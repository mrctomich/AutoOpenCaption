/**
 * Timeline model — pure logic for the interactive timeline editor (Phases 2–4).
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
export function groupBoxes(vp, groups, allWords = null) {
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
            // Transcript-array index per group word (parallel to g.words;
            // -1 when not resolvable). Phase 4 word-level edits need it;
            // indexOf on live word objects, so it reflects the CURRENT array.
            wordIndex: (allWords && g.words)
                ? g.words.map(w => allWords.indexOf(w))
                : undefined,
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

// ── Direct timing edits (Phase 4) ─────────────────────────────────
// Gesture resolution and clamping are PURE: the view drags a ghost and the
// App commits through the same functions, so the ghost always shows exactly
// what the commit will produce. Data is only ever touched once, on commit
// (design: no per-move writes).

/** Pointer grab zone within a box: 'left' | 'right' edge or 'body'. */
export function grabZone(xInBox, boxW, edgePx = 5) {
    if (boxW >= 2 * edgePx + 2) {
        if (xInBox < edgePx) return 'left';
        if (xInBox > boxW - edgePx) return 'right';
    }
    return 'body';
}

/** Word sub-boxes become visible (and word-gesture-grabbable) at this zoom (Q3). */
export const WORD_SUB_PPS = 120;

/**
 * Resolve the gesture for a press inside a caption box.
 *
 *  - `zone`  : grabZone() result for the box body/edges.
 *  - `wordIndexInGroup`: index of the word under the cursor within
 *              box.group.words when zoomed past WORD_SUB_PPS (else null).
 *  - `wordIndex`: that word's index in the transcript's full words array.
 *
 * Edge zones drill to word-edge resizes when a word is under the cursor;
 * body zones drag the whole word when a word is under the cursor, else the
 * whole group. Returns null for nothing grabbable (caller falls back to
 * pan/seek).
 */
export function resolveGesture({ zone, wordIndexInGroup = null, wordIndex = -1, groupIndex }) {
    const wordGrab = wordIndexInGroup != null && wordIndex >= 0;
    if (zone === 'left') {
        return wordGrab
            ? { kind: 'word-resize', wordIndex, edge: 'start' }
            : { kind: 'group-resize', groupIndex, edge: 'start' };
    }
    if (zone === 'right') {
        return wordGrab
            ? { kind: 'word-resize', wordIndex, edge: 'end' }
            : { kind: 'group-resize', groupIndex, edge: 'end' };
    }
    return wordGrab
        ? { kind: 'word-move', wordIndex }
        : { kind: 'group-move', groupIndex };
}

/**
 * Live (non-deleted) neighbour bounds around [fromIdx, toIdx] in the FULL
 * transcript word array: prevEnd = end of the closest live word before the
 * span, nextStart = start of the closest live word after it. Infinity when
 * none — the span is the first/last live word.
 */
export function liveNeighborBounds(words, fromIdx, toIdx) {
    let prevEnd = -Infinity;
    let nextStart = Infinity;
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (w.deleted) continue; // words inside the span match neither branch
        if (i < fromIdx) prevEnd = Math.max(prevEnd, w.end);
        else if (i > toIdx) nextStart = Math.min(nextStart, w.start);
    }
    return { prevEnd, nextStart };
}

/**
 * Allowed drag delta (seconds) for a gesture given the CURRENT word data.
 * Clamps per design: start ≥ 0, end ≤ duration, start ≤ end, and stricter
 * than the inspector — drags may not cross a live neighbour's edge, keeping
 * words monotonically ordered (the existing word array order is playback
 * order). Returns `{ lo, hi }` (may be lo > hi when the data already
 * violates the rules; clampDelta then pins to `hi`).
 */
