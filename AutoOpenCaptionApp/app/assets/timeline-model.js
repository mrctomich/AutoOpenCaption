/**
 * Timeline model — pure logic for the interactive timeline editor (Phases 2–3).
 *
 * No DOM, no canvas: viewport state, coordinate transforms, zoom/scroll
 * clamps, ruler tick selection, and box display geometry. All time values
 * are floating-point seconds; pixel values are derived at call time and
 * never persisted or used as a source of truth (design rule: timestamps
 * are never quantized to pixels).
 */

// Upper bound on pixels-per-second zoom (≈ 1 frame per 17 ms at 600 px/s).
export const MAX_PPS = 600;
// Zero/negative/collapsed stored times still render with this width so
// they stay visible and (Phase 4) grabbable. Stored data is never modified.
export const MIN_BOX_PX = 4;

/**
 * Create a viewport.
 * pps omitted or 0 ⇒ zoom-to-fit (all content visible).
 * All parameters clamped so the viewport is always usable.
 */
export function createViewport({ durationSec = 0, viewWidthPx = 0, viewStartSec = 0, pps = 0 } = {}) {
    const vp = {
        durationSec: Math.max(0, durationSec),
        viewWidthPx: Math.max(0, viewWidthPx),
        viewStartSec: 0,
        pps: 0,
    };
    vp.pps = clampPps(vp, pps);
    vp.viewStartSec = clampViewStart(vp, viewStartSec);
    return vp;
}

/** Minimum zoom = fit whole content in the viewport (never zoomed-out past it). */
export function fitPps(vp) {
    if (vp.durationSec <= 0 || vp.viewWidthPx <= 0) return 0;
    return vp.viewWidthPx / vp.durationSec;
}

export function clampPps(vp, pps) {
    if (!Number.isFinite(pps)) return fitPps(vp);
    const min = fitPps(vp);
    if (min === 0) return Math.min(Math.max(pps, 0), MAX_PPS);
    return Math.min(Math.max(pps, min), MAX_PPS);
}

export function clampViewStart(vp, viewStartSec) {
    const maxStart = maxViewStart(vp);
    if (!Number.isFinite(viewStartSec)) return 0;
    return Math.min(Math.max(viewStartSec, 0), maxStart);
}

export function maxViewStart(vp) {
    if (vp.pps <= 0) return 0;
    return Math.max(0, vp.durationSec - vp.viewWidthPx / vp.pps);
}

// ── Coordinate transforms ─────────────────────────────────────────
export function timeToX(vp, tSec) {
    return (tSec - vp.viewStartSec) * vp.pps;
}

export function xToTime(vp, xPx) {
    return vp.viewStartSec + xPx / vp.pps;
}

/** Right edge of the visible window in seconds. */
export function viewEndTime(vp) {
    return vp.viewStartSec + (vp.pps > 0 ? vp.viewWidthPx / vp.pps : 0);
}

// ── Navigation ────────────────────────────────────────────────────
/**
 * Zoom by `factor` keeping the time under `anchorX` fixed at that pixel.
 * Returns a NEW viewport; the anchor invariant
 *   xToTime(next, anchorX) === xToTime(prev, anchorX)
 * holds whenever the resulting viewStart is not edge-clamped.
 */
export function zoomAtAnchor(vp, anchorX, factor) {
    const newPps = clampPps(vp, vp.pps * factor);
    if (newPps === vp.pps) return { ...vp };
    const tAnchor = xToTime(vp, anchorX);
    const next = { ...vp, pps: newPps, viewStartSec: tAnchor - anchorX / newPps };
    next.viewStartSec = clampViewStart(next, next.viewStartSec);
    return next;
}

/** Pan by a pixel delta (drag-right moves the window left in time). */
export function panByPixels(vp, dxPx) {
    const next = { ...vp, viewStartSec: vp.viewStartSec - dxPx / (vp.pps || 1) };
    next.viewStartSec = clampViewStart(next, next.viewStartSec);
    return next;
}

/** Whole-content zoom. */
export function fitViewport(vp) {
    const next = { ...vp, pps: fitPps(vp), viewStartSec: 0 };
    return next;
}

