/**
 * Keyboard shortcuts (Space play/pause, =/+ and -/_ timeline zoom,
 * i/o set selected-word in/out at the playhead).
 *
 * Same two-layer discipline as the other App-side suites:
 *  1. behavioral tests on setWordEdgeAtPlayhead, extracted from the real
 *     app.js source and invoked with a stub `this` (no DOM needed);
 *  2. source-level guards on bindKeyboardShortcuts for the key map,
 *     guard conditions and preventDefault discipline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── extract the real functions from app.js ────────────────────────

const appSrc = readFileSync(
    fileURLToPath(new URL('../app/assets/app.js', import.meta.url)), 'utf8',
).replace(/\r\n/g, '\n'); // repo files are CRLF; normalize for needle matching

function extractFn(signature) {
    const start = appSrc.indexOf(signature);
    assert.ok(start >= 0, `${signature} not found in app.js`);
    const end = appSrc.indexOf('\n    },', start);
    assert.ok(end > start, `end of ${signature} not found`);
    return appSrc.slice(start, end + '\n    }'.length);
}

const edgeSrc = extractFn('setWordEdgeAtPlayhead(field) {');
const kbdSrc = extractFn('bindKeyboardShortcuts() {');

// Build a callable from the extracted method source: drop the method
// signature, keep the body, rewrap as a plain function expression.
// (Anchor the body on the signature, not indexOf('{') — the JSDoc above
// the method contains braces too.)
const edgeBody = edgeSrc.slice(edgeSrc.indexOf('setWordEdgeAtPlayhead(field) {')
    + 'setWordEdgeAtPlayhead(field) {'.length, edgeSrc.lastIndexOf('}'));
const setWordEdgeAtPlayhead = new Function('return function (field) {' + edgeBody + '}')();

// ── 1. behavioral: setWordEdgeAtPlayhead ──────────────────────────

function stubApp({ word = { start: 2, end: 4 }, selected = 0, time = 3, transcript = true } = {}) {
    const calls = [];
    const app = {
        transcript: transcript ? { words: [word] } : null,
        selectedWordIndex: selected,
        video: { currentTime: time },
        saveState: () => calls.push('saveState'),
        rebuildLayout: () => calls.push('rebuildLayout'),
        renderTranscriptEditor: () => calls.push('renderTranscriptEditor'),
        updateInspector: () => calls.push('updateInspector'),
        updatePreview: () => calls.push('updatePreview'),
    };
    return { app, calls, word };
}

test("i: sets the word's start to the playhead", () => {
    const { app, word } = stubApp({ time: 3 });
    setWordEdgeAtPlayhead.call(app, 'start');
    assert.equal(word.start, 3);
    assert.equal(word.end, 4);
});

test("o: sets the word's end to the playhead", () => {
    const { app, word } = stubApp({ time: 3.5 });
    setWordEdgeAtPlayhead.call(app, 'end');
    assert.equal(word.end, 3.5);
    assert.equal(word.start, 2);
});

test('i clamps at the word end instead of crossing it', () => {
    const { app, word } = stubApp({ time: 9 });
    setWordEdgeAtPlayhead.call(app, 'start');
    assert.equal(word.start, 4); // = word.end, never past it
});

test('o clamps at the word start instead of crossing it', () => {
    const { app, word } = stubApp({ time: 0.5 });
    setWordEdgeAtPlayhead.call(app, 'end');
    assert.equal(word.end, 2); // = word.start, never before it
});

test('marks the word userAdjusted (addressed outline, CTC-safe)', () => {
    const { app, word } = stubApp({ time: 3 });
    assert.equal(word.userAdjusted, undefined);
    setWordEdgeAtPlayhead.call(app, 'start');
    assert.equal(word.userAdjusted, true);
});

test('no-op (same value) does not touch the undo stack', () => {
    const { app, calls, word } = stubApp({ time: 2 }); // start already 2
    setWordEdgeAtPlayhead.call(app, 'start');
    assert.equal(word.start, 2);
    assert.ok(!calls.includes('saveState'), 'no-op must not saveState');
});

test('a real change saves undo exactly once and refreshes downstream', () => {
    const { app, calls } = stubApp({ time: 3 });
    setWordEdgeAtPlayhead.call(app, 'end');
    assert.equal(calls.filter(c => c === 'saveState').length, 1);
    for (const c of ['rebuildLayout', 'renderTranscriptEditor',
        'updateInspector', 'updatePreview']) {
        assert.ok(calls.includes(c), `must call ${c}`);
    }
});

test('guards: no transcript / no selection / bad field / bad time', () => {
    const a = stubApp({ transcript: false });
    setWordEdgeAtPlayhead.call(a.app, 'start');
    assert.equal(a.calls.length, 0);

    const b = stubApp({ selected: -1 });
    setWordEdgeAtPlayhead.call(b.app, 'start');
    assert.equal(b.calls.length, 0);

    const c = stubApp();
    setWordEdgeAtPlayhead.call(c.app, 'middle');
    setWordEdgeAtPlayhead.call(c.app, undefined);
    assert.equal(c.calls.length, 0);

    const d = stubApp({ time: NaN });
    setWordEdgeAtPlayhead.call(d.app, 'start');
    assert.equal(d.calls.length, 0);

    const e = stubApp({ time: Infinity });
    setWordEdgeAtPlayhead.call(e.app, 'start');
    assert.equal(e.calls.length, 0);
});

// ── 2. source guards on the key map ───────────────────────────────

test('space toggles playback with preventDefault, only as a bare key', () => {
    assert.match(kbdSrc, /this\.togglePlay\(\)/);
    assert.match(kbdSrc, /e\.code === 'Space' \|\| e\.key === ' '/);
    // Guarded behind the no-modifier / not-editing branch.
    assert.match(kbdSrc,
        /else if \(!e\.ctrlKey && !e\.metaKey && !e\.altKey && !isEditing\)[\s\S]*?Space[\s\S]*?togglePlay/);
    // A focused button/link keeps native Space activation.
    assert.match(kbdSrc, /isActivatable[\s\S]{0,120}?return;/);
    assert.match(kbdSrc, /tag === 'BUTTON' \|\| tag === 'A'/);
});

test('= and + zoom the timeline in; - and _ zoom out', () => {
    assert.match(kbdSrc, /e\.key === '=' \|\| e\.key === '\+'[\s\S]{0,80}?zoomBy\(1\.6\)/);
    assert.match(kbdSrc, /e\.key === '-' \|\| e\.key === '_'[\s\S]{0,80}?zoomBy\(1 \/ 1\.6\)/);
    // Same factor as the toolbar zoom buttons (timeline-view.js).
    const viewSrc = readFileSync(
        fileURLToPath(new URL('../app/assets/timeline-view.js', import.meta.url)), 'utf8',
    );
    assert.match(viewSrc, /zoomBy\(1\.6\)/);
    assert.match(viewSrc, /zoomBy\(1 \/ 1\.6\)/);
});

test('i and o route to setWordEdgeAtPlayhead start/end', () => {
    assert.match(kbdSrc, /e\.key === 'i'[\s\S]{0,80}?setWordEdgeAtPlayhead\('start'\)/);
    assert.match(kbdSrc, /e\.key === 'o'[\s\S]{0,80}?setWordEdgeAtPlayhead\('end'\)/);
});

test('every new shortcut preventDefaults before acting', () => {
    for (const sig of ['this.setWordEdgeAtPlayhead(\'start\')',
        'this.setWordEdgeAtPlayhead(\'end\')', 'this.timeline?.zoomBy(1.6)',
        'this.timeline?.zoomBy(1 / 1.6)', 'this.togglePlay()']) {
        const at = kbdSrc.indexOf(sig + ';');
        assert.ok(at > 0, `key map must call ${sig}`);
        const before = kbdSrc.slice(Math.max(0, at - 120), at);
        assert.match(before, /e\.preventDefault\(\);\s*$/,
            `${sig} must be preceded by preventDefault`);
    }
});

test('editing-in-progress blocks the bare-key shortcuts', () => {
    // isEditing covers contentEditable, INPUT, TEXTAREA and SELECT.
    assert.match(kbdSrc, /contentEditable === 'true'[\s\S]*?INPUT[\s\S]*?TEXTAREA[\s\S]*?SELECT/);
    // The bare-key branch is gated on !isEditing (Space/zoom/i/o/d).
    assert.match(kbdSrc, /!e\.ctrlKey && !e\.metaKey && !e\.altKey && !isEditing/);
});

test('pre-existing shortcuts survive the rewrite', () => {
    for (const sig of ['this.undo()', 'this.redo()', 'this.enterTextEdit(',
        'this.selectWord(-1)', 'this.deleteWord(', 'this.debugOverlay = !this.debugOverlay']) {
        assert.ok(kbdSrc.includes(sig), `lost pre-existing shortcut: ${sig}`);
    }
});
