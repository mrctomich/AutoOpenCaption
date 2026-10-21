/**
 * WhisperAdapter
 *
 * Converts Whisper pipeline output into the application's internal
 * transcript model. Handles multiple output schemas from different
 * Whisper ONNX exports:
 *
 *   Schema A (word-level):  chunks[].words[].{ word, timestamp }
 *   Schema A2 (transformers.js return_timestamps:'word'): every WORD is its
 *     own flat chunk chunks[].{ text, timestamp } — real alignment, NOT a
 *     segment to estimate over. Opt in with options.wordLevelTimestamps.
 *   Schema B (segment-level): chunks[].{ text, timestamp }
 *   Schema C (no chunks):   { text } only
 *
 * Internal Transcript Model:
 *   { version, sourceFile, language, words: Word[] }
 *   Word = { id, text, start, end, deleted }
 *   Repaired/estimated words additionally carry:
 *     { estimated: true, estimatedReason, originalStart, originalEnd,
 *       unplaced? }   // estimates — NOT verified against the audio
 */

let _nextId = 0;

const FALLBACK_WORD_DURATION = 0.25; // avg estimate/word when a trailing run has no upper anchor

function makeId() {
    return `w${String(_nextId++).padStart(4, '0')}`;
}

// A timestamp value is either a finite number or null — never silently 0.
// 0 is a LEGAL timestamp (a word can be spoken at t=0); null means the model
// gave us nothing, which is different information and must survive to the
// sanitizer so the word is repaired instead of pinned to the start.
function toStamp(v) {
    const n = Number(v);
    return (v == null || !Number.isFinite(n)) ? null : n;
}

function splitSegmentToWords(text, start, end) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    // Even spacing across a segment window is an ESTIMATE, not an alignment.
    // Non-finite / inverted windows yield null stamps so sanitizeWords()
    // repairs the words instead of fabricating a span from NaN.
    const s = toStamp(start);
    const e = toStamp(end);
    const segWindow = (s !== null && e !== null && e > s) ? (e - s) : null;
    const duration = segWindow !== null ? segWindow : FALLBACK_WORD_DURATION * words.length;

    return words.map((word, i) => {
        if (segWindow === null) {
            return {
                id: makeId(), text: word, start: null, end: null, deleted: false,
                estimated: true, estimatedReason: 'segment-split', originalStart: null, originalEnd: null
            };
        }
        // Cumulative rounding: segment boundaries stay exact and monotone.
        return {
            id: makeId(),
            text: word,
            start: Math.round((s + (i / words.length) * duration) * 100) / 100,
            end: Math.round((s + ((i + 1) / words.length) * duration) * 100) / 100,
            deleted: false,
            estimated: true, estimatedReason: 'segment-split', originalStart: null, originalEnd: null
        };
    });
}

/**
 * Repair invalid word timestamps (missing / zero / equal start+end /
 * backward jumps / beyond audio) produced by Whisper's cross-attention
 * entropy alignment — it collapses runs of words to identical stamps on
 * singing or speech-over-music.
 *
 * A word is VALID when it has all of:
 *   * both stamps present (null/NaN are NOT coerced to 0 — see toStamp),
 *   * 0 <= start < end,
 *   * start >= the previous valid word's start (monotone model order),
 *   * start < audio duration (when known).
 *
 * Invalid words are repaired as contiguous runs. Each run gets a window
 * [lo, hi] that it can NEVER expand past:
 *   lo = previous valid word's end, or the run's own collapsed stamp when
 *        the run carried finite ones (it weakly locates where it was
 *        spoken);
 *   hi = next valid word's start, hard-capped at the audio duration. A
 *        trailing run with unknown duration is paced at
 *        FALLBACK_WORD_DURATION per word.
 * Boundaries inside the window are cumulative-rounded, weighted by word
 * length: every word gets at least 1 centisecond when the window has
 * room, and the last boundary lands exactly on hi — so a repair can
 * never overwrite or push a healthy neighbor.
 *
 * NOT-enough-room policy: when the window is shorter than the run, we
 * cannot give every word a positive duration without violating the
 * bounds. We deliberately do NOT invent space (that would imply more
 * accuracy than we have): the words spread proportionally inside the
 * window and may end up with zero duration, flagged `unplaced`. The
 * renderer's group-level minimum duration keeps the caption visible;
 * word-level highlighting for unplaced words is, honestly, unreliable.
 *
 * Healthy model timestamps are emitted byte-identical — no clamping, no
 * overlap resolution. Rendering constraints (minimum cue duration, cue
 * overlap) belong to the renderer, e.g. CaptionRenderer.groupWords().
 *
 * Repaired words are flagged so estimates stay distinguishable from real
 * alignments: estimated: true, estimatedReason ('collapsed' | 'missing' |
 * 'negative' | 'beyond-audio' | 'out-of-order'), originalStart/originalEnd
 * (raw model values, null when the model provided none), unplaced?: true.
 *
 * @param {Array} words  Word[] with raw start/end
 * @param {number|null} audioDuration total audio length in seconds, if known
 * @returns {{ words: Array, repaired: number, unplaced: number, runs: number }}
 */
