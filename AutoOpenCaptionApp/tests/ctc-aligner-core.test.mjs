// Unit tests for the pure parts of the experimental CTC aligner (no model download).
// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCharIdMap,
  normalizeTranscript,
  frameRangeToSeconds,
  CTC_BLANK_ID,
  CTC_UNK_ID,
  CTC_DELIMITER_ID,
  CTC_VOCAB_SIZE,
} from '../app/assets/ctc-aligner.js';

// Fake tokenizer replicating Xenova/wav2vec2-base-960h tokenizer.json behavior exactly:
// <pad>=0 <s>=1 </s>=2 <unk>=3 |=4, letters in frequency order E=5..Z=31, '=27.
// encode(): uppercase letters + apostrophe -> their id; space -> 4; anything else -> 3 (<unk>).
const VOCAB = {
  '|': 4, E: 5, T: 6, A: 7, O: 8, N: 9, I: 10, H: 11, S: 12, R: 13, D: 14, L: 15, U: 16,
  M: 17, W: 18, C: 19, F: 20, G: 21, Y: 22, P: 23, B: 24, V: 25, K: 26, "'": 27, X: 28,
  J: 29, Q: 30, Z: 31,
};
const fakeTokenizer = {
  encode(s) {
    const out = [];
    for (const ch of s) {
      if (ch === ' ') out.push(4);
      else if (VOCAB[ch] !== undefined) out.push(VOCAB[ch]);
      else out.push(3); // <unk>
    }
    return out;
  },
};

test('buildCharIdMap derives the exact letter alphabet from encode() probing', () => {
  const map = buildCharIdMap(fakeTokenizer);
  assert.equal(map.get('A'), 7);
  assert.equal(map.get('Z'), 31);
  assert.equal(map.get("'"), 27);
  // specials and unsupported chars are absent
  for (const ch of ['|', ' ', '0', '9', 'ß', 'é', '€']) assert.ok(!map.has(ch), `${ch} must not be in map`);
  // every mapped id is a valid, non-special vocab id
  for (const id of map.values()) {
    assert.ok(id >= 5 && id < CTC_VOCAB_SIZE, `mapped id ${id} out of representable range`);
    assert.notEqual(id, CTC_BLANK_ID);
    assert.notEqual(id, CTC_UNK_ID);
    assert.notEqual(id, CTC_DELIMITER_ID);
  }
});

test('normalizeTranscript: basic words, delimiter between words, identity mapping', () => {
  const map = buildCharIdMap(fakeTokenizer);
  const r = normalizeTranscript([{ text: 'HELLO' }, { text: 'WORLD' }], map);
  assert.equal(r.readyWordCount, 2);
  assert.deepEqual(r.unalignable, []);
  // H E | W O R L D -> ids
  assert.deepEqual(r.tokenIds, [11, 5, 15, 15, 8, 4, 18, 8, 13, 15, 14]);
  // tokenWord: first 5 -> word 0, delimiter -> -1, last 5 -> word 1
  assert.deepEqual([...r.tokenWord], [0, 0, 0, 0, 0, -1, 1, 1, 1, 1, 1]);
  assert.equal(r.tokenWord.length, r.tokenIds.length);
});

test('normalizeTranscript: lower-case transcript works (upper-cased internally)', () => {
  const map = buildCharIdMap(fakeTokenizer);
  const r = normalizeTranscript(['the', 'quick'], map);
  assert.equal(r.readyWordCount, 2);
  assert.deepEqual(r.tokenIds.slice(0, 3), [6, 11, 5]); // T=6 H=11 E=5 (frequency-order vocab)
});

test('normalizeTranscript: apostrophes and contractions are alignable', () => {
  const map = buildCharIdMap(fakeTokenizer);
  const straight = normalizeTranscript(["DON'T"], map);
  const curly = normalizeTranscript(['DON’T'], map);
  assert.equal(straight.readyWordCount, 1);
  assert.equal(curly.readyWordCount, 1);
  assert.deepEqual(straight.tokenIds, curly.tokenIds); // curly folded to straight
  assert.ok(straight.tokenIds.includes(27));
});

test('normalizeTranscript: accents fold to base letters', () => {
  const map = buildCharIdMap(fakeTokenizer);
  const r = normalizeTranscript(['café'.toUpperCase(), 'NAÏVE'], map); // CAFÉ NAÏVE
  assert.equal(r.readyWordCount, 2);
});

