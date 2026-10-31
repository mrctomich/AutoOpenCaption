// Phase 3 (caption lanes, hit-testing, zoom-to-selection) — pure model tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createViewport, groupBoxes, packLanes, hitTestBoxes, frameSpan,
    timeToX, xToTime, boxRect, MIN_BOX_PX, MAX_PPS,
} from '../app/assets/timeline-model.js';

const g = (i, start, end, text = `cue ${i}`, wordId = `w${i}`) => ({
    start, end, text, words: [{ id: wordId, text: 'x', start, end }],
});

// ── groupBoxes ────────────────────────────────────────────────────

test('groupBoxes: box x/w match the group boundaries exactly', () => {
    // duration 100 s @ 1000 px ⇒ min pps = 10, so pps 10 survives the fit clamp.
    const vp = createViewport({ durationSec: 100, viewWidthPx: 1000, pps: 10 });
    const groups = [g(1, 2, 4), g(2, 7.5, 9.25)];
    const boxes = groupBoxes(vp, groups);
    assert.equal(boxes.length, 2);
    assert.equal(boxes[0].x, timeToX(vp, 2));
    assert.equal(boxes[0].w, 20);
    assert.equal(boxes[1].x, timeToX(vp, 7.5));
    assert.ok(Math.abs(boxes[1].w - 17.5) < 1e-9);
    // Index and first word survive for click → selection mapping.
    assert.equal(boxes[1].index, 1);
    assert.equal(boxes[1].word.id, 'w2');
});

test('groupBoxes: input is never mutated and data is never read back from pixels', () => {
    const vp = createViewport({ durationSec: 60, viewWidthPx: 1000, pps: 10 });
    const groups = [g(1, 2, 4), g(2, 2, 2)]; // second is zero-duration
    const before = structuredClone(groups);
    groupBoxes(vp, groups);
    assert.deepEqual(groups, before);
});

test('groupBoxes: zero/near-zero spans get MIN_BOX_PX visual width, data untouched', () => {
    const vp = createViewport({ durationSec: 60, viewWidthPx: 1000, pps: 10 });
    const groups = [g(1, 5, 5)];
    const boxes = groupBoxes(vp, groups);
    assert.equal(boxes[0].w, MIN_BOX_PX);
    assert.equal(boxes[0].degenerate, true);
    assert.equal(groups[0].start, 5);
    assert.equal(groups[0].end, 5);
    // Centered on the true timestamp.
    const center = boxes[0].x + boxes[0].w / 2;
    assert.ok(Math.abs(center - timeToX(vp, 5)) < 1e-9);
});

test('groupBoxes: empty / missing input', () => {
    const vp = createViewport({ durationSec: 60, viewWidthPx: 1000 });
    assert.deepEqual(groupBoxes(vp, []), []);
    assert.deepEqual(groupBoxes(vp, null), []);
});

test('groupBoxes: box without words yields null word (click is a no-op)', () => {
    const vp = createViewport({ durationSec: 10, viewWidthPx: 500, pps: 10 });
    const boxes = groupBoxes(vp, [{ start: 1, end: 2, text: '', words: [] }]);
    assert.equal(boxes[0].word, null);
});

// ── packLanes ─────────────────────────────────────────────────────

test('packLanes: non-overlapping cues share one lane', () => {
    const boxes = [
        { x: 0, w: 50 }, { x: 60, w: 50 }, { x: 120, w: 40 },
    ];
    const { laneOf, laneCount } = packLanes(boxes);
    assert.deepEqual(laneOf, [0, 0, 0]);
    assert.equal(laneCount, 1);
});

test('packLanes: overlapping cues stack into new lanes', () => {
    // cue2 overlaps cue1; cue3 fits lane 0 after cue1, cue4 needs lane 2.
    const boxes = [
        { x: 0, w: 100 },   // lane 0
        { x: 50, w: 100 },  // lane 1 (overlaps lane 0's box)
        { x: 110, w: 30 },  // lane 0 (after box1 ends at 100)
        { x: 130, w: 30 },  // lane 1? no: lane1 ends 150 → lane 2
    ];
    const { laneOf, laneCount } = packLanes(boxes);
    assert.deepEqual(laneOf, [0, 1, 0, 2]);
    assert.equal(laneCount, 3);
});

test('packLanes: back-to-back cues with 1px float wobble stay on one lane', () => {
    const boxes = [{ x: 0, w: 100 }, { x: 99.4, w: 60 }]; // x < prev end, within slack
    const { laneOf, laneCount } = packLanes(boxes);
    assert.deepEqual(laneOf, [0, 0]);
    assert.equal(laneCount, 1);
});

test('packLanes: empty input yields one empty lane', () => {
    const { laneOf, laneCount } = packLanes([]);
    assert.deepEqual(laneOf, []);
    assert.equal(laneCount, 1);
});

// ── hitTestBoxes ──────────────────────────────────────────────────

