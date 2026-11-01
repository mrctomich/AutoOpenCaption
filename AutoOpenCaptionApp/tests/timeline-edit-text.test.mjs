/**
 * Phase 5e — fresh captions fully editable end-to-end.
 *
 * A fresh caption is created with NO text (planNewCaption default) and its
 * text arrives later — chip double-click / F2 (enterTextEdit by index) or
 * the inspector field. Two contracts must hold end-to-end:
 *   1. Editing text by index flows through grouping, preview layout, the
 *      transcript display pane, SRT/VTT export, and timeline box labels.
 *   2. Empty/placeholder text never breaks grouping or rendering and never
 *      produces leading/double spaces in exported or displayed text.
 *
 * Convention per 5b: pure functions (joinWordTexts, planNewCaption,
 * groupWords, computeLayout, groupBoxes) are tested functionally; the App
 * and TimelineView wiring is pinned at source level against app.js /
 * timeline-view.js (they need the DOM, which lands in the 5f browser QA).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    planNewCaption, groupBoxes, joinWordTexts,
} from '../app/assets/timeline-model.js';
import { groupWords, computeLayout } from '../app/assets/caption-renderer.js';

const W = (id, start, end, text = id, extra = {}) => ({
    id, text, start, end, deleted: false,
    origStart: start, origEnd: end,
    originalStart: start, originalEnd: end,
    ...extra,
});

const GROUPING = { maxWords: 8, maxSeconds: 4, maxCharacters: 42 };

const STYLE = {
    mainSize: 42, activeSize: 46, font: 'Arial', activeWordBold: true,
    position: { yPx: 900 },
};

// ── computeLayout needs a canvas; minimal stub (file-local) ──────────
// Node has no DOM; the renderer only needs measureText for layout math.
// Deterministic width = 10 px per character (0 for empty text).
globalThis.document = {
    createElement: () => ({
        width: 1, height: 1,
        getContext: () => ({
            measureText: (t) => ({ width: String(t ?? '').length * 10 }),
        }),
    }),
};

// ── A. joinWordTexts — the shared text join ─────────────────────────

test('joinWordTexts: plain join with single spaces', () => {
    assert.equal(
        joinWordTexts([W('a', 1, 2, 'alpha'), W('b', 3, 4, 'bravo')]),
        'alpha bravo',
    );
});

test('joinWordTexts: empty text mid-list leaves no double space', () => {
    assert.equal(
        joinWordTexts([W('a', 1, 2, 'alpha'), W('e', 3, 4, ''), W('b', 5, 6, 'bravo')]),
        'alpha bravo',
    );
});

test('joinWordTexts: empty text at the head leaves no leading space', () => {
    assert.equal(
        joinWordTexts([W('e', 1, 2, ''), W('a', 3, 4, 'alpha')]),
        'alpha',
    );
});

test('joinWordTexts: all-empty list (placeholder caption) is empty string', () => {
    assert.equal(joinWordTexts([W('e', 1, 2, '')]), '');
    assert.equal(joinWordTexts([W('e1', 1, 2, ''), W('e2', 3, 4, '')]), '');
});

test('joinWordTexts: whitespace-only words are dropped, words are trimmed', () => {
    assert.equal(
        joinWordTexts([W('a', 1, 2, '  hello '), W('w', 3, 4, '   '), W('b', 5, 6, 'world')]),
        'hello world',
    );
});

test('joinWordTexts: null/undefined/empty input and malformed entries', () => {
    assert.equal(joinWordTexts(null), '');
    assert.equal(joinWordTexts(undefined), '');
    assert.equal(joinWordTexts([]), '');
    assert.equal(
        joinWordTexts([null, W('a', 1, 2, 'alpha'), { id: 'x' }]),
        'alpha',
    );
});

// ── B. Fresh captions through grouping + export (functional mirror) ──

test('5e: fresh empty caption forms a valid group with a finite span', () => {
    const t = {
        durationSec: 20,
        words: [W('w0001', 1, 2, 'alpha'), W('w0002', 20, 21, 'bravo')],
    };
    const plan = planNewCaption({
        words: t.words, startSec: 10, text: '', durationSec: 20,
    });
    assert.equal(plan.ok, true);
    t.words.splice(plan.index, 0, plan.word);
    const groups = groupWords(t.words, GROUPING);
    const g = groups.find((gr) => gr.words.some((w) => w.id === plan.word.id));
    assert.ok(g, 'the placeholder caption must form its own cue');
    assert.ok(Number.isFinite(g.start) && Number.isFinite(g.end) && g.end > g.start);
    // Placeholder: a legal cue with an empty text line, never a crash.
    assert.equal(joinWordTexts(g.words), '');
});

test('5e: empty caption absorbed into a neighbour group stays clean text', () => {
    // Fresh empty at 6–7, w0003 at 8–9: the empty word starts its own group
    // (6 - 1 > maxSeconds from the first group's start) and w0003 joins it
    // (8 - 6 = 2 s ≤ maxSeconds). A plain join(' ') would emit ' charlie'
    // (leading space); joinWordTexts must not.
    const t = {
        durationSec: 20,
        words: [
            W('w0001', 1, 2, 'alpha'), W('w0002', 3, 4, 'bravo'),
            W('w0003', 8, 9, 'charlie'),
        ],
    };
    const plan = planNewCaption({
        words: t.words, startSec: 6, text: '', durationSec: 20,
    });
    assert.equal(plan.ok, true);
    t.words.splice(plan.index, 0, plan.word);
    const groups = groupWords(t.words, GROUPING);
    const g = groups.find((gr) => gr.words.some((w) => w.id === plan.word.id));
    assert.equal(g.words.length, 2, 'placeholder merges with the neighbour word');
    assert.equal(joinWordTexts(g.words), 'charlie');
    assert.ok(!joinWordTexts(g.words).includes('  '), 'no double spaces');
});

test('5e: SRT cue text lines carry no leading/double spaces (mirror)', () => {
    const t = {
        durationSec: 20,
        words: [
            W('w0001', 1, 2, 'alpha'), W('w0002', 3, 4, 'bravo'),
            W('w0003', 8, 9, 'charlie'),
        ],
    };
    const p1 = planNewCaption({ words: t.words, startSec: 6, text: '', durationSec: 20 });
    t.words.splice(p1.index, 0, p1.word);
    const p2 = planNewCaption({ words: t.words, startSec: 12, text: 'delta echo', durationSec: 20 });
    assert.equal(p1.ok, true);
    assert.equal(p2.ok, true);
    t.words.splice(p2.index, 0, p2.word);
    const groups = groupWords(t.words, GROUPING);
    // Mirror generateSRT's per-cue line: joinWordTexts(group.words).
    const lines = groups.map((g) => joinWordTexts(g.words));
    for (const line of lines) {
        assert.ok(!/^\s/.test(line), `no leading whitespace in cue: ${JSON.stringify(line)}`);
        assert.ok(!line.includes('  '), `no double spaces in cue: ${JSON.stringify(line)}`);
    }
    assert.ok(lines.includes('charlie'));
    assert.ok(lines.includes('delta echo'), 'the typed fresh caption exports its text');
});

test('5e: VTT cue text equals the SRT cue text (export parity)', () => {
    const t = {
        durationSec: 20,
        words: [W('w0001', 1, 2, 'alpha'), W('w0002', 8, 9, 'bravo')],
    };
    const plan = planNewCaption({
        words: t.words, startSec: 5, text: '', durationSec: 20,
    });
    t.words.splice(plan.index, 0, plan.word);
    const groups = groupWords(t.words, GROUPING);
    // generateSRT and generateVTT both derive the cue text the same way;
    // pin that the shared helper is the single source for both.
    const srtTexts = groups.map((g) => joinWordTexts(g.words));
    const vttTexts = groups.map((g) => joinWordTexts(g.words));
    assert.deepEqual(vttTexts, srtTexts);
});

test('5e: transcript display pane stays clean with placeholder words', () => {
    const t = {
        durationSec: 20,
        words: [W('w0001', 1, 2, 'alpha'), W('w0002', 8, 9, 'bravo')],
    };
    const plan = planNewCaption({
        words: t.words, startSec: 5, text: '', durationSec: 20,
    });
    t.words.splice(plan.index, 0, plan.word);
    const fullText = joinWordTexts(t.words.filter((w) => !w.deleted));
    assert.equal(fullText, 'alpha bravo');
});

// ── C. Preview canvas layout (computeLayout with the canvas stub) ────

test('5e: computeLayout with an empty word — one entry, zero width, no crash', () => {
    const t = {
        durationSec: 20,
        words: [
            W('w0001', 1, 2, 'alpha'), W('e', 3, 4, ''), W('w0002', 5, 6, 'bravo'),
        ],
    };
    // Loose grouping so all three words land in ONE group.
    const groups = groupWords(t.words, {
        maxWords: 12, maxSeconds: 30, maxCharacters: 60,
    });
    assert.equal(groups.length, 1);
    const layout = computeLayout(groups, STYLE, 800, 450);
    assert.equal(layout.length, 1);
    assert.equal(layout[0].layouts.length, 3, 'every word gets a layout entry');
    const empty = layout[0].layouts.find((l) => l.word.id === 'e');
    assert.ok(empty);
    assert.equal(empty.normalW, 0, 'empty text measures zero width');
    assert.equal(empty.activeW, 0);
    assert.ok(Number.isFinite(empty.x), 'the placeholder keeps its slot position');
    // Neighbours still measure normally and the row stays centered.
    assert.ok(layout[0].totalWidth > 0);
    assert.ok(Number.isFinite(layout[0].x));
});

test('5e: computeLayout on an all-empty placeholder group — no crash', () => {
    const groups = groupWords(
        [W('e', 10, 11, '')],
        { maxWords: 12, maxSeconds: 30, maxCharacters: 60 },
    );
    assert.equal(groups.length, 1);
    const layout = computeLayout(groups, STYLE, 800, 450);
    assert.equal(layout[0].totalWidth, 0);
    assert.ok(Number.isFinite(layout[0].x));
});

// ── D. Text edit by index (functional mirrors of the commit paths) ───

test('5e: editing text by index flows to groups, export text, display text', () => {
    const t = {
        durationSec: 20,
        words: [W('w0001', 1, 2, 'alpha'), W('w0002', 11, 12, 'bravo')],
    };
    const plan = planNewCaption({
        words: t.words, startSec: 6, text: '', durationSec: 20,
    });
    t.words.splice(plan.index, 0, plan.word);
    // The funnel selects the new word (selectWord(plan.index)); F2 / chip
    // dblclick / inspector all write words[index].text — mirror that write.
    const idx = t.words.findIndex((w) => w.id === plan.word.id);
    assert.equal(idx, plan.index, 'planned index is the live index after splice');
    t.words[idx].text = 'fresh caption';
    const groups = groupWords(t.words, GROUPING);
    const g = groups.find((gr) => gr.words.some((w) => w.id === plan.word.id));
    assert.equal(joinWordTexts(g.words), 'fresh caption');
    assert.equal(joinWordTexts(t.words.filter((w) => !w.deleted)), 'alpha fresh caption bravo');
});

test('5e: inspector clearing a word back to empty stays clean downstream', () => {
    const t = {
        durationSec: 20,
        words: [
            W('w0001', 1, 2, 'alpha'), W('w0002', 3, 4, 'bravo'),
            W('w0003', 8, 9, 'charlie'),
        ],
    };
    // Inspector change handler writes the trimmed value (possibly '').
    const idx = 1;
    t.words[idx].text = '';
    const groups = groupWords(t.words, GROUPING);
    const lines = groups.map((g) => joinWordTexts(g.words));
    for (const line of lines) {
        assert.ok(!/^\s/.test(line));
        assert.ok(!line.includes('  '));
    }
    assert.ok(lines.every((l) => !l.includes('bravo') || l === 'bravo'));
    assert.equal(joinWordTexts(t.words), 'alpha charlie');
});

// ── E. Timeline box labels (functional + source) ─────────────────────

test('5e: groupBoxes label contract for a fresh caption', () => {
    const t = {
        durationSec: 20,
        words: [
            W('w0001', 1, 2, 'alpha'), W('w0002', 11, 12, 'bravo'),
        ],
    };
    const plan = planNewCaption({
        words: t.words, startSec: 6, text: 'fresh', durationSec: 20,
    });
    t.words.splice(plan.index, 0, plan.word);
    const groups = groupWords(t.words, GROUPING);
    const vp = { pps: 100, viewStartSec: 0, viewWidthPx: 2000, durationSec: 20 };
    const boxes = groupBoxes(vp, groups, t.words);
    const b = boxes.find((box) => box.group.words.some((w) => w.id === plan.word.id));
    assert.ok(b, 'the fresh caption gets a box');
    // The label the view draws (5e fix: derived from live words, not a
    // nonexistent group.text field).
    assert.equal(joinWordTexts(b.group.words), 'fresh');
    // The box's wordIndex maps the fresh word back to its live array
    // index — the same index the drag/edit funnels use (selectable +
    // draggable contract, data side).
    const wi = b.wordIndex[0];
    assert.equal(t.words[wi].id, plan.word.id);
});

// ── Source-level guards ──────────────────────────────────────────────

const appSrc = readFileSync(
    fileURLToPath(new URL('../app/assets/app.js', import.meta.url)), 'utf8',
);
const viewSrc = readFileSync(
    fileURLToPath(new URL('../app/assets/timeline-view.js', import.meta.url)), 'utf8',
);

const sliceFn = (src, name) => {
    // Slice one class method: match the DEFINITION (4-space indent +
    // opening brace) so call sites like `this.foo(...)` never win, and cut
    // at the method's own 4-space closing brace (class methods close with
    // `    }`, not `    },` — the body is indented 8+, so the first 4-space
    // close after the head is the method's end).
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const head = new RegExp('^    ' + esc + '\\s*\\{', 'm');
    const m = head.exec(src);
    assert.ok(m, `method definition not found: ${name}`);
    const rest = src.slice(m.index);
    const close = rest.search(/\n    \},?/);
    return close === -1 ? rest.slice(0, 8000) : rest.slice(0, close + 6);
};

test('app.js: all text joins go through joinWordTexts', () => {
    assert.match(appSrc, /import\s*\{[^}]*joinWordTexts[^}]*\}\s*from\s*'\.\/timeline-model\.js'/);
    const srt = sliceFn(appSrc, 'generateSRT()');
    const vtt = sliceFn(appSrc, 'generateVTT()');
    const display = sliceFn(appSrc, 'renderTranscriptDisplay()');
    assert.match(srt, /joinWordTexts\(group\.words\)/, 'SRT cue text must use the shared join');
    assert.match(vtt, /joinWordTexts\(group\.words\)/, 'VTT cue text must use the shared join');
    assert.match(display, /joinWordTexts\(words\)/, 'display pane must use the shared join');
    // No stray raw joins left in these paths.
    for (const [name, src] of [['generateSRT', srt], ['generateVTT', vtt],
        ['renderTranscriptDisplay', display]]) {
        assert.ok(!src.includes(".map(w => w.text).join(' ')"),
            `${name} must not bypass joinWordTexts`);
    }
});

test('app.js: enterTextEdit edits by index and commits the trimmed text', () => {
    const fn = sliceFn(appSrc, 'enterTextEdit(index)');
    assert.match(fn, /if\s*\(\s*index\s*<\s*0\s*\|\|\s*!this\.transcript\s*\)\s*return;/);
    assert.match(fn, /const word = this\.transcript\.words\[index\]|words\[index\]/,
        'must resolve the word by index');
    assert.match(fn, /chip\.querySelector\('\.word-text'\)/,
        'must target the chip\'s .word-text span');
    assert.match(fn, /textSpan\.contentEditable = 'true'/);
    // Commit: trim, one save, write by index, refresh downstream.
    assert.match(fn, /const newText = textSpan\.textContent\.trim\(\)/);
    assert.match(fn, /this\.transcript\.words\[index\]\.text = newText;/);
    assert.equal((fn.match(/this\.saveState\(\)/g) || []).length, 1,
        'exactly one undo save per text commit');
    for (const call of ['rebuildLayout()', 'updatePreview()', 'updateInspector()']) {
        assert.ok(fn.includes(call), `commit must call ${call}`);
    }
    // Escape cancels without writing.
    assert.match(fn, /cancelled = true;/);
    assert.match(fn, /textSpan\.textContent = originalText;/);
});

test('app.js: F2 and chip dblclick route into enterTextEdit by index', () => {
    const f2 = sliceFn(appSrc, 'bindKeyboardShortcuts()');
    assert.match(f2,
        /e\.key === 'F2'[\s\S]{0,200}?this\.enterTextEdit\(this\.selectedWordIndex\)/,
        'F2 must edit the selected word by index');
    const dbl = appSrc.slice(appSrc.indexOf("chip.addEventListener('dblclick'"),
        appSrc.indexOf("chip.addEventListener('dblclick'") + 200);
    assert.match(dbl, /this\.enterTextEdit\(i\)/,
        'chip dblclick must edit that chip\'s word by its index');
});

test('app.js: inspector text field writes the trimmed value by selected index', () => {
    const fn = sliceFn(appSrc, 'bindInspectorControls()');
    assert.match(fn, /this\.transcript\.words\[this\.selectedWordIndex\]\.text = e\.target\.value\.trim\(\)/);
    // bindInspectorControls has 3 change handlers (text/start/end), each with
    // exactly one undo save — count only inside the text handler.
    const textHandler = fn.slice(
        fn.indexOf("textInput.addEventListener('change'"),
        fn.indexOf("textInput.addEventListener('keydown'"));
    assert.equal((textHandler.match(/this\.saveState\(\)/g) || []).length, 1,
        'inspector text change: exactly one undo save');
    for (const call of ['rebuildLayout()', 'renderTranscriptEditor()', 'updatePreview()']) {
        assert.ok(fn.includes(call), `inspector commit must call ${call}`);
    }
});

test('timeline-view: box label derived from live words; dead group.text gone', () => {
    assert.match(viewSrc, /joinWordTexts,?\s*\n?\s*\}\s*from\s*'\.\/timeline-model\.js'/);
    const draw = sliceFn(viewSrc, '_drawLanes(w, top, height)');
    assert.match(draw, /if\s*\(\s*b\.w\s*>=\s*28\s*&&\s*label\s*\)/);
    assert.ok(!viewSrc.includes('b.group.text'),
        'no reads of the nonexistent group.text field remain');
});
