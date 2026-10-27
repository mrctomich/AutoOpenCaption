/**
 * TimelineView — DOM/canvas glue for the timeline dock (Phase 2).
 *
 * One DPR-aware canvas with three bands: ruler, waveform, caption lanes
 * (lanes are placeholders until Phase 3 draws caption boxes). Owns the
 * viewport (from timeline-model.js), the pointer/wheel state machine and a
 * dirty-flag rAF redraw. It NEVER stores timestamps: playback position is
 * pushed in via setTime() from the app's preview loop, and user seeks go
 * out through the onSeek callback — one writer per direction (design rule).
 *
 * Interaction map (design doc):
 *   wheel                → horizontal scroll
 *   ctrl+wheel           → zoom at cursor
 *   drag ruler           → pan
 *   click ruler          → seek
 *   drag waveform/lane   → scrub (continuous seek)
 * Dock height + collapsed state persist to localStorage (Q2 decision).
 */

import {
    createViewport, zoomAtAnchor, panByPixels, fitViewport, scrollToTime,
    timeToX, xToTime, pickRulerStep, rulerTicks, formatRulerTime,
} from './timeline-model.js';
import { columnsFromPeaks } from './waveform.js';

const STORAGE_KEY = '***';
const RULER_H = 22;
const LANE_H = 46;           // caption-lane placeholder band (Phase 3 fills it)
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
     */
    constructor(container, canvas, { onSeek = () => {} } = {}) {
        this.container = container;
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.onSeek = onSeek;

        this.viewport = createViewport({ durationSec: 0, viewWidthPx: 0 });
        this.peaks = null;
        this.playheadTime = 0;
        this.needsRedraw = false;
        this._raf = 0;

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
        if (Number.isFinite(t)) this.playheadTime = t;
        const el = this.container.querySelector('#timeline-time');
        if (el) el.textContent = this._formatClock(this.playheadTime);
        this.invalidate();
    }

    /** Keep `t` on screen (auto-follow hook; no seek). */
    followTime(t) {
        this.viewport = scrollToTime(this.viewport, t);
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

    _bandFor(y) {
        const h = this.canvas.clientHeight;
        if (y <= RULER_H) return 'ruler';
        if (y >= h - LANE_H) return 'lane';
        return 'wave';
    }

    _bindPointer() {
        const c = this.canvas;
        c.style.touchAction = 'none';
        let mode = null; // 'pan' | 'scrub' | 'ruler'
        let startX = 0, startView = 0, moved = false;

        c.addEventListener('pointerdown', (e) => {
            if (this.viewport.durationSec <= 0) return;
            e.preventDefault();
            c.setPointerCapture(e.pointerId);
            const r = c.getBoundingClientRect();
            const x = e.clientX - r.left;
            startX = e.clientX;
            mode = this._bandFor(e.clientY - r.top) === 'ruler' ? 'ruler' : 'scrub';
            startView = this.viewport.viewStartSec;
            moved = false;
            if (mode === 'scrub') this.onSeek(Math.min(Math.max(xToTime(this.viewport, x), 0), this.viewport.durationSec));
        });

        c.addEventListener('pointermove', (e) => {
            if (!mode) return;
            const dx = e.clientX - startX;
            if (Math.abs(dx) > 3) moved = true;
            if (mode === 'ruler' && moved) {
                this.viewport = { ...this.viewport, viewStartSec: startView };
                this.viewport = panByPixels(this.viewport, dx);
            } else if (mode === 'scrub') {
                const r = c.getBoundingClientRect();
                const x = e.clientX - r.left;
                this.onSeek(Math.min(Math.max(xToTime(this.viewport, x), 0), this.viewport.durationSec));
            }
        });

        const end = (e) => {
            if (!mode) return;
            const r = c.getBoundingClientRect();
            const x = e.clientX - r.left;
            if (mode === 'ruler' && !moved) {
                this.onSeek(Math.min(Math.max(xToTime(this.viewport, x), 0), this.viewport.durationSec));
            }
            mode = null;
        };
        c.addEventListener('pointerup', end);
        c.addEventListener('pointercancel', () => { mode = null; });
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

        const wfTop = RULER_H + 2;
        const wfH = Math.max(30, h - RULER_H - LANE_H - 6);
        const laneTop = h - LANE_H;

        this._drawWaveform(w, wfTop, wfH);
        this._drawLanes(w, laneTop, LANE_H);
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
        const ctx = this.ctx;
        ctx.fillStyle = this.colors.raised;
        ctx.fillRect(0, top, w, height);
        ctx.strokeStyle = this.colors.border;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, top + 0.5); ctx.lineTo(w, top + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = this.colors.muted;
        ctx.font = '11px var(--font-sans, sans-serif)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('Caption lanes — boxes arrive in Phase 3', 8, top + height / 2);
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
