// Phase 4b (ghost preview) — pure model tests for applyGestureDelta, the
// ghost's single source of truth. The property that matters end-to-end:
// ghost == commit. The App's commit funnel (Phase 4d) applies the SAME
// function with the SAME clamped delta, so if these hold, what the user
// drags is exactly what gets written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    applyGestureDelta, editBounds, editBoundsForGroup, clampDelta,
} from '../app/assets/timeline-model.js';

// Word factory: transcript-array shape, live unless stated.
const w = (id, start, end, extra = {}) => ({
    id, text: `w${id}`, start, end, deleted: false, ...extra,
});

// Words at 1..2, 2.2..3, 3.5..4 (indices 0,1,2).
const words = () => [w(1, 1, 2), w(2, 2.2, 3), w(3, 3.5, 4)];

// ── word gestures ─────────────────────────────────────────────────

test('word-move: translates start AND end by delta', () => {
    const out = applyGestureDelta(
        { kind: 'word-move', wordIndex: 1 }, words(), [1], 0.5);
    assert.deepEqual([...out.keys()], [1]);
    assert.deepEqual(out.get(1), { start: 2.7, end: 3.5 });
});

test('word-resize: only the grabbed edge moves', () => {
    const ws = words();
    const left = applyGestureDelta(
        { kind: 'word-resize', wordIndex: 1, edge: 'start' }, ws, [1], -0.1);
    assert.deepEqual(left.get(1), { start: 2.1, end: 3 });
    const right = applyGestureDelta(
        { kind: 'word-resize', wordIndex: 1, edge: 'end' }, ws, [1], 0.25);
    assert.deepEqual(right.get(1), { start: 2.2, end: 3.25 });
});

test('word gestures: out-of-range / missing word → empty Map', () => {
    const ws = words();
    assert.equal(applyGestureDelta(
        { kind: 'word-move', wordIndex: 99 }, ws, [99], 1).size, 0);
    assert.equal(applyGestureDelta(
        { kind: 'word-resize', wordIndex: -3, edge: 'start' }, ws, [-3], 1).size, 0);
});

// ── group gestures ────────────────────────────────────────────────

test('group-move: every valid index translates; invalid skipped', () => {
    const out = applyGestureDelta(
        { kind: 'group-move', groupIndex: 0 }, words(), [0, 1, -1, 99], -0.4);
    assert.deepEqual([...out.keys()].sort(), [0, 1]);
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    assert.ok(near(out.get(0).start, 0.6) && near(out.get(0).end, 1.6));
    assert.ok(near(out.get(1).start, 1.8) && near(out.get(1).end, 2.6));
});

test('group-resize: start edge moves ONLY first word; end edge ONLY last', () => {
    const ws = words();
    const left = applyGestureDelta(
        { kind: 'group-resize', groupIndex: 0, edge: 'start' }, ws, [0, 1, 2], -0.2);
    assert.deepEqual([...left.keys()], [0]);
    assert.deepEqual(left.get(0), { start: 0.8, end: 2 });

    const right = applyGestureDelta(
        { kind: 'group-resize', groupIndex: 0, edge: 'end' }, ws, [0, 1, 2], 0.3);
    assert.deepEqual([...right.keys()], [2]);
    assert.deepEqual(right.get(2), { start: 3.5, end: 4.3 });
});

test('group-resize picks first/last by TRANSCRIPT INDEX, not array order', () => {
    // wordIndexes given out of order (2 before 0) — edges must still be 0 / 2.
    const ws = words();
    const left = applyGestureDelta(
        { kind: 'group-resize', groupIndex: 0, edge: 'start' }, ws, [2, 0], -0.2);
    assert.deepEqual([...left.keys()], [0]);
    const right = applyGestureDelta(
        { kind: 'group-resize', groupIndex: 0, edge: 'end' }, ws, [2, 0], 0.3);
    assert.deepEqual([...right.keys()], [2]);
});

test('group gestures with no valid indices → empty Map', () => {
    const ws = words();
    assert.equal(applyGestureDelta(
        { kind: 'group-move', groupIndex: 0 }, ws, [], 1).size, 0);
    assert.equal(applyGestureDelta(
        { kind: 'group-resize', groupIndex: 0, edge: 'end' }, ws, [-1], 1).size, 0);
});

