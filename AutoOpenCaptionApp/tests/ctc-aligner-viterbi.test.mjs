// Phase 2 tests: Viterbi CTC forced-alignment core + word-timing aggregation +
// alignCtcTranscript end-to-end wiring with fake model objects (no downloads).
// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  forcedAlignViterbi,
  buildWordTiming,
  alignCtcTranscript,
  normalizeTranscript,
  buildCharIdMap,
  CtcAlignerError,
  CTC_BLANK_ID,
  CTC_DELIMITER_ID,
  CTC_VOCAB_SIZE,
  CTC_MIN_TOKEN_LOGPROB,
} from '../app/assets/ctc-aligner.js';

// Same fake tokenizer as ctc-aligner-core.test.mjs (Xenova/wav2vec2-base-960h replica:
// <pad>=0 |=4 <unk>=3, frequency-order letters E=5..Z=31, '=27).
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

// Build sharp synthetic emissions: one frame per entry of `path` (entry = argmax id).
function synth(path, sharp = 12, vocab = CTC_VOCAB_SIZE) {
  const data = new Float32Array(path.length * vocab);
  for (let t = 0; t < path.length; t++) {
    data.fill(-sharp, t * vocab, (t + 1) * vocab);
    data[t * vocab + path[t]] = sharp;
  }
  return data;
}

const B = CTC_BLANK_ID; // 0
const D = CTC_DELIMITER_ID; // 4

// Emissions helper: one sharp frame per symbol with blanks between ALL symbols, so
// repeated letters (LL in HELLO, OO/KK/EE in BOOKKEEPER) are unambiguously two tokens.
const blanked = (symbols) => [B, ...symbols.flatMap((s) => [s, B])];

test('forcedAlignViterbi: simple CAT path yields per-token spans and path labels', () => {
  // target C A T = 19 7 6; frames: _ C C _ A _ T _ _
  const tokenIds = [19, 7, 6];
  const path = [B, 19, 19, B, 7, B, 6, B, B];
  const logits = synth(path);
  const r = forcedAlignViterbi(logits, path.length, CTC_VOCAB_SIZE, tokenIds);
  assert.equal(r.feasible, true);
  assert.ok(r.bestLogProb > -1); // path fits the sharp emissions almost exactly
  assert.deepEqual([...r.pathTokens], [-1, 0, 0, -1, 1, -1, 2, -1, -1]);
  assert.deepEqual([...r.tokenFirstFrame], [1, 4, 6]);
  assert.deepEqual([...r.tokenLastFrame], [2, 4, 6]);
  assert.deepEqual([...r.tokenFrameCount], [2, 1, 1]);
  for (const lp of r.tokenLogProb) assert.ok(lp > -0.5, 'confident tokens have near-zero log prob');
});

test('forcedAlignViterbi: blank-separated repetition BOOKKEEPER gets distinct spans', () => {
  const tokenIds = [24, 8, 8, 26, 26, 5, 5, 23, 5, 13]; // B O O K K E E P E R
  const path = [B, 24, B, 8, B, 8, B, 26, B, 26, B, 5, B, 5, B, 23, B, 5, B, 13, B];
  const r = forcedAlignViterbi(synth(path), path.length, CTC_VOCAB_SIZE, tokenIds);
  assert.equal(r.feasible, true);
  assert.equal(r.tokenFirstFrame.length, tokenIds.length);
  // every token on the path, none collapsed: strictly increasing first frames
  for (let j = 0; j < tokenIds.length; j++) assert.ok(r.tokenFrameCount[j] >= 1, `token ${j} has no frames`);
  for (let j = 1; j < tokenIds.length; j++) {
    assert.ok(r.tokenFirstFrame[j] > r.tokenLastFrame[j - 1], `token ${j} overlaps token ${j - 1}`);
  }
  assert.deepEqual([...r.tokenFirstFrame], [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]);
});