test('normalizeTranscript: trailing punctuation is dropped, word stays alignable', () => {
  const map = buildCharIdMap(fakeTokenizer);
  const r = normalizeTranscript(['YES.', 'HEY!', '(WOW)', 'well—'], map);
  assert.equal(r.readyWordCount, 4);
  assert.deepEqual(r.unalignable, []);
  // word identity preserved for the last word
  assert.equal(r.tokenWord[r.tokenWord.length - 1], 3);
});

test('normalizeTranscript: numbers and unsupported chars make the WORD unalignable, never truncated', () => {
  const map = buildCharIdMap(fakeTokenizer);
  const words = [{ text: 'I' }, { text: 'ATE' }, { text: '7' }, { text: 'PIZZAS' }, { text: 'AT' }, { text: '3PM' }];
  const r = normalizeTranscript(words, map);
  // words 2 ('7') and 5 ('3PM') must be reported, NOT silently dropped or aligned as partial text
  assert.equal(r.readyWordCount, 4);
  const reported = r.unalignable.map((u) => u.index).sort((a, b) => a - b);
  assert.deepEqual(reported, [2, 5]);
  assert.equal(r.unalignable.find((u) => u.index === 2).text, '7');
  assert.equal(r.unalignable.find((u) => u.index === 5).reason, 'unsupported-characters');
  // tokenWord never references an unalignable word index
  for (const w of r.tokenWord) {
    if (w >= 0) assert.ok(['ready'].includes(r.wordStatus.get(w)), `token maps to ${r.wordStatus.get(w)} word ${w}`);
  }
});

test('normalizeTranscript: pure-punctuation words are "empty" unalignable and get no delimiter', () => {
  const map = buildCharIdMap(fakeTokenizer);
  const r = normalizeTranscript(['...', 'OK', '—'], map);
  assert.equal(r.readyWordCount, 1);
  assert.equal(r.wordStatus.get(0), 'empty');
  assert.equal(r.wordStatus.get(2), 'empty');
  // single word -> no delimiter tokens
  assert.ok(!r.tokenIds.includes(CTC_DELIMITER_ID));
});

test('normalizeTranscript: empty input yields empty target', () => {
  const map = buildCharIdMap(fakeTokenizer);
  const r = normalizeTranscript([], map);
  assert.deepEqual(r.tokenIds, []);
  assert.equal(r.readyWordCount, 0);
});

test('normalizeTranscript: repeated words keep distinct identities', () => {
  const map = buildCharIdMap(fakeTokenizer);
  const r = normalizeTranscript(['NO', 'NO', 'NO'], map);
  assert.equal(r.readyWordCount, 3);
  const wordIdx = new Set([...r.tokenWord].filter((w) => w >= 0));
  assert.deepEqual([...wordIdx].sort(), [0, 1, 2]);
  // NO NO NO -> N O | N O | N O
  assert.deepEqual(r.tokenIds, [9, 8, 4, 9, 8, 4, 9, 8]);
});

test('frameRangeToSeconds: uses actual dims, not nominal stride; offset added exactly once', () => {
  // verified real case: 32000 samples -> 99 frames (not 100) at 16 kHz
  const r = frameRangeToSeconds(10, 10, 99, 32000, 16000, 0);
  const secPerFrame = 32000 / 16000 / 99; // 0.0202... s
  assert.ok(Math.abs(r.start - 10 * secPerFrame) < 1e-12);
  assert.ok(Math.abs(r.end - 11 * secPerFrame) < 1e-12);
  assert.ok(r.end > r.start);
  // window offset added once
  const off = frameRangeToSeconds(0, 0, 50, 16000, 16000, 12.5);
  assert.ok(Math.abs(off.start - 12.5) < 1e-12);
  assert.ok(Math.abs(off.end - (12.5 + 16000 / 16000 / 50)) < 1e-12);
});

test('frameRangeToSeconds: rejects degenerate windows', () => {
  assert.throws(() => frameRangeToSeconds(0, 0, 0, 100, 16000, 0), /zero-length window/);
  assert.throws(() => frameRangeToSeconds(0, 0, 10, 0, 16000, 0), /zero-length window/);
});
