# AutoOpenCaption — Handoff Document

## Project Overview
A local-only, zero-install browser-based video captioning tool. Users unzip a folder, double-click `Start AutoOpenCaption.bat`, and a local PowerShell server runs at `http://localhost:8743`. Everything (transcription, editing, styling, preview, export) runs in-browser via WebAssembly (FFmpeg + Whisper via Transformers.js). No admin access, Python, Node, or FFmpeg required.

**Core constraint:** Everything must live in a single folder that can be zipped, moved, and unzipped on any Windows machine with zero install. No internet required after first model download.

## Architecture

### FFmpeg Integration
Custom 3-layer wrapper around `@ffmpeg/core` directly (NOT `@ffmpeg/ffmpeg`):

```
app.js -> FFmpegService -> FFmpegWrapper (wrapper.js) -> Worker (worker.js) -> @ffmpeg/core WASM
```

- **`app/ffmpeg/worker.js`** (90 lines): Web worker. Receives URLs via LOAD message.
- **`app/ffmpeg/wrapper.js`** (129 lines): Main-thread class wrapping worker communication.
- **`app/assets/ffmpeg-service.js`** (59 lines): App-level singleton. Rest of app imports only this.
- **`app/wasm/ffmpeg-core.js`** + **`ffmpeg-core.wasm`**: `@ffmpeg/core@0.12.6` UMD build (vendored, 30.7 MB wasm).

### Transformers.js Integration
- `transformers.umd.js` (827 KB) loaded via `<script type="module">` in `index.html`
- Exposes `window.TransformersPipeline` and `window.TransformersEnv` globals
- `app.js` waits for `transformers-loaded` event before using them

### Server
- `server/serve.ps1`: PowerShell HttpListener on port 8743
- Serves from `app/` directory
- Has COOP/COEP headers (for SharedArrayBuffer future support)
- Has CORS, Accept-Ranges, proper MIME types

## CRITICAL BUG: Path Resolution in Worker

**This is the primary bug preventing the app from working.**

The worker is at `app/ffmpeg/worker.js`. When it calls `importScripts(coreURL)`, the browser resolves `coreURL` relative to the **worker's location** (`app/ffmpeg/`), NOT relative to the HTML page (`app/`).

Currently `ffmpeg-service.js` sets:
```javascript
const WASM_CORE_URL = 'wasm/ffmpeg-core.js';      // WRONG
const WASM_BINARY_URL = 'wasm/ffmpeg-core.wasm';   // WRONG
const WORKER_URL = 'ffmpeg/worker.js';              // correct (resolved from HTML page)
```

When the worker at `app/ffmpeg/worker.js` calls `importScripts('wasm/ffmpeg-core.js')`, the browser looks for `app/ffmpeg/wasm/ffmpeg-core.js` — **which does not exist**. The actual file is at `app/wasm/ffmpeg-core.js`.

**The fix** is to change the paths in `ffmpeg-service.js` to be relative to the worker's location:
```javascript
const WASM_CORE_URL = '../wasm/ffmpeg-core.js';     // FIXED
const WASM_BINARY_URL = '../wasm/ffmpeg-core.wasm';  // FIXED
const WORKER_URL = 'ffmpeg/worker.js';               // correct (resolved from HTML page)
```

The `WORKER_URL` is correct because `new Worker(WORKER_URL)` is called from the main thread, where URLs resolve relative to the HTML document at `app/index.html`.

## Other Known Issues

### 1. COEP Header May Block Transformers.js Fetches
The server sends `Cross-Origin-Embedder-Policy: require-corp`. This means any subresource loaded by `transformers.umd.js` (e.g., ONNX model downloads from HuggingFace) must either:
- Come from the same origin, OR
- Have a `Cross-Origin-Resource-Policy: cross-origin` header from the remote server

Since Transformers.js downloads models from `huggingface.co`, those responses need the CORP header. If huggingface.co doesn't send it, the COEP header will block the download. The fix options are:
- Remove COEP entirely (breaks future multi-thread FFmpeg but allows model downloads)
- Change COEP to `credentialless` instead of `require-corp` (more permissive)
- Set `Cross-Origin-Resource-Policy: cross-origin` only on specific paths served locally

