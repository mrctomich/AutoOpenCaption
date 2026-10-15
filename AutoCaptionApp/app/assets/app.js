import { FFmpegService } from './ffmpeg-service.js';
import { whisperToTranscript } from './whisper-adapter.js';
import { groupWords, findGroupAtTime, computeLayout, drawGroup, drawDiagnostics } from './caption-renderer.js';

const waitForTransformers = () => new Promise((resolve) => {
    if (window.TransformersPipeline) {
        resolve();
    } else {
        window.addEventListener('transformers-loaded', resolve, { once: true });
    }
});

await waitForTransformers();

const pipeline = window.TransformersPipeline;
const env = window.TransformersEnv;

const fetchFile = async (input) => {
    if (input instanceof File || input instanceof Blob) {
        return new Uint8Array(await input.arrayBuffer());
    }
    if (typeof input === 'string') {
        const response = await fetch(input);
        return new Uint8Array(await response.arrayBuffer());
    }
    if (input instanceof URL) {
        const response = await fetch(input.href);
        return new Uint8Array(await response.arrayBuffer());
    }
    if (input instanceof ArrayBuffer) {
        return new Uint8Array(input);
    }
    throw new Error('Unsupported input type');
};

env.allowLocalModels = true;
env.allowRemoteModels = true;
// Bundled models ship in the zip under app/models/ (base model is included);
// transformers.js looks here first and falls back to the Hub for tiny/small.
env.localModelPath = 'models/';
env.backends.onnx.wasm.proxy = true;
// Serve ONNX Runtime WASM from the local vendor folder instead of the jsdelivr
// CDN, so transcription works in locked-down IT environments with no internet.
env.backends.onnx.wasm.wasmPaths = new URL('assets/', document.baseURI).href;

let whisperPipeline = null;
let loadedModelId = null;

// ── Status Manager ──────────────────────────────────────────
const Status = {
    _logEl: null,
    _latestEl: null,
    _expanded: false,

    init() {
        this._logEl = document.getElementById('status-log-expanded');
        this._latestEl = document.getElementById('status-bar-latest');
        this._latestEl.addEventListener('click', () => this.toggleLog());

        document.addEventListener('click', (e) => {
            if (this._expanded && !document.getElementById('status-bar').contains(e.target)) {
                this.collapseLog();
            }
        });
    },

    msg(text, type = 'info') {
        const now = new Date();
        const ts = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
        const icons = { success: '\u2713', info: '\u25CF', warning: '\u26A0', error: '\u2717', active: '' };

        this._latestEl.querySelector('.status-icon').className = `status-icon ${type}`;
        this._latestEl.querySelector('.status-icon').textContent = icons[type] || '\u25CF';
        this._latestEl.querySelector('.status-msg').textContent = text;

        const entry = document.createElement('div');
        entry.className = `status-entry ${type}`;
        entry.innerHTML = `<span class="status-time">${ts}</span><span class="status-icon">${icons[type] || '\u25CF'}</span><span class="status-msg">${text}</span>`;
        this._logEl.prepend(entry);

        console.log(`[Status:${type}] ${text}`);
        return entry;
    },

    setActive(text) {
        return this.msg(text, 'active');
    },

    clearActive() {
        const active = this._logEl.querySelectorAll('.status-entry.active');
        active.forEach(el => el.remove());
        this._latestEl.querySelector('.status-icon').className = 'status-icon';
        this._latestEl.querySelector('.status-icon').textContent = '';
    },

    success(text) { return this.msg(text, 'success'); },
    error(text) { return this.msg(text, 'error'); },
    warning(text) { return this.msg(text, 'warning'); },

    toggleLog() {
        this._expanded = !this._expanded;
        this._logEl.classList.toggle('open', this._expanded);
        this._latestEl.querySelector('.view-log-label').innerHTML = this._expanded
            ? 'Close log &#9652;'
            : 'View log &#9662;';
    },

    collapseLog() {
        this._expanded = false;
        this._logEl.classList.remove('open');
        this._latestEl.querySelector('.view-log-label').innerHTML = 'View log &#9662;';
    },
};

// ── Pipeline State ──────────────────────────────────────────
const Pipeline = {
    _steps: ['video', 'model', 'transcribe', 'edit', 'export'],
    _completed: new Set(),

    reset() {
        this._completed.clear();
        this._steps.forEach(s => {
            const el = document.getElementById(`step-${s}`);
            el.classList.remove('completed', 'active');
        });
    },

    complete(step) {
        this._completed.add(step);
        const el = document.getElementById(`step-${step}`);
        el.classList.remove('active');
        el.classList.add('completed');
        const idx = this._steps.indexOf(step);
        if (idx < this._steps.length - 1) {
            const nextEl = document.getElementById(`step-${this._steps[idx + 1]}`);
            if (!nextEl.classList.contains('completed')) {
                nextEl.classList.add('active');
            }
        }
    },

    activate(step) {
        const el = document.getElementById(`step-${step}`);
        if (!el.classList.contains('completed')) {
            el.classList.add('active');
        }
    },

    deactivate(step) {
        const el = document.getElementById(`step-${step}`);
        el.classList.remove('active');
    },

    undo(step) {
        this._completed.delete(step);
        const el = document.getElementById(`step-${step}`);
        el.classList.remove('completed');
    }
};

// ── Progress Overlay ────────────────────────────────────────
const Progress = {
    _overlay: null,
    _title: null,
    _status: null,
    _barContainer: null,
    _barFill: null,
    _pct: null,
    _elapsed: null,
    _spinner: null,
    _cancelBtn: null,
    _cancelCb: null,
    _startTime: 0,
    _timer: null,

    init() {
        this._overlay = document.getElementById('progress-overlay');
        this._title = document.getElementById('progress-title');
        this._status = document.getElementById('progress-status');
        this._barContainer = this._overlay.querySelector('.progress-bar-container');
        this._barFill = document.getElementById('progress-bar-fill');
        this._pct = document.getElementById('progress-pct');
        this._elapsed = document.getElementById('progress-elapsed');
        this._spinner = this._overlay.querySelector('.spinner');
        this._cancelBtn = document.getElementById('btn-cancel-progress');
        this._cancelBtn.addEventListener('click', () => {
            if (!this._cancelCb || this._cancelBtn.disabled) return;
            this._cancelBtn.disabled = true;
            this._cancelBtn.textContent = 'Cancelling...';
            this._cancelCb();
        });
    },

    _resetCancel() {
        this._cancelCb = null;
        this._cancelBtn.classList.add('hidden');
        this._cancelBtn.disabled = false;
        this._cancelBtn.textContent = 'Cancel';
    },

    show(title, status, onCancel = null) {
        this._title.textContent = title;
        this._status.textContent = status || '';
        this._barContainer.style.display = 'none';
        this._spinner.style.display = '';
        this._resetCancel();
        if (onCancel) {
            this._cancelCb = onCancel;
            this._cancelBtn.classList.remove('hidden');
        }
        this._overlay.classList.remove('hidden');
        this._startTime = performance.now();
        this._updateElapsed();
    },

    showProgress(title, status, onCancel = null) {
        this._title.textContent = title;
        this._status.textContent = status || '';
        this._barContainer.style.display = '';
        this._spinner.style.display = 'none';
        this._barFill.style.width = '0%';
        this._pct.textContent = '0%';
        this._resetCancel();
        if (onCancel) {
            this._cancelCb = onCancel;
            this._cancelBtn.classList.remove('hidden');
        }
        this._overlay.classList.remove('hidden');
        this._startTime = performance.now();
        this._updateElapsed();
    },

    update(pct, status) {
        this._barFill.style.width = `${pct}%`;
        this._pct.textContent = `${Math.round(pct)}%`;
        if (status) this._status.textContent = status;
        this._updateElapsed();
    },

    hide() {
        this._overlay.classList.add('hidden');
        this._resetCancel();
        if (this._timer) cancelAnimationFrame(this._timer);
    },

    _updateElapsed() {
        if (this._timer) cancelAnimationFrame(this._timer);
        const tick = () => {
            const elapsed = ((performance.now() - this._startTime) / 1000).toFixed(0);
            this._elapsed.textContent = `${elapsed}s elapsed`;
            if (!this._overlay.classList.contains('hidden')) {
                this._timer = requestAnimationFrame(tick);
            }
        };
        tick();
    }
};

// ── Model Status ────────────────────────────────────────────
const ModelStatus = {
    _el: null,

    init() { this._el = document.getElementById('model-status'); },

    set(state, text) {
        this._el.className = `model-status ${state}`;
        this._el.textContent = text || '';
    },

    clear() {
        this._el.className = 'model-status';
        this._el.textContent = '';
    }
};

