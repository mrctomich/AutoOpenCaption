/**
 * Replacing the video while a transcript is loaded must ask the user
 * first: Keep captions (carry over), Start fresh (discard), or Cancel
 * (abort the load). No transcript ⇒ no question.
 *
 * Two layers, per repo convention: the REAL extracted loadVideo /
 * askCaptionReplacement / resolveCaptionChoice / clearCaptions run against
 * stub `this` + stub document (behavioral), plus regex source-guards on
 * the modal markup, button wiring, and the keyboard guard in
 * bindKeyboardShortcuts.
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

function extractBody(signature) {
    const start = appSrc.indexOf(signature);
    assert.ok(start >= 0, `${signature} not found in app.js`);
    const end = appSrc.indexOf('\n    },', start);
    assert.ok(end > start, `end of ${signature} not found`);
    // Signature already ends at the body's opening '{' — slice past its
    // whole length (a bare indexOf('{') would hit a parameter brace).
    return appSrc.slice(start + signature.length, end);
}

const loadVideoBody = extractBody('async loadVideo(file) {');
const askBody = extractBody('askCaptionReplacement(incomingFile) {');
const resolveBody = extractBody('resolveCaptionChoice(choice) {');
const clearBody = extractBody('clearCaptions() {');

const loadVideo = new Function(
    'return async function (file) {' + loadVideoBody + '};')();

// ── 1. behavioral: loadVideo gate ─────────────────────────────────

function runLoadVideo({ transcript, answer }) {
    const app = {
        transcript,
        videoFile: { name: 'old.mp4' },
        _captionChoiceResolve: null,
        calls: [],
        answer,
        askCaptionReplacement: async (f) => {
            app.calls.push(['ask', f.name]);
            return app.answer;
        },
        applyVideoLoad: (f) => app.calls.push(['apply', f.name]),
        clearCaptions: () => app.calls.push(['clear']),
    };
    return loadVideo.call(app, { name: 'new.mp4' }).then(() => app.calls);
}

const t100 = { words: new Array(100) };

test('loadVideo: transcript + keep ⇒ asks, keeps (no clear), loads', async () => {
    const calls = await runLoadVideo({ transcript: t100, answer: 'keep' });
    assert.deepEqual(calls, [['ask', 'new.mp4'], ['apply', 'new.mp4']]);
});

test('loadVideo: transcript + clear ⇒ clears BEFORE loading', async () => {
    const calls = await runLoadVideo({ transcript: t100, answer: 'clear' });
    assert.deepEqual(calls, [['ask', 'new.mp4'], ['clear'], ['apply', 'new.mp4']]);
});

test('loadVideo: transcript + cancel ⇒ never loads, never clears', async () => {
    const calls = await runLoadVideo({ transcript: t100, answer: null });
    assert.deepEqual(calls, [['ask', 'new.mp4']]);
});

test('loadVideo: no transcript ⇒ no question, straight to load', async () => {
    for (const transcript of [null, { words: [] }]) {
        const calls = await runLoadVideo({ transcript, answer: 'clear' });
        assert.deepEqual(calls, [['apply', 'new.mp4']]);
    }
});

test('loadVideo: a second load while the question is open is ignored', async () => {
    const app = {
        transcript: t100,
        _captionChoiceResolve: () => {}, // modal already open
        calls: [],
    };
    await loadVideo.call(app, { name: 'new.mp4' });
    assert.deepEqual(app.calls, []);
});

// ── 2. behavioral: the real modal round-trip ──────────────────────

function fakeEl() {
    return {
        textContent: '',
        focusCount: 0,
        focus() { this.focusCount++; },
        _hidden: true,
        classList: {
            remove(c) { this._self._hidden = false; },
            add(c) { this._self._hidden = true; },
            contains(c) { return this._self._hidden; },
        },
    };
}

test('ask→resolve: modal shows with word count + names, resolves the choice', async () => {
    const els = {};
    const document = { getElementById: (id) => (els[id] ??= (() => {
        const e = fakeEl(); e.classList._self = e; return e;
    })()) };
    const ask = new Function('document',
        'return function (incomingFile) {' + askBody + '};')(document);
    const resolve = new Function('document',
        'return function (choice) {' + resolveBody + '};')(document);

    const app = { transcript: { words: new Array(142) }, videoFile: { name: 'old.mp4' } };
    const pending = ask.call(app, { name: 'new.mp4' });

    assert.equal(els['modal-replace-captions']._hidden, false, 'modal must be shown');
    const detail = els['modal-replace-detail'].textContent;
    assert.match(detail, /old\.mp4/);
    assert.match(detail, /new\.mp4/);
    assert.match(detail, /142 words/);
    assert.equal(els['btn-modal-keep-captions'].focusCount, 1,
        'safe default (Keep) receives focus so Enter/Space acts immediately');

    resolve.call(app, 'keep');
    assert.equal(await pending, 'keep');
    assert.equal(els['modal-replace-captions']._hidden, true, 'modal must hide after answer');
    assert.equal(app._captionChoiceResolve, null, 'pending slot must be cleared');

    // A stale second answer (double-click) must be a silent no-op.
    resolve.call(app, 'clear');
    assert.equal(els['modal-replace-captions']._hidden, true);
});

// ── 3. behavioral: clearCaptions rewinds to pre-transcription state ──

test('clearCaptions resets transcript state, disables export, rewinds pipeline', () => {
    const calls = [];
    const buttons = {};
    const document = {
        getElementById: (id) => (buttons[id] ??= { id, disabled: false }),
    };
    const Pipeline = { undo: (s) => calls.push(['pipeline-undo', s]) };
    const Status = { msg: (m) => calls.push(['status', m]) };
    const clear = new Function('document', 'Pipeline', 'Status',
        'return function () {' + clearBody + '};')(document, Pipeline, Status);

    const app = {
        transcript: { words: [{}] },
        transcriptMeta: { model: 'whisper-base', processingTime: 1, audioSamples: 2, audioDuration: 3 },
        undoStack: [{}, {}], redoStack: [{}],
        selectedWordIndex: 4, _ctcSnapshot: { x: 1 },
        canvas: { width: 640, height: 360 },
        ctx: { clearRect: () => calls.push(['clearRect']) },
        timeline: { invalidate: () => calls.push(['tl-invalidate']) },
        rebuildLayout: () => calls.push('rebuildLayout'),
        renderTranscriptEditor: () => calls.push('renderTranscriptEditor'),
        renderTranscriptDisplay: () => calls.push('renderTranscriptDisplay'),
        updateDiagnostics: () => calls.push('updateDiagnostics'),
        updateInspector: () => calls.push('updateInspector'),
        updateCtcUi: () => calls.push('updateCtcUi'),
        highlightActiveWord: () => calls.push('highlightActiveWord'),
    };
    clear.call(app);

    assert.equal(app.transcript, null);
    assert.equal(app.transcriptMeta.model, null);
    assert.deepEqual(app.undoStack, []);
    assert.deepEqual(app.redoStack, []);
    assert.equal(app.selectedWordIndex, -1);
    assert.equal(app._ctcSnapshot, null);
    assert.equal(buttons['btn-export-srt'].disabled, true);
    assert.equal(buttons['btn-export-vtt'].disabled, true);
    assert.equal(buttons['btn-generate'].disabled, true);
    assert.deepEqual(calls.filter((c) => Array.isArray(c) && c[0] === 'pipeline-undo')
        .map((c) => c[1]), ['transcribe', 'edit', 'export']);
    for (const m of ['rebuildLayout', 'renderTranscriptEditor', 'renderTranscriptDisplay',
        'updateDiagnostics', 'updateInspector', 'updateCtcUi', 'clearRect',
        'highlightActiveWord', 'tl-invalidate']) {
        assert.ok(calls.flat().includes(m), `clearCaptions must call ${m}`);
    }
});

// ── 4. source-level guards ────────────────────────────────────────

test('guard: modal markup exists, hidden by default, with the three actions', () => {
    assert.match(htmlSrc, /id="modal-replace-captions" class="modal-overlay hidden"/);
    assert.match(htmlSrc, /id="btn-modal-cancel-load" class="btn-secondary"/);
    assert.match(htmlSrc, /id="btn-modal-clear-captions" class="btn-secondary btn-danger"/);
    assert.match(htmlSrc, /id="btn-modal-keep-captions" class="btn-primary"/);
    assert.match(htmlSrc, /id="modal-replace-detail"/);
});

test('guard: the three modal buttons resolve keep/clear/null in bindEvents', () => {
    const start = appSrc.indexOf('bindEvents() {');
    assert.ok(start >= 0);
    const end = appSrc.indexOf('\n    },', start);
    const body = appSrc.slice(start, end);
    assert.match(body, /getElementById\('btn-modal-keep-captions'\)[\s\S]{0,60}resolveCaptionChoice\('keep'\)\);/);
    assert.match(body, /getElementById\('btn-modal-clear-captions'\)[\s\S]{0,60}resolveCaptionChoice\('clear'\)\);/);
    assert.match(body, /getElementById\('btn-modal-cancel-load'\)[\s\S]{0,60}resolveCaptionChoice\(null\)\);/);
});

test('guard: applyVideoLoad is reachable only through the loadVideo gate (or the content-identical transcode swap)', () => {
    const direct = [...appSrc.matchAll(/this\.applyVideoLoad\(/g)];
    assert.equal(direct.length, 2,
        'import paths go through loadVideo; the ONLY other caller is runTranscode swapping in a content-identical H.264 conversion (no caption prompt needed)');
    assert.match(loadVideoBody, /this\.applyVideoLoad\(file\);/);
    const swStart = appSrc.indexOf('async swapInConverted(file, dataOrBlob) {');
    const swBody = appSrc.slice(swStart, appSrc.indexOf('\n    },', swStart));
    assert.ok(swStart > 0 && /this\.applyVideoLoad\(converted\);/.test(swBody),
        'second caller must be swapInConverted (content-identical H.264 swap)');
});

test('guard: both import paths still route through loadVideo', () => {
    const calls = [...appSrc.matchAll(/this\.loadVideo\(file\);/g)];
    assert.equal(calls.length, 2, 'drop handler + file-input onchange');
});

test('guard: open modal owns the keyboard — Escape cancels, other keys swallowed', () => {
    const start = appSrc.indexOf('bindKeyboardShortcuts() {');
    assert.ok(start >= 0);
    const end = appSrc.indexOf('\n    },', start);
    const kbd = appSrc.slice(start, end);
    const guardAt = kbd.indexOf("getElementById('modal-replace-captions')");
    const aeAt = kbd.indexOf('const ae = document.activeElement;');
    assert.ok(guardAt >= 0 && guardAt < aeAt,
        'modal guard must run before any shortcut logic (before const ae = ...)');
    assert.match(kbd.slice(guardAt, aeAt),
        /e\.key === 'Escape'[\s\S]{0,80}this\.resolveCaptionChoice\(null\);/);
    assert.match(kbd.slice(guardAt, aeAt), /return;\s*\n\s*\}/,
        'every non-Escape key must return while the modal is open');
});
