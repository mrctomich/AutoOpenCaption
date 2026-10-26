// ctc-aligner.js — experimental browser-side CTC forced alignment (Phase 3: chunked inference)
//
// Local-first: uses the SAME Transformers.js bundle (window.Transformers, v3.4.1) and the SAME
// model-caching behavior (resumable download + OPFS shim) as the Whisper pipeline. No new runtime.
//
// ---------------------------------------------------------------------------
// VERIFIED FACTS (probed 2026-10-21 against the checked-in Transformers.js v3.4.1 bundle,
// the Xenova/wav2vec2-base-960h repository, and a real q8 ONNX inference run — do not "fix"
// these from generic online docs, which describe newer APIs):
//
//  * Model files required (repo root-relative): config.json, tokenizer.json,
//    tokenizer_config.json, preprocessor_config.json, onnx/model_quantized.onnx.
//    Quantized ONNX ("q8" dtype) exists and measures 95,286,046 bytes (90.9 MiB).
//    (fp32 alternative onnx/model.onnx is ~361 MB — not used.)
//  * Vocabulary (tokenizer.json "model.vocab"): 32 entries, EXACT:
//      <pad>=0 </s>=2 <unk>=3 |=4 E=5 T=6 A=7 O=8 N=9 I=10 H=11 S=12 R=13 D=14 L=15 U=16
//      M=17 W=18 C=19 F=20 G=21 Y=22 P=23 B=24 V=25 K=26 '=27 X=28 J=29 Q=30 Z=31  (<s>=1)
//    i.e. letters are in FREQUENCY order, NOT alphabetical. <pad> (id 0) is pad_token_id
//    and serves as the CTC blank; "|" (id 4) is the word delimiter; "'" (id 27) is in-vocab.
//    ids 1,2,3 (<s>, </s>, <unk>) must never enter an alignment target.
//  * tokenizer.encode(text) returns per-character ids with NO special tokens appended.
//    The tokenizer is CASE-SENSITIVE: lowercase input maps to <unk> (3). We must upper-case
//    the transcript ourselves. The normalizer converts spaces to "|".
//  * tokenizer.vocab is NOT exposed on the tokenizer object in v3.4.1; char->id must be
//    derived from the tokenizer's own encode() (see buildCharIdMap).
//  * Feature extractor: `await fe(float32Array)` -> { input_values: Tensor float32 [1, N],
//    attention_mask }. It NORMALIZES (do_normalize=true) and is SINGLE-CLIP ONLY:
//    passing an array of clips throws ("expects input to be a Float32Array").
//  * Model call form in v3.4.1: `await model({ input_values })` (kwargs object), returns
//    { logits: Tensor float32 [1, numFrames, 32] }.
//  * Frame rate: conv strides [5,2,2,2,2,2,2] -> 320-sample stride = 20 ms/frame = 50 fps,
//    but the per-layer floor() means numFrames is NOT exactly floor(N/320)
//    (e.g. N=32000 -> 99 frames). Always derive timing from the actual logits dims.
//  * v3.4.1 hub downloads have NO AbortController support; cancellation is only possible
//    at our own inference boundaries (between windows) and via checking before load.
//  * Offline behavior verified: with the app's OPFS-style customCache shim,
//    allowRemoteModels=false and local wasmPaths, model load = ~0.6 s, q8 inference on
//    2 s of audio ~0.64 s on ONE wasm thread (browser multi-thread will be faster).
// ---------------------------------------------------------------------------

export const CTC_ALIGNER_EXPERIMENTAL = true;

export const CTC_MODEL_ID = "Xenova/wav2vec2-base-960h";
export const CTC_MODEL_DTYPE = "q8"; // onnx/model_quantized.onnx, 90.9 MiB
export const CTC_SUPPORTED_LANGUAGES = ["en"];

export const CTC_BLANK_ID = 0;   // <pad> doubles as the CTC blank
export const CTC_UNK_ID = 3;     // <unk> — must never enter an alignment target
export const CTC_DELIMITER_ID = 4; // "|" word delimiter
export const CTC_VOCAB_SIZE = 32;
export const CTC_SAMPLE_RATE = 16000;
export const CTC_FRAME_STRIDE_SAMPLES = 320; // 20 ms; actual per-window dims may floor differently

const TAG = "[ctc-aligner]";

/** Errors carrying a machine-readable code so the UI can explain failures. */
export class CtcAlignerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CtcAlignerError";
    this.code = code;
  }
}

export function isCtcAlignerAvailable(Transformers) {
  const T = Transformers ?? (typeof window !== "undefined" ? window.Transformers : null);
  return !!(T && (T.Wav2Vec2ForCTC ?? T.AutoModelForCTC) && T.AutoFeatureExtractor);
}

// ---------------------------------------------------------------------------
// Transcript normalization (pure — no model, no network; unit-tested in
// tests/ctc-aligner-core.test.mjs)
// ---------------------------------------------------------------------------

/**
 * Build a char->id table for the single-character alphabet by probing the tokenizer's own
 * encode(). v3.4.1 does not expose tokenizer.vocab, and encode() applies the real
 * normalizer + WordLevel split, so probing is the ground truth. Only ids that come back as
 * exactly ONE non-{blank,unk,delimiter} token count as representable characters.
 *
 * @param {{encode:(s:string)=>number[]}} tokenizer
 * @param {{blankId?:number, unkId?:number, delimiterId?:number}} [ids]
 */
