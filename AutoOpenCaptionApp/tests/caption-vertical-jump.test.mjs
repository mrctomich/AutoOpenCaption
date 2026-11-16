/**
 * Vertical caption jumps (word-anchored position overrides).
 *
 * Three layers, same discipline as the other App-side suites:
 *  1. pure renderer resolution — resolveGroupYpx / baseYpx imported REAL
 *     from caption-renderer.js (no DOM needed);
 *  2. behavioral tests on setCaptionJump / nudgeCaptionJump /
 *     clearCaptionJumpAtSelection / effectiveCaptionYpx, extracted from
 *     the real app.js source and invoked with a stub `this`;
 *  3. source-level guards on the inspector wiring, chip marker, key map
 *     and export path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveGroupYpx, baseYpx } from '../app/assets/caption-renderer.js';

// ── 1. pure resolution (real renderer functions) ──────────────────

const style = { position: { placement: 'lower-third', yPx: 780 } };
const W = (id, start, extra = {}) => ({ id, text: 'w' + id, start, end: start + 0.5, ...extra });

test('baseYpx: yPx wins, legacy placement/offsetPx migrates, value clamps', () => {
    assert.equal(baseYpx({ position: { yPx: 300 } }), 300);
    assert.equal(baseYpx({ position: { placement: 'bottom', offsetPx: 220 } }), 860);
    assert.equal(baseYpx({ position: { placement: 'top', offsetPx: 100 } }), 100);
    assert.equal(baseYpx({ position: { placement: 'custom' } }), 540);
    assert.equal(baseYpx({ position: { yPx: 5000 } }), 1080);
    assert.equal(baseYpx({}), 540);
});

test('no anchors → every group sits on the global baseline', () => {
    const groups = [
        { words: [W(1, 0)], start: 0, end: 1 },
        { words: [W(2, 2)], start: 2, end: 3 },
    ];
    assert.deepEqual(resolveGroupYpx(groups, style), [780, 780]);
});

test('anchor moves its own group AND carries to later groups', () => {
    const groups = [
        { words: [W(1, 0)], start: 0, end: 1 },
        { words: [W(2, 2, { captionY: 300 })], start: 2, end: 3 },
        { words: [W(3, 4)], start: 4, end: 5 },
    ];
    assert.deepEqual(resolveGroupYpx(groups, style), [780, 300, 300]);
});

test('anchor mid-group moves the whole group (cue granularity)', () => {
    const groups = [
        { words: [W(1, 0), W(2, 0.5, { captionY: 200 }), W(3, 1)], start: 0, end: 1.5 },
        { words: [W(4, 2)], start: 2, end: 2.5 },
    ];
    assert.deepEqual(resolveGroupYpx(groups, style), [200, 200]);
});

test('a second anchor replaces the first; the first never snaps back', () => {
    const groups = [
        { words: [W(1, 0)], start: 0, end: 1 },
        { words: [W(2, 1, { captionY: 100 })], start: 1, end: 2 },
        { words: [W(3, 2, { captionY: 950 })], start: 2, end: 3 },
        { words: [W(4, 3)], start: 3, end: 4 },
    ];
    assert.deepEqual(resolveGroupYpx(groups, style), [780, 100, 950, 950]);
});

test('anchor values clamp into the 0..1080 reference frame', () => {
    const groups = [
        { words: [W(1, 0, { captionY: 5000 })], start: 0, end: 1 },
        { words: [W(2, 1, { captionY: -20 })], start: 1, end: 2 },
    ];
    assert.deepEqual(resolveGroupYpx(groups, style), [1080, 0]);
});

// ── extract the real App methods from app.js ───────────────────────

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

function buildMethod(signature, injections = {}) {
    const src = extractFn(signature);
    const body = src.slice(src.indexOf(signature) + signature.length, src.lastIndexOf('}'));
    const names = Object.keys(injections);
    return new Function(...names, 'return function (' + signature.slice(signature.indexOf('(') + 1, signature.lastIndexOf(')')) + ') {'
        + body + '}')(...Object.values(injections));
}

const statusMsgs = [];
const StatusStub = { msg: (m) => statusMsgs.push(m) };

// baseYpx is a module-level import in app.js — inject the REAL one so the
// extracted effectiveCaptionYpx resolves the same as the app does.
const realBaseYpx = baseYpx;
const setCaptionJump = buildMethod('setCaptionJump(index, yPxOrNull) {', { Status: StatusStub });
const effectiveCaptionYpx = buildMethod('effectiveCaptionYpx(index) {', { baseYpx: realBaseYpx });
const nudgeCaptionJump = buildMethod('nudgeCaptionJump(delta) {', { Status: StatusStub });
const clearCaptionJumpAtSelection = buildMethod('clearCaptionJumpAtSelection() {', { Status: StatusStub });

// ── 2. behavioral: setCaptionJump against a stub `this` ───────────

function stubApp({ words = [W(1, 0)], selected = 0, hasTranscript = true } = {}) {
    const calls = [];
    const app = {
        transcript: hasTranscript ? { words } : null,
        selectedWordIndex: selected,
        style: { position: { placement: 'lower-third', yPx: 780 } },
        saveState: () => calls.push('saveState'),
        rebuildLayout: () => calls.push('rebuildLayout'),
        renderTranscriptEditor: () => calls.push('renderTranscriptEditor'),
        updateInspector: () => calls.push('updateInspector'),
        updatePreview: () => calls.push('updatePreview'),
    };
    // chain the real extracted helpers the way the live App object wires them
    app.setCaptionJump = (i, y) => setCaptionJump.call(app, i, y);
    app.effectiveCaptionYpx = (i) => effectiveCaptionYpx.call(app, i);
    return { app, calls, words };
}

test('setCaptionJump: sets captionY, saves undo exactly once, refreshes downstream', () => {
    const { app, calls, words } = stubApp();
    const ok = app.setCaptionJump(0, 300);
    assert.equal(ok, true);
    assert.equal(words[0].captionY, 300);
    assert.equal(calls.filter(c => c === 'saveState').length, 1);
    for (const c of ['rebuildLayout', 'renderTranscriptEditor',
        'updateInspector', 'updatePreview']) {
        assert.ok(calls.includes(c), `must call ${c}`);
    }
});

test('setCaptionJump: string input from the number field is coerced; out-of-range clamps', () => {
    const { app, words } = stubApp();
    app.setCaptionJump(0, '540');
    assert.equal(words[0].captionY, 540);
    app.setCaptionJump(0, '2000');
    assert.equal(words[0].captionY, 1080);
    app.setCaptionJump(0, -40);
    assert.equal(words[0].captionY, 0);
});

test('setCaptionJump: non-numeric input hints via Status and mutates nothing', () => {
    const { app, calls, words } = stubApp();
    const before = statusMsgs.length;
    const ok = app.setCaptionJump(0, 'abc');
    assert.equal(ok, false);
    assert.equal(words[0].captionY, undefined);
    assert.equal(calls.length, 0);
    assert.ok(statusMsgs.length > before, 'must hint the user');
});

test('setCaptionJump: no-op (same value) never burns an undo slot', () => {
    const { app, calls, words } = stubApp();
    app.setCaptionJump(0, 300);
    const callsAfterFirst = calls.length;
    const ok = app.setCaptionJump(0, 300);
    assert.equal(ok, false);
    assert.equal(calls.filter(c => c === 'saveState').length, 1, 'still exactly one saveState');
    assert.equal(calls.length, callsAfterFirst, 'no-op must not refresh');
    assert.equal(words[0].captionY, 300);
});

test('setCaptionJump(null) clears the anchor outright (no null residue)', () => {
    const { app, words } = stubApp();
    app.setCaptionJump(0, 300);
    app.setCaptionJump(0, null);
    assert.equal('captionY' in words[0], false, 'property must be deleted, not nulled');
    assert.equal(app.setCaptionJump(0, null), false, 'clearing an un-anchored word is a no-op');
});

test('setCaptionJump guards: no transcript / bad index', () => {
    const a = stubApp({ hasTranscript: false });
    assert.equal(a.app.setCaptionJump(0, 300), false);
    assert.equal(a.calls.length, 0);
    const b = stubApp();
    assert.equal(b.app.setCaptionJump(-1, 300), false);
    assert.equal(b.app.setCaptionJump(99, 300), false);
    assert.equal(b.calls.length, 0);
});

test('effectiveCaptionYpx: walks back through live anchors, skips deleted, falls to global', () => {
    const words = [
        W(1, 0, { captionY: 300 }),
        W(2, 1, { deleted: true, captionY: 50 }), // deleted anchor must NOT apply
        W(3, 2),
    ];
    const { app } = stubApp({ words });
    assert.equal(app.effectiveCaptionYpx(0), 300);
    assert.equal(app.effectiveCaptionYpx(1), 300, 'deleted word\'s own anchor is skipped');
    assert.equal(app.effectiveCaptionYpx(2), 300, 'inherits the last live anchor');
    const { app: fresh } = stubApp({ words: [W(1, 0)] });
    assert.equal(fresh.effectiveCaptionYpx(0), 780, 'falls back to global position');
});

test('nudge: first press creates the anchor from the effective position', () => {
    const words = [W(1, 0), W(2, 1)];
    const { app } = stubApp({ words, selected: 1 });
    nudgeCaptionJump.call(app, -60);
    assert.equal(words[1].captionY, 720, '780 inherited, nudged up 60');
});

test('nudge: subsequent presses move the anchor; edge hint instead of silent no-op', () => {
    const words = [W(1, 0)];
    const { app } = stubApp({ words });
    app.setCaptionJump(0, 20);
    nudgeCaptionJump.call(app, -60);
    assert.equal(words[0].captionY, 0, 'clamps at the top edge');
    const before = statusMsgs.length;
    nudgeCaptionJump.call(app, -60);
    assert.equal(words[0].captionY, 0);
    assert.ok(statusMsgs.length > before, 'edge no-op must still speak up');
});

test('nudge: no selection → Status hint, never mutates or saves', () => {
    const { app, calls } = stubApp({ selected: -1 });
    const before = statusMsgs.length;
    nudgeCaptionJump.call(app, 60);
    assert.equal(calls.length, 0);
    assert.ok(statusMsgs.length > before);
    assert.match(statusMsgs.at(-1), /select a word/i);
});

test('clear at selection: clears an anchored word; hints when nothing to clear', () => {
    const words = [W(1, 0)];
    const { app } = stubApp({ words });
    app.setCaptionJump(0, 400);
    clearCaptionJumpAtSelection.call(app);
    assert.equal('captionY' in words[0], false);

    const before = statusMsgs.length;
    clearCaptionJumpAtSelection.call(app);
    assert.ok(statusMsgs.length > before);
    assert.match(statusMsgs.at(-1), /no vertical jump/i);
});

test('deleteWord hands the deleted word\'s anchor to the next live word', () => {
    const deleteWord = buildMethod('deleteWord(index) {', {});
    const words = [W(1, 0, { captionY: 350 }), W(2, 1, { deleted: true }), W(3, 2)];
    const { app } = stubApp({ words });
    deleteWord.call(app, 0);
    assert.equal(words[0].deleted, true);
    assert.equal(words[2].captionY, 350, 'anchor skipped the already-deleted word');
});

// ── 3. source guards: renderer, inspector, chip, key map, export ──

const rendererSrc = readFileSync(
    fileURLToPath(new URL('../app/assets/caption-renderer.js', import.meta.url)), 'utf8',
).replace(/\r\n/g, '\n');

test('guard: computeLayout resolves per-group y (preview and export share it)', () => {
    assert.match(rendererSrc, /const groupYpx = resolveGroupYpx\(groups, style\);/);
    assert.match(rendererSrc, /const y = canvasHeight \* \(groupYpx\[groupIndex\] \/ 1080\);/);
    // Export reuses these same layouts — nothing in the export path may
    // re-derive a single global y.
    assert.ok(!rendererSrc.match(/canvasHeight \* \(yPx \/ 1080\)/),
        'stale single-baseline y computation must be gone');
});

test('guard: index.html carries the jump row controls on single lines', () => {
    const html = readFileSync(
        fileURLToPath(new URL('../app/index.html', import.meta.url)), 'utf8',
    );
    assert.match(html, /id="inspector-jump-y" class="inspector-time-input" step="10" min="0" max="1080"/);
    assert.match(html, /id="inspector-jump-set"/);
    assert.match(html, /id="inspector-jump-clear"/);
    assert.match(html, /id="inspector-jump-hint"/);
});

test('guard: inspector wiring routes into the single funnel', () => {
    const start = appSrc.indexOf('bindInspectorControls() {');
    const end = appSrc.indexOf('\n    },', start);
    const slice = appSrc.slice(start, end);
    assert.ok(slice.includes("getElementById('inspector-jump-set').addEventListener('click', commitJumpFromInput);"));
    assert.ok(slice.includes('const commitJumpFromInput = () => {\n            if (this.selectedWordIndex < 0 || !this.transcript) return;'));
    assert.ok(slice.includes('this.setCaptionJump(this.selectedWordIndex, raw);'));
    assert.ok(slice.includes('this.setCaptionJump(this.selectedWordIndex, null);'));
    // report-only invariant: the view layer must not mutate or save.
    const jumpWiring = slice.slice(slice.indexOf('const jumpInput'));
    for (const bad of ['saveState(', 'splice(', 'transcript.words[']) {
        assert.ok(!jumpWiring.includes(bad), `inspector jump wiring must not ${bad}`);
    }
});

test('guard: updateInspector reflects jump state (pinned value / inherited placeholder / disabled clear)', () => {
    const start = appSrc.indexOf('updateInspector() {');
    const end = appSrc.indexOf('\n    },', start);
    const slice = appSrc.slice(start, end);
    assert.ok(slice.includes("getElementById('inspector-jump-y')"));
    assert.ok(slice.includes('const inheritedY = Math.round(this.effectiveCaptionYpx(this.selectedWordIndex));'));
    assert.ok(slice.includes('jumpClear.disabled = word.captionY == null;'));
});

test('guard: word chips mark jump anchors (class gated on live word + captionY != null)', () => {
    assert.match(appSrc, /\+ \(!word\.deleted && word\.captionY != null \? ' has-jump' : ''\)/);
    assert.match(rendererSrc, /if \(w\.captionY != null\) \{/);
});

test('guard: [ / ] and backslash are bare-key shortcuts with preventDefault before acting', () => {
    const start = appSrc.indexOf('bindKeyboardShortcuts() {');
    const end = appSrc.indexOf('\n        });\n    },', start);
    const kbdSrc = appSrc.slice(start, end);
    for (const [key, sig] of [["'['", 'this.nudgeCaptionJump(-60);'],
        ["']'", 'this.nudgeCaptionJump(60);'],
        ["'\\\\'", 'this.clearCaptionJumpAtSelection();']]) {
        assert.match(kbdSrc, new RegExp(
            `key === ${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\) \\{\\s*e\\.preventDefault\\(\\);\\s*${sig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
    // Map comment documents the new keys.
    assert.match(appSrc, /\[ \/ \] move caption up\/down at selected word/);
});

test('guard: deleteWord anchor-handoff happens before deleted = true', () => {
    const start = appSrc.indexOf('deleteWord(index) {');
    const end = appSrc.indexOf('\n    },', start);
    const slice = appSrc.slice(start, end);
    const handoff = slice.indexOf('next.captionY = word.captionY;');
    const mark = slice.indexOf('word.deleted = true;');
    assert.ok(handoff > 0 && mark > handoff,
        'anchor must move to the next live word before the word is marked deleted');
});
