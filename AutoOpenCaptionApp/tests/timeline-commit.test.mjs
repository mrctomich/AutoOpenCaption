// Phase 4d (mutation funnel) — commitProposal validation tests + funnel
// contract guards. commitProposal is the PURE half of the App commit funnel:
// the view releases a clamped proposal Map (word index → { start, end }),
// commitProposal turns it into validated { index, start, end } mutations,
// and App.applyTimelineEdit writes them to transcript.words behind exactly
// one saveState(). App.applyTimelineEdit itself needs the DOM, so its
// contract (single save, side-field protection, wiring) is guarded here by
// applying mutations the same way the funnel does plus a source-level check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { commitProposal } from '../app/assets/timeline-model.js';

// Word factory with the full side-field surface the funnel must never touch.
const w = (id, start, end, extra = {}) => ({
    id, text: `w${id}`, start, end, deleted: false,
    origStart: start, origEnd: end,
    originalStart: start, originalEnd: end,
    estimated: true, estimatedStart: start, estimatedEnd: end,
    ...extra,
});

const map = (entries) => new Map(entries);

// Mirrors App.applyTimelineEdit's write loop exactly.
function applyLikeFunnel(words, mutations) {
    for (const m of mutations) {
        const word = words[m.index];
        word.start = m.start;
        word.end = m.end;
        word.userAdjusted = true;
    }
}

// ── commit semantics ──────────────────────────────────────────────

test('commitProposal: happy path yields one mutation per proposed word', () => {
    const words = [w(1, 0, 1), w(2, 2, 3), w(3, 5, 6)];
    const out = commitProposal(words, map([
        [1, { start: 1.5, end: 2.5 }],
        [2, { start: 4, end: 5 }],
    ]));
    assert.deepEqual(out, [
        { index: 1, start: 1.5, end: 2.5 },
        { index: 2, start: 4, end: 5 },
    ]);
});

test('commitProposal: PURE — the words array is untouched', () => {
    const words = [w(1, 0, 1), w(2, 2, 3)];
    const before = structuredClone(words);
    commitProposal(words, map([[1, { start: 1.2, end: 2.2 }]]));
    assert.deepEqual(words, before);
});

test('commitProposal: applied mutations carry only start/end; side fields survive (R2)', () => {
    const words = [w(1, 0, 1), w(2, 2, 3, { deleted: true }), w(3, 5, 6, { unplaced: true })];
    const before = words.map((x) => ({ ...x }));
    const mutations = commitProposal(words, map([
        [0, { start: 0.5, end: 1.5 }],
        [2, { start: 4.5, end: 5.5 }],
    ]));
    applyLikeFunnel(words, mutations);
    for (const [i, word] of words.entries()) {
        const orig = before[i];
        // Only start/end/userAdjusted may differ.
        for (const key of Object.keys(orig)) {
            if (key === 'start' || key === 'end' || key === 'userAdjusted') continue;
            assert.equal(word[key], orig[key], `word ${i} field '${key}' must not change`);
        }
        // Nothing new beyond userAdjusted appears.
        for (const key of Object.keys(word)) {
            assert.ok(
                key in orig || key === 'userAdjusted',
                `word ${i} gained unexpected field '${key}'`,
            );
        }
    }
    // The committed moves actually landed.
    assert.deepEqual([words[0].start, words[0].end], [0.5, 1.5]);
    assert.deepEqual([words[2].start, words[2].end], [4.5, 5.5]);
});

test('funnel sets userAdjusted on touched words only', () => {
    const words = [w(1, 0, 1), w(2, 2, 3)];
    const mutations = commitProposal(words, map([[0, { start: 0.5, end: 1.2 }]]));
    applyLikeFunnel(words, mutations);
    assert.equal(words[0].userAdjusted, true);
    assert.equal(words[1].userAdjusted, undefined);
});

// ── zero-delta / returned-to-origin no-op ─────────────────────────

test('commitProposal: zero-delta proposal produces no mutations', () => {
    const words = [w(1, 0, 1), w(2, 2, 3)];
    const out = commitProposal(words, map([
        [0, { start: 0, end: 1 }],
        [1, { start: 2, end: 3 }],
    ]));
    assert.deepEqual(out, []);
});

test('commitProposal: drag returned to origin (fp residue ≤ eps) is a no-op', () => {
    const words = [w(1, 1, 2)];
    const out = commitProposal(words, map([[0, { start: 1 + 1e-12, end: 2 - 1e-12 }]]));
    assert.deepEqual(out, []);
});