export function buildCharIdMap(tokenizer, ids = {}) {
  const blankId = ids.blankId ?? CTC_BLANK_ID;
  const unkId = ids.unkId ?? CTC_UNK_ID;
  const delimiterId = ids.delimiterId ?? CTC_DELIMITER_ID;
  // <s>/</s> are always off-limits in a CTC target regardless of repo ids.
  const forbidden = new Set([blankId, unkId, delimiterId, 1, 2]);
  const map = new Map();
  // Full ASCII printable + letters that survive NFKD stripping.
  const candidates = [];
  for (let c = 0x20; c <= 0x7e; c++) candidates.push(String.fromCharCode(c));
  for (let c = 0xc0; c <= 0x17f; c++) candidates.push(String.fromCharCode(c));
  for (const ch of candidates) {
    let enc;
    try {
      enc = tokenizer.encode(ch);
    } catch {
      continue;
    }
    if (enc.length === 1 && !forbidden.has(enc[0])) {
      map.set(ch, enc[0]);
    }
  }
  return map;
}

/**
 * Normalize Whisper transcript words into a CTC target sequence.
 *
 * Rules (explicit, per experiment spec):
 *  - Text is upper-cased (the model's vocab has no lowercase).
 *  - Unicode NFKD, combining marks stripped (é -> E). This is lossy but representable.
 *  - Curly apostrophes (U+2018/2019/2032) become ' ; ' is representable and kept
 *    inside words (contractions like DON'T are in the vocab path).
 *  - Hyphens/em-dashes/underscores inside a word are dropped (pronounced-through).
 *  - Any other punctuation (.,;:!?()[]{}"«»… etc.) is dropped from alignment targets.
 *  - '|' (id 4) is inserted ONCE between consecutive alignable words as delimiter.
 *  - Characters with no vocab id (digits, non-Latin scripts, ß, …) make the WHOLE WORD
 *    unalignable — we never silently delete characters from a word we still return.
 *  - Words with zero representable characters (pure punctuation) are "empty" unalignable.
 *
 * @param {Array<{text?:string}|string>} words original order, identity = index
 * @param {Map<string, number>} charIdMap from buildCharIdMap()
 * @param {{delimiterId?:number}} [opts]
 * @returns {{
 *   tokenIds: number[],                // target sequence for Viterbi
 *   tokenWord: Int32Array,             // per token: source word index, or -1 for delimiter
 *   wordStatus: Map<number, "ready"|"empty"|"unsupported">,
 *   unalignable: Array<{index:number, text:string, reason:string, chars:string[]}>,
 *   readyWordCount: number
 * }}
 */
export function normalizeTranscript(words, charIdMap, opts = {}) {
  const delimiterId = opts.delimiterId ?? CTC_DELIMITER_ID;
  const tokenIds = [];
  const tokenWord = [];
  const wordStatus = new Map();
  const unalignable = [];

  const dropped = new Set(["-", "‐", "‑", "–", "—", "―", "_", "­"]); // hyphen family: pronounce-through
  const apostrophes = new Set(["'", "’", '‘', "‛", "ʼ"]);

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const raw = typeof w === "string" ? w : String(w?.text ?? "");
    const decomposed = raw.normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase();

    const letters = [];
    const badChars = new Set();
    for (const ch of decomposed) {
      if (dropped.has(ch)) continue;
      if (/\s/.test(ch)) continue; // word-internal whitespace: words are already split
      let id = charIdMap.get(ch);
      if (id === undefined && apostrophes.has(ch)) id = charIdMap.get("'"); // curly -> straight
      if (id !== undefined) {
        letters.push({ ch, id });
        continue;
      }
      // Unicode punctuation/symbols (.,;:!?()[]{}"«»…) are dropped: not pronounced.
      // Anything else left over (digits, non-Latin letters, ß, …) has no vocab sound:
      // the WHOLE word becomes unalignable — we never align a truncated word.
      if (/[\p{P}\p{S}]/u.test(ch)) continue;
      badChars.add(ch);
    }

    if (letters.length === 0) {
      wordStatus.set(i, "empty");
      unalignable.push({
        index: i,
        text: raw,
        reason: badChars.size ? "unsupported-characters" : "no-alignable-characters",
        chars: [...badChars],
      });
      continue;
    }
    if (badChars.size > 0) {
      // Partial support: do NOT align a truncated form of the word; keep it reported.
      wordStatus.set(i, "unsupported");
      unalignable.push({ index: i, text: raw, reason: "unsupported-characters", chars: [...badChars] });
      continue;
    }

    if (tokenIds.length > 0) {
      tokenIds.push(delimiterId);
      tokenWord.push(-1);
    }
    for (const { id } of letters) {
      tokenIds.push(id);
      tokenWord.push(i);
    }
    wordStatus.set(i, "ready");
  }

  return {
    tokenIds,
    tokenWord: Int32Array.from(tokenWord),
    wordStatus,
    unalignable,
    readyWordCount: [...wordStatus.values()].filter((s) => s === "ready").length,
  };
}

