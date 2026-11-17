/**
 * Codec sniffing for imported video files.
 *
 * Answers one question with zero dependencies: "what codec is the video
 * track of this file, and can this app's FFmpeg.wasm engine decode it?"
 * The bundled FFmpeg build decodes H.264 / HEVC / VP8 / VP9 but its native
 * AV1 decoder is broken (verified against ffmpeg 5.1.4 and the newest
 * official @ffmpeg/core 0.12.10 — both fail every AV1 frame with
 * "Missing Sequence Header"), so an AV1 source silently produces a
 * 0-byte export today.
 *
 * Deliberately conservative: any file we cannot confidently parse returns
 * null and the caller must fall back to legacy behavior (no gating).
 *
 * DOM-free by design: imported directly by the unit tests.
 */

// Sample-entry fourcc -> human label, for the MP4 'stsd' table.
const VIDEO_FOURCC_LABEL = {
    avc1: 'H.264', avc3: 'H.264',
    hvc1: 'H.265/HEVC', hev1: 'H.265/HEVC',
    av01: 'AV1', av1: 'AV1',
    vp08: 'VP8', vp09: 'VP9'
};

// Codecs the bundled FFmpeg.wasm core is VERIFIED to decode (probe-tested
// 2026-11: h264 + hevc(8/10-bit) encode end-to-end; av1 fails on every
// frame). Unknown codecs return null so callers never gate on a guess.
const WASM_DECODABLE = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'vp08', 'vp09', 'mp4v']);
const WASM_NOT_DECODABLE = new Set(['av01', 'av1']);

// Generic codec strings for <video>.canPlayType() probing. Values only need
// to be representative of the format; the browser answers based on decoder
// availability, not the exact level.
export const CAN_PLAY_TYPE_CODEC = {
    avc1: 'avc1.640028', avc3: 'avc1.640028',
    hvc1: 'hvc1.1.6.L93.90', hev1: 'hev1.1.6.L93.90',
    av01: 'av01.0.05M.08',
    vp08: 'vp8', vp09: 'vp09.00.10.08'
};

export function codecLabel(fourcc) {
    return VIDEO_FOURCC_LABEL[fourcc] || fourcc || 'unknown';
}

/**
 * @param {string|null} fourcc sample entry fourcc (e.g. 'av01')
 * @returns {boolean|null} true = FFmpeg.wasm decodes it, false = it cannot,
 *   null = unknown codec (caller should NOT gate).
 */
export function wasmCanDecodeVideo(fourcc) {
    if (!fourcc) return null;
    if (WASM_DECODABLE.has(fourcc)) return true;
    if (WASM_NOT_DECODABLE.has(fourcc)) return false;
    return null;
}

