// Phase 3 tests: chunked inference — planCtcWindows (grid, anchor assignment, seam
// invariants, cap overflow) + alignCtcTranscript multi-window execution with fake model
// objects (no downloads). Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planCtcWindows,
  alignCtcTranscript,
  normalizeTranscript,
  buildCharIdMap,
  CtcAlignerError,
  CTC_BLANK_ID,
  CTC_DELIMITER_ID,
  CTC_SAMPLE_RATE,
  CTC_VOCAB_SIZE,
  CTC_WINDOW_DURATION_SECONDS,
  CTC_WINDOW_OVERLAP_SECONDS,
} from '../app/assets/ctc-aligner.js';

// Same fake tokenizer as the other suites (Xenova/wav2vec2-base-960h replica).
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
      else out.push(3);
    }
    return out;
  },
};
const charIdMap = buildCharIdMap(fakeTokenizer);
const B = CTC_BLANK_ID; // 0
const D = CTC_DELIMITER_ID; // 4

// Sharp synthetic emissions: one frame per entry of `path` (entry = argmax id).
function synth(path, sharp = 12, vocab = CTC_VOCAB_SIZE) {
  const data = new Float32Array(path.length * vocab);
  for (let t = 0; t < path.length; t++) {
    data.fill(-sharp, t * vocab, (t + 1) * vocab);
    data[t * vocab + path[t]] = sharp;
  }
  return data;
}

// --- planCtcWindows: pure planning ------------------------------------------

function wordsAt(seconds, text = 'HI') {
  return seconds.map((s) => ({ text, start: s, end: s + 0.4 }));
}
function normOf(words) { return normalizeTranscript(words, charIdMap); }
function range(a, b) { const r = []; for (let i = a; i < b; i++) r.push(i); return r; }

test('planCtcWindows: fixed grid with overlap; words assigned by start-hint window', () => {
  assert.equal(CTC_WINDOW_DURATION_SECONDS, 25);
  assert.equal(CTC_WINDOW_OVERLAP_SECONDS, 1.5);
  const words = wordsAt(range(0, 60)); // one word per second for 60 s
  const norm = normOf(words);
  const plan = planCtcWindows({ totalSamples: 60 * CTC_SAMPLE_RATE, norm, words });
  // grid: W0 [0,25], W1 [23.5,48.5], W2 [47,60]
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map((w) => [w.startSample, w.endSample]), [
    [0, 400000], [376000, 776000], [752000, 960000],
  ]);
  // start hints: words 0..24 land in W0 (24 s < 25 s), 25..48 in W1, 49..59 in W2
  assert.ok(plan[0].tokenStart === 0);
  assert.ok(plan[1].tokenStart > plan[0].tokenStart);
  assert.ok(plan[2].tokenEnd === norm.tokenIds.length);
});

test('planCtcWindows: short audio is one window covering all ready tokens', () => {
  const words = wordsAt(range(0, 10));
  const norm = normOf(words);
  const plan = planCtcWindows({ totalSamples: 10 * CTC_SAMPLE_RATE, norm, words });
  assert.equal(plan.length, 1);
  assert.deepEqual([plan[0].startSample, plan[0].endSample], [0, 160000]);
  assert.deepEqual([plan[0].tokenStart, plan[0].tokenEnd], [0, norm.tokenIds.length]);
});

test('planCtcWindows: windows with no words are skipped', () => {
  const words = wordsAt([...range(0, 3), ...range(50, 53)]);
  const norm = normOf(words);
  const plan = planCtcWindows({ totalSamples: 60 * CTC_SAMPLE_RATE, norm, words });
  assert.equal(plan.length, 2); // the middle 47 s of silence gets no inference
  assert.equal(plan[0].startSample, 0);
  assert.ok(plan[1].startSample >= 45 * CTC_SAMPLE_RATE); // fixed grid: W2 starts at 47 s
});