export function sanitizeWords(words, audioDuration = null) {
    if (!words.length) return { words, repaired: 0, unplaced: 0, runs: 0 };

    // Repaired boundaries are clamped EXACTLY to the healthy neighbours
    // (model stamps can sit at sub-centisecond values — rounding a bound
    // could push a repaired word past its neighbour). Interior boundaries
    // are additionally quantised to whole-centisecond steps so exports stay
    // tidy when the window allows it.
    const durSec = (Number.isFinite(audioDuration) && audioDuration > 0)
        ? Math.floor(audioDuration * 100) / 100 : null;

    // Pass 1: classify each word, keeping model order.
    const items = [];
    let lastStart = -Infinity;
    for (const w of words) {
        const rawS = w.start, rawE = w.end;
        const s = Number(rawS), e = Number(rawE);
        let reason = null;
        if (rawS == null || rawE == null || !Number.isFinite(s) || !Number.isFinite(e)) reason = 'missing';
        else if (e === s) reason = 'collapsed';
        else if (s < 0 || e < s) reason = 'negative';
        else if (durSec !== null && s >= durSec) reason = 'beyond-audio';
        else if (s < lastStart) reason = 'out-of-order';
        items.push({ w, s, e, ok: reason === null, reason });
        if (reason === null) lastStart = s;
    }

    // Pass 2: repair each invalid run strictly inside its bounded window.
    let repaired = 0, unplaced = 0, runs = 0;
    let i = 0;
    while (i < items.length) {
        if (items[i].ok) { i++; continue; }
        let j = i;
        while (j < items.length && !items[j].ok) j++;
        const runLen = j - i;

        let lo = i > 0 ? items[i - 1].e : 0;
        // The collapsed stamps themselves are unreliable for duration but they
        // weakly locate the run: when finite and after the previous word, keep
        // the run at its collapsed position instead of sliding it backwards.
        // Missing stamps (null) are skipped — Number(null) === 0 would drag
        // the anchor to the start of the audio.
        let anchorMin = Infinity;
        for (let k = i; k < j; k++) {
            if (items[k].w.start == null || !Number.isFinite(Number(items[k].w.start))) continue;
            const a = Number(items[k].w.start);
            if (a < anchorMin) anchorMin = a;
        }
        if (Number.isFinite(anchorMin) && anchorMin > lo) lo = anchorMin;

        // Hard upper bound — the run can never overrun the next valid word or
        // the end of the audio. Kept as EXACT seconds, never rounded: a bound
        // rounded UP could push the repair past the healthy neighbour.
        let hi;
        if (j < items.length) hi = items[j].s;
        if (durSec !== null) hi = (hi === undefined ? durSec : Math.min(hi, durSec));
        if (hi === undefined || !Number.isFinite(hi)) hi = lo + runLen * FALLBACK_WORD_DURATION;
        if (hi < lo) {
            // Healthy neighbours themselves overlap (previous end is past the
            // next word's start) or the anchor sits beyond the audio end.
            // Place the run AT the upper bound instead of pushing past it:
            // monotone start order beats keeping the weak anchor, and the
            // zero-length window flags every word in the run `unplaced`.
            lo = hi;
        }
        const window = hi - lo;
        const windowCs = window * 100;

        // Distribute the window across the run, weighted by word length.
        // Targets step in whole centiseconds from lo; every boundary is
        // clamped into [previous boundary, hi] and the last lands exactly on
        // hi. Feasible ⇒ >= 1cs per word; infeasible ⇒ proportional spread
        // with zero durations, every word flagged `unplaced`.
        const weights = items.slice(i, j)
            .map((it) => Math.max(1, String(it.w.text || '').trim().length));
        const totalW = weights.reduce((a, b) => a + b, 0);
        const feasible = windowCs >= runLen - 1e-9;
        const bounds = [lo];
        let cum = 0;
        for (let k = 0; k < runLen; k++) {
            cum += weights[k];
            const stepCs = feasible
                ? (k + 1) + Math.round((windowCs - runLen) * cum / totalW)
                : Math.round(windowCs * cum / totalW);
            let b = lo + stepCs / 100;
            if (b > hi) b = hi;
            if (b < bounds[k]) b = bounds[k];
            bounds.push(b);
        }
        bounds[bounds.length - 1] = hi;

        if (!feasible) unplaced += runLen;
        runs++;
        for (let k = 0; k < runLen; k++) {
            const it = items[i + k];
            it.est = true;
            it.unplaced = !feasible;
            it.s = bounds[k];
            it.e = bounds[k + 1];
            repaired++;
        }
        i = j;
    }

    // Pass 3: emit. Healthy words are byte-identical to the input; repaired
    // words carry estimate flags + the original model stamps for diagnostics.
    return {
        words: items.map((it) => {
            if (!it.est) return { ...it.w };
            return {
                ...it.w,
                start: it.s,
                end: it.e,
                estimated: true,
                estimatedReason: it.reason,
                originalStart: toStamp(it.w.start),
                originalEnd: toStamp(it.w.end),
                ...(it.unplaced ? { unplaced: true } : {})
            };
        }),
        repaired,
        unplaced,
        runs,
    };
}