export function editBounds(gesture, words, durationSec) {
    const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Infinity;
    const w = (i) => (i >= 0 && i < words.length ? words[i] : null);

    if (gesture.kind === 'word-move' || gesture.kind === 'word-resize') {
        const word = w(gesture.wordIndex);
        if (!word) return { lo: 0, hi: 0 };
        const { prevEnd, nextStart } = liveNeighborBounds(words, gesture.wordIndex, gesture.wordIndex);
        if (gesture.kind === 'word-move') {
            // Whole word translates, duration preserved.
            return {
                lo: Math.max(0 - word.start, prevEnd - word.start),
                hi: Math.min(dur - word.end, nextStart - word.end),
            };
        }
        if (gesture.edge === 'start') {
            // New start ∈ [prevEnd, word.end] ∩ [0, ∞).
            return {
                lo: Math.max(0, prevEnd) - word.start,
                hi: word.end - word.start,
            };
        }
        // edge === 'end': new end ∈ [word.start, nextStart] ∩ [.., dur].
        return {
            lo: word.start - word.end,
            hi: Math.min(dur, nextStart) - word.end,
        };
    }

    // Group gestures need the group's word list → editBoundsForGroup().
    return { lo: 0, hi: 0 };
}

/**
 * Bounds for a GROUP gesture. `groupWordsArr` is the group's live words and
 * `wordIndexes` their parallel indices in the full transcript array (from
 * groupBoxes). Move translates every word (duration and internal gaps
 * preserved); resize-start moves only the first word's start, resize-end
 * only the last word's end.
 */
export function editBoundsForGroup(gesture, allWords, groupWordsArr, wordIndexes, durationSec) {
    const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Infinity;
    if (!groupWordsArr || !groupWordsArr.length) return { lo: 0, hi: 0 };
    const idxs = wordIndexes && wordIndexes.length === groupWordsArr.length
        ? wordIndexes
        : groupWordsArr.map(() => -1);
    const valid = idxs.map((ix, i) => ({ ix, i })).filter(o => o.ix >= 0);
    if (!valid.length) return { lo: 0, hi: 0 };

    const from = Math.min(...valid.map(o => o.ix));
    const to = Math.max(...valid.map(o => o.ix));
    const { prevEnd, nextStart } = liveNeighborBounds(allWords, from, to);

    if (gesture.kind === 'group-move') {
        // Every word must stay in [prevEnd-side, nextStart-side] and inside
        // [0, dur] — the tightest word in the group wins.
        let lo = -Infinity, hi = Infinity;
        for (const { i } of valid) {
            const word = allWords[idxs[i]];
            lo = Math.max(lo, -word.start, prevEnd - word.start);
            hi = Math.min(hi, dur - word.end, nextStart - word.end);
        }
        return { lo: Number.isFinite(lo) ? lo : 0, hi: Number.isFinite(hi) ? hi : 0 };
    }
    // group-resize: only one word's one edge moves.
    if (gesture.edge === 'start') {
        const firstIdx = valid.reduce((a, b) => (a.ix < b.ix ? a : b)).ix;
        const word = allWords[firstIdx];
        return {
            lo: Math.max(0, prevEnd) - word.start,
            hi: word.end - word.start,
        };
    }
    const lastIdx = valid.reduce((a, b) => (a.ix > b.ix ? a : b)).ix;
    const word = allWords[lastIdx];
    return {
        lo: word.start - word.end,
        hi: Math.min(dur, nextStart) - word.end,
    };
}

/** Apply `{ lo, hi }` to a raw delta (pins to hi when bounds are inverted). */
export function clampDelta(delta, { lo, hi }) {
    return Math.min(Math.max(delta, lo), hi);
}

/**
 * Per-word display sub-boxes for the words of one group (drawn and
 * hit-tested when pps ≥ WORD_SUB_PPS). Same MIN_BOX_PX display rule as
 * group boxes; stored word times are never touched.
 */
export function wordBoxes(vp, words) {
    if (!words || !words.length) return [];
    return words.map((word, i) => {
        const r = boxRect(vp, word.start, word.end);
        return { i, word, x: r.x, w: r.w, degenerate: r.degenerate };
    });
}