test('planCtcWindows: no ready words -> no windows', () => {
  const words = [{ text: '7' }, { text: '?!' }];
  const norm = normOf(words);
  assert.deepEqual(planCtcWindows({ totalSamples: 60 * CTC_SAMPLE_RATE, norm, words }), []);
});

test('planCtcWindows: seams are word boundaries — tokens contiguous, no word split', () => {
  // 90 s of words, some hints deliberately sloppy (drift up to 2 s = seam width territory)
  const words = range(0, 90).map((s) => ({
    text: s % 3 === 0 ? 'HELLO' : 'HI',
    start: s + (s % 7) * 0.3,
    end: s + 0.5,
  }));
  const norm = normOf(words);
  const plan = planCtcWindows({ totalSamples: 90 * CTC_SAMPLE_RATE, norm, words });
  assert.ok(plan.length >= 4);

  // contiguity + exact-once coverage of every token
  assert.equal(plan[0].tokenStart, 0);
  for (let i = 1; i < plan.length; i++) {
    assert.equal(plan[i].tokenStart, plan[i - 1].tokenEnd, `gap/overlap between windows ${i - 1} and ${i}`);
  }
  assert.equal(plan[plan.length - 1].tokenEnd, norm.tokenIds.length);

  // audio ranges stay inside the file and in increasing order
  let prevStart = -1;
  for (const w of plan) {
    assert.ok(w.startSample >= 0 && w.endSample <= 90 * CTC_SAMPLE_RATE);
    assert.ok(w.endSample > w.startSample && w.startSample > prevStart || w.startSample === 0);
    prevStart = w.startSample;
    assert.ok(w.tokenEnd > w.tokenStart);
  }

  // no word is ever split: all letters of a word fall inside exactly one window
  const letterWindowCount = new Map(); // word -> count of windows containing its letters
  for (const w of plan) {
    const seen = new Set();
    for (let j = w.tokenStart; j < w.tokenEnd; j++) {
      const wordIdx = norm.tokenWord[j];
      if (wordIdx >= 0 && !seen.has(wordIdx)) { seen.add(wordIdx); letterWindowCount.set(wordIdx, (letterWindowCount.get(wordIdx) ?? 0) + 1); }
    }
  }
  for (const [wordIdx, count] of norm.wordStatus) {
    if (count === 0) continue;
    if (norm.wordStatus.get(wordIdx) === 'ready') {
      assert.equal(letterWindowCount.get(wordIdx) ?? 0, 1, `word ${wordIdx} split across ${letterWindowCount.get(wordIdx)} windows`);
    }
  }

  // a word's leading delimiter travels with the word (never dangles at a previous window end)
  for (const w of plan) {
    if (w.tokenStart > 0 && norm.tokenWord[w.tokenStart] === -1) {
      // window opens with a delimiter — it must belong to a word inside THIS window
      assert.ok(w.tokenStart + 1 < w.tokenEnd, 'dangling delimiter at window end');
    }
  }
});

test('planCtcWindows: out-of-order hints still produce monotonic window assignment', () => {
  // Whisper occasionally emits scrambled timestamps; token order must never regress
  const words = range(0, 40).map((s) => ({
    text: 'HI',
    start: s < 20 ? 70 - s : s - 20, // wild back-and-forth hints
    end: s + 0.3,
  }));
  const norm = normOf(words);
  const plan = planCtcWindows({ totalSamples: 90 * CTC_SAMPLE_RATE, norm, words });
  assert.equal(plan[0].tokenStart, 0);
  assert.equal(plan[plan.length - 1].tokenEnd, norm.tokenIds.length);
  for (let i = 1; i < plan.length; i++) assert.equal(plan[i].tokenStart, plan[i - 1].tokenEnd);
  for (const w of plan) assert.ok(w.endSample > w.startSample && w.tokenEnd > w.tokenStart);
});

