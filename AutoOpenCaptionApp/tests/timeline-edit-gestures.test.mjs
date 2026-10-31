// Phase 4a (direct timing edits: gesture resolution + clamping) — pure model tests.
// These cover the functions the view uses to drag a ghost and the App uses to
// commit: grabZone, resolveGesture, liveNeighborBounds, editBounds,
// editBoundsForGroup, clampDelta, wordBoxes (+ groupBoxes wordIndex add-on).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createViewport, groupBoxes, boxRect, MIN_BOX_PX,
    grabZone, resolveGesture, liveNeighborBounds,
    editBounds, editBoundsForGroup, clampDelta, wordBoxes,
    hitTestWordBox, WORD_SUB_PPS,
} from '../app/assets/timeline-model.js';

// Word factory: transcript-array shape, live unless stated.
const w = (id, start, end, extra = {}) => ({
    id, text: `w${id}`, start, end, deleted: false, ...extra,
});

// ── grabZone ──────────────────────────────────────────────────────

test('grabZone: wide box splits into left edge / body / right edge', () => {
    assert.equal(grabZone(0, 100), 'left');
    assert.equal(grabZone(4.999, 100), 'left');
    assert.equal(grabZone(5, 100), 'body');
    assert.equal(grabZone(50, 100), 'body');
    assert.equal(grabZone(95, 100), 'body');   // edge is exclusive: x > boxW − 5
    assert.equal(grabZone(95.1, 100), 'right');
    assert.equal(grabZone(99.9, 100), 'right');
});

test('grabZone: narrow box has no edges — whole box stays body (no dead zone)', () => {
    // A 4 px sliver (MIN_BOX_PX) must be fully grabbable as body/move.
    assert.equal(grabZone(0, MIN_BOX_PX), 'body');
    assert.equal(grabZone(2, MIN_BOX_PX), 'body');
    // Below the 2*edgePx+2 threshold the edges would overlap or starve the
    // body; everything is 'body' there.
    assert.equal(grabZone(0, 11), 'body');
    // Exactly at the threshold the edges appear.
    assert.equal(grabZone(0, 12), 'left');
    assert.equal(grabZone(11.5, 12), 'right');
});

test('grabZone: custom edgePx honoured', () => {
    assert.equal(grabZone(9, 100, 10), 'left');
    assert.equal(grabZone(10, 100, 10), 'body');
    assert.equal(grabZone(90, 100, 10), 'body');
    assert.equal(grabZone(90.1, 100, 10), 'right');
});

// ── resolveGesture ────────────────────────────────────────────────

test('resolveGesture: no word under cursor → group-level gestures', () => {
    assert.deepEqual(
        resolveGesture({ zone: 'body', groupIndex: 3 }),
        { kind: 'group-move', groupIndex: 3 });
    assert.deepEqual(
        resolveGesture({ zone: 'left', groupIndex: 3 }),
        { kind: 'group-resize', groupIndex: 3, edge: 'start' });
    assert.deepEqual(
        resolveGesture({ zone: 'right', groupIndex: 3 }),
        { kind: 'group-resize', groupIndex: 3, edge: 'end' });
});

test('resolveGesture: word under cursor → word-level gestures', () => {
    const at = { wordIndexInGroup: 1, wordIndex: 7 };
    assert.deepEqual(
        resolveGesture({ zone: 'body', ...at, groupIndex: 0 }),
        { kind: 'word-move', wordIndex: 7 });
    assert.deepEqual(
        resolveGesture({ zone: 'left', ...at, groupIndex: 0 }),
        { kind: 'word-resize', wordIndex: 7, edge: 'start' });
    assert.deepEqual(
        resolveGesture({ zone: 'right', ...at, groupIndex: 0 }),
        { kind: 'word-resize', wordIndex: 7, edge: 'end' });
});

test('resolveGesture: unresolvable transcript index falls back to group level', () => {
    // wordIndex -1 means the word object is not in the live array any more.
    assert.deepEqual(
        resolveGesture({ zone: 'right', wordIndexInGroup: 2, wordIndex: -1, groupIndex: 4 }),
        { kind: 'group-resize', groupIndex: 4, edge: 'end' });
});

