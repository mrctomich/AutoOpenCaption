import { FFmpegService } from './ffmpeg-service.js';
import { whisperToTranscript } from './whisper-adapter.js';
import { groupWords, findGroupAtTime, computeLayout, drawGroup, drawDiagnostics } from './caption-renderer.js';
import { installResumableFetch, isFileCached } from './resumable-fetch.js';

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

// HuggingFace's CDN drops long connections mid-file (net::ERR_CONNECTION_CLOSED
// a few hundred MB into the large model's encoder), and transformers.js has no
// resume: every dropout restarted the whole download and the tab eventually
// died. installResumableFetch wraps fetch() for huggingface.co downloads,
// spooling bytes to OPFS with automatic Range-retry resume (across drops AND
// page reloads — clicking Download again picks up where it stopped). Because
// the shim's OPFS files ARE the model cache, disable transformers.js's own
// CacheStorage layer: leaving it on made a second ~1 GB copy in memory.
if (navigator.storage && navigator.storage.getDirectory) {
    env.useBrowserCache = false;
    installResumableFetch({ log: (m) => console.info('[download]', m) });
} else {
    console.warn('OPFS unavailable in this browser — model downloads will not be resumable');
}

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
    _loadedBytes: 0,
    _totalBytes: 0,

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
        this._loadedBytes = 0;
        this._totalBytes = 0;
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
        this._loadedBytes = 0;
        this._totalBytes = 0;
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

    // Feed raw download byte counts (from transformers.js progress events
    // or estimated from the per-file fraction) so the elapsed line can
    // show MB downloaded and throughput — a single model is several files
    // and the per-file percentage alone tells you nothing about how much
    // is left overall.
    updateBytes(pct, loaded, total, status) {
        if (typeof loaded === 'number' && loaded > 0) this._loadedBytes = loaded;
        if (typeof total === 'number' && total > 0) this._totalBytes = total;
        this.update(pct, status);
    },

    hide() {
        this._overlay.classList.add('hidden');
        this._resetCancel();
        if (this._timer) cancelAnimationFrame(this._timer);
    },

    _updateElapsed() {
        if (this._timer) cancelAnimationFrame(this._timer);
        const fmtMB = (b) => `${(b / 1048576).toFixed(1)} MB`;
        const tick = () => {
            const totalSecs = Math.floor((performance.now() - this._startTime) / 1000);
            // HH:MM:SS — a 1 GB model download can legitimately pass an hour
            // on a slow connection, and mm:ss reads as "still 12 minutes"
            // after 72 have gone by.
            const hh = Math.floor(totalSecs / 3600);
            const mm = Math.floor((totalSecs % 3600) / 60);
            const ss = totalSecs % 60;
            const pad = (n) => String(n).padStart(2, '0');
            let line = `${pad(hh)}:${pad(mm)}:${pad(ss)} elapsed`;
            if (this._totalBytes > 0) {
                const rate = totalSecs > 0 ? this._loadedBytes / totalSecs : 0;
                line += ` — ${fmtMB(this._loadedBytes)} / ${fmtMB(this._totalBytes)}`;
                if (rate > 0) line += ` (${fmtMB(rate)}/s)`;
            }
            this._elapsed.textContent = line;
            if (!this._overlay.classList.contains('hidden')) {
                this._timer = requestAnimationFrame(tick);
            }
        };
        tick();
    }
};

// ── Model Status ────────────────────────────────────────────
// Customer-facing model name shown in the download dialog (the HF repo id
// "onnx-community/whisper-large-v3-turbo_timestamped" is not a name).
const MODEL_DISPLAY_NAMES = {
    'tiny': 'Whisper tiny',
    'base': 'Whisper base',
    'small': 'Whisper small',
    'large-v3-turbo': 'Whisper large-v3-turbo'
};
function modelDisplayName(modelId) {
    return MODEL_DISPLAY_NAMES[modelId] || `Whisper ${modelId}`;
}