/** Ensure `t` is visible: center it if outside, else leave untouched. */
export function scrollToTime(vp, t) {
    const vEnd = viewEndTime(vp);
    if (vp.pps <= 0 || vp.durationSec <= 0) return { ...vp };
    if (t >= vp.viewStartSec && t <= vEnd) return { ...vp };
    const span = vp.viewWidthPx / vp.pps;
    const next = { ...vp, viewStartSec: t - span / 2 };
    next.viewStartSec = clampViewStart(next, next.viewStartSec);
    return next;
}

// ── Ruler ─────────────────────────────────────────────────────────
/** Major tick candidates in seconds (each minor band = major / 5). */
export const RULER_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600];
export const MINOR_SUBDIVISIONS = 5;

/** Smallest step whose on-screen spacing is >= minMajorPx (largest if none). */
export function pickRulerStep(pps, minMajorPx = 70) {
    if (!(pps > 0)) return RULER_STEPS[RULER_STEPS.length - 1];
    for (const step of RULER_STEPS) {
        if (step * pps >= minMajorPx) return step;
    }
    return RULER_STEPS[RULER_STEPS.length - 1];
}

/**
 * Tick times for the current viewport: `{ majors, minors }` in seconds.
 * Computed by integer index (k*step) — never by float accumulation — so
 * ticks land exactly on multiples of the step. Bounded for safety.
 */
export function rulerTicks(vp, step = pickRulerStep(vp.pps)) {
    const majors = [];
    const minors = [];
    if (!(vp.pps > 0) || vp.durationSec <= 0 || !(step > 0)) return { majors, minors };
    const start = vp.viewStartSec;
    const end = viewEndTime(vp);
    const MAX_TICKS = 4000;

    let k0 = Math.floor(start / step);
    let k1 = Math.ceil(end / step);
    if (k1 - k0 > MAX_TICKS) k1 = k0 + MAX_TICKS;
    for (let k = k0; k <= k1; k++) {
        const t = k * step;
        if (t >= -1e-9 && t <= vp.durationSec + 1e-9) majors.push(t);
    }

    const minorStep = step / MINOR_SUBDIVISIONS;
    k0 = Math.floor(start / minorStep);
    k1 = Math.ceil(end / minorStep);
    if (k1 - k0 > MAX_TICKS) k1 = k0 + MAX_TICKS;
    for (let k = k0; k <= k1; k++) {
        if (k % MINOR_SUBDIVISIONS === 0) continue; // majors drawn separately
        const t = k * minorStep;
        if (t >= -1e-9 && t <= vp.durationSec + 1e-9) minors.push(t);
    }
    return { majors, minors };
}

/** Compact ruler label: M:SS (step ≥ 1 s), M:SS.d, or M:SS.dd for 0.25 s. */
export function formatRulerTime(t, step) {
    const clamped = Math.max(0, t);
    const m = Math.floor(clamped / 60);
    let s = clamped - m * 60;
    const decimals = step >= 1 ? 0 : (step === 0.25 ? 2 : 1);
    s = Number(s.toFixed(decimals));
    if (s >= 60) { m += 1; s -= 60; } // rounding pushed .95 → 60.0
    const sStr = decimals > 0
        ? s.toFixed(decimals).padStart(3 + decimals, '0')
        : String(Math.round(s)).padStart(2, '0');
    return `${m}:${sStr}`;
}

// ── Box display geometry ──────────────────────────────────────────
/**
 * Screen rect for a stored [start, end] span. Width is at least
 * MIN_BOX_PX (centered on the true position when clamped up) so collapsed
 * or zero-length stored times remain visible; the stored values are never
 * touched here. `degenerate: true` marks widths that were bumped.
 */
export function boxRect(vp, startSec, endSec) {
    let x = timeToX(vp, startSec);
    let w = (endSec - startSec) * vp.pps;
    let degenerate = false;
    if (!(w >= MIN_BOX_PX)) { // also catches NaN / negative spans
        degenerate = !(endSec > startSec) || w < MIN_BOX_PX;
        const center = x + (Number.isFinite(w) ? w : 0) / 2;
        x = center - MIN_BOX_PX / 2;
        w = MIN_BOX_PX;
    }
    return { x, w, degenerate };
}

