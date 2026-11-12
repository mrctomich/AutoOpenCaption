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
| 4 | Direct caption timing edits (drag move, edge resize) | **DONE 2026-10-30** — split 4a–4f all complete: 4a b512f72, 4b 00fffb8 (+QA 25/25), 4c 3c8e740 (+QA 19/19), 4d 0663881 (+QA 20/20), 4e 45decb2 (+QA 29/29), 4f (this record: export-reflection QA 9/9, docs, PR) |
| 5 | Create missing captions/words, undo/redo integration | **IN PROGRESS** — split 5a–5f: 5a 0e1fcb3, 5b c96849b, 5c+5d 35d6212, 5e (this record: joinWordTexts shared join + box-label latent-bug fix, 229 green). Remaining: **5f** (browser QA + closeout) |
| 6 | Integration, regression testing, polish | not started |

## How to resume (fresh session)

1. `cd AutoOpenCaptionApp && node --test tests/*.test.mjs` — must be **229 pass / 0 fail** before starting (baseline verified 2026-11-01 after Phase 5e; was 208 after 5c+5d, 192 after 5a, 205 after 5b).
2. Read this file (architecture + design below) — do not re-explore the repo from scratch. **Phase 4 (4a–4f) is COMPLETE**; **Phase 5 is 5/6 done (5a–5e)** — see the Phase 5 records below for the shipped state. Next is **5f** (browser QA `scripts/tl_phase5_qa.cjs` modeled on `tl_phase4e_qa.cjs`: button create, empty-lane dbl-click create, undo/redo LIFO incl. rapid mixed gestures, unique-id audit, export reflection, F2 text edit on a fresh word in the real browser; then docs closeout, push, PR #13 update).
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
  → **RESOLVED (Phase 2): lanes-only shipped** (ruler + empty band, no error).
  A decode-only button remains a possible later enhancement.
- **Q2 (Phase 2):** timeline default height / collapsed state persisted to
  localStorage (like theme)? Proposal: yes, localStorage.
  → **RESOLVED (Phase 2): persisted** (dock height + collapsed, localStorage).
- **Q3 (Phase 4):** word-level drag pps threshold (proposal: show word
  sub-boxes when ≥ ~120 px/s).
  → **RESOLVED (4a): `WORD_SUB_PPS = 120`** — sub-boxes drawn, hit-tested
  and grabbable at ≥120 px/s; below that every box grab is a group gesture.
- **Q4 (Phase 5):** add-caption UX — dbl-click empty lane space vs. explicit
  "Add caption at playhead" button. Proposal: both. **OPEN — answer at
  Phase 5 start.**

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
| 4a | Pure gesture/clamp logic in `timeline-model.js` (no DOM) | **DONE 2026-10-29** (b512f72) |
| 4b | Ghost drag rendering + word sub-boxes + hover cursors (view only, no commits) | **DONE 2026-10-29** (00fffb8 + QA 25/25) |
| 4c | Pointer FSM: wire pointerdown/move/up on lanes to grab-zone + ghost (still no commits) | **DONE 2026-10-30** (3c8e740 + QA 19/19) |
| 4d | App mutation funnel: `applyTimelineEdit` commit on release (saveState → mutate → refresh) | **DONE 2026-10-30** (0663881 + QA 20/20) |
| 4e | Browser QA of real drag gestures (mouse events end-to-end, undo restores) | **DONE 2026-10-30** (45decb2 + QA 29/29) |
| 4f | Docs, final polish, push PR update | **DONE 2026-10-30** (this record; export-reflection QA 9/9) |

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


---

## Phase 4c — Pointer FSM: COMPLETE (2026-10-30)

**What was built:**

- `timeline-model.js`: `hitTestWordBox(vp, words, xPx)` → index of the word
  sub-box under the pointerdown x, or −1. Same `boxRect` display rule as
  `wordBoxes` (degenerate words keep a `MIN_BOX_PX` grab target),
  deterministic first-match at shared boundaries, −1 in gaps/outside.
- `timeline-view.js` pointer FSM (the 4b ghost API finally driven by real
  pointers): box press + 3 px drag threshold → `startGhostDrag` —
  `grabZone(downX)` + word hit-test (only at `pps ≥ WORD_SUB_PPS`) →
  `resolveGesture` → `beginGhost`; every move → `moveGhost(dxPx)`.
  Release → `endGhostDrag` reports `{ gesture, wordIndexes, delta,
  proposal }` through the new **`onGestureEnd`** constructor callback —
  zero-delta releases report NOTHING (a 0 commit must not burn an undo
  slot). Esc mid-drag cancels (no report, and the press does NOT fall
  through to pan); `pointercancel` cancels likewise. A box press can never
  pan: it either ghosts or, after Esc/an unresolvable grab, stays inert
  until release. Ruler drag, empty-lane pan, wheel, click-select and
  dbl-click-seek all unchanged.
- Still NO commits (per split): `App` does not wire `onGestureEnd` yet —
  default no-op. Phase 4d attaches `applyTimelineEdit`. Word data verified
  byte-identical after every gesture.

**Files changed:** `app/assets/timeline-model.js`, `timeline-view.js`
(modified); `tests/timeline-edit-gestures.test.mjs` (+6 tests:
`hitTestWordBox` boundary/gap/degenerate/empty + FSM word→transcript-index
mapping through `groupBoxes.wordIndex`); `scripts/tl_phase4c_qa.cjs` (new).

**Tests:** `node --test tests/*.test.mjs` → **153 pass, 0 fail** (147 + 6).

**Browser verification (headless Chrome via playwright-core, 12 s clip,
19/19 checks — `scripts/tl_phase4c_qa.cjs`):** group-move via word gap
(delta 0.2 s at pps 300, mid-drag ghost active); word-move on a solo-word
box (wordIndex 2); word-resize `end` via right-edge grab drilling through
the group box; over-drag left pins delta at −1.0 s (start ≥ 0 clamp);
Esc clears ghost, release reports nothing, view does NOT pan; single click
selects without ghost/gesture; dbl-click still seeks (`seek: true`);
empty-lane drag pans without ghost; word data byte-identical after every
interaction; zero page errors.

**QA pitfalls learned:** (1) native `ffmpeg`/`node` get NO git-bash path
translation — a clip written to `/tmp/x` silently lands in `C:\tmp\x`;
pass `SCRATCH`/`NODE_PATH` as `C:/...` native paths. (2) The QA clip
`tl_clip.mp4` (12 s, 2026-10-28 build) persists in the Hermes scratch dir;
`playwright-core` lives in `<scratch>/pw4c/node_modules` (reinstall there
with npm if it ages out).

**Known limitations:** nothing commits yet (4d); word-level grabbing only
at `pps ≥ WORD_SUB_PPS` — below that every box grab is a group gesture
(by design).

**Next phase starting point:** Phase 4d — App mutation funnel: wire
`onGestureEnd` → `App.applyTimelineEdit`: `saveState()` once → apply the
proposal Map to `transcript.words` (only `start`/`end` + `userAdjusted =
true`; never touch `orig*`/`original*`/`deleted`/`estimated*`) →
`rebuildLayout()` → `renderTranscriptEditor()` → `renderTranscriptDisplay()`
→ `updatePreview()` → `timeline.invalidate()`. Status note when the edit
changed the group count (R3). STOP after 4d.

## Phase 4d — App mutation funnel: COMPLETE (2026-10-30)

**Scope:** a completed timeline gesture now really commits. `bindTimeline`
wires `onGestureEnd` → `App.applyTimelineEdit`; the drag pipeline of 4a–4c
ends in a write to `transcript.words` behind exactly one undo save.

**What was built:**
- `commitProposal(words, proposal, eps?)` in `timeline-model.js` — the PURE
  validation half: proposal `Map<index, {start,end}>` → list of
  `{index, start, end}` mutations. Rejects out-of-range/non-integer indices,
  non-finite times, `start < 0`, and NEW start>end inversions; an
  already-inverted stored word stays inverted when moved (R6
  rendered-as-stored). Entries equal to stored times (≤ eps) produce no
  mutation — zero-delta and returned-to-origin drags come back empty, which
  is what makes the funnel's no-op cheap and total.
- `App.applyTimelineEdit({ proposal })` in `app.js` — the funnel: validate →
  empty mutations ⇒ return false WITHOUT touching anything → otherwise
  `saveState()` once → write ONLY `start`/`end` + `userAdjusted = true` →
  `rebuildLayout()` (lanes + `timeline.invalidate()`) →
  `renderTranscriptEditor()` → `renderTranscriptDisplay()` →
  `updateInspector()` → `updatePreview()` → `timeline?.invalidate()`.
  R3: when the derived `captionGroups` count changed, a status note reports
  the reflow (`Timing change regrouped captions: N → M groups.`).
- `onGestureEnd: (info) => this.applyTimelineEdit(info)` in `bindTimeline`.

**Files changed:** `app/assets/timeline-model.js` (+`commitProposal`),
`app/assets/app.js` (import, funnel, wiring),
`tests/timeline-commit.test.mjs` (new, 15 tests: commit semantics, purity,
zero-delta/eps no-ops, all rejection rules, inverted-store R6, plus
source-level guards pinning the funnel contract — one `saveState()`, gated on
non-empty mutations, writes only start/end/userAdjusted, downstream refresh
calls, R3 note, `onGestureEnd` wiring),
`scripts/tl_phase4d_qa.cjs` (new browser QA).

**Tests:** `node --test tests/*.test.mjs` → **168 pass, 0 fail** (153 + 15).

**Browser verification (headless Chrome via playwright-core, 12 s clip,
20/20 checks — `scripts/tl_phase4d_qa.cjs`):** 4-group synthetic transcript
with full `orig*`/`original*`/`estimated*` side fields; instrumentation
wraps `App.applyTimelineEdit`/`App.saveState` WITHOUT replacing the hook (the
real wiring runs). Zero press+release: no funnel call, no save, data
identical. Word-move bravo −0.4 s: exactly one funnel call + one save, word
lands 2.6..3.0 (duration preserved ≤1 ULP), `userAdjusted` set, every side
field intact (R2), other words untouched. `App.undo()` restores the pre-edit
snapshot. Drag-out-and-back-to-origin: no commit, no save. Far-left drag
clamped to alpha end → bravo touches alpha → groups merge 4 → 3 with its own
single save (R3). Second undo restores data AND derived group count. Ghost
cleared, zero page errors.

**QA pitfalls learned:** (1) the 4c harness replaced `tl.onGestureEnd` with
a recorder — fine pre-4d, fatal for it (bypasses the funnel); 4d instead
wraps `App.applyTimelineEdit`/`App.saveState` and counts calls, since the
view's hook resolves `this.applyTimelineEdit` at event time. (2) `Status` is
module-scoped, not on `window` — R3's note is asserted via the observable
group-count change, not DOM text. (3) `tl_clip.mp4` had aged out of scratch;
regenerated with ffmpeg (testsrc+sine, 12 s, h264/aac) — same recipe works.

**Known limitations:** nothing commits per-preview-frame (only on release —
by design); nudge/keyboard timing edits still not wired (later phases).

**Next phase starting point:** Phase 4e — QA & edge cases: dense transcripts
and long media in the committed state, rapid successive gestures (undo stack
depth), drag during playback, resize/re-render after commit, RTL/long words,
plus a full manual-feel pass with real ASR output. STOP after 4e.

## Phase 4e — QA & edge cases of the committed state: COMPLETE (2026-10-30)

**Scope:** no new features — harden the 4d commit funnel against edge cases:
rapid successive gestures, drag during playback, long media, resize after
commit, dense transcripts, long/RTL words. All browser-verified; every
scenario ends with undo unwinding to a byte-identical snapshot.

**What was built:** `scripts/tl_phase4e_qa.cjs` (new; scaffold copied from
`tl_phase4d_qa.cjs` — same non-bypassing instrumentation: wraps
`App.applyTimelineEdit`/`App.saveState`, counts calls, times the funnel).
Uses a NEW 60 s clip `tl_clip_60.mp4` (testsrc+sine, 60 s h264/aac, ffmpeg
lavfi) so long-media clamping is exercised against real duration.

**Browser verification (headless Chrome via playwright-core, 60 s clip,
29/29 checks):**
- **S1 rapid successive gestures:** three word-moves fired back-to-back →
  exactly 3 funnel calls + 3 saves; `undo()`×3 unwinds LIFO (undo #1 restores
  alpha while bravo stays moved); final snapshot byte-identical.
- **S2 drag during playback:** muted `video.play()`, word-move committed
  mid-stream → one call + one save, word lands 2.6..3.0, video NOT paused
  and `currentTime` advanced through the funnel refresh; undo restores.
- **S3 long media (60 s):** at pps 10 a far-right group drag pins `end ==
  durationSec` (59.4..60.0), no overrun, one commit; undo restores.
- **S4 resize after commit:** after a −0.4 s commit, `setViewportSize
  1440×900 → 1000×700` → bravo box rebuilt at the same transform x (780 →
  780, fitMode manual keeps pps) and the lane band repaints (9 distinct
  colors, pixel probe); undo after resize restores.
- **S5 dense transcript (30 words, 0.35 s pitch, 10 groups):** press derived
  from the calibrated box transform lands on word 6's sub-box centre (never
  an inter-word gap) → EXACTLY one word changes, and it equals
  `__last.wordIndex`; funnel incl. full editor re-render 0.6 ms; group count
  stable.