test('WORD_SUB_PPS: word sub-boxes appear at ≥ 120 px/s (Q3 decision)', () => {
    assert.equal(WORD_SUB_PPS, 120);
});

// ── liveNeighborBounds ────────────────────────────────────────────

test('liveNeighborBounds: nearest live edges around a middle span', () => {
    const words = [w(1, 0, 1), w(2, 1, 2), w(3, 3, 4), w(4, 5, 6)];
    assert.deepEqual(liveNeighborBounds(words, 1, 2), { prevEnd: 1, nextStart: 5 });
    // Single-word span.
    assert.deepEqual(liveNeighborBounds(words, 2, 2), { prevEnd: 2, nextStart: 5 });
});

test('liveNeighborBounds: deleted neighbours are skipped', () => {
    const words = [
        w(1, 0, 1),
        w(2, 0.5, 0.9, { deleted: true }), // dead neighbour before the span
        w(3, 3, 4),
        w(4, 4.5, 4.9, { deleted: true }), // dead neighbour after the span
    ];
    assert.deepEqual(liveNeighborBounds(words, 2, 2), { prevEnd: 1, nextStart: Infinity });
});

test('liveNeighborBounds: first/last live word yields open bounds', () => {
    const words = [w(1, 0, 1, { deleted: true }), w(2, 1, 2), w(3, 3, 4)];
    assert.deepEqual(liveNeighborBounds(words, 1, 1), { prevEnd: -Infinity, nextStart: 3 });
    assert.deepEqual(liveNeighborBounds(words, 2, 2), { prevEnd: 2, nextStart: Infinity });
    assert.deepEqual(liveNeighborBounds(words, 0, 2), { prevEnd: -Infinity, nextStart: Infinity });
});

// ── editBounds: word level ────────────────────────────────────────

test('editBounds word-move: delta clamped by neighbours, both directions', () => {
    const words = [w(1, 0, 1), w(2, 2, 3), w(3, 5, 6)];
    const g = { kind: 'word-move', wordIndex: 1 };
    const { lo, hi } = editBounds(g, words, 10);
    // lo/hi are DRAG DELTAS (seconds), not absolute positions.
    assert.ok(Math.abs(lo - -1) < 1e-12);   // slide left until start = prevEnd (1)
    assert.ok(Math.abs(hi - 2) < 1e-12);    // slide right until end = nextStart (5)
    // Free move inside bounds passes through untouched.
    assert.ok(Math.abs(clampDelta(-0.25, { lo, hi }) - -0.25) < 1e-12);
    // Over-pull pins at the neighbour edge — no crossing (R: monotonic order).
    assert.ok(Math.abs(clampDelta(-5, { lo, hi }) - -1) < 1e-12);  // new start 1…
    assert.ok(Math.abs(clampDelta(9, { lo, hi }) - 2) < 1e-12);    // …new end 5
});

test('editBounds word-move: duration preserved for any committed delta (≤1 ULP)', () => {
    const words = [w(1, 0, 1), w(2, 2, 3), w(3, 5, 6)];
    const bounds = editBounds({ kind: 'word-move', wordIndex: 1 }, words, 10);
    for (const raw of [-100, -1.7, 0, 0.4, 42]) {
        const dt = clampDelta(raw, bounds);
        const word = words[1];
        const newStart = word.start + dt;
        const newEnd = word.end + dt;
        // Both edges translate by the SAME dt; the recomputed width may drift
        // by ≤1 ULP from IEEE rounding — invisible at ms SRT precision.
        assert.ok(Math.abs((newEnd - newStart) - (word.end - word.start)) < 1e-12);
    }
});

