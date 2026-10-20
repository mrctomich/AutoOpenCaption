AutoCaption - Local Browser Captioning Tool
==========================================

Quick Start
-----------
1. Double-click "Start AutoCaption.bat"
2. Your browser will open to http://localhost:8743
3. Click "Import Video" or drag a video onto the preview area
4. Click "Transcribe" to generate captions
5. Edit words, adjust timing, and style your captions
6. Click "Generate Video" to export with burned-in captions

Requirements
------------
- Windows 10 or later
- Chrome, Edge, or Firefox (Chrome/Edge recommended for WebGPU)
- No Python, Node.js, FFmpeg, or admin rights needed

Features
--------
- Local transcription using Whisper AI (runs in your browser)
- Word-level editing with timestamps
- Style presets (save/load/export)
- Live preview with active word highlighting
- Export to SRT/VTT subtitle files
- Export to MP4 with burned-in captions

How It Works
------------
AutoCaption uses WebAssembly versions of FFmpeg and Whisper AI that run
entirely in your browser. No data is sent to any server.

First-Time Use
--------------
The "base" Whisper model ships inside this zip (app/models/) and loads
automatically when the app opens — no download needed to transcribe with
base. The "tiny", "small", and "large" models download from Hugging Face
on first use and are cached in your browser afterward.

Managing models: app/models/ holds one folder per model —
whisper-tiny, whisper-base, whisper-small, whisper-large-v3-turbo — each
self-contained (config, tokenizer, and ONNX weights). Delete a folder to
free its disk space; the app shows "Download" for any model whose folder
is missing. To add a model by hand, drop its complete file tree into the
matching folder (the same files as the bundled whisper-base folder).
Browser-downloaded models are cached inside the browser (see "clear the
cache" below), separate from app/models/.

Note: presets are stored in your browser. After updating AutoCaption,
previously-saved presets from an older version persist; clear site data
(see below) and restart to load the current factory presets.

To clear the cache:
1. Open Chrome DevTools (F12)
2. Go to Application tab
3. Under Storage, click "Clear site data"

Model Selection
---------------
- tiny: ~65 MB, fastest, least accurate (downloads on first use)
- base: bundled in this zip, good balance (default, loads automatically)
- small: ~510 MB, accurate, slower (downloads on first use)
- large: ~3 GB, Whisper large-v3-turbo — best accuracy, still fast;
  needs a strong machine and a big one-time download (downloads on
  first use)

Export speed note: burned-in MP4 export runs FFmpeg single-threaded in
WebAssembly; a 3-minute 1080p clip can take 15-30+ minutes depending on
your CPU. The progress bar shows real encoding progress and the encode
can be cancelled mid-run.

Style Presets
-------------
Presets are saved in your browser's IndexedDB storage. To transfer
presets between machines:
1. Export preset as JSON
2. Import JSON on the other machine

Factory Presets
---------------
- VCG Blue Pop: #005288 highlight with outline (default)
- Classic White: Yellow highlight with shadow
- TikTok Bold: Red highlight, centered placement

Export Options
--------------
SRT/VTT: Standard subtitle files for use with any video player
MP4: Video with burned-in captions (styled exactly as in preview)

License
-------
This software uses:
- FFmpeg (LGPL/GPL) - https://ffmpeg.org
- Transformers.js (Apache 2.0) - https://github.com/huggingface/transformers.js
- ONNX Runtime Web (MIT) - https://onnxruntime.ai

See LICENSES/ directory for full license texts.

Troubleshooting
---------------
Problem: "Could not start the server on port 8743"
Solution: Another AutoCaption window (or program) is already using port 8743.
Just open http://localhost:8743 in your browser, or close the other window
and start again. Closing the AutoCaption console window stops its server.

Problem: Video won't load
Solution: Try a different video format (MP4 recommended)

Problem: Transcription is slow
Solution: Use the "tiny" model or ensure WebGPU is enabled in your browser

Problem: Export fails
Solution: Check that your video file isn't too large (try under 500MB)

Problem: Captions look wrong
Solution: Adjust font size and position in the Caption Style panel

Support
-------
For issues or questions, check the README.txt or contact the developer.