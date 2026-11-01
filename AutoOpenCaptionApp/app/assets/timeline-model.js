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
 * touched here. `degenerate: true` marks TIME spans that are zero/inverted/non-finite
 * (rendered as dashed warnings); `widened: true` marks valid spans bumped
 * to MIN_BOX_PX for visibility at the current zoom.
 */
export function boxRect(vp, startSec, endSec) {
    const trueX = timeToX(vp, startSec);
    const rawW = (endSec - startSec) * vp.pps;
    let x = trueX, w = rawW;
    // `degenerate` is a property of the TIME span (zero, inverted or
    // non-finite), NEVER of the zoom level: at low zoom a perfectly valid
    // short cue must not be flagged as broken just because it is < MIN_BOX_PX.
    const degenerate = !(endSec > startSec);
    let widened = false;
    if (!(w >= MIN_BOX_PX)) { // also catches NaN / negative spans
        widened = !degenerate;
        const center = x + (Number.isFinite(w) ? w : 0) / 2;
        x = center - MIN_BOX_PX / 2;
        w = MIN_BOX_PX;
    }
    // TRUE (unwidened) extent, used by packLanes: cues pack by when they
    // actually happen, so MIN_BOX_PX widening at low zoom cannot
    // manufacture extra lanes (max-words=1 at low zoom used to pile every
    // short word into its own lane). NaN spans stay NaN → each invalid cue
    // takes its own lane instead of hiding behind a neighbour.
    return { x, w, degenerate, widened, trueX, trueW: Number.isFinite(rawW) ? Math.max(0, rawW) : NaN };
}

/**
 * Cue text for a word list (Phase 5e): the words' texts joined with SINGLE
 * spaces, dropping empty/whitespace-only entries. Fresh captions are created
 * with no text (planNewCaption default) and the inspector can clear a word's
 * text — without this filter the plain `join(' ')` produces leading spaces
 * (`['', 'alpha']` → `' alpha'`) or double spaces (`['a', '', 'b']` →
 * `'a  b'`) in SRT/VTT export, the transcript display pane, and timeline
 * box labels. All four call sites share this one join so the exported text
 * and the on-screen text stay identical.
 */
