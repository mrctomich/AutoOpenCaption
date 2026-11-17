/**
 * transcode-service.test.mjs — unit + behavioral tests for the Tier 2
 * WebCodecs convert-on-import feature.
 *
 * Three layers, same shape as codec-detect.test.mjs:
 *   1. pure helpers imported straight from transcode-service.js
 *      (no DOM/WebCodecs touched at module load);
 *   2. the REAL extracted App methods against a stub `this` (offer
 *      decision, modal resolve semantics, runTranscode success/cancel/
 *      failure/swap flows);
 *   3. source guards: the modal, its wiring, the keyboard guard and the
 *      vendored libraries are present where they must be.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
    audioSpecificConfigFromEsds,
    pickOutputBitrate,
    chooseAvcLevel,
    rotationFromMatrix,
    descriptionBoxName,
    webCodecsAvailable,
    transcodeToH264,
    MAX_TRANSCODE_BYTES,
    TranscodeCancelled,
} from '../app/assets/transcode-service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appJsPath = path.join(here, '..', 'app', 'assets', 'app.js');
const indexHtmlPath = path.join(here, '..', 'app', 'index.html');
const appSrc = readFileSync(appJsPath, 'utf8').replace(/\r\n/g, '\n');
const htmlSrc = readFileSync(indexHtmlPath, 'utf8').replace(/\r\n/g, '\n');

// ── layer 1: pure helpers ────────────────────────────────────────────────

test('pickOutputBitrate: scales source bitrate by 1.25 within sane bounds', () => {
    // The user's JohnOliver HEVC: 1718 kbps at 1080x1920@24
    const bps = pickOutputBitrate(1_718_000, 1080, 1920, 24);
    assert.equal(bps, 2_147_500);
    // tiny source bitrate -> resolution floor, not a 5 kbps disaster
    const lo = pickOutputBitrate(10_000, 1080, 1920, 24);
    assert.ok(lo >= 800_000 && lo >= 1080 * 1920 * 24 * 0.04 * 0.99);
    // absurd source bitrate -> resolution ceiling
    const hi = pickOutputBitrate(1e9, 1080, 1920, 24);
    assert.ok(hi <= 1080 * 1920 * 24 * 0.30 + 1);
    // no info -> heuristic, finite and positive
    const auto = pickOutputBitrate(undefined, 1280, 720, 0);
    assert.ok(auto > 0 && Number.isFinite(auto));
});

test('chooseAvcLevel: 1080-class gets level 4.0, 4K gets 5.1', () => {
    assert.equal(chooseAvcLevel(1080, 1920, 24), '640028');
    assert.equal(chooseAvcLevel(1280, 720, 60), '640028');
    assert.equal(chooseAvcLevel(3840, 2160, 30), '640033');
});

test('rotationFromMatrix: snaps tkhd matrices to 0/90/180/270', () => {
    const ID = 65536;
    assert.equal(rotationFromMatrix([ID, 0, 0, 0, ID, 0, 0, 0, 1073741824]), 0);
    assert.equal(rotationFromMatrix([0, ID, 0, -ID, 0, 0, 0, 0, 1073741824]), 90);
    assert.equal(rotationFromMatrix([0, -ID, 0, ID, 0, 0, 0, 0, 1073741824]), 270);
    assert.equal(rotationFromMatrix([-ID, 0, 0, 0, -ID, 0, 0, 0, 1]), 180);
    assert.equal(rotationFromMatrix([46341, 46341, 0, -46341, 46341, 0, 0, 0, 1]), 0); // 45° skew → 0
    assert.equal(rotationFromMatrix(null), 0);
    assert.equal(rotationFromMatrix([0, 0, 0, 0, 0, 0, 0, 0, 1]), 0);
});

test('descriptionBoxName: maps codec families to their config boxes', () => {
    assert.equal(descriptionBoxName('avc1.640028'), 'avcC');
    assert.equal(descriptionBoxName('avc3.4D001E'), 'avcC');
    assert.equal(descriptionBoxName('hvc1.1.6.L153.90'), 'hvcC');
    assert.equal(descriptionBoxName('hev1.1.6.L93.B0'), 'hvcC');
    assert.equal(descriptionBoxName('av01.0.09M.08'), 'av1C');
    assert.equal(descriptionBoxName('vp09.00.10.08'), 'vpcC');
    assert.equal(descriptionBoxName('mp4a.40.2'), 'esds');
    assert.equal(descriptionBoxName('opus'), null);
    assert.equal(descriptionBoxName(undefined), null);
});

test('audioSpecificConfigFromEsds: digs the 0x05 payload out of a real-shaped esds', () => {
    // Build the exact byte shape ffmpeg/HandBrake emit for AAC-LC 44.1k stereo.
    const asc = [0x12, 0x10]; // audioSpecificConfig: AAC-LC @ 44100, chan cfg 2
    const bytes = [
        0x00, 0x00, 0x00, 0x00, // version + flags
        0x03, 0x19, // ES_Descriptor tag + len
        0x00, 0x01, // ES_ID
        0x00, // flags: no OCR / priority / URI
        0x04, 0x0F, // DecoderConfigDescriptor tag + len
        0x40, 0x15, 0x00, 0x06, 0x00, 0x00, 0x03, 0x84, 0x00, 0x00, 0x03, 0x84, 0x00, // 13 bytes
        0x05, 0x02, ...asc, // DecSpecificInfo tag + len + payload
        0x06, 0x01, 0x02, // SLConfigDescriptor (ignored)
    ];
    assert.deepEqual([...audioSpecificConfigFromEsds(Uint8Array.from(bytes))], asc);
    assert.equal(audioSpecificConfigFromEsds(null), null);
    assert.equal(audioSpecificConfigFromEsds(Uint8Array.from([1, 2, 3])), null);
    const bad = Uint8Array.from(bytes); bad[4] = 0x99; // wrong top tag
    assert.equal(audioSpecificConfigFromEsds(bad), null);
});

test('webCodecsAvailable + module surface', () => {
    assert.equal(webCodecsAvailable(), false); // plain node: no window
    assert.equal(MAX_TRANSCODE_BYTES, 1.5 * 1024 * 1024 * 1024);
    assert.equal(typeof transcodeToH264, 'function');
    const err = new TranscodeCancelled();
    assert.equal(err.isCancelled, true);
    assert.ok(err instanceof Error);
});

// ── layer 2: the REAL App methods against a stub `this` ──────────────────

function extractMethod(name, signature = null) {
    const sig = signature || `${name}() {`;
    const start = appSrc.indexOf(sig);
    assert.ok(start >= 0, `method ${name} found`);
    const bodyStart = appSrc.indexOf('{', start + sig.length - 1);
    const end = appSrc.indexOf('\n    },', bodyStart);
    assert.ok(end > bodyStart, `${name} body terminator found`);
    return appSrc.slice(bodyStart + 1, end);
}

function makeStatus() {
    const msgs = [];
    return {
        msgs,
        error: (m) => msgs.push(['error', m]),
        warning: (m) => msgs.push(['warning', m]),
        msg: (m) => msgs.push(['msg', m]),
        success: (m) => msgs.push(['success', m]),
    };
}

test('needsTranscodeOffer: only mp4 hvc1/hev1/av01 with WebCodecs', () => {
    const fn = new Function('webCodecsAvailable', `return function (info) {${extractMethod('needsTranscodeOffer', 'needsTranscodeOffer(info) {')}}`);
    const yes = { container: 'mp4', videoCodec: 'av01' };
    assert.equal(fn(() => true)(yes), true);
    assert.equal(fn(() => true)({ container: 'mp4', videoCodec: 'hvc1' }), true);
    assert.equal(fn(() => true)({ container: 'mp4', videoCodec: 'avc1' }), false);
    assert.equal(fn(() => true)({ container: 'mp4', videoCodec: 'vp09' }), false);
    assert.equal(fn(() => true)({ container: 'webm', videoCodec: 'av01' }), false);
    assert.equal(fn(() => false)(yes), false); // no WebCodecs -> never offer
    assert.equal(fn(() => true)(null), false);
});

test('resolveTranscode: hides modal, resolves once, double-resolve is a no-op', async () => {
    const modals = [];
    const document = { getElementById: (id) => ({ id, textContent: '', classList: { add: () => modals.push(['add', id]), remove: () => modals.push(['rm', id]) }, focus() { } }) };
    const ask = new Function('document', `return function (info) {${extractMethod('askTranscode', 'askTranscode(info) {')}}`);
    const resolve = new Function('document', `return function (convert) {${extractMethod('resolveTranscode', 'resolveTranscode(convert) {')}}`);
    const stub = { transcodeOfferDetail: () => 'detail text' };
    const p = ask(document).call(stub, { videoCodec: 'av01', container: 'mp4' });
    assert.equal(typeof stub._transcodeAskResolve, 'function');
    resolve(document).call(stub, true);
    resolve(document).call(stub, false); // must NOT overwrite the first answer
    assert.equal(await p, true);
    assert.equal(stub._transcodeAskResolve, null);
});

test('maybeOfferTranscode: decline remembers per-file; convert runs; stale file ignored', async () => {
    const fn = new Function(`return async function (file, info) {${extractMethod('maybeOfferTranscode', 'maybeOfferTranscode(file, info) {')}}`);
    const mk = (videoFile) => ({
        videoFile,
        _transcodeAskResolve: null,
        _transcoding: false,
        asked: 0,
        ran: [],
        needsTranscodeOffer: () => true,
        async askTranscode() { this.asked++; return this.answer; },
        async runTranscode(f) { this.ran.push(f); },
    });
    const f1 = { name: 'a.mp4' };
    const declined = mk(f1); declined.answer = false;
    await fn().call(declined, f1, { container: 'mp4', videoCodec: 'av01' });
    assert.equal(declined._transcodeDeclinedFile, f1);
    await fn().call(declined, f1, { container: 'mp4', videoCodec: 'av01' });
    assert.equal(declined.asked, 1, 'declined file is never re-asked');

    const converted = mk(f1); converted.answer = true;
    await fn().call(converted, f1, { container: 'mp4', videoCodec: 'av01' });
    assert.deepEqual(converted.ran, [f1]);

    const stale = mk({ name: 'other.mp4' }); stale.answer = true;
    await fn().call(stale, f1, { container: 'mp4', videoCodec: 'av01' });
    assert.equal(stale.asked, 0, 'offer dies when the video already swapped');
});

function runTranscodeHarness({ transcodeImpl, videoSwapDuring = false, codec = 'av01' }) {
    const Status = makeStatus();
    const Progress = { calls: [], showProgress(t, s, c) { this.calls.push(['show', t]); this.cancel = c; }, update(p, s) { this.calls.push(['update', p]); }, hide() { this.calls.push(['hide']); } };
    class FileStub { constructor(parts, name) { this.name = name; this.size = 12345; } }
    const transcodeToH264 = transcodeImpl;
    const fn = new Function('Status', 'Progress', 'transcodeToH264', 'File', 'wasmCanDecodeVideo', 'codecLabel',
        `return async function (file) {${extractMethod('runTranscode', 'runTranscode(file) {')}}`);
    const file = { name: 'clip.hevc.mp4' };
    const stub = {
        _transcoding: false, _exportRunning: false, _transcribeRunning: false, _transcodeAskResolve: null,
        _codecInfo: { container: 'mp4', videoCodec: codec }, ffmpegLoaded: true,
        videoFile: file,
        video: { currentTime: 7.5, addEventListener() { } },
        loaded: null, swapped: [],
        applyVideoLoad(f) { this.loaded = f; if (videoSwapDuring) this.videoFile = f; },
        async swapInConverted(f, data) { this.swapped.push([f, data]); if (videoSwapDuring) this.videoFile = f; },
        async transcodeWithFFmpeg(f) { this.ffmpegCalled = f; return { byteLength: 9, size: 9 }; },
    };
    return fn(Status, Progress, transcodeToH264, FileStub, (c) => c === 'hvc1', (c) => c).call(stub, file)
        .then(() => ({ stub, Status, Progress }));
}

test('runTranscode success: hands the blob to swapInConverted', async () => {
    const blob = { size: 5_000_000 };
    const { stub, Progress } = await runTranscodeHarness({ transcodeImpl: async () => blob });
    assert.equal(stub.swapped.length, 1);
    assert.equal(stub.swapped[0][1], blob);
    assert.ok(Progress.calls.some(([k]) => k === 'hide'));
    assert.equal(stub._transcoding, false);
});

test('swapInConverted: *_h264.mp4 name, pinned avc1 sniff, success status, save offer', async () => {
    const fn = new Function('File', 'Status',
        `return async function (file, dataOrBlob) {${extractMethod('swapInConverted', 'swapInConverted(file, dataOrBlob) {')}}`);
    const stub = {
        loaded: null, video: { currentTime: 3, addEventListener() { } }, applyVideoLoad(f) { this.loaded = f; },
        saveAsked: null,
        async askSaveConverted(f) { this.saveAsked = f; return false; },
    };
    await fn(FileStub(), makeStatus()).call(stub, { name: 'clip.hevc.mp4' }, new Blob(['abc'], { type: 'video/mp4' }));
    assert.equal(stub.loaded.name, 'clip.hevc_h264.mp4');
    assert.equal(stub._codecInfo.videoCodec, 'avc1');
    assert.equal(stub._codecFile, stub.loaded);
    assert.equal((await stub._codecProbe).videoCodec, 'avc1');
    assert.equal(stub.saveAsked, stub.loaded, 'the user is asked where to save the converted copy');
});
function FileStub() { return class { constructor(parts, name) { this.name = name; this.size = 3; } }; }

test('runTranscode failure on AV1 (no wasm decode) keeps the plain error — no fallback', async () => {
    const { stub, Status } = await runTranscodeHarness({
        transcodeImpl: async () => { throw new Error('This browser cannot decode av01'); },
    });
    assert.equal(stub.swapped.length, 0);
    assert.equal(stub.ffmpegCalled, undefined, 'no FFmpeg fallback for codecs the wasm core cannot decode either');
    assert.ok(Status.msgs.some(([k, m]) => k === 'error' && m.includes('cannot decode')));
});

test('runTranscode failure on HEVC (wasm can decode) falls back to FFmpeg and swaps the result', async () => {
    const { stub, Status } = await runTranscodeHarness({
        codec: 'hvc1',
        transcodeImpl: async () => { throw new Error('This browser cannot decode hvc1'); },
    });
    assert.equal(stub.ffmpegCalled.name, 'clip.hevc.mp4', 'fallback ran through FFmpeg with the original file');
    assert.equal(stub.swapped.length, 1, 'fallback result swapped in like the WebCodecs path');
    assert.equal(stub.swapped[0][1].byteLength, 9);
    assert.ok(Status.msgs.some(([k, m]) => k === 'msg' && m.includes('falling back')));
    assert.ok(!Status.msgs.some(([k]) => k === 'error'), 'successful fallback is not an error');
});

test('runTranscode cancel keeps original and logs no error', async () => {

    const cancelled = await runTranscodeHarness({ transcodeImpl: async () => { const e = new Error('Conversion cancelled.'); e.isCancelled = true; throw e; } });
    assert.equal(cancelled.stub.loaded, null);
    assert.equal(cancelled.stub.swapped.length, 0);
    assert.ok(cancelled.Status.msgs.some(([k, m]) => k === 'msg' && m.toLowerCase().includes('cancelled')));
    assert.ok(!cancelled.Status.msgs.some(([k]) => k === 'error'), 'cancel is not an error');
});

test('runTranscode refuses while export/transcription is running', async () => {
    let called = false;
    const Status = makeStatus();
    const Progress = { showProgress() { }, update() { }, hide() { } };
    const fn = new Function('Status', 'Progress', 'transcodeToH264', 'File', 'wasmCanDecodeVideo', 'codecLabel',
        `return async function (file) {${extractMethod('runTranscode', 'runTranscode(file) {')}}`);
    const file = { name: 'a.mp4' };
    const stub = {
        _transcoding: false, _exportRunning: true, _transcribeRunning: false, _transcodeAskResolve: null,
        videoFile: file, video: { currentTime: 0, addEventListener() { } }, loaded: null, applyVideoLoad(f) { this.loaded = f; },
    };
    await fn(Status, Progress, async () => { called = true; return {}; }, File, () => false, (c) => c).call(stub, file);
    assert.equal(called, false);
    assert.ok(Status.msgs.some(([k]) => k === 'warning'));
});

// ── layer 3: wiring source-guards ────────────────────────────────────────

test('index.html carries the transcode modal with both buttons', () => {
    assert.ok(htmlSrc.includes('id="modal-transcode"'));
    assert.ok(htmlSrc.includes('id="btn-modal-transcode-convert"'));
    assert.ok(htmlSrc.includes('id="btn-modal-transcode-keep"'));
    assert.ok(htmlSrc.includes('id="modal-transcode-detail"'));
});

test('bindEvents wires both buttons to resolveTranscode', () => {
    assert.match(appSrc, /getElementById\('btn-modal-transcode-convert'\)\.addEventListener\('click', \(\) => this\.resolveTranscode\(true\)\)/);
    assert.match(appSrc, /getElementById\('btn-modal-transcode-keep'\)\.addEventListener\('click', \(\) => this\.resolveTranscode\(false\)\)/);
});

test('keyboard guard: modal-transcode owns the keyboard, Escape = keep', () => {
    const kbAt = appSrc.indexOf('bindKeyboardShortcuts() {');
    const guardAt = appSrc.indexOf("getElementById('modal-transcode')", kbAt);
    const activeAt = appSrc.indexOf('const ae = document.activeElement;', kbAt);
    assert.ok(guardAt > kbAt && activeAt > guardAt, 'transcode guard precedes shortcut dispatch');
    const block = appSrc.slice(guardAt, guardAt + 400);
    assert.ok(block.includes("e.key === 'Escape'"));
    assert.ok(block.includes('this.resolveTranscode(false)'));
});

test('applyVideoLoad hooks the offer; a stale offer dies on the next load', () => {
    assert.ok(appSrc.includes('this.maybeOfferTranscode(file, info)'));
    assert.ok(appSrc.includes('if (this._transcodeAskResolve) this.resolveTranscode(false);'));
});

test('generateVideo: blocked-but-convertible export opens the offer, not just an error', () => {
    assert.ok(appSrc.includes('if (await this.askTranscode(this._codecInfo)) await this.runTranscode(this.videoFile);'));
});

test('vendored libraries and licenses are present', () => {
    const vendor = path.join(here, '..', 'app', 'assets', 'vendor');
    for (const [f, min] of [['mp4box.all.min.js', 100_000], ['mp4-muxer.mjs', 40_000]]) {
        const p = path.join(vendor, f);
        assert.ok(existsSync(p), `${f} vendored`);
        assert.ok(statSync(p).size > min, `${f} looks complete`);
    }
    assert.ok(existsSync(path.join(here, '..', 'LICENSES', 'MP4Box.txt')));
    assert.ok(existsSync(path.join(here, '..', 'LICENSES', 'Mp4-Muxer.txt')));
});

test('app.js imports the service (offer + convert available at load)', () => {
    assert.ok(appSrc.includes("from './transcode-service.js'"));
    assert.ok(appSrc.includes('webCodecsAvailable'));
});

// ── save-the-converted-file modal (PR #26 feedback) ─────────────────────

function saveFileHarness({ picker, file = { name: 'clip_h264.mp4', size: 5_000_000 } }) {
    const Status = makeStatus();
    const writes = [];
    const clicks = [];
    const window = picker ? { showSaveFilePicker: picker(writes) } : {};
    const document = { createElement: () => { const a = { click() { clicks.push(a.download); } }; return a; } };
    const URL = { createObjectURL: () => 'blob:x', revokeObjectURL() { } };
    const fn = new Function('Status', 'window', 'document', 'URL',
        `return async function (file) {${extractMethod('saveConvertedFile', 'saveConvertedFile(file) {')}}`);
    return { Status, writes, clicks, run: () => fn(Status, window, document, URL)(file) };
}

test('saveConvertedFile: picker path writes the blob to the chosen handle', async () => {
    let opts = null;
    const h = saveFileHarness({
        picker: (writes) => async (o) => {
            opts = o;
            return { name: 'my-choice.mp4', createWritable: async () => ({ write: (b) => { writes.push(b); }, close: async () => { } }) };
        },
    });
    await h.run();
    assert.equal(opts.suggestedName, 'clip_h264.mp4', 'suggested name is the converted file');
    assert.equal(h.writes.length, 1, 'the converted blob was written');
    assert.ok(h.Status.msgs.some(([k, m]) => k === 'success' && m.includes('my-choice.mp4')));
    assert.equal(h.clicks.length, 0, 'no download fallback once the picker ran');
});

test('saveConvertedFile: picker cancel says so, nothing written', async () => {
    const h = saveFileHarness({
        picker: () => async () => { const e = new Error('cancel'); e.name = 'AbortError'; throw e; },
    });
    await h.run();
    assert.equal(h.writes.length, 0);
    assert.equal(h.clicks.length, 0);
    assert.ok(h.Status.msgs.some(([k, m]) => k === 'msg' && m.includes('Not saved')));
});

test('saveConvertedFile: no picker falls back to a browser download', async () => {
    const h = saveFileHarness({ picker: null });
    await h.run();
    assert.deepEqual(h.clicks, ['clip_h264.mp4'], 'anchor download carries the converted name');
    assert.ok(h.Status.msgs.some(([k, m]) => k === 'success' && m.includes('downloaded')));
});

test('resolveSaveConverted: hides modal, resolves once, double-resolve is a no-op', async () => {
    const ask = new Function('document', `return function (file) {${extractMethod('askSaveConverted', 'askSaveConverted(file) {')}}`);
    const resolve = new Function('document', `return function (save) {${extractMethod('resolveSaveConverted', 'resolveSaveConverted(save) {')}}`);
    const modals = [];
    const document = { getElementById: (id) => ({ id, textContent: '', classList: { add: () => modals.push(['add', id]), remove: () => modals.push(['rm', id]) }, focus() { } }) };
    const stub = {};
    const p = ask(document).call(stub, { name: 'x_h264.mp4', size: 2_000_000 });
    assert.equal(typeof stub._saveConvertedResolve, 'function');
    resolve(document).call(stub, true);
    resolve(document).call(stub, false); // must NOT overwrite the first answer
    assert.equal(await p, true);
    assert.equal(stub._saveConvertedResolve, null);
    assert.ok(modals.some(([op, id]) => op === 'rm' && id === 'modal-save-converted'), 'modal shown (hidden class removed)');
    assert.ok(modals.some(([op, id]) => op === 'add' && id === 'modal-save-converted'), 'modal hidden on resolve');
});

test('runTranscode refusals are never silent', async () => {
    const Status = makeStatus();
    const Progress = { showProgress() { }, update() { }, hide() { } };
    const fn = new Function('Status', 'Progress', 'transcodeToH264', 'File', 'wasmCanDecodeVideo', 'codecLabel',
        `return async function (file) {${extractMethod('runTranscode', 'runTranscode(file) {')}}`);
    const file = { name: 'a.mp4' };
    const busy = { _transcoding: true, _exportRunning: false, _transcribeRunning: false, _transcodeAskResolve: null, videoFile: file };
    await fn(Status, Progress, async () => ({}), File, () => false, (c) => c).call(busy, file);
    assert.ok(Status.msgs.some(([k, m]) => k === 'warning' && m.includes('already running')));
    const stale = { _transcoding: false, _exportRunning: false, _transcribeRunning: false, _transcodeAskResolve: null, videoFile: { name: 'other.mp4' } };
    await fn(Status, Progress, async () => ({}), File, () => false, (c) => c).call(stale, file);
    assert.ok(Status.msgs.some(([k, m]) => k === 'msg' && m.includes('changed')));
});

test('AV1 conversion failure tells the user what to do next', async () => {
    const { Status } = await runTranscodeHarness({
        transcodeImpl: async () => { throw new Error('Could not start the av01 decoder'); },
    });
    assert.ok(Status.msgs.some(([k, m]) => k === 'error' && m.includes('AV1') && m.includes('HandBrake')));
});

// ── save-converted wiring source-guards ──────────────────────────────────

test('index.html carries the save-converted modal with both buttons', () => {
    assert.ok(htmlSrc.includes('id="modal-save-converted"'));
    assert.ok(htmlSrc.includes('id="btn-modal-save-converted-save"'));
    assert.ok(htmlSrc.includes('id="btn-modal-save-converted-dismiss"'));
    assert.ok(htmlSrc.includes('id="modal-save-converted-detail"'));
});

test('bindEvents wires the save-converted buttons; keyboard guard owns it', () => {
    assert.match(appSrc, /getElementById\('btn-modal-save-converted-save'\)\.addEventListener\('click', \(\) => this\.resolveSaveConverted\(true\)\)/);
    assert.match(appSrc, /getElementById\('btn-modal-save-converted-dismiss'\)\.addEventListener\('click', \(\) => this\.resolveSaveConverted\(false\)\)/);
    const kbAt = appSrc.indexOf('bindKeyboardShortcuts() {');
    const guardAt = appSrc.indexOf("getElementById('modal-save-converted')", kbAt);
    const activeAt = appSrc.indexOf('const ae = document.activeElement;', kbAt);
    assert.ok(guardAt > kbAt && activeAt > guardAt, 'save-converted guard precedes shortcut dispatch');
    assert.ok(appSrc.slice(guardAt, guardAt + 400).includes('this.resolveSaveConverted(false)'));
});
