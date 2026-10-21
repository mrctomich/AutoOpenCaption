# Manual word-sync verification (transformers.js path)

The original bug report pointed at collapsed word runs at **00:01:09.980**
(John-Oliver clip) and **00:02:49.980** (Games-popups clip) in transcripts
produced by the in-app transformers.js pipeline. Those coordinates come from
the browser ONNX alignment; the headless test suite covers the repair
machinery on real whisper.cpp data (`tests/real-audio-sanitize.test.mjs` +
`tests/fixtures/john_whispercpp_raw.json` + `tests/fixtures/games_whispercpp_raw.json`),
but reproducing the exact zones requires the app itself:

1. Open AutoCaption (dev build), load `john.mp4` and the Games-popups video.
2. Transcribe both with the current build (model cache may need a clear if
   a stale tokenizer/alignment cache was used before).
3. Export SRT and search for the two timecodes:
   - a healthy repair looks like distinct increasing `start/end` around the
     timecode, matching the spoken words when played back;
   - an `unplaced` run (see the warning toast / `transcript.timing.unplaced`)
     keeps zero-length words — the renderer still shows the group, but the
     timestamps are honestly unknown; treat those boundaries as estimates.
4. In DevTools, inspect `transcript.timing` after a run:
   `{ runs, repaired, estimated, unplaced, hasEstimates }`. Every repaired
   word carries `estimated`, `estimatedReason`, and the raw model stamps in
   `originalStart` / `originalEnd` — compare them against the exported
   timecodes to see exactly what was interpolated.

## Known limitation (by design)

`sanitizeWords()` guarantees *structural* correctness only — positive
durations, valid ordering, no expansion past the audio duration or the next
valid word. A repaired boundary is an estimate weighted by word length, not
verified speech alignment. For substantial failures (many repaired runs, or
`unplaced > 0`) the recovery path is forced alignment against the original
audio; candidates: whisper.cpp `-dtw <ctc-model>` (needs a separate CTC
model, not bundled) or WhisperX/stable-ts wav2vec2 alignment (Python-side).
Until one is integrated, such regions stay flagged `estimated` and should be
reported to the user as timing estimates, not real alignments.