// ---------------------------------------------------------------------------
// Frame timing helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Convert a frame index range [frameStart, frameEnd] (inclusive frames of the logits
 * sequence for a window) to seconds, using the ACTUAL number of frames produced for
 * numSamples — not the nominal 320 stride — so window offsets add exactly once.
 *
 * @param {number} frameStart
 * @param {number} frameEnd
 * @param {number} numFrames logits frames for the window
 * @param {number} windowSamples samples in the window
 * @param {number} sampleRate
 * @param {number} windowOffsetSeconds audio offset of the window start
 */
export function frameRangeToSeconds(frameStart, frameEnd, numFrames, windowSamples, sampleRate, windowOffsetSeconds = 0) {
  if (numFrames <= 0 || windowSamples <= 0) {
    throw new CtcAlignerError("bad-frame-range", "cannot convert frames with zero-length window");
  }
  const secPerFrame = windowSamples / sampleRate / numFrames;
  const start = windowOffsetSeconds + frameStart * secPerFrame;
  // frameEnd inclusive -> end is the END of that frame
  const end = windowOffsetSeconds + (frameEnd + 1) * secPerFrame;
  return { start, end };
}

// ---------------------------------------------------------------------------
// Model loading (browser; mirrors the Whisper loader's env/caching behavior)
// ---------------------------------------------------------------------------

/**
 * Load the CTC acoustic model + feature extractor + tokenizer through the app's existing
 * Transformers.js bundle, which already has resumable download + OPFS caching wired via
 * env.customCache (resumable-fetch.js). Once cached, works offline.
 *
 * @param {{
 *   Transformers?: object,            // window.Transformers (auto-detected)
 *   modelId?: string,
 *   dtype?: string,                   // default "q8"
 *   onProgress?: (p:{stage:string, detail?:string, progress?:number}) => void,
 *   shouldCancel?: () => boolean,     // checked before load (v3.4.1 cannot abort downloads)
 * }} [options]
 * @returns {Promise<{
 *   model: object, featureExtractor: object, tokenizer: object,
 *   charIdMap: Map<string,number>, blankId:number, delimiterId:number, unkId:number,
 *   modelId: string, dtype: string
 * }>}
 */
export async function loadCtcAligner(options = {}) {
  const T = options.Transformers ?? (typeof window !== "undefined" ? window.Transformers : null);
  if (!isCtcAlignerAvailable(T)) {
    throw new CtcAlignerError(
      "transformers-missing",
      "Transformers.js bundle (window.Transformers) with Wav2Vec2ForCTC is not available."
    );
  }
  if (options.shouldCancel?.()) {
    throw new CtcAlignerError("cancelled", "Alignment was cancelled before model loading.");
  }
  const modelId = options.modelId ?? CTC_MODEL_ID;
  const dtype = options.dtype ?? CTC_MODEL_DTYPE;
  const onProgress = options.onProgress ?? (() => {});

  // Map transformers.js download progress events to our aligner progress.
  const progressCallback = (ev) => {
    if (!ev || typeof ev !== "object") return;
    if (ev.status === "progress") {
      onProgress({ stage: "download", detail: ev.file ?? "", progress: ev.progress });
    } else if (ev.status === "done") {
      onProgress({ stage: "download-done", detail: ev.file ?? "" });
    } else if (ev.status === "initiate") {
      onProgress({ stage: "download-start", detail: ev.file ?? "" });
    }
  };

  onProgress({ stage: "load-feature-extractor" });
  const featureExtractor = await T.AutoFeatureExtractor.from_pretrained(modelId, {
    progress_callback: progressCallback,
  });

  onProgress({ stage: "load-tokenizer" });
  const tokenizer = await T.AutoTokenizer.from_pretrained(modelId, {
    progress_callback: progressCallback,
  });

  onProgress({ stage: "load-model" });
  const ModelCtor = T.Wav2Vec2ForCTC ?? T.AutoModelForCTC;
  const model = await ModelCtor.from_pretrained(modelId, {
    dtype,
    progress_callback: progressCallback,
  });

  // Validate the essentials against what the algorithm assumes; fail loudly rather than
  // aligning against a misread vocabulary.
  const charIdMap = buildCharIdMap(tokenizer);
  const delimiterOk = (() => {
    try { return tokenizer.encode("|").length === 1 && tokenizer.encode("|")[0] === CTC_DELIMITER_ID; } catch { return false; }
  })();
  if (!delimiterOk) {
    throw new CtcAlignerError("vocab-mismatch", "Expected '|' delimiter (id 4) was not confirmed via tokenizer.encode().");
  }
  if (!charIdMap.has("A") || !charIdMap.has("'")) {
    throw new CtcAlignerError("vocab-mismatch", "Expected A-Z and apostrophe to be representable; they are not.");
  }

  onProgress({ stage: "ready" });
  return {
    model,
    featureExtractor,
    tokenizer,
    charIdMap,
    blankId: CTC_BLANK_ID,
    delimiterId: CTC_DELIMITER_ID,
    unkId: CTC_UNK_ID,
    modelId,
    dtype,
  };
}

// ---------------------------------------------------------------------------
// Viterbi CTC forced-alignment core (Phase 2) — pure: consumes logits, emits frames.
// No model, no DOM, no network; unit-tested with synthetic emissions.
// ---------------------------------------------------------------------------

// A token whose frames average less probability than this had no real acoustic evidence.
// Uniform (zero-information) emissions over the 32-class vocab give p = 1/32 ≈ 0.031, so
// 0.05 flags "the model is not telling us anything about this word" without punishing
// merely-difficult frames. Overridable per call; Phase 5 will tune it on real fixtures.
export const CTC_MIN_TOKEN_LOGPROB = Math.log(0.05); // ≈ -3.0 nats

