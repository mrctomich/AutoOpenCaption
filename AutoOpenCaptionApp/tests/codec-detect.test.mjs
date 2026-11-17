/**
 * Codec sniffing (app/assets/codec-detect.js) + the honest-failure wiring.
 *
 * Three layers, per repo convention:
 *   1. the REAL pure module imported directly (box parser + tables —
 *      DOM-free by design, fixtures are synthetic MP4/WebM bytes);
 *   2. the REAL extracted App.exportCodecGate / App.reportCodec /
 *      App.detectSourceCodec run against a stub `this` (recording fakes);
 *   3. regex source-guards on the wiring in app.js / wrapper.js /
 *      ffmpeg-service.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    parseMp4Codecs, sniffWebmVideoCodec, detectFromSlices,
    wasmCanDecodeVideo, codecLabel, CAN_PLAY_TYPE_CODEC
} from '../app/assets/codec-detect.js';

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', 'app', 'assets', 'app.js'), 'utf8')
    .replace(/\r\n/g, '\n');
const wrapperSrc = readFileSync(join(here, '..', 'app', 'ffmpeg', 'wrapper.js'), 'utf8')
    .replace(/\r\n/g, '\n');
const serviceSrc = readFileSync(join(here, '..', 'app', 'assets', 'ffmpeg-service.js'), 'utf8')
    .replace(/\r\n/g, '\n');

// ── synthetic MP4 builders ─────────────────────────────────────

function box(name, ...bodies) {
    const body = concatBytes(bodies);
    const out = new Uint8Array(8 + body.length);
    writeU32(out, 0, 8 + body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
    out.set(body, 8);
    return out;
}
function box64(name, ...bodies) {
    const body = concatBytes(bodies);
    const out = new Uint8Array(16 + body.length);
    writeU32(out, 0, 1); // largesize follows
    for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
    writeU32(out, 8, 0);
    writeU32(out, 12, 16 + body.length);
    out.set(body, 16);
    return out;
}
function writeU32(b, o, v) {
    b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255;
    b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255;
}
function concatBytes(list) {
    const total = list.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const b of list) { out.set(b, o); o += b.length; }
    return out;
}
const zeros = (n) => new Uint8Array(n);
const str4 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

// stsd: version+flags(4) entry_count(4) entry[size(4) format(4) padding...]
function stsd(format) {
    const entry = box(format, zeros(70));
    return box('stsd', concatBytes([zeros(4), Uint8Array.of(0, 0, 0, 1), entry]));
}
function hdlr(handler) {
    return box('hdlr', concatBytes([zeros(8), str4(handler), zeros(20)]));
}
function trak(handler, format) {
    return box('trak', box('mdia', hdlr(handler), box('minf', box('stbl', stsd(format)))));
}
function moovBody(videoFormat, audioFormat = 'mp4a') {
    return concatBytes([trak('vide', videoFormat), trak('soun', audioFormat)]);
}
function moov(videoFormat, audioFormat = 'mp4a') {
    return box('moov', moovBody(videoFormat, audioFormat));
}
const ftyp = box('ftyp', str4('isom'), zeros(4));
const mdat = (n) => box('mdat', zeros(n));

test('parseMp4Codecs: faststart layout (moov in head slice)', () => {
    const buf = concatBytes([ftyp, moov('avc1'), mdat(64)]);
    assert.deepEqual(parseMp4Codecs(buf), { videoCodec: 'avc1', audioCodec: 'mp4a' });
});

test('parseMp4Codecs: moov-at-end found via tail slice (HandBrake layout)', () => {
    const full = concatBytes([ftyp, mdat(200), moov('hvc1')]);
    // head slice has no complete moov; tail slice ends exactly at moov end
    assert.equal(parseMp4Codecs(full.subarray(0, 40)), null);
    const tail = full.subarray(40);
    assert.deepEqual(parseMp4Codecs(tail, true), { videoCodec: 'hvc1', audioCodec: 'mp4a' });
});

test('parseMp4Codecs: AV1 detected and 64-bit moov size handled', () => {
    const buf = concatBytes([ftyp, box64('moov', moovBody('av01'))]);
    const parsed = parseMp4Codecs(buf);
    assert.equal(parsed && parsed.videoCodec, 'av01');
    assert.equal(parsed.audioCodec, 'mp4a');
});

test('parseMp4Codecs: truncated moov returns null (never guess)', () => {
    const buf = concatBytes([ftyp, moov('av01')]);
    assert.equal(parseMp4Codecs(buf.subarray(0, buf.length - 30)), null);
});

test('parseMp4Codecs: garbage / non-mp4 buffers return null', () => {
    assert.equal(parseMp4Codecs(zeros(64)), null);
    assert.equal(parseMp4Codecs(null), null);
    assert.equal(parseMp4Codecs(zeros(8)), null);
});

test('sniffWebmVideoCodec: EBML magic required, then CodecID scan', () => {
    const ebml = concatBytes([Uint8Array.of(0x1A, 0x45, 0xDF, 0xA3), zeros(16), str4('V_AV1'), zeros(8)]);
    assert.equal(sniffWebmVideoCodec(ebml), 'av01');
    const vp9 = concatBytes([Uint8Array.of(0x1A, 0x45, 0xDF, 0xA3), zeros(16), str4('V_VP9')]);
    assert.equal(sniffWebmVideoCodec(vp9), 'vp09');
    // same strings without the EBML magic must NOT trigger
    assert.equal(sniffWebmVideoCodec(concatBytes([zeros(4), str4('V_AV1')])), null);
});

test('detectFromSlices: prefers webm sniff for .webm names, mp4 parse otherwise', () => {
    const mp4buf = concatBytes([ftyp, moov('hvc1')]);
    assert.deepEqual(
        detectFromSlices({ head: mp4buf, tail: null }, 'clip.mp4'),
        { container: 'mp4', videoCodec: 'hvc1', audioCodec: 'mp4a' });
    const webm = concatBytes([Uint8Array.of(0x1A, 0x45, 0xDF, 0xA3), str4('V_MPEGH/ISO/HEVC')]);
    assert.deepEqual(
        detectFromSlices({ head: webm, tail: null }, 'clip.webm'),
        { container: 'webm', videoCodec: 'hvc1', audioCodec: null });
    // unparsable container -> null (legacy behavior, no gating)
    assert.equal(detectFromSlices({ head: zeros(64), tail: null }, 'clip.mp4'), null);
});

test('wasmCanDecodeVideo + codecLabel tables', () => {
    assert.equal(wasmCanDecodeVideo('avc1'), true);
    assert.equal(wasmCanDecodeVideo('hvc1'), true);
    assert.equal(wasmCanDecodeVideo('hev1'), true);
    assert.equal(wasmCanDecodeVideo('vp09'), true);
    assert.equal(wasmCanDecodeVideo('av01'), false);
    assert.equal(wasmCanDecodeVideo('av1'), false);
    assert.equal(wasmCanDecodeVideo('dvhe'), null); // unknown -> never gate
    assert.equal(wasmCanDecodeVideo(null), null);
    assert.equal(codecLabel('av01'), 'AV1');
    assert.equal(codecLabel('hvc1'), 'H.265/HEVC');
    assert.equal(codecLabel('dvhe'), 'dvhe');
    for (const k of ['avc1', 'hvc1', 'av01', 'vp09']) {
        assert.ok(CAN_PLAY_TYPE_CODEC[k], `canPlayType codec string for ${k}`);
    }
});

// ── layer 2: the REAL App methods against a stub `this` ────────

function extractMethod(name, signature = null) {
    const sig = signature || `${name}() {`;
    const start = appSrc.indexOf(sig);
    assert.ok(start >= 0, `method ${name} found`);
    const bodyStart = appSrc.indexOf('{', start + sig.length - 1);
    const end = appSrc.indexOf('\n    },', bodyStart);
    assert.ok(end > bodyStart, `${name} body terminator found`);
    return appSrc.slice(bodyStart + 1, end);
}

function runExportGate(codecInfo, extra = {}) {
    const fn = new Function('codecLabel', 'wasmCanDecodeVideo',
        `return function () {${extractMethod('exportCodecGate')}}`);
    const mod = { codecLabel, wasmCanDecodeVideo };
    const stub = Object.assign({ _codecInfo: codecInfo }, extra);
    return fn(mod.codecLabel, mod.wasmCanDecodeVideo).call(stub);
}

test('exportCodecGate: refuses AV1 with an actionable message', () => {
    const msg = runExportGate({ container: 'mp4', videoCodec: 'av01', audioCodec: 'mp4a' });
    assert.ok(msg && msg.includes('AV1'), 'names the codec');
    assert.ok(msg.includes('H.264'), 'names the workaround');
});

test('exportCodecGate: supported AND unknown codecs are never gated', () => {
    assert.equal(runExportGate({ videoCodec: 'hvc1' }), null);
    assert.equal(runExportGate({ videoCodec: 'avc1' }), null);
    assert.equal(runExportGate({ videoCodec: 'dvhe' }), null);
    assert.equal(runExportGate(null), null);
    assert.equal(runExportGate({}), null);
});

function runReportCodec(codecInfo, canPlayResult, wasmAnswer) {
    const status = { msgs: [] };
    const Status = {
        error: (m) => status.msgs.push(['error', m]),
        warning: (m) => status.msgs.push(['warning', m])
    };
    const fn = new Function('Status', 'codecLabel', 'wasmCanDecodeVideo', 'CAN_PLAY_TYPE_CODEC',
        `return function (info) {${extractMethod('reportCodec', 'reportCodec(info) {')}}`);
    const stub = {
        _codecInfo: codecInfo,
        video: { canPlayType: () => canPlayResult }
    };
    fn(Status, codecLabel, () => wasmAnswer, CAN_PLAY_TYPE_CODEC).call(stub, codecInfo);
    return status.msgs;
}

test('reportCodec: HEVC without browser decoder warns black-preview, not export', () => {
    const msgs = runReportCodec({ videoCodec: 'hvc1' }, '', true);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0][0], 'warning');
    assert.ok(msgs[0][1].includes('black'));
    assert.ok(!msgs[0][1].toLowerCase().includes('not possible'));
});

test('reportCodec: AV1 errors on export impossibility', () => {
    const msgs = runReportCodec({ videoCodec: 'av01' }, 'probably', false);
    assert.ok(msgs.some(([t, m]) => t === 'error' && m.includes('AV1')));
    assert.ok(msgs.some(([, m]) => m.includes('export is not possible')));
});

test('reportCodec: fully-playable H.264 stays silent', () => {
    assert.equal(runReportCodec({ videoCodec: 'avc1' }, 'probably', true).length, 0);
});

test('detectSourceCodec: reads head + tail slices through File.slice', async () => {
    const mp4buf = concatBytes([ftyp, moov('hvc1'), mdat(4096), moov('hvc1')]);
    const file = {
        name: 'clip.mp4',
        size: mp4buf.length,
        slice(from, to) {
            return { arrayBuffer: async () => mp4buf.slice(from, to === undefined ? mp4buf.length : to).buffer };
        }
    };
    const fn = new Function('detectFromSlices',
        `return async function (file) {${extractMethod('detectSourceCodec', 'detectSourceCodec(file) {')}}`);
    const info = await fn(detectFromSlices)(file);
    assert.equal(info.videoCodec, 'hvc1');
});

// ── layer 3: wiring source-guards ──────────────────────────────

function sliceMethod(name) {
    let start = appSrc.indexOf(`    ${name}(`);
    if (start < 0) start = appSrc.indexOf(`    async ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    const end = appSrc.indexOf('\n    },', start);
    return appSrc.slice(start, end);
}

test('applyVideoLoad starts the codec probe and caches its result', () => {
    const s = sliceMethod('applyVideoLoad');
    assert.ok(s.includes('this._codecProbe = this.detectSourceCodec(file)'), 'probe kicked off');
    assert.ok(s.includes('this._codecInfo = info'), 'result cached');
    assert.ok(s.includes('this.reportCodec(info)'), 'reported');
    assert.ok(s.includes('if (this.videoFile !== file) return;'), 'drop-race guard');
});

test('generateVideo gates BEFORE the save-file picker and rejects empty output', () => {
    const s = sliceMethod('generateVideo');
    const gateAt = s.indexOf('this.exportCodecGate()');
    const pickerAt = s.indexOf('showSaveFilePicker');
    assert.ok(gateAt >= 0, 'gate called');
    assert.ok(pickerAt >= 0);
    assert.ok(gateAt < pickerAt, 'gate runs before the picker (no 0-byte leftovers)');
    assert.ok(s.includes('await this._codecProbe;'), 'awaits in-flight probe');
    assert.ok(s.includes('outputData.byteLength === 0'), 'empty-output guard');
    assert.ok(s.includes('FFmpegService.lastErrorSummary()'), 'ffmpeg log tail in the error');
});

test('encodeVideo clears logs before execs and surfaces the ffmpeg error tail', () => {
    const s = sliceMethod('encodeVideo');
    assert.ok(s.includes('FFmpegService.clearLogs();'), 'clears logs');
    assert.ok(s.includes('lastErrorSummary'), 'error tail surfaced on non-zero exit');
    const clearAt = s.indexOf('FFmpegService.clearLogs();');
    const execAt = s.indexOf('FFmpegService.exec(');
    assert.ok(clearAt < execAt, 'cleared before the first exec');
});

test('extractAudio checks the WAV exec exit code', () => {
    const s = sliceMethod('extractAudio');
    assert.ok(s.includes('wavRet !== 0'), 'exit code checked');
    assert.ok(s.includes('lastErrorSummary'), 'error tail surfaced');
});

test('wrapper keeps a log ring and rejects pending work when the worker dies', () => {
    assert.ok(wrapperSrc.includes('#logs'), 'ring buffer exists');
    assert.ok(wrapperSrc.includes('#failAllPending'), 'pending-rejection helper');
    assert.ok(wrapperSrc.includes('this.#worker.onerror'), 'worker onerror wired');
    // the LOG branch must now record, not discard
    assert.ok(!wrapperSrc.includes("return; // ffmpeg log lines"), 'old swallow removed');
    const logBranch = wrapperSrc.slice(wrapperSrc.indexOf("if (type === 'LOG')"));
    assert.ok(logBranch.slice(0, 600).includes('this.#logs.push'), 'LOG lines captured');
});

test('ffmpeg-service exposes log access to the app layer', () => {
    assert.ok(serviceSrc.includes('clearLogs()'));
    assert.ok(serviceSrc.includes('lastErrorSummary('));
    assert.ok(serviceSrc.includes('wrapper.getLogs()'));
});