export function joinWordTexts(words) {
    if (!words || !words.length) return '';
    return words
        .map((w) => (w && w.text ? String(w.text).trim() : ''))
        .filter((t) => t !== '')
        .join(' ');
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
            widened: r.widened,
            trueX: r.trueX,
            trueW: r.trueW,
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
    const laneEnds = []; // TRUE right edge (seconds→px) of the last VALID box per lane
    const invalidIdx = []; // cues with no finite true extent
    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        // Pack by the TRUE time extent, not the MIN_BOX_PX-widened display
        // box: chronological cues never collide, no matter how far out the
        // user has zoomed (widened slivers may visually overlap ~2px, which
        // is far more honest than inventing lanes).
        const bx = b.trueX ?? b.x;
        const bw = b.trueW ?? b.w;
        if (!Number.isFinite(bx) || !Number.isFinite(bw)) {
            invalidIdx.push(i); // no position at all → reserved lane, below
            continue;
        }
        let placed = false;
        for (let l = 0; l < laneEnds.length; l++) {
            if (bx >= laneEnds[l] - slackPx) {
                laneOf[i] = l;
                laneEnds[l] = bx + bw;
                placed = true;
                break;
            }
        }
        if (!placed) {
            laneOf[i] = laneEnds.length;
            laneEnds.push(bx + bw);
        }
    }
    // Invalid cues (NaN start/end) render at x=NaN — i.e. nowhere. They
    // share ONE reserved lane after all valid lanes: they must neither
    // invent one lane per broken cue nor poison a shared lane end and
    // push every later valid cue down a row.
    if (invalidIdx.length) {
        const reserved = laneEnds.length;
        for (const i of invalidIdx) laneOf[i] = reserved;
        laneEnds.push(Infinity);
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
 * Proposed times for a gesture delta — the ghost's single source of truth
 * (Phase 4b). PURE: nothing is written to `words`; the App's commit funnel
 * (Phase 4d) applies the same rule to the same indices, so the ghost always
 * shows exactly what the commit will produce.
 *
 * Returns a Map of transcript word index → `{ start, end }` for every word
 * the gesture touches (all group words on group-move, one word otherwise).
 * The delta is clamped here (same bounds as the commit) so a ghost can never
 * show an impossible position. Empty Map for gestures with no valid target.
 */
export function applyGestureDelta(gesture, allWords, wordIndexes, deltaSec) {
    const out = new Map();
    const idxs = Array.isArray(wordIndexes) ? wordIndexes : [];
    const valid = [];
    idxs.forEach((ix, i) => {
        if (Number.isInteger(ix) && ix >= 0 && ix < allWords.length) valid.push({ ix, i });
    });
    if (!valid.length) return out;

    const set = (ix, start, end) => out.set(ix, { start, end });

    if (gesture.kind === 'word-move') {
        const word = allWords[gesture.wordIndex];
        if (word) set(gesture.wordIndex, word.start + deltaSec, word.end + deltaSec);
        return out;
    }
    if (gesture.kind === 'word-resize') {
        const word = allWords[gesture.wordIndex];
        if (!word) return out;
        if (gesture.edge === 'start') set(gesture.wordIndex, word.start + deltaSec, word.end);
        else set(gesture.wordIndex, word.start, word.end + deltaSec);
        return out;
    }

    // Group gestures operate on the valid transcript indices directly.
    if (gesture.kind === 'group-move') {
        for (const { ix } of valid) {
            const word = allWords[ix];
            set(ix, word.start + deltaSec, word.end + deltaSec);
        }
        return out;
    }
    if (gesture.kind === 'group-resize') {
        if (gesture.edge === 'start') {
            const { ix } = valid.reduce((a, b) => (a.ix < b.ix ? a : b));
            const word = allWords[ix];
            set(ix, word.start + deltaSec, word.end);
        } else {
            const { ix } = valid.reduce((a, b) => (a.ix > b.ix ? a : b));
            const word = allWords[ix];
            set(ix, word.start, word.end + deltaSec);
        }
        return out;
    }
    return out;
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

/**
 * Index of the word sub-box under xPx, or -1 (Phase 4c pointer FSM). Uses
 * the same boxRect display rule as wordBoxes (degenerate words keep a
 * MIN_BOX_PX grab target). Callers gate on the parent box hit first, so a
 * last-word sliver extending past the group's visual edge is naturally
 * clipped by that gate. First match wins (group words don't overlap).
 */
export function hitTestWordBox(vp, words, xPx) {
    if (!words || !words.length) return -1;
    for (let i = 0; i < words.length; i++) {
        const r = boxRect(vp, words[i].start, words[i].end);
        if (xPx >= r.x && xPx <= r.x + r.w) return i;
    }
    return -1;
}

/**
 * Validate a gesture proposal Map into word mutations (Phase 4d commit
 * funnel). PURE: returns a list of `{ index, start, end }` changes and
 * writes nothing — `App.applyTimelineEdit` applies the list to
 * `transcript.words` once per completed gesture, behind a single
 * `saveState()`, and sets `userAdjusted` on each touched word.
 *
 * Rules (progress doc R2/R6):
 *  - Only valid indices with finite proposed times are accepted.
 *  - `start >= 0` always. A NEW start>end inversion is never introduced;
 *    a word already stored inverted keeps its inversion (invalid values
 *    are rendered-as-stored, never silently "fixed").
 *  - Entries equal to the stored times produce no mutation — a zero-delta
 *    gesture or a drag returned to its origin makes the whole commit empty,
 *    so the funnel no-ops and skips the undo save entirely.
 *
 * The output carries ONLY start/end: every other word field (`text`,
 * `deleted`, `estimated*`, `orig*`, `original*`, `unplaced`, flags) is off
 * limits to the commit funnel by design.
 */
export function commitProposal(words, proposal, eps = 1e-9) {
    const mutations = [];
    if (!words || !proposal || typeof proposal.forEach !== 'function') return mutations;
    proposal.forEach((p, ix) => {
        if (!Number.isInteger(ix) || ix < 0 || ix >= words.length) return;
        const word = words[ix];
        if (!word || !p) return;
        const start = p.start, end = p.end;
        if (!Number.isFinite(start) || !Number.isFinite(end)) return;
        if (start < 0) return;
        const wasValid = word.end >= word.start;         // stored sanity baseline
        if (wasValid && end < start) return;             // never introduce inversion
        if (Math.abs(word.start - start) <= eps && Math.abs(word.end - end) <= eps) return;
        mutations.push({ index: ix, start, end });
    });
    return mutations;
}

// ── Caption creation (Phase 5) ─────────────────────────────────────────
//
// Pure planning for user-created captions: the view computes a click time,
// the App commits the plan. Like commitProposal, this never mutates — the
// caller splices the returned word at the returned index through the single
// App funnel (one saveState() per create).

// Matches the renderer's emitted-cue minimum (groupWords clamps to 0.1 s);
// a planned caption shorter than this can never render as specified.
export const MIN_CAPTION_SEC = 0.1;
// Default span for a caption created from a bare click position.
export const DEFAULT_CAPTION_SEC = 1.0;

/**
 * Next unique word id: `w####` continuing the max numeric suffix found in
 * existing ids. The scan must cover splitWord's injected `w<date6>` ids
 * (six-digit, large) — a plain count would collide with those. If the
 * computed id is somehow taken, it increments until free.
 */
export function nextWordId(words) {
    let max = 0;
    const taken = new Set();
    for (const w of words || []) {
        const id = w && w.id;
        if (typeof id !== 'string') continue;
        taken.add(id);
        const m = /^w(\d+)$/.exec(id);
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    let n = max + 1;
    while (taken.has(`w${String(n).padStart(4, '0')}`)) n++;
    return `w${String(n).padStart(4, '0')}`;
}

/**
 * Plan a new caption without touching data.
 *
 * @param words   current transcript.words (may be null/empty)
 * @param startSec requested start (click/playhead time). Non-finite ⇒ reject.
 * @param endSec   optional requested end (omitted ⇒ start + DEFAULT_CAPTION_SEC)
 * @param text     optional caption text (omitted ⇒ '' — user types it in 5e)
 * @param durationSec media duration (finite > 0 ⇒ clamps both ends)
 *
 * Policy:
 *  - start clamps into [0, duration]; end into [start + MIN, duration].
 *  - The span then shrinks into the gap between neighbouring LIVE words
 *    (deleted words' timings no longer block — the renderer skips them).
 *    `shrunk: true` reports this. If less than MIN_CAPTION_SEC remains the
 *    plan is rejected: reason 'no-room' (App shows a status note, no data
 *    changes) — captions must never overlap spoken words on creation; the
 *    monotonicity guard and cue clamping stay a repair path, not a routine.
 *  - The new word is USER data from birth: userAdjusted true and orig*
 *    baselines equal to the planned span, so CTC realign and drift
 *    detection both treat it as untouchable (never "modified").
 *  - `index` keeps the array sorted by start (insertion point after any
 *    equal-start words, including deleted ones, which keep their place).
 *
 * @returns {ok:true, word, index, shrunk} | {ok:false, reason}
 */
export function planNewCaption({ words = [], startSec, endSec, text = '', durationSec } = {}) {
    if (!Number.isFinite(startSec)) return { ok: false, reason: 'bad-start' };
    let start = Math.max(0, startSec);
    let end = Number.isFinite(endSec) ? endSec : start + DEFAULT_CAPTION_SEC;
    const bounded = Number.isFinite(durationSec) && durationSec > 0;
    if (bounded) {
        start = Math.min(start, durationSec);
        end = Math.min(end, durationSec);
    }
    if (end - start < MIN_CAPTION_SEC) {
        // Degenerate/clamped-away span: restore the DEFAULT length first
        // (a click at the very end of the media still deserves a
        // full-length caption pulled backwards), falling back to MIN.
        const maxLen = bounded ? Math.min(DEFAULT_CAPTION_SEC, durationSec) : DEFAULT_CAPTION_SEC;
        if (maxLen < MIN_CAPTION_SEC) return { ok: false, reason: 'no-room' };
        end = bounded ? Math.min(start + DEFAULT_CAPTION_SEC, durationSec) : start + DEFAULT_CAPTION_SEC;
        start = Math.max(0, end - maxLen);
        if (end - start < MIN_CAPTION_SEC - 1e-9) return { ok: false, reason: 'no-room' };
    }

    // Shrink into the live gap around the requested span (single pass,
    // order-independent): the nearest live word ENDING inside pushes our
    // start right; the nearest live word STARTING inside pulls our end
    // left; a word fully CONTAINING the span leaves no gap at all.
    // Deleted words' timings no longer block (the renderer skips them).
    let prevEnd = null, nextStart = null;
    for (const w of words) {
        if (!w || w.deleted) continue;
        const ws = Number.isFinite(w.start) ? w.start : null;
        const we = Number.isFinite(w.end) ? w.end : null;
        if (ws === null || we === null) continue;
        if (ws < start && we > end) return { ok: false, reason: 'no-room' };
        if (we > start && we <= end) prevEnd = prevEnd === null ? we : Math.max(prevEnd, we);
        if (ws >= start && ws < end) nextStart = nextStart === null ? ws : Math.min(nextStart, ws);
    }
    let shrunk = false;
    if (prevEnd !== null) { start = prevEnd; shrunk = true; }
    if (nextStart !== null) { end = nextStart; shrunk = true; }
    if (end - start < MIN_CAPTION_SEC) return { ok: false, reason: 'no-room' };

    let index = 0;
    for (const w of words) {
        const ws = w && Number.isFinite(w.start) ? w.start : Infinity;
        if (ws <= start) index++;
    }

    const word = {
        id: nextWordId(words),
        text,
        start, end,
        deleted: false,
        userAdjusted: true,   // created by the user ⇒ CTC never moves it
        estimated: false,
        origStart: start,     // baseline = its own span ⇒ never "modified"
        origEnd: end,
    };
    return { ok: true, word, index, shrunk };
}