// Safety cap on the backpointer table (T * (2S+1) Int8 entries). Chunk planning keeps
// windows small, so this normally never fires — it remains as a final memory guard for
// degenerate cases (e.g. a huge transcript crammed into one tiny audio window).
const MAX_VITERBI_CELLS = 1 << 27; // 134M entries ≈ 134 MB

/**
 * Log-space Viterbi forced alignment over an exact CTC target (Graves & Graves, Ch. 7).
 *
 * State layout interleaves blanks: 0=B, 1=t0, 2=B, 3=t1, ..., 2S=B — 2S+1 states, where
 * state 2j+1 emits tokenIds[j] and even states emit the CTC blank. Every valid CTC path
 * for the target corresponds to exactly one state path, and the token→token transition
 * (2j-1 → 2j+1) is only allowed when the two token ids DIFFER — which is precisely what
 * makes "AA" (needs a blank between) distinct from a single "A" run.
 *
 * Memory: two Float64 rows over states + Int8Array(T * states) backpointers = O(T * 2S).
 *
 * @param {ArrayLike<number>} logitsData flat row-major [T x vocabSize] frame logits
 * @param {number} numFrames           T (read from actual logits dims — see header fact)
 * @param {number} vocabSize           32 for wav2vec2-base-960h
 * @param {ArrayLike<number>} tokenIds target sequence (blank id forbidden)
 * @param {{blankId?: number}} [opts]
 * @returns {{ feasible: true, bestLogProb: number, avgLogProbPerFrame: number,
 *             pathTokens: Int32Array,           // per frame: token index j, -1 = blank
 *             tokenFirstFrame: Int32Array, tokenLastFrame: Int32Array,
 *             tokenFrameCount: Int32Array,      // >= 1 for every token on a feasible path
 *             tokenLogProb: Float64Array,       // summed log p(emission) over its frames
 *             numFrames: number }
 *         | { feasible: false, reason: "too-few-frames" | "no-path", numFrames: number }}
 */
export function forcedAlignViterbi(logitsData, numFrames, vocabSize, tokenIds, opts = {}) {
  const blankId = opts.blankId ?? CTC_BLANK_ID;
  const T = numFrames | 0;
  const V = vocabSize | 0;
  const S = tokenIds.length;
  if (T <= 0 || V <= 0) throw new CtcAlignerError("bad-logits", "numFrames and vocabSize must be positive");
  if (logitsData.length < T * V) {
    throw new CtcAlignerError("bad-logits", `logitsData has ${logitsData.length} values, need ${T} x ${V}`);
  }
  for (let j = 0; j < S; j++) {
    const id = tokenIds[j];
    if (!Number.isInteger(id) || id < 0 || id >= V) {
      throw new CtcAlignerError("bad-target", `token id ${id} at ${j} out of range [0, ${V})`);
    }
    if (id === blankId) throw new CtcAlignerError("bad-target", "blank id cannot appear in the CTC target");
  }
  if (S === 0) {
    return {
      feasible: true, bestLogProb: 0, avgLogProbPerFrame: 0,
      pathTokens: new Int32Array(T).fill(-1),
      tokenFirstFrame: new Int32Array(0), tokenLastFrame: new Int32Array(0),
      tokenFrameCount: new Int32Array(0), tokenLogProb: new Float64Array(0),
      numFrames: T,
    };
  }
  // Shortest possible CTC path: one frame per token plus one blank between every pair of
  // ADJACENT EQUAL tokens (they cannot merge). 2S-1 would be the worst case only — e.g.
  // HELLO fits in 6 frames (H E L _ L O), not 9.
  let minFrames = S;
  for (let j = 1; j < S; j++) if (tokenIds[j] === tokenIds[j - 1]) minFrames++;
  if (T < minFrames) {
    return { feasible: false, reason: "too-few-frames", numFrames: T, requiredFrames: minFrames };
  }
  const states = 2 * S + 1;
  if (T * states > MAX_VITERBI_CELLS) {
    throw new CtcAlignerError(
      "window-too-large",
      `Viterbi table would need ${T} x ${states} cells (> ${MAX_VITERBI_CELLS}); window too large for single-pass alignment.`
    );
  }

  const NEG = Number.NEGATIVE_INFINITY;
  let alpha = new Float64Array(states).fill(NEG);
  let nextAlpha = new Float64Array(states);
  const frameLse = new Float64Array(T); // log-sum-exp per frame, reused during backtrack
  const lp = new Float64Array(V);       // log-softmax of the current frame
  const bp = new Int8Array(T * states); // 0 = stayed, 1 = came from s-1, 2 = came from s-2

  const logSoftmaxFrame = (t) => {
    const base = t * V;
    let max = logitsData[base];
    for (let v = 1; v < V; v++) { const x = logitsData[base + v]; if (x > max) max = x; }
    let sum = 0;
    for (let v = 0; v < V; v++) sum += Math.exp(logitsData[base + v] - max);
    const lse = max + Math.log(sum);
    frameLse[t] = lse;
    for (let v = 0; v < V; v++) lp[v] = logitsData[base + v] - lse;
  };

  // t = 0: a path may start on the leading blank (state 0) or already emit the first token.
  logSoftmaxFrame(0);
  alpha[0] = lp[blankId];
  alpha[1] = lp[tokenIds[0]];

  for (let t = 1; t < T; t++) {
    logSoftmaxFrame(t);
    const lpBlank = lp[blankId];
    nextAlpha.fill(NEG);
    const row = t * states;
    // Even (blank) states 2j: stay, or arrive from the preceding token state 2j-1.
    for (let j = 0; j <= S; j++) {
      const s = 2 * j;
      let best = alpha[s];
      let from = 0;
      if (s > 0 && alpha[s - 1] > best) { best = alpha[s - 1]; from = 1; }
      nextAlpha[s] = best + lpBlank;
      bp[row + s] = from;
    }
    // Odd (token) states 2j+1: stay, arrive from blank 2j, or — only when the label
    // differs from token j-1 — jump directly from token state 2j-1.
    for (let j = 0; j < S; j++) {
      const s = 2 * j + 1;
      let best = alpha[s];
      let from = 0;
      if (alpha[s - 1] > best) { best = alpha[s - 1]; from = 1; }
      if (j > 0 && tokenIds[j] !== tokenIds[j - 1] && alpha[s - 2] > best) { best = alpha[s - 2]; from = 2; }
      nextAlpha[s] = best + lp[tokenIds[j]];
      bp[row + s] = from;
    }
    const swap = alpha; alpha = nextAlpha; nextAlpha = swap;
  }

  // Path ends on the trailing blank or on the last token.
  const endState = alpha[2 * S] >= alpha[2 * S - 1] ? 2 * S : 2 * S - 1;
  const bestLogProb = alpha[endState];
  if (!Number.isFinite(bestLogProb)) {
    return { feasible: false, reason: "no-path", numFrames: T };
  }

  const pathTokens = new Int32Array(T).fill(-1);
  const tokenFirstFrame = new Int32Array(S).fill(-1);
  const tokenLastFrame = new Int32Array(S).fill(-1);
  const tokenFrameCount = new Int32Array(S);
  const tokenLogProb = new Float64Array(S);

  let s = endState;
  for (let t = T - 1; t >= 0; t--) {
    if (s % 2 === 1) {
      const j = (s - 1) >> 1;
      pathTokens[t] = j;
      if (tokenLastFrame[j] === -1) tokenLastFrame[j] = t; // first hit walking back = last frame
      tokenFirstFrame[j] = t;                              // keeps overwriting down to first frame
      tokenFrameCount[j]++;
      tokenLogProb[j] += logitsData[t * V + tokenIds[j]] - frameLse[t];
    }
    if (t > 0) s -= bp[t * states + s];
  }

  return {
    feasible: true, bestLogProb, avgLogProbPerFrame: bestLogProb / T,
    pathTokens, tokenFirstFrame, tokenLastFrame, tokenFrameCount, tokenLogProb,
    numFrames: T,
  };
}

