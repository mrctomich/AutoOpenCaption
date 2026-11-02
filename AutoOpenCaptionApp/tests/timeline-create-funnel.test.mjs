/**
 * Phase 5b — App.addCaptionAt funnel contract.
 *
 * planNewCaption (5a) is pure; App.addCaptionAt commits the plan behind
 * exactly one saveState(). Like the 4d funnel guards, App needs the DOM, so
 * the commit contract is pinned (1) at source level against app.js and
 * (2) functionally by mirroring the funnel's splice against the real
 * planNewCaption + groupWords, including an undo-snapshot round-trip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planNewCaption } from '../app/assets/timeline-model.js';
import { groupWords } from '../app/assets/caption-renderer.js';

const W = (id, start, end, extra = {}) => ({
    id, text: id, start, end, deleted: false,
    origStart: start, origEnd: end,
    originalStart: start, originalEnd: end,
    ...extra,
});

const GROUPING = { maxWords: 8, maxSeconds: 4, maxCharacters: 42 };

// ── functional mirror of the funnel ──────────────────────────────

// Mirrors App.addCaptionAt's commit path exactly: plan → saveState
// (JSON snapshot) → splice at plan.index.
function commitLikeFunnel(transcript, args) {
    const plan = planNewCaption({
        words: transcript.words,
        durationSec: transcript.durationSec,
        ...args,
    });
    if (!plan.ok) return { plan, snapshot: null };
    const snapshot = JSON.parse(JSON.stringify(transcript));
    transcript.words.splice(plan.index, 0, plan.word);
    return { plan, snapshot };
}

test('funnel mirror: create lands sorted, unique id, appears in groupWords', () => {
    const t = {
        durationSec: 20,
        words: [W('w0001', 1, 2), W('w0002', 3, 4), W('w0003', 8, 9)],
    };
    const { plan, snapshot } = commitLikeFunnel(t, { startSec: 5, text: 'gap fill' });
    assert.equal(plan.ok, true);
    assert.equal(t.words.length, 4);
    // Sorted by start; inserted between the 4 s and 8 s words.
    assert.deepEqual(t.words.map((w) => w.start), [1, 3, 5, 8]);
    assert.equal(t.words[2].text, 'gap fill');
    assert.equal(t.words[2].id, 'w0004'); // unique max+1
    // Unique ids overall.
    const ids = new Set(t.words.map((w) => w.id));
    assert.equal(ids.size, t.words.length);
    // Derived cue list reflects the new caption.
    const groups = groupWords(t.words, GROUPING);
    assert.ok(groups.some((g) => g.words.some((w) => w.id === 'w0004')));
    assert.ok(snapshot, 'commit must snapshot for undo');
});

test('funnel mirror: undo snapshot round-trips a create byte-identically', () => {
    const t = { durationSec: 20, words: [W('w0001', 1, 2), W('w0002', 3, 4)] };
    const before = JSON.stringify(t);
    const { snapshot } = commitLikeFunnel(t, { startSec: 10, text: 'x' });
    const afterCreate = JSON.stringify(t);
    assert.notEqual(afterCreate, before);             // create landed
    // undo(): redoStack.push(copy(transcript)); transcript = undoStack.pop()
    const redoStack = [JSON.parse(afterCreate)];
    let transcript = JSON.parse(JSON.stringify(snapshot));
    assert.equal(JSON.stringify(transcript), before); // byte-identical undo
    // redo(): undoStack.push(copy(transcript)); transcript = redoStack.pop()
    transcript = redoStack.pop();
    assert.equal(JSON.stringify(transcript), afterCreate); // create re-applied
});

test('funnel mirror: rejected plan leaves the transcript untouched (no-room)', () => {
    const t = { durationSec: 20, words: [W('w0001', 1, 2), W('w0002', 3, 4)] };
    const before = JSON.stringify(t);
    // Span fully inside w0001: planNewCaption rejects — no shrink possible.
    const { plan, snapshot } = commitLikeFunnel(t, { startSec: 1.2, endSec: 1.5 });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'no-room');
    assert.equal(snapshot, null);                 // rejection: no save, no write
    assert.equal(JSON.stringify(t), before);
});

test('funnel mirror: span clipped into a gap commits shrunk, neighbours unmoved', () => {
    const t = { durationSec: 20, words: [W('w0001', 1, 2), W('w0002', 3, 4)] };
    const { plan, snapshot } = commitLikeFunnel(t, { startSec: 1.2 });
    // Default end 2.2: w0001's end lands inside → start pushed to 2; end stays
    // 2.2 (w0002 starts at 3, outside). Contract from planNewCaption, not raw px.
    assert.equal(plan.ok, true);
    assert.equal(plan.shrunk, true);
    assert.deepEqual([plan.word.start, plan.word.end], [2, 2.2]);
    assert.ok(snapshot);
    assert.deepEqual(t.words.map((w) => [w.start, w.end]), [[1, 2], [2, 2.2], [3, 4]]);
});

test('funnel mirror: hard rejection (bad-start) writes nothing', () => {
    const t = { durationSec: 20, words: [W('w0001', 1, 2)] };
    const before = JSON.stringify(t);
    const { plan, snapshot } = commitLikeFunnel(t, { startSec: NaN });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'bad-start');
    assert.equal(snapshot, null);
    assert.equal(JSON.stringify(t), before);
});

test('funnel mirror: create inside a tiny gap rejected; neighbours keep places', () => {
    // Gap of 0.05 s between live words — below MIN_CAPTION_SEC.
    const t = { durationSec: 20, words: [W('w0001', 1, 2), W('w0002', 2.05, 3)] };
    const before = JSON.stringify(t);
    const { plan, snapshot } = commitLikeFunnel(t, { startSec: 2.01, endSec: 2.04 });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'no-room');
    assert.equal(snapshot, null);
    assert.equal(JSON.stringify(t), before);
});

test('funnel mirror: new word survives JSON (no functions/class instances)', () => {
    const t = { durationSec: 20, words: [] };
    const { plan } = commitLikeFunnel(t, { startSec: 2, text: 'json ok' });
    const round = JSON.parse(JSON.stringify(plan.word));
    assert.deepEqual(round, plan.word);
});

// ── source-level guards on app.js (the real funnel) ──────────────

const appSrc = readFileSync(
    fileURLToPath(new URL('../app/assets/app.js', import.meta.url)), 'utf8',
);
const fnStart = appSrc.indexOf('addCaptionAt({ startSec');
const fnSrc = fnStart >= 0
    ? appSrc.slice(fnStart, appSrc.indexOf('\n    },', fnStart))
    : '';

test('app.js imports planNewCaption and defines addCaptionAt', () => {
    assert.match(appSrc, /import\s*\{[^}]*planNewCaption[^}]*\}\s*from\s*'\.\/timeline-model\.js'/);
    assert.ok(fnSrc.length > 0, 'App.addCaptionAt not found in app.js');
});

test('addCaptionAt: rejects without transcript and without any undo save', () => {
    assert.match(fnSrc, /if\s*\(!this\.transcript\)\s*return false;/);
    // The plan rejection branch returns false BEFORE the save happens.
    assert.match(fnSrc, /if\s*\(!plan\.ok\)\s*\{[\s\S]*?return false;\s*\}[\s\S]*?this\.saveState\(\)/);
});

test('addCaptionAt: exactly one saveState, gated on a valid plan', () => {
    const saves = fnSrc.match(/this\.saveState\(\)/g) || [];
    assert.equal(saves.length, 1);
});

test('addCaptionAt: splices the planned word at the planned index', () => {
    assert.match(fnSrc, /this\.transcript\.words\.splice\(plan\.index,\s*0,\s*plan\.word\)/);
});

test('addCaptionAt: selects the new word without seeking and refreshes downstream', () => {
    assert.match(fnSrc, /this\.selectWord\(plan\.index,\s*\{ seek: false \}\)/);
    for (const call of ['rebuildLayout()', 'renderTranscriptDisplay()',
        'updatePreview()', 'timeline?.invalidate()']) {
        assert.ok(fnSrc.includes(call), `addCaptionAt must call ${call}`);
    }
    // selectWord must run AFTER the splice (it renders by index).
    assert.ok(
        fnSrc.indexOf('splice(plan.index') < fnSrc.indexOf('selectWord(plan.index'),
        'selectWord must run after the splice',
    );
});

test('addCaptionAt: no-room rejection surfaces a status note', () => {
    assert.match(fnSrc, /plan\.reason === 'no-room'/);
    assert.match(fnSrc, /Status\.msg\(/);
});

// ── 5c/5d entry points (toolbar button + empty-lane double-click) ─

const viewSrc = readFileSync(
    fileURLToPath(new URL('../app/assets/timeline-view.js', import.meta.url)), 'utf8',
);
const htmlSrc = readFileSync(
    fileURLToPath(new URL('../app/index.html', import.meta.url)), 'utf8',
);

test('5c: toolbar button exists and the view reports, never mutates', () => {
    assert.match(htmlSrc, /id="btn-tl-add-caption"[^>]*disabled/,
        'button must start disabled (enabled by rebuildLayout with a transcript)');
    assert.match(appSrc, /addBtn\.disabled = !this\.transcript;/,
        'rebuildLayout must gate the button on transcript presence');
    assert.match(viewSrc, /onAddCaption\s*=\s*\(\)\s*=>\s*\{\}/,
        'constructor must default onAddCaption to a noop');
    assert.match(viewSrc,
        /q\('btn-tl-add-caption'\)\?\.addEventListener\('click', \(\) => this\.onAddCaption\(\{ startSec: null \}\)\)/,
        'toolbar click must report startSec: null (App resolves the playhead)');
    // View stays report-only: no mutation primitives in the toolbar bind.
    const bind = viewSrc.slice(viewSrc.indexOf('_bindToolbar()'),
        viewSrc.indexOf('_bindResizer()'));
    assert.ok(!/saveState|splice|addCaptionAt|transcript/.test(bind),
        'view must not mutate transcript data');
});

test('5d: empty-lane double-click reports startSec; box dbl-click still selects', () => {
    const dbl = viewSrc.slice(viewSrc.indexOf("addEventListener('dblclick'"),
        viewSrc.indexOf('// Keyboard parity'));
    assert.match(dbl, /this\.onSelectGroup\(\{[\s\S]*?seek: true/,
        'dbl-click on a box must keep seeking-selection');
    assert.match(dbl, /const t = xToTime\(this\.viewport, x\);/,
        'empty spot must resolve the clicked time via xToTime');
    assert.match(dbl, /Number\.isFinite\(t\) && t >= 0\) this\.onAddCaption\(\{ startSec: t \}\)/);
    // Report-only again: the dblclick handler must not touch data.
    assert.ok(!/saveState|splice|transcript/.test(dbl),
        'dblclick handler must not mutate transcript data');
    // The add branch is the hit-test ELSE: it only fires when i == null.
    const ifPos = dbl.indexOf('if (i != null');
    const elsePos = dbl.indexOf('onAddCaption');
    assert.ok(ifPos >= 0 && elsePos > ifPos, 'add path must be the no-hit else branch');
});

test('5c: App routes onAddCaption through addCaptionAt with playhead fallback', () => {
    assert.match(appSrc,
        /onAddCaption: \(\{ startSec \} = \{\}\) => this\.addCaptionAt\(\{/,
        'App must wire the view callback into the single create funnel');
    assert.match(appSrc, /this\.video\.currentTime/,
        'fallback must use the playhead');
});
