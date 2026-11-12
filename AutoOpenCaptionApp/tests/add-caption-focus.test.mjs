/**
 * Type-at-once UX: App.addCaptionAt must move focus into the inspector's
 * text field right after a successful create, so the user can type the new
 * caption's text without reaching for the mouse. Rejections must NOT steal
 * focus (the create failed; leave the caret where it is).
 *
 * Two layers, per repo convention: the REAL extracted addCaptionAt runs
 * against a stub `this` (behavioral), plus regex source-guards on wiring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appSrc = readFileSync(
    fileURLToPath(new URL('../app/assets/app.js', import.meta.url)), 'utf8',
).replace(/\r\n/g, '\n');

// Anchor on the signature (the JSDoc above contains braces); the body ends
// at the lone closing '    },' that terminates the method.
const sig = 'addCaptionAt({ startSec, endSec, text = \'\' } = {}) {';
const fnStart = appSrc.indexOf(sig);
assert.ok(fnStart >= 0, 'App.addCaptionAt signature not found in app.js');
const fnSrc = appSrc.slice(fnStart, appSrc.indexOf('\n    },', fnStart));
// The signature already ends at the body's opening '{' — slice past it
// (a plain indexOf('{') would hit the destructured-parameter brace).
const body = fnSrc.slice(sig.length);

// Run the REAL extracted method against a recording stub environment.
function runAddCaption({ plan, transcript = { words: [] } } = {}) {
    const calls = [];
    let focusCount = 0;
    const fakeInput = { focus() { focusCount++; calls.push(['focus']); } };
    const stub = {
        transcript,
        video: { duration: 20, currentTime: 5 },
        timeline: { invalidate() { calls.push(['invalidate']); } },
        saveState() { calls.push(['saveState']); },
        rebuildLayout() { calls.push(['rebuildLayout']); },
        selectWord(index, opts) { calls.push(['selectWord', index, opts?.seek]); },
        renderTranscriptDisplay() { calls.push(['renderTranscriptDisplay']); },
        updatePreview() { calls.push(['updatePreview']); },
    };
    const planNewCaption = () => plan;
    const Status = { msg(m) { calls.push(['status', m]); } };
    const document = {
        getElementById: (id) => (id === 'inspector-text' ? fakeInput : null),
    };
    const fn = new Function(
        'planNewCaption', 'Status', 'document',
        `return function ({ startSec, endSec, text = '' } = {}) {${body}};`,
    )(planNewCaption, Status, document);
    const result = fn.call(stub, { startSec: 5 });
    return { result, calls, focusCount };
}

const okPlan = {
    ok: true, index: 1, shrunk: false,
    word: { id: 'w9', start: 5, end: 5.5, text: '' },
};

test('addCaptionAt: successful create focuses the inspector text field', () => {
    const { result, calls, focusCount } = runAddCaption({ plan: okPlan });
    assert.equal(result, true);
    assert.equal(focusCount, 1, 'must focus inspector-text exactly once');
    // Order contract: focus lands AFTER selection/rendering, so the
    // inspector is un-hidden and shows the new (empty) word's text.
    const focusAt = calls.findIndex((c) => c[0] === 'focus');
    const selectAt = calls.findIndex((c) => c[0] === 'selectWord');
    assert.ok(selectAt >= 0 && focusAt > selectAt,
        'focus must run after selectWord (inspector populated + visible)');
});

test('addCaptionAt: rejected plan creates nothing and never steals focus', () => {
    const { result, focusCount } = runAddCaption({
        plan: { ok: false, reason: 'no-room' },
    });
    assert.equal(result, false);
    assert.equal(focusCount, 0, 'rejected create must not move focus');
});

test('addCaptionAt: no transcript returns false before any focus/DOM touch', () => {
    const { result, focusCount } = runAddCaption({ plan: okPlan, transcript: null });
    assert.equal(result, false);
    assert.equal(focusCount, 0);
});

// ── source-level guards ───────────────────────────────────────────

test('guard: addCaptionAt focuses inspector-text via optional-chained focus()', () => {
    assert.match(fnSrc, /document\.getElementById\('inspector-text'\)\?\.focus\(\);/,
        "addCaptionAt must focus the inspector's text input");
});

test('guard: the focus call sits after selectWord and before the status msg', () => {
    const focusAt = fnSrc.indexOf("getElementById('inspector-text')");
    const selectAt = fnSrc.indexOf('selectWord(plan.index');
    const statusAt = fnSrc.indexOf('if (plan.shrunk)');
    assert.ok(selectAt >= 0 && focusAt > selectAt,
        'focus must come after selectWord (inspector must be visible first)');
    assert.ok(statusAt > focusAt, 'focus must run on the committed path');
});
