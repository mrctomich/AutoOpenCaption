/**
 * ctc-apply.js — Phase 4 glue between the CTC aligner result contract
 * (see ctc-aligner.js, alignCtcTranscript @returns) and the app's live
 * transcript word objects. Pure functions, no DOM, unit-tested in
 * tests/ctc-apply.test.mjs.
 *
 * Non-destructive rules (Phase 4 requirements):
 *  - Only words the aligner classed "ctc" get new timestamps. "estimated"
 *    and "unalignable" words keep their current app values EXACTLY —
 *    including any timestamp the user edited after transcription.
 *  - USER-ADJUSTED GUARD (approved Phase 1 decision, Gap A): a word the
 *    user manually adjusted (userAdjusted flag, or start/end moved away
 *    from the origStart/origEnd baseline — same rule the editor uses for
 *    its green "adjusted" outline) is never overwritten by CTC timing,
 *    even when the aligner found evidence for it. Its existing timing,
 *    text and flag survive. Pass { skipUserAdjusted: false } to opt out.
 *    If such a word's existing timing is INVALID (non-finite, negative,
 *    reversed, or outside the audio duration) it is still kept — we never
 *    fabricate a replacement — but it is counted in `flaggedInvalid` and
 *    marked with a `user-timing-*` ctcReason so the UI can report it.
 *  - English-only gate (Gap B): canCtcRealign() is the single source of
 *    truth for whether the Realign UI may run (wav2vec2-base-960h is an
 *    English model; anything other than language === 'en' is unsupported).
 *  - applyCtcResult() returns a per-word snapshot (keyed by word id) that
 *    revertCtcResult() restores completely: start/end, the `estimated`
 *    red-flag, and the origStart/origEnd "adjusted" baseline.
 *  - Text is never touched. Words created after the realign (split/merge)
 *    are ignored by revert — they have no snapshot entry.
 */

/**
 * True only for an English transcript with words to align. The aligner
 * model (Xenova/wav2vec2-base-960h) is English-only, so anything that is
 * not exactly language === 'en' — including undefined or 'auto' — must
 * not enter the alignment path (approved Phase 1 decision, Gap B).
 */
export function canCtcRealign(transcript) {
    return !!(transcript
        && transcript.language === 'en'
        && Array.isArray(transcript.words)
        && transcript.words.length > 0);
}

/**
 * The pure mirror of the editor's isWordAdjusted() rule, restricted to
 * timing: a word counts as user-adjusted if it carries the userAdjusted
 * flag (set by split/merge) or its current start/end differ from the
 * origStart/origEnd baseline captured at transcription (set by inspector
 * edits and nudges). Text-only edits are NOT a timing adjustment — the
 * aligner aligns against the current text, so those words still benefit.
 */
export function isUserAdjustedTiming(word) {
    if (!word) return false;
    if (word.userAdjusted) return true;
    if (word.origStart !== undefined && word.start !== word.origStart) return true;
    if (word.origEnd !== undefined && word.end !== word.origEnd) return true;
    return false;
}

/**
 * Why an existing timing is unusable, or null when it is fine. Used to
 * REPORT invalid user timings instead of silently replacing them.
 * `duration` (seconds of decoded audio) enables the out-of-range check.
 */
export function invalidTimingReason(word, duration) {
    const { start, end } = word;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'user-timing-invalid';
    if (start < 0 || end < 0) return 'user-timing-negative';
    if (end <= start) return 'user-timing-reversed';
    if (Number.isFinite(duration) && duration > 0 && (start >= duration || end > duration + 0.25)) {
        return 'user-timing-out-of-range';
    }
    return null;
}

/**
 * Apply an alignCtcTranscript() result onto the app transcript words.
 *
 * Marks set on ctc words:   ctcAligned = true, ctcReason deleted,
 *                           estimated cleared (timing is now evidence-based),
 *                           origStart/origEnd re-anchored to the new timing
 *                           so machine-aligned chips don't read as
 *                           "user adjusted" (userAdjusted keeps its own
 *                           green marker through the flag).
 * Marks set on kept words:  ctcAligned = false, ctcReason = why the aligner
 *                           skipped it (from result.unalignable).
 *
 * @param {Array<{id:*, text:string, start:number, end:number}>} words  live transcript words (mutated)
 * @param {{words: Array, unalignable: Array}} result  alignCtcTranscript() result
 * @param {{skipUserAdjusted?: boolean, duration?: number}} [options]
 *        skipUserAdjusted (default true): never overwrite a word the user
 *        manually adjusted (see isUserAdjustedTiming). duration: seconds of
 *        decoded audio, enables the out-of-range validity check.
 * @returns {{snapshot: Array, aligned: number, kept: number, changed: number,
 *            skippedUserAdjusted: number, flaggedInvalid: number}}
 * @throws if result.words does not line up 1:1 (length and id order) with words
 */