test('forcedAlignViterbi: AA vs A disambiguation (identical letters need a blank)', () => {
  // Two A frames with no blank CANNOT spell "AA": shortest AA path is A _ A (3 frames).
  const twoA = forcedAlignViterbi(synth([7, 7]), 2, CTC_VOCAB_SIZE, [7, 7]);
  assert.equal(twoA.feasible, false);
  assert.equal(twoA.reason, 'too-few-frames');
  // With a blank between them it is exactly "AA", as two separate spans.
  const withBlank = forcedAlignViterbi(synth([7, B, 7]), 3, CTC_VOCAB_SIZE, [7, 7]);
  assert.equal(withBlank.feasible, true);
  assert.deepEqual([...withBlank.tokenFirstFrame], [0, 2]);
  // One A frame spells "A" but not "AA" — the two targets are distinguishable.
  const oneA = forcedAlignViterbi(synth([7, B, 7]), 3, CTC_VOCAB_SIZE, [7]);
  assert.equal(oneA.feasible, true);
  assert.deepEqual([...oneA.tokenFirstFrame], [0]);
});

test('forcedAlignViterbi: best path prefers the target that matches the emissions (AAA vs AA)', () => {
  const emissions = synth([7, B, 7, B, 7]); // three A's separated by blanks
  const aaa = forcedAlignViterbi(emissions, 5, CTC_VOCAB_SIZE, [7, 7, 7]);
  const aa = forcedAlignViterbi(emissions, 5, CTC_VOCAB_SIZE, [7, 7]);
  assert.equal(aaa.feasible, true);
  assert.equal(aa.feasible, true);
  assert.ok(aaa.bestLogProb > aa.bestLogProb + 10, 'AAA must fit far better than AA');
});

test('forcedAlignViterbi: word-delimiter token beats stretching letters (HI|THERE order)', () => {
  // emissions: H I | T H E R E with blanks; target WITH delimiter vs target without
  const withDelim = [11, 10, D, 6, 11, 5, 13, 5];
  const withoutDelim = [11, 10, 6, 11, 5, 13, 5];
  const path = [B, 11, 10, B, D, B, 6, 11, 5, 13, 5, B];
  const logits = synth(path);
  const a = forcedAlignViterbi(logits, path.length, CTC_VOCAB_SIZE, withDelim);
  const b = forcedAlignViterbi(logits, path.length, CTC_VOCAB_SIZE, withoutDelim);
  assert.equal(a.feasible, true);
  assert.equal(b.feasible, true);
  assert.ok(a.bestLogProb > b.bestLogProb + 10, 'delimiter target must match emissions far better');
  // token order along the path is strictly increasing
  let prev = -2;
  for (const j of a.pathTokens) {
    if (j >= 0) { assert.ok(j >= prev, 'path token order must be monotonic'); prev = j; }
  }
});

test('forcedAlignViterbi: rejects blank in target and bad shapes', () => {
  assert.throws(() => forcedAlignViterbi(synth([B]), 1, CTC_VOCAB_SIZE, [B]), CtcAlignerError);
  assert.throws(() => forcedAlignViterbi(new Float32Array(4), 1, CTC_VOCAB_SIZE, [5]), /need 1 x 32/);
  // empty target is trivially feasible (all-blank path)
  const r = forcedAlignViterbi(synth([B, B, B]), 3, CTC_VOCAB_SIZE, []);
  assert.equal(r.feasible, true);
  assert.ok([...r.pathTokens].every((x) => x === -1));
});

test('forcedAlignViterbi: window-too-large guard fires before allocating backpointers', () => {
  const S = 700;
  const T = 100_000; // T * (2S+1) = 140.1M cells > 2^27 cap
  const tokenIds = new Array(S).fill(5);
  const data = new Float32Array(T * CTC_VOCAB_SIZE); // 12.8 MB, no frames filled (all zeros)
  assert.throws(
    () => forcedAlignViterbi(data, T, CTC_VOCAB_SIZE, tokenIds),
    /window too large|Viterbi table/
  );
});

test('buildWordTiming: word spans in seconds use actual dims + offset; order preserved', () => {
  const words = [{ text: 'HI' }, { text: 'THERE' }];
  const norm = normalizeTranscript(words, charIdMap);
  const path = [B, 11, B, 10, B, D, B, 6, B, 11, B, 5, B, 13, B, 5, B]; // _ H _ I _ | _ T _ H _ E _ R _ E _
  const alignment = forcedAlignViterbi(synth(path), path.length, CTC_VOCAB_SIZE, norm.tokenIds);
  assert.equal(alignment.feasible, true);
  const numFrames = path.length;
  const windowSamples = numFrames * 320 + 100; // deliberately NOT numFrames*320
  const secPerFrame = windowSamples / 16000 / numFrames;
  const timing = buildWordTiming(alignment, norm, { numFrames, windowSamples, sampleRate: 16000 });
  const w0 = timing.get(0);
  const w1 = timing.get(1);
  assert.ok(w0 && w1, 'both words timed');
  assert.ok(!w0.lowConfidence && !w1.lowConfidence);
  assert.ok(Math.abs(w0.start - 1 * secPerFrame) < 1e-12);
  assert.ok(Math.abs(w0.end - 4 * secPerFrame) < 1e-12); // last HI frame is index 3 -> end = 4
  assert.ok(w0.end <= w1.start, 'word order in time must be preserved');
  // offset shifts everything exactly once
  const timedOff = buildWordTiming(alignment, norm, {
    numFrames, windowSamples, sampleRate: 16000, windowOffsetSeconds: 5,
  });
  assert.ok(Math.abs(timedOff.get(0).start - (1 * secPerFrame + 5)) < 1e-12);
});