test('commitProposal: empty or missing proposal produces no mutations', () => {
    const words = [w(1, 0, 1)];
    assert.deepEqual(commitProposal(words, new Map()), []);
    assert.deepEqual(commitProposal(words, null), []);
    assert.deepEqual(commitProposal(null, map([[0, { start: 1, end: 2 }]])), []);
});

// ── validation rejects (R2) ───────────────────────────────────────

test('commitProposal: out-of-range and non-integer indices are skipped', () => {
    const words = [w(1, 0, 1), w(2, 2, 3)];
    const out = commitProposal(words, map([
        [-1, { start: 0, end: 1 }],
        [2, { start: 4, end: 5 }],       // == words.length
        [1.5, { start: 0, end: 1 }],
        ['0', { start: 0, end: 0.5 }],
    ]));
    assert.deepEqual(out, []);
});

test('commitProposal: non-finite or negative times are skipped', () => {
    const words = [w(1, 0, 1), w(2, 2, 3), w(3, 5, 6)];
    const out = commitProposal(words, map([
        [0, { start: NaN, end: 1 }],
        [1, { start: 2.5, end: Infinity }],
        [2, { start: -0.5, end: 5.5 }],
    ]));
    assert.deepEqual(out, []);
});

test('commitProposal: a NEW start>end inversion is never introduced', () => {
    const words = [w(1, 0, 1)];
    assert.deepEqual(commitProposal(words, map([[0, { start: 0.9, end: 0.1 }]])), []);
});

test('commitProposal: already-inverted stored word keeps its inversion when moved (R6)', () => {
    // Rendered-as-stored data: moving it must not "fix" or reject it.
    const words = [w(1, 5, 2)];
    const out = commitProposal(words, map([[0, { start: 4, end: 1 }]]));
    assert.deepEqual(out, [{ index: 0, start: 4, end: 1 }]);
});

test('commitProposal: holes in the words array are skipped, not crashed', () => {
    const words = [w(1, 0, 1), null, w(3, 5, 6)];
    const out = commitProposal(words, map([
        [1, { start: 2, end: 3 }],
        [2, { start: 4.5, end: 5.5 }],
    ]));
    assert.deepEqual(out, [{ index: 2, start: 4.5, end: 5.5 }]);
});

// ── funnel wiring contract (source-level guard; App needs the DOM) ─

const appSrc = readFileSync(
    fileURLToPath(new URL('../app/assets/app.js', import.meta.url)), 'utf8',
);
const funnelSrc = appSrc.slice(
    appSrc.indexOf('applyTimelineEdit({ proposal }'),
    appSrc.indexOf('applyTimelineEdit({ proposal }') >= 0
        ? appSrc.indexOf('\n    },', appSrc.indexOf('applyTimelineEdit({ proposal }'))
        : appSrc.length,
);

test('bindTimeline routes onGestureEnd through applyTimelineEdit', () => {
    assert.match(appSrc, /onGestureEnd:\s*\(info\)\s*=>\s*this\.applyTimelineEdit\(info\)/);
});

test('applyTimelineEdit saves undo state exactly once per gesture', () => {
    assert.ok(funnelSrc.length > 0, 'applyTimelineEdit not found in app.js');
    const saves = funnelSrc.match(/this\.saveState\(\)/g) || [];
    assert.equal(saves.length, 1);
    // And the save is gated on a non-empty mutation list (no-op = no save).
    assert.match(funnelSrc, /if\s*\(!mutations\.length\)\s*return false;[\s\S]*this\.saveState\(\)/);
});

test('applyTimelineEdit writes only start/end/userAdjusted and refreshes downstream', () => {
    assert.match(funnelSrc, /word\.start = m\.start;/);
    assert.match(funnelSrc, /word\.end = m\.end;/);
    assert.match(funnelSrc, /word\.userAdjusted = true;/);
    for (const call of ['rebuildLayout()', 'renderTranscriptEditor()',
        'renderTranscriptDisplay()', 'updatePreview()', 'timeline?.invalidate()']) {
        assert.ok(funnelSrc.includes(call), `funnel must call ${call}`);
    }
    // R3: group-count change surfaces a status note.
    assert.match(funnelSrc, /captionGroups\.length !== groupsBefore/);
});