export function applyCtcResult(words, result, options = {}) {
    if (!Array.isArray(words)) throw new TypeError('applyCtcResult: words must be an array');
    if (!result || !Array.isArray(result.words)) throw new TypeError('applyCtcResult: result.words must be an array');
    if (words.length !== result.words.length) {
        throw new Error(`applyCtcResult: result has ${result.words.length} words but the transcript has ${words.length}`);
    }
    const skipUserAdjusted = options.skipUserAdjusted !== false;
    const duration = options.duration;

    const reasonById = new Map();
    for (const u of result.unalignable || []) reasonById.set(result.words[u.index]?.id ?? u.index, u.reason);

    const snapshot = [];
    let aligned = 0, kept = 0, changed = 0, skippedUserAdjusted = 0, flaggedInvalid = 0;

    words.forEach((w, i) => {
        const r = result.words[i];
        const id = w.id ?? i;
        if (r.id !== id) {
            throw new Error(`applyCtcResult: order mismatch at word ${i} (result id ${r.id}, transcript id ${id})`);
        }
        snapshot.push({
            id,
            start: w.start,
            end: w.end,
            estimated: w.estimated,
            origStart: w.origStart,
            origEnd: w.origEnd,
        });

        if (r.alignment === 'ctc' && skipUserAdjusted && isUserAdjustedTiming(w)) {
            // Gap A guard: user edits win. Timing, text and flags stay
            // EXACTLY as they are. Invalid existing timing is reported
            // (counted + ctcReason), never silently repaired.
            w.ctcAligned = false;
            const invalid = invalidTimingReason(w, duration);
            w.ctcReason = invalid || 'user-adjusted';
            if (invalid) flaggedInvalid++;
            kept++;
            skippedUserAdjusted++;
        } else if (r.alignment === 'ctc') {
            if (w.start !== r.start || w.end !== r.end) changed++;
            w.start = r.start;
            w.end = Math.max(r.end, r.start + 1e-6);
            w.estimated = false;          // timing now has audio evidence
            w.ctcAligned = true;
            delete w.ctcReason;
            w.origStart = w.start;        // don't show machine timing as user-adjusted
            w.origEnd = w.end;
            aligned++;
        } else {
            // "estimated"/"unalignable": keep the current app timing untouched,
            // record why the aligner had no evidence for this word.
            w.ctcAligned = false;
            w.ctcReason = reasonById.get(id) || 'no-ctc-evidence';
            kept++;
        }
    });

    return { snapshot, aligned, kept, changed, skippedUserAdjusted, flaggedInvalid };
}

/**
 * Restore the pre-realign state taken by applyCtcResult(). Matched by word
 * id, so words split/merged after the realign are left alone. Clears the
 * ctcAligned/ctcReason marks on every word it restores.
 *
 * @returns {number} how many words were restored
 */
export function revertCtcResult(words, snapshot) {
    if (!Array.isArray(words)) throw new TypeError('revertCtcResult: words must be an array');
    if (!Array.isArray(snapshot)) throw new TypeError('revertCtcResult: snapshot must be an array');
    const byId = new Map(snapshot.map((s) => [s.id, s]));
    let restored = 0;
    words.forEach((w, i) => {
        const s = byId.get(w.id ?? i);
        if (!s) return;
        w.start = s.start;
        w.end = s.end;
        if (s.estimated === undefined) delete w.estimated; else w.estimated = s.estimated;
        if (s.origStart === undefined) delete w.origStart; else w.origStart = s.origStart;
        if (s.origEnd === undefined) delete w.origEnd; else w.origEnd = s.origEnd;
        delete w.ctcAligned;
        delete w.ctcReason;
        restored++;
    });
    return restored;
}

/** True if any word carries a live realign mark (drives the Revert button). */
export function hasCtcMarks(words) {
    return Array.isArray(words) && words.some((w) => w.ctcAligned || w.ctcReason);
}