test('buildWordTiming: uniform (zero-information) emissions flag every word lowConfidence', () => {
  const norm = normalizeTranscript(['CAT', 'DOG'], charIdMap);
  const T = 40;
  const zeros = new Float32Array(T * CTC_VOCAB_SIZE); // uniform softmax: p = 1/32 per class
  const alignment = forcedAlignViterbi(zeros, T, CTC_VOCAB_SIZE, norm.tokenIds);
  assert.equal(alignment.feasible, true); // a path exists — it just means nothing
  const timing = buildWordTiming(alignment, norm, { numFrames: T, windowSamples: T * 320, sampleRate: 16000 });
  assert.equal(timing.size, 2);
  for (const span of timing.values()) {
    assert.ok(span.lowConfidence, 'uniform emissions must be flagged low-confidence');
    assert.ok(span.confidence < CTC_MIN_TOKEN_LOGPROB);
  }
});

// --- alignCtcTranscript end-to-end with fake loaded objects -------------------

function makeLoaded(synthPath) {
  const data = synth(synthPath);
  const numFrames = synthPath.length;
  return {
    model: async () => ({ logits: { data, dims: [1, numFrames, CTC_VOCAB_SIZE] } }),
    featureExtractor: async (f32) => ({ input_values: { data: f32, dims: [1, f32.length] } }),
    tokenizer: fakeTokenizer,
    charIdMap,
    blankId: CTC_BLANK_ID,
    delimiterId: CTC_DELIMITER_ID,
    unkId: 3,
    modelId: 'fake/wav2vec2',
    dtype: 'q8',
  };
}

test('alignCtcTranscript: HELLO 7 WORLD — CTC for letters, estimate kept for number', async () => {
  // emissions: _ H _ E _ L _ L _ O _ | _ W _ O _ R _ L _ D _  (blanks everywhere)
  const path = blanked([11, 5, 15, 15, 8, D, 18, 8, 13, 15, 14]);
  const loaded = makeLoaded(path);
  const words = [
    { id: 'a', text: 'HELLO', start: 0.05, end: 0.42 },
    { id: 'b', text: '7', start: 1.5, end: 1.6 }, // Whisper hint — must NOT influence CTC
    { id: 'c', text: 'WORLD', start: 0.42, end: 0.9 },
  ];
  const samples = new Float32Array(path.length * 320 + 100);
  const res = await alignCtcTranscript({ words, samples, loaded });

  assert.equal(res.words.length, 3);
  assert.deepEqual(res.words.map((w) => w.id), ['a', 'b', 'c']); // identity + order preserved
  assert.deepEqual(res.words.map((w) => w.text), ['HELLO', '7', 'WORLD']);
  assert.deepEqual(res.words.map((w) => w.alignment), ['ctc', 'estimated', 'ctc']);

  // original Whisper timestamps preserved on every word for undo
  assert.equal(res.words[0].originalStart, 0.05);
  assert.equal(res.words[1].originalStart, 1.5);
  assert.equal(res.words[2].originalStart, 0.42);
  // the '7' keeps its Whisper time exactly
  assert.equal(res.words[1].start, 1.5);
  assert.equal(res.words[1].end, 1.6);

  // CTC times are audio-derived, NOT the hints, and are ordered
  const spf = samples.length / 16000 / path.length;
  assert.ok(Math.abs(res.words[0].start - 1 * spf) < 1e-12);
  assert.ok(Math.abs(res.words[2].end - 22 * spf) < 1e-12);
  assert.ok(res.words[0].end <= res.words[2].start);

  // stats + unalignable report
  assert.equal(res.stats.total, 3);
  assert.equal(res.stats.ctc, 2);
  assert.equal(res.stats.estimated, 1);
  assert.equal(res.stats.unalignable, 0);
  assert.equal(res.unalignable.length, 1);
  assert.equal(res.unalignable[0].index, 1);
  assert.equal(res.unalignable[0].reason, 'unsupported-characters');
});