**Recommended:** Change COEP to `credentialless` in `serve.ps1`.

### 2. Caption Text Centering Inconsistency
- `renderCaptions()` (live preview, line 259): Draws all words at `x = width / 2` with `textAlign: center`, then increments x — causing words to overlap at the center point.
- `renderCaptionsToCtx()` (export, line 740): Correctly measures total width first, then starts drawing from `(width - totalWidth) / 2`.
- **Fix:** Make `renderCaptions()` use the same centering logic as `renderCaptionsToCtx()`.

### 3. Factory Presets Not in Files
Factory presets are hardcoded in `app.js` `loadFactoryPresets()` (line 880) instead of being JSON files in `app/presets/`. The execution plan intended them to be separate files loaded on first run.

### 4. No Merge Button in UI
`mergeWithNext()` method exists at line 1232 of `app.js` but has no button in the HTML to trigger it.

### 5. `_lastFrames` Never Set
In `encodeVideo()` (line 837), the code does `for (const frame of this._lastFrames || [])` but `_lastFrames` is never assigned. This means the frame cleanup after encoding silently does nothing — frame PNGs are never cleaned up from the FFmpeg virtual filesystem. The fix is to store the frames array before encoding.

### 6. `export default` in ffmpeg-core.js May Need Handling
The vendored `app/wasm/ffmpeg-core.js` (UMD) does NOT have `export default` at the end (good — it's UMD, not ESM). But the worker tries `(await import(coreURL)).default` in the catch block as a fallback for module workers. Since the worker is created as a classic worker (no `{ type: 'module' }`), `importScripts` should succeed and the `import()` fallback should never execute. Verify this works.

## File Structure
```
AutoOpenCaptionApp/
├── Start AutoOpenCaption.bat
├── server/
│   └── serve.ps1
├── app/
│   ├── index.html
│   ├── assets/
│   │   ├── app.js (1245 lines, 47 KB)
│   │   ├── ffmpeg-service.js (59 lines, 1.4 KB)
│   │   ├── style.css
│   │   └── transformers.umd.js (827 KB)
│   ├── ffmpeg/
│   │   ├── wrapper.js (129 lines, 3.8 KB)
│   │   └── worker.js (90 lines, 2.4 KB)
│   ├── wasm/
│   │   ├── ffmpeg-core.js (112 KB, @ffmpeg/core@0.12.6 UMD)
│   │   └── ffmpeg-core.wasm (30.7 MB)
│   └── presets/ (empty)
├── LICENSES/
└── handoff.md
```

## What to Fix (Priority Order)

1. **FIX THE PATH BUG in `ffmpeg-service.js`**: Change `WASM_CORE_URL` and `WASM_BINARY_URL` to use `../wasm/` prefix so they resolve correctly from the worker's location.

2. **Fix COEP header** in `serve.ps1`: Change `require-corp` to `credentialless` so Transformers.js can download ONNX models from HuggingFace.

3. **Fix caption centering** in `renderCaptions()`: Use the same `(width - totalWidth) / 2` approach as `renderCaptionsToCtx()`.

4. **Fix frame cleanup**: Store `frames` as `this._lastFrames` in `generateVideo()` before passing to `writeFramesToFFmpeg()`.

5. **Add merge button** to HTML and wire it up.

6. **Move factory presets** to `app/presets/*.json` files.

## Key Files to Read
- `app/assets/ffmpeg-service.js` — has the path bug (line 13-14)
- `app/ffmpeg/worker.js` — the worker that resolves paths
- `app/assets/app.js` — main application (1245 lines)
- `server/serve.ps1` — has COEP header issue (line 45)
- `autoopencaption-web-execution-plan.md` — original design spec

## Verification Steps
After fixing, verify:
1. Console shows "FFmpeg loaded successfully" (not "FFmpeg failed to load")
2. Import a video file works
3. Click "Transcribe" — model downloads and transcription completes
4. "Generate Video" produces a downloadable MP4
5. No CORS/COEP errors in console
6. All paths in Network tab resolve to `localhost:8743`, no 404s

## Suggested Skills
- `pinokio` — if user wants to discover related tools
