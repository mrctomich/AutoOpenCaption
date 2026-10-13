# Local Browser AutoCaption App — Execution Plan

**Target:** A single folder, zip-and-share, double-click-to-run captioning tool for Windows. No installers, no admin rights, no Python/Node/FFmpeg pre-installed on the user's machine. Everything — transcription, editing, styling, preview, and final MP4 export — runs locally in the user's existing browser.
A single folder, zip-and-share, double-click-to-run captioning tool for Windows. No installers, no admin rights, no Python/Node/FFmpeg pre-installed on the user's machine. Everything — transcription, editing, styling, preview, and final MP4 export — runs locally in the user's existing browser. Provide customer with one zip file and it has everything in it that they need. Needs to work in IT environment where user has zero admin rights and limited download capabilities.
This document is the build spec. Follow it phase by phase; each phase has a concrete deliverable and a "done when" check.

---

## 1. Architecture Summary

```
AutoCaptionApp/                  <- the folder the user unzips
├── Start AutoCaption.bat        <- double-click entry point
├── server/
│   └── serve.ps1                <- zero-dependency local web server (PowerShell HttpListener)
├── app/                         <- static built frontend (HTML/CSS/JS, no build step needed at runtime)
│   ├── index.html
│   ├── assets/                  <- bundled JS (transformers.js, ffmpeg.wasm core, fonts, icons)
│   └── presets/                 <- factory-default style presets (JSON)
├── LICENSES/                    <- FFmpeg, Transformers.js, font licenses
└── README.txt
```

**Why a local server instead of opening `index.html` directly:** Opening HTML straight from disk (`file://`) breaks WASM module loading in Chrome (CORS blocks `fetch()` of local files) and makes model caching unreliable across runs. Serving the same folder over `http://localhost` fixes both, and costs the user nothing — `Start AutoCaption.bat` launches a tiny server using PowerShell, which already ships on every Windows machine, then opens the default browser to `http://localhost:8743`. No binary to bundle, no install, no antivirus flags from an unsigned `.exe`.

**Core libraries (vendored into `app/assets/`, not loaded from a CDN, so the app works offline after the first model download):**
- **Transformers.js** (`@huggingface/transformers`) — runs Whisper in-browser via ONNX Runtime Web (WASM, with automatic WebGPU acceleration when available).
- **ffmpeg.wasm** (`@ffmpeg/ffmpeg` + `@ffmpeg/core`, single-thread build) — real FFmpeg compiled to WebAssembly, used only for final export muxing/encoding. Single-thread build needs no special server headers; we can upgrade to the multi-thread core later for speed since we control our own server's response headers.

**Whisper model:** default **`whisper-base`** (quantized ONNX, ~140 MB), downloaded once on first transcription and cached via the browser's Cache API under the `http://localhost:8743` origin — persists across runs as long as the user keeps the same folder and doesn't clear browser data. Model picker also offers tiny/small for users who want to trade speed vs. accuracy.

