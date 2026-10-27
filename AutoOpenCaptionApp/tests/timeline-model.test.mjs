/**
 * Timeline editor Phase 2 — pure viewport/transform logic
 * (app/assets/timeline-model.js). No DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createViewport, fitPps, clampPps, clampViewStart, maxViewStart,
    timeToX, xToTime, viewEndTime,
    zoomAtAnchor, panByPixels, fitViewport, scrollToTime,
    pickRulerStep, rulerTicks, formatRulerTime,
    boxRect, MIN_BOX_PX, MAX_PPS, RULER_STEPS,
} from '../app/assets/timeline-model.js';

const EPS = 1e-9;

test('createViewport: omitted pps zooms to fit', () => {
    const vp = createViewport({ durationSec: 60, viewWidthPx: 1200 });
    assert.equal(vp.pps, 20);
    assert.equal(vp.viewStartSec, 0);
});

test('createViewport: clamps out-of-range start and pps', () => {
    const vp = createViewport({ durationSec: 10, viewWidthPx: 100, viewStartSec: 999, pps: 1e9 });
    assert.equal(vp.pps, MAX_PPS);
    assert.equal(vp.viewStartSec, maxViewStart(vp)); // 10 - 100/600
    const vp2 = createViewport({ durationSec: 10, viewWidthPx: 100, viewStartSec: -5, pps: 0.001 });
    assert.equal(vp2.viewStartSec, 0);
    assert.equal(vp2.pps, 10); // fit clamp
});

test('t→x→t round-trip is exact within float epsilon', () => {
    const vp = createViewport({ durationSec: 37.42, viewWidthPx: 977, pps: 137.3 });
    vp.viewStartSec = clampViewStart(vp, 12.5);
    for (const t of [0, 0.001, 3.14159, 12.5, 20.000001, 37.42]) {
        const back = xToTime(vp, timeToX(vp, t));
        assert.ok(Math.abs(back - t) < EPS, `round-trip ${t} → ${back}`);
    }
});

test('fitPps / clampPps bounds', () => {
    const vp = createViewport({ durationSec: 200, viewWidthPx: 1000 });
    assert.equal(fitPps(vp), 5);
    assert.equal(clampPps(vp, 1), 5);     // never below fit
    assert.equal(clampPps(vp, 10000), MAX_PPS);
    assert.equal(clampPps(vp, 42), 42);
    // Empty viewport: no fit floor, but still bounded
    const empty = createViewport({ durationSec: 0, viewWidthPx: 1000 });
    assert.equal(fitPps(empty), 0);
    assert.equal(clampPps(empty, 50), 50);
});

test('zoomAtAnchor: anchor time stays at the same pixel', () => {
    const vp = createViewport({ durationSec: 60, viewWidthPx: 1000 }); // fit, pps 16.67
    const anchorX = 400;
    const tAnchor = xToTime(vp, anchorX);
    const next = zoomAtAnchor(vp, anchorX, 2);
    assert.ok(Math.abs(next.pps - vp.pps * 2) < EPS);
    assert.ok(Math.abs(xToTime(next, anchorX) - tAnchor) < 1e-9);
    // Zoom back out with the inverse factor restores the anchor too
    const back = zoomAtAnchor(next, anchorX, 0.5);
    assert.ok(Math.abs(xToTime(back, anchorX) - tAnchor) < 1e-9);
});

test('zoomAtAnchor: clamped at both extremes', () => {
    const vp = createViewport({ durationSec: 60, viewWidthPx: 1000 });
    // Zooming OUT below fit is a no-op (already fully visible)
    const noChange = zoomAtAnchor(vp, 500, 0.5);
    assert.equal(noChange.pps, vp.pps);
    assert.equal(noChange.viewStartSec, 0);
    // Zooming IN past MAX_PPS stops at MAX_PPS, start stays >= 0
    let z = vp;
    for (let i = 0; i < 20; i++) z = zoomAtAnchor(z, 0, 2);
    assert.equal(z.pps, MAX_PPS);
    assert.ok(z.viewStartSec >= 0);
});

test('panByPixels: pans and clamps at both edges', () => {
    const vp = createViewport({ durationSec: 60, viewWidthPx: 100, pps: 10 }); // window = 10 s
    assert.ok(Math.abs(panByPixels(vp, -50).viewStartSec - 5) < EPS);   // left-pan 50 px = 5 s
    assert.equal(panByPixels(vp, 50).viewStartSec, 0);                   // clamp at 0
    const far = panByPixels(vp, -1e6);
    assert.equal(far.viewStartSec, maxViewStart(vp));                    // clamp at duration - window
});

test('fitViewport shows whole content from zero', () => {
    const vp = createViewport({ durationSec: 30, viewWidthPx: 600, pps: 50 });
    vp.viewStartSec = 12;
    const fit = fitViewport(vp);
    assert.equal(fit.pps, 20);
    assert.equal(fit.viewStartSec, 0);
    assert.ok(Math.abs(viewEndTime(fit) - 30) < EPS);
});

test('scrollToTime: centers out-of-view times, leaves visible times alone', () => {
    const vp = createViewport({ durationSec: 100, viewWidthPx: 100, pps: 2 }); // window 50 s
    const same = scrollToTime(vp, 20); // already inside 0..50
    assert.equal(same.viewStartSec, vp.viewStartSec);
    const jumped = scrollToTime(vp, 90);
    // Centered start would be 65 s, but the window (50 s) clamps at 50 s
    assert.equal(jumped.viewStartSec, 50);
    assert.ok(jumped.viewStartSec <= maxViewStart(jumped));
    // A time just past the right edge but not near the end centers exactly
    const vp2 = createViewport({ durationSec: 100, viewWidthPx: 100, pps: 2 });
    assert.ok(Math.abs(scrollToTime(vp2, 55).viewStartSec - 30) < EPS);
});

test('pickRulerStep: major spacing >= minMajorPx across zoom range', () => {
    const cases = [
        [600, 0.25],   // 0.1 would be 60 px (<70) → 0.25 (150 px)
        [100, 1],
        [30, 5],       // 2*30=60<70 → 5 (150)
        [2, 60],       // 30*2=60<70 → 60 (120)
        [0.5, 300],    // 120*0.5=60<70 → 300 (150)
        [0, RULER_STEPS.at(-1)],
    ];
    for (const [pps, expected] of cases) {
        assert.equal(pickRulerStep(pps), expected, `pps=${pps}`);
    }
    // Invariant: chosen step always >= min spacing (unless largest step)
    for (const pps of [3, 7, 17, 33, 61, 123, 240, 480]) {
        const step = pickRulerStep(pps, 70);
        assert.ok(step * pps >= 70 || step === RULER_STEPS.at(-1), `pps=${pps} step=${step}`);
    }
});

test('rulerTicks: majors land on exact multiples, minors subdivide by 5', () => {
    const vp = createViewport({ durationSec: 10, viewWidthPx: 400, pps: 40 }); // window 10 s
    const { majors, minors } = rulerTicks(vp, 1);
    assert.deepEqual(majors, Array.from({ length: 11 }, (_, i) => i));
    for (const t of minors) {
        assert.ok(t >= 0 && t <= 10);
        assert.ok(Math.abs(t * 5 - Math.round(t * 5)) < EPS);   // multiple of 0.2
        assert.ok(Math.abs(t - Math.round(t)) > EPS, 'minors must exclude majors');
    }
    assert.equal(minors.length, 10 * 4); // 4 minors between each pair of 11 majors
});

test('rulerTicks: panned window ticks follow viewStart', () => {
    const vp = createViewport({ durationSec: 60, viewWidthPx: 100, pps: 10 });
    vp.viewStartSec = 32; // window 32..42
    const { majors } = rulerTicks(vp, 1);
    assert.equal(majors[0], 32);
    assert.equal(majors.at(-1), 42);
});

test('rulerTicks: empty for no duration or zero zoom', () => {
    const empty = createViewport({ durationSec: 0, viewWidthPx: 500 });
    assert.deepEqual(rulerTicks(empty, 1), { majors: [], minors: [] });
    const vp = { durationSec: 10, viewWidthPx: 500, viewStartSec: 0, pps: 0 };
    assert.deepEqual(rulerTicks(vp, 1), { majors: [], minors: [] });
});

test('formatRulerTime: compact labels per step size', () => {
    assert.equal(formatRulerTime(0, 1), '0:00');
    assert.equal(formatRulerTime(65, 1), '1:05');
    assert.equal(formatRulerTime(599, 10), '9:59');
    assert.equal(formatRulerTime(61.25, 0.25), '1:01.25');
    assert.equal(formatRulerTime(5.5, 0.5), '0:05.5');
    assert.equal(formatRulerTime(0.1, 0.1), '0:00.1');
    // float wobble is absorbed
    assert.equal(formatRulerTime(2 * 0.1, 0.1), '0:00.2');
});

test('boxRect: normal span, minimum width, degenerate spans', () => {
    const vp = createViewport({ durationSec: 10, viewWidthPx: 1000, pps: 100 });
    const r = boxRect(vp, 1.0, 1.5);
    assert.ok(Math.abs(r.x - 100) < EPS);
    assert.ok(Math.abs(r.w - 50) < EPS);
    assert.equal(r.degenerate, false);
    // Zero-length stored span still renders MIN_BOX_PX centered on position
    const z = boxRect(vp, 3.0, 3.0);
    assert.equal(z.w, MIN_BOX_PX);
    assert.ok(Math.abs(z.x - (300 - MIN_BOX_PX / 2)) < EPS);
    assert.equal(z.degenerate, true);
    // Sub-pixel span is bumped to MIN_BOX_PX too
    const s = boxRect(vp, 2.0, 2.005); // 0.5 px
    assert.equal(s.w, MIN_BOX_PX);
    // Inverted/NaN spans never produce negative widths
    assert.ok(boxRect(vp, 5, 4).w >= MIN_BOX_PX);
    assert.ok(boxRect(vp, NaN, 4).w >= MIN_BOX_PX);
});
