# Interactive Waveform & Caption Timeline Editor — Progress

**PR branch:** `feature/interactive-timeline-editor`
**Repository:** https://github.com/mrctomich/AutoOpenCaption (app lives in `AutoOpenCaptionApp/`)

This document is the persistent handoff for a phased implementation. Read
**"How to resume"** first. Each phase appends a record here and then STOPS —
the next phase only starts when the user authorizes it in a fresh session.

---

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Repository investigation & technical design | **DONE 2026-10-27** (this document) |
| 2 | Timeline panel foundation: ruler, waveform, scroll, zoom, playhead | not started |
| 3 | Caption boxes + selection sync + double-click seek | not started |
| 4 | Direct caption timing edits (drag move, edge resize) | not started |
| 5 | Create missing captions/words, undo/redo integration | not started |
| 6 | Integration, regression testing, polish | not started |

## How to resume (fresh session)

1. `cd AutoOpenCaptionApp && node --test tests/*.test.mjs` — must be **63 pass / 0 fail** before starting (baseline verified 2026-10-27 on this branch; Phase 1 changed no code).
2. Read this file (architecture + design below) — do not re-explore the repo from scratch.
3. Begin the next unchecked phase above. Finish its tests, append its record, STOP.
4. Push note: plain `git push` hangs here (Git Credential Manager prompt with no TTY). Working command:
   `GIT_TERMINAL_PROMPT=0 git -c credential.helper= push "https://x-access-token:$(gh auth token)@github.com/mrctomich/AutoOpenCaption.git" feature/interactive-timeline-editor`

---

## Phase 1 findings — current architecture

Static site, **no framework, no bundler**: `app/index.html` + ESM modules under
`app/assets/`. All mutable UI state hangs off one global object literal,
`App` (`app.js`, 2717 lines). Helper singletons: `Status`, `Progress`,
`Pipeline`, `ModelStatus`.

### Caption data model (the single source of truth)

- `App.transcript = { version, sourceFile, language, words: Word[], info?, timing? }`
  built by `whisperToTranscript()` (`whisper-adapter.js`).
- `Word = { id, text, start, end, deleted, originalStart, originalEnd,
  estimated?, estimatedReason?, unplaced?, userAdjusted?, origText?,
  origStart?, origEnd? }`. Times are **floating-point seconds**. Array order is
  authoritative playback order; `id` is a unique tag (`splitWord` re-ids, so
  ids are not sorted — new words must take `max(id)+1`).
- `originalStart/End` hold raw model stamps; `estimated` marks interpolated
  timings; `timing = { runs, repaired, estimated, unplaced, hasEstimates }`
  is the sanitize summary.
- **User-adjustment protection** (`isWordAdjusted`, app.js:2034): a word is
  user-adjusted if `userAdjusted` is set (split/merge set it) **or** its
  text/start/end drifted from `origText/origStart/origEnd` (stamped after
  transcription, app.js:1592–1594). `ctc-apply.js` (`skipUserAdjusted`,
  default **true**) refuses to overwrite such words during CTC realign.
  Timeline edits must never clear these fields; timing drift from the
  `orig*` stamps automatically protects moved words from CTC overwrite.

### Derived state (never edit)

- `App.captionGroups = groupWords(words, style.grouping)` (caption-renderer.js:13)
  — filters `deleted`, splits on `maxWords`/`maxSeconds` (gap measured from
  **group start**)/`maxCharacters`, and clamps emitted `end ≥ start + 0.1`
  (renderer-only clamp; stored data untouched). **SRT/VTT export and the
  preview canvas both consume `captionGroups`** — after any word mutation the
  existing paths call `rebuildLayout()` then re-render; the timeline must
  follow the same rule.
- `App.captionLayout = computeLayout(...)` — pixel geometry for the preview
  canvas only.

### Word editor & timestamp update paths

- `renderTranscriptEditor()` (app.js:2042) rebuilds the whole chip DOM
  (`#word-selector`, `.word-chip[data-index]`) on every change; playback
  highlight is cheap class toggling (`highlightActiveWord`).
