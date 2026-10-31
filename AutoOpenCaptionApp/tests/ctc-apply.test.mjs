/**
 * Phase 4 — pure apply/revert logic between alignCtcTranscript() results
 * and the app transcript word objects (app/assets/ctc-apply.js).
 * No DOM, no model: results are hand-built in the documented contract shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCtcResult, revertCtcResult, hasCtcMarks, canCtcRealign, isUserAdjustedTiming, invalidTimingReason } from '../app/assets/ctc-apply.js';

function makeWords() {
    return [
        { id: 'w0', text: 'HELLO', start: 1.00, end: 1.40, estimated: true, origStart: 1.00, origEnd: 1.40 },
        { id: 'w1', text: 'WORLD', start: 1.50, end: 2.00, origStart: 1.50, origEnd: 2.00 },
        { id: 'w2', text: '123', start: 2.10, end: 2.30, origStart: 2.10, origEnd: 2.30 },
    ];
}

function makeResult() {
    return {
        words: [
            { id: 'w0', text: 'HELLO', start: 0.94, end: 1.31, alignment: 'ctc', originalStart: 1.00, originalEnd: 1.40 },
            { id: 'w1', text: 'WORLD', start: 1.50, end: 2.00, alignment: 'estimated', originalStart: 1.50, originalEnd: 2.00 },
            { id: 'w2', text: '123', start: 2.10, end: 2.30, alignment: 'estimated', originalStart: 2.10, originalEnd: 2.30 },
        ],
        stats: { total: 3, ctc: 1, estimated: 2, unalignable: 0, windows: 1, inferenceMs: 5 },
        unalignable: [
            { index: 1, text: 'WORLD', reason: 'low-confidence', chars: [] },
            { index: 2, text: '123', reason: 'unsupported-characters', chars: ['1', '2', '3'] },
        ],
    };
}

test('applyCtcResult: ctc words get new timing, marks and cleared estimated flag', () => {
    const words = makeWords();
    const out = applyCtcResult(words, makeResult());

    assert.equal(out.aligned, 1);
    assert.equal(out.kept, 2);
    assert.equal(out.changed, 1);

    const w0 = words[0];
    assert.equal(w0.start, 0.94);
    assert.equal(w0.end, 1.31);
    assert.equal(w0.estimated, false);
    assert.equal(w0.ctcAligned, true);
    assert.equal(w0.ctcReason, undefined);
    // "adjusted" baseline re-anchored so the chip does not read user-adjusted
    assert.equal(w0.origStart, 0.94);
    assert.equal(w0.origEnd, 1.31);
});

test('applyCtcResult: estimated/unalignable words keep their CURRENT app timing untouched', () => {
    const words = makeWords();
    // Simulate a user timestamp edit after transcription.
    words[1].start = 1.62;
    words[1].end = 2.11;
    applyCtcResult(words, makeResult());

    assert.equal(words[1].start, 1.62); // NOT overwritten by result value
    assert.equal(words[1].end, 2.11);
    assert.equal(words[1].ctcAligned, false);
    assert.equal(words[1].ctcReason, 'low-confidence');

    assert.equal(words[2].start, 2.10);
    assert.equal(words[2].ctcReason, 'unsupported-characters');
});

test('applyCtcResult: end is always > start (degenerate span guard)', () => {
    const words = [{ id: 'a', text: 'X', start: 0, end: 0 }];
    const result = {
        words: [{ id: 'a', text: 'X', start: 5, end: 5, alignment: 'ctc', originalStart: 0, originalEnd: 0 }],
        unalignable: [],
    };
    applyCtcResult(words, result);
    assert.ok(words[0].end > words[0].start);
});

test('applyCtcResult: rejects length and id-order mismatch (transcript edited mid-flight)', () => {
    assert.throws(() => applyCtcResult(makeWords(), { words: [], unalignable: [] }), /3 words but the transcript has 3|has 0 words/);
    const words = makeWords();
    const bad = makeResult();
    bad.words[1] = { ...bad.words[1], id: 'zzz' };
    assert.throws(() => applyCtcResult(words, bad), /order mismatch at word 1/);
});

test('revertCtcResult: full restore of timing, estimated flag and orig baseline', () => {
    const words = makeWords();
    const before = JSON.parse(JSON.stringify(words));
    const { snapshot } = applyCtcResult(words, makeResult());

    // user edits text after the realign — revert must not touch text or userAdjusted
    words[0].text = 'HALLO';
    words[0].userAdjusted = true;

    const n = revertCtcResult(words, snapshot);
    assert.equal(n, 3);
    assert.equal(words[0].start, before[0].start);
    assert.equal(words[0].end, before[0].end);
    assert.equal(words[0].estimated, true);       // red flag restored
    assert.equal(words[0].origStart, 1.00);
    assert.equal(words[0].origEnd, 1.40);
    assert.equal(words[0].ctcAligned, undefined);
    assert.equal(words[0].ctcReason, undefined);
    assert.equal(words[0].text, 'HALLO');         // text edit survives revert
    assert.equal(words[1].ctcReason, undefined);
});

test('revertCtcResult: words created after the realign (split) are left alone', () => {
    const words = makeWords();
    const { snapshot } = applyCtcResult(words, makeResult());
    // Split w1 into two NEW words with fresh ids, like the app's split does.
    words.splice(2, 0, { id: 'w1b', text: 'ORLD', start: 1.7, end: 2.0 });

    const n = revertCtcResult(words, snapshot);
    assert.equal(n, 3);
    assert.equal(words[2].id, 'w1b');
    assert.equal(words[2].start, 1.7); // untouched
});

test('revertCtcResult: absent estimated/orig fields are removed again, not set to undefined', () => {
    const words = [{ id: 'a', text: 'A', start: 1, end: 2 }]; // no estimated/orig*
    const { snapshot } = applyCtcResult(words, {
        words: [{ id: 'a', text: 'A', start: 1.2, end: 2.2, alignment: 'ctc' }],
        unalignable: [],
    });
    revertCtcResult(words, snapshot);
    assert.ok(!('estimated' in words[0]));
    assert.ok(!('origStart' in words[0]));
    assert.ok(!('origEnd' in words[0]));
});

test('applyCtcResult: words without ids match by index on apply AND revert', () => {
    const words = [
        { text: 'A', start: 0, end: 1 },
        { text: 'B', start: 1, end: 2 },
    ];
    const result = {
        words: [
            { id: 0, text: 'A', start: 0.1, end: 0.9, alignment: 'ctc' },
            { id: 1, text: 'B', start: 1, end: 2, alignment: 'estimated' },
        ],
        unalignable: [{ index: 1, text: 'B', reason: 'low-confidence', chars: [] }],
    };
    const { snapshot } = applyCtcResult(words, result);
    assert.equal(words[0].start, 0.1);
    assert.equal(words[1].ctcReason, 'low-confidence');
    const n = revertCtcResult(words, snapshot);
    assert.equal(n, 2);
    assert.equal(words[0].start, 0);
    assert.equal(words[1].ctcReason, undefined);
});

test('hasCtcMarks reflects live marks', () => {
    const words = makeWords();
    assert.equal(hasCtcMarks(words), false);
    applyCtcResult(words, makeResult());
    assert.equal(hasCtcMarks(words), true);
});

// ── Gap A: user-adjusted guard (approved Phase 1 decision) ──────────

test('guard: userAdjusted word with ctc evidence keeps EXACT user timing, text and flag', () => {
    const words = [
        { id: 'w0', text: 'HELLO', start: 1.00, end: 1.40, origStart: 1.00, origEnd: 1.40 },
        { id: 'w1', text: 'WORLD', start: 1.55, end: 1.99, origStart: 1.50, origEnd: 2.00, userAdjusted: true },
        { id: 'w2', text: 'AGAIN', start: 2.10, end: 2.30, origStart: 2.10, origEnd: 2.30 },
    ];
    const result = {
        words: [
            { id: 'w0', text: 'HELLO', start: 0.94, end: 1.31, alignment: 'ctc' },
            { id: 'w1', text: 'WORLD', start: 1.48, end: 2.05, alignment: 'ctc' },
            { id: 'w2', text: 'AGAIN', start: 2.08, end: 2.35, alignment: 'ctc' },
        ],
        unalignable: [],
    };
    const out = applyCtcResult(words, result);

    // Guarded word untouched: exact user values, flag and text preserved.
    assert.equal(words[1].start, 1.55);
    assert.equal(words[1].end, 1.99);
    assert.equal(words[1].text, 'WORLD');
    assert.equal(words[1].userAdjusted, true);
    assert.equal(words[1].ctcAligned, false);
    assert.equal(words[1].ctcReason, 'user-adjusted');
    // Counts: guarded word is kept, not aligned; neighbors still align.
    assert.equal(out.aligned, 2);
    assert.equal(out.kept, 1);
    assert.equal(out.skippedUserAdjusted, 1);
    assert.equal(out.flaggedInvalid, 0);
    assert.equal(words[0].start, 0.94);
    assert.equal(words[2].start, 2.08);
    assert.equal(words[2].ctcAligned, true);
});

test('guard: start/end moved away from orig baseline counts as user-adjusted (no flag set)', () => {
    const words = [{ id: 'w0', text: 'A', start: 3.00, end: 3.50, origStart: 1.00, origEnd: 1.40 }];
    const out = applyCtcResult(words, {
        words: [{ id: 'w0', text: 'A', start: 0.94, end: 1.31, alignment: 'ctc' }],
        unalignable: [],
    });
    assert.equal(words[0].start, 3.00);
    assert.equal(words[0].end, 3.50);
    assert.equal(out.skippedUserAdjusted, 1);
});

test('guard: text-only edit is NOT a timing adjustment — word still aligns', () => {
    const words = [{ id: 'w0', text: 'HELLO!', start: 1.00, end: 1.40, origText: 'HELLO', origStart: 1.00, origEnd: 1.40 }];
    const out = applyCtcResult(words, {
        words: [{ id: 'w0', text: 'HELLO!', start: 0.94, end: 1.31, alignment: 'ctc' }],
        unalignable: [],
    });
    assert.equal(words[0].start, 0.94);
    assert.equal(out.aligned, 1);
    assert.equal(out.skippedUserAdjusted, 0);
});

test('guard: skipUserAdjusted:false opts back into overwriting adjusted words', () => {
    const words = [{ id: 'w0', text: 'A', start: 3.00, end: 3.50, origStart: 1.00, origEnd: 1.40, userAdjusted: true }];
    const out = applyCtcResult(words, {
        words: [{ id: 'w0', text: 'A', start: 0.94, end: 1.31, alignment: 'ctc' }],
        unalignable: [],
    }, { skipUserAdjusted: false });
    assert.equal(words[0].start, 0.94);
    assert.equal(words[0].end, 1.31);
    assert.equal(out.aligned, 1);
    assert.equal(out.skippedUserAdjusted, 0);
});

test('guard: invalid existing user timing is KEPT and reported, never repaired', () => {
    const cases = [
        { w: { start: 2.0, end: 1.0 }, reason: 'user-timing-reversed' },       // end <= start
        { w: { start: NaN, end: 1.0 }, reason: 'user-timing-invalid' },        // non-finite
        { w: { start: -1.0, end: 1.0 }, reason: 'user-timing-negative' },      // negative
        { w: { start: 40.0, end: 41.0 }, reason: 'user-timing-out-of-range' }, // beyond 10 s audio
    ];
    for (const { w, reason } of cases) {
        const words = [{ id: 'w0', text: 'A', origStart: w.start, origEnd: w.end, userAdjusted: true, ...w }];
        const out = applyCtcResult(words, {
            words: [{ id: 'w0', text: 'A', start: 0.94, end: 1.31, alignment: 'ctc' }],
            unalignable: [],
        }, { duration: 10 });
        assert.equal(words[0].start, w.start, `start kept for ${reason}`);
        assert.equal(words[0].end, w.end, `end kept for ${reason}`);
        assert.equal(words[0].ctcReason, reason);
        assert.equal(out.flaggedInvalid, 1, `flagged for ${reason}`);
        assert.equal(out.skippedUserAdjusted, 1);
        assert.equal(out.aligned, 0);
    }
});

test('guard: revert restores a skipped/flagged adjusted word to its exact pre-realign state', () => {
    const words = [{ id: 'w0', text: 'A', start: 2.0, end: 1.0, origStart: 2.0, origEnd: 1.0, userAdjusted: true }];
    const { snapshot } = applyCtcResult(words, {
        words: [{ id: 'w0', text: 'A', start: 0.94, end: 1.31, alignment: 'ctc' }],
        unalignable: [],
    }, { duration: 10 });
    assert.equal(words[0].ctcReason, 'user-timing-reversed');
    revertCtcResult(words, snapshot);
    assert.equal(words[0].start, 2.0);
    assert.equal(words[0].end, 1.0);
    assert.equal(words[0].userAdjusted, true);
    assert.equal(words[0].ctcReason, undefined);
    assert.equal(words[0].ctcAligned, undefined);
});

// ── Gap B: English-only gate ─────────────────────────────────────────

test('canCtcRealign: true only for English transcript with words', () => {
    assert.equal(canCtcRealign({ language: 'en', words: [{ id: 'w0' }] }), true);
});

test('canCtcRealign: false for other languages, undefined, auto, no words, null', () => {
    const words = [{ id: 'w0' }];
    assert.equal(canCtcRealign({ language: 'es', words }), false);
    assert.equal(canCtcRealign({ language: undefined, words }), false);
    assert.equal(canCtcRealign({ language: 'auto', words }), false);
    assert.equal(canCtcRealign({ words }), false);
    assert.equal(canCtcRealign({ language: 'en', words: [] }), false);
    assert.equal(canCtcRealign({ language: 'en' }), false);
    assert.equal(canCtcRealign(null), false);
    assert.equal(canCtcRealign(undefined), false);
});

test('helpers: isUserAdjustedTiming / invalidTimingReason edge cases', () => {
    assert.equal(isUserAdjustedTiming(null), false);
    assert.equal(isUserAdjustedTiming({ start: 1, end: 2 }), false);
    assert.equal(isUserAdjustedTiming({ start: 1, end: 2, userAdjusted: true }), true);
    assert.equal(isUserAdjustedTiming({ start: 1, end: 2, origStart: 1, origEnd: 2 }), false);
    assert.equal(isUserAdjustedTiming({ start: 1, end: 2, origEnd: 2.5 }), true);
    assert.equal(invalidTimingReason({ start: 0, end: 1.5 }), null);
    assert.equal(invalidTimingReason({ start: 0, end: 0 }), 'user-timing-reversed'); // zero-length
    assert.equal(invalidTimingReason({ start: 0, end: 5 }, 10), null);
    assert.equal(invalidTimingReason({ start: 0, end: 10.1 }, 10), null); // 0.25 s tolerance
    assert.equal(invalidTimingReason({ start: 0, end: 12 }, 10), 'user-timing-out-of-range');
    assert.equal(invalidTimingReason({ start: 12, end: 13 }), null); // no duration ⇒ no range check
});

// ── MONOTONICITY GUARD (Phase 4 follow-up) ──────────────────────────
// Realign output mixes fresh CTC spans with kept Whisper estimates, so a
// CTC word can be stamped before the previous word ended. That created
// overlapping caption groups (second packed timeline lane + overlapping
// SRT cues). applyCtcResult now clamps CTC starts forward; untouchable
// words (kept/user timings) are only counted, never moved.

function seamWords() {
    return [
        { id: 'a', text: 'FIRST', start: 1.00, end: 3.00, origStart: 1.00, origEnd: 3.00 },
        { id: 'b', text: 'SECOND', start: 2.50, end: 3.20, origStart: 2.50, origEnd: 3.20 },
    ];
}

test('monotonicity: CTC word starting before previous word end is clamped to prevEnd', () => {
    const words = seamWords();
    const result = {
        words: [
            { id: 'a', text: 'FIRST', start: 1.00, end: 3.00, alignment: 'ctc' },
            { id: 'b', text: 'SECOND', start: 2.50, end: 3.20, alignment: 'ctc' },
        ],
        unalignable: [],
    };
    const out = applyCtcResult(words, result);
    assert.equal(out.monotonicClamped, 1);
    assert.equal(out.backwardConflicts, 0);
    assert.equal(words[1].start, 3.00);
    assert.equal(words[1].end, 3.20);
    // baseline re-anchored to the FINAL clamped timing, not the raw CTC span
    assert.equal(words[1].origStart, 3.00);
    assert.equal(words[1].origEnd, 3.20);
});

test('monotonicity: CTC span fully inside the previous word gets positive duration at prevEnd', () => {
    const words = seamWords();
    const result = {
        words: [
            { id: 'a', text: 'FIRST', start: 1.00, end: 3.00, alignment: 'ctc' },
            { id: 'b', text: 'SECOND', start: 2.10, end: 2.40, alignment: 'ctc' },
        ],
        unalignable: [],
    };
    const out = applyCtcResult(words, result);
    assert.equal(out.monotonicClamped, 1);
    assert.equal(words[1].start, 3.00);
    assert.ok(words[1].end > words[1].start);
});

test('monotonicity: kept estimate with a late end pushes the following CTC word forward', () => {
    const words = seamWords();
    const result = {
        words: [
            { id: 'a', text: 'FIRST', start: 1.00, end: 3.00, alignment: 'estimated' },
            { id: 'b', text: 'SECOND', start: 2.50, end: 3.20, alignment: 'ctc' },
        ],
        unalignable: [{ index: 0, text: 'FIRST', reason: 'low-confidence', chars: [] }],
    };
    const out = applyCtcResult(words, result);
    assert.equal(words[0].start, 1.00); // kept timing untouched
    assert.equal(words[1].start, 3.00); // CTC clamped to the kept word end
    assert.equal(out.monotonicClamped, 1);
    assert.equal(out.backwardConflicts, 0);
});

test('monotonicity: backward jump from an untouchable word is reported, never repaired', () => {
    const words = [
        { id: 'a', text: 'FIRST', start: 5.00, end: 6.00, userAdjusted: true, origStart: 5.00, origEnd: 6.00 },
        { id: 'b', text: 'SECOND', start: 2.00, end: 2.50, origStart: 2.00, origEnd: 2.50 },
        { id: 'c', text: 'THIRD', start: 7.00, end: 7.50, origStart: 7.00, origEnd: 7.50 },
    ];
    const result = {
        words: [
            { id: 'a', text: 'FIRST', start: 5.00, end: 6.00, alignment: 'ctc' },   // user-guarded
            { id: 'b', text: 'SECOND', start: 2.00, end: 2.50, alignment: 'estimated' }, // goes backwards
            { id: 'c', text: 'THIRD', start: 6.80, end: 7.50, alignment: 'ctc' },
        ],
        unalignable: [{ index: 1, text: 'SECOND', reason: 'low-confidence', chars: [] }],
    };
    const out = applyCtcResult(words, result, { skipUserAdjusted: true });
    assert.equal(words[0].start, 5.00);  // user-adjusted word untouched
    assert.equal(words[1].start, 2.00);  // kept estimate untouched
    assert.equal(out.backwardConflicts, 1); // the backward kept word is reported
    // the later CTC word is still pushed past the running max end (6.00)
    assert.equal(words[2].start, 6.80);  // already past 6.00, no clamp needed
    assert.equal(out.monotonicClamped, 0);
});

test('monotonicity: healthy chronological transcript passes through with zero guard counts', () => {
    const words = seamWords();
    const result = {
        words: [
            { id: 'a', text: 'FIRST', start: 1.00, end: 2.00, alignment: 'ctc' },
            { id: 'b', text: 'SECOND', start: 2.10, end: 3.20, alignment: 'ctc' },
        ],
        unalignable: [],
    };
    const out = applyCtcResult(words, result);
    assert.equal(out.monotonicClamped, 0);
    assert.equal(out.backwardConflicts, 0);
    assert.equal(words[0].start, 1.00);
    assert.equal(words[1].start, 2.10);
});

test('monotonicity: revert restores the exact pre-realign state when clamping occurred', () => {
    const words = seamWords();
    const before = JSON.parse(JSON.stringify(words));
    const result = {
        words: [
            { id: 'a', text: 'FIRST', start: 1.00, end: 3.00, alignment: 'ctc' },
            { id: 'b', text: 'SECOND', start: 2.50, end: 3.20, alignment: 'ctc' },
        ],
        unalignable: [],
    };
    const { snapshot } = applyCtcResult(words, result);
    assert.equal(words[1].start, 3.00); // clamped
    const n = revertCtcResult(words, snapshot);
    assert.equal(n, 2);
    for (let i = 0; i < words.length; i++) {
        assert.equal(words[i].start, before[i].start);
        assert.equal(words[i].end, before[i].end);
        assert.equal(words[i].origStart, before[i].origStart);
        assert.equal(words[i].origEnd, before[i].origEnd);
    }
});