/**
 * Aggregate a feasible Viterbi alignment into per-word frame spans + seconds, using the
 * tokenWord map from normalizeTranscript(). Delimiter tokens are skipped for spans and
 * confidence. A word is flagged lowConfidence when any of its tokens sits on < 1 frame or
 * averages emission log-prob below minTokenLogProb — the caller then KEEPS the Whisper
 * estimate instead of forcing the CTC timestamps (never truncates, never reorders).
 *
 * @param {ReturnType<typeof forcedAlignViterbi>} alignment (must be feasible)
 * @param {{tokenIds:number[], tokenWord:Int32Array}} norm result of normalizeTranscript()
 * @param {{ numFrames:number, windowSamples:number, sampleRate:number,
 *           windowOffsetSeconds?:number, minTokenLogProb?:number }} opts
 * @returns {Map<number, { frameStart:number, frameEnd:number, start:number, end:number,
 *           confidence:number, lowConfidence:boolean }>} key = source word index
 */
export function buildWordTiming(alignment, norm, opts = {}) {
  const out = new Map();
  if (!alignment || !alignment.feasible) return out;
  const { numFrames, windowSamples, sampleRate, windowOffsetSeconds = 0,
    minTokenLogProb = CTC_MIN_TOKEN_LOGPROB } = opts;
  const { tokenWord } = norm;

  for (let j = 0; j < tokenWord.length; j++) {
    const w = tokenWord[j];
    if (w < 0) continue; // word delimiter
    const count = alignment.tokenFrameCount[j];
    let cur = out.get(w);
    if (!cur) {
      cur = { frameStart: alignment.tokenFirstFrame[j], frameEnd: alignment.tokenLastFrame[j],
        logProbSum: 0, frameTotal: 0, lowConfidence: false };
      out.set(w, cur);
    }
    if (alignment.tokenFirstFrame[j] < cur.frameStart) cur.frameStart = alignment.tokenFirstFrame[j];
    if (alignment.tokenLastFrame[j] > cur.frameEnd) cur.frameEnd = alignment.tokenLastFrame[j];
    cur.logProbSum += alignment.tokenLogProb[j];
    cur.frameTotal += count;
    if (count < 1) cur.lowConfidence = true;
    else if (alignment.tokenLogProb[j] / count < minTokenLogProb) cur.lowConfidence = true;
  }

  for (const cur of out.values()) {
    cur.confidence = cur.frameTotal > 0 ? cur.logProbSum / cur.frameTotal : Number.NEGATIVE_INFINITY;
    const range = frameRangeToSeconds(cur.frameStart, cur.frameEnd, numFrames, windowSamples,
      sampleRate, windowOffsetSeconds);
    cur.start = range.start;
    cur.end = range.end;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chunk planning (Phase 3) — pure: audio length + normalized target -> window list.
// ---------------------------------------------------------------------------

// wav2vec2 tolerates ~25 s per inference; the ~1.5 s overlap absorbs Whisper word-start
// error at the seams so each seam can always cut at a word boundary inside the overlap.
export const CTC_WINDOW_DURATION_SECONDS = 25;
export const CTC_WINDOW_OVERLAP_SECONDS = 1.5;

/**
 * Plan inference windows. Windows tile the audio on a fixed grid
 * (window k covers [k*step, min(total, k*step + duration)) with step = duration - overlap,
 * so consecutive windows overlap). Each READY word is assigned to exactly one window —
 * the earliest one whose audio interval contains the word's START hint (falling back to
 * its end hint, then the previous word's anchor when timestamps are missing) — so a word
 * straddling a seam lands in the window that actually contains where it begins. Windows
 * with no words are skipped entirely (no inference wasted on pure silence); assignment
 * is monotonic in word order even when Whisper timestamps are out of order, and a
 * per-window token cap (>= 1 frame per token) spills overflow words into the next window
 * so degenerate hint-less inputs cannot cram everything into one window.
 *
 * Cut points are always word boundaries: window token ranges are contiguous, cover every
 * token exactly once, and never split a word. A word's leading delimiter token belongs to
 * the gap before the word, so it travels with the LATER window as its first token.
 *
 * @param {object} input
 * @param {number} input.totalSamples      samples of 16 kHz mono audio (> 0)
 * @param {number} [input.sampleRate]
 * @param {object} input.norm              result of normalizeTranscript()
 * @param {Array}  [input.words]           original word objects (for .start/.end hints)
 * @param {number} [input.windowDurationSeconds]
 * @param {number} [input.overlapSeconds]
 * @returns {Array<{startSample: number, endSample: number, tokenStart: number, tokenEnd: number}>}
 *   windows in audio order; tokenStart/tokenEnd are GLOBAL indices into norm.tokenIds
 */
export function planCtcWindows(input = {}) {
  const totalSamples = input.totalSamples | 0;
  if (totalSamples <= 0) {
    throw new CtcAlignerError('bad-input', 'planCtcWindows: totalSamples must be positive');
  }
  const norm = input.norm;
  if (!norm || !Array.isArray(norm.tokenIds) || !(norm.tokenWord instanceof Int32Array)) {
    throw new CtcAlignerError('bad-input', 'planCtcWindows: norm must come from normalizeTranscript()');
  }
  const sampleRate = input.sampleRate ?? CTC_SAMPLE_RATE;
  const words = Array.isArray(input.words) ? input.words : [];
  const durationSamples = Math.max(2 * CTC_FRAME_STRIDE_SAMPLES,
    Math.round((input.windowDurationSeconds ?? CTC_WINDOW_DURATION_SECONDS) * sampleRate));
  const overlapSamples = Math.max(0, Math.min(
    Math.round((input.overlapSeconds ?? CTC_WINDOW_OVERLAP_SECONDS) * sampleRate),
    Math.floor(durationSamples / 2)));
  const step = durationSamples - overlapSamples;
  const numAudioWindows = totalSamples <= durationSamples
    ? 1
    : 1 + Math.ceil((totalSamples - durationSamples) / step);
  const lastIdx = numAudioWindows - 1;
  // Every token needs at least one frame: upper bound of useful tokens per window.
  const capTokens = Math.max(1, Math.floor(durationSamples / CTC_FRAME_STRIDE_SAMPLES));

  // Letter extents per word (delimiters have tokenWord = -1).
  const firstLetter = new Map();
  const lastLetter = new Map();
  for (let j = 0; j < norm.tokenWord.length; j++) {
    const w = norm.tokenWord[j];
    if (w < 0) continue;
    if (!firstLetter.has(w)) firstLetter.set(w, j);
    lastLetter.set(w, j);
  }
  const ranges = []; // { word, tokStart (incl. leading delimiter), tokEnd }
  if (norm.wordStatus instanceof Map) {
    for (const [w, st] of norm.wordStatus) {
      if (st === 'ready' && firstLetter.has(w)) {
        const f = firstLetter.get(w);
        ranges.push({
          word: w,
          tokStart: f > 0 && norm.tokenWord[f - 1] === -1 ? f - 1 : f,
          tokEnd: lastLetter.get(w) + 1,
        });
      }
    }
    ranges.sort((a, b) => a.word - b.word);
  }
  if (ranges.length === 0) return [];

  // Earliest window whose audio interval contains the anchor sample position.
  const windowForAnchor = (samplePos) => {
    const p = samplePos > 0 ? samplePos : 0;
    const k = p < durationSamples ? 0 : Math.floor((p - durationSamples) / step) + 1;
    return Math.min(lastIdx, Math.max(0, k));
  };

  const groups = [];
  let group = null;
  let carrySec = 0; // previous word's anchor: fallback when timestamps are missing
  for (const r of ranges) {
    const src = words[r.word];
    const s = src && Number.isFinite(src.start) ? src.start : null;
    const e = src && Number.isFinite(src.end) ? src.end : null;
    const anchorSec = s !== null ? s : e !== null ? e : carrySec;
    carrySec = anchorSec;
    let k = windowForAnchor(anchorSec * sampleRate);
    if (group && k < group.k) k = group.k; // monotonic in word order despite bad hints
    const wTok = r.tokEnd - r.tokStart;
    if (group && k === group.k && group.tokens + wTok > capTokens && group.k < lastIdx) {
      k = group.k + 1; // cap overflow: start spilling into the next window
    }
    if (!group || k !== group.k) {
      group = { k, tokStart: r.tokStart, tokEnd: r.tokEnd, tokens: 0 };
      groups.push(group);
    } else {
      group.tokEnd = r.tokEnd; // contiguous: consecutive ready words share a boundary
    }
    group.tokens += wTok;
  }

  return groups.map((g) => ({
    startSample: Math.min(g.k * step, totalSamples - 1),
    endSample: Math.min(totalSamples, g.k * step + durationSamples),
    tokenStart: g.tokStart,
    tokenEnd: g.tokEnd,
  }));
}

// ---------------------------------------------------------------------------
// Entry point (contract fixed in Phase 1; Phase 3 = chunked inference per
// planCtcWindows — nothing else in the flow changes)
// ---------------------------------------------------------------------------

/**
 * EXPERIMENTAL forced alignment of an existing Whisper transcript to audio.
 *
 * Contract (stays stable through phases 2-3):
 * @param {{
 *   words: Array<{id?:*, text:string, start?:number, end?:number}>,  // original order preserved
 *   samples: Float32Array,        // mono 16 kHz (same buffer Whisper used)
 *   sampleRate?: number,          // default 16000
 *   loaded?: object,              // from loadCtcAligner()
 *   onProgress?: (p) => void,       // {stage, window, windows}: window is 1-based, per inference window
 *   shouldCancel?: () => boolean,   // checked between windows/stages; an ONNX call itself cannot abort
 *   minTokenLogProb?: number,       // confidence override (see CTC_MIN_TOKEN_LOGPROB)
 *   windowDurationSeconds?: number, // chunk planning override (see planCtcWindows)
 *   overlapSeconds?: number,        // chunk planning override (see planCtcWindows)
 * }} input
 * @returns {Promise<{
 *   words: Array<{ id:*, text:string, start:number, end:number,
 *                  alignment:"ctc"|"estimated"|"unalignable",
 *                   originalStart?:number, originalEnd?:number }>,
 *   stats: { total:number, ctc:number, estimated:number, unalignable:number,
 *            windows:number, inferenceMs:number },  // windows = number of inference windows
 *   unalignable: Array<{index:number, text:string, reason:string, chars:string[]}>,
 * }>}
 *
 * Per-word alignment classes:
 *  - "ctc": timestamps replaced by CTC-Viterbi evidence (originals kept on originalStart/End).
 *  - "estimated": no (usable) CTC evidence; the Whisper timestamp is kept as-is. This includes
 *    low-confidence CTC paths ("the model says nothing about this word") — we never force them.
 *  - "unalignable": neither CTC evidence nor a usable Whisper timestamp; start/end are filled
 *    by forward fill from the previous word for display only.
 * Words with no CTC evidence are reported in `unalignable` with a reason
 * ("unsupported-characters" | "no-alignable-characters" | "low-confidence" |
 *  "alignment-infeasible").
 *
 * Guarantees: input words are never reordered, dropped, or rewritten; word identity (id or
 * index) is preserved; original timestamps remain on originalStart/originalEnd for undo;
 * Whisper hint timestamps are NEVER used as alignment priors (Viterbi is audio-only).
 */
export async function alignCtcTranscript(input = {}) {
  const words = Array.isArray(input.words) ? input.words : null;
  if (!words) throw new CtcAlignerError("bad-input", "alignCtcTranscript: input.words must be an array");
  const samples = input.samples;
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    throw new CtcAlignerError("bad-input", "alignCtcTranscript: input.samples must be a non-empty Float32Array");
  }
  const loaded = input.loaded;
  if (!loaded || typeof loaded.model !== "function" || typeof loaded.featureExtractor !== "function"
    || !(loaded.charIdMap instanceof Map)) {
    throw new CtcAlignerError("bad-input", "alignCtcTranscript: input.loaded must come from loadCtcAligner()");
  }
  const sampleRate = input.sampleRate ?? CTC_SAMPLE_RATE;
  const shouldCancel = input.shouldCancel ?? null;
  const onProgress = input.onProgress ?? (() => {});
  const checkCancel = (stage) => {
    if (shouldCancel && shouldCancel()) {
      throw new CtcAlignerError("cancelled", `Alignment was cancelled at stage: ${stage}`);
    }
  };

  checkCancel("start");
  const norm = normalizeTranscript(words, loaded.charIdMap, { delimiterId: loaded.delimiterId });

  // Result skeleton: identity + original timestamps fixed NOW, before any inference.
  const outWords = words.map((w, i) => {
    const obj = typeof w === "string" ? { text: w } : (w ?? {});
    return {
      id: obj.id ?? i,
      text: typeof obj.text === "string" ? obj.text : String(obj.text ?? w ?? ""),
      originalStart: Number.isFinite(obj.start) ? obj.start : null,
      originalEnd: Number.isFinite(obj.end) ? obj.end : null,
      start: null,
      end: null,
      alignment: "estimated",
    };
  });

  const stats = { total: outWords.length, ctc: 0, estimated: 0, unalignable: 0, windows: 0, inferenceMs: 0 };
  const unalignableOut = [];
  const timing = new Map(); // word idx -> { start, end, lowConfidence } (GLOBAL seconds)
  const infeasibleWords = new Set(); // word idx whose window could not be aligned

  if (norm.readyWordCount > 0) {
    // Phase 3: chunked inference. Each planned window = one featureExtractor call + one
    // model call + one Viterbi over that window's token range (word-boundary-safe seams,
    // see planCtcWindows). windowOffsetSeconds makes frameRangeToSeconds return GLOBAL
    // times, applied exactly once per window.
    const plan = planCtcWindows({
      totalSamples: samples.length,
      sampleRate,
      norm,
      words,
      windowDurationSeconds: input.windowDurationSeconds,
      overlapSeconds: input.overlapSeconds,
    });
    stats.windows = plan.length;

    for (let wi = 0; wi < plan.length; wi++) {
      const win = plan[wi];
      // v3.4.1 cannot abort a running ONNX call — we only cancel at boundaries between
      // windows and stages.
      checkCancel("features");
      onProgress({ stage: "ctc-features", window: wi + 1, windows: plan.length });
      const clip = samples.subarray(win.startSample, win.endSample);
      const feOut = await loaded.featureExtractor(clip);

      checkCancel("inference");
      onProgress({ stage: "ctc-inference", window: wi + 1, windows: plan.length });
      const t0 = Date.now();
      const modelOut = await loaded.model({ input_values: feOut.input_values }); // v3.4.1 kwargs form
      stats.inferenceMs += Date.now() - t0;

      const logits = modelOut?.logits;
      if (!logits || !logits.data || !Array.isArray(logits.dims) || logits.dims.length !== 3 || logits.dims[0] !== 1) {
        throw new CtcAlignerError("bad-logits", "model output is not a [1, numFrames, vocab] logits tensor");
      }
      const numFrames = logits.dims[1];
      const vocabSize = logits.dims[2];

      checkCancel("viterbi");
      onProgress({ stage: "ctc-align", window: wi + 1, windows: plan.length });
      const windowTokenIds = norm.tokenIds.slice(win.tokenStart, win.tokenEnd);
      let alignment = null;
      try {
        alignment = forcedAlignViterbi(logits.data, numFrames, vocabSize, windowTokenIds, {
          blankId: loaded.blankId ?? CTC_BLANK_ID,
        });
      } catch (err) {
        // Memory guard tripped: this window's audio/transcript combo is unusable.
        // Degrade its words instead of failing the whole alignment.
        if (err instanceof CtcAlignerError && err.code === "window-too-large") alignment = null;
        else throw err;
      }
      if (alignment && alignment.feasible) {
        const wTiming = buildWordTiming(alignment, {
          tokenIds: windowTokenIds,
          tokenWord: norm.tokenWord.subarray(win.tokenStart, win.tokenEnd), // word indices stay GLOBAL
        }, {
          numFrames,
          windowSamples: win.endSample - win.startSample,
          sampleRate,
          windowOffsetSeconds: win.startSample / sampleRate,
          minTokenLogProb: input.minTokenLogProb ?? CTC_MIN_TOKEN_LOGPROB,
        });
        for (const [idx, span] of wTiming) timing.set(idx, span);
      } else {
        // e.g. transcript longer than this window's audio can possibly hold.
        for (let j = win.tokenStart; j < win.tokenEnd; j++) {
          const w = norm.tokenWord[j];
          if (w >= 0) infeasibleWords.add(w);
        }
      }
    }
  }

  for (let i = 0; i < outWords.length; i++) {
    const out = outWords[i];
    const span = timing.get(i);
    const status = norm.wordStatus.get(i);
    const src = norm.unalignable.find((u) => u.index === i);
    if (status === "ready" && span && !span.lowConfidence) {
      out.alignment = "ctc";
      out.start = span.start;
      out.end = Math.max(span.end, span.start + 1e-6);
      stats.ctc++;
      continue;
    }
    // No usable CTC evidence: keep the Whisper estimate, report why.
    let reason;
    if (status === "ready") {
      reason = span ? "low-confidence" : (infeasibleWords.has(i) ? "alignment-infeasible" : "no-timing");
    } else {
      reason = src ? src.reason : "no-alignable-characters";
    }
    unalignableOut.push({ index: i, text: out.text, reason, chars: src ? src.chars : [] });
    if (out.originalStart !== null) {
      out.alignment = "estimated";
      out.start = out.originalStart;
      out.end = out.originalEnd !== null ? out.originalEnd : out.originalStart;
      stats.estimated++;
    } else {
      out.alignment = "unalignable"; // timestamps forward-filled below, display only
      stats.unalignable++;
    }
  }

  // Forward-fill timestamps for words that have neither CTC nor Whisper timing.
  let cursor = 0;
  for (const out of outWords) {
    if (out.start === null) { out.start = cursor; out.end = cursor; }
    cursor = Math.max(cursor, out.end);
  }

  onProgress({ stage: "done" });
  return { words: outWords, stats, unalignable: unalignableOut };
}