test('planCtcWindows: token cap spills hint-less words into later windows', () => {
  // no timestamps at all: everything anchors at 0 s, but the cap (1 frame per token)
  // must spread 60 words over several windows instead of cramming one
  const words = range(0, 60).map(() => ({ text: 'HELLO WORLD' }));
  const norm = normOf(words);
  const plan = planCtcWindows({
    totalSamples: 60 * CTC_SAMPLE_RATE, norm, words,
    windowDurationSeconds: 1, overlapSeconds: 0.25, // cap = 16000/320 = 50 tokens
  });
  assert.ok(plan.length > 3, 'hint-less transcript must spill across windows');
  assert.equal(plan[0].tokenStart, 0);
  assert.equal(plan[plan.length - 1].tokenEnd, norm.tokenIds.length);
  for (let i = 1; i < plan.length; i++) assert.equal(plan[i].tokenStart, plan[i - 1].tokenEnd);
  const capTokens = Math.floor((1 * CTC_SAMPLE_RATE) / 320);
  for (const w of plan) assert.ok(w.tokenEnd - w.tokenStart <= capTokens, 'window exceeds the 1-frame-per-token cap');
});

test('planCtcWindows: rejects bad inputs', () => {
  const norm = normOf(['HI']);
  assert.throws(() => planCtcWindows({ totalSamples: 0, norm }), CtcAlignerError);
  assert.throws(() => planCtcWindows({ totalSamples: 16000, norm: {} }), CtcAlignerError);
});

// --- alignCtcTranscript: multi-window execution ------------------------------

// Fake stack whose "model" synthesizes perfect emissions for whichever token slice the
// planner handed to each window: window k is call #k (plan order = call order).
function makeChunkedLoaded(norm, plan, { sabotageWindow = -1 } = {}) {
  const calls = { fe: [], model: 0 };
  return {
    calls,
    model: async ({ input_values }) => {
      const wi = calls.model++;
      if (wi === sabotageWindow) {
        // one frame: no transcript of any length fits -> window infeasible
        return { logits: { data: synth([B]), dims: [1, 1, CTC_VOCAB_SIZE] } };
      }
      const win = plan[wi];
      const tokens = norm.tokenIds.slice(win.tokenStart, win.tokenEnd);
      const numFrames = Math.floor(input_values.dims[1] / 320);
      assert.ok(2 * tokens.length + 1 <= numFrames, 'test emissions need frame room');
      const path = [B];
      for (const t of tokens) path.push(t, B); // token j at frame 2j+1
      while (path.length < numFrames) path.push(B);
      return { logits: { data: synth(path), dims: [1, numFrames, CTC_VOCAB_SIZE] } };
    },
    featureExtractor: async (f32) => {
      calls.fe.push(f32.length);
      return { input_values: { data: f32, dims: [1, f32.length] } };
    },
    tokenizer: fakeTokenizer,
    charIdMap,
    blankId: CTC_BLANK_ID,
    delimiterId: CTC_DELIMITER_ID,
    unkId: 3,
    modelId: 'fake/wav2vec2',
    dtype: 'q8',
  };
}