- `selectWord(index)` (2104) selects + scrolls + **seeks `video.currentTime =
  word.start`**. Inspector (2225): text/start/end inputs (seconds) + ±50 ms
  nudge buttons; every commit is `saveState()` → mutate word →
  `rebuildLayout()` → `renderTranscriptEditor()` → `updatePreview()`.
- `deleteWord` (soft), `splitWord` (2362, re-ids, `userAdjusted: true`),
  `mergeWithNext` (2392), `nudgeTime` (2338 — note: **no saveState**, existing
  undo gap, out of scope to fix).
- Undo/redo: `saveState()` (2410) pushes a JSON deep copy of `words` (cap 50).
  CTC realign keeps a separate whole-transcript snapshot (`App._ctcSnapshot`)
  with Revert.

### Video playback

`<video id="video">` is the clock. rAF loop while playing (`startPreviewLoop`,
924) → `updatePreview()` draws the caption canvas + active word. Scrubber is a
0–100 range mapped to `duration`. Seeking = assigning `video.currentTime`.

### Audio (waveform source)

`extractAudio()` (app.js:1236): ffmpeg.wasm → WAV → **16 kHz mono
Float32Array**; cached as `App._audioCache = { samples, file }` during
transcription (app.js:1538), cleared on new video (775). CTC realign already
reuses it — **the waveform needs no new decode**. If it's null (transcript
restored without re-transcribing) the timeline must degrade to
caption-lanes-only.

### Tests

`node --test tests/*.test.mjs` (8 files, pure-logic modules only: ctc-apply,
sanitizers, resumable-fetch…). DOM/canvas code is QA'd manually. 63/63 green
at Phase 1. New pure modules must follow this pattern (headless-testable logic
split from DOM glue).

### Layout

`.main-grid` = 3 columns (preview+playback+export | transcript display + word
editor | settings), `#status-bar` full width at bottom. Drag-resizer pattern
exists (`bindCenterResizer`, 732).

---

## Technical design (agreed direction)

### Placement & modules

Timeline docks as a **full-width row between `.main-grid` and `#status-bar`**,
collapsible, vertically drag-resizable. Three new modules following the repo's
pure-logic/DOM split:

1. **`timeline-model.js`** (pure, headless-tested): viewport, coordinate
   transforms, zoom/scroll clamps, ruler tick selection, hit-testing, gesture
   resolution (drag → intended edit), display-width rules for zero-length
   boxes, lane packing.
2. **`waveform.js`** (pure, headless-tested): peak table from Float32Array;
   chunked incremental build; visible-range → per-pixel column aggregation.
3. **`timeline-view.js`** (DOM/canvas glue): one DPR-aware canvas (ruler band,
   waveform band, caption lanes), pointer-event state machine, dirty-flag
   redraw, calls `App` callbacks for data changes.

`App` gains `App.timeline = { view, peaks, ... }` plus one central mutation
helper used by all timeline edits (see "single mutation funnel" below).

### Coordinate system (precision is first-class)

- Viewport = `{ viewStartSec, pixelsPerSecond (pps), viewWidthPx, durationSec }`.
- `x = (t − viewStart) × pps`, `t = viewStart + x ÷ pps`. Pixels are computed
  from seconds at draw time only; **pixel values are never persisted and
  timestamps are never quantized to pixels** (drag deltas accumulate in
  seconds; rounding happens nowhere).
- Zoom-at-anchor (cursor): `viewStart' = tAnchor − (tAnchor − viewStart) ×
  pps ÷ pps'`. Clamp `pps ∈ [viewWidth/duration, ~600]`; clamp
  `viewStart ∈ [0, duration − viewWidth/pps]`.
- Interaction: wheel = horizontal scroll, ctrl+wheel = zoom at cursor, drag
  ruler = pan, buttons for zoom-to-selection / zoom-fit / zoom-word.
- Ruler: pick major step from `…0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300,
  600…` s so majors stay ≥ ~70 px; minors subdivide ×5.

### Waveform strategy