// ── Model availability (Download vs Load) ─────────────────────────
// Where each model's files actually live on THIS machine:
//   'bundled' — a complete copy under app/models/ (ships inside the zip)
//   'cached'  — fully downloaded earlier and spooled to the OPFS cache by
//               the resumable-fetch shim (.part + complete sidecar)
//   null      — not on this machine; "Download" would fetch from the Hub
// The model button shows "Load" whenever the value is non-null, so a
// model that is already on disk never looks like it still needs a
// download — and a bundled copy that went missing (e.g. a release built
// without app/models/, or files evicted by the browser) honestly shows
// "Download" instead of a "Load" that could only fail.
const localAvailability = new Map();
const availabilityInFlight = new Map();

// Files a Whisper model must have present to run with zero network: the
// ONNX weights for the dtypes loadWhisper() requests (kept in sync with
// MODEL_FILE_SIZES) plus the smallest config/tokenizer set transformers.js
// always loads before inference.
const MODEL_SMALL_FILES = ['config.json', 'tokenizer.json'];

function modelRequiredFiles(modelId) {
    const onnx = Object.keys(App.MODEL_FILE_SIZES[modelId] || {});
    if (!onnx.length) return null;
    return [...MODEL_SMALL_FILES, ...onnx.map((f) => `onnx/${f}`)];
}

