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
    };
    const Status = {
        error(m) { calls.push(['status.error', m]); },
        success(m) { calls.push(['status.success', m]); },
        warning(m) { calls.push(['status.warning', m]); },
    };
    const document = { getElementById: el };
    const Pipeline = { complete(s) { calls.push(['pipeline.complete', s]); } };
    const confirm = () => { calls.push('confirm'); return confirmAnswer; };
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
        'parseCaptionFile', 'buildImportedTranscript', 'Status', 'document', 'Pipeline', 'confirm',
        `return async function (file) {${body}};`,
    )(parseCaptionFile, buildImportedTranscript, Status, document, Pipeline, confirm);
    const file = { name: 'subs.srt', text: async () => fileText };
    await fn.call(stub, file);
    return { stub, calls, els };
}

test('parse failure: Status.error, never reaches the consent dialog', async () => {
    const before = { words: [{ id: 'old', text: 'keep me' }] };
    const { stub, calls } = await runLoadCaptionFile({
        fileText: 'GARBAGE', transcript: before,
    });
    assert.equal(stub.transcript, before, 'existing transcript must survive');
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'status.error' && /no caption cues/.test(c[1])));
    assert.ok(!calls.includes('confirm'), 'consent dialog must not open on a dead file');
});

test('consent cancelled: nothing is mutated at all', async () => {
    const before = { words: [{ id: 'old', text: 'keep me' }] };
    const { stub, calls } = await runLoadCaptionFile({
        transcript: before, confirmAnswer: false,
    });
    assert.ok(calls.includes('confirm'));
    assert.equal(stub.transcript, before);
    assert.equal(stub.undoStack.length, 1);
    assert.ok(!calls.some(c => Array.isArray(c) && c[0] === 'pipeline.complete'));
    assert.ok(!calls.some(c => Array.isArray(c) && c[0] === 'status.success'));
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
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'status.success' && /1 captions \(1 words\)/.test(c[1])));
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'status.warning' && /estimated/.test(c[1])),
        'the estimated-timing warning must fire after import');
});

// ── 6. Wiring source-guards ───────────────────────────────────────────

test('index.html carries the Import Captions button (disabled until a video loads)', () => {
    const html = readFileSync(
        fileURLToPath(new URL('../app/index.html', import.meta.url)), 'utf8',
    );
    assert.match(html, /id="btn-import-captions"[^>]*disabled[^>]*>Import Captions</);
});

test('app.js wiring: binding, file types, enable-on-video, tooltips', () => {
    assert.match(appSrc,
        /document\.getElementById\('btn-import-captions'\)\.addEventListener\('click', \(\) => this\.importCaptions\(\)\);/);
    assert.match(appSrc, /input\.accept = '\.srt,\.vtt';/);
    assert.match(appSrc,
        /document\.getElementById\('btn-import-captions'\)\.disabled = false;/);
    assert.match(appSrc, /word\.estimatedReason === 'caption-import'/,
        'chip tooltip must distinguish imported-file estimates');
    assert.match(appSrc, /this\.transcript\.imported/,
        'CTC realign tooltip must explain imported transcripts');
});