test('editBounds word-move: clamped to [0, duration] at the ends of the media', () => {
    const words = [w(1, 0.5, 1.5), w(2, 4, 5)]; // word 1 is first/last live
    const { lo, hi } = editBounds({ kind: 'word-move', wordIndex: 0 }, words, 6);
    assert.ok(Math.abs(lo - -0.5) < 1e-12); // start may reach 0, not below
    assert.ok(Math.abs(hi - 2.5) < 1e-12);   // end may reach nextStart (4) − end (1.5)
    assert.ok(clampDelta(-99, { lo, hi }) + 0.5 >= 0); // committed start ≥ 0
    assert.ok(clampDelta(99, { lo, hi }) + 1.5 <= 6);  // committed end ≤ dur
});

test('editBounds word-resize start: only start moves, bounded by prevEnd/0/end', () => {
    const words = [w(1, 0, 1), w(2, 2, 3), w(3, 5, 6)];
    const { lo, hi } = editBounds(
        { kind: 'word-resize', wordIndex: 1, edge: 'start' }, words, 10);
    assert.ok(Math.abs(lo - (1 - 2)) < 1e-12); // to prevEnd
    assert.ok(Math.abs(hi - (3 - 2)) < 1e-12); // collapse to end (start ≤ end)
    assert.ok(clampDelta(-99, { lo, hi }) + 2 >= 1); // never crosses prevEnd
    assert.ok(clampDelta(99, { lo, hi }) + 2 <= 3);  // never inverts
});

test('editBounds word-resize end: only end moves, bounded by start/nextStart/duration', () => {
    const words = [w(1, 0, 1), w(2, 2, 3), w(3, 5, 6)];
    const { lo, hi } = editBounds(
        { kind: 'word-resize', wordIndex: 1, edge: 'end' }, words, 10);
    assert.ok(Math.abs(lo - (2 - 3)) < 1e-12);   // collapse to start
    assert.ok(Math.abs(hi - (5 - 3)) < 1e-12);   // to nextStart
    assert.ok(clampDelta(-99, { lo, hi }) + 3 >= 2); // never inverts
    assert.ok(clampDelta(99, { lo, hi }) + 3 <= 5);  // never crosses nextStart

    // Duration cap bites when the word is last and media is shorter than ∞.
    const last = [w(1, 0, 1), w(2, 2, 3)];
    const b2 = editBounds({ kind: 'word-resize', wordIndex: 1, edge: 'end' }, last, 4);
    assert.ok(Math.abs(b2.hi - (4 - 3)) < 1e-12);
    assert.ok(clampDelta(99, b2) + 3 <= 4);
});

test('editBounds word-resize start: 0 floor beats a negative prevEnd ghost', () => {
    // Corrupt data: previous word ends before 0. Committed start must stay ≥ 0.
    const words = [w(1, -2, -1), w(2, 2, 3)];
    const { lo } = editBounds(
        { kind: 'word-resize', wordIndex: 1, edge: 'start' }, words, 10);
    assert.ok(Math.abs(lo - (0 - 2)) < 1e-12);
    assert.ok(clampDelta(-99, { lo, hi: 0 }) + 2 >= 0);
});

test('editBounds: unknown word index yields a frozen gesture', () => {
    const words = [w(1, 0, 1)];
    assert.deepEqual(editBounds({ kind: 'word-move', wordIndex: 5 }, words, 10), { lo: 0, hi: 0 });
    assert.deepEqual(editBounds({ kind: 'word-resize', wordIndex: -1, edge: 'start' }, words, 10), { lo: 0, hi: 0 });
});

// ── editBoundsForGroup ────────────────────────────────────────────

test('editBoundsForGroup group-move: tightest word in the group wins', () => {
    // Group = words 1..2 (indices 1,2) sitting 0.5 s after prev and 1 s before next.
    const words = [w(1, 0, 1), w(2, 1.5, 2), w(3, 2, 3), w(4, 4, 5)];
    const groupWords = [words[1], words[2]];
    const g = { kind: 'group-move', groupIndex: 0 };
    const { lo, hi } = editBoundsForGroup(g, words, groupWords, [1, 2], 10);
    assert.ok(Math.abs(lo - -0.5) < 1e-12); // drag left: first word hits prevEnd (delta 1 − 1.5)
    assert.ok(Math.abs(hi - 1) < 1e-12);    // drag right: last word hits nextStart (delta 4 − 3)
    // Committing the clamped delta keeps EVERY word inside the neighbour gap.
    const dt = clampDelta(-50, { lo, hi });
    assert.ok(words[1].start + dt >= 1 - 1e-12);
    assert.ok(words[2].end + dt <= 4 + 1e-12);
});

