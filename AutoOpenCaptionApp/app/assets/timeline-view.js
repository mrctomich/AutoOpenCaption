/**
 * TimelineView — DOM/canvas glue for the timeline dock (Phases 2–3).
 *
 * One DPR-aware canvas with three bands: ruler, waveform, caption lanes
 * (Phase 3 draws real caption boxes from App.captionGroups). Owns the
 * viewport (from timeline-model.js), the pointer/wheel state machine and a
 * dirty-flag rAF redraw. It NEVER stores timestamps: playback position is
 * pushed in via setTime() from the app's preview loop, caption data is
 * pulled per-draw through getGroups(), and user seeks go out through the
 * onSeek callback — one writer per direction (design rule).
 *
 * Interaction map (design doc):
 *   wheel                → horizontal scroll
 *   ctrl+wheel           → zoom at cursor
 *   drag ruler           → pan
 *   click ruler          → seek
 *   drag waveform        → scrub (continuous seek)
 *   click caption box    → select first word (NO seek)
 *   dbl-click box / Enter→ seek to group start
 *   drag box / drag empty lane → pan (scrub once released off a box)
 *   hover box body/edge  → move / ew-resize cursor (Phase 4b)
 *   word sub-boxes       → per-word outlines inside caption boxes at
 *                          pps ≥ WORD_SUB_PPS (Phase 4b, display only)
 *   drag ghost           → beginGhost/moveGhost/cancelGhost render the
 *                          clamped proposed edit WITHOUT touching data
 *                          (Phase 4b; the pointer FSM drives it in Phase 4c,
 *                          the App commits through the same model fns in 4d)
 * Dock height + collapsed state persist to localStorage (Q2 decision).
 */

import {
    createViewport, zoomAtAnchor, panByPixels, fitViewport, scrollToTime,
    timeToX, xToTime, pickRulerStep, rulerTicks, formatRulerTime,
    groupBoxes, packLanes, hitTestBoxes, frameSpan, MIN_BOX_PX, boxRect,
    grabZone, editBounds, editBoundsForGroup, clampDelta,
    wordBoxes, WORD_SUB_PPS, applyGestureDelta,
} from './timeline-model.js';
import { columnsFromPeaks } from './waveform.js';

const STORAGE_KEY = '***';
const RULER_H = 22;
const LANE_H = 22;           // one caption lane row
const LANE_MIN_H = 24;       // lane strip when there are no lanes to show
const MIN_HEIGHT = 130;
const MAX_HEIGHT_FRAC = 0.6; // of window height

function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; }
    catch { return {}; }
}
function savePrefs(prefs) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* private mode etc. */ }
}

export class TimelineView {
    /**
     * @param container  #timeline-dock element
     * @param canvas     #timeline-canvas element
     * @param onSeek     (timeSec) => void — user-initiated seek (ruler click, scrub)
     * @param getGroups  () => CaptionGroup[] — live caption groups (App.captionGroups)
     * @param getAllWords () => Word[] — live transcript word array (Phase 4:
     *                   word sub-boxes, gesture bounds, ghost proposals)
     * @param onSelectGroup ({ groupIndex, word, seek, toggle }) => void — box click
     */
    constructor(container, canvas, { onSeek = () => {}, getGroups = () => [], getAllWords = () => [], onSelectGroup = () => {} } = {}) {
        this.container = container;
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.onSeek = onSeek;
        this.getGroups = getGroups;
        this.getAllWords = getAllWords;
        this.onSelectGroup = onSelectGroup;

        this.viewport = createViewport({ durationSec: 0, viewWidthPx: 0 });
        this.peaks = null;
        this.playheadTime = 0;
        this.needsRedraw = false;
        this._raf = 0;

        // Selection is pushed IN (editor ⇄ timeline sync lives in App);
        // the view only renders it and reports clicks out.
        this.selectedGroupIndex = -1;
        // Lane geometry recomputed each draw, kept for hit-testing.
        this._laneBoxes = [];
        this._laneOf = [];
        this._laneTop = 0;

        // In-flight drag ghost (Phase 4b): { gesture, bounds, delta, lane }.
        // Rendering state ONLY — no timestamps live here; the proposal is
        // recomputed from live word data every frame.
        this._ghost = null;
        this._dragging = false; // suppresses hover-cursor while a drag is active

        this.colors = null;
        this._readColors();
        new MutationObserver(() => { this._readColors(); this.invalidate(); })
            .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

        // ── prefs: height / collapsed (Q2: persist to localStorage) ──
        const prefs = loadPrefs();
        this.collapsed = !!prefs.collapsed;
        const height = Math.min(Math.max(prefs.height || 180, MIN_HEIGHT),
                                Math.floor(window.innerHeight * MAX_HEIGHT_FRAC));
        container.style.height = `${height}px`;
        this._applyCollapsed();

        this._bindToolbar();
        this._bindResizer();
        this._bindPointer();
        this._bindWheel();

        this._measure();
        this._ro = new ResizeObserver(() => this._measure());
        this._ro.observe(container);
    }