**Key design decision — one renderer for preview AND export:** Captions are drawn with the same `<canvas>`-based renderer in both places. Live preview draws the canvas over the `<video>` element in real time. Export renders the *same* canvas code to a sequence of transparent PNG frames, which FFmpeg overlays onto the source video. This guarantees the exported video looks pixel-identical to what the user saw in preview, and avoids depending on `libass` subtitle-burning support inside ffmpeg.wasm (which standard builds don't reliably include). See Phase 6 for the efficient frame-batching approach — we don't render 30 frames/sec for the whole video, only at caption state changes.

---

## 2. Data Model

### Transcript (word-level)
```json
{
  "version": 1,
  "sourceFile": "video.mp4",
  "language": "en",
  "words": [
    { "id": "w0001", "text": "Build", "start": 0.32, "end": 0.58, "deleted": false },
    { "id": "w0002", "text": "fast.", "start": 0.58, "end": 0.91, "deleted": false }
  ]
}
```
Editing operations (split word, merge words, retime, delete, retype text) all act on this array. SRT/VTT export and the caption grouping logic (max words / max seconds / max characters, matching the screenshot's "Grouping" panel) are pure functions over this same array — no extra library needed.

### Style preset
```json
{
  "name": "VCG Magenta Pop",
  "font": "Montserrat",
  "mainSize": 72,
  "activeSize": 78,
  "textColor": "#FFFFFF",
  "activeColor": "#FF00CE",
  "mainWeight": "bold",
  "activeWordBold": true,
  "effects": {
    "outline": { "enabled": true, "color": "#05050A", "size": 5 },
    "shadow":  { "enabled": false, "color": "#000000", "size": 5 },
    "glow":    { "enabled": false, "color": "#FF00CE", "size": 5 }
  },
  "grouping": { "maxWords": 4, "maxSeconds": 2.2, "maxCharacters": 32 },
  "position": { "placement": "bottom", "offsetPx": 220 }
}
```
Presets are stored in IndexedDB (origin-stable now that we're on localhost) and are also exportable/importable as plain `.json` files, so a user can carry a style between machines without depending on browser storage at all.

---

## 3. Phased Build Plan

### Phase 0 — Local server & app shell
- Write `server/serve.ps1`: a PowerShell `System.Net.HttpListener` script that serves `app/` statically on `http://localhost:8743`, sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (future-proofing for multi-thread ffmpeg.wasm), and correct MIME types for `.wasm`/`.js`.
- Write `Start AutoCaption.bat`: launches `powershell -ExecutionPolicy Bypass -File server\serve.ps1`, waits ~1s, opens `http://localhost:8743` in the default browser. Include a visible console window so the user can see it's running (and close it to stop the app).
- Build a minimal `index.html` shell with the four-panel layout from the reference screenshot: Preview, Caption Setup, Caption Style, Grouping/Effects/Position/Style Library.
- **Done when:** double-clicking the `.bat` opens a browser tab serving the static shell, no console errors, closing the console window stops the server.

### Phase 1 — Video import & preview player
- File picker (`<input type="file">` or drag-drop) loads the video into a `<video>` element via `URL.createObjectURL`.
- Transport controls: play/pause, scrub, current time readout (matches "Preview" panel).
- **Done when:** any local MP4/MOV can be loaded and scrubbed smoothly.

### Phase 2 — Audio extraction + transcription
- Use ffmpeg.wasm to extract a mono 16kHz WAV from the loaded video (Whisper's expected input format) — this also means we never depend on the browser's native container/codec decoding for the ASR step.
- Integrate Transformers.js: load `whisper-base` (configurable to tiny/small) via the `automatic-speech-recognition` pipeline with `return_timestamps: 'word'`. Show a progress UI for (a) first-time model download with byte progress, cached afterward, and (b) transcription progress.
- Map pipeline output into the word-level transcript JSON schema (Section 2).
- **Done when:** loading a video and clicking "Transcribe" produces a word-by-word transcript with timestamps, and re-running on a second video does **not** re-download the model.

### Phase 3 — Transcript editor
- Render the transcript as editable word chips with start/end times.
- Support: retype a word's text, nudge start/end time, delete a word, split a word into two, merge two words.
- Keep the data model (Section 2) as the single source of truth; the editor only mutates it.
- **Done when:** edits persist, undo is available for at least the last action, and the preview captions (Phase 5) reflect edits live.

### Phase 4 — SRT / VTT export
- Pure-JS formatter: group words per the active style's grouping rules (max words/seconds/characters) into caption cues, then emit standard SRT and WebVTT text, downloaded via a `Blob` link.
- **Done when:** exported `.srt`/`.vtt` opens correctly in VLC and validates against the SRT/VTT spec (correct timecodes, sequential cue numbers for SRT).
- **Note:** since the closed-caption file just needs the displayed text per cue (not the visual style), this phase has no rendering dependency — keep it decoupled from Phase 6's canvas renderer.

### Phase 5 — Caption style engine + live preview
- Build the shared canvas renderer: given the transcript, a timestamp, and a style preset, draw the current caption group onto a transparent canvas positioned over the video at the correct placement/offset, with the active word in `activeColor`/`activeSize`/bold per the preset, plus outline/shadow/glow effects (canvas `shadowBlur`/`shadowColor` for glow, multiple stroke passes for outline).
- Wire this renderer to the `<video>`'s `timeupdate`/`requestAnimationFrame` loop for live preview, matching the screenshot's WYSIWYG behavior.
- Build the Caption Style + Effects + Grouping + Position panels to edit a live preset object that feeds this renderer.
- **Done when:** preview captions visually match a preset's settings in real time, including active-word highlighting as the video plays.

### Phase 6 — Style Library (presets)
- Save/Load/Delete named presets to IndexedDB; "Save" snapshots the current style panel state, "Delete" matches the screenshot's button.
- Export/Import a preset as a `.json` file for portability between machines.
- Ship a few factory presets in `app/presets/` (e.g. "VCG Magenta Pop" from the screenshot) loaded on first run.
- **Done when:** presets persist across app restarts (same folder, same browser) and survive being exported/re-imported.

### Phase 7 — Export pipeline (burned-in MP4)
This is the most involved phase — break it into the following steps:

1. **Caption overlay rendering:** Instead of rendering every video frame, render one transparent PNG only at each *caption state change* (group change or active-word change — typically every 0.2–0.6s), using the Phase 5 canvas renderer at full source resolution. This keeps render time roughly proportional to word count, not video duration.
2. **Build a held-frame image sequence:** Use FFmpeg's `concat` demuxer with explicit per-frame durations (so each rendered PNG is held until the next state change) rather than encoding at a fixed fps — this avoids generating and encoding redundant identical frames.
3. **Composite onto source video:** `ffmpeg -i source.mp4 -f concat -i overlay_list.txt -filter_complex overlay -c:v libx264 -c:a copy out.mp4` (single ffmpeg.wasm invocation, run inside a Web Worker so the UI stays responsive, with progress reported via ffmpeg.wasm's progress event).
4. **Default export preset (req. #8):** detect source resolution and bitrate via `ffprobe`-equivalent (`ffmpeg -i` log parsing) and target a comparable `-b:v` (or a high constant `-crf 18` if bitrate detection is unreliable) so quality roughly matches the source; always `-c:v libx264`; attempt `-c:a copy` first and fall back to `-c:a aac -b:a 192k` if the source audio codec isn't valid in MP4 containers.
5. **Custom export presets:** allow resolution/bitrate/crf overrides as additional, named presets (separate from caption style presets) per req. #7.
- **Done when:** "Generate Video" produces an MP4 with burned-in styled captions, default settings preserve source resolution and roughly source quality, and audio passthrough is used whenever the source codec allows it.

### Phase 8 — Polish & packaging
- Error states: missing video, transcription failure, export failure — all surfaced in the UI, never a silent console error.
- Write `README.txt` covering: how to start the app, where models/presets are stored, how to fully reset (clear browser site data for `localhost:8743`), FFmpeg/Transformers.js license notices in `LICENSES/`.
- Final zip test: copy the whole folder to a machine with no dev tools installed, confirm cold-start works end to end (model download → transcribe → edit → style → export).
- **Done when:** a clean Windows machine, given only the zip, can go from "unzip" to "exported captioned MP4" with no extra setup.

---

## 4. Known Limitations to Set Expectations On
- First transcription of a video downloads the Whisper model (~140 MB for `base`); subsequent runs reuse the cache as long as the browser's site data for `localhost:8743` isn't cleared.
- WASM Whisper is slower than native `faster-whisper`/CTranslate2 on CPU; WebGPU (when available on the user's GPU/browser) closes much of that gap automatically — no UI toggle needed, it's auto-detected.
- Export speed scales with caption density (more word changes = more overlay frames) more than with raw video length, thanks to the held-frame approach in Phase 7.
- Browser default is Chrome/Edge for best WASM+WebGPU support; the app should still work on Firefox via the WASM CPU path.

---

## 5. What the Coding Agent Needs to Decide/Confirm Along the Way
- Exact ffmpeg.wasm filter syntax for the held-frame concat overlay (Phase 7, step 2) should be prototyped early with a short test clip before wiring it into the full UI — it's the highest-risk technical step in this plan.
- Confirm `whisper-base`'s actual quantized ONNX file size and first-run download time on a typical connection, and surface that number in the UI's first-run model-download prompt.