- **S6 long word + RTL:** 'Supercalifragilisticexpialidocious' and 'مرحبا'
  both get lane boxes; RTL word drag commits 2.6..3.0, text byte-identical
  (no mangling), R2 side fields intact.
- Final invariants: ghost cleared, zero page errors.

**Contract learned (assertion was wrong, app was right):** on a dense track
a −0.2 s word-move applies only −0.05 s — `editBounds` clamps word-move at
`prevEnd` (live neighbor bounds), i.e. **word drags never overlap the
neighbouring live word**; the clamped word pins flush to the neighbour's end
with duration preserved. QA now asserts the clamped delta AND
`newStart == prevEnd` instead of the raw pointer delta. This is the
"A no-op can be the contract" pitfall in its clamp form: derive the expected
delta from `editBounds`, never from raw px/pps.

**QA pitfalls learned:** (1) word sub-boxes are NOT stored on the view
(computed per-frame in `draw`) — to press one programmatically, calibrate
the box transform from a known solo box (`p = box.x − (start−viewStart)·pps`)
and press the word's time-centre; group-box centres fall into inter-word
gaps → silent group gesture. (2) Right-clamp at media end is only testable
with a clip long enough to overshoot in-viewport: 12 s clip can't; a 60 s
clip at pps 10 drags +1150 px = +115 s → clean clamp at 60.0.