- Peaks computed **once** from `App._audioCache.samples`: fixed buckets of 512
  samples (≈32 ms) storing min/max as Int16 → ≈450 KB per hour of video.
  Independent of zoom; every zoom level aggregates the same table.
- Render: buckets overlapping the visible range → per-pixel column (min/max
  vertical line, RMS optional later). Even at 2×DPR on a wide screen this is
  a few thousand column draws — fine per frame.
- Build progressively in ~5 s audio slices (setTimeout/yield loop) so the UI
  stays responsive; draw partial waveform as slices land.
- Multi-level peak pyramid: **not** planned (single level verified adequate
  by the arithmetic above; revisit only if profiling disagrees).
- **No wavesurfer.js or other dependency** — the app already owns canvas
  rendering, ffmpeg decode, and the custom caption-lane layout a library
  would only half-cover. Keep zero new runtime deps.
- Missing `_audioCache`: lanes-only mode + status note (open question Q1).

### Caption lanes & selection (Phase 3)

- Boxes come from `App.captionGroups` (identical grouping the preview/export
  use — one truth). Box rect from group start/end; greedy lane packing by
  overlap; text label when box is wide enough.
- Zero/negative/collapsed stored times render with a **4 px minimum width**
  visual target; stored values are never modified (critical requirement 1).
- Click box → select group's first word via a selection-sync that does **not**
  seek; double-click → seek (`video.currentTime = group.start`) using the
  existing `selectWord` seek semantics. Sync is event-driven both ways
  (word-editor selection ⇄ timeline highlight) with a re-entrancy guard;
  rendering never emits selection events → no feedback loops.

### Editing model (Phase 4 — decisions pre-agreed, revisit at phase start)

- **Move caption** = translate `start`/`end` of every word in the group by
  dt. **Resize left** = first word's `start`; **resize right** = last word's
  `end`. Clamps: `start ≥ 0`, `end ≤ duration`, `start ≤ end`; neighbour
  clamping to the adjacent word's edge (keeps monotonically ordered words —
  the existing inspector only clamps within the word, timeline clamps
  stricter because drags are continuous).
- Word-level drag (word boxes shown when `pps` ≥ threshold): edits that
  word's start/end with inspector-identical semantics.
- **Gesture protocol:** pointerdown → hit-test → ghost (no data touched) →
  pointerup → `saveState()` once + commit + full refresh. No per-move writes.
- **User-adjust marking:** timeline timing edits leave `orig*` stamps
  untouched (drift detection then auto-protects against CTC overwrite);
  matching split/merge convention, timeline-edited words also get
  `userAdjusted = true` so the editor's "addressed" outline agrees.
- **Grouping side effect (accepted):** groups are derived, so after a move a
  group may merge/split neighbours at recompute when grouping rules' thresholds
  cross. This is the honest consequence of one source of truth; a frozen cue
  list was rejected (would fork the data model). Documented here per the
  brief's requirement.

### Single mutation funnel

`App.applyTimelineEdit(fn)`-style helper: `saveState()` → mutate
`transcript.words` (intended fields only; never touch `deleted`, `estimated*`,
`orig*`, `original*`, `unplaced`) → `rebuildLayout()` →
`renderTranscriptEditor()` → `renderTranscriptDisplay()` → `updatePreview()` →
`timeline.invalidate()`. Timeline never keeps its own copy of timestamps —
it re-reads `App.captionGroups`/`transcript.words` on every render.

### Playback sync

Playhead = `video.currentTime` sampled inside the existing rAF preview loop
(+ on `seeked`/`timeupdate` while paused). Timeline → video only on explicit
user action (playhead drag, ruler click, dbl-click). The loop draws the
playhead but never seeks — one writer per direction, loop-safe.