// ── Main App ────────────────────────────────────────────────
const App = {
    video: null,
    canvas: null,
    ctx: null,
    transcript: null,
    videoFile: null,
    undoStack: [],
    redoStack: [],
    selectedWordIndex: -1,
    captionGroups: [],
    captionLayout: [],
    debugOverlay: false,
    transcriptMeta: {
        model: null,
        processingTime: null,
        audioSamples: null,
        audioDuration: null
    },
    style: {
        name: 'WhiteTxtBlueBox',
        font: 'Montserrat',
        mainSize: 72,
        activeSize: 72,
        textColor: '#FFFFFF',
        activeColor: '#FFFFFF',
        mainWeight: 'bold',
        activeWordBold: true,
        effects: {
            outline: { enabled: true, color: '#05050A', size: 13 },
            shadow: { enabled: false, color: '#000000', opacity: 100, direction: 45, distance: 2, softness: 5 },
            glow: { enabled: false, color: '#7C3AED', size: 5 }
        },
        activeBox: { enabled: true, color: '#005288', padding: 10, radius: 8 },
        grouping: { maxWords: 3, maxSeconds: 2.2, maxCharacters: 32 },
        position: { placement: 'lower-third', yPx: 780 }
    },

    async init() {
        this.video = document.getElementById('video-player');
        this.canvas = document.getElementById('caption-overlay');
        this.ctx = this.canvas.getContext('2d');

        Status.init();
        Progress.init();
        ModelStatus.init();
        Pipeline.reset();
        Status.success('Application ready');
        Status.msg('Press D to toggle debug overlay', 'info');

        try {
            await FFmpegService.init();
            this.ffmpegLoaded = true;
            Status.success('FFmpeg engine loaded');
        } catch (err) {
            Status.error('FFmpeg failed to load — export disabled');
            this.ffmpegLoaded = false;
        }

        this.bindEvents();
        this.bindRenderSettings();
        this.loadPresets();
        this.bindKeyboardShortcuts();
        this.bindInspectorControls();
        this.bindCenterResizer();
        this.updateModelStatus();
        this.updateThemeIcon();
        this.autoLoadDefaultModel();
    },

    bindEvents() {
        document.getElementById('btn-import').addEventListener('click', () => this.importVideo());
        document.getElementById('btn-transcribe').addEventListener('click', () => this.transcribe());
        document.getElementById('btn-transcribe-model').addEventListener('click', () => this.transcribe());
        document.getElementById('btn-play').addEventListener('click', () => this.togglePlay());
        document.getElementById('scrubber').addEventListener('input', (e) => this.scrub(e));
        document.getElementById('btn-export-srt').addEventListener('click', () => this.exportSRT());
        document.getElementById('btn-export-vtt').addEventListener('click', () => this.exportVTT());
        document.getElementById('btn-generate').addEventListener('click', () => this.generateVideo());
        document.getElementById('btn-download-model').addEventListener('click', () => this.downloadModel());
        document.getElementById('btn-theme-toggle').addEventListener('click', () => this.toggleTheme());
        document.getElementById('btn-toggle-diagnostics').addEventListener('click', () => {
            const panel = document.getElementById('panel-transcript-display');
            panel.classList.toggle('expanded');
            document.getElementById('diagnostics').classList.toggle('hidden');
        });
        document.getElementById('sel-model').addEventListener('change', () => this.updateModelStatus());

        document.getElementById('btn-load-preset').addEventListener('click', () => this.loadSelectedPreset());
        document.getElementById('btn-save-preset').addEventListener('click', () => this.savePreset());
        document.getElementById('btn-delete-preset').addEventListener('click', () => this.deletePreset());
        document.getElementById('btn-export-preset').addEventListener('click', () => this.exportPreset());
        document.getElementById('btn-import-preset').addEventListener('click', () => document.getElementById('file-preset').click());
        document.getElementById('file-preset').addEventListener('change', (e) => this.importPreset(e));

        this.video.addEventListener('timeupdate', () => this.updatePreview());
        this.video.addEventListener('loadedmetadata', () => this.onVideoLoaded());
        this.video.addEventListener('play', () => this.startPreviewLoop());
        this.video.addEventListener('pause', () => this.stopPreviewLoop());

        document.addEventListener('click', (e) => {
            const selector = document.getElementById('word-selector');
            const inspector = document.getElementById('word-inspector');
            if (!selector.contains(e.target) && !inspector.contains(e.target)) {
                this.selectWord(-1);
            }
        });

        const dropZone = document.getElementById('drop-zone');
        const videoContainer = document.querySelector('.video-container');

        videoContainer.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('hidden');
        });

        videoContainer.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!this.video.src) dropZone.classList.remove('hidden');
        });

        videoContainer.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const file = e.dataTransfer.files[0];
            if (file && file.type.startsWith('video/')) {
                this.loadVideo(file);
            }
        });

        dropZone.addEventListener('click', () => this.importVideo());
        this.bindStyleControls();
    },

    bindStyleControls() {
        const updateStyle = () => {
            this.style.font = document.getElementById('sel-font').value;
            this.style.mainSize = parseInt(document.getElementById('range-main-size').value);
            this.style.activeSize = parseInt(document.getElementById('range-active-size').value);
            this.style.textColor = document.getElementById('color-text').value;
            this.style.activeColor = document.getElementById('color-active').value;
            this.style.activeWordBold = document.getElementById('chk-bold').checked;
            this.style.effects.outline.enabled = document.getElementById('chk-outline').checked;
            this.style.effects.outline.color = document.getElementById('color-outline').value;
            this.style.effects.outline.size = parseInt(document.getElementById('range-outline-size').value);
            this.style.effects.shadow.enabled = document.getElementById('chk-shadow').checked;
            this.style.effects.shadow.color = document.getElementById('color-shadow').value;
            this.style.effects.shadow.opacity = parseInt(document.getElementById('range-shadow-opacity').value);
            this.style.effects.shadow.direction = parseInt(document.getElementById('range-shadow-direction').value);
            this.style.effects.shadow.distance = parseInt(document.getElementById('range-shadow-distance').value);
            this.style.effects.shadow.softness = parseInt(document.getElementById('range-shadow-softness').value);
            this.style.effects.glow.enabled = document.getElementById('chk-glow').checked;
            this.style.effects.glow.color = document.getElementById('color-glow').value;
            this.style.effects.glow.size = parseInt(document.getElementById('range-glow-size').value);
            if (!this.style.activeBox) this.style.activeBox = { enabled: false, color: '#FF00CE', padding: 10, radius: 8 };
            this.style.activeBox.enabled = document.getElementById('chk-active-box').checked;
            this.style.activeBox.color = document.getElementById('color-active-box').value;
            this.style.activeBox.padding = parseInt(document.getElementById('range-active-box-pad').value);
            this.style.activeBox.radius = parseInt(document.getElementById('range-active-box-radius').value);
            this.style.grouping.maxWords = parseInt(document.getElementById('num-max-words').value);
            this.style.grouping.maxSeconds = parseFloat(document.getElementById('num-max-seconds').value);
            this.style.grouping.maxCharacters = parseInt(document.getElementById('num-max-chars').value);
            this.style.position.yPx = parseInt(document.getElementById('range-offset').value);
            this.style.position.placement = document.getElementById('sel-placement').value;
            this.syncHexFields();
            this.rebuildLayout();
            this.updatePreview();
        };

        document.querySelectorAll('.style-controls input, .style-controls select, .grouping-controls input, .effects-controls input, .position-controls input, .position-controls select').forEach(el => {
            el.addEventListener('input', updateStyle);
            el.addEventListener('change', updateStyle);
        });

        // Hex text fields paired with each color picker. The picker still
        // offers the browser's RGB/HSL tabs; the hex box gives a precise
        // default entry point.
        const hexPairs = [
            ['color-text', 'hex-text'],
            ['color-active', 'hex-active'],
            ['color-outline', 'hex-outline'],
            ['color-shadow', 'hex-shadow'],
            ['color-glow', 'hex-glow'],
            ['color-active-box', 'hex-active-box']
        ];
        this._hexPairs = hexPairs;
        for (const [colorId, hexId] of hexPairs) {
            const colorInput = document.getElementById(colorId);
            const hexInput = document.getElementById(hexId);
            hexInput.value = colorInput.value.toUpperCase();
            hexInput.addEventListener('input', () => {
                let v = hexInput.value.trim();
                if (!v.startsWith('#')) v = '#' + v;
                if (/^#[0-9a-fA-F]{6}$/.test(v)) {
                    colorInput.value = v.toLowerCase();
                    updateStyle();
                }
            });
        }

        const syncSliderNumber = (rangeId, numberId) => {
            const range = document.getElementById(rangeId);
            const num = document.getElementById(numberId);
            range.addEventListener('input', () => { num.value = range.value; });
            num.addEventListener('input', () => { range.value = num.value; updateStyle(); });
        };
        syncSliderNumber('range-main-size', 'range-main-size-num');
        syncSliderNumber('range-active-size', 'range-active-size-num');
        syncSliderNumber('range-active-box-pad', 'range-active-box-pad-num');
        syncSliderNumber('range-active-box-radius', 'range-active-box-radius-num');
        // Vertical position slider (0..1080 reference frame). Dragging it
        // away from a preset value switches the dropdown to "Custom".
        const placementSelect = document.getElementById('sel-placement');
        const offsetRange = document.getElementById('range-offset');
        const offsetNum = document.getElementById('range-offset-num');
        offsetRange.addEventListener('input', () => {
            offsetNum.value = offsetRange.value;
            this.syncPlacementDropdown(parseInt(offsetRange.value));
        });
        offsetNum.addEventListener('input', () => {
            offsetRange.value = offsetNum.value;
            this.syncPlacementDropdown(parseInt(offsetNum.value));
            updateStyle();
        });
        placementSelect.addEventListener('change', () => {
            const yPx = App.POSITION_PRESETS[placementSelect.value];
            if (yPx != null) {
                offsetRange.value = yPx;
                offsetNum.value = yPx;
                updateStyle();
            }
        });
    },

    syncHexFields() {
        if (!this._hexPairs) return;
        for (const [colorId, hexId] of this._hexPairs) {
            const hex = document.getElementById(hexId);
            if (document.activeElement !== hex) {
                hex.value = document.getElementById(colorId).value.toUpperCase();
            }
        }
    },

    // Caption baseline in a 1080p reference frame (0 = top, 1080 = bottom).
    POSITION_PRESETS: {
        'top': 90,
        'center': 540,
        'lower-third': 780,
        'bottom': 990
    },

    syncPlacementDropdown(yPx) {
        const select = document.getElementById('sel-placement');
        const match = Object.entries(App.POSITION_PRESETS).find(([, v]) => v === yPx);
        select.value = match ? match[0] : 'custom';
        const customOpt = select.querySelector('option[value="custom"]');
        if (customOpt) customOpt.hidden = !match;
    },

    // Draggable divider between Transcript Output and Word Editor panels.
    bindCenterResizer() {
        const resizer = document.getElementById('center-resizer');
        const transcriptPanel = document.getElementById('panel-transcript-display');
        let startY = 0, startH = 0;

        const onMove = (e) => {
            const dh = e.clientY - startY;
            const newH = Math.min(
                Math.max(60, startH + dh),
                resizer.parentElement.clientHeight - 180
            );
            transcriptPanel.style.flex = `0 0 ${newH}px`;
            transcriptPanel.style.maxHeight = 'none';
            transcriptPanel.classList.add('resized');
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
        resizer.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startY = e.clientY;
            startH = transcriptPanel.getBoundingClientRect().height;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            document.body.style.cursor = 'row-resize';
            document.body.style.userSelect = 'none';
        });
    },

    importVideo() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'video/*';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (file) this.loadVideo(file);
        };
        input.click();
    },

    loadVideo(file) {
        const url = URL.createObjectURL(file);
        this.video.src = url;
        this.videoFile = file;
        document.getElementById('drop-zone').classList.add('hidden');
    },

    onVideoLoaded() {
        document.getElementById('btn-transcribe').disabled = false;
        document.getElementById('btn-play').disabled = false;
        document.getElementById('scrubber').disabled = false;
        this.resizeCanvas();
        this.updateTimeDisplay();
        window.addEventListener('resize', () => this.resizeCanvas());

        Pipeline.complete('video');
        Status.success(`Video loaded — ${this.video.videoWidth}x${this.video.videoHeight}`);
        this.updateModelStatus();
    },

    resizeCanvas() {
        const vw = this.video.videoWidth;
        const vh = this.video.videoHeight;
        if (!vw || !vh) return;

        const container = this.canvas.parentElement;
        const cw = container.clientWidth;
        const ch = container.clientHeight;
        const videoAspect = vw / vh;
        const containerAspect = cw / ch;

        let renderedW, renderedH;
        if (videoAspect > containerAspect) {
            renderedW = cw;
            renderedH = cw / videoAspect;
        } else {
            renderedH = ch;
            renderedW = ch * videoAspect;
        }

        const offsetX = (cw - renderedW) / 2;
        const offsetY = (ch - renderedH) / 2;

        this.canvas.width = vw;
        this.canvas.height = vh;
        this.canvas.style.width = renderedW + 'px';
        this.canvas.style.height = renderedH + 'px';
        this.canvas.style.left = offsetX + 'px';
        this.canvas.style.top = offsetY + 'px';

        this.rebuildLayout();
    },

    rebuildLayout() {
        if (!this.transcript) {
            this.captionGroups = [];
            this.captionLayout = [];
            return;
        }
        this.captionGroups = groupWords(this.transcript.words, this.style.grouping);
        this.captionLayout = computeLayout(this.captionGroups, this.style, this.canvas.width, this.canvas.height);
    },

    togglePlay() {
        if (this.video.paused) this.video.play();
        else this.video.pause();
    },

    scrub(e) {
        const time = (e.target.value / 100) * this.video.duration;
        this.video.currentTime = time;
    },

    updateTimeDisplay() {
        const fmt = (s) => {
            const m = Math.floor(s / 60);
            const sec = Math.floor(s % 60);
            return `${m}:${sec.toString().padStart(2, '0')}`;
        };
        document.getElementById('time-display').textContent =
            `${fmt(this.video.currentTime)} / ${fmt(this.video.duration || 0)}`;
        if (this.video.duration) {
            document.getElementById('scrubber').value =
                (this.video.currentTime / this.video.duration) * 100;
        }
    },

    updatePreview() {
        this.updateTimeDisplay();
        if (!this.transcript || !this.video.duration) return;

        const time = this.video.currentTime;
        const { width, height } = this.canvas;
        this.ctx.clearRect(0, 0, width, height);
        if (!this.captionGroups.length) { this.highlightActiveWord(null); return; }

        const groupIndex = findGroupAtTime(this.captionGroups, time);
        if (groupIndex < 0) { this.highlightActiveWord(null); return; }

        const group = this.captionGroups[groupIndex];
        const layout = this.captionLayout[groupIndex];
        if (!layout) return;

        let activeWordId = null;
        let activeWordIdx = -1;
        for (let i = 0; i < group.words.length; i++) {
            const w = group.words[i];
            if (w.start <= time && w.end >= time) {
                activeWordId = w.id;
                activeWordIdx = i;
                break;
            }
        }

        drawGroup(this.ctx, layout, activeWordId, this.style);

        this.highlightActiveWord(activeWordId);

        if (this.debugOverlay) {
            drawDiagnostics(this.ctx, layout, groupIndex, activeWordIdx);
        }
    },

    // Highlights the word chip matching the currently-spoken word while the
    // video plays, and auto-scrolls the editor to keep it visible. Cheap
    // class toggles only — no re-render, safe to call every animation frame.
    highlightActiveWord(activeWordId) {
        if (activeWordId === this._lastActiveWordId) return;
        this._lastActiveWordId = activeWordId;
        const editor = document.getElementById('word-selector');
        const prev = editor.querySelector('.word-chip.playback-active');
        if (prev) prev.classList.remove('playback-active');
        if (activeWordId == null || !this.transcript) return;
        const idx = this.transcript.words.findIndex(w => w.id === activeWordId && !w.deleted);
        if (idx < 0) return;
        const chip = editor.querySelector(`[data-index="${idx}"]`);
        if (!chip) return;
        chip.classList.add('playback-active');
        // Only follow the playhead while playing so manual scrolling sticks.
        if (this.video && !this.video.paused) {
            chip.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    },

    startPreviewLoop() {
        const loop = () => {
            if (!this.video.paused) {
                this.updatePreview();
                this._raf = requestAnimationFrame(loop);
            }
        };
        this._raf = requestAnimationFrame(loop);
    },

    stopPreviewLoop() {
        if (this._raf) cancelAnimationFrame(this._raf);
    },

    // ── Model Status ────────────────────────────────────────
    updateModelStatus() {
        const modelId = document.getElementById('sel-model').value;
        const btn = document.getElementById('btn-download-model');
        const transcribeBtn = document.getElementById('btn-transcribe-model');
        if (loadedModelId === modelId) {
            ModelStatus.set('cached', 'Loaded');
            btn.disabled = true;
            btn.textContent = 'Loaded';
            Pipeline.complete('model');
        } else {
            ModelStatus.clear();
            btn.disabled = false;
            btn.textContent = 'Download';
            Pipeline.undo('model');
        }
        // Show the toolbar Transcribe shortcut once a model is resident and
        // a video is loaded.
        transcribeBtn.hidden = loadedModelId === null;
        transcribeBtn.disabled = !this.videoFile;
    },

    // The base model ships inside the zip (app/models/) — load it silently in
    // the background at startup so the first transcription needs no download.
    async autoLoadDefaultModel() {
        const modelId = 'base';
        try {
            Status.setActive('Loading bundled base model...');
            await this.loadWhisper(modelId, null);
            Status.clearActive();
            Status.success('Bundled base model ready — no download needed');
        } catch (err) {
            Status.clearActive();
            Status.warning(`Bundled model failed to load (${err.message}) — it will be loaded on first transcription`);
        }
    },

    // Shared Whisper loader used by Download button, auto-load, and Transcribe.
    async loadWhisper(modelId, progressCallback) {
        const modelName = `onnx-community/whisper-${modelId}_timestamped`;
        // The base model is bundled under app/models/ — serve it from the
        // local server instead of hitting HuggingFace (fast start, and works
        // with no internet at all). Other models download and get cached.
        env.allowRemoteModels = modelId !== 'base';
        whisperPipeline = await pipeline(
            'automatic-speech-recognition',
            modelName,
            {
                dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
                progress_callback: progressCallback || undefined
            }
        );
        loadedModelId = modelId;
        this.updateModelStatus();
    },

    // ── Theme Toggle ────────────────────────────────────────
    toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
        this.updateThemeIcon();
    },

    updateThemeIcon() {
        const btn = document.getElementById('btn-theme-toggle');
        const theme = document.documentElement.getAttribute('data-theme');
        btn.innerHTML = theme === 'dark' ? '&#9790;' : '&#9788;';
        btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    },

    // ── Extract Audio ───────────────────────────────────────
    async extractAudio() {
        const active = Status.setActive('Extracting audio from video...');
        Progress.show('Extracting Audio', 'Reading video file');

        const inputData = await fetchFile(this.videoFile);
        await FFmpegService.writeFile('input.mp4', inputData);

        Progress.update(50, 'Converting to WAV');
        await FFmpegService.exec([
            '-i', 'input.mp4', '-vn', '-acodec', 'pcm_s16le',
            '-ar', '16000', '-ac', '1', 'output.wav'
        ]);

        Progress.update(90, 'Reading audio data');
        const audioData = await FFmpegService.readFile('output.wav');
        await FFmpegService.deleteFile('input.mp4');
        await FFmpegService.deleteFile('output.wav');

        const wavBlob = new Blob([audioData], { type: 'audio/wav' });
        const arrayBuffer = await wavBlob.arrayBuffer();
        const view = new DataView(arrayBuffer);

        const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
        if (riff !== 'RIFF') throw new Error('Invalid WAV: missing RIFF header');

        let offset = 12;
        let fmtFound = false, dataFound = false;
        let wavChannels = 0, wavSampleRate = 0, wavBitsPerSample = 0, dataSize = 0;

        while (offset < arrayBuffer.byteLength - 8) {
            const chunkId = String.fromCharCode(view.getUint8(offset), view.getUint8(offset+1), view.getUint8(offset+2), view.getUint8(offset+3));
            const chunkSize = view.getUint32(offset + 4, true);
            offset += 8;
            if (chunkId === 'fmt ') {
                wavChannels = view.getUint16(offset + 2, true);
                wavSampleRate = view.getUint32(offset + 4, true);
                wavBitsPerSample = view.getUint16(offset + 14, true);
                fmtFound = true;
            } else if (chunkId === 'data') {
                dataSize = chunkSize;
                dataFound = true;
                break;
            }
            offset += chunkSize;
        }

        if (!fmtFound || !dataFound) throw new Error('Invalid WAV: fmt=' + fmtFound + ' data=' + dataFound);

        const bytesPerSample = wavBitsPerSample / 8;
        const numSamples = dataSize / (wavChannels * bytesPerSample);
        const pcmOffset = offset;
        let channelData;

        if (wavChannels === 1 && wavBitsPerSample === 16) {
            channelData = new Float32Array(numSamples);
            for (let i = 0; i < numSamples; i++) {
                channelData[i] = view.getInt16(pcmOffset + i * 2, true) / 32768;
            }
        } else if (wavChannels === 2 && wavBitsPerSample === 16) {
            channelData = new Float32Array(numSamples);
            for (let i = 0; i < numSamples; i++) {
                const left = view.getInt16(pcmOffset + i * 4, true) / 32768;
                const right = view.getInt16(pcmOffset + i * 4 + 2, true) / 32768;
                channelData[i] = (left + right) / 2;
            }
        } else {
            throw new Error('Unsupported WAV: ' + wavChannels + 'ch ' + wavBitsPerSample + 'bit');
        }

        const duration = channelData.length / wavSampleRate;
        active.remove();
        Status.success(`Audio extracted — ${duration.toFixed(1)}s, ${wavChannels === 1 ? 'mono' : 'stereo→mono'}`);
        Progress.hide();
        return { samples: channelData, duration };
    },

    // ── Download Model ──────────────────────────────────────
    async downloadModel() {
        const modelId = document.getElementById('sel-model').value;
        const modelName = `onnx-community/whisper-${modelId}_timestamped`;
        const btn = document.getElementById('btn-download-model');

        try {
            btn.disabled = true;
            btn.textContent = 'Loading...';
            ModelStatus.set('downloading', 'Loading');
            Pipeline.activate('model');
            Status.setActive(`Loading ${modelName}...`);

            Progress.showProgress('Loading Model', `${modelName}`);
            // Transformers.js v3 progress statuses: initiate | download | progress | done | ready
            // (progress.progress is a 0..1 fraction)
            const progressCallback = (progress) => {
                if (progress.status === 'initiate') {
                    Progress.update(0, `Fetching ${progress.file || 'model file'}...`);
                } else if (progress.status === 'progress' && typeof progress.progress === 'number') {
                    const pct = Math.min(100, Math.max(0, progress.progress * 100));
                    Progress.update(pct, `Downloading ${modelId}: ${Math.round(pct)}%`);
                } else if (progress.status === 'ready' || progress.status === 'loading') {
                    Progress.update(100, 'Loading into memory...');
                }
            };

            await this.loadWhisper(modelId, progressCallback);

            Progress.hide();
            Status.clearActive();
            Status.success(`Model ${modelId} ready for transcription`);
        } catch (err) {
            Progress.hide();
            Status.clearActive();
            Status.error(`Model load failed: ${err.message}`);
            ModelStatus.clear();
            btn.disabled = false;
            btn.textContent = 'Download';
            Pipeline.deactivate('model');
        }
    },

    // ── Transcribe ──────────────────────────────────────────
    async transcribe() {
        if (!this.videoFile) return;
        if (!this.ffmpegLoaded) {
            Status.error('FFmpeg is still loading. Please wait and try again.');
            return;
        }
        if (this._exportRunning || this._transcribeRunning) {
            Status.warning('Another operation is already running');
            return;
        }

        let cancelled = false;
        this._transcribeRunning = true;
        this._transcribeCancel = () => { cancelled = true; };

        try {
            Pipeline.activate('transcribe');
            const { samples: audioSamples, duration: audioDuration } = await this.extractAudio();
            if (cancelled) throw { __cancelled: true };

            const modelId = document.getElementById('sel-model').value;
            const language = document.getElementById('sel-language').value;

            if (loadedModelId !== modelId) {
                const isBundled = modelId === 'base';
                Progress.showProgress('Loading Model',
                    isBundled ? 'Loading bundled base model...' : 'First run downloads from HuggingFace...');
                // Transformers.js v3 emits: initiate | download | progress | done | ready
                const progressCallback = (progress) => {
                    if (cancelled) throw { __cancelled: true };
                    if (progress.status === 'initiate') {
                        Progress.update(10, `Fetching ${progress.file || 'model file'}...`);
                    } else if (progress.status === 'progress' && typeof progress.progress === 'number') {
                        const pct = Math.min(100, Math.max(0, progress.progress * 100));
                        Progress.update(10 + pct * 0.4, `Downloading model: ${Math.round(pct)}%`);
                    } else if (progress.status === 'ready' || progress.status === 'loading') {
                        Progress.update(50, 'Loading model into memory...');
                    }
                };
                await this.loadWhisper(modelId, progressCallback);
                if (cancelled) throw { __cancelled: true };
            }

            Progress.showProgress('Transcribing', `Using ${modelId} model...`, () => {
                // Whisper has no abort hook inside a running pipeline call; we
                // set the flag and abandon the result when it finally resolves.
                cancelled = true;
                Progress.update(0, 'Cancelling...');
            });
            const active = Status.setActive('Transcribing audio...');

            const tStart = performance.now();
            const result = await whisperPipeline(audioSamples, {
                language: language,
                task: 'transcribe',
                return_timestamps: 'word',
                chunk_length_s: 30,
                stride_length_s: 5
            });
            if (cancelled) throw { __cancelled: true };
            const tEnd = performance.now();

            Progress.update(90, 'Building transcript...');
            Status.setActive('Building transcript...');

            const transcript = whisperToTranscript(result, audioDuration, this.videoFile.name, language);

            this.transcript = transcript;
            this.transcriptMeta = {
                model: `onnx-community/whisper-${modelId}_timestamped`,
                processingTime: tEnd - tStart,
                audioSamples: audioSamples.length,
                audioDuration: audioDuration
            };

            this.rebuildLayout();
            active.remove();
            Status.clearActive();
            Status.success(`Transcription complete — ${transcript.words.length} words, ${((tEnd - tStart) / 1000).toFixed(1)}s`);

            this.renderTranscriptEditor();
            this.renderTranscriptDisplay();
            this.updateDiagnostics();

            document.getElementById('btn-export-srt').disabled = false;
            document.getElementById('btn-export-vtt').disabled = false;
            document.getElementById('btn-generate').disabled = false;
            document.getElementById('btn-render-settings').disabled = false;

            Pipeline.complete('transcribe');
            Pipeline.complete('edit');
            Progress.hide();
        } catch (err) {
            Progress.hide();
            Status.clearActive();
            if (err && err.__cancelled) {
                Status.msg('Transcription cancelled', 'info');
            } else {
                Status.error(`Transcription failed: ${err.message}`);
            }
            Pipeline.deactivate('transcribe');
        } finally {
            this._transcribeRunning = false;
            this._transcribeCancel = null;
        }
    },

    // ── Export SRT / VTT ────────────────────────────────────
    async exportSRT() {
        if (!this.transcript) return;
        const srt = this.generateSRT();
        const baseName = this.videoFile?.name?.replace(/\.[^.]+$/, '') || 'captions';
        this.downloadFile(srt, `${baseName}.srt`, 'text/plain');
        Status.success('SRT file exported');
    },

    async exportVTT() {
        if (!this.transcript) return;
        const vtt = this.generateVTT();
        const baseName = this.videoFile?.name?.replace(/\.[^.]+$/, '') || 'captions';
        this.downloadFile(vtt, `${baseName}.vtt`, 'text/vtt');
        Status.success('VTT file exported');
    },

    generateSRT() {
        if (!this.captionGroups.length) return '';
        return this.captionGroups.map((group, i) => {
            const start = this.formatSRTTime(group.start);
            const end = this.formatSRTTime(group.end);
            const text = group.words.map(w => w.text).join(' ');
            return `${i + 1}\n${start} --> ${end}\n${text}`;
        }).join('\n\n');
    },

    generateVTT() {
        if (!this.captionGroups.length) return 'WEBVTT\n\n';
        const cues = this.captionGroups.map(group => {
            const start = this.formatVTTTime(group.start);
            const end = this.formatVTTTime(group.end);
            const text = group.words.map(w => w.text).join(' ');
            return `${start} --> ${end}\n${text}`;
        }).join('\n\n');
        return `WEBVTT\n\n${cues}`;
    },

    formatSRTTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.round((seconds % 1) * 1000);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    },

    formatVTTTime(seconds) {
        return this.formatSRTTime(seconds).replace(',', '.');
    },

    downloadFile(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    },

    // ── Generate Video ──────────────────────────────────────
    async generateVideo() {
        if (!this.videoFile || !this.transcript) {
            Status.error('No video or transcript loaded');
            return;
        }
        if (!this.ffmpegLoaded) {
            Status.error('FFmpeg is still loading. Please wait.');
            return;
        }
        if (this._exportRunning || this._transcribeRunning) {
            Status.warning('Another operation is already running');
            return;
        }

        let cancelled = false;
        this._exportRunning = true;
        const cancelExport = () => {
            cancelled = true;
            // FFmpeg WASM cannot abort mid-encode; terminate the worker to
            // stop the CPU burn immediately. It is re-initialized afterwards.
            FFmpegService.terminate();
            this.ffmpegLoaded = false;
        };

        try {
            Pipeline.activate('export');
            const baseName = this.videoFile.name.replace(/\.[^.]+$/, '');
            const suggestedName = `${baseName}_captioned.mp4`;

            let fileHandle = null;
            if (window.showSaveFilePicker) {
                try {
                    fileHandle = await window.showSaveFilePicker({
                        suggestedName: suggestedName,
                        types: [{ description: 'MP4 Video', accept: { 'video/mp4': ['.mp4'] } }]
                    });
                } catch (err) {
                    if (err.name === 'AbortError') {
                        Pipeline.deactivate('export');
                        Status.msg('Export cancelled by user', 'info');
                        return;
                    }
                }
            }

            Progress.show('Generating Video', 'Preparing caption overlays...', cancelExport);
            Status.setActive('Preparing video export...');
            const states = this.getCaptionStateChanges();

            Progress.showProgress('Rendering Captions', `Rendering ${states.length} caption frames...`, cancelExport);
            Status.setActive(`Rendering ${states.length} caption frames...`);
            const frames = await this.renderOverlayFrames(states, () => cancelled);
            if (cancelled) throw { __cancelled: true };
            this._lastFrames = frames;

            Progress.update(50, 'Writing overlay frames to FFmpeg...');
            Status.setActive('Encoding video...');
            await this.writeFramesToFFmpeg(frames);
            if (cancelled) throw { __cancelled: true };

            Progress.update(70, 'Encoding MP4...');
            // Real encode progress from ffmpeg's own events (0..1 of video
            // timeline processed). Single-thread WASM x264 at 1080p is slow;
            // without this the bar would sit at a fake 70% for many minutes.
            FFmpegService.onProgress = (p) => {
                if (typeof p?.progress === 'number') {
                    const pct = Math.min(100, Math.max(0, p.progress * 100));
                    Progress.update(70 + pct * 0.28, `Encoding MP4: ${Math.round(pct)}% of video`);
                }
            };
            await this.encodeVideo();
            FFmpegService.onProgress = null;
            if (cancelled) throw { __cancelled: true };

            Progress.update(90, 'Finalizing...');
            Status.setActive('Finalizing MP4...');

            const outputData = await FFmpegService.readFile('output.mp4');
            const blob = new Blob([outputData.buffer], { type: 'video/mp4' });

            if (fileHandle) {
                const writable = await fileHandle.createWritable();
                await writable.write(blob);
                await writable.close();
            } else {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = suggestedName;
                a.click();
                URL.revokeObjectURL(url);
            }

            await FFmpegService.deleteFile('output.mp4');

            Status.clearActive();
            Status.success(`Video exported — ${suggestedName}`);
            Pipeline.complete('export');
            Progress.hide();
        } catch (err) {
            Progress.hide();
            Status.clearActive();
            FFmpegService.onProgress = null;
            if ((err && err.__cancelled) || cancelled) {
                // Cancel terminates the worker mid-encode, which rejects the
                // pending exec with 'FFmpeg terminated' — that's expected.
                Status.msg('Export cancelled', 'info');
            } else {
                Status.error(`Video export failed: ${err.message}`);
            }
            Pipeline.deactivate('export');
        } finally {
            this._exportRunning = false;
            // If cancel terminated the worker, bring it back so the user can
            // try again (or transcribe) without reloading the page.
            if (!FFmpegService.isLoaded) {
                try {
                    Status.setActive('Re-initializing FFmpeg engine...');
                    await FFmpegService.init();
                    this.ffmpegLoaded = true;
                    Status.clearActive();
                    Status.success('FFmpeg engine reloaded');
                } catch {
                    this.ffmpegLoaded = false;
                    Status.warning('FFmpeg engine failed to reload — reload the page');
                }
            }
        }
    },

    getCaptionStateChanges() {
        if (!this.captionGroups.length || !this.video.duration) return [];

        const states = [];
        let lastGroupId = null;
        const step = 0.1;

        for (let t = 0; t <= this.video.duration; t += step) {
            const groupIndex = findGroupAtTime(this.captionGroups, t);
            const group = groupIndex >= 0 ? this.captionGroups[groupIndex] : null;
            const layout = groupIndex >= 0 ? this.captionLayout[groupIndex] : null;
            const groupId = group ? group.words.map(w => w.id).join(',') : '';

            let activeWordId = null;
            if (group) {
                for (const w of group.words) {
                    if (w.start <= t && w.end >= t) {
                        activeWordId = w.id;
                        break;
                    }
                }
            }

            const stateKey = `${groupId}|${activeWordId}`;
            if (stateKey !== lastGroupId) {
                states.push({ time: t, groupIndex, layout, activeWordId, key: stateKey });
                lastGroupId = stateKey;
            }
        }

        return states;
    },

    async renderOverlayFrames(states, isCancelled = () => false) {
        // Write each PNG straight into FFmpeg's filesystem as it is rendered
        // (instead of buffering every frame in JS memory as well) so peak
        // memory is roughly halved on long videos.
        const frameList = [];
        const canvas = document.createElement('canvas');
        canvas.width = this.video.videoWidth;
        canvas.height = this.video.videoHeight;
        const ctx = canvas.getContext('2d');

        for (let i = 0; i < states.length; i++) {
            if (isCancelled()) return frameList;
            const state = states[i];
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            if (state.layout) {
                drawGroup(ctx, state.layout, state.activeWordId, this.style);
            }

            const duration = i < states.length - 1
                ? states[i + 1].time - state.time
                // Last frame must hold until the END of the video — if it
                // stopped short (e.g. fixed 0.5s), the overlay input would
                // end early, shortest=1 would cut the video stream there,
                // and the player would freeze the last frame while the
                // copied audio kept playing to the true end.
                : Math.max(0.5, this.video.duration - state.time + 0.5);

            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            const data = new Uint8Array(await blob.arrayBuffer());
            const filename = `frame_${String(i).padStart(6, '0')}.png`;
            await FFmpegService.writeFile(filename, data);
            frameList.push({ filename, duration });

            Progress.update(5 + (i / states.length) * 35, `Rendering frame ${i + 1}/${states.length}...`);
        }

        return frameList;
    },

    async writeFramesToFFmpeg(frames) {
        let concatContent = '';
        for (const frame of frames) {
            concatContent += `file '${frame.filename}'\n`;
            concatContent += `duration ${frame.duration.toFixed(4)}\n`;
        }
        concatContent += `file '${frames[frames.length - 1].filename}'\n`;
        await FFmpegService.writeFile('concat.txt', new TextEncoder().encode(concatContent));
    },

    // ── Render Settings (gear menu) ─────────────────────────
    bindRenderSettings() {
        const gear = document.getElementById('btn-render-settings');
        const menu = document.getElementById('render-settings-menu');

        gear.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.classList.toggle('hidden');
        });
        // Clicking inside the menu must not close it; outside does.
        menu.addEventListener('click', (e) => e.stopPropagation());
        document.addEventListener('click', () => menu.classList.add('hidden'));

        // Persist settings so the chosen quality survives reloads.
        const ids = ['sel-render-fps', 'range-render-crf', 'sel-render-preset', 'sel-render-audio'];
        try {
            const saved = JSON.parse(localStorage.getItem('renderSettings') || 'null');
            if (saved) {
                for (const id of ids) {
                    const el = document.getElementById(id);
                    if (el && saved[id] != null) el.value = saved[id];
                }
            }
        } catch { /* corrupt storage — ignore, use defaults */ }
        const persist = () => {
            const data = {};
            for (const id of ids) data[id] = document.getElementById(id).value;
            localStorage.setItem('renderSettings', JSON.stringify(data));
        };
        for (const id of ids) {
            document.getElementById(id).addEventListener('change', persist);
        }
        const crfRange = document.getElementById('range-render-crf');
        const crfNum = document.getElementById('range-render-crf-num');
        crfNum.value = crfRange.value;
        crfRange.addEventListener('input', () => { crfNum.value = crfRange.value; persist(); });
        crfNum.addEventListener('input', () => { crfRange.value = crfNum.value; persist(); });
    },

    getRenderSettings() {
        // fps '' = "Same as source": omit -r entirely so FFmpeg keeps the
        // source frame rate (the original, always-correct behavior).
        const fpsRaw = document.getElementById('sel-render-fps').value;
        return {
            fps: fpsRaw ? (parseInt(fpsRaw) || null) : null,
            crf: parseInt(document.getElementById('range-render-crf').value) || 18,
            preset: document.getElementById('sel-render-preset').value || 'ultrafast',
            audio: document.getElementById('sel-render-audio').value || 'copy'
        };
    },

    async encodeVideo() {
        const inputData = await fetchFile(this.videoFile);
        await FFmpegService.writeFile('source.mp4', inputData);

        const rs = this.getRenderSettings();
        // IMPORTANT: -r must ONLY be an output option here. Placing it before
        // '-f concat' makes the concat demuxer ignore every 'duration' line,
        // giving each PNG one frame slot at the chosen fps — the overlay then
        // runs ~fps/10x too fast and overlay=shortest=1 truncates the video
        // stream (e.g. 10s of video for a 30s overlay), producing a short,
        // broken MP4 with exit code 0 and no error.
        const baseArgs = [
            '-i', 'source.mp4',
            '-f', 'concat', '-safe', '0',
            '-i', 'concat.txt',
            '-filter_complex', '[0:v][1:v]overlay=0:0:shortest=1',
            '-c:v', 'libx264', '-preset', rs.preset, '-crf', String(rs.crf)
        ];
        if (rs.fps) baseArgs.push('-r', String(rs.fps));

        let ret;
        if (rs.audio === 'copy') {
            // Audio passthrough first; if the source audio codec isn't valid
            // in MP4 (e.g. Opus/Vorbis source), fall back to AAC re-encoding.
            ret = await FFmpegService.exec([...baseArgs, '-c:a', 'copy', '-y', 'output.mp4']);
            if (ret !== 0) {
                Status.warning('Audio passthrough failed — re-encoding audio as AAC...');
                await FFmpegService.deleteFile('output.mp4').catch(() => {});
                ret = await FFmpegService.exec([...baseArgs, '-c:a', 'aac', '-b:a', '192k', '-y', 'output.mp4']);
            }
        } else {
            const bitrate = rs.audio === 'aac256' ? '256k' : '192k';
            ret = await FFmpegService.exec([...baseArgs, '-c:a', 'aac', '-b:a', bitrate, '-y', 'output.mp4']);
        }
        if (ret !== 0) {
            throw new Error(`FFmpeg exited with code ${ret} (source audio codec may be unsupported by ffmpeg.wasm)`);
        }

        await FFmpegService.deleteFile('source.mp4');
        await FFmpegService.deleteFile('concat.txt');
        for (const frame of this._lastFrames || []) {
            await FFmpegService.deleteFile(frame.filename).catch(() => {});
        }
        this._lastFrames = null;
    },

    // ── Transcript Editor ───────────────────────────────────
    renderTranscriptEditor() {
            const editor = document.getElementById('word-selector');
        if (!this.transcript || !this.transcript.words.length) {
            editor.innerHTML = '<p class="placeholder">No transcript available.</p>';
            return;
        }

        editor.innerHTML = '';
        this._lastActiveWordId = null;
        this.transcript.words.forEach((word, i) => {
            const chip = document.createElement('span');
            chip.className = `word-chip ${word.deleted ? 'deleted' : ''} ${i === this.selectedWordIndex ? 'selected' : ''}`;
            chip.dataset.index = i;

            const textSpan = document.createElement('span');
            textSpan.className = 'word-text';
            textSpan.textContent = word.text;

            const timeSpan = document.createElement('span');
            timeSpan.className = 'timestamp';
            timeSpan.textContent = `${word.start.toFixed(2)}-${word.end.toFixed(2)}`;

            chip.addEventListener('click', (e) => {
                e.stopPropagation();
                this.selectWord(i);
            });

            chip.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.enterTextEdit(i);
            });

            chip.appendChild(textSpan);
            chip.appendChild(timeSpan);
            editor.appendChild(chip);
        });

        if (this.selectedWordIndex >= 0) {
            const selected = editor.querySelector(`[data-index="${this.selectedWordIndex}"]`);
            if (selected) selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    },

    selectWord(index) {
        const activeEl = document.activeElement;
        if (activeEl && activeEl.contentEditable === 'true') {
            activeEl.blur();
        }
        this.exitTextEdit();
        this.selectedWordIndex = index;
        this.renderTranscriptEditor();
        this.updateInspector();
        
        // Clicking a word always moves the playhead to its start time,
        // whether or not the video is playing — makes precise editing easy.
        if (index >= 0 && this.transcript && this.video && this.video.src) {
            const word = this.transcript.words[index];
            this.video.currentTime = word.start;
        }
    },

    enterTextEdit(index) {
        if (index < 0 || !this.transcript) return;
        
        this.selectedWordIndex = index;
            const editor = document.getElementById('word-selector');
        const chip = editor.querySelector(`[data-index="${index}"]`);
        if (!chip) return;
        
        const textSpan = chip.querySelector('.word-text');
        if (!textSpan) return;
        
        const originalText = this.transcript.words[index].text;
        let cancelled = false;
        
        textSpan.contentEditable = 'true';
        textSpan.spellcheck = false;
        textSpan.focus();
        
        const range = document.createRange();
        range.selectNodeContents(textSpan);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        
        const cleanup = () => {
            textSpan.removeEventListener('blur', onBlur);
            textSpan.removeEventListener('keydown', onKeydown);
            textSpan.removeAttribute('contenteditable');
            textSpan.removeAttribute('spellcheck');
        };
        
        const onBlur = () => {
            cleanup();
            if (!cancelled) {
                const newText = textSpan.textContent.trim();
                if (newText && newText !== originalText) {
                    this.saveState();
                    this.transcript.words[index].text = newText;
                    this.rebuildLayout();
                    this.updatePreview();
                }
            }
            this.updateInspector();
        };
        
        const onKeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                textSpan.blur();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelled = true;
                textSpan.textContent = originalText;
                textSpan.blur();
            }
        };
        
        textSpan.addEventListener('blur', onBlur);
        textSpan.addEventListener('keydown', onKeydown);
    },

    exitTextEdit() {
            const editor = document.getElementById('word-selector');
        const editableTexts = editor.querySelectorAll('.word-text[contenteditable="true"]');
        editableTexts.forEach(el => {
            el.removeAttribute('contenteditable');
            el.removeAttribute('spellcheck');
        });
    },

    updateInspector() {
        const inspector = document.getElementById('word-inspector');
        
        if (this.selectedWordIndex < 0 || !this.transcript) {
            inspector.classList.add('hidden');
            return;
        }
        
        const word = this.transcript.words[this.selectedWordIndex];
        if (!word) {
            inspector.classList.add('hidden');
            return;
        }
        
        inspector.classList.remove('hidden');
        
        document.getElementById('inspector-text').value = word.text;
        document.getElementById('inspector-start').value = word.start.toFixed(2);
        document.getElementById('inspector-end').value = word.end.toFixed(2);
        
        const mergeBtn = document.getElementById('inspector-merge');
        mergeBtn.disabled = this.selectedWordIndex >= this.transcript.words.length - 1;
    },

    bindInspectorControls() {
        const textInput = document.getElementById('inspector-text');
        textInput.addEventListener('change', (e) => {
            if (this.selectedWordIndex < 0 || !this.transcript) return;
            this.saveState();
            this.transcript.words[this.selectedWordIndex].text = e.target.value.trim();
            this.rebuildLayout();
            this.renderTranscriptEditor();
            this.updatePreview();
        });
        
        textInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                textInput.blur();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                textInput.value = this.transcript.words[this.selectedWordIndex].text;
                textInput.blur();
            }
        });
        
        const startInput = document.getElementById('inspector-start');
        startInput.addEventListener('change', (e) => {
            if (this.selectedWordIndex < 0 || !this.transcript) return;
            this.saveState();
            const word = this.transcript.words[this.selectedWordIndex];
            word.start = Math.max(0, parseFloat(e.target.value) || 0);
            if (word.start > word.end) word.start = word.end;
            this.rebuildLayout();
            this.renderTranscriptEditor();
            this.updatePreview();
        });
        
        const endInput = document.getElementById('inspector-end');
        endInput.addEventListener('change', (e) => {
            if (this.selectedWordIndex < 0 || !this.transcript) return;
            this.saveState();
            const word = this.transcript.words[this.selectedWordIndex];
            word.end = Math.max(word.start, parseFloat(e.target.value) || 0);
            this.rebuildLayout();
            this.renderTranscriptEditor();
            this.updatePreview();
        });
        
        document.getElementById('inspector-start-minus').addEventListener('click', () => {
            this.nudgeTime(this.selectedWordIndex, 'start', -0.05);
        });
        
        document.getElementById('inspector-start-plus').addEventListener('click', () => {
            this.nudgeTime(this.selectedWordIndex, 'start', 0.05);
        });
        
        document.getElementById('inspector-end-minus').addEventListener('click', () => {
            this.nudgeTime(this.selectedWordIndex, 'end', -0.05);
        });
        
        document.getElementById('inspector-end-plus').addEventListener('click', () => {
            this.nudgeTime(this.selectedWordIndex, 'end', 0.05);
        });
        
        document.getElementById('inspector-split').addEventListener('click', () => {
            this.splitWord(this.selectedWordIndex);
        });
        
        document.getElementById('inspector-merge').addEventListener('click', () => {
            this.mergeWithNext(this.selectedWordIndex);
        });
        
        document.getElementById('inspector-delete').addEventListener('click', () => {
            this.deleteWord(this.selectedWordIndex);
        });
    },

    renderTranscriptDisplay() {
        const el = document.getElementById('transcript-text');
        if (!this.transcript || !this.transcript.words.length) {
            el.innerHTML = '<p class="placeholder">No transcript yet. Import a video and click Transcribe.</p>';
            return;
        }

        const words = this.transcript.words.filter(w => !w.deleted);
        const fullText = words.map(w => w.text).join(' ');
        el.textContent = fullText;
    },

    updateDiagnostics() {
        if (!this.transcript || !this.transcript.words.length) {
            document.getElementById('diag-words').textContent = '-';
            document.getElementById('diag-groups').textContent = '-';
            document.getElementById('diag-duration').textContent = '-';
            document.getElementById('diag-model').textContent = '-';
            document.getElementById('diag-time').textContent = '-';
            document.getElementById('diag-samples').textContent = '-';
            return;
        }

        const activeWords = this.transcript.words.filter(w => !w.deleted);
        const duration = activeWords.length > 0
            ? activeWords[activeWords.length - 1].end - activeWords[0].start
            : 0;

        document.getElementById('diag-words').textContent = activeWords.length;
        document.getElementById('diag-groups').textContent = this.captionGroups.length;
        document.getElementById('diag-duration').textContent = duration.toFixed(2) + 's';
        document.getElementById('diag-model').textContent = this.transcriptMeta.model || '-';
        document.getElementById('diag-time').textContent = this.transcriptMeta.processingTime
            ? (this.transcriptMeta.processingTime / 1000).toFixed(1) + 's' : '-';
        document.getElementById('diag-samples').textContent = this.transcriptMeta.audioSamples
            ? this.transcriptMeta.audioSamples.toLocaleString() : '-';
    },

    // ── Word Editing ────────────────────────────────────────
    nudgeTime(index, field, delta) {
        if (!this.transcript) return;
        this.saveState();
        const word = this.transcript.words[index];
        word[field] = Math.max(0, word[field] + delta);
        if (field === 'start' && word.start > word.end) word.start = word.end;
        if (field === 'end' && word.end < word.start) word.end = word.start;
        this.rebuildLayout();
        this.renderTranscriptEditor();
        this.updateInspector();
        this.updatePreview();
    },

    deleteWord(index) {
        if (!this.transcript) return;
        this.saveState();
        this.transcript.words[index].deleted = true;
        this.selectedWordIndex = -1;
        this.rebuildLayout();
        this.renderTranscriptEditor();
        this.updateInspector();
        this.updatePreview();
    },

    splitWord(index) {
        if (!this.transcript) return;
        const word = this.transcript.words[index];
        if (word.text.length < 2) return;

        this.saveState();
        const mid = Math.floor(word.text.length / 2);
        const splitPoint = word.start + (word.end - word.start) * (mid / word.text.length);

        this.transcript.words.splice(index, 1, {
            id: word.id, text: word.text.slice(0, mid),
            start: word.start, end: splitPoint, deleted: false
        }, {
            id: `w${String(Date.now()).slice(-6)}`, text: word.text.slice(mid),
            start: splitPoint, end: word.end, deleted: false
        });

        this.selectedWordIndex = index;
        this.rebuildLayout();
        this.renderTranscriptEditor();
        this.updateInspector();
        this.updatePreview();
    },

    mergeWithNext(index) {
        if (!this.transcript || index >= this.transcript.words.length - 1) return;
        this.saveState();
        const current = this.transcript.words[index];
        const next = this.transcript.words[index + 1];
        current.text = current.text + ' ' + next.text;
        current.end = next.end;
        this.transcript.words.splice(index + 1, 1);
        this.rebuildLayout();
        this.renderTranscriptEditor();
        this.updateInspector();
        this.updatePreview();
    },

    // ── Undo / Redo ─────────────────────────────────────────
    saveState() {
        if (!this.transcript) return;
        this.undoStack.push(JSON.parse(JSON.stringify(this.transcript)));
        this.redoStack = [];
        if (this.undoStack.length > 50) this.undoStack.shift();
    },

    undo() {
        if (this.undoStack.length === 0) return;
        this.redoStack.push(JSON.parse(JSON.stringify(this.transcript)));
        this.transcript = this.undoStack.pop();
        this.rebuildLayout();
        this.renderTranscriptEditor();
        this.renderTranscriptDisplay();
        this.updateDiagnostics();
        this.updateInspector();
        this.updatePreview();
    },

    redo() {
        if (this.redoStack.length === 0) return;
        this.undoStack.push(JSON.parse(JSON.stringify(this.transcript)));
        this.transcript = this.redoStack.pop();
        this.rebuildLayout();
        this.renderTranscriptEditor();
        this.renderTranscriptDisplay();
        this.updateDiagnostics();
        this.updateInspector();
        this.updatePreview();
    },

    // ── Keyboard Shortcuts ──────────────────────────────────
    bindKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            const isEditing = document.activeElement?.contentEditable === 'true' || 
                             document.activeElement?.tagName === 'INPUT';
            
            if (e.ctrlKey && e.key === 'z') {
                e.preventDefault();
                this.undo();
            } else if (e.ctrlKey && e.key === 'y') {
                e.preventDefault();
                this.redo();
            } else if (e.key === 'F2' && this.selectedWordIndex >= 0 && !isEditing) {
                e.preventDefault();
                this.enterTextEdit(this.selectedWordIndex);
            } else if (e.key === 'Escape') {
                if (isEditing) {
                    const el = document.activeElement;
                    if (el?.tagName === 'INPUT') {
                        el.blur();
                    }
                } else {
                    this.selectWord(-1);
                }
            } else if (e.key === 'Delete' && this.selectedWordIndex >= 0 && !isEditing) {
                e.preventDefault();
                this.deleteWord(this.selectedWordIndex);
            } else if (e.key === 'd' && !e.ctrlKey && !e.altKey && !isEditing) {
                this.debugOverlay = !this.debugOverlay;
                this.updatePreview();
            }
        });
    },

    // ── Presets ─────────────────────────────────────────────
    async loadPresets() {
        return new Promise((resolve) => {
            const request = indexedDB.open('AutoCaptionDB', 1);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('presets')) {
                    db.createObjectStore('presets', { keyPath: 'name' });
                }
            };
            request.onsuccess = (e) => {
                this.db = e.target.result;
                const tx = this.db.transaction('presets', 'readonly');
                const store = tx.objectStore('presets');
                const getAll = store.getAll();
                getAll.onsuccess = () => {
                    this.presets = getAll.result;
                    this.populatePresetDropdown();
                    // Seed any factory preset the DB doesn't have yet (first
                    // run, or a preset added in a later version). Existing
                    // presets are never overwritten, so user edits survive.
                    this.loadFactoryPresets();
                    resolve();
                };
            };
            request.onerror = () => resolve();
        });
    },

    populatePresetDropdown() {
        const select = document.getElementById('sel-preset');
        select.innerHTML = '<option value="">-- Select Preset --</option>';
        this.presets.forEach(preset => {
            const opt = document.createElement('option');
            opt.value = preset.name;
            opt.textContent = preset.name;
            select.appendChild(opt);
        });
    },

    async loadFactoryPresets() {
        const presetFiles = [
            'presets/white-txt-bluebox.json',
            'presets/vcg-magenta-pop.json',
            'presets/classic-white.json',
            'presets/tiktok-bold.json'
        ];

        for (const file of presetFiles) {
            try {
                const resp = await fetch(file);
                if (resp.ok) {
                    const preset = await resp.json();
                    await this.savePresetToDB(preset);
                }
            } catch (e) {
                console.warn('Failed to load factory preset:', file, e);
            }
        }
        await this.loadPresets();
    },

    async savePresetToDB(preset) {
        return new Promise((resolve) => {
            if (!this.db) return resolve();
            const tx = this.db.transaction('presets', 'readwrite');
            const store = tx.objectStore('presets');
            store.put(preset);
            tx.oncomplete = () => resolve();
        });
    },

    async loadSelectedPreset() {
        const select = document.getElementById('sel-preset');
        const name = select.value;
        if (!name) return;

        const preset = this.presets.find(p => p.name === name);
        if (!preset) return;

        document.getElementById('sel-font').value = preset.font;
        document.getElementById('range-main-size').value = preset.mainSize;
        document.getElementById('range-main-size-num').value = preset.mainSize;
        document.getElementById('range-active-size').value = preset.activeSize;
        document.getElementById('range-active-size-num').value = preset.activeSize;
        document.getElementById('color-text').value = preset.textColor;
        document.getElementById('color-active').value = preset.activeColor;
        document.getElementById('chk-bold').checked = preset.activeWordBold;
        document.getElementById('chk-outline').checked = preset.effects.outline.enabled;
        document.getElementById('color-outline').value = preset.effects.outline.color;
        document.getElementById('range-outline-size').value = preset.effects.outline.size;
        document.getElementById('chk-shadow').checked = preset.effects.shadow.enabled;
        document.getElementById('color-shadow').value = preset.effects.shadow.color;
        // Shadow gained opacity/direction/distance/softness — migrate legacy
        // {size}-only presets to the equivalent new look.
        const sh = preset.effects.shadow;
        document.getElementById('range-shadow-opacity').value = sh.opacity != null ? sh.opacity : 100;
        document.getElementById('range-shadow-direction').value = sh.direction != null ? sh.direction : 45;
        document.getElementById('range-shadow-distance').value = sh.distance != null ? sh.distance : 2.83;
        document.getElementById('range-shadow-softness').value = sh.softness != null ? sh.softness : (sh.size != null ? sh.size : 5);
        document.getElementById('chk-glow').checked = preset.effects.glow.enabled;
        document.getElementById('color-glow').value = preset.effects.glow.color;
        document.getElementById('range-glow-size').value = preset.effects.glow.size;
        // activeBox is a newer preset field — fall back to defaults for old presets.
        const ab = preset.activeBox || { enabled: false, color: '#FF00CE', padding: 10, radius: 8 };
        document.getElementById('chk-active-box').checked = !!ab.enabled;
        document.getElementById('color-active-box').value = ab.color;
        document.getElementById('range-active-box-pad').value = ab.padding;
        document.getElementById('range-active-box-pad-num').value = ab.padding;
        document.getElementById('range-active-box-radius').value = ab.radius;
        document.getElementById('range-active-box-radius-num').value = ab.radius;
        document.getElementById('num-max-words').value = preset.grouping.maxWords;
        document.getElementById('num-max-seconds').value = preset.grouping.maxSeconds;
        document.getElementById('num-max-chars').value = preset.grouping.maxCharacters;
        // Migrate legacy {placement, offsetPx-from-bottom} presets to yPx.
        const pos = preset.position || {};
        const yPx = pos.yPx != null ? pos.yPx
            : pos.placement === 'bottom' ? 1080 - (pos.offsetPx ?? 220)
            : pos.placement === 'top' ? (pos.offsetPx ?? 100)
            : 540;
        document.getElementById('range-offset').value = yPx;
        document.getElementById('range-offset-num').value = yPx;
        this.syncPlacementDropdown(yPx);

        Object.assign(this.style, JSON.parse(JSON.stringify(preset)));
        this.style.activeBox = JSON.parse(JSON.stringify(ab));
        this.rebuildLayout();
        this.updatePreview();
        Status.success(`Preset loaded: ${name}`);
    },

    async savePreset() {
        const name = prompt('Preset name:');
        if (!name) return;

        const preset = {
            name: name,
            font: this.style.font,
            mainSize: this.style.mainSize,
            activeSize: this.style.activeSize,
            textColor: this.style.textColor,
            activeColor: this.style.activeColor,
            mainWeight: this.style.mainWeight,
            activeWordBold: this.style.activeWordBold,
            effects: JSON.parse(JSON.stringify(this.style.effects)),
            activeBox: JSON.parse(JSON.stringify(this.style.activeBox || { enabled: false, color: '#FF00CE', padding: 10, radius: 8 })),
            grouping: JSON.parse(JSON.stringify(this.style.grouping)),
            position: JSON.parse(JSON.stringify(this.style.position))
        };

        await this.savePresetToDB(preset);
        await this.loadPresets();
        document.getElementById('sel-preset').value = name;
        Status.success(`Preset saved: ${name}`);
    },

    async deletePreset() {
        const select = document.getElementById('sel-preset');
        const name = select.value;
        if (!name) return;

        if (!confirm(`Delete preset "${name}"?`)) return;

        return new Promise((resolve) => {
            const tx = this.db.transaction('presets', 'readwrite');
            const store = tx.objectStore('presets');
            store.delete(name);
            tx.oncomplete = async () => {
                await this.loadPresets();
                Status.success(`Preset deleted: ${name}`);
                resolve();
            };
        });
    },

    exportPreset() {
        const select = document.getElementById('sel-preset');
        const name = select.value;
        if (!name) return;

        const preset = this.presets.find(p => p.name === name);
        if (!preset) return;

        const json = JSON.stringify(preset, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name.replace(/\s+/g, '_')}.json`;
        a.click();
        URL.revokeObjectURL(url);
        Status.success(`Preset exported: ${name}`);
    },

    async importPreset(e) {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const preset = JSON.parse(text);
            if (!preset.name) return alert('Invalid preset file');

            await this.savePresetToDB(preset);
            await this.loadPresets();
            document.getElementById('sel-preset').value = preset.name;
            Status.success(`Preset imported: ${preset.name}`);
        } catch (err) {
            Status.error('Error importing preset: ' + err.message);
        }
    }
};

document.addEventListener('DOMContentLoaded', () => App.init());
