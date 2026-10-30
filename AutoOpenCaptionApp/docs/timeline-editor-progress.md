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
| 2 | Timeline panel foundation: ruler, waveform, scroll, zoom, playhead | **DONE 2026-10-27** |
| 3 | Caption boxes + selection sync + double-click seek | **DONE 2026-10-28** |
| 4 | Direct caption timing edits (drag move, edge resize) | **IN PROGRESS** — split 4a–4f (see split below): 4a **DONE 2026-10-29** (b512f72), 4b **DONE 2026-10-29** (00fffb8 + QA), next = **4c pointer FSM** |
| 5 | Create missing captions/words, undo/redo integration | not started |
| 6 | Integration, regression testing, polish | not started |

## How to resume (fresh session)

1. `cd AutoOpenCaptionApp && node --test tests/*.test.mjs` — must be **147 pass / 0 fail** before starting (baseline verified 2026-10-29 after Phase 4b; was 107 after Phase 3, 134 after 4a).
2. Read this file (architecture + design below) — do not re-explore the repo from scratch. **Phase 4 is split into 4a–4f (see split section); one sub-phase per session, then STOP.**
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


---

## Phase 3 — Caption boxes, selection sync & zoom-to-selection: COMPLETE (2026-10-28)

**What was built:**

- `timeline-model.js` (pure, headless-tested): `groupBoxes()` maps live
  `App.captionGroups` → lane boxes (`boxRect` honours `MIN_BOX_PX = 4`:
  zero/collapsed cues stay visible+clickable slivers when zoomed out);
  `packLanes()` greedy interval packing (overlap → separate lanes, laneOf
  indexed parallel to boxes); `hitTestBoxes()` topmost-first with `padPx`
  hit-area growth; `frameSpan()` zoom-to-selection (already-visible span →
  viewport unchanged; else zoom in just enough, never past `MAX_PPS`, center
  the span; zero-duration span always drills one multiplicative step).
- `timeline-view.js`: caption lane strip is real — draws packed boxes per
  frame (selected group highlighted via CSS vars), pointer state machine
  extended: box click = select first word (no seek), double-click = seek to
  group start, shift-click on selected word = deselect; toolbar
  `Sel` button (`#btn-tl-zoom-sel`) → `zoomToSelected()` (selected cue, else
  playhead); `setSelectedWord(wordId)` reverse-sync API.
- `app.js` wiring: `getGroups: () => this.captionGroups` (boxes always
  mirror exported cue boundaries; `rebuildLayout()` ends with
  `timeline.invalidate()`); `onTimelineSelectGroup({ word, seek, toggle })`
  → `selectWord(idx, { seek })` — editor stays the selection authority, box
  highlight follows via `selectWord → setSelectedWord`; `selectWord` gained
  the `{ seek = true }` option (box clicks pass `seek: false`). Global
  outside-click deselect now exempts the whole `#timeline-dock` (document
  click fires before toolbar button handlers; zoom-to-selection would
  otherwise always see an empty selection).
- Word data is NEVER mutated by Phase 3 interactions (R7): stored
  `word.start/end` byte-identical after all box/zoom interactions.

**Files changed:** `app/assets/timeline-model.js`, `timeline-view.js`,
`app.js`, `app/index.html` (modified); `tests/timeline-lanes.test.mjs` (new).

**Tests:** `node --test tests/*.test.mjs` → **107 pass, 0 fail** (89 + 18
new lane/framing tests).

**Browser verification (headless Playwright, 12 s clip, 15/15 checks):**
groups derived from captionGroups; overlapping cues pack to lane 2;
collapsed cue renders 4 px sliver; box x/w match group times; click selects
first word WITHOUT seeking; timeline highlights selected group; double-click
seeks to group start; editor word-select highlights its box (reverse sync);
shift-click deselects; zoom-to-selection stays put when the cue is fully
visible (stay-put rule); zoom-to-selection frames an off-screen cue (view
9.38–12 s → 4.95–7.35 s, cue 6–6.3 centered); stored word times unchanged.

**Pitfalls learned (QA-script side, not app bugs):** the QA script must run
with stdin redirected (`node tl_phase3_qa.js < /dev/null`) — otherwise
Playwright sees the open pipe and every evaluate dies with "stdin is not a
tty". Stay-put at fit zoom is CORRECT behaviour (whole video visible = span
framed); test the framing branch by zooming in + panning the cue off-screen
first.

**Known limitations:** boxes are display/selection only — no drag-move or
edge-resize yet (Phase 4); lane count is unbounded (fine for realistic
grouping).

**Next phase starting point:** Phase 4 (direct timing edits: drag move, edge
resize) per design. STOP here — one phase per session.


---

## Phase 4 split — smaller sub-phases (decided 2026-10-29)

Phase 4 proved too large for one context window, so it is split; **one
sub-phase per session, then STOP:**

| Sub | Scope | Status |
|---|---|---|
| 4a | Pure gesture/clamp logic in `timeline-model.js` (no DOM) | **DONE** (b512f72) |
| 4b | Ghost drag rendering + word sub-boxes + hover cursors (view only, no commits) | **DONE** (00fffb8 + QA this session) |
| 4c | Pointer FSM: wire pointerdown/move/up on lanes to grab-zone + ghost (still no commits) | next |
| 4d | App mutation funnel: `applyTimelineEdit` commit on release (saveState → mutate → refresh) | not started |
| 4e | Browser QA of real drag gestures (mouse events end-to-end, undo restores) | not started |
| 4f | Docs, final polish, push PR update | not started |