function readU32(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function fourcc(b, o) {
    return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

/**
 * Walk the children of an MP4 container box inside one buffer.
 * cb(name, contentStart, contentEnd) — content excludes the 8/16-byte
 * header. Returns true when the walk stayed inside [start,end); false on a
 * malformed or truncated box (caller treats the window as inconclusive).
 */
function walkBoxes(buf, start, end, cb) {
    let o = start;
    while (o + 8 <= end) {
        let size = readU32(buf, o);
        const name = fourcc(buf, o + 4);
        let body = o + 8;
        if (size === 1) {
            // 64-bit largesize; sizes above 2^32 cannot fit any read window.
            if (o + 16 > end) return false;
            const hi = readU32(buf, o + 8);
            const lo = readU32(buf, o + 12);
            if (hi !== 0) return false;
            size = lo;
            body = o + 16;
        } else if (size === 0) {
            size = end - o; // box runs to end of stream
        }
        if (size < 8) return false; // malformed
        const boxEnd = o + size;
        if (boxEnd > end) return false; // truncated by read window
        if (cb(name, body, boxEnd) === false) return true;
        o = boxEnd;
    }
    return o >= end;
}

/** First sample-entry format of an stsd box ('avc1', 'av01', ...). */
function firstEntryFormat(buf, start, end) {
    if (start + 8 > end) return null;
    const entryCount = readU32(buf, start + 4);
    let o = start + 8;
    for (let i = 0; i < entryCount && o + 8 <= end; i++) {
        const size = readU32(buf, o);
        if (size < 8) return null;
        if (i === 0) return fourcc(buf, o + 4);
        o += size;
    }
    return null;
}

function parseTrak(buf, start, end) {
    let handler = null, format = null, ok = true;
    // trak -> mdia -> (hdlr | minf -> stbl -> stsd)
    ok = walkBoxes(buf, start, end, (name, body, boxEnd) => {
        if (name !== 'mdia') return true;
        ok = walkBoxes(buf, body, boxEnd, (n2, b2, e2) => {
            if (n2 === 'hdlr') {
                // version+flags(4) pre_defined(4) handler_type(4)
                if (b2 + 12 <= e2) handler = fourcc(buf, b2 + 8);
                return true;
            }
            if (n2 !== 'minf') return true;
            ok = walkBoxes(buf, b2, e2, (n3, b3, e3) => {
                if (n3 !== 'stbl') return true;
                ok = walkBoxes(buf, b3, e3, (n4, b4, e4) => {
                    if (n4 === 'stsd') { format = firstEntryFormat(buf, b4, e4); return false; }
                    return true;
                });
                return false;
            });
            return false;
        });
        return false;
    });
    if (!ok || !handler || !format) return {};
    if (handler === 'vide') return { video: format };
    if (handler === 'soun') return { audio: format };
    return {};
}

function parseMoov(buf, start, end) {
    let videoCodec = null, audioCodec = null, ok = true;
    ok = walkBoxes(buf, start, end, (name, body, boxEnd) => {
        if (name !== 'trak') return true;
        const t = parseTrak(buf, body, boxEnd);
        if (t.video && !videoCodec) videoCodec = t.video;
        if (t.audio && !audioCodec) audioCodec = t.audio;
        return true;
    });
    if (!ok) return null;
    if (!videoCodec && !audioCodec) return null;
    return { videoCodec, audioCodec };
}

/**
 * Extract track codec info from an MP4 byte window that CONTAINS the moov
 * box (either the head or the tail of the file). Handles moov at start
 * (faststart) and moov at end (HandBrake's default layout).
 *
 * @param {Uint8Array} buf file slice
 * @param {boolean} isTailSlice true when buf is the END of the file (a moov
 *   with size 0 "runs to end" only resolves against the real file end)
 * @returns {{videoCodec: string|null, audioCodec: string|null}|null}
 *   null when no complete moov is present in the window (unknown).
 */
export function parseMp4Codecs(buf, isTailSlice = false) {
    if (!buf || buf.length < 16) return null;
    if (isTailSlice) {
        // Box boundaries before this slice are unknown — locate 'moov' by
        // fourcc scan and accept it only when its size resolves exactly on
        // the slice end (moov is the last box in non-faststart files).
        for (let i = buf.length - 8; i > 3; i--) {
            if (fourcc(buf, i) !== 'moov') continue;
            const headerStart = i - 4;
            let size = readU32(buf, headerStart);
            let body = i + 4;
            if (size === 1) {
                const hi = readU32(buf, headerStart + 8);
                const lo = readU32(buf, headerStart + 12);
                if (hi !== 0) continue;
                size = lo;
                body = headerStart + 16;
            } else if (size === 0) {
                size = buf.length - headerStart;
            }
            if (size < 8 || headerStart + size !== buf.length) continue;
            const parsed = parseMoov(buf, body, headerStart + size);
            if (parsed) return parsed;
        }
        return null;
    }
    let result = null;
    walkBoxes(buf, 0, buf.length, (name, body, boxEnd) => {
        if (name === 'moov') { result = parseMoov(buf, body, boxEnd); return false; }
        return true;
    });
    return result;
}

/**
 * Matroska/WebM codec sniff: codec IDs are plain ASCII strings stored in
 * the CodecID element. Scanning the raw bytes for the known IDs is
 * sufficient here and avoids an EBML parser.
 */
const WEBM_IDS = {
    'V_MPEG4/ISO/AVC': 'avc1',
    'V_MPEGH/ISO/HEVC': 'hvc1',
    'V_AV1': 'av01',
    'V_VP8': 'vp08',
    'V_VP9': 'vp09'
};
export function sniffWebmVideoCodec(buf) {
    if (!buf || buf.length < 16) return null;
    // Only trust buffers that actually start with the EBML magic.
    if (!(buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3)) return null;
    const text = new TextDecoder('latin1').decode(buf.subarray(0, Math.min(buf.length, 262144)));
    for (const [id, name] of Object.entries(WEBM_IDS)) {
        if (text.includes(id)) return name;
    }
    return null;
}

/**
 * File-level detection used by the app: feed the head and (when needed)
 * tail slices of the file. Pure w.r.t. I/O — the caller reads the slices.
 *
 * @param {{head: Uint8Array, tail: Uint8Array|null}} slices
 * @param {string} fileName used only to prefer the webm sniff for .webm
 * @returns {{container:'mp4'|'webm', videoCodec:string|null, audioCodec:string|null}|null}
 */
export function detectFromSlices(slices, fileName = '') {
    const lower = (fileName || '').toLowerCase();
    if (lower.endsWith('.webm') || lower.endsWith('.mkv')) {
        const v = sniffWebmVideoCodec(slices.head);
        return v ? { container: 'webm', videoCodec: v, audioCodec: null } : null;
    }
    // MP4 family: moov is usually in the first MB (faststart) or flush at
    // the file end (HandBrake default). Try head first, then tail.
    let info = parseMp4Codecs(slices.head, false);
    if (!info && slices.tail) info = parseMp4Codecs(slices.tail, true);
    if (!info) return null;
    return { container: 'mp4', videoCodec: info.videoCodec, audioCodec: info.audioCodec };
}