test('editBoundsForGroup group-move: every word keeps its own duration and gaps', () => {
    const words = [w(1, 0, 1), w(2, 1.2, 2.5), w(3, 2.5, 3), w(4, 6, 7)];
    const groupWords = [words[1], words[2]];
    const bounds = editBoundsForGroup({ kind: 'group-move', groupIndex: 0 }, words, groupWords, [1, 2], 10);
    const dt = clampDelta(0.37, bounds);
    const moved = groupWords.map(x => [x.start + dt, x.end + dt]);
    // ≤1 ULP: same dt on both edges; IEEE re-rounding of the width is expected.
    assert.ok(Math.abs((moved[0][1] - moved[0][0]) - (words[1].end - words[1].start)) < 1e-12);
    assert.ok(Math.abs((moved[1][1] - moved[1][0]) - (words[2].end - words[2].start)) < 1e-12);
    assert.ok(Math.abs((moved[1][0] - moved[0][1]) - (words[2].start - words[1].end)) < 1e-12); // gap preserved
});

test('editBoundsForGroup group-resize start: first word only, bounded by prevEnd/end', () => {
    const words = [w(1, 0, 1), w(2, 2, 2.5), w(3, 2.5, 3), w(4, 4, 5)];
    const groupWords = [words[1], words[2]];
    const { lo, hi } = editBoundsForGroup(
        { kind: 'group-resize', groupIndex: 0, edge: 'start' }, words, groupWords, [1, 2], 10);
    assert.ok(Math.abs(lo - (1 - 2)) < 1e-12); // grow to prevEnd
    assert.ok(Math.abs(hi - (2.5 - 2)) < 1e-12); // collapse first word to its end
    const dt = clampDelta(-50, { lo, hi });
    assert.ok(words[1].start + dt >= 1 - 1e-12);
    assert.ok(words[1].start + dt <= words[1].end + 1e-12);
});

test('editBoundsForGroup group-resize end: last word only, bounded by nextStart/duration', () => {
    const words = [w(1, 0, 1), w(2, 2, 2.5), w(3, 2.5, 3), w(4, 4, 5)];
    const groupWords = [words[1], words[2]];
    const { lo, hi } = editBoundsForGroup(
        { kind: 'group-resize', groupIndex: 0, edge: 'end' }, words, groupWords, [1, 2], 10);
    assert.ok(Math.abs(lo - (2.5 - 3)) < 1e-12);   // collapse last word to its start
    assert.ok(Math.abs(hi - (4 - 3)) < 1e-12);     // grow to nextStart
    const dt = clampDelta(50, { lo, hi });
    assert.ok(words[2].end + dt <= 4 + 1e-12);
    assert.ok(words[2].end + dt >= words[2].start - 1e-12);
});

test('editBoundsForGroup: group pinned to media edges moves within [0, duration]', () => {
    const words = [w(1, 0, 1), w(2, 1, 2)]; // group is first + last live word
    const { lo, hi } = editBoundsForGroup(
        { kind: 'group-move', groupIndex: 0 }, words, words, [0, 1], 3);
    assert.ok(Math.abs(lo - 0) < 1e-12);    // already at 0 — cannot go left
    assert.ok(Math.abs(hi - 1) < 1e-12);    // group end (2) may reach dur (3)
});

test('editBoundsForGroup: empty group / no resolvable indices yields frozen gesture', () => {
    const words = [w(1, 0, 1)];
    assert.deepEqual(
        editBoundsForGroup({ kind: 'group-move', groupIndex: 0 }, words, [], [], 10),
        { lo: 0, hi: 0 });
    assert.deepEqual(
        editBoundsForGroup({ kind: 'group-move', groupIndex: 0 }, words, [words[0]], [-1], 10),
        { lo: 0, hi: 0 });
});