---

## Phase 4a — Pure gesture & clamp logic: COMPLETE (2026-10-29)

**What was built** (`timeline-model.js`, headless-tested only — commit b512f72):

- `grabZone(xInBox, boxW, edgePx=5)` → `'left' | 'right' | 'body'` (edge zones
  only when the box is wide enough to have both edges + body).
- `resolveGesture({ zone, wordIndexInGroup, wordIndex, groupIndex })` →
  gesture object: `group-move` / `group-resize{edge}` / `word-move` /
  `word-resize{edge}` — word grab only when word boxes are active.
- `liveNeighborBounds(words, fromIx, toIx)` → tightest adjacent word edges;
  `editBounds` (word gestures) and `editBoundsForGroup` (group gestures) →
  `{ lo, hi }` clamp bounds: `start ≥ 0`, `end ≤ duration`, `start ≤ end`,
  neighbour word edges; tightest word in a group wins for `group-move`.
- `clampDelta(delta, { lo, hi })`.
- `wordBoxes(vp, words)` + `WORD_SUB_PPS = 120` (Q3 resolved: sub-boxes at
  ≥120 px/s); `groupBoxes` gained optional `allWords` arg → per-group
  `wordIndex` mapping (group word i → transcript index, −1 if not found).
- Bug fixed during development: `liveNeighborBounds` span-range guard made
  the neighbour branches dead code (always ±Infinity → clamps never applied).

**Tests:** `tests/timeline-edit-gestures.test.mjs` (new, 27 tests) →
**134 pass, 0 fail**.

---

## Phase 4b — Ghost drag rendering, word sub-boxes, hover cursors: COMPLETE (2026-10-29)

**What was built:**

- `timeline-model.js`: `applyGestureDelta(gesture, allWords, wordIndexes,
  deltaSec)` → `Map<transcriptIndex, {start,end}>` — the ghost's single
  source of truth, PURE (never mutates `words`); same rule Phase 4d will use
  to commit, so ghost == commit. Empty Map for invalid targets; clamped
  bounds applied by the caller.
- `timeline-view.js` ghost API (rendering state ONLY, no timestamps stored):
  `beginGhost(gesture, groupIndex)` (resolves wordIndexes + edit bounds from
  live data, picks the grabbed box's lane), `moveGhost(dxPx)` (px→s, clamps
  via `clampDelta`, recomputes proposal from LIVE words every move),
  `endGhost()` → final clamped delta + clear (NO commit — 4d wires that),
  `cancelGhost()`.
- `_drawGhost`: dashed muted outline at the ORIGINAL span, translucent accent
  union at the PROPOSED span, per-word proposed sub-boxes at word zoom, plus
  a delta readout; redrawn via the existing dirty-flag rAF loop.
- Word sub-boxes display: at `pps ≥ WORD_SUB_PPS` each group box draws
  per-word outlines (+ text when ≥24 px) clamped inside the parent box (the
  group `end` carries the renderer's ≥0.1 s display clamp, so the last word
  can extend past the visual edge — sub-boxes are clamped to match).
- Hover cursors: box body → `move`, edges (`grabZone`) → `ew-resize`,
  empty lane → none; suppressed while a drag is active (`_dragging`).
- `app.js`: `getAllWords()` passed to the view (live `transcript.words`).

**Files changed:** `app/assets/timeline-model.js`, `timeline-view.js`,
`app.js` (modified); `tests/timeline-ghost.test.mjs` (new, 13 tests);
`scripts/tl_phase4b_qa.cjs` (new QA harness). Code commit: 00fffb8.

**Tests:** `node --test tests/*.test.mjs` → **147 pass, 0 fail** (134 + 13).

**Browser verification (headless Chrome via playwright-core, 12 s clip,
25/25 checks — `scripts/tl_phase4b_qa.cjs`):** sub-boxes OFF below threshold
(1 distinct interior color @80 pps) vs ON above (outlines + text @200 pps);
`wordIndex` mapping correct; hover cursors move/ew-resize/empty correct;
ghost start/move/clamp/end/cancel lifecycle correct; proposal translates
every group word, clamps at `start ≥ 0` and at the neighbour word edge;
ghost pixels appear at the proposed spot and revert on end/cancel;
**word data byte-identical after every ghost interaction** (no per-move
writes, `endGhost` does not commit); no page errors.

**QA pitfalls learned:** (1) QA scripts must run as `.cjs` from the scratch
dir where `playwright-core` is installed (`NODE_PATH`), stdin `</dev/null`.
(2) The timeline redraws via dirty-flag rAF — pixel assertions must sample
AFTER a `waitForTimeout(≥250 ms)`, never in the same `evaluate` that
triggered the change. (3) Interior-color thresholds must be calibrated with
a probe run (stroke + AA cluster tightly at 4-bit quantization).

**Known limitations:** ghost/sub-boxes are rendering-only — nothing is
grab-or-committable by a real mouse until 4c (FSM) + 4d (funnel).

**Next phase starting point:** Phase 4c — pointer FSM: lane pointerdown →
`grabZone`/word-box hit → `resolveGesture` → `beginGhost`; move →
`moveGhost`; up → hold delta for 4d (or stub commit); must coexist with the
existing click/dbl-click/pan handlers without regressions. STOP after 4c.