---

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Timeline edits silently retrigger auto-timing | Edits only ever go through the mutation funnel; transcription/CTC remain explicit button actions only. Test asserts `timing`/`estimated` fields unchanged after drag. |
| R2 | Manual-adjust flags clobbered | Funnel writes only `start`/`end` (+ `userAdjusted`); `orig*`/`original*` never touched. Headless tests assert protection survives edits. |
| R3 | Group reflow surprises users after moves | Accepted design consequence (above); status note after edits that changed group count. |
| R4 | Long-video memory: samples already 240 MB/hr via `_audioCache` | Pre-existing; peaks table adds only ~450 KB/hr. Note limitation; no new memory class introduced. |
| R5 | Full chip-DOM rebuild per commit strains huge transcripts | Commits once per gesture (not per move); virtualization deferred unless measured. |
| R6 | Zero-duration boxes ungrabbable / invalid times | Min 4 px hit target, clamped commit rules, invalid values rendered-as-stored + warning. |
| R7 | Selection feedback loops | Event-driven sync + re-entrancy guard; render never emits events. |
| R8 | Export goes stale after timeline edit | Funnel always calls `rebuildLayout()` (SRT/VTT read `captionGroups`). |
| R9 | CTC Revert after timeline edits restores pre-realign state incl. timeline edits | Correct semantics (snapshot is pre-realign); document in Phase 4 record. |
| R10 | Canvas DPR/resize drift | Re-measure on container resize (existing `resizeCanvas` window hook pattern); scale ctx by DPR. |

### Open questions (answer at phase start, not silently)

- **Q1 (Phase 2):** transcript without `_audioCache` (restored session) — offer
  a "decode audio for waveform" button (ffmpeg only, no transcription) or ship
  lanes-only? Default proposal: lanes-only for now, revisit in Phase 2 review.
- **Q2 (Phase 2):** timeline default height / collapsed state persisted to
  localStorage (like theme)? Proposal: yes, localStorage.
- **Q3 (Phase 4):** word-level drag pps threshold (proposal: show word
  sub-boxes when ≥ ~120 px/s).
- **Q4 (Phase 5):** add-caption UX — dbl-click empty lane space vs. explicit
  "Add caption at playhead" button. Proposal: both.

---

## Acceptance criteria (whole feature, by phase)

- **P2:** ruler ticks legible at min→max zoom; waveform aligned with video
  within ±50 ms audibly at several timecodes; 60 fps scroll/zoom on a ≥10 min
  video; playhead tracks playback both directions; collapse/resize works;
  zero new runtime deps; `node --test` green incl. new `timeline-model` +
  `waveform` unit tests (round-trip `t→x→t` exactness within float epsilon,
  zoom-at-anchor invariant, clamp behaviour, peak correctness on synthetic
  arrays).
- **P3:** boxes match exported SRT block boundaries exactly; selection
  highlight syncs editor⇄timeline with no loops; dbl-click seeks; zero-duration
  stored values render visibly with min target and unchanged data (assert).
- **P4:** move preserves duration exactly (Δstart == Δend, stored floats);
  resize changes only the intended edge; every edit correct at min and max
  zoom and any scroll offset; one undo step reverts a whole gesture; flags
  per R2 tests; SRT/VTT re-export reflects edits.
- **P5:** new caption appears in editor/preview/export with unique id; undo
  works; empty-space dbl-click and playhead-create both function.
- **P6:** full manual workflow pass on short + long video; transcription,
  CTC realign/revert, sanitize estimates, manual `estimated` flags, styling,
  burn-in export all regression-checked; limitations documented.

---

## Phase 1 record — 2026-10-27

**Completed:** full repository investigation (app.js all 2717 lines,
whisper-adapter, ctc-apply, caption-renderer, index.html, tests, docs);
architecture, state-ownership and timestamp-flow mapped; technical design,
risk register, acceptance criteria and phase checklists written into this
document.

**Files changed:** `AutoOpenCaptionApp/docs/timeline-editor-progress.md`
(added) — documentation only, **zero code changes**.

**Tests:** `node --test tests/*.test.mjs` → **63 pass, 0 fail** (baseline on
`main` a798e16, unchanged by Phase 1).

**Known limitations / unresolved:** open questions Q1–Q4 above.