test('hitTestBoxes: point inside a box returns its input index', () => {
    const boxes = [{ x: 0, w: 50 }, { x: 60, w: 50 }];
    const laneOf = [0, 1];
    assert.equal(hitTestBoxes(boxes, laneOf, 25, 10, 0, 22), 0);
    assert.equal(hitTestBoxes(boxes, laneOf, 80, 32, 0, 22), 1);
});

test('hitTestBoxes: pad makes MIN_BOX_PX slivers clickable', () => {
    const boxes = [{ x: 100, w: MIN_BOX_PX }];
    const laneOf = [0];
    // 2px outside the box edge is still a hit with default pad.
    assert.equal(hitTestBoxes(boxes, laneOf, 100 - 1, 10, 0, 22), 0);
    assert.equal(hitTestBoxes(boxes, laneOf, 100 + MIN_BOX_PX + 1, 10, 0, 22), 0);
    // 6px away is not.
    assert.equal(hitTestBoxes(boxes, laneOf, 100 - 6, 10, 0, 22), null);
});

test('hitTestBoxes: wrong lane row and gaps miss', () => {
    const boxes = [{ x: 0, w: 50 }, { x: 60, w: 50 }];
    const laneOf = [0, 1];
    assert.equal(hitTestBoxes(boxes, laneOf, 25, 32, 0, 22), null); // row 1, box in row 0
    assert.equal(hitTestBoxes(boxes, laneOf, 55, 10, 0, 22), null);  // horizontal gap
});

test('hitTestBoxes: topmost (last-drawn) box wins on overlap', () => {
    const boxes = [{ x: 0, w: 100 }, { x: 50, w: 100 }];
    const laneOf = [0, 0];
    assert.equal(hitTestBoxes(boxes, laneOf, 75, 10, 0, 22), 1);
});

// ── frameSpan (zoom-to-selection) ─────────────────────────────────

test('frameSpan: already-visible span leaves the viewport unchanged', () => {
    const vp = createViewport({ durationSec: 60, viewWidthPx: 1000, pps: 10 });
    const out = frameSpan(vp, 10, 12); // x 100..120, margin 48px → visible
    assert.equal(out.pps, vp.pps);
    assert.equal(out.viewStartSec, vp.viewStartSec);
});

test('frameSpan: off-screen span zooms in just enough and centers it', () => {
    const vp = createViewport({ durationSec: 600, viewWidthPx: 1000, pps: 10 }); // fit=1.67
    const out = frameSpan(vp, 300, 304); // 4s span + margins
    assert.ok(out.pps > vp.pps, 'zoomed in');
    assert.ok(out.pps <= MAX_PPS);
    const x0 = timeToX(out, 300), x1 = timeToX(out, 304);
    assert.ok(x0 >= 0 && x1 <= out.viewWidthPx, 'span fully visible');
    // Roughly centered (clamping may shift at the edges; 300s is mid-timeline).
    assert.ok(Math.abs((x0 + x1) / 2 - out.viewWidthPx / 2) < 2);
});

test('frameSpan: zero-duration span (data untouched, visual only) still frames', () => {
    const vp = createViewport({ durationSec: 600, viewWidthPx: 1000, pps: 10 });
    const out = frameSpan(vp, 42, 42);
    assert.ok(out.pps > vp.pps);
    const x = timeToX(out, 42);
    assert.ok(x >= 0 && x <= out.viewWidthPx);
});

test('frameSpan: clamps inside content bounds at the edges', () => {
    const vp = createViewport({ durationSec: 30, viewWidthPx: 1000, pps: 2 });
    const out = frameSpan(vp, 29, 30);
    assert.ok(out.viewStartSec >= 0);
    // Content shorter than the view stays fully visible.
    if ((out.durationSec || 30) * out.pps <= out.viewWidthPx) {
        assert.equal(out.viewStartSec, 0);
    } else {
        assert.ok(out.viewStartSec + out.viewWidthPx / out.pps <= 30 + 1e-9);
    }
});

// ── round-trip integrity (R7 guard for lanes) ─────────────────────

test('lane pipeline: data → pixels → hit → same group, start/end never drift', () => {
    const vp = createViewport({ durationSec: 120, viewWidthPx: 800, pps: 6, viewStartSec: 20 });
    const groups = [g(1, 20, 23), g(2, 22, 26), g(3, 30, 30)]; // overlap + zero-dur
    const snapshot = structuredClone(groups);
    const boxes = groupBoxes(vp, groups);
    const { laneOf } = packLanes(boxes);
    // Click the middle of each visual box → maps back to the same group.
    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        const hit = hitTestBoxes(boxes, laneOf, b.x + b.w / 2,
                                 0 + laneOf[i] * 22 + 11, 0, 22);
        assert.equal(hit, i);
        assert.equal(boxes[hit].group, groups[i]); // same live object, no copy
    }
    assert.deepEqual(groups, snapshot); // no mutation anywhere
    // And the data still converts back to the original seconds.
    for (let i = 0; i < groups.length; i++) {
        assert.ok(Math.abs(xToTime(vp, timeToX(vp, groups[i].start)) - groups[i].start) < 1e-9);
    }
});