test('unknown gesture kind → empty Map', () => {
    assert.equal(applyGestureDelta({ kind: 'nope' }, words(), [0], 1).size, 0);
});

// ── purity (R1/R7: the ghost must not touch data) ─────────────────

test('purity: applyGestureDelta never mutates the words array', () => {
    const ws = words();
    const before = JSON.stringify(ws);
    applyGestureDelta({ kind: 'word-move', wordIndex: 0 }, ws, [0], 0.7);
    applyGestureDelta({ kind: 'group-move', groupIndex: 0 }, ws, [0, 1, 2], -0.3);
    applyGestureDelta({ kind: 'word-resize', wordIndex: 2, edge: 'end' }, ws, [2], 0.1);
    assert.equal(JSON.stringify(ws), before);
});

test('purity: zero delta returns stored times unchanged', () => {
    const ws = words();
    const out = applyGestureDelta({ kind: 'group-move', groupIndex: 0 }, ws, [0, 1, 2], 0);
    assert.deepEqual(out.get(0), { start: 1, end: 2 });
    assert.deepEqual(out.get(2), { start: 3.5, end: 4 });
});

// ── ghost == commit: proposal respects the SAME bounds ────────────

test('clamped proposal never crosses duration/zero/neighbour bounds (word)', () => {
    const ws = words();
    const dur = 12;
    for (const g of [
        { kind: 'word-move', wordIndex: 1 },
        { kind: 'word-resize', wordIndex: 1, edge: 'start' },
        { kind: 'word-resize', wordIndex: 1, edge: 'end' },
    ]) {
        const bounds = editBounds(g, ws, dur);
        for (const raw of [-99, -1.5, -0.05, 0, 0.3, 1.1, 99]) {
            const d = clampDelta(raw, bounds);
            const p = applyGestureDelta(g, ws, [g.wordIndex], d).get(1);
            assert.ok(p.start >= -1e-9 && p.start <= p.end + 1e-9,
                `${g.kind}/${g.edge || ''} raw=${raw}: start ${p.start}`);
            assert.ok(p.end <= dur + 1e-9, `end ${p.end} > dur`);
            assert.ok(p.start >= ws[0].end - 1e-9, 'crossed prev neighbour');
            assert.ok(p.end <= ws[2].start + 1e-9, 'crossed next neighbour');
        }
    }
});

test('clamped proposal never crosses bounds (group-move)', () => {
    const ws = words();
    const g = { kind: 'group-move', groupIndex: 0 };
    const bounds = editBoundsForGroup(g, ws, ws, [0, 1, 2], 12);
    for (const raw of [-50, -2, 0, 2, 50]) {
        const d = clampDelta(raw, bounds);
        const out = applyGestureDelta(g, ws, [0, 1, 2], d);
        assert.ok(out.get(0).start >= 0 - 1e-9);
        assert.ok(out.get(2).end <= 12 + 1e-9);
        // Gaps and durations preserved exactly under a translate.
        assert.ok(Math.abs((out.get(1).start - out.get(0).end) - 0.2) < 1e-9);
        assert.ok(Math.abs((out.get(0).end - out.get(0).start) - 1) < 1e-9);
    }
});

test('overlapping neighbours (invalid data): clampDelta pins to hi, ghost cannot worsen it', () => {
    // Word 1 (3..4) sits inside word 0 (0..5): prevEnd(5) > end(4) makes
    // resize-start bounds INVERTED (lo = 5-3 = 2 > hi = 4-3 = 1); clampDelta
    // must pin to hi, landing the start exactly on the word's end.
    const ws = [w(1, 0, 5), w(2, 3, 4)];
    const g = { kind: 'word-resize', wordIndex: 1, edge: 'start' };
    const bounds = editBounds(g, ws, 10);
    assert.ok(bounds.lo > bounds.hi, 'bounds must be inverted for this fixture');
    for (const raw of [-5, 0, 5]) {
        const d = clampDelta(raw, bounds);
        assert.equal(d, bounds.hi); // pinned
        const p = applyGestureDelta(g, ws, [1], d).get(1);
        // Proposal equals exactly what a commit with the same clamp produces
        // — the ghost shows the pinned result, never worse.
        assert.deepEqual(p, { start: 3 + d, end: 4 });
    }
});