**Next phase starting point:** Phase 2, per design above — create
`app/assets/timeline-model.js`, `app/assets/waveform.js`,
`app/assets/timeline-view.js`, dock panel in `index.html` (+CSS) between
`.main-grid` and `#status-bar`, wire `App` (`bindTimeline()` in init, peaks
build hooked after transcription where `_audioCache` is set, playhead in the
preview loop), plus `tests/timeline-model.test.mjs` and
`tests/waveform.test.mjs`. No caption-box editing until Phase 3. Then update
this document and STOP.

---

## Phase 2 — Viewport, waveform & timeline dock: COMPLETE (2026-10-27)

**What was built:**

- `app/assets/timeline-model.js` (pure, headless-tested): `Viewport` =
  `{ durationSec, viewWidthPx, viewStartSec, pps }`; `timeToX`/`xToTime`,
  `clampViewport` (`pps ∈ [viewWidth/duration, MAX_PPS=600]`,
  `viewStart ∈ [0, duration − viewWidth/pps]`), `zoomAtAnchor` (cursor
  anchor, zero drift verified), `panByPixels`, `scrollToTime` (auto-follow),
  `fit`, ruler step picker from the `…0.1, 0.25, 0.5, 1, 2, 5, …` ladder
  keeping majors ≥ ~70 px. Pixel values are never persisted.
- `app/assets/waveform.js` (pure, headless-tested): `createPeakBuilder` —
  512-sample buckets (≈32 ms) storing min/max as Int16 in a flat
  `Int16Array`, incremental `feed()` + `snapshot()` handoff;
  `columnsForRange()` aggregates buckets → per-pixel columns for any zoom.
  Fixed `quantize()` edge bug found by tests: exactly −1.0 mapped to 0.
- `app/assets/timeline-view.js`: DPR-aware canvas dock (`#timeline-dock`,
  180 px default) with ruler band (22 px), waveform band, reserved caption
  lane strip; pointer-event state machine (ruler click = seek, ruler drag =
  pan, wave/lane scrub = seek), plain wheel = horizontal scroll,
  ctrl+wheel = zoom-at-cursor; toolbar zoom in/out/fit + collapse; dock
  height & collapsed state persist to localStorage (Q2 resolved).
  CSS-variable colors with MutationObserver re-read (theme-safe); dirty-flag
  rAF redraw.
- `App` wiring: `bindTimeline()` in `init()`, `timeline.setTime()` from the
  preview loop (`timeupdate`), `onSeek` → `video.currentTime`,
  `buildWaveformPeaks()` slices of 5 s audio (`setTimeout` between) fired
  right after `_audioCache` is set post-transcription (app.js:1592); new
  video clears peaks + duration.
- Q1 (restored session without `_audioCache`): lanes-only mode — dock shows
  ruler + empty waveform band, no error. Q3/Q4 still open (Phase 3+).

**Files changed:** `app/index.html`, `app/assets/style.css`,
`app/assets/app.js` (modified); `app/assets/timeline-model.js`,
`app/assets/waveform.js`, `app/assets/timeline-view.js`,
`tests/timeline-model.test.mjs`, `tests/waveform.test.mjs` (new).

**Tests:** `node --test tests/*.test.mjs` → **89 pass, 0 fail** (63 baseline
+ 26 new).

**Browser verification (headless, 12 s ffmpeg test clip over local HTTP):**
video load fits timeline (105.3 pps); ctrl+wheel zoom anchor drift 0.000 s;
wheel pan clamps at 0; ruler click seek `video.currentTime` matches
`xToTime` to the millisecond; fake `_audioCache` → 375/375 peak buckets;
playhead tracks muted playback (Δ < 0.05 s); toolbar zoom/collapse/expand
all mutate viewport/prefs; waveform pixels present in canvas band (14
distinct colors incl. accent + AA blends).

**Known limitations:** caption lane strip is a placeholder until Phase 3;
zoom-to-selection / zoom-word buttons deferred to Phase 3 (selection
exists then); waveform only appears after transcription (Q1 lanes-only).

**Next phase starting point:** Phase 3 (caption lanes & selection) per
design above. STOP here — one phase per session.

