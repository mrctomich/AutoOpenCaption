/**
 * Word Editor find & replace bar: search a word Whisper got wrong and
 * replace the next match (step-through, selects + seeks to it) or every
 * match in one undo step.
 *
 * Two layers, per repo convention: the REAL extracted planWordReplace /
 * findNextWord / replaceWordOnce / replaceAllWords run against stub `this`
 * + stub Status (behavioral — the logic is DOM-independent, so this layer
 * reproduces the feature end to end), plus regex source-guards on the
 * find-bar markup, binding, chip highlight class, Ctrl+F/H chords, and
 * find-state resets in clearCaptions / transcribe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appSrc = readFileSync(
    fileURLToPath(new URL('../app/assets/app.js', import.meta.url)), 'utf8',
).replace(/\r\n/g, '\n'); // repo files are CRLF; normalize for needle matching

const htmlSrc = readFileSync(
    fileURLToPath(new URL('../app/index.html', import.meta.url)), 'utf8',
).replace(/\r\n/g, '\n');

const cssSrc = readFileSync(
    fileURLToPath(new URL('../app/assets/style.css', import.meta.url)), 'utf8',
).replace(/\r\n/g, '\n');

// Module-level pure function: body ends at a column-0 '}'.
function extractFn(signature) {
    const start = appSrc.indexOf(signature);
    assert.ok(start >= 0, `${signature} not found in app.js`);
    const end = appSrc.indexOf('\n}', start + signature.length);
    assert.ok(end > start, `end of ${signature} not found`);
    return appSrc.slice(start + signature.length, end);
}

// App method: body ends at the next column-4 '},'.
function extractBody(signature) {
    const start = appSrc.indexOf(signature);
    assert.ok(start >= 0, `${signature} not found in app.js`);
    const end = appSrc.indexOf('\n    },', start);
    assert.ok(end > start, `end of ${signature} not found`);
    // Signature already ends at the body's opening '{' — slice past its
    // whole length (a bare indexOf('{') would hit a parameter brace).
    return appSrc.slice(start + signature.length, end);
}

const planWordReplace = new Function(
    'return function (words, { search, replacement, caseSensitive = false } = {}) {' + extractFn(
        'function planWordReplace(words, { search, replacement, caseSensitive = false } = {}) {') + '};')();

const stubThis = (transcript, extra = {}) => {
    const app = {
        transcript,
        selectedWordIndex: -1,
        saves: 0,
        calls: [],
        statuses: [],
        saveState() { app.saves++; },
        // The REAL extracted hint body (it only needs Status).
        _findReplaceHint: new Function('Status',
            'return function (search) {' + extractBody('_findReplaceHint(search) {') + '};')(Status),
        rebuildLayout() { app.calls.push('rebuildLayout'); },
        renderTranscriptEditor() { app.calls.push('renderTranscriptEditor'); },
        renderTranscriptDisplay() { app.calls.push('renderTranscriptDisplay'); },
        updateInspector() { app.calls.push('updateInspector'); },
        updatePreview() { app.calls.push('updatePreview'); },
        selectWord(i, o = {}) { app.calls.push(['select', i, o.seek ?? true]); },
        timeline: null,
        ...extra,
    };
    return app;
};
const Status = { msgs: [], msg(m, t) { Status.msgs.push([m, t]); } };
const asMethod = (sig) => new Function('planWordReplace', 'Status',
    'return function ({ search, replacement, caseSensitive = false } = {}) {'
    + extractBody(sig) + '};')(planWordReplace, Status);

const findNextWord = asMethod('findNextWord({ search, replacement, caseSensitive = false } = {}) {');
const replaceWordOnce = asMethod('replaceWordOnce({ search, replacement, caseSensitive = false } = {}) {');
const replaceAllWords = asMethod('replaceAllWords({ search, replacement, caseSensitive = false } = {}) {');

const W = (text, extra = {}) => ({ text, start: 1, end: 2, deleted: false, ...extra });

// ── 1. behavioral: the pure planner ───────────────────────────────

test('plan: every differing occurrence, replacement word only', () => {
    const words = [W('kernelless'), W('the'), W('Kernelless'), W('kernellessly')];
    const plan = planWordReplace(words, { search: 'kernelless', replacement: 'Kubernetes' });
    assert.deepEqual(plan, [
        { index: 0, before: 'kernelless', after: 'Kubernetes' },
        { index: 2, before: 'Kernelless', after: 'Kubernetes' },
    ], 'case-insensitive whole-word match; substring words never match');
});

test('plan: surrounding punctuation is kept around the replacement', () => {
    const words = [W('"hello,"'), W('’twice’.')];
    const plan = planWordReplace(words, { search: 'hello', replacement: 'goodbye' });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].after, '"goodbye,"');
    const plan2 = planWordReplace(words, { search: 'twice', replacement: 'three' });
    assert.equal(plan2[0].after, '’three’.');
});

test('plan: caseSensitive distinguishes case both ways', () => {
    const words = [W('hello'), W('Hello')];
    assert.deepEqual(planWordReplace(words, { search: 'hello', replacement: 'x' }).map(p => p.index), [0, 1]);
    assert.deepEqual(
        planWordReplace(words, { search: 'hello', replacement: 'x', caseSensitive: true }).map(p => p.index),
        [0]);
    assert.deepEqual(
        planWordReplace(words, { search: 'Hello', replacement: 'x', caseSensitive: true }).map(p => p.index),
        [1]);
});

test('plan: skips deleted, all-punctuation words, and no-change matches', () => {
    const words = [W('hello', { deleted: true }), W('...'), W('hello')];
    assert.deepEqual(planWordReplace(words, { search: 'hello', replacement: 'hello' }), [],
        'a re-applied replacement plans nothing (no-op ⇒ no undo slot)');
    assert.deepEqual(planWordReplace(words, { search: 'hello', replacement: 'hi' }).map(p => p.index), [2],
        'deleted and punctuation-only words never match');
});

test('plan: blank or punctuation-only search matches nothing', () => {
    const words = [W('hello'), W('...')];
    for (const search of ['', '   ', '...', '?!']) {
        assert.deepEqual(planWordReplace(words, { search, replacement: 'x' }), []);
    }
    assert.deepEqual(planWordReplace(null, { search: 'hello', replacement: 'x' }), []);
});

test('plan: a punctuation-wrapped search still finds the bare token', () => {
    const plan = planWordReplace([W('hello')], { search: '"hello"', replacement: 'hi' });
    assert.deepEqual(plan.map(p => p.index), [0]);
});

// ── 2. behavioral: step-through replace (one at a time) ───────────

function transcriptWith(texts) {
    return { words: texts.map((t, i) => W(t, { start: i + 0.5, end: i + 1 })) };
}

test('replaceWordOnce: replaces next match after selection, one undo save, selects it', () => {
    Status.msgs.length = 0;
    const app = stubThis(transcriptWith(['a', 'kernelless', 'b', 'kernelless']));
    const ok = replaceWordOnce.call(app, { search: 'kernelless', replacement: 'Kubernetes' });
    assert.equal(ok, true);
    assert.equal(app.transcript.words[1].text, 'Kubernetes');
    assert.equal(app.transcript.words[3].text, 'kernelless', 'only the NEXT match is replaced');
    assert.equal(app.saves, 1);
    assert.deepEqual(app.calls.filter((c) => Array.isArray(c)), [['select', 1, true]]);
    assert.equal(Status.msgs.length, 1);
    assert.equal(Status.msgs[0][1], 'success');
    assert.match(Status.msgs[0][0], /match 1 of 2/);
});

test('replaceWordOnce: advances past the selection and wraps at the end', () => {
    const app = stubThis(transcriptWith(['kernelless', 'x', 'kernelless']));
    app.selectedWordIndex = 1;
    assert.equal(replaceWordOnce.call(app, { search: 'kernelless', replacement: 'K' }), true);
    assert.equal(app.transcript.words[2].text, 'K');
    assert.equal(replaceWordOnce.call(app, { search: 'kernelless', replacement: 'K' }), true,
        'wraps around to the first remaining match');
    assert.equal(app.transcript.words[0].text, 'K');
    assert.equal(app.saves, 2);
});

test('replaceWordOnce: no match ⇒ hint, zero writes, no undo save', () => {
    Status.msgs.length = 0;
    const app = stubThis(transcriptWith(['a', 'b']));
    assert.equal(replaceWordOnce.call(app, { search: 'nope', replacement: 'x' }), false);
    assert.equal(app.saves, 0);
    assert.deepEqual(app.calls, []);
    assert.equal(Status.msgs[0][1], 'warning');
    assert.match(Status.msgs[0][0], /Nothing left to replace for "nope"/);
    Status.msgs.length = 0;
    assert.equal(replaceWordOnce.call(app, { search: '  ', replacement: 'x' }), false);
    assert.match(Status.msgs[0][0], /Type a word to find first/, 'empty search must not be a silent no-op');
});

test('replaceWordOnce: no transcript ⇒ immediate false', () => {
    const app = stubThis(null);
    assert.equal(replaceWordOnce.call(app, { search: 'a', replacement: 'b' }), false);
    assert.equal(app.saves, 0);
});

// ── 3. behavioral: replace all (one undo step) ────────────────────

test('replaceAllWords: every match, exactly ONE saveState before any write', () => {
    Status.msgs.length = 0;
    const app = stubThis(transcriptWith(['kernelless', 'ok', '"kernelless,"']));
    const order = [];
    app.saveState = () => { app.saves++; order.push('save'); };
    const w0 = app.transcript.words[0];
    let v0 = w0.text;
    Object.defineProperty(w0, 'text', {
        configurable: true,
        set(v) { order.push('write'); v0 = v; }, get() { return v0; },
    });
    const ok = replaceAllWords.call(app, { search: 'kernelless', replacement: 'Kubernetes' });
    assert.equal(ok, true);
    assert.equal(app.saves, 1);
    assert.equal(app.transcript.words[0].text, 'Kubernetes');
    assert.equal(app.transcript.words[2].text, '"Kubernetes,"');
    assert.equal(app.transcript.words[1].text, 'ok');
    assert.deepEqual(order, ['save', 'write'], 'undo snapshot precedes the first write');
    assert.match(Status.msgs[0][0], /Replaced 2 × "kernelless" → "Kubernetes"/);
});

test('replaceAllWords: re-applying the same replacement burns no undo slot', () => {
    const app = stubThis(transcriptWith(['Kubernetes', 'ok']));
    assert.equal(replaceAllWords.call(app, { search: 'kernelless', replacement: 'Kubernetes' }), false);
    assert.equal(app.saves, 0);
});

// ── 4. behavioral: find next ──────────────────────────────────────

test('findNextWord: selects (and seeks) the next match, wraps; writes nothing', () => {
    const app = stubThis(transcriptWith(['a', 'nope', 'nope']));
    app.selectedWordIndex = 1;
    assert.equal(findNextWord.call(app, { search: 'nope', replacement: 'x' }), true);
    assert.deepEqual(app.calls, [['select', 2, true]]);
    app.selectedWordIndex = 2;
    assert.equal(findNextWord.call(app, { search: 'nope', replacement: 'x' }), true);
    assert.deepEqual(app.calls[1], ['select', 1, true], 'wraps to the first match');
    assert.equal(app.saves, 0);
    assert.equal(app.transcript.words[1].text, 'nope', 'find never mutates');
});

test('findNextWord: no match ⇒ warning hint, no selection', () => {
    const app = stubThis(transcriptWith(['a']));
    assert.equal(findNextWord.call(app, { search: 'zzz', replacement: 'x' }), false);
    assert.deepEqual(app.calls, []);
    assert.equal(Status.msgs.at(-1)[1], 'warning');
});

// ── 5. source-level guards ────────────────────────────────────────

test('guard: find bar markup exists with all ids on guarded lines', () => {
    for (const id of ['find-input', 'replace-input', 'find-case-sensitive',
        'btn-find-next', 'btn-replace-once', 'btn-replace-all', 'find-count']) {
        assert.match(htmlSrc, new RegExp(`id="${id}"`), `index.html needs #${id}`);
    }
    assert.match(htmlSrc, /id="find-input" class="find-input"/);
    assert.match(htmlSrc, /class="find-bar" id="find-bar"/);
});

test('guard: init binds the find bar; render highlights matches; CSS marks them', () => {
    assert.match(appSrc, /this\.bindFindReplaceControls\(\);/);
    const render = appSrc.slice(appSrc.indexOf('renderTranscriptEditor() {'),
        appSrc.indexOf('\n    },', appSrc.indexOf('renderTranscriptEditor() {')));
    assert.match(render, /findSet\.has\(i\)/);
    assert.match(render, /\+ \(findSet && findSet\.has\(i\) \? ' find-match' : ''\);/);
    assert.match(cssSrc, /\.word-chip\.find-match\s*{\s*box-shadow: inset 0 -3px/);
    assert.match(cssSrc, /\.find-bar\s*{/);
});

test('guard: Ctrl+F / Ctrl+H focus the find bar before the bare-key branch', () => {
    const kbd = appSrc.slice(appSrc.indexOf('bindKeyboardShortcuts() {'));
    const fChord = kbd.match(/else if \(e\.ctrlKey && key === 'f'\)[\s\S]*?\} else if/);
    const hChord = kbd.match(/else if \(e\.ctrlKey && key === 'h'\)[\s\S]*?\} else if/);
    assert.ok(fChord && hChord, 'Ctrl+F and Ctrl+H chords must exist');
    assert.match(fChord[0], /getElementById\('find-input'\)/);
    assert.match(hChord[0], /getElementById\('replace-input'\)/);
    assert.ok(kbd.indexOf("key === 'f'") < kbd.indexOf("'F2'"),
        'chords are checked before the bare-key branch');
});

test('guard: clearCaptions and transcribe reset the find state', () => {
    const clear = appSrc.slice(appSrc.indexOf('clearCaptions() {'),
        appSrc.indexOf('\n    },', appSrc.indexOf('clearCaptions() {')));
    assert.match(clear, /this\.findMatches = \[\];/);
    assert.match(clear, /this\._refreshFindCount\?\.\(\);/);
    const tStart = appSrc.indexOf('this.transcript = transcript;');
    assert.match(appSrc.slice(tStart, tStart + 400), /this\.findMatches = \[\];/);
});

test('guard: click-away deselect exempts the whole Word Editor panel (find bar included)', () => {
    // Press-based (pointerdown), because a click after a drag reports the
    // COMMON ANCESTOR of press/release — that deselected the word the user was
    // text-selecting in the inspector. The panel-wide exemption covers the
    // find bar, the chip list and the inspector bar plus their padding.
    const at = appSrc.indexOf("document.addEventListener('pointerdown'");
    assert.ok(at >= 0, 'press-based click-away deselect handler not found');
    const handler = appSrc.slice(at, appSrc.indexOf('\n        });', at));
    assert.match(handler, /document\.querySelector\('\.panel-word-editor'\)/);
    assert.match(handler, /if \(wordPanel && wordPanel\.contains\(e\.target\)\) return;/);
    assert.match(handler, /this\.selectWord\(-1\);/);
    assert.ok(!handler.includes("getElementById('find-bar')"),
        'the panel-wide exemption replaces the per-element list');
});

test('guard: replace funnels commit through exactly one saveState each', () => {
    for (const sig of ['replaceWordOnce({ search, replacement, caseSensitive = false } = {}) {',
        'replaceAllWords({ search, replacement, caseSensitive = false } = {}) {']) {
        const body = extractBody(sig);
        assert.equal((body.match(/this\.saveState\(\);/g) || []).length, 1,
            `${sig.split('(')[0]}: exactly one undo save`);
        assert.match(body, /planWordReplace\(this\.transcript\.words/,
            'both funnels plan through the single pure planner');
    }
});