// ── Caption boxes (Phase 3) ───────────────────────────────────────
/**
 * Display boxes for caption groups. Input is `App.captionGroups` verbatim —
 * the same derived array the preview canvas and SRT/VTT export consume, so
 * box boundaries match exported cue boundaries exactly (acceptance P3).
 *
 * Purely visual: x/w come from the viewport at call time, and the stored
 * `start`/`end` on the groups are NEVER read back from or written to here.
 * Boxes keep their input array index so hit results map back to groups.
 */
export function groupBoxes(vp, groups) {
    if (!groups || !groups.length) return [];
    return groups.map((g, index) => {
        const r = boxRect(vp, g.start, g.end);
        return {
            index,
            group: g,
            x: r.x,
            w: r.w,
            degenerate: r.degenerate,
            // Word the box selects on click: the group's first live word.
            word: g.words && g.words.length ? g.words[0] : null,
        };
    });
}

/**
 * Greedy lane packing: boxes land in the first lane whose last visual
 * extent ends before this box starts (±1 px slack absorbs float wobble of
 * back-to-back cues). Packing runs in the input order (= cue order), which
 * keeps each lane chronologically sorted and stable across redraws.
 * Returns `{ laneOf: number[], laneCount }`.
 */
export function packLanes(boxes, slackPx = 1) {
    const laneOf = new Array(boxes.length).fill(0);
    const laneEnds = []; // visual right edge of the last box per lane
    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        let placed = false;
        for (let l = 0; l < laneEnds.length; l++) {
            if (b.x >= laneEnds[l] - slackPx) {
                laneOf[i] = l;
                laneEnds[l] = b.x + b.w;
                placed = true;
                break;
            }
        }
        if (!placed) {
            laneOf[i] = laneEnds.length;
            laneEnds.push(b.x + b.w);
        }
    }
    return { laneOf, laneCount: Math.max(1, laneEnds.length) };
}

/**
 * Hit-test a point against packed caption boxes. Returns the input index of
 * the topmost (last-drawn) box under the point, or null. `padPx` grows each
 * box's hit area so MIN_BOX_PX slivers stay clickable (R6); the lane strip's
 * vertical bounds are the caller's business.
 */
export function hitTestBoxes(boxes, laneOf, xPx, yPx, laneTop, laneH, padPx = 2) {
    for (let i = boxes.length - 1; i >= 0; i--) {
        const b = boxes[i];
        if (laneOf[i] == null) continue;
        const y0 = laneTop + laneOf[i] * laneH;
        if (yPx < y0 - padPx || yPx > y0 + laneH + padPx) continue;
        if (xPx >= b.x - padPx && xPx <= b.x + b.w + padPx) return i;
    }
    return null;
}

/**
 * Viewport framing a [start, end] span (zoom-to-selection): if the span is
 * already visible with the requested margin, the viewport is returned
 * unchanged; otherwise zoom in just enough (never past MAX_PPS) and pan so
 * the span is centered with `marginPx` breathing room on both sides.
 *
 * Zero-duration spans (collapsed/degenerate cues, or framing the playhead
 * with no selection) have no extent to check, so the stay-put rule cannot
 * apply: framing a point always zooms in one multiplicative step and stays
 * bounded by MAX_PPS, so repeated presses drill in and then stop instead of
 * silently doing nothing.
 */
export function frameSpan(vp, startSec, endSec, marginPx = 48) {
    if (!(vp.pps > 0) || !Number.isFinite(startSec)) return { ...vp };
    const end = Number.isFinite(endSec) ? Math.max(endSec, startSec) : startSec;
    // Already fully visible with the margin? Stay put (positive spans only).
    if (end > startSec) {
        const marginSec = marginPx / vp.pps;
        if (startSec >= vp.viewStartSec + marginSec && end <= viewEndTime(vp) - marginSec) {
            return { ...vp };
        }
    }
    // Zoom in only as far as needed to fit span + margin (never past MAX_PPS,
    // never below the current zoom).
    const needPps = vp.viewWidthPx / (end - startSec + 2 * (marginPx / Math.max(vp.pps, 1e-9)));
    const targetPps = clampPps(vp, Math.min(Math.max(vp.pps, needPps), MAX_PPS));
    const next = { ...vp, pps: targetPps };
    const center = (startSec + end) / 2;
    next.viewStartSec = clampViewStart(next, center - (next.viewWidthPx / targetPps) / 2);
    return next;
}
