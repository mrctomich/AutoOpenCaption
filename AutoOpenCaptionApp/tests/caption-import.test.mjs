/**
 * Caption file import (SRT / VTT upload) — app/assets/caption-import.js.
 *
 * Three layers, per repo convention:
 *   1. the REAL pure module imported directly (parse + word pacing +
 *      transcript shape — the module is DOM-free by design);
 *   2. the REAL extracted App.loadCaptionFile run against a stub `this`
 *      (consent gate, mutation order, button/pipeline effects);
 *   3. regex source-guards on the wiring (button, binding, tooltips).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    parseCaptionFile, cuesToTranscriptWords, buildImportedTranscript,
} from '../app/assets/caption-import.js';
import { groupWords } from '../app/assets/caption-renderer.js';

const EPS = 1e-9;
const GROUPING = { maxWords: 8, maxSeconds: 2.5, maxCharacters: 42 };

// ── 1. Parser: SRT ────────────────────────────────────────────────────

test('SRT: BOM, CRLF, ids and ,mmm stamps parse to exact seconds', () => {
    const srt = '\uFEFF1\r\n00:01:02,500 --> 00:01:05,250\r\nHello there\r\n\r\n' +
        '2\r\n01:02:03,000 --> 01:02:04,100\r\nSecond cue\r\n';
    const r = parseCaptionFile(srt);
    assert.equal(r.format, 'srt');
    assert.equal(r.cues.length, 2);
    assert.ok(Math.abs(r.cues[0].start - 62.5) < EPS);   // 0:01:02,500
    assert.ok(Math.abs(r.cues[0].end - 65.25) < EPS);
    assert.equal(r.cues[0].text, 'Hello there');
    assert.ok(Math.abs(r.cues[1].start - 3723.0) < EPS); // 1:02:03,000
});

test('SRT: multi-line cue text joins, missing ids tolerated, .mmm accepted', () => {
    const srt = '00:00:01.000 --> 00:00:02.000\nline one\nline two\n\n' +
        '7\n00:00:03,000 --> 00:00:04,000\nsingle\n';
    const r = parseCaptionFile(srt);
    assert.equal(r.cues.length, 2);
    assert.equal(r.cues[0].text, 'line one line two');
    assert.equal(r.cues[1].text, 'single');
});

// ── 2. Parser: VTT ────────────────────────────────────────────────────

test('VTT: header, NOTE block, cue ids, settings, tags and entities', () => {
    const vtt = 'WEBVTT\nKind: captions\nLanguage: en\n\n' +
        'NOTE this block must vanish\n\n' +
        'STYLE\n::::\n\n' +
        'first-cue\n00:00:01.000 --> 00:00:02.000 line:90% position:50%\n<i>Hello</i> <v Speaker>world</v> &amp; friends\n\n' +
        '00:01:30.250 --> 00:01:32.000\nno-hours timestamp\n';
    const r = parseCaptionFile(vtt);
    assert.equal(r.format, 'vtt');
    assert.equal(r.cues.length, 2);
    assert.equal(r.cues[0].text, 'Hello world & friends');
    assert.ok(Math.abs(r.cues[1].start - 90.25) < EPS); // MM:SS.mmm
});

test('styling-only and empty cues drop; reversed times skip; no cues throws', () => {
    const srt = '00:00:01,000 --> 00:00:02,000\n<i></i>\n\n' +
        '00:00:03,000 --> 00:00:04,000\nreal cue\n';
    assert.equal(parseCaptionFile(srt).cues.length, 1);

    const reversed = '00:00:03,000 --> 00:00:04,000\nreal cue\n\n' +
        '00:00:05,000 --> 00:00:02,000\nbackwards\n';
    const rr = parseCaptionFile(reversed);
    assert.equal(rr.cues.length, 1);   // the reversed cue is skipped, counted
    assert.equal(rr.skippedLines, 1);

    assert.throws(() => parseCaptionFile(''), /empty/);
    assert.throws(() => parseCaptionFile('just some prose\nno timecodes here'), /no caption cues/);
});

// ── 3. Word pacing ────────────────────────────────────────────────────

test('words fill the cue: exact cue edges, monotone, length-weighted', () => {
    const cues = [
        { start: 1.0, end: 3.0, text: 'I am enormous' },
        { start: 3.5, end: 4.5, text: 'next block' },
    ];
    const { words, clampedCues } = cuesToTranscriptWords(cues);
    assert.equal(clampedCues, 0);
    assert.equal(words.length, 5);
    assert.ok(Math.abs(words[0].start - 1.0) < EPS);
    assert.ok(Math.abs(words[2].end - 3.0) < EPS);   // last word of cue 1 hits cue end
    assert.ok(Math.abs(words[3].start - 3.5) < EPS); // cue 2 keeps its start
    assert.ok(Math.abs(words[4].end - 4.5) < EPS);
    // monotone and non-overlapping throughout
    for (let i = 1; i < words.length; i++) {
        assert.ok(words[i].start >= words[i - 1].end - EPS, `overlap at ${i}`);
        assert.ok(words[i].end >= words[i].start);
    }
    // the long word got the biggest slice of its block
    assert.ok(words[2].end - words[2].start > words[1].end - words[1].start);
});

test('overlapping cues clamp forward; out-of-order cues sort first', () => {
    const cues = [
        { start: 6.5, end: 7.5, text: 'second in file' },
        { start: 1.0, end: 3.0, text: 'first by time' },
        { start: 2.5, end: 6.0, text: 'starts inside cue one' },
    ];
    const { words, clampedCues } = cuesToTranscriptWords(cues);
    assert.equal(clampedCues, 1);
    assert.equal(words[0].text, 'first'); // time-sorted
    for (let i = 1; i < words.length; i++) {
        assert.ok(words[i].start >= words[i - 1].end - EPS, `overlap at ${i}`);
    }
});

test('degenerate cues survive: zero-length and shorter than 1ms/word', () => {
    const cues = [
        { start: 1.0, end: 1.0, text: 'instant a b' },
        { start: 2.0, end: 2.002, text: 'one two three four' },
    ];
    const { words } = cuesToTranscriptWords(cues);
    for (let i = 1; i < words.length; i++) {
        assert.ok(words[i].start >= words[i - 1].end - EPS);
        assert.ok(words[i].end >= words[i].start);
    }
    assert.ok(Math.abs(words[1].end - 1.0) < EPS);
    assert.ok(Math.abs(words[words.length - 1].end - 2.002) < EPS);
    // groupWords still yields a positive-duration, single-lane cue
    const groups = groupWords(words, GROUPING);
    for (let i = 1; i < groups.length; i++) {
        assert.ok(groups[i].start >= groups[i - 1].end - EPS);
    }
});

// ── 4. Transcript shape ───────────────────────────────────────────────

test('imported transcript: estimated words with orig* snapshot, CTC gate closed', () => {
    const parsed = parseCaptionFile('00:00:01,000 --> 00:00:02,000\nHello world\n');
    const t = buildImportedTranscript(parsed, { sourceFile: 'movie.srt' });
    assert.equal(t.language, null);
    assert.equal(t.imported, true);
    assert.equal(t.sourceFormat, 'srt');
    assert.equal(t.sourceFile, 'movie.srt');
    assert.equal(t.words.length, 2);
    for (const w of t.words) {
        assert.equal(w.estimated, true);
        assert.equal(w.estimatedReason, 'caption-import');
        assert.equal(w.deleted, false);
        assert.equal(w.origText, w.text);
        assert.equal(w.origStart, w.start);
        assert.equal(w.origEnd, w.end);
    }
    const t2 = { ...t.timing };
    delete t2.clampedCues;
    assert.deepEqual(t2, {
        repaired: 0, estimated: 2, unplaced: 0, runs: 0,
        hasEstimates: true, importedCues: 1,
    });
    assert.equal(t.timing.clampedCues, 0);
});

// ── 5. App.loadCaptionFile (REAL extracted method, stub `this`) ───────

const appSrc = readFileSync(
    fileURLToPath(new URL('../app/assets/app.js', import.meta.url)), 'utf8',
).replace(/\r\n/g, '\n');

const sig = 'async loadCaptionFile(file) {';
const fnStart = appSrc.indexOf(sig);
assert.ok(fnStart >= 0, 'App.loadCaptionFile signature not found in app.js');
const body = appSrc.slice(fnStart + sig.length, appSrc.indexOf('\n    },', fnStart));

async function runLoadCaptionFile({
    fileText = '00:00:01,000 --> 00:00:02,000\nHi\n',
    parseImpl, buildImpl, confirmAnswer = true, transcript = null,
} = {}) {
    const calls = [];
    const els = {};
    const el = (id) => (els[id] ??= { disabled: true, classList: { add() {}, remove() {} } });
    const stub = {
        transcript,
        videoFile: { name: 'movie.mp4' },
        selectedWordIndex: 4,
        undoStack: [{ stale: true }],
        redoStack: [{ stale: true }],
        findMatches: [0],
        _ctcSnapshot: { stale: true },
        timeline: { invalidate() { calls.push('invalidate'); } },
        rebuildLayout() { calls.push('rebuildLayout'); },
        renderTranscriptEditor() { calls.push('renderTranscriptEditor'); },
        renderTranscriptDisplay() { calls.push('renderTranscriptDisplay'); },
        updateDiagnostics() { calls.push('updateDiagnostics'); },
        updateInspector() { calls.push('updateInspector'); },
        updateCtcUi() { calls.push('updateCtcUi'); },
        buildImportedWaveform() { calls.push('buildImportedWaveform'); },
        async askCaptionImport() { calls.push('askCaptionImport'); return confirmAnswer; },
    };
    const Status = {
        error(m) { calls.push(['status.error', m]); },
        success(m) { calls.push(['status.success', m]); },
        warning(m) { calls.push(['status.warning', m]); },
    };
    const document = { getElementById: el };
    const Pipeline = { complete(s) { calls.push(['pipeline.complete', s]); } };
    const parseCaptionFile = parseImpl ?? ((t) => {
        if (t.includes('GARBAGE')) throw new Error('no caption cues found');
        return { format: 'srt', cues: [{ start: 1, end: 2, text: 'Hi' }] };
    });
    const buildImportedTranscript = buildImpl ?? ((parsed, opts) => ({
        words: [{ id: 'i0000', text: 'Hi', start: 1, end: 2 }],
        timing: { importedCues: parsed.cues.length, clampedCues: 0 },
        sourceFile: opts.sourceFile,
    }));
    const fn = new Function(
        'parseCaptionFile', 'buildImportedTranscript', 'Status', 'document', 'Pipeline',
        `return async function (file) {${body}};`,
    )(parseCaptionFile, buildImportedTranscript, Status, document, Pipeline);
    const file = { name: 'subs.srt', text: async () => fileText };
    await fn.call(stub, file);
    return { stub, calls, els };
}

test('parse failure: Status.error, never reaches the restriction modal', async () => {
    const before = { words: [{ id: 'old', text: 'keep me' }] };
    const { stub, calls } = await runLoadCaptionFile({
        fileText: 'GARBAGE', transcript: before,
    });
    assert.equal(stub.transcript, before, 'existing transcript must survive');
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'status.error' && /no caption cues/.test(c[1])));
    assert.ok(!calls.includes('askCaptionImport'), 'modal must not open on a dead file');
});

test('consent cancelled: nothing is mutated at all', async () => {
    const before = { words: [{ id: 'old', text: 'keep me' }] };
    const { stub, calls } = await runLoadCaptionFile({
        transcript: before, confirmAnswer: false,
    });
    assert.ok(calls.includes('askCaptionImport'));
    assert.equal(stub.transcript, before);
    assert.equal(stub.undoStack.length, 1);
    assert.ok(!calls.some(c => Array.isArray(c) && c[0] === 'pipeline.complete'));
    assert.ok(!calls.some(c => Array.isArray(c) && c[0] === 'status.success'));
});

test('loadCaptionFile uses the styled modal, never native confirm()', () => {
    const codeOnly = body.replace(/\/\/.*$/gm, ''); // comments may mention confirm()
    assert.ok(!/\bconfirm\(/.test(codeOnly),
        'native confirm() scrolls on small windows — the modal owns the notice');
});

test('confirmed import: commit order, undo reset, gates and pipeline', async () => {
    const before = { words: [{ id: 'old', text: 'replace me' }] };
    const { stub, calls, els } = await runLoadCaptionFile({ transcript: before });

    assert.equal(stub.transcript.words[0].id, 'i0000', 'imported transcript committed');
    assert.equal(stub.transcript.sourceFile, 'subs.srt');
    assert.deepEqual(stub.undoStack, [], 'undo slots from the old captions must be gone');
    assert.deepEqual(stub.redoStack, []);
    assert.equal(stub.selectedWordIndex, -1);
    assert.equal(stub._ctcSnapshot, null);

    const seq = calls.filter(c => typeof c === 'string' && c !== 'confirm');
    assert.ok(seq.indexOf('rebuildLayout') >= 0);
    assert.ok(seq.indexOf('rebuildLayout') < seq.indexOf('renderTranscriptEditor'),
        'groups must exist before the editor renders');

    assert.equal(els['btn-export-srt'].disabled, false);
    assert.equal(els['btn-export-vtt'].disabled, false);
    assert.equal(els['btn-generate'].disabled, false);
    assert.ok(calls.some(c => c[0] === 'pipeline.complete' && c[1] === 'transcribe'));
    assert.ok(calls.some(c => c[0] === 'pipeline.complete' && c[1] === 'edit'));
    assert.ok(calls.includes('buildImportedWaveform'),
        'committed import must kick off the background waveform decode');
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'status.success' && /1 captions \(1 words\)/.test(c[1])));
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'status.warning' && /estimated/.test(c[1])),
        'the estimated-timing warning must fire after import');
});

// ── 6. The restriction modal itself (REAL extracted ask/resolve) ──────

function extractMethod(signature) {
    const start = appSrc.indexOf(signature);
    assert.ok(start >= 0, `signature not found: ${signature}`);
    return appSrc.slice(start + signature.length, appSrc.indexOf('\n    },', start));
}

function modalEnv() {
    const log = [];
    const mk = (id) => ({
        id, textContent: '',
        classList: {
            add(c) { log.push([id, 'add', c]); },
            remove(c) { log.push([id, 'remove', c]); },
        },
        focus() { log.push([id, 'focus']); },
    });
    const els = {};
    return {
        log,
        stub: {},
        document: { getElementById: (id) => (els[id] ??= mk(id)) },
    };
}

test('askCaptionImport: opens modal, fills detail, focuses Import', async () => {
    const bodyAsk = extractMethod('askCaptionImport(parsed, file, replacing) {');
    const { log, stub, document } = modalEnv();
    const fn = new Function('document', `return function (parsed, file, replacing) {${bodyAsk}};`)(document);
    const pending = fn.call(stub, { cues: [1, 2] }, { name: 'a b.srt' }, true);
    assert.match(stub._captionImportResolve.constructor.name, /Function/);
    const detail = document.getElementById('modal-import-detail').textContent;
    assert.match(detail, /Import 2 captions from "a b\.srt" and REPLACE the current captions\?/);
    assert.ok(log.some(l => l[0] === 'modal-import-captions' && l[1] === 'remove' && l[2] === 'hidden'));
    assert.ok(log.some(l => l[0] === 'btn-modal-import-ok' && l[1] === 'focus'));
    // answer it via the extracted resolver — the PROMISE carries the answer
    const bodyRes = extractMethod('resolveCaptionImport(answer) {');
    const res = new Function('document', `return function (answer) {${bodyRes}};`)(document);
    res.call(stub, true);
    assert.equal(await pending, true);
    assert.ok(log.some(l => l[0] === 'modal-import-captions' && l[1] === 'add' && l[2] === 'hidden'));
    assert.equal(stub._captionImportResolve, null);
    // double-resolve is a no-op (guard returns before touching the DOM)
    const logLen = log.length;
    res.call(stub, false);
    assert.equal(log.length, logLen, 'already-answered modal must not touch the DOM again');
});

// ── 7. Background waveform decode (REAL extracted buildImportedWaveform)

const wfBody = (() => {
    const sig = 'async buildImportedWaveform() {';
    const start = appSrc.indexOf(sig);
    assert.ok(start >= 0, 'App.buildImportedWaveform signature not found in app.js');
    return appSrc.slice(start + sig.length, appSrc.indexOf('\n    },', start));
})();

function wfEnv({ extractImpl, videoSwapDuringDecode = false, transcribeDuringDecode = false,
    discardDuringDecode = false, FFmpegLoaded = true } = {}) {
    const calls = [];
    const file = { name: 'movie.mp4' };
    const stub = {
        videoFile: file,
        transcript: { words: [1] },
        _transcribeRunning: false,
        _audioCache: null,
        buildWaveformPeaks() { calls.push('buildWaveformPeaks'); },
        async extractAudio() {
            calls.push('extractAudio');
            if (videoSwapDuringDecode) stub.videoFile = { name: 'other.mp4' };
            if (transcribeDuringDecode) stub._transcribeRunning = true;
            if (discardDuringDecode) stub.transcript = null;
            if (extractImpl) return extractImpl();
            return { samples: new Float32Array(4), duration: 0.00025 };
        },
    };
    const FFmpegService = {
        isLoaded: FFmpegLoaded,
        async init() { calls.push('ffmpeg.init'); },
    };
    const Status = {
        msg(m) { calls.push(['status.msg', m]); },
        warning(m) { calls.push(['status.warning', m]); },
    };
    const Progress = { hide() { calls.push('progress.hide'); } };
    const fn = new Function('FFmpegService', 'Status', 'Progress',
        `return async function () {${wfBody}};`)(FFmpegService, Status, Progress);
    return { calls, stub, run: () => fn.call(stub) };
}

test('waveform decode: happy path caches audio and builds peaks', async () => {
    const env = wfEnv();
    await env.run();
    assert.ok(env.calls.includes('extractAudio'));
    assert.ok(env.calls.includes('buildWaveformPeaks'));
    assert.ok(env.stub._audioCache, '_audioCache filled');
    assert.equal(env.stub._waveformBuild, false, 're-entrancy flag released');
    assert.ok(env.calls.some(c => Array.isArray(c) && c[0] === 'status.msg' && /Waveform ready/.test(c[1])));
});

test('waveform decode: FFmpeg is initialised only when not already loaded', async () => {
    const cold = wfEnv({ FFmpegLoaded: false });
    await cold.run();
    assert.ok(cold.calls.includes('ffmpeg.init'));
    const warm = wfEnv({ FFmpegLoaded: true });
    await warm.run();
    assert.ok(!warm.calls.includes('ffmpeg.init'));
});

test('waveform decode: results are DROPPED when the video swaps mid-decode', async () => {
    const env = wfEnv({ videoSwapDuringDecode: true });
    await env.run();
    assert.equal(env.stub._audioCache, null, 'stale decode must not poison the new video');
    assert.ok(!env.calls.includes('buildWaveformPeaks'));
});

test('waveform decode: transcribe takeover and discarded transcript also drop it', async () => {
    const t = wfEnv({ transcribeDuringDecode: true });
    await t.run();
    assert.equal(t.stub._audioCache, null);
    const d = wfEnv({ discardDuringDecode: true });
    await d.run();
    assert.equal(d.stub._audioCache, null);
});

test('waveform decode: failure warns, never throws, releases the flag', async () => {
    const env = wfEnv({ extractImpl: () => { throw new Error('no audio stream'); } });
    await env.run(); // must not reject
    assert.ok(env.calls.includes('progress.hide'), 'overlay cannot be left up');
    assert.ok(env.calls.some(c => Array.isArray(c) && c[0] === 'status.warning'
        && /Waveform skipped/.test(c[1]) && /Captions are unaffected/.test(c[1])));
    assert.equal(env.stub._waveformBuild, false);
});

test('waveform decode: second call while one is running is ignored', async () => {
    const env = wfEnv();
    env.stub._waveformBuild = true;
    await env.run();
    assert.ok(!env.calls.includes('extractAudio'));
});

// ── 8. Wiring source-guards ───────────────────────────────────────────

test('index.html carries the Import Captions button (disabled until a video loads)', () => {
    const html = readFileSync(
        fileURLToPath(new URL('../app/index.html', import.meta.url)), 'utf8',
    );
    assert.match(html, /id="btn-import-captions"[^>]*disabled[^>]*>Import Captions</);
});

test('index.html carries the restriction modal with all four notices', () => {
    const html = readFileSync(
        fileURLToPath(new URL('../app/index.html', import.meta.url)), 'utf8',
    );
    assert.match(html, /id="modal-import-captions" class="modal-overlay hidden"/);
    assert.match(html, /id="btn-modal-import-ok" class="btn-primary">Import</);
    assert.match(html, /id="btn-modal-import-cancel" class="btn-secondary">Cancel</);
    const li = html.match(/<ul id="modal-import-restrictions">[\s\S]*?<\/ul>/);
    assert.ok(li, 'restrictions list missing');
    assert.equal((li[0].match(/<li>/g) ?? []).length, 4);
});

test('app.js wiring: binding, file types, enable-on-video, tooltips, Escape guard', () => {
    assert.match(appSrc,
        /document\.getElementById\('btn-import-captions'\)\.addEventListener\('click', \(\) => this\.importCaptions\(\)\);/);
    assert.match(appSrc, /input\.accept = '\.srt,\.vtt';/);
    assert.match(appSrc,
        /document\.getElementById\('btn-import-captions'\)\.disabled = false;/);
    assert.match(appSrc, /word\.estimatedReason === 'caption-import'/,
        'chip tooltip must distinguish imported-file estimates');
    assert.match(appSrc, /this\.transcript\.imported/,
        'CTC realign tooltip must explain imported transcripts');
    // modal buttons wired, and Escape owns the keyboard while it is open
    assert.match(appSrc,
        /document\.getElementById\('btn-modal-import-ok'\)\s*\n?\s*\.addEventListener\('click', \(\) => this\.resolveCaptionImport\(true\)\);/);
    assert.match(appSrc,
        /const importModal = document\.getElementById\('modal-import-captions'\);/,);
    assert.match(appSrc,
        /if \(importModal && !importModal\.classList\.contains\('hidden'\)\) \{[\s\S]{0,160}this\.resolveCaptionImport\(false\);/);
});