// ── clampDelta ────────────────────────────────────────────────────

test('clampDelta: pass-through, edge pinning, inverted bounds pin to hi', () => {
    assert.equal(clampDelta(0.5, { lo: -1, hi: 1 }), 0.5);
    assert.equal(clampDelta(-4, { lo: -1, hi: 1 }), -1);
    assert.equal(clampDelta(4, { lo: -1, hi: 1 }), 1);
    // lo > hi means the stored data already violates the rules: pin to hi.
    assert.equal(clampDelta(123, { lo: 2, hi: -2 }), -2);
    assert.equal(clampDelta(-123, { lo: 2, hi: -2 }), -2);
});

// ── wordBoxes + groupBoxes.wordIndex ──────────────────────────────

test('wordBoxes: display sub-boxes parallel to the group words, data untouched', () => {
    const vp = createViewport({ durationSec: 10, viewWidthPx: 1000, pps: 100 });
    const words = [w(1, 2, 2.5), w(2, 2.5, 3), w(3, 3, 3)];
    const before = structuredClone(words);
    const boxes = wordBoxes(vp, words);
    assert.equal(boxes.length, 3);
    assert.equal(boxes[0].i, 0);
    assert.equal(boxes[0].word, words[0]);
    assert.ok(Math.abs(boxes[0].x - (2 - vp.viewStartSec) * 100) < 1e-9);
    assert.ok(Math.abs(boxes[0].w - 50) < 1e-9);
    assert.equal(boxes[2].degenerate, true); // zero-length word stays visible
    assert.equal(boxes[2].w, MIN_BOX_PX);
    assert.deepEqual(words, before);
    assert.deepEqual(wordBoxes(vp, []), []);
    assert.deepEqual(wordBoxes(vp, null), []);
});

test('groupBoxes: wordIndex maps each group word to its CURRENT transcript slot', () => {
    const vp = createViewport({ durationSec: 10, viewWidthPx: 1000, pps: 100 });
    const words = [w(1, 0, 1), w(2, 2, 2.5), w(3, 2.5, 3), w(4, 5, 6)];
    const groups = [
        { start: 2, end: 3, text: 'a b', words: [words[1], words[2]] },
        { start: 5, end: 6, text: 'c', words: [words[3]] },
    ];
    const boxes = groupBoxes(vp, groups, words);
    assert.deepEqual(boxes[0].wordIndex, [1, 2]);
    assert.deepEqual(boxes[1].wordIndex, [3]);
    // Without allWords the field stays undefined (Phase 3 callers unaffected).
    assert.equal(groupBoxes(vp, groups)[0].wordIndex, undefined);
});

// ── End-to-end gesture arithmetic (ghost == commit, P4 acceptance) ─

test('gesture flow: high-zoom word drag resolves, clamps, and lands inside bounds', () => {
    // 120 px/s is the word sub-box threshold; at 200 the sub-boxes are live.
    const vp = createViewport({ durationSec: 12, viewWidthPx: 1000, pps: 200 });
    const words = [w(1, 1, 1.5), w(2, 1.5, 2.2), w(3, 2.2, 3)];
    const group = { start: 1, end: 3, text: 'one two three', words };
    const [box] = groupBoxes(vp, [group], words);
    // Press on the right edge of the sub-box for word 2 (index 1).
    const sub = wordBoxes(vp, words)[1];
    const zone = grabZone(sub.w - 1, sub.w);          // 'right'
    const gesture = resolveGesture({
        zone, wordIndexInGroup: 1, wordIndex: box.wordIndex[1], groupIndex: 0,
    });
    assert.deepEqual(gesture, { kind: 'word-resize', wordIndex: 1, edge: 'end' });
    // Drag +2 s (way past the next word): ghost delta clamps to the neighbour.
    const bounds = editBounds(gesture, words, vp.durationSec);
    const dt = clampDelta(2, bounds);
    assert.ok(Math.abs(dt - (2.2 - 2.2)) < 1e-12); // hi = nextStart(2.2) − end(2.2)
    // Applying it (the commit) equals the ghost exactly and orders survive.
    words[1].end += dt;
    assert.ok(words[1].end <= words[2].start + 1e-12);
    assert.equal(words[1].start, 1.5); // other edge untouched
});

