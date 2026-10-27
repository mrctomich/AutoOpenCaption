/**
 * Timeline model — pure logic for the interactive timeline editor (Phase 2).
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
