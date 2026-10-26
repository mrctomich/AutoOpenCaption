/**
 * Phase 4 — pure apply/revert logic between alignCtcTranscript() results
 * and the app transcript word objects (app/assets/ctc-apply.js).
 * No DOM, no model: results are hand-built in the documented contract shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCtcResult, revertCtcResult, hasCtcMarks } from '../app/assets/ctc-apply.js';

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
