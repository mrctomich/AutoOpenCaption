/**
 * WhisperAdapter
 *
 * Converts Whisper pipeline output into the application's internal
 * transcript model. Handles multiple output schemas from different
 * Whisper ONNX exports:
 *
 *   Schema A (word-level):  chunks[].words[].{ word, timestamp }
 *   Schema B (segment-level): chunks[].{ text, timestamp }
 *   Schema C (no chunks):   { text } only
 *
 * Internal Transcript Model:
 *   { version, sourceFile, language, words: Word[] }
 *   Word = { id, text, start, end, deleted }
 */

let _nextId = 0;

const MIN_WORD_DURATION = 0.05;      // seconds — no word may be shorter than this
const FALLBACK_WORD_DURATION = 0.25; // avg estimate when no window bounds an invalid run

function makeId() {
    return `w${String(_nextId++).padStart(4, '0')}`;
}

function splitSegmentToWords(text, start, end) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const duration = end - start;
    const timePerWord = duration / words.length;

    return words.map((word, i) => ({
        id: makeId(),
        text: word,
        start: start + i * timePerWord,
        end: start + (i + 1) * timePerWord,
        deleted: false
    }));
}

/**
 * Repair degenerate word timestamps (null / zero / equal start+end /
 * backward jumps). A run of invalid words is re-timed by distributing the
 * interval between its nearest VALID neighbours proportionally to word
 * length — the word ORDER from the model stays trustworthy even when the
 * timestamps are not. Leading runs spread from 0; trailing runs up to
 * audioDuration (or at FALLBACK pace when the duration is unknown).
 *
 * @param {Array} words  Word[] with raw start/end
 * @param {number|null} audioDuration total audio length in seconds, if known
 * @returns {{ words: Array, repaired: number }} new array + repair count
 */
export function sanitizeWords(words, audioDuration = null) {
    if (!words.length) return { words, repaired: 0 };

    // Integer centiseconds throughout: rounding can then never collapse a
    // word to zero duration, and every emitted stamp is representable
    // exactly in SRT (millisecond) format.
    const cs = (t) => Math.round(t * 100);
    const sec = (c) => c / 100;
    const durCs = Number.isFinite(audioDuration) && audioDuration > 0 ? cs(audioDuration) : null;

    const items = words.map((w) => {
        const start = Number(w.start);
        const end = Number(w.end);
        const ok = Number.isFinite(start) && Number.isFinite(end) &&
            start >= 0 && end > start;
        return { ...w, ok, s: ok ? cs(start) : NaN, e: ok ? cs(end) : NaN };
    });

    // A word starting earlier than the last accepted word is misaligned too
    // (chunk stitching or collapsed frames can jump backward).
    let lastStart = -Infinity;
    for (const it of items) {
        if (it.ok && it.s < lastStart) it.ok = false;
        if (it.ok) lastStart = it.s;
    }

    let repaired = 0;
    let i = 0;
    while (i < items.length) {
        if (items[i].ok) { i++; continue; }
        let j = i;
        while (j < items.length && !items[j].ok) j++;

        const runLen = j - i;
        let lo = i > 0 ? items[i - 1].e : 0;
        // The collapsed stamp itself weakly indicates where the run was
        // spoken; trust it when it falls after the previous valid word.
        const anchor = Math.min(...items.slice(i, j)
            .map((it) => (Number.isFinite(Number(it.start)) ? cs(Number(it.start)) : Infinity)));
        if (Number.isFinite(anchor) && anchor > lo) lo = anchor;
        let cap = Infinity;
        if (durCs !== null) {
            cap = durCs;
            // A short trailing run should not expand across the whole
            // remaining audio — pace it at FALLBACK_WORD_DURATION/word
            // (capped to the audio end).
            if (j >= items.length) {
                cap = Math.min(durCs, lo + Math.ceil(runLen * FALLBACK_WORD_DURATION * 100));
            }
        }
        let hi = j < items.length
            ? items[j].s
            : (durCs !== null && durCs > lo
                ? Math.min(durCs, lo + Math.ceil(runLen * FALLBACK_WORD_DURATION * 100))
                : lo + runLen * FALLBACK_WORD_DURATION * 100);
        if (hi > cap) hi = cap;
        // Guarantee every word in the run at least 1 centisecond.
        if (hi < lo + runLen) hi = lo + runLen;

        // Spread the window across the run, weighted by word length.
        const weights = items.slice(i, j)
            .map((it) => Math.max(1, String(it.text || '').trim().length));
        const totalW = weights.reduce((a, b) => a + b, 0);
        let t = lo;
        for (let k = 0; k < runLen; k++) {
            const d = Math.max(1, Math.round(((hi - lo) * weights[k]) / totalW));
            items[i + k].s = t;
            items[i + k].e = t + d;
            t += d;
            repaired++;
        }
        i = j;
    }

    // Final pass: start times non-decreasing, positive duration on every
    // word, clamped to the audio. Good alignments are never moved earlier;
    // a word is only pushed when a repaired neighbour ran past its start.
    let prevEnd = 0;
    for (let k = 0; k < items.length; k++) {
        const it = items[k];
        if (it.s < prevEnd) it.s = prevEnd;
        if (durCs !== null && it.s > durCs - 1) it.s = durCs - 1;
        if (it.e <= it.s) it.e = it.s + MIN_WORD_DURATION * 100;
        const nextS = k + 1 < items.length ? items[k + 1].s : null;
        // Do not overrun the next word's start unless the next word itself
        // needs pushing (handled on its own iteration).
        if (nextS !== null && it.e > nextS && nextS > it.s) it.e = nextS;
        if (durCs !== null) it.e = Math.max(it.s + 1, Math.min(it.e, durCs));
        prevEnd = Math.max(prevEnd, it.s, it.e);
    }

    return {
        words: items.map(({ ok, s, e, ...w }) => ({ ...w, start: sec(s), end: sec(e) })),
        repaired,
    };
}

export function whisperToTranscript(result, audioDuration, sourceFile, language) {
    _nextId = 0;

    const words = [];

    if (result.chunks && result.chunks.length > 0) {
        result.chunks.forEach((chunk, ci) => {
            if (chunk.words && chunk.words.length > 0) {
                chunk.words.forEach(w => {
                    words.push({
                        id: makeId(),
                        text: w.word || w.text || '',
                        start: w.timestamp?.[0] ?? 0,
                        end: w.timestamp?.[1] ?? 0,
                        deleted: false
                    });
                });
            } else if (chunk.text && chunk.timestamp) {
                const chunkWords = splitSegmentToWords(
                    chunk.text,
                    chunk.timestamp[0],
                    chunk.timestamp[1]
                );
                words.push(...chunkWords);
            }
        });
    } else if (result.text) {
        const textWords = result.text.trim().split(/\s+/).filter(Boolean);
        const timePerWord = audioDuration / textWords.length;
        textWords.forEach((word, i) => {
            words.push({
                id: makeId(),
                text: word,
                start: Math.min(i * timePerWord, audioDuration),
                end: Math.min((i + 1) * timePerWord, audioDuration),
                deleted: false
            });
        });
    }

    const sanitized = sanitizeWords(words, audioDuration);

    return {
        version: 1,
        sourceFile: sourceFile,
        language: language,
        words: sanitized.words,
        repairedTimestamps: sanitized.repaired
    };
}