    // ── Public API ──────────────────────────────────────────────

    /** Video duration changed. First non-zero duration auto-fits. */
    setDuration(d) {
        const wasEmpty = this.viewport.durationSec <= 0;
        this.viewport.durationSec = Math.max(0, Number.isFinite(d) ? d : 0);
        if (this.viewport.durationSec === 0) {
            this.viewport.pps = 0;
            this.viewport.viewStartSec = 0;
        } else if (wasEmpty) {
            this.fit();
        }
        this.invalidate();
    }

    /** Push the latest peak snapshot (or null to clear, e.g. new video). */
    setPeaks(peaks) {
        this.peaks = peaks && peaks.count > 0 ? peaks : null;
        this.invalidate();
    }

    /** Push playback position (called from the preview loop / seeked). */
    setTime(t) {
        if (!Number.isFinite(t) || t === this.playheadTime) return;
        this.playheadTime = t;
        const el = this.container.querySelector('#timeline-time');
        if (el) el.textContent = this._formatClock(t);
        this.invalidate();
    }

    /** Push the editor's selected word: highlight its caption box. -1 = none. */
    setSelectedWord(wordId) {
        const next = wordId == null ? -1
            : this.getGroups().findIndex(g => g.words && g.words.some(w => w.id === wordId));
        if (next === this.selectedGroupIndex) return;
        this.selectedGroupIndex = next;
        this.invalidate();
    }

    /** Zoom-to-selection: frame the selected caption (or playhead if none). */
    zoomToSelected() {
        const g = this.getGroups()[this.selectedGroupIndex];
        if (g) {
            this.viewport = frameSpan(this.viewport, g.start, g.end);
        } else {
            this.viewport = frameSpan(this.viewport, this.playheadTime, this.playheadTime);
        }
        this.invalidate();
    }

    /** Keep `t` on screen (auto-follow hook; no seek). */
    followTime(t) {
        this.viewport = scrollToTime(this.viewport, t);
        this.invalidate();
    }

    // ── Drag ghost (Phase 4b) ───────────────────────────────────
    // Rendering-only preview of an in-flight timing gesture. The pointer FSM
    // (Phase 4c) drives begin/move/cancel; the App commits through the same
    // model functions, so the ghost always equals the commit. NO word data is
    // ever touched here (gesture protocol: pointerdown → ghost, pointerup →
    // saveState + commit, no per-move writes).