**Files changed:** `scripts/tl_phase4e_qa.cjs` (new), this doc. No app code
touched — zero app bugs found; the only fix was the S5 expectation.

**Tests:** `node --test tests/*.test.mjs` → **168 pass, 0 fail** (unchanged;
re-verified this session).

**Known limitations:** the "manual-feel pass with real ASR output" is NOT
done here — it needs a full whisper transcription run in the user's browser
(644 MB model); synthetic transcripts cover the data shapes. Recommend the
user dogfood one real video before merge. Nudge/keyboard edits still
unwired (unchanged limitation).

**Next phase starting point:** Phase 4f — wrap-up: final doc pass (phase
index, architecture summary, limitations), push, and prepare the PR for
review/merge per the repo rhythm. STOP after 4f — do NOT merge before the
user's word.

## Phase 4 complete — as-built architecture (2026-10-30)

The shipped timeline editor, as built across Phases 2–4 (this is the
authoritative snapshot for future phases; the design section above is the
pre-build intent — where they differ, this wins):

**Modules** (`app/assets/`, zero runtime deps):

- `timeline-model.js` — PURE, headless-tested. `Viewport`
  (`durationSec, viewWidthPx, viewStartSec, pps`) with `timeToX`/`xToTime`
  (float seconds authoritative; pixels never persisted), `clampViewport`
  (`pps ∈ [viewWidth/duration, 600]`), `zoomAtAnchor`, `panByPixels`,
  `scrollToTime`, ruler step ladder; `groupBoxes` (+`wordIndex` mapping),
  `packLanes`, `hitTestBoxes`, `frameSpan`; word level: `wordBoxes`
  (`WORD_SUB_PPS = 120`), `hitTestWordBox`; gestures: `grabZone` (edges
  5 px), `resolveGesture` → `group-move | group-resize{edge} | word-move |
  word-resize{edge}`, `liveNeighborBounds`/`editBounds`/`editBoundsForGroup`
  (`start ≥ 0`, `end ≤ duration`, `start ≤ end`, neighbour edges),
  `clampDelta`, `applyGestureDelta` (ghost proposal `Map<index,
  {start,end}>`, pure — same rule the commit uses, so ghost == commit),
  `commitProposal` (validate → mutation list; rejects bad indices,
  non-finite, `start < 0`, NEW start>end inversions; ≤eps no-ops;
  already-inverted stores stay inverted, R6).
- `waveform.js` — PURE: 512-sample min/max buckets (`createPeakBuilder`,
  incremental `feed`/`snapshot`), `columnsForRange` per-pixel aggregation at
  any zoom; built in 5 s slices after transcription.
- `timeline-view.js` — DOM/canvas glue: DPR-aware `#timeline-dock` canvas
  (ruler / waveform / caption lanes), pointer FSM (box press +3 px → ghost
  drag; ruler click seek / drag pan; empty-lane pan; wheel scroll,
  ctrl+wheel zoom; click select, dbl-click seek; Esc/pointercancel abort
  without pan fallthrough; zero-delta release reports nothing),
  `onGestureEnd({ gesture, wordIndexes, delta, proposal })` callback,
  `setSelectedWord` reverse sync, localStorage height/collapse.
- `app.js` — `bindTimeline()` wires the view to `App`; **single mutation
  funnel** `App.applyTimelineEdit({ proposal })`: validate via
  `commitProposal` → empty ⇒ return false untouched → else exactly one
  `saveState()` → write ONLY `start`/`end` + `userAdjusted = true` (never
  `orig*`/`original*`/`deleted`/`estimated*` → CTC protection via drift, R2)
  → `rebuildLayout()` → editor/display/inspector/preview refresh →
  `timeline.invalidate()`; R3 status note when group count changes. The
  timeline stores NO timestamps of its own — every render re-reads
  `App.captionGroups` / `transcript.words`.

**Invariants proven headless (168 tests) + browser QA (93 checks across
4b–4f):** one undo slot per committed gesture (LIFO verified); ghost ==
committed result; moves preserve duration ≤1 ULP; word drags never overlap
the neighbour live word (`editBounds` pins flush at `prevEnd`); side fields
byte-identical (R2); zero-delta/return-to-origin never burns undo; SRT/VTT
re-export reflects edits and undo (4f QA); playback keeps running through a
commit; 60 s end-clamp exact; dense-track one-word-per-gesture.

### Consolidated limitations (state of Phase 4)

