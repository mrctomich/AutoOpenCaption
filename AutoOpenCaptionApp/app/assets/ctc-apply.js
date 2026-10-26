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
 *  - applyCtcResult() returns a per-word snapshot (keyed by word id) that
 *    revertCtcResult() restores completely: start/end, the `estimated`
 *    red-flag, and the origStart/origEnd "adjusted" baseline.
 *  - Text is never touched. Words created after the realign (split/merge)
 *    are ignored by revert — they have no snapshot entry.
 */

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
 * @returns {{snapshot: Array, aligned: number, kept: number, changed: number}}
 * @throws if result.words does not line up 1:1 (length and id order) with words
 */
export function applyCtcResult(words, result) {
    if (!Array.isArray(words)) throw new TypeError('applyCtcResult: words must be an array');
    if (!result || !Array.isArray(result.words)) throw new TypeError('applyCtcResult: result.words must be an array');
    if (words.length !== result.words.length) {
        throw new Error(`applyCtcResult: result has ${result.words.length} words but the transcript has ${words.length}`);
    }

    const reasonById = new Map();
    for (const u of result.unalignable || []) reasonById.set(result.words[u.index]?.id ?? u.index, u.reason);

    const snapshot = [];
    let aligned = 0, kept = 0, changed = 0;

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

        if (r.alignment === 'ctc') {
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

    return { snapshot, aligned, kept, changed };
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