test('alignCtcTranscript: 60 s transcript runs in 3 windows with global timestamps', async () => {
  const samples = new Float32Array(60 * CTC_SAMPLE_RATE);
  const words = wordsAt(range(0, 60));
  const norm = normalizeTranscript(words, charIdMap);
  const plan = planCtcWindows({ totalSamples: samples.length, norm, words });
  assert.equal(plan.length, 3);
  const loaded = makeChunkedLoaded(norm, plan);

  const progress = [];
  const res = await alignCtcTranscript({ words, samples, loaded, onProgress: (p) => progress.push(p) });

  assert.equal(loaded.calls.model, 3, 'one inference per window');
  assert.deepEqual(loaded.calls.fe, [400000, 400000, 208000], 'clips are the planned windows');
  assert.equal(res.stats.windows, 3);
  assert.equal(res.stats.ctc, 60);
  assert.deepEqual(res.unalignable, []);

  // token emission layout per window: token j at frame 2j+1, frame = 0.02 s of a
  // 400000-sample window (1250 frames). Window 1 starts at 23.5 s, window 2 at 47 s.
  const W0 = res.words[0], W25 = res.words[25], W59 = res.words[59];
  // W0: 'HI' letters are window tokens 0 and 1 -> frames 1, 3
  assert.ok(Math.abs(W0.start - 0.02) < 1e-9, `word0 start ${W0.start}`);
  assert.ok(Math.abs(W0.end - 0.08) < 1e-9);
  // W1 opens with word25's leading delimiter (token 0), letters at frames 3, 5
  assert.ok(Math.abs(W25.start - (23.5 + 3 * 0.02)) < 1e-9, `word25 start ${W25.start}`);
  assert.ok(Math.abs(W25.end - (23.5 + 6 * 0.02)) < 1e-9);
  // W2 covers words 49..59; word59's letters are local tokens 31,32 -> frames 63,65
  assert.ok(Math.abs(W59.start - (47 + 63 * 0.02)) < 1e-9, `word59 start ${W59.start}`);
  assert.ok(Math.abs(W59.end - (47 + 66 * 0.02)) < 1e-9);

  // progress carries the window counter
  assert.deepEqual(
    progress.map((p) => `${p.stage}:${p.window ?? '-'}`).slice(0, 9),
    ['ctc-features:1', 'ctc-inference:1', 'ctc-align:1', 'ctc-features:2', 'ctc-inference:2',
      'ctc-align:2', 'ctc-features:3', 'ctc-inference:3', 'ctc-align:3'],
  );
  assert.equal(progress.at(-1).stage, 'done');
});

test('alignCtcTranscript: cancellation between windows throws and stops inference', async () => {
  const samples = new Float32Array(60 * CTC_SAMPLE_RATE);
  const words = wordsAt(range(0, 60));
  const norm = normalizeTranscript(words, charIdMap);
  const plan = planCtcWindows({ totalSamples: samples.length, norm, words });
  const loaded = makeChunkedLoaded(norm, plan);

  let cancel = false;
  const res = alignCtcTranscript({
    words, samples, loaded,
    onProgress: (p) => { if (p.stage === 'ctc-inference' && p.window === 1) cancel = true; },
    shouldCancel: () => cancel,
  });
  await assert.rejects(res, (err) => err instanceof CtcAlignerError && err.code === 'cancelled');
  assert.equal(loaded.calls.model, 1, 'no further windows after cancel');
});

test('alignCtcTranscript: an infeasible window degrades only its own words', async () => {
  const samples = new Float32Array(60 * CTC_SAMPLE_RATE);
  const words = wordsAt(range(0, 60));
  const norm = normalizeTranscript(words, charIdMap);
  const plan = planCtcWindows({ totalSamples: samples.length, norm, words });
  const loaded = makeChunkedLoaded(norm, plan, { sabotageWindow: 1 }); // window 2 of 3

  const res = await alignCtcTranscript({ words, samples, loaded });
  assert.equal(res.stats.windows, 3);
  const classes = res.words.map((w) => w.alignment);
  assert.ok(classes.every((c, i) => (i >= 25 && i <= 48 ? c === 'estimated' : c === 'ctc')),
    `expected only words 25..48 degraded, got ${classes.join(',')}`);
  const bad = res.unalignable.filter((u) => u.reason === 'alignment-infeasible');
  assert.equal(bad.length, 24);
  assert.equal(bad[0].index, 25);
  assert.equal(bad.at(-1).index, 48);
  // degraded words keep their Whisper timestamps
  assert.equal(res.words[25].start, 25);
  assert.equal(res.words[48].end, 48.4);
  // other windows unaffected
  assert.equal(res.stats.ctc, 36);
});