export function whisperToTranscript(result, audioDuration, sourceFile, language, options = {}) {
    _nextId = 0;

    const words = [];

    if (result.chunks && result.chunks.length > 0) {
        result.chunks.forEach((chunk) => {
            if (chunk.words && chunk.words.length > 0) {
                chunk.words.forEach(w => {
                    const ts = Array.isArray(w.timestamp) ? w.timestamp : [];
                    words.push({
                        id: makeId(),
                        text: w.word || w.text || '',
                        // Missing stamps stay null (0 is a legal timestamp).
                        start: toStamp(ts[0]),
                        end: toStamp(ts[1]),
                        deleted: false
                    });
                });
            } else if (chunk.text && chunk.timestamp) {
                // transformers.js with return_timestamps:'word' emits ONE
                // aligned word per chunk: chunks[].{ text, timestamp } with
                // no words array. Those stamps are real model alignments —
                // running them through splitSegmentToWords() would mark
                // EVERY word 'segment-split'/estimated (the "all chips red"
                // regression). Only a chunk holding several whitespace
                // tokens is genuinely a segment to pace words over.
                const tokens = String(chunk.text).trim().split(/\s+/).filter(Boolean);
                if (options.wordLevelTimestamps && tokens.length === 1) {
                    words.push({
                        id: makeId(),
                        text: tokens[0],
                        start: toStamp(chunk.timestamp[0]),
                        end: toStamp(chunk.timestamp[1]),
                        deleted: false
                    });
                } else {
                    words.push(...splitSegmentToWords(
                        chunk.text,
                        chunk.timestamp[0],
                        chunk.timestamp[1]
                    ));
                }
            }
        });
    } else if (result.text) {
        words.push(...splitSegmentToWords(result.text, 0, audioDuration));
    }

    // Repair invalid/collapsed word timings (e.g. whisper-large-v3-turbo
    // cross-attention entropy returns start === end for words sung over
    // music) instead of letting zero-duration cues reach grouping/export.
    // Repaired stamps are ESTIMATES bounded by healthy neighbours — never
    // present them as verified alignments.
    const sanitized = sanitizeWords(words, audioDuration);

    return {
        version: 1,
        sourceFile: sourceFile,
        language: language,
        words: sanitized.words,
        repairedTimestamps: sanitized.repaired,
        timing: {
            repaired: sanitized.repaired,
            estimated: sanitized.words.filter(w => w.estimated).length,
            unplaced: sanitized.unplaced,
            runs: sanitized.runs,
            hasEstimates: sanitized.words.some(w => w.estimated)
        }
    };
}