// Cheap probe — HEAD requests for the bundled candidates (never the
// 600 MB bodies) plus OPFS sidecar reads for the download cache. Results
// (and in-flight probes) are memoised; refresh=true re-checks after a
// failed load or a finished download so the button only ever gets fresher.
async function probeModelLocal(modelId, refresh = false) {
    if (!refresh && localAvailability.has(modelId)) return localAvailability.get(modelId);
    if (!refresh && availabilityInFlight.has(modelId)) return availabilityInFlight.get(modelId);
    const run = (async () => {
        let result = null;
        const files = modelRequiredFiles(modelId);
        if (files) {
            const repo = `onnx-community/whisper-${modelId}_timestamped`;
            try {
                let bundled = true;
                for (const f of files) {
                    const url = new URL(`${env.localModelPath}${repo}/${f}`, document.baseURI).href;
                    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
                    if (!res.ok || res.headers.get('content-length') === '0') { bundled = false; break; }
                }
                if (bundled) result = 'bundled';
            } catch { /* server refused / offline — treat as not bundled */ }
            if (!result && navigator.storage && navigator.storage.getDirectory) {
                let cached = true;
                for (const f of files) {
                    // Same URL shape transformers.js requests for this file
                    // (remotePathTemplate '{model}/resolve/{revision}/',
                    // default revision main) so the shim's cache key matches
                    // what a real download wrote.
                    const ok = await isFileCached(
                        `https://huggingface.co/${repo}/resolve/main/${f}`);
                    if (!ok) { cached = false; break; }
                }
                if (cached) result = 'cached';
            }
        }
        localAvailability.set(modelId, result);
        return result;
    })();
    availabilityInFlight.set(modelId, run);
    const settle = () => availabilityInFlight.delete(modelId);
    run.then(settle, settle);
    return run;
}

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
        // Probe where every model lives (bundled folder / download cache /
        // missing) before the first auto-load, so selector flips show the
        // right button instantly. Cheap: HEAD requests + OPFS sidecar reads.
        await this.warmModelAvailability();
        this.autoLoadDefaultModel();
    },

    // Probe every selectable model, bundled candidates first, so their
    // availability answers are cached by the time the user touches the
    // selector. Failures are non-fatal (a probe failure just means
    // "not on this machine").
    async warmModelAvailability() {
        for (const id of ['base', 'tiny', 'small', 'large-v3-turbo']) {
            try { await probeModelLocal(id); } catch { /* treat as not local */ }
        }
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
        // Effects sliders also get typed-number boxes (same pattern as above).
        syncSliderNumber('range-outline-size', 'range-outline-size-num');
        syncSliderNumber('range-shadow-opacity', 'range-shadow-opacity-num');
        syncSliderNumber('range-shadow-direction', 'range-shadow-direction-num');
        syncSliderNumber('range-shadow-distance', 'range-shadow-distance-num');
        syncSliderNumber('range-shadow-softness', 'range-shadow-softness-num');
        syncSliderNumber('range-glow-size', 'range-glow-size-num');
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
            btn.title = `${modelDisplayName(modelId)} is loaded and ready`;
            Pipeline.complete('model');
        } else {
            // The button doubles as Load: a model whose files are all on
            // this machine (bundled folder or finished download) needs no
            // download — it just loads into memory.
            const local = localAvailability.get(modelId) || null;
            btn.disabled = false;
            if (local) {
                btn.textContent = 'Load';
                btn.title = `${modelDisplayName(modelId)} is already on this machine (`
                    + `${local === 'bundled' ? 'bundled files' : 'previous download'}) — click to load it`;
                ModelStatus.set('cached', local === 'bundled' ? 'Bundled' : 'Downloaded');
            } else {
                btn.textContent = 'Download';
                btn.title = 'Download model for offline use';
                ModelStatus.clear();
            }
            this._availShown = { model: modelId, value: local };
            Pipeline.undo('model');
        }
        // Show the toolbar Transcribe shortcut once a model is resident and
        // a video is loaded.
        transcribeBtn.hidden = loadedModelId === null;
        transcribeBtn.disabled = !this.videoFile;

        // Availability is answered asynchronously (HEAD + OPFS reads). Fire
        // a probe only when this model's answer is still unknown; the
        // re-render it triggers records the value in _availShown, so the
        // render→probe→render cycle settles after one pass per model.
        const shown = this._availShown;
        if (loadedModelId !== modelId && (!shown || shown.model !== modelId)) {
            probeModelLocal(modelId).then(() => {
                if (loadedModelId !== modelId
                        && document.getElementById('sel-model').value === modelId) {
                    this.updateModelStatus();
                }
            });
        }
    },

    // The base model normally ships inside the zip (app/models/) — load it
    // silently in the background at startup so the first transcription
    // needs no download. If this install has no bundled copy (a release
    // built without app/models/, or files evicted by the browser), say so
    // and leave the button on "Download" — base can be fetched once and
    // cached like any other model now, instead of failing forever with
    // "local_files_only=true ... not found locally".
    async autoLoadDefaultModel() {
        const modelId = 'base';
        const local = await probeModelLocal(modelId);
        if (!local) {
            Status.warning('Bundled base model files were not found in this install — press Download next to the model selector to fetch base once');
            return;
        }
        try {
            Status.setActive('Loading base model...');
            await this.loadWhisper(modelId, null);
            Status.clearActive();
            Status.success('Base model ready — loaded from '
                + (local === 'bundled' ? 'bundled files' : 'the local download cache')
                + ', no download needed');
        } catch (err) {
            Status.clearActive();
            Status.warning(`Base model failed to load (${err.message}) — it will be loaded on first transcription`);
        }
    },

    // Shared Whisper loader used by the model button, auto-load, and Transcribe.
    async loadWhisper(modelId, progressCallback) {
        const modelName = `onnx-community/whisper-${modelId}_timestamped`;
        // large-v3-turbo must use the quantized encoder: its fp32 encoder is
        // a 0.5 MB stub whose weights live in a separate 2.4 GB
        // encoder_model.onnx_data file that bypasses progress reporting (bar
        // jumped to 100% after the decoder while the data file still streamed
        // uncounted, and Cancel never fired). The _quantized encoder is one
        // self-contained 615 MB file, so the whole model is ~1.04 GB and
        // every byte is tracked.
        const dtype = modelId === 'large-v3-turbo'
            ? 'q8'
            : { encoder_model: 'fp32', decoder_model_merged: 'q8' };
        const build = () => pipeline(
            'automatic-speech-recognition',
            modelName,
            {
                dtype: dtype,
                progress_callback: progressCallback || undefined
            }
        );
        // A model whose files are ALL on this machine — the bundled folder
        // or a finished resumable download — loads with
        // allowRemoteModels = false: instant, and works with no internet
        // at all. When the probe finds files missing, keep the Hub enabled
        // so the click can actually fetch them (this is what used to break
        // "base": a hardcoded local-only rule turned a missing bundled file
        // into a Download button that could never succeed).
        let local = await probeModelLocal(modelId);
        env.allowRemoteModels = !local;
        try {
            whisperPipeline = await build();
        } catch (err) {
            // The probe said the files were here but the load still failed
            // (the browser evicted part of the cache since the probe, for
            // example). Fall back once to the Hub instead of dead-ending
            // the user; missing files re-download through the resumable
            // shim and complete the cache.
            if (!local) throw err;
            localAvailability.set(modelId, null);
            env.allowRemoteModels = true;
            whisperPipeline = await build();
        }
        loadedModelId = modelId;
        // Every file is on disk now — bundled or freshly downloaded and
        // spooled by the shim. Remember it so the button offers "Load"
        // again even after this model is swapped out and back.
        localAvailability.set(modelId, local || 'cached');
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

    // Verified per-file download sizes (bytes) for exactly the files each
    // model loads with the dtypes in loadWhisper() — large-v3-turbo uses
    // q8 for both ONNX files, the others an fp32 encoder + q8 decoder.
    // Measured live from the Hugging Face file trees (onnx-community/
    // whisper-<id>_timestamped, October 2026). Seeding totals from this
    // map means the progress bar divides by the REAL model size from the
    // first byte — no guessing at files that haven't reported a size yet
    // (the old placeholder heuristic ran 25% when half the bytes were
    // already down) — and files served from the browser cache count as
    // completed bytes instead of vanishing from both sides of the ratio.
    MODEL_FILE_SIZES: {
        'large-v3-turbo': {
            'encoder_model_quantized.onnx': 644883359,
            'decoder_model_merged_quantized.onnx': 439997434,
        },
        'small': {
            'encoder_model.onnx': 352791798,
            'decoder_model_merged_quantized.onnx': 156795750,
        },
        'base': {
            'encoder_model.onnx': 82451730,
            'decoder_model_merged_quantized.onnx': 53712708,
        },
        'tiny': {
            'encoder_model.onnx': 32894434,
            'decoder_model_merged_quantized.onnx': 30730264,
        },
    },

    // Shared model-download progress callback. A model is several files;
    // transformers.js reports per-file progress with loaded/total BYTES, so
    // we accumulate across files — otherwise the bar jumps to 100% when the
    // first (small) file finishes while the big encoder is still going.
    makeModelProgressCallback(modelId, isCancelled, basePct = 0, spanPct = 100) {
        const seeded = this.MODEL_FILE_SIZES[modelId] || {};
        const files = {};   // name -> { loaded, total, done }
        // Seed EVERY known file up front, not just when an event first
        // touches it: the denominator is exact from the very first event
        // (no false 100% when a tiny config file completes before the
        // ONNX files have even been initiated), and a cached file firing
        // 'ready' while others are still pending cannot fake all-done.
        for (const [name, size] of Object.entries(seeded))
            files[name] = { loaded: 0, total: size, done: false };
        let shownFrac = 0;  // high-water bar fraction (see show())
        const touch = (name) => files[name] || (files[name] = {
            loaded: 0, total: seeded[name] || 0, done: false,
        });
        const overall = () => {
            let loaded = 0, total = 0, allDone = true;
            for (const f of Object.values(files)) {
                loaded += f.loaded;
                total += f.total;
                if (!f.done) allDone = false;
            }
            return { loaded, total, allDone };
        };
        // Bar fraction = bytes arrived / total across all files. Seeded
        // sizes (above) make that total exact for our models the instant
        // any file touches; config/tokenizer files report their real size
        // on their first progress event. A file whose size stays unknown
        // counts on neither side, so the fraction never overstates. Until
        // every file reports done the bar is capped at 99.5% — 100% is
        // reserved for the all-done moment, never earlier. The high-water
        // mark only smooths tiny self-corrections as real sizes replace
        // seeds; it cannot lock in a false 100% because of the cap.
        const show = () => {
            const { loaded, total, allDone } = overall();
            let frac = total > 0 ? loaded / total : 0;
            if (frac > 1) frac = 1;
            if (!allDone && frac > 0.995) frac = 0.995;
            if (frac > shownFrac) shownFrac = frac;
            return { loaded, total, allDone };
        };
        return (progress) => {
            if (isCancelled()) throw { __cancelled: true };
            // progress.file looks like "onnx/decoder_model_merged_q8.onnx" —
            // show just the file name, the full path is noise in the status line.
            const name = (progress.file || progress.name || 'file').split('/').pop();
            const rec = touch(name);
            if (progress.status === 'initiate' || progress.status === 'download') {
                const o = show();
                Progress.updateBytes(basePct + shownFrac * spanPct, o.loaded, o.total,
                    `Fetching ${name}...`);
            } else if (progress.status === 'progress') {
                if (typeof progress.loaded === 'number') rec.loaded = progress.loaded;
                if (typeof progress.total === 'number' && progress.total > 0) rec.total = progress.total;
                const o = show();
                Progress.updateBytes(basePct + shownFrac * spanPct, o.loaded, o.total,
                    `Downloading ${modelDisplayName(modelId)}: ${Math.round(shownFrac * 100)}% (${name})`);
            } else if (progress.status === 'done') {
                // 'progress' events throttle and can end below total; a
                // finished file's real size is its total (or its last
                // loaded count when the size was never reported).
                if (rec.total > 0) rec.loaded = rec.total;
                else if (rec.loaded > 0) rec.total = rec.loaded;
                rec.done = true;
                const o = show();
                Progress.updateBytes(basePct + shownFrac * spanPct, o.loaded, o.total,
                    `Finished ${name}`);
            } else if (progress.status === 'ready' || progress.status === 'loading') {
                // 'ready' fires PER FILE as each one lands in memory. A
                // file served from the browser cache fires it without ever
                // reporting bytes — count it as fully downloaded (its seed
                // size) so the bar still reflects the whole model when only
                // part of it needs fetching. "Loading into memory..." is
                // claimed only once every file is done, never mid-download.
                if (rec.total > 0 && rec.loaded === 0) rec.loaded = rec.total;
                rec.done = true;
                const o = show();
                Progress.updateBytes(basePct + shownFrac * spanPct, o.loaded, o.total,
                    o.allDone ? 'Loading into memory...' : `${name} ready`);
            }
        };
    },

    // ── Model Button (Download / Load) ──────────────────────
    async downloadModel() {
        const modelId = document.getElementById('sel-model').value;
        const modelName = `onnx-community/whisper-${modelId}_timestamped`;
        const btn = document.getElementById('btn-download-model');

        // Re-check where the files live before deciding what this click
        // means: a model fully present on this machine LOADS from disk
        // with no network; anything else downloads from the Hub through
        // the resumable shim. (The button label already reflects the last
        // probe; this refresh catches files that arrived since — another
        // tab, a finished partial, or a bundle copied in by hand.)
        const local = await probeModelLocal(modelId, true);

        // large-v3-turbo is a ~1 GB download (quantized) — confirm before starting.
        if (!local && modelId === 'large-v3-turbo') {
            const ok = confirm(
                'The "large" model (Whisper large-v3-turbo) is a ~1 GB download ' +
                'that is cached on this machine. It gives the best transcription ' +
                'accuracy but needs a strong machine and a strong connection.\n\n' +
                'If the download is ever interrupted, just click Download again — ' +
                'it resumes from where it stopped instead of starting over.\n\n' +
                'Download now?'
            );
            if (!ok) return;
        }

        let cancelled = false;

        try {
            btn.disabled = true;
            btn.textContent = local ? 'Loading...' : 'Downloading...';
            ModelStatus.set('downloading', local ? 'Loading' : 'Downloading');
            Pipeline.activate('model');
            Status.setActive(local
                ? `Loading ${modelDisplayName(modelId)}...`
                : `Downloading ${modelName}...`);

            // Ask the browser to protect the OPFS download cache from eviction
            // (must be requested from a user gesture — this is one).
            if (navigator.storage && navigator.storage.persist) {
                try { await navigator.storage.persist(); } catch { /* non-fatal */ }
            }

            // Initial line shows the customer-facing name and the expected
            // total size; exact byte totals appear within seconds once the
            // first files report their Content-Length.
            const SIZE_HINTS = { 'tiny': '~65 MB', 'base': '~136 MB',
                'small': '~490 MB', 'large-v3-turbo': '~1.04 GB' };
            Progress.showProgress(
                local ? 'Loading Model' : 'Downloading Model',
                local
                    ? `${modelDisplayName(modelId)} — reading from `
                        + `${local === 'bundled' ? 'bundled files' : 'the local download cache'}`
                    : `${modelDisplayName(modelId)} — ${SIZE_HINTS[modelId] || 'size unknown'}`,
                () => {
                // Throwing from the next progress event unwinds the stream
                // reader inside transformers.js and closes the connection.
                cancelled = true;
            });
            // Transformers.js v3 progress statuses: initiate | download | progress | done | ready.
            const progressCallback = this.makeModelProgressCallback(modelId, () => cancelled);

            await this.loadWhisper(modelId, progressCallback);

            Progress.hide();
            Status.clearActive();
            Status.success(`Model ${modelId} ready for transcription`);
        } catch (err) {
            Progress.hide();
            Status.clearActive();
            if (err && err.__cancelled) {
                Status.warning(`Download of ${modelId} cancelled — progress saved, Download will resume from where it stopped`);
            } else {
                Status.error(`Model load failed: ${err.message}`);
                // Bytes downloaded so far are spooled to disk by the resumable
                // fetch layer, so a retry (or reopening the app) continues.
                if (!local) {
                    Status.warning('Partial download progress is saved — clicking Download again resumes from where it stopped');
                }
            }
            // Whatever the probe believed may be stale now — re-check so the
            // button shows the truth (Download vs Load) on the next look.
            await probeModelLocal(modelId, true);
            this.updateModelStatus();
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
                // Load-from-disk vs download, same rule as the model button.
                const local = await probeModelLocal(modelId);
                Progress.showProgress(local ? 'Loading Model' : 'Downloading Model',
                    local
                        ? `${modelDisplayName(modelId)} — reading from `
                            + `${local === 'bundled' ? 'bundled files' : 'the local download cache'}...`
                        : 'First run downloads from HuggingFace...',
                    () => { cancelled = true; });
                // Accumulates bytes across all model files (base 10% → 50% span).
                const progressCallback = this.makeModelProgressCallback(modelId, () => cancelled, 10, 40);
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
            if (transcript.repairedTimestamps > 0) {
                Status.warning(`${transcript.repairedTimestamps} word${transcript.repairedTimestamps === 1 ? '' : 's'} had collapsed timestamps (music/speech overlap) — timing interpolated automatically`);
            }

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
            const end = this.formatSRTTime(Math.max(group.end, group.start + 0.1));
            const text = group.words.map(w => w.text).join(' ');
            return `${i + 1}\n${start} --> ${end}\n${text}`;
        }).join('\n\n');
    },

    generateVTT() {
        if (!this.captionGroups.length) return 'WEBVTT\n\n';
        const cues = this.captionGroups.map(group => {
            const start = this.formatVTTTime(group.start);
            const end = this.formatVTTTime(Math.max(group.end, group.start + 0.1));
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
            request.onsuccess = async (e) => {
                this.db = e.target.result;
                // Seed missing factory presets FIRST (insert-only), then read
                // the list once. Previously this called loadFactoryPresets()
                // which itself called loadPresets() — an infinite loop that
                // kept rebuilding the dropdown and reset the user's
                // selection back to "-- Select Preset --".
                await this.seedFactoryPresets();
                const tx = this.db.transaction('presets', 'readonly');
                const store = tx.objectStore('presets');
                const getAll = store.getAll();
                getAll.onsuccess = () => {
                    this.presets = getAll.result;
                    this.populatePresetDropdown();
                    resolve();
                };
                getAll.onerror = () => resolve();
            };
            request.onerror = () => resolve();
        });
    },

    populatePresetDropdown() {
        const select = document.getElementById('sel-preset');
        const previous = select.value;
        select.innerHTML = '<option value="">-- Select Preset --</option>';
        this.presets.forEach(preset => {
            const opt = document.createElement('option');
            opt.value = preset.name;
            opt.textContent = preset.name;
            select.appendChild(opt);
        });
        // Keep the current selection across a rebuild (e.g. after save or
        // import) as long as the preset still exists.
        if (previous && this.presets.some(p => p.name === previous)) {
            select.value = previous;
        }
    },

    async seedFactoryPresets() {
        const presetFiles = [
            'presets/white-txt-bluebox.json',
            'presets/vcg-magenta-pop.json',
            'presets/classic-white.json',
            'presets/tiktok-bold.json'
        ];

        // Insert-only: existing presets are never overwritten, so user
        // edits and deletions survive app restarts.
        const existing = await new Promise((resolve) => {
            const tx = this.db.transaction('presets', 'readonly');
            const getAllKeys = tx.objectStore('presets').getAllKeys();
            getAllKeys.onsuccess = () => resolve(new Set(getAllKeys.result));
            getAllKeys.onerror = () => resolve(new Set());
        });

        for (const file of presetFiles) {
            try {
                const resp = await fetch(file);
                if (!resp.ok) continue;
                const preset = await resp.json();
                if (existing.has(preset.name)) continue;
                await this.savePresetToDB(preset);
            } catch (e) {
                console.warn('Failed to load factory preset:', file, e);
            }
        }
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
        document.getElementById('range-outline-size-num').value = preset.effects.outline.size;
        document.getElementById('chk-shadow').checked = preset.effects.shadow.enabled;
        document.getElementById('color-shadow').value = preset.effects.shadow.color;
        // Shadow gained opacity/direction/distance/softness — migrate legacy
        // {size}-only presets to the equivalent new look.
        const sh = preset.effects.shadow;
        const shOpacity = sh.opacity != null ? sh.opacity : 100;
        const shDirection = sh.direction != null ? sh.direction : 45;
        const shDistance = sh.distance != null ? sh.distance : 2.83;
        const shSoftness = sh.softness != null ? sh.softness : (sh.size != null ? sh.size : 5);
        document.getElementById('range-shadow-opacity').value = shOpacity;
        document.getElementById('range-shadow-opacity-num').value = shOpacity;
        document.getElementById('range-shadow-direction').value = shDirection;
        document.getElementById('range-shadow-direction-num').value = shDirection;
        document.getElementById('range-shadow-distance').value = shDistance;
        document.getElementById('range-shadow-distance-num').value = shDistance;
        document.getElementById('range-shadow-softness').value = shSoftness;
        document.getElementById('range-shadow-softness-num').value = shSoftness;
        document.getElementById('chk-glow').checked = preset.effects.glow.enabled;
        document.getElementById('color-glow').value = preset.effects.glow.color;
        document.getElementById('range-glow-size').value = preset.effects.glow.size;
        document.getElementById('range-glow-size-num').value = preset.effects.glow.size;
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