    /** @returns {boolean} true when a grabbable ghost was started. */
    beginGhost(gesture, groupIndex = -1) {
        const allWords = this.getAllWords() || [];
        const box = this._laneBoxes.find(b => b.index === groupIndex);
        const wordIndexes = gesture.kind.startsWith('group-')
            ? (box && box.wordIndex) || []
            : [gesture.wordIndex];
        const bounds = gesture.kind === 'group-move' || gesture.kind === 'group-resize'
            ? editBoundsForGroup(gesture, allWords,
                                 (box && box.group && box.group.words) || [],
                                 wordIndexes, this.viewport.durationSec)
            : editBounds(gesture, allWords, this.viewport.durationSec);
        // Inverted bounds (already-invalid stored data) are fine here:
        // clampDelta pins to `hi`, so the ghost simply cannot make it worse.
        const involved = [...applyGestureDelta(gesture, allWords, wordIndexes, 0).keys()];
        if (!involved.length) return false;
        this._ghost = {
            gesture, groupIndex, wordIndexes, bounds,
            involved,
            // Ghost rides the grabbed box's lane; word gestures fall back to
            // their group's lane (wordIndex → box lookup below).
            lane: (() => {
                const b = box || this._laneBoxes.find(
                    lb => lb.wordIndex && lb.wordIndex.includes(gesture.wordIndex));
                return b ? (this._laneOf[b.index] || 0) : 0;
            })(),
            delta: 0,
            proposal: applyGestureDelta(gesture, allWords, wordIndexes, 0),
        };
        this.invalidate();
        return true;
    }

    /** Update with a RAW pixel delta (px right = later); clamps to bounds. */
    moveGhost(dxPx) {
        if (!this._ghost) return null;
        const raw = dxPx / (this.viewport.pps || 1);
        const delta = clampDelta(raw, this._ghost.bounds);
        if (delta === this._ghost.delta) return delta;
        this._ghost.delta = delta;
        // Recompute from LIVE word data (never from a cached snapshot): the
        // funnel only commits on release, so words cannot move mid-drag, but
        // this keeps the proposal honest under any future re-entrancy.
        this._ghost.proposal = applyGestureDelta(
            this._ghost.gesture, this.getAllWords() || [], this._ghost.wordIndexes, delta);
        this.invalidate();
        return delta;
    }

    /** Final clamped delta (what a commit would apply), then clear the ghost. */
    endGhost() {
        const g = this._ghost;
        this._ghost = null;
        this.invalidate();
        return g ? g.delta : null;
    }

    /** Abort without committing. */
    cancelGhost() {
        this._ghost = null;
        this.invalidate();
    }

    fit() {
        this.viewport = fitViewport(this.viewport);
        this.invalidate();
    }

    zoomBy(factor, anchorX = null) {
        const ax = anchorX === null ? this._cssWidth() / 2 : anchorX;
        this.viewport = zoomAtAnchor(this.viewport, ax, factor);
        this.invalidate();
    }

    invalidate() {
        if (this.needsRedraw || this.collapsed) return;
        this.needsRedraw = true;
        this._raf = requestAnimationFrame(() => {
            this.needsRedraw = false;
            this._draw();
        });
    }

    destroy() {
        this._ro?.disconnect();
        cancelAnimationFrame(this._raf);
    }

    // ── Internals ───────────────────────────────────────────────

    _cssWidth() { return this.canvas.clientWidth || 0; }

    _measure() {
        const dpr = window.devicePixelRatio || 1;
        const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
        if (w <= 0 || h <= 0) return; // collapsed / hidden
        const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
        if (this.canvas.width !== bw || this.canvas.height !== bh) {
            this.canvas.width = bw;
            this.canvas.height = bh;
        }
        this.viewport.viewWidthPx = w;
        if (this.viewport.durationSec > 0 && this.viewport.pps === 0) this.fit();
        this.invalidate();
    }

    _readColors() {
        const cs = getComputedStyle(document.documentElement);
        const v = (name, fallback) => (cs.getPropertyValue(name) || fallback).trim();
        this.colors = {
            panel: v('--bg-panel', '#fff'),
            raised: v('--bg-panel-raised', '#f4f2ff'),
            border: v('--border', '#e3e5ea'),
            muted: v('--text-muted', '#8c94a3'),
            text: v('--text-primary', '#14171f'),
            accent: v('--accent', '#7c3aed'),
            danger: v('--danger', '#dc2626'),
        };
    }

    _formatClock(t) {
        const m = Math.floor(t / 60);
        const s = t - m * 60;
        return `${m}:${s.toFixed(1).padStart(4, '0')}`;
    }

    _applyCollapsed() {
        this.container.classList.toggle('collapsed', this.collapsed);
        const btn = this.container.querySelector('#btn-tl-collapse');
        if (btn) btn.textContent = this.collapsed ? '▸' : '▾';
    }