test('alignCtcTranscript: Whisper hint timestamps are not alignment priors', async () => {
  const path = blanked([11, 5, 15, 15, 8]);
  const loaded = makeLoaded(path);
  const samples = new Float32Array(path.length * 320);
  const base = [{ id: 0, text: 'HELLO' }];
  const hints = [
    { start: 0.01, end: 0.02 },
    { start: 40.0, end: 41.5 },   // absurdly late hint
    { start: 3, end: 2 },          // inverted hint
  ];
  const runs = [];
  for (const h of hints) {
    const res = await alignCtcTranscript({ words: [{ ...base[0], ...h }], samples, loaded });
    runs.push(res.words[0]);
  }
  for (const w of runs) {
    assert.equal(w.alignment, 'ctc');
    assert.equal(w.start, runs[0].start);
    assert.equal(w.end, runs[0].end);
  }
});

test('alignCtcTranscript: minTokenLogProb override demotes weak CTC to estimated', async () => {
  const path = blanked([11, 5, 15, 15, 8]);
  const loaded = makeLoaded(path);
  const samples = new Float32Array(path.length * 320);
  const words = [{ text: 'HELLO', start: 0.1, end: 0.2 }];
  const res = await alignCtcTranscript({ words, samples, loaded, minTokenLogProb: 0 });
  assert.equal(res.words[0].alignment, 'estimated');
  assert.equal(res.words[0].start, 0.1); // Whisper time kept
  assert.equal(res.unalignable[0].reason, 'low-confidence');
});

test('alignCtcTranscript: infeasible window (too many words) degrades to estimates, no throw', async () => {
  const path = [B, 5, B]; // 3 frames cannot hold a long transcript
  const loaded = makeLoaded(path);
  const samples = new Float32Array(path.length * 320);
  const words = [
    { text: 'SUPERCALIFRAGILISTIC', start: 0, end: 1 },
    { text: 'EXPIALIDOCIOUS', start: 1, end: 2 },
  ];
  const res = await alignCtcTranscript({ words, samples, loaded });
  assert.deepEqual(res.words.map((w) => w.alignment), ['estimated', 'estimated']);
  assert.equal(res.words[0].start, 0);
  assert.equal(res.words[1].start, 1); // Whisper times kept
  assert.ok(res.unalignable.every((u) => u.reason === 'alignment-infeasible'));
});

test('alignCtcTranscript: word without any timestamp is unalignable and forward-filled', async () => {
  const path = blanked([11, 5, 15, 15, 8]);
  const loaded = makeLoaded(path);
  const samples = new Float32Array(path.length * 320);
  const words = [{ text: 'HELLO' }, { text: '7' }]; // '7' has no CTC and no Whisper time
  const res = await alignCtcTranscript({ words, samples, loaded });
  assert.equal(res.words[0].alignment, 'ctc');
  assert.equal(res.words[1].alignment, 'unalignable');
  assert.equal(res.stats.unalignable, 1);
  assert.ok(Number.isFinite(res.words[1].start) && res.words[1].start >= res.words[0].end);
});

test('alignCtcTranscript: cancellation throws CtcAlignerError code "cancelled"', async () => {
  const loaded = makeLoaded([B, 5, B]);
  await assert.rejects(
    () => alignCtcTranscript({ words: [{ text: 'A' }], samples: new Float32Array(3200), loaded, shouldCancel: () => true }),
    (err) => err instanceof CtcAlignerError && err.code === 'cancelled'
  );
});

test('alignCtcTranscript: progress stages are namespaced and ordered', async () => {
  const loaded = makeLoaded([B, 11, 5, 15, 15, 8, B]);
  const seen = [];
  await alignCtcTranscript({
    words: [{ text: 'HELLO' }],
    samples: new Float32Array(7 * 320),
    loaded,
    onProgress: (p) => seen.push(p.stage),
  });
  assert.deepEqual(seen, ['ctc-features', 'ctc-inference', 'ctc-align', 'done']);
});