1. Waveform requires `_audioCache` (present after transcription); restored
   sessions show lanes-only (Q1) — decode-only button not built.
2. Word-level grabbing only at `pps ≥ 120`; below it every grab is a group
   gesture (by design, Q3).
3. Nudge/keyboard timing edits not wired to the funnel (pre-existing
   inspector gap, incl. `nudgeTime`'s missing `saveState`).
4. Group reflow after moves is accepted behaviour (R3) — a frozen cue list
   was rejected; reflow is status-noted and reflected in exports.
5. CTC Revert after timeline edits restores the pre-realign snapshot
   including timeline edits (R9 — correct semantics).
6. Manual-feel pass with a real Whisper transcription (644 MB model, user's
   browser) NOT yet done — synthetic transcripts cover data shapes;
   dogfood one real video before merge recommended.
7. Full burn-in/CTC/sanitize regression sweep is Phase 6 scope.

## Phase 4f — Docs, export-reflection QA, push & PR-ready: COMPLETE (2026-10-30)

**Scope:** final documentation pass, closing the one P4 acceptance item not
yet end-to-end verified (SRT/VTT re-export reflects edits), push, PR update.
No app code changed.

**What was built:**
- `scripts/tl_phase4f_export_qa.cjs` (new) — export-reflection QA on the
  real wiring (no instrumentation needed; `generateSRT`/`generateVTT` read
  derived `captionGroups`): **9/9 PASS** — baseline 4 cues; committed
  word-drag bravo −0.4 s appears as `00:00:02,600 --> 00:00:03,000` in SRT
  (and dot-separator form in VTT) with all other cues unchanged; undo
  restores the exported times; regroup drag yields 3 cues with merged text
  `Alpha bravo.` spanning 1.0 → 1.8; zero page errors.
- This doc: Phase/status tables closed out (4 DONE, 5 = next), resume
  baseline 168, Q1/Q2/Q3 marked resolved with shipped values, as-built
  architecture summary + consolidated limitations added above.

**Tests:** `node --test tests/*.test.mjs` → **168 pass, 0 fail** (verified
this session before doc edits).

**Files changed:** `docs/timeline-editor-progress.md`,
`scripts/tl_phase4f_export_qa.cjs` (new). Docs + script pushed to
`feature/interactive-timeline-editor`; PR #13 retitled and body rewritten
as the full Phase 1–4 review summary. **NOT merged — waiting on the
user's word** (per rule; also 4e limitation: real-ASR dogfood pending).

**Next phase starting point:** Phase 5 — create missing captions/words +
undo/redo integration. Answer Q4 first (proposal: both dbl-click empty lane
AND "add caption at playhead" button). New words take `max(id)+1`; create
through the same funnel discipline (one `saveState()` per gesture). If the
phase looks heavy for one context window, split it 4a–4f-style. STOP after
Phase 5 (or each sub-phase if split).

## Phase 4 follow-up — CTC realign monotonicity guard (2026-10-31)

**Reported symptom (user dogfood):** after clicking "Realign timing", the
timeline showed a SECOND caption lane with boxes overlapping the first row.

**Root cause:** `alignCtcTranscript()` output mixes fresh wav2vec2 CTC spans
with kept Whisper estimates (`no-ctc-evidence` / `low-confidence` /
user-adjusted guard) and its only ordering guarantee
(`cursor = Math.max(cursor, out.end)`) covers words with NO timestamp at
all. At seams the word stream could go backwards in time. `applyCtcResult()`
wrote spans word-by-word with no ordering check; `groupWords()`' overlap
clamp intentionally skips the `next.start <= g.start` case, so the overlap
survived into `captionGroups` — visible as a second packed lane
(`packLanes` opens a lane per time-overlapping group) AND in SRT/VTT export
(overlapping cues; `findGroupAtTime` lets the earlier caption win).

**Fix (ctc-apply.js, `applyCtcResult`):** forward pass tracks `prevEnd` =
running max of every processed word's end. A CTC word's start is clamped to
`prevEnd` (end follows to keep positive duration) and counted in
`monotonicClamped`. Untouchable words (kept estimates, user-adjusted,
flagged-invalid) are NEVER moved — consistent with the Gap A guard; a
backward jump caused by one of those is counted in `backwardConflicts`.
`origStart/origEnd` re-anchor to the FINAL clamped timing. Snapshot is
taken before any mutation, so `revertCtcResult` still restores exactly.

**Reporting (app.js):** success status gains "N shifted forward to keep word
order"; new warning when `backwardConflicts > 0` pointing at the inspector.

**Tests:** +6 in `tests/ctc-apply.test.mjs` (clamp-to-prevEnd, fully-inside
span gets positive duration at prevEnd, kept-estimate seam pushes following
CTC word, untouchable backward jump reported-not-repaired, healthy input
zero-counts, revert restores post-clamp state).
`node --test tests/*.test.mjs` → **174 pass, 0 fail** (baseline 168 + 6).
E2E sanity: clamped seam → `groupWords` emits zero overlapping group pairs
→ `packLanes` single lane.

**Files changed:** `app/assets/ctc-apply.js`, `app/assets/app.js`,
`tests/ctc-apply.test.mjs`, `README.txt`, this doc. No timeline/grouping
code touched — the second lane stays as the honest signal for overlaps
that only untouchable words can cause (now warned about).

**Next phase starting point:** unchanged — Phase 5 (create
captions/words + undo/redo; answer Q4 first).

---

## Lane-packing fix — MIN_BOX_PX widening must not invent lanes (dogfood, 2026-10-31)

**Symptom (user screenshot):** with max-words=1 and zoomed out, every short
cue stacked into its own lane row AND was drawn as a dashed "degenerate"
warning.

**Root cause:** `boxRect` bumped sub-`MIN_BOX_PX` spans to 4 px and conflated
two different things in one flag — `degenerate` meant "was bumped", which at
low zoom is true for every perfectly valid short cue. `packLanes` then packed
by the WIDENED box, so chronologically-adjacent slivers (true gap < 4 px)
collided and manufactured lanes.

**Fix (`timeline-model.js`):**
- `boxRect` now separates the concepts: `degenerate: true` only when the TIME
  span itself is broken (zero/inverted/non-finite — dashed render stays
  meaningful); `widened: true` for valid spans bumped to `MIN_BOX_PX`; and it
  carries the TRUE extent `trueX`/`trueW` (NaN stays NaN) alongside.
- `groupBoxes` passes the three new fields through.
- `packLanes` packs by TRUE extent (`trueX ?? x` — manual/test boxes without
  the fields keep working). Invalid cues share ONE reserved lane after all
  valid lanes: they render at x=NaN (invisible) and must neither invent one
  lane per broken cue nor poison a shared lane end and push every later valid
  cue down a row.

**Tests:** +4 → `node --test tests/*.test.mjs` = **178 pass, 0 fail**
(baseline 174). `boxRect` widened-vs-degenerate matrix; low-zoom sliver
regression (12 cues → 1 lane); genuine overlap still splits at low zoom;
invalid-cue reserved-lane matrix.

**Browser QA (`scripts/tl_lanes_fix_qa.cjs`, headless Chrome):** 8/8 PASS —
10 short cues at pps 8 render one lane (pixel-probed rows), real overlap
still splits to two rendered rows, NaN cue reserves exactly one extra lane,
zero page errors. Screenshots: `lanes_lowzoom.png`, `lanes_overlap.png`.

**Files changed:** `app/assets/timeline-model.js`,
`tests/timeline-model.test.mjs`, `tests/timeline-lanes.test.mjs`,
`scripts/tl_lanes_fix_qa.cjs`, this doc.

**Next phase starting point:** unchanged — Phase 5 (create captions/words +
undo/redo; answer Q4 first).

---

## Phase 5 kickoff — split into 5a–5f (2026-11-01)

**Q4 ANSWERED (was open since Phase 1):** add-caption UX = **both**, as
proposed: (1) double-click empty lane space creates a caption at the clicked
time, (2) an explicit "＋ caption at playhead" button in the timeline
toolbar. Both funnel into the same App mutation — one `saveState()` per
create, standard undo stack.

**Scope (from the Phase 5 starting point):** create missing captions/words +
undo/redo integration. New words take `max(id)+1` (ids are `w####` strings —
parse the numeric part; `splitWord` injects large `w<date6>` ids so the max
scan must cover them). Array stays sorted by `start` on insert.

**Split — one sub-phase per session, record + STOP after each:**

| Sub | Scope | Surface |
|-----|-------|---------|
| **5a** | Pure create logic in `timeline-model.js`: `planNewCaption({words, startSec, endSec?, text?, durationSec})` → `{ok, word, index, reason}` — unique `max(id)+1` id, clamps (0 ≤ start, end ≤ duration, end ≥ start+0.1), "no-room" rejection inside dense runs, sorted insert index; flags `userAdjusted:true, estimated:false`, orig* baseline = new span (so CTC never moves user-created data). Headless tests. NO UI. | model + tests |
| **5b** | App funnel: `App.addCaptionAt({startSec, endSec?, text?})` — one `saveState()`, splice at planned index, select new word, full refresh chain (rebuildLayout → editor → inspector → preview → timeline). Verify create + delete round-trip through the existing undo/redo stack. | app.js |
| **5c** | Entry point 1: toolbar "＋ caption at playhead" button (index.html + bind) → `addCaptionAt(playhead)`; disabled without a transcript; status note on no-room rejection. | index.html + app.js |
| **5d** | Entry point 2: dbl-click empty lane space in the view → new `onAddCaption({startSec})` callback → same App path. Must NOT regress box dbl-click seek, ruler seek, or ghost-drag suppression; view stays data-free (reports, never mutates). | timeline-view.js |
| **5e** | Make the new caption editable end-to-end: text edit on a fresh word (F2/enterTextEdit by index), placeholder/empty-text edge cases in grouping + render, appears in preview canvas and SRT/VTT export; timeline box selectable/ draggable like any word (CTC-protection via userAdjusted). | app.js + editor |
| **5f** | Browser QA script (button create, dbl-click create, undo/redo LIFO incl. rapid mixed gestures, unique-id audit, export reflection), docs closeout, push, PR #13 update. | QA + docs |

**Dependencies:** strict order 5a→5b→{5c,5d}→5e→5f. 5c and 5d could share a
session if context allows after a light 5b.

**Test baseline entering Phase 5:** `node --test tests/*.test.mjs` =
**179 pass, 0 fail** (178 + CTC follow-up 2 split of the backward-jump test).

---

## Phase 5a — pure create logic (`planNewCaption`) (2026-11-01)

**Shipped:** `timeline-model.js` gains `planNewCaption({words, startSec,
endSec?, text?, durationSec?})` → `{ok:true, word, index, shrunk}` |
`{ok:false, reason:'bad-start'|'no-room'}`, plus `nextWordId(words)` and
constants `MIN_CAPTION_SEC` (0.1, matches groupWords' emitted-cue floor) /
`DEFAULT_CAPTION_SEC` (1.0). Pure — never mutates input; App commits in 5b.

**Semantics locked by tests (13 new, `tests/timeline-create.test.mjs`):**
- id = `w####` continuation of max numeric suffix — scan covers splitWord's
  6-digit `w<date6>` ids (a plain count would collide); taken-id loop guard.
- start clamps to [0, duration]; degenerate span (click at media end /
  endSec==startSec) restores the DEFAULT length pulled backwards.
- Shrink into the live gap: nearest live END inside pushes start right,
  nearest live START inside pulls end left (single pass, order-independent —
  prevEnd/nextStart computed before applying); word fully CONTAINING the
  span ⇒ 'no-room'. < MIN remaining ⇒ 'no-room'. Touching neighbours OK,
  overlap never.
- Deleted words' timings don't block; junk entries (null, missing stamps)
  tolerated; deleted words still count for the sorted insert index.
- New word flags: `userAdjusted:true, estimated:false, deleted:false`,
  `origStart/origEnd` = own span ⇒ CTC realign and drift detection both
  treat user-created captions as untouchable/never-modified.

**Tests:** `node --test tests/*.test.mjs` = **192 pass, 0 fail**
(baseline 179). No app/view changes — 5b wires the App funnel.

**Next sub-phase:** 5b — `App.addCaptionAt()` mutation funnel: one
`saveState()`, splice plan.word at plan.index, `selectWord(newIndex)`, full
refresh chain; status note on 'no-room'; undo/redo round-trip of create. STOP.

---

## Phase 5b — App.addCaptionAt() mutation funnel (2026-11-01)

**Shipped:** `App.addCaptionAt({ startSec, endSec, text })` in `app.js`
(right after `applyTimelineEdit`): `planNewCaption` (5a) plans PURE → on
`!plan.ok` a status note ('no-room' vs generic) and `return false` with
ZERO writes and no undo save → else exactly one `saveState()` → `splice
(plan.index, 0, plan.word)` → `rebuildLayout()` → `selectWord(plan.index,
{ seek: false })` (covers editor re-render + inspector + timeline highlight;
creating ≠ navigation) → `renderTranscriptDisplay()` → `updatePreview()` →
`timeline?.invalidate()`. Status note names the new span (or the shrink).
`app.js` import line extended to `{ commitProposal, planNewCaption }`.

**Tests:** `tests/timeline-create-funnel.test.mjs` (new, 13): 7 functional
mirrors of the commit path against the REAL planNewCaption + groupWords
(sorted insert + unique id + appears in derived cue list; undo/redo stack
round-trip byte-identical; rejected plan = no save no write; shrunk-gap
contract; bad-start hard reject; <MIN gap rejected; planned word is
JSON-serializable) + 6 source-level guards pinning the funnel contract
(same convention as timeline-commit.test.mjs): one saveState gated on
plan.ok, splice at plan.index, selectWord seek:false AFTER the splice,
full refresh chain, no-room status note.

**Failure logged:** first test run 1 fail — MY assertion was wrong, app was
right (recurring pitfall): `startSec 1.2` with default 1.0 s span SHRINKS
into the gap [2, 2.2] instead of being rejected, so the "rejected plan"
mirror's fallback branch compared the wrong slice. Fixed by using a span
fully inside a live word (1.2–1.5) for the true rejection case and adding a
separate test for the shrunk-gap contract. Lesson: derive create-plan
expectations from planNewCaption's shrink rules, never intuition.

**Tests:** `node --test tests/*.test.mjs` = **205 pass, 0 fail** (baseline 192).

**Next sub-phase:** 5c — toolbar "＋ caption at playhead" button (index.html
+ bindTimeline/toolbar wiring → `addCaptionAt(this.video.currentTime)`;
disabled without a transcript). 5d after that (dbl-click empty lane →
`onAddCaption({startSec})` view callback — view reports, never mutates).
STOP after 5d unless context is clearly ample.

---

## Phase 5c + 5d — create entry points: toolbar button + empty-lane dbl-click (2026-11-01)

Shipped together as allowed by the 5 kickoff ("5c and 5d could share a
session"). Both entry points are THIN: they only call the 5b funnel; no
planning or mutation logic lives in the view or the toolbar.

**5c (toolbar button):** `index.html` gets
`<button id="btn-tl-add-caption" ... disabled>＋</button>` in the timeline
toolbar (before "Sel"). `timeline-view.js` `_bindToolbar()` binds
`click → this.onAddCaption({ startSec: null })` (null = "resolve it
yourself"). `app.js` `rebuildLayout()` gates enablement:
`addBtn.disabled = !this.transcript` — so it enables exactly when a
transcript exists, including after load/clear via any path that rebuilds.

**5d (empty-lane dbl-click):** `TimelineView` constructor accepts
`onAddCaption = () => {}`. The existing canvas `dblclick` handler gains an
`else` branch on the box hit-test: no hit below `_laneTop` →
`xToTime(viewport, x)` → guarded (`Number.isFinite && t >= 0`) →
`onAddCaption({ startSec: t })`. Box dbl-click keeps the seek-select
behavior untouched; ruler area still returns early (`y < _laneTop`).
Known accepted quirk: the two single-clicks of a dbl-click fire first, so
a dbl-click on empty lane also seeks there — harmless (playhead lands on
the spot you are creating at, and create never seeks).

**App wiring (both):** `bindTimeline` passes
`onAddCaption: ({ startSec } = {}) => this.addCaptionAt({ startSec: finite
? startSec : (video.currentTime finite ? it : 0) })` — one funnel, one
dispatch point.

**Tests:** `tests/timeline-create-funnel.test.mjs` +3 (13 → 16): button
exists + starts disabled + view report-only (no `saveState|splice|addCaptionAt|transcript`
in `_bindToolbar`), dblclick branch contract (box select kept, xToTime add
path, add is the `i == null` else), App routing with playhead fallback.
Same source-guard convention as the 5b guards.

**Successes:** all 16 funnel tests green first try; full suite
`node --test tests/*.test.mjs` = **208 pass / 0 fail** (baseline 205). No
regression in the 3 dblclick-sensitive paths at source level (box select,
ruler early-return, ghost drag lives in pointer handlers — untouched).

**Not yet verified (defer to 5f browser QA):** real click/dbl-click
dispatch end-to-end (no headless run this session; per convention browser
QA is 5f's job — add `scripts/tl_phase5_qa.cjs` modeled on
`tl_phase4e_qa.cjs`: playwright-core + headless Chrome, SCRATCH env =
native C:/ path with `tl_clip_60.mp4`, run with stdin `</dev/null`).

**Next sub-phase:** 5e — make a fresh caption editable end-to-end: text
edit on a new word (F2/`enterTextEdit` by index), placeholder/empty-text
edge cases in `groupWords` + canvas render, new word appears in preview
canvas and SRT/VTT export, timeline box selectable/draggable like any word
(CTC-protection already via `userAdjusted:true` from 5a). Then 5f (browser
QA script `tl_phase5_qa.cjs`, docs closeout, push, PR #13 update).

---

## Phase 5e — fresh captions fully editable end-to-end: COMPLETE (2026-11-01)

**Shipped:**

- `joinWordTexts(words)` in `timeline-model.js` — the single shared cue-text
  join: trims each word, drops empty/whitespace-only entries, joins with
  SINGLE spaces. All four call sites now use it: `generateSRT`,
  `generateVTT`, `renderTranscriptDisplay`, and the timeline box label.
  The old plain `join(' ')` produced leading spaces (`['', 'alpha']` →
  `' alpha'`) or double spaces (`['a', '', 'b']` → `'a  b'`) in SRT/VTT
  export, the transcript display pane, and box labels.
- **Latent bug fixed (view):** the timeline box label read `b.group.text` —
  a field derived groups do NOT carry (`groupWords` emits
  `{ words, start, end }`) — so box labels silently never rendered (latent
  since Phase 2). `_drawLanes` now derives the label from live words via
  `joinWordTexts(b.group.words)`; the label check is `b.w >= 28 && label`.
- Text-edit paths confirmed end-to-end and contract-pinned (pre-existing
  code, not rewritten): `enterTextEdit(index)` (chip dbl-click at
  app.js:2284, F2 → `selectedWordIndex` at 2655) commits `textContent.trim()`
  with exactly ONE `saveState()` and the full refresh chain
  (rebuildLayout → updatePreview → updateInspector); Escape restores
  `originalText` without writing. The inspector text field writes the
  trimmed value (possibly `''`) by `selectedWordIndex` with one save. A
  fresh word created by the 5b funnel is editable through these paths
  immediately — the planned index is the live index after the splice
  (asserted in tests).

**Contracts locked by tests (21 new, `tests/timeline-edit-text.test.mjs`):**
- `joinWordTexts`: head/mid empty, whitespace-only words, all-empty
  placeholder (→ `''`), null/undefined/empty input, malformed entries.
- A fresh EMPTY caption (`planNewCaption` with `text: ''`) forms a valid
  cue with a finite span, exports an empty text line, never crashes; an
  empty word absorbed into a neighbour group stays clean (`'charlie'`,
  not `' charlie'`).
- SRT/VTT cue-line mirrors: no leading whitespace, no double spaces; typed
  fresh text exports; SRT/VTT parity through the shared helper.
- Transcript display pane stays clean with placeholder words.
- `computeLayout` (deterministic `measureText` stub): an empty word keeps
  its slot at zero width with finite x; an all-empty group gets
  `totalWidth 0`, finite x — no crash.
- Text edit by index flows to groups, export text, and display text
  (`'alpha fresh caption bravo'`); inspector clearing a word to `''` stays
  clean downstream.
- `groupBoxes`: the fresh caption gets a box with label `'fresh'` and
  `wordIndex` mapping back to its live array index — the selectable/
  draggable data-side contract (CTC protection already via 5a's
  `userAdjusted:true`).
- Source guards (same convention as 5b/5c/5d): SRT/VTT/display all use
  `joinWordTexts` with no raw joins left; `enterTextEdit` by index + one
  save + refresh chain + Escape-cancel; F2 and chip dblclick route by
  index; inspector text handler writes the trimmed value with exactly one
  save; view label derived from live words, zero `b.group.text` reads left.

**Tests:** `node --test tests/*.test.mjs` = **229 pass, 0 fail**
(baseline 208).

**Files changed:** `app/assets/timeline-model.js` (+`joinWordTexts`),
`app/assets/app.js` (import + SRT/VTT/display joins),
`app/assets/timeline-view.js` (box label from live words),
`tests/timeline-edit-text.test.mjs` (new, 21), this doc.

**Known limitations / deferred to 5f:** real-browser end-to-end (F2 typing
into a fresh word, button create, dbl-click create, undo/redo LIFO with
rapid mixed gestures, unique-id audit, export reflection on the live DOM)
is 5f's job — `scripts/tl_phase5_qa.cjs` modeled on `tl_phase4e_qa.cjs`
(playwright-core headless Chrome, `SCRATCH`/`NODE_PATH` as `C:/` native
paths, stdin `</dev/null`, wrap `App.addCaptionAt`/`App.saveState` without
replacing hooks).

**Next sub-phase:** 5f — browser QA + closeout: `scripts/tl_phase5_qa.cjs`
(button create, empty-lane dbl-click create, undo/redo LIFO incl. rapid
mixed gestures, unique-id audit, export reflection, F2 text edit on a fresh
word), docs closeout, push, PR #13 update. STOP after 5f — do NOT merge
before the user's word.

---

## Phase 5f — browser QA + Phase 5 closeout: COMPLETE (2026-11-01)

**QA script:** `scripts/tl_phase5_qa.cjs` (playwright-core headless Chrome,
pattern of `tl_phase4e_qa.cjs`: local file server + clip served at
`/tl_clip_60.mp4`, `SCRATCH`/`NODE_PATH` as native `C:/` paths, stdin
`</dev/null`). Instrumentation wraps `App.addCaptionAt`/`App.saveState` as
counting pass-throughs — hooks are never replaced (4d lesson preserved).

**Run:** from the QA env dir:
`SCRATCH='C:/Users/<user>/AppData/Local/Temp/pw4c' NODE_PATH='<same>/node_modules' node scripts/tl_phase5_qa.cjs </dev/null`

**Scenarios — 30/30 PASS, zero page errors:**
- **S0** gating: `#btn-tl-add-caption` disabled without transcript, enabled with one.
- **S1** button create: playhead 20.4 → word 20.4–21.4, exactly one funnel
  create + one save; new word is user data from birth (`userAdjusted:true`,
  `estimated:false`, `orig*` = own span); new word selected, playhead unmoved.
- **S2** dbl-click: empty-lane dbl-click at 11.0 s creates at cursor time
  (±1 px); dbl-click on an existing box still selects + seeks and creates
  nothing; no-room position → `false`, zero words, zero saves.
- **S3** rapid mixed gestures create→drag→F2-edit: one save each; staged LIFO
  undo unwinds exactly one gesture per press (full state-string diff against
  snapshots); redo ×3 restores; Escape in F2 edit cancels with zero saves.
- **S4** unique-id audit: seeded date-style `w251031` + non-numeric `x9`;
  three creates → `w251032/33/34`, all 7 ids unique.
- **S5** export reflection: fresh EMPTY caption is a real cue with an empty
  text line; typed text appears in SRT; SRT/VTT cue-text parity via shared
  `joinWordTexts`; no double/leading spaces; display pane reflects edits.

**Two real bugs found by the QA run and fixed (app.js):**
1. `enterTextEdit` blur-commit called `rebuildLayout` → `updatePreview` but
   NOT `renderTranscriptDisplay()` — the transcript display pane kept stale
   text after an F2 edit until some unrelated refresh.
2. Inspector `#inspector-text` change handler: same missing
   `renderTranscriptDisplay()`.
Both commit paths now run the full chain; the two source-guard tests in
`tests/timeline-edit-text.test.mjs` were tightened to require the call
(the inspector guard now scopes to the text handler itself).

**Test baseline:** `node --test tests/*.test.mjs` = **229 pass, 0 fail**.

## Phase 5 complete — as-built summary (2026-11-01)

Create-caption UX (Q4) shipped as both entries: toolbar button (playhead)
and empty-lane dbl-click (cursor time), through one funnel
(`App.addCaptionAt` → `planNewCaption`) with one save per create, standard
undo/redo, id allocation covering `w<date6>` suffixes, user-created words
CTC-protected from birth, and full editor/preview/display/SRT/VTT
reflection. P5 acceptance criteria met.

**State:** Phase 5 = 5a (`planNewCaption`), 5b (funnel), 5c+5d (entry
points), 5e (fresh-caption editability + display-refresh fixes), 5f (QA +
closeout). PR #13 pushed, NOT merged — awaiting the user's word +
real-ASR dogfood (Phase 6 plan: full-workflow regression pass).

---

## Phase 6 — Full-workflow regression pass: COMPLETE (2026-11-12)

**Script:** `scripts/tl_phase6_workflow_qa.cjs` (playwright-core headless
Chrome; same server/hook pattern as 5f — counting pass-through on
`App.saveState`, hooks never replaced). Purpose-built speech asset:
`tl_clip_speech.mp4` in the QA scratch dir — 8.7 s, testsrc2 video +
Windows-SAPI TTS speech ("The quick brown fox… caption timing check.",
1 s lead silence), h264/aac, generated with local ffmpeg.

**Run:** from the QA env dir, set `SCRATCH` + `NODE_PATH` to the C:/ paths
(clip `tl_clip_speech.mp4` next to `tl_clip_60.mp4`). NOTE: run it detached
(PowerShell `Start-Process node … -RedirectStandardOutput`) — this machine's
agent background shell cannot spawn node.exe with redirected stdio
("stdin/stdout is not a tty").

**Result — 32/32 PASS, zero page errors (2 runs).** All real pipeline:
- **S0 gating** — buttons gated before video/transcript.
- **S1 REAL transcription** — bundled whisper-base (136 MB local ONNX),
  ffmpeg.wasm audio extraction, 15/15 expected words in 53 s, orig*
  snapshots on every word, sane monotone timestamps, `_audioCache`
  populated with the same file, editor chips + SRT cues render (5 grouped
  cues for 15 words).
- **S2 estimated-flag flow** — forced-estimated word shows
  `needs-attention`; inspector nudge +0.05 s → one save, chip flips to
  `adjusted` (green beats attention).
- **S3 REAL CTC realign + revert** — ~91 MB wav2vec2 q8 download,
  `Realigned 13 of 15 — 2 kept (no CTC evidence)`; manually adjusted word
  preserved byte-exact, order monotone, re-timed words' `estimated`
  cleared; revert restores the full pre-realign state (timings + flags +
  snapshot cleared). The `env.allowRemoteModels=false` interaction worry
  was unfounded: realign works after a bundled local-model transcription.
- **S4 styling + presets** — live style update; preset save (prompt dialog
  answered by harness) → load roundtrip restores values; export JSON has
  name/font/effects/grouping.
- **S5 create funnel on real transcript** — playhead parked in a real gap
  (0.05 s; default 1.0 s caption next to a word at 0.8 s is a legitimate
  no-room reject, first harness pass proved it); +1 word, one save.
- **S6 REAL burn-in export** — ffmpeg.wasm encode, download captured,
  verified EXTERNALLY: ffprobe duration 8.744 s exact + h264/aac streams
  (audio copy); frame PSNR vs source at same timestamps = 43.6 dB in the
  caption-free region vs 21.4 dB inside speech → captions demonstrably
  burned in, non-caption frames untouched.
- **S7 cancel on 60 s media** — export cancelled mid-render, status
  reported, FFmpeg worker re-initialises, no download leaked.

**Harness lessons (all failures were harness-side, zero app bugs found):**
1. `statusMsgs` is a Node variable — referencing it inside
   `page.waitForFunction` throws on the first poll and leaks as PAGEERROR.
   Poll Node-side (`waitStatus()` helper).
2. QA test servers must answer HEAD with real `Content-Length` —
   `probeModelLocal` treats 0/missing as "not bundled" and silently
   re-downloads the whole 136 MB model (and the renderer then OOM-crashed
   at default heap; launch Chrome with
   `--js-flags=--max-old-space-size=6144`).
3. Export frame-diffs must sample before the earliest caption that exists
   AT EXPORT TIME — a caption created by the S5 funnel at 0.05 s made the
   t=0.4 s "silent" sample legitimately differ.

## Phase 6 — cross-phase regression sweep + stale-assertion fixes

All 8 prior browser suites re-run against this branch's HEAD
(`p6_sweep.bat` pattern; regenerate scratch clips if aged out:
`tl_clip.mp4` = 12 s testsrc+sine, `tl_clip_60.mp4` = 60 s, both
640×360@10 h264/aac via ffmpeg lavfi; `tl_phase3_qa.mjs` needs a `.cjs`
copy to run since it uses require()).

- phase4c 19/19, 4d 20/20, 4e 30/30, 4f 9/9, lanes 8/8, phase5 30/30 — green.
- Two STALE expectations fixed (app behavior is the intended post-fix
  semantics; see lane-packing fix + 5e label bug-fix):
  - `tl_phase3_qa.mjs` 5c: looked `_laneBoxes[zi]` up positionally —
    invalid-cue lane reservation no longer keeps boxes in group-index
    order, so it sampled a neighbour. Now `.find(b => b.index === zi)`
    and asserts `widened && !degenerate` (groupWords normalises a
    collapsed cue to +0.1 s → valid span widened to MIN_BOX_PX;
    `degenerate` is reserved for NaN/inverted spans).
  - `tl_phase4b_qa.cjs`: expected 1 color inside a low-zoom box, but 5e
    fixed labels (never rendered before) → fill + label text = 2 colors
    is correct; sub-box outlines stay gated at WORD_SUB_PPS (assertion
    now `colors <= 2`, hi-zoom ON-check unchanged proves the gate).
- After fixes: phase3 15/15, phase4b 25/25.

**Unit baseline unchanged:** 229 pass, 0 fail. No app-code changes in
Phase 6 — the pass found no app regressions; all three script edits above
are test-harness corrections.

## Phase 6 limitations (documented, P6 acceptance criteria otherwise met)

1. Real Whisper run in QA uses the bundled `base` model on clean TTS
   speech — the user's own dogfood with `large-v3-turbo` on real footage
   remains the human acceptance step (clean TTS exercised 0 repaired
   timestamps; the repaired/estimated paths are covered by the sanitize
   unit suite + forced-flag browser check).
2. Burn-in check is PSNR-based evidence (caption window differs strongly,
   silent window matches source), not OCR of the burned text.
3. Long-media check is the 60 s clip cancel path; no full multi-minute
   encode in CI (wasm encode time).

**State:** Phases 1–6 COMPLETE. PR #13 pushed with the Phase 6 closeout,
NOT merged — awaiting the user's word.
