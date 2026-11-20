/**
 * Word Editor selection integrity (the two "wrong word is selected" bugs).
 *
 * Bug 1 — clicking a word previewed and highlighted the word BEFORE it:
 * adjacent cues share a boundary (previous.end === next.start) and the cue
 * lookup returned the FIRST cue containing the time, so a playhead parked at
 * word.start resolved to the previous cue. A seek can also land a hair BEFORE
 * the requested time (players quantize to the media's frame step), which no
 * time-only lookup can recover — resolvePreviewCue() honours the word the
 * playhead was sent to while the video is paused.
 *
 * Bug 2 — the inspector bar vanished mid-edit: it was hidden whenever nothing
 * was selected, and two paths cleared the selection (the document-level
 * deselect keyed on `click`, which reports the common ancestor of a
 * text-selection drag, and Escape pressed inside an inspector field, whose
 * own blur() made the global handler believe the user was not editing).
 *
 * Layers: pure model functions imported directly, the REAL extracted
 * updateInspector against a DOM stub, and source-guards on the wiring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findGroupAtTime, findWordAtTime, resolvePreviewCue, groupWords }
    from '../app/assets/caption-renderer.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
    .replace(/\r\n/g, '\n');
const appSrc = read('../app/assets/app.js');
const htmlSrc = read('../app/index.html');
const cssSrc = read('../app/assets/style.css');

// Contiguous words, exactly what a transcript looks like: word N ends where
// word N+1 starts. maxWords: 1 — the user's reported setting (one word/cue).
const GROUPING = { maxWords: 1, maxSeconds: 2.2, maxCharacters: 32 };
const words = [
    { id: 1, text: 'along', start: 24.76, end: 24.92 },
    { id: 2, text: 'with', start: 24.92, end: 25.12 },
    { id: 3, text: 'seed', start: 25.12, end: 25.40 },
];
const groups = groupWords(words, GROUPING);

// ── 1. cue resolution ────────────────────────────────────────
test('fixture: one cue per word, boundaries shared', () => {
    assert.equal(groups.length, 3);
    assert.equal(groups[0].end, groups[1].start);
    assert.equal(groups[1].end, groups[2].start);
});

test('findGroupAtTime: a shared boundary belongs to the cue that STARTS there', () => {
    // This is the bug: 24.92 is both 'along'.end and 'with'.start, and the
    // first match returned 'along' — the word before the one clicked.
    assert.equal(findGroupAtTime(groups, 24.92), 1);
    assert.equal(findGroupAtTime(groups, 25.12), 2);
    // Interior of a cue is unaffected.
    assert.equal(findGroupAtTime(groups, 24.80), 0);
    assert.equal(findGroupAtTime(groups, 25.00), 1);
    // Edges and gaps keep working.
    assert.equal(findGroupAtTime(groups, 24.76), 0);
    assert.equal(findGroupAtTime(groups, 25.40), 2);
    assert.equal(findGroupAtTime(groups, 20), -1);
    assert.equal(findGroupAtTime(groups, 30), -1);
});

test('findWordAtTime: a multi-word cue activates the incoming word at a join', () => {
    const multi = [
        { id: 10, text: 'the', start: 0, end: 0.4 },
        { id: 11, text: 'seed', start: 0.4, end: 0.9 },
    ];
    assert.equal(findWordAtTime(multi, 0.4), 1);
    assert.equal(findWordAtTime(multi, 0.2), 0);
    assert.equal(findWordAtTime(multi, 0.9), 1);
    assert.equal(findWordAtTime(multi, 1.5), -1);
});

// ── 2. preview resolution (including a quantized seek) ───────
test('resolvePreviewCue: without a preferred word, time decides', () => {
    assert.deepEqual(resolvePreviewCue(groups, 24.92), { groupIndex: 1, wordId: 2 });
    assert.deepEqual(resolvePreviewCue(groups, 25.0), { groupIndex: 1, wordId: 2 });
    assert.deepEqual(resolvePreviewCue(groups, 22), { groupIndex: -1, wordId: null });
});

test('resolvePreviewCue: a seek that landed early inside the PREVIOUS cue shows the sent word', () => {
    // Player quantization: sent to 24.92 ('with'), parked at 24.90 — inside
    // 'along'. The user clicked 'with', so 'with' must be on screen.
    const cue = resolvePreviewCue(groups, 24.90, { preferredWordId: 2 });
    assert.deepEqual(cue, { groupIndex: 1, wordId: 2 });
    // Same time with no selection resolves to 'along' — playback is unchanged.
    assert.deepEqual(resolvePreviewCue(groups, 24.90), { groupIndex: 0, wordId: 1 });
});

test('resolvePreviewCue: the preferred word only wins while the playhead is at its start', () => {
    // 0.3 s past 'with'.start is real playback/scrubbing, not a selection seek.
    assert.deepEqual(resolvePreviewCue(groups, 25.30, { preferredWordId: 2 }),
        { groupIndex: 2, wordId: 3 });
    // A word that is no longer in the cue list (deleted) never wins.
    assert.deepEqual(resolvePreviewCue(groups, 24.80, { preferredWordId: 99 }),
        { groupIndex: 0, wordId: 1 });
});

test('resolvePreviewCue: cue padded past its last word has no active word', () => {
    // groupWords() pads a too-short cue to 0.1 s; the tail has no word.
    const short = groupWords([{ id: 7, text: 'hmm', start: 0, end: 0.02 }], GROUPING);
    assert.equal(short[0].end > 0.02, true);
    assert.deepEqual(resolvePreviewCue(short, 0.09), { groupIndex: 0, wordId: null });
});

// ── 3. the inspector bar: real updateInspector against a DOM stub ──
const controlsSrc = appSrc.match(/const INSPECTOR_CONTROLS = \[([\s\S]*?)\];/);
assert.ok(controlsSrc, 'INSPECTOR_CONTROLS list not found in app.js');
const CONTROLS = [...controlsSrc[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

const sig = 'updateInspector() {';
const fnStart = appSrc.indexOf(sig);
assert.ok(fnStart >= 0, 'App.updateInspector signature not found in app.js');
const body = appSrc.slice(fnStart, appSrc.indexOf('\n    },', fnStart)).slice(sig.length);

function makeDoc() {
    const els = {};
    const mk = (id) => {
        const el = { id, value: undefined, placeholder: undefined, disabled: false, textContent: undefined, classes: new Set() };
        el.classList = {
            add: (c) => el.classes.add(c),
            remove: (c) => el.classes.delete(c),
            toggle: (c, on) => { (on === undefined ? !el.classes.has(c) : on) ? el.classes.add(c) : el.classes.delete(c); },
            contains: (c) => el.classes.has(c),
        };
        els[id] = el;
    };
    [...CONTROLS, 'word-inspector', 'inspector-align-field', 'inspector-align-note',
        'inspector-jump-hint'].forEach(mk);
    return { els, getElementById: (id) => els[id] || null };
}

function runUpdateInspector({ selectedWordIndex = -1, transcript = { words } } = {}) {
    const doc = makeDoc();
    const fn = new Function('document', 'INSPECTOR_CONTROLS',
        `return function () {${body}};`)(doc, CONTROLS);
    fn.call({ selectedWordIndex, transcript, effectiveCaptionYpx: () => 300 });
    return doc.els;
}

test('inspector controls cover every field the bar exposes', () => {
    for (const id of ['inspector-text', 'inspector-start', 'inspector-end',
        'inspector-split', 'inspector-merge', 'inspector-delete',
        'inspector-jump-y', 'inspector-jump-set', 'inspector-jump-clear']) {
        assert.ok(CONTROLS.includes(id), `${id} must be switched off by the idle state`);
    }
});

test('with no word selected the bar stays visible and goes idle', () => {
    const els = runUpdateInspector({ selectedWordIndex: -1 });
    assert.ok(!els['word-inspector'].classes.has('hidden'),
        'the bar must never be hidden again — that is the disappearing-bar bug');
    assert.ok(els['word-inspector'].classes.has('inspector-idle'), 'idle state applied');
    for (const id of CONTROLS) assert.equal(els[id].disabled, true, `${id} disabled while idle`);
    assert.equal(els['inspector-text'].value, '');
    assert.equal(els['inspector-start'].value, '');
    assert.equal(els['inspector-end'].value, '');
    assert.equal(els['inspector-align-field'].classes.has('hidden'), true);
});

test('with no transcript at all the bar still renders idle, not missing', () => {
    const els = runUpdateInspector({ selectedWordIndex: -1, transcript: null });
    assert.ok(els['word-inspector'].classes.has('inspector-idle'));
    assert.equal(els['inspector-text'].disabled, true);
});

test('a selected word clears the idle state, fills and enables the bar', () => {
    const els = runUpdateInspector({ selectedWordIndex: 1 });
    assert.ok(!els['word-inspector'].classes.has('inspector-idle'), 'idle cleared');
    assert.equal(els['inspector-text'].value, 'with');
    assert.equal(els['inspector-start'].value, '24.92');
    assert.equal(els['inspector-end'].value, '25.12');
    // Merge Next (last word) and Jump Clear (word with no jump anchor) are
    // disabled on purpose AFTER the bar is enabled — asserted below.
    for (const id of CONTROLS.filter((c) => c !== 'inspector-merge' && c !== 'inspector-jump-clear')) {
        assert.equal(els[id].disabled, false, `${id} enabled`);
    }
    assert.equal(els['inspector-merge'].disabled, false, 'not the last word');
    assert.equal(els['inspector-jump-clear'].disabled, true, 'nothing pinned at this word');
});

test('a word with a pinned jump enables Clear; the last word keeps Merge off', () => {
    const pinned = words.map((w, i) => (i === 1 ? { ...w, captionY: 400 } : w));
    const els = runUpdateInspector({ selectedWordIndex: 1, transcript: { words: pinned } });
    assert.equal(els['inspector-jump-clear'].disabled, false, 'Clear applies to a pinned word');
    assert.equal(els['inspector-jump-y'].value, 400);
    const last = runUpdateInspector({ selectedWordIndex: words.length - 1 });
    assert.equal(last['inspector-merge'].disabled, true);
    assert.equal(last['inspector-text'].disabled, false);
});

test('a stale index (word count shrank) renders idle instead of hiding the bar', () => {
    const els = runUpdateInspector({ selectedWordIndex: 99 });
    assert.ok(els['word-inspector'].classes.has('inspector-idle'));
    assert.ok(!els['word-inspector'].classes.has('hidden'));
    assert.equal(els['inspector-text'].disabled, true);
});

// ── 4. source guards on the wiring ───────────────────────────
test('updatePreview resolves the cue through resolvePreviewCue, gated on paused', () => {
    const at = appSrc.indexOf('updatePreview() {');
    const fnSrc = appSrc.slice(at, appSrc.indexOf('\n    },', at));
    assert.match(fnSrc, /const preferredWordId = \(this\.video\.paused && this\.selectedWordIndex >= 0\)/,
        'only a paused playhead may honour the selection — nothing may lead the audio');
    assert.match(fnSrc, /resolvePreviewCue\(this\.captionGroups, time, \{ preferredWordId \}\);/);
    assert.match(fnSrc, /this\.highlightActiveWord\(cue\.wordId\);/,
        'the chip highlight follows the same resolution as the canvas');
    assert.ok(!fnSrc.includes('w.start <= time && w.end >= time'),
        'the old first-match word loop is gone');
});

test('export state changes use the same word boundary rule as the preview', () => {
    const at = appSrc.indexOf('getCaptionStateChanges() {');
    const fnSrc = appSrc.slice(at, appSrc.indexOf('\n    },', at));
    assert.match(fnSrc, /findWordAtTime\(group\.words, t\)/);
});

test('Escape inside an inspector field cannot deselect the word', () => {
    const at = appSrc.indexOf('bindInspectorControls() {');
    const fnSrc = appSrc.slice(at, appSrc.indexOf('\n    },', at));
    // The field's own blur() moves focus to <body> before the document-level
    // keydown handler reads activeElement, so the field must consume the key.
    const stops = (fnSrc.match(/e\.stopPropagation\(\);/g) || []).length;
    assert.ok(stops >= 4, `Enter/Escape in both text and jump fields must stop propagation (${stops} found, need >= 4)`);
});

test('init puts the bar in its idle state on boot', () => {
    assert.match(appSrc, /this\.bindInspectorControls\(\);\n\s*this\.updateInspector\(\);/);
});

test('markup: the bar ships visible and the hint is reserved', () => {
    assert.match(htmlSrc, /<div class="inspector inspector-idle" id="word-inspector">/);
    assert.ok(!/id="word-inspector"[^>]*hidden/.test(htmlSrc), 'no hidden class on the bar');
    assert.match(htmlSrc, /<span class="inspector-hint" id="inspector-hint">/);
});

test('markup: find bar, chip list and inspector all live inside the Word Editor panel', () => {
    const start = htmlSrc.indexOf('<section class="panel panel-word-editor">');
    assert.ok(start >= 0, 'Word Editor panel not found');
    const panel = htmlSrc.slice(start, htmlSrc.indexOf('</section>', start));
    for (const id of ['id="find-bar"', 'id="word-selector"', 'id="word-inspector"',
        'id="inspector-text"', 'id="inspector-jump-set"']) {
        assert.ok(panel.includes(id), `${id} must stay inside .panel-word-editor (press-away exemption)`);
    }
});

test('stylesheet: nothing can hide the bar, and the idle state reads as off', () => {
    assert.ok(!/\.inspector\.hidden\s*\{/.test(cssSrc),
        'the rule that hid the inspector bar is gone for good');
    assert.match(cssSrc, /\.inspector\.inspector-idle \.inspector-field/);
    assert.match(cssSrc, /\.inspector\.inspector-idle \.inspector-hint \{ visibility: visible; \}/);
    assert.match(cssSrc, /\.inspector-hint\s*\{[^}]*visibility: hidden;/s);
    // The bar grows to fit its content (it used to be a fixed 130 px that
    // clipped the Vertical Jump row), and the hint text that only appears while
    // a word is selected must not change its height.
    assert.match(cssSrc, /\.inspector\s*\{[^}]*min-height: 130px;/s);
    assert.match(cssSrc, /\.inspector-jump-hint\s*\{[^}]*display: block;[^}]*min-height: 1\.2em;[^}]*line-height: 1\.2em;/s);
    // updateInspector toggles `hidden` on the CTC provenance row; the class was
    // inert because no scoped rule existed for this component.
    assert.match(cssSrc, /\.inspector-align-note\.hidden \{ display: none; \}/);
});