// ── hitTestWordBox (Phase 4c pointer FSM word grab) ───────────────

test('hitTestWordBox: back-to-back words resolve to the word under x', () => {
    const vp = createViewport({ durationSec: 12, viewWidthPx: 1000, pps: 200 });
    const words = [w(1, 1, 1.5), w(2, 1.5, 2.2), w(3, 2.2, 3)];
    // viewStart = 0 → x = t*200: word 1 spans 200..300.
    assert.equal(hitTestWordBox(vp, words, 250), 0);
    assert.equal(hitTestWordBox(vp, words, 350), 1);   // word 2: 300..440
    assert.equal(hitTestWordBox(vp, words, 500), 2);   // word 3: 440..600
});

test('hitTestWordBox: shared boundary hits the FIRST word (deterministic)', () => {
    const vp = createViewport({ durationSec: 12, viewWidthPx: 1000, pps: 200 });
    const words = [w(1, 1, 1.5), w(2, 1.5, 2.2)];
    assert.equal(hitTestWordBox(vp, words, 300), 0);   // word 1 right edge
});

test('hitTestWordBox: gaps and outside spans return -1', () => {
    const vp = createViewport({ durationSec: 12, viewWidthPx: 1000, pps: 200 });
    const words = [w(1, 1, 1.5), w(2, 2.5, 3)];
    // Gap 1.5..2.5 → x 300..500; middle of the gap misses both words.
    assert.equal(hitTestWordBox(vp, words, 400), -1);
    assert.equal(hitTestWordBox(vp, words, 100), -1);  // before first word
    assert.equal(hitTestWordBox(vp, words, 900), -1);  // after last word
});

test('hitTestWordBox: zero-length word keeps a MIN_BOX_PX grab target', () => {
    const vp = createViewport({ durationSec: 12, viewWidthPx: 1000, pps: 200 });
    const words = [w(1, 1, 1), w(2, 2, 3)];
    // Degenerate word at t=1 → sliver of MIN_BOX_PX centered on x=200.
    assert.equal(hitTestWordBox(vp, words, 200), 0);
    assert.equal(hitTestWordBox(vp, words, 200 + MIN_BOX_PX / 2 - 0.5), 0);
});

test('hitTestWordBox: empty input returns -1', () => {
    const vp = createViewport({ durationSec: 12, viewWidthPx: 1000, pps: 200 });
    assert.equal(hitTestWordBox(vp, [], 50), -1);
    assert.equal(hitTestWordBox(vp, null, 50), -1);
});

test('FSM word grab maps hit word → transcript index via groupBoxes.wordIndex', () => {
    // Mirrors timeline-view.startGhostDrag: box hit → word hit → resolveGesture.
    const vp = createViewport({ durationSec: 12, viewWidthPx: 1000, pps: 200 });
    const words = [w(7, 0, 0.4), w(8, 1, 1.5), w(9, 1.5, 2.2), w(10, 2.2, 3)];
    const group = { start: 1, end: 3, text: 'two three four', words: words.slice(1) };
    const [box] = groupBoxes(vp, [group], words);
    const downX = 350;                       // inside word 9 (x 300..440)
    const i = hitTestWordBox(vp, group.words, downX);
    assert.equal(i, 1);
    const wordIndex = box.wordIndex[i];
    assert.equal(wordIndex, 2);              // transcript position of word 9
    const gesture = resolveGesture({
        zone: grabZone(downX - box.x, box.w),
        wordIndexInGroup: i, wordIndex, groupIndex: box.index,
    });
    assert.deepEqual(gesture, { kind: 'word-move', wordIndex: 2 });
});