    _bindToolbar() {
        const q = (id) => this.container.querySelector('#' + id);
        q('btn-tl-zoom-in')?.addEventListener('click', () => this.zoomBy(1.6));
        q('btn-tl-zoom-out')?.addEventListener('click', () => this.zoomBy(1 / 1.6));
        q('btn-tl-zoom-fit')?.addEventListener('click', () => this.fit());
        q('btn-tl-zoom-sel')?.addEventListener('click', () => this.zoomToSelected());
        q('btn-tl-collapse')?.addEventListener('click', () => {
            this.collapsed = !this.collapsed;
            this._applyCollapsed();
            const prefs = loadPrefs();
            prefs.collapsed = this.collapsed;
            savePrefs(prefs);
            if (!this.collapsed) this._measure();
        });
    }

    _bindResizer() {
        const resizer = this.container.querySelector('#timeline-resizer');
        if (!resizer) return;
        let startY = 0, startH = 0;
        const onMove = (e) => {
            const max = Math.floor(window.innerHeight * MAX_HEIGHT_FRAC);
            const h = Math.min(Math.max(MIN_HEIGHT, startH + (startY - e.clientY)), max);
            this.container.style.height = `${h}px`; // grows upward: dock is below main
        };
        const onUp = () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            const prefs = loadPrefs();
            prefs.height = parseInt(this.container.style.height, 10);
            savePrefs(prefs);
        };
        resizer.addEventListener('pointerdown', (e) => {
            if (this.collapsed) return;
            e.preventDefault();
            startY = e.clientY;
            startH = this.container.getBoundingClientRect().height;
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.body.style.cursor = 'row-resize';
            document.body.style.userSelect = 'none';
        });
    }

    /** Height of the caption-lane strip for the current lane count. */
    _laneStripH(laneCount) {
        return Math.max(LANE_MIN_H, laneCount * LANE_H + 4);
    }

    /**
     * Recompute caption boxes + lane packing for the current viewport.
     * Called once per draw and before hit-testing; results cached on the
     * instance (boxes derive from the live groups — never stored timestamps).
     */
    _refreshLanes(h) {
        const groups = (this.getGroups() && this.getGroups()) || [];
        // allWords enables the per-group wordIndex mapping (Phase 4 edits).
        this._laneBoxes = groupBoxes(this.viewport, groups, this.getAllWords() || []);
        const { laneOf, laneCount } = packLanes(this._laneBoxes);
        this._laneOf = laneOf;
        // Cap the strip so the waveform keeps a usable minimum height;
        // boxes in hidden lanes simply pack down into fewer visible rows.
        const maxStrip = Math.max(LANE_MIN_H, h - RULER_H - 6 - 30);
        const stripH = Math.min(this._laneStripH(laneCount), maxStrip);
        this._laneTop = h - stripH;
        return stripH;
    }

    _bindPointer() {
        const c = this.canvas;
        c.style.touchAction = 'none';
        let mode = null;     // 'ruler' | 'box' | 'lane-empty' | 'scrub'
        let startX = 0, startY = 0, startView = 0, moved = false;
        let hitIndex = null; // box index under pointerdown (lane band)

        const seekAt = (x) => this.onSeek(
            Math.min(Math.max(xToTime(this.viewport, x), 0), this.viewport.durationSec));

        c.addEventListener('pointerdown', (e) => {
            if (this.viewport.durationSec <= 0) return;
            e.preventDefault();
            c.setPointerCapture(e.pointerId);
            const r = c.getBoundingClientRect();
            const x = e.clientX - r.left;
            const y = e.clientY - r.top;
            startX = e.clientX; startY = e.clientY;
            startView = this.viewport.viewStartSec;
            moved = false;
            hitIndex = null;

            if (y <= RULER_H) {
                mode = 'ruler';
            } else if (y >= this._laneTop) {
                // Lane band: resolve the box under the cursor against the
                // last drawn frame's geometry (lanes are cheap to re-pack).
                this._refreshLanes(c.clientHeight);
                hitIndex = hitTestBoxes(this._laneBoxes, this._laneOf, x, y,
                                        this._laneTop, LANE_H);
                mode = hitIndex != null ? 'box' : 'lane-empty';
            } else {
                mode = 'scrub';
                seekAt(x); // waveform scrub is immediate, like the old dock
            }
        });

        c.addEventListener('pointermove', (e) => {
            if (!mode) {
                // Hover affordances (Phase 4b): caption-box edges show the
                // resize cursor, box bodies the move cursor. Purely visual —
                // the grab itself lands with the pointer FSM (Phase 4c).
                if (this._dragging) return;
                const r = c.getBoundingClientRect();
                const hx = e.clientX - r.left, hy = e.clientY - r.top;
                let cursor = '';
                if (this.viewport.durationSec > 0 && hy >= this._laneTop) {
                    this._refreshLanes(c.clientHeight);
                    const ix = hitTestBoxes(this._laneBoxes, this._laneOf,
                                            hx, hy, this._laneTop, LANE_H);
                    if (ix != null) {
                        const b = this._laneBoxes[ix];
                        cursor = grabZone(hx - b.x, b.w) === 'body' ? 'move' : 'ew-resize';
                    }
                }
                if (c.style.cursor !== cursor) c.style.cursor = cursor;
                return;
            }
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
            if (!moved) return;
            if (mode === 'scrub') {
                const r = c.getBoundingClientRect();
                seekAt(e.clientX - r.left);
            } else {
                // ruler drag, box drag, empty-lane drag → pan
                this.viewport = { ...this.viewport, viewStartSec: startView };
                this.viewport = panByPixels(this.viewport, dx);
                this.invalidate();
            }
        });

        const end = (e) => {
            if (!mode) return;
            const r = c.getBoundingClientRect();
            const x = e.clientX - r.left;
            if (!moved) {
                if (mode === 'ruler') {
                    seekAt(x);
                } else if (mode === 'box') {
                    const box = this._laneBoxes[hitIndex];
                    if (box) {
                        // Select WITHOUT seeking (design: click selects,
                        // dbl-click / Enter seeks). Shift toggles.
                        this.onSelectGroup({
                            groupIndex: box.index,
                            word: box.word,
                            seek: false,
                            toggle: e.shiftKey,
                        });
                    }
                } else if (mode === 'lane-empty') {
                    seekAt(x);
                }
            }
            mode = null;
            hitIndex = null;
        };
        c.addEventListener('pointerup', end);
        c.addEventListener('pointercancel', () => { mode = null; hitIndex = null; });

        // Double-click a caption box → seek to the group start (existing
        // selectWord seek semantics, applied by the App callback).
        c.addEventListener('dblclick', (e) => {
            if (this.viewport.durationSec <= 0) return;
            const r = c.getBoundingClientRect();
            const x = e.clientX - r.left;
            const y = e.clientY - r.top;
            if (y < this._laneTop) return;
            const i = hitTestBoxes(this._laneBoxes, this._laneOf, x, y,
                                   this._laneTop, LANE_H);
            if (i != null && this._laneBoxes[i]) {
                this.onSelectGroup({
                    groupIndex: i,
                    word: this._laneBoxes[i].word,
                    seek: true,
                    toggle: false,
                });
            }
        });

        // Keyboard parity for the above: with the canvas focused, Enter seeks
        // to the selected group's start (or the playhead when nothing is
        // selected). The canvas is focusable (tabindex) but takes no other
        // keys — global shortcuts (Ctrl+Z, Delete, …) still reach the app.
        c.setAttribute('tabindex', '0');
        c.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || this.viewport.durationSec <= 0) return;
            e.preventDefault();
            const g = this.getGroups()[this.selectedGroupIndex];
            if (g) {
                this.onSelectGroup({
                    groupIndex: this.selectedGroupIndex,
                    word: (g.words && g.words[0]) || null,
                    seek: true,
                    toggle: false,
                });
            } else {
                this.onSeek(this.playheadTime);
            }
        });
    }

    _bindWheel() {
        this.canvas.addEventListener('wheel', (e) => {
            if (this.viewport.durationSec <= 0) return;
            e.preventDefault();
            const r = this.canvas.getBoundingClientRect();
            const x = e.clientX - r.left;
            if (e.ctrlKey || e.metaKey) {
                this.viewport = zoomAtAnchor(this.viewport, x, Math.exp(-e.deltaY * 0.0015));
            } else {
                const dx = (e.deltaX !== 0 ? e.deltaX : e.deltaY) * (e.deltaMode === 1 ? 16 : 1);
                this.viewport = panByPixels(this.viewport, dx);
            }
            this.invalidate();
        }, { passive: false });
    }

    // ── Drawing ─────────────────────────────────────────────────

    _draw() {
        const ctx = this.ctx;
        const dpr = window.devicePixelRatio || 1;
        const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
        if (w <= 0 || h <= 0) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const vp = this.viewport;
        if (vp.durationSec <= 0) {
            ctx.fillStyle = this.colors.muted;
            ctx.font = '12px var(--font-sans, sans-serif)';
            ctx.textAlign = 'center';
            ctx.fillText('Load a video to use the timeline', w / 2, h / 2);
            return;
        }

        const stripH = this._refreshLanes(h);
        const wfTop = RULER_H + 2;
        const wfH = Math.max(30, h - RULER_H - stripH - 6);

        this._drawWaveform(w, wfTop, wfH);
        this._drawLanes(w, this._laneTop, stripH);
        this._drawGhost(w, this._laneTop);
        this._drawRuler(w);
        this._drawPlayhead(w, h);
    }

    _drawRuler(w) {
        const ctx = this.ctx, vp = this.viewport;
        const step = pickRulerStep(vp.pps);
        const { majors, minors } = rulerTicks(vp, step);

        ctx.fillStyle = this.colors.raised;
        ctx.fillRect(0, 0, w, RULER_H);
        ctx.strokeStyle = this.colors.border;
        ctx.beginPath();
        ctx.moveTo(0, RULER_H + 0.5); ctx.lineTo(w, RULER_H + 0.5);
        ctx.stroke();

        ctx.strokeStyle = this.colors.muted;
        ctx.beginPath();
        for (const t of minors) {
            const x = Math.round(timeToX(vp, t)) + 0.5;
            ctx.moveTo(x, RULER_H - 5); ctx.lineTo(x, RULER_H);
        }
        ctx.stroke();

        ctx.fillStyle = this.colors.text;
        ctx.font = '10px var(--font-mono, monospace)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        for (const t of majors) {
            const x = timeToX(vp, t);
            ctx.strokeStyle = this.colors.muted;
            ctx.beginPath();
            ctx.moveTo(Math.round(x) + 0.5, RULER_H - 10);
            ctx.lineTo(Math.round(x) + 0.5, RULER_H);
            ctx.stroke();
            const label = formatRulerTime(t, step);
            const lx = Math.min(Math.max(x + 4, 2), w - 46);
            ctx.fillText(label, lx, 8);
        }
    }

    _drawWaveform(w, top, height) {
        const ctx = this.ctx, vp = this.viewport;
        const mid = top + height / 2;

        ctx.fillStyle = this.colors.panel;
        ctx.fillRect(0, top - 2, w, height + 4);

        if (!this.peaks) {
            ctx.fillStyle = this.colors.muted;
            ctx.font = '11px var(--font-sans, sans-serif)';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Waveform appears after transcription', w / 2, mid);
            return;
        }

        const { data, columns } = columnsFromPeaks(this.peaks, vp, w);
        ctx.strokeStyle = this.colors.accent;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        for (let c = 0; c < columns; c++) {
            const lo = data[c * 2], hi = data[c * 2 + 1];
            if (lo === 0 && hi === 0) continue;
            const y0 = mid - hi * (height / 2);
            const y1 = mid - lo * (height / 2);
            ctx.moveTo(c + 0.5, y0);
            ctx.lineTo(c + 0.5, Math.max(y1, y0 + 1));
        }
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Dim the not-yet-built tail while peaks are still building.
        const fullBuiltPx = timeToX(vp, peaksFullDurationSec(this.peaks));
        if (fullBuiltPx < w - 1) {
            ctx.fillStyle = this.colors.raised;
            ctx.globalAlpha = 0.6;
            ctx.fillRect(Math.max(0, fullBuiltPx), top - 2, w - Math.max(0, fullBuiltPx), height + 4);
            ctx.globalAlpha = 1;
        }
    }

    _drawLanes(w, top, height) {
        const ctx = this.ctx, vp = this.viewport;
        ctx.fillStyle = this.colors.raised;
        ctx.fillRect(0, top, w, height);
        ctx.strokeStyle = this.colors.border;
        ctx.beginPath();
        ctx.moveTo(0, top + 0.5); ctx.lineTo(w, top + 0.5);
        ctx.stroke();

        const boxes = this._laneBoxes;
        if (!boxes.length) {
            ctx.fillStyle = this.colors.muted;
            ctx.font = '11px var(--font-sans, sans-serif)';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText('Caption lanes are empty — transcribe to fill them',
                         8, top + height / 2);
            return;
        }

        for (let i = 0; i < boxes.length; i++) {
            const b = boxes[i];
            const lane = this._laneOf[i];
            if (b.x > w || b.x + b.w < 0) continue;
            const y = top + lane * LANE_H + 3;
            const bh = LANE_H - 6;
            const selected = i === this.selectedGroupIndex;

            // Box fill — selected uses the accent, like the editor chip.
            ctx.fillStyle = this.colors.accent;
            ctx.globalAlpha = selected ? 0.55 : 0.16;
            this._roundRect(ctx, b.x, y, b.w, bh, 3);
            ctx.fill();
            ctx.globalAlpha = 1;

            // Border; degenerate (zero/near-zero duration) cues get a dashed
            // warning outline so they stay visible AND recognizable (R6).
            ctx.strokeStyle = selected ? this.colors.accent
                : (b.degenerate ? this.colors.danger : this.colors.muted);
            if (b.degenerate) ctx.setLineDash([3, 2]);
            this._roundRect(ctx, b.x, y, b.w, bh, 3);
            ctx.stroke();
            ctx.setLineDash([]);

            // Word sub-boxes at high zoom (Phase 4b): per-word outlines so
            // the user sees exactly which word an edit will grab. Display
            // only — sub-boxes are visual; word-level grabbing lands with
            // the pointer FSM (Phase 4c).
            const words = b.group.words;
            if (vp.pps >= WORD_SUB_PPS && words && words.length) {
                const subs = wordBoxes(vp, words);
                ctx.strokeStyle = selected ? this.colors.accent : this.colors.muted;
                ctx.globalAlpha = 0.9;
                for (const s of subs) {
                    // Clamp sub-boxes into the parent box: the group `end`
                    // carries the renderer's ≥0.1 s display clamp, so the
                    // last word can extend past the visual box edge.
                    const sx = Math.max(s.x, b.x);
                    const sr = Math.min(s.x + s.w, b.x + b.w);
                    if (sr - sx < 1) continue;
                    this._roundRect(ctx, sx, y + 1.5, sr - sx, bh - 3, 2);
                    ctx.stroke();
                    if (sr - sx >= 24 && s.word.text) {
                        ctx.save();
                        this._roundRect(ctx, sx, y + 1.5, sr - sx, bh - 3, 2);
                        ctx.clip();
                        ctx.fillStyle = selected ? this.colors.text : this.colors.muted;
                        ctx.font = '9px var(--font-sans, sans-serif)';
                        ctx.textAlign = 'left';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(s.word.text, sx + 3, y + bh / 2, sr - sx - 5);
                        ctx.restore();
                    }
                }
                ctx.globalAlpha = 1;
                continue; // word labels replace the group label at this zoom
            }

            // Text label when the box is wide enough to fit ~3+ glyphs.
            if (b.w >= 28 && b.group.text) {
                ctx.save();
                this._roundRect(ctx, b.x, y, b.w, bh, 3);
                ctx.clip();
                ctx.fillStyle = selected ? this.colors.text : this.colors.muted;
                ctx.font = '10px var(--font-sans, sans-serif)';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(b.group.text, b.x + 5, y + bh / 2, b.w - 8);
                ctx.restore();
            }
        }
    }

    /**
     * Draw the in-flight ghost (Phase 4b). Renders the CLAMPED proposal from
     * applyGestureDelta — exactly what a commit at this pointer position would
     * produce — as a solid accent box on the grabbed lane, with the original
     * span shown dashed for reference. Pure rendering: reads _ghost only.
     */
    _drawGhost(w, top) {
        const g = this._ghost;
        if (!g) return;
        const ctx = this.ctx, vp = this.viewport;
        const y = top + g.lane * LANE_H + 3;
        const bh = LANE_H - 6;

        // Union span of the proposal + per-word proposed rects.
        let uStart = Infinity, uEnd = -Infinity;
        const rects = [];
        for (const ix of g.involved) {
            const p = g.proposal.get(ix);
            if (!p) continue;
            const r = boxRect(vp, p.start, p.end);
            rects.push(r);
            uStart = Math.min(uStart, p.start);
            uEnd = Math.max(uEnd, p.end);
        }
        if (!rects.length || !(uEnd > uStart)) return;

        const ux = boxRect(vp, uStart, uEnd);

        // Original span, dashed muted — shows where the edit came from.
        const box = this._laneBoxes.find(b => b.index === g.groupIndex);
        if (box) {
            ctx.strokeStyle = this.colors.muted;
            ctx.globalAlpha = 0.6;
            ctx.setLineDash([3, 3]);
            this._roundRect(ctx, box.x, y, Math.max(box.w, MIN_BOX_PX), bh, 3);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 1;
        }

        // Proposed union: translucent accent fill + solid outline.
        ctx.fillStyle = this.colors.accent;
        ctx.globalAlpha = 0.35;
        this._roundRect(ctx, ux.x, y, Math.max(ux.w, MIN_BOX_PX), bh, 3);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = this.colors.accent;
        this._roundRect(ctx, ux.x, y, Math.max(ux.w, MIN_BOX_PX), bh, 3);
        ctx.stroke();

        // Per-word proposed sub-boxes at word-zoom (matches sub-box display).
        if (vp.pps >= WORD_SUB_PPS && rects.length > 1) {
            ctx.strokeStyle = this.colors.accent;
            ctx.globalAlpha = 0.8;
            for (const r of rects) {
                this._roundRect(ctx, r.x, y + 1.5, Math.max(r.w, 1), bh - 3, 2);
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
        }

        // Delta readout so the user sees the actual shift while dragging.
        if (Math.abs(g.delta) > 1e-6) {
            const label = `${g.delta > 0 ? '+' : '−'}${Math.abs(g.delta).toFixed(2)}s`;
            ctx.font = '10px var(--font-sans, sans-serif)';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            ctx.fillStyle = this.colors.accent;
            ctx.fillText(label, Math.min(Math.max(ux.x, 2), w - 40), y - 1);
        }
    }

    _roundRect(ctx, x, y, w, h, r) {
        const rr = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
        ctx.closePath();
    }

    _drawPlayhead(w, h) {
        const vp = this.viewport;
        if (!(vp.pps > 0)) return;
        const x = timeToX(vp, this.playheadTime);
        if (x < -6 || x > w + 6) return;
        const ctx = this.ctx;
        ctx.strokeStyle = this.colors.danger;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, RULER_H - 12);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.fillStyle = this.colors.danger;
        ctx.beginPath();
        ctx.moveTo(x - 5, RULER_H - 12);
        ctx.lineTo(x + 5, RULER_H - 12);
        ctx.lineTo(x, RULER_H - 4);
        ctx.closePath();
        ctx.fill();
    }
}

// Helper kept out of the class for testability parity: seconds covered by
// ALL fed samples (vs. only completed buckets).
function peaksFullDurationSec(peaks) {
    return peaks.builtSamples / peaks.sampleRate;
}
