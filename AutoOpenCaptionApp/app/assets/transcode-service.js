/**
 * transcode-service.js — in-browser conversion of "hard" source codecs
 * (HEVC / AV1 / VP9) into plain H.264 + AAC MP4 using WebCodecs.
 *
 * WHY: the bundled FFmpeg.wasm engine can decode H.264/HEVC/VP9 but not
 * AV1, and HEVC runs at a fraction of realtime in pure wasm. Chrome's
 * WebCodecs API exposes the machine's hardware decoders (HEVC, AV1, VP9,
 * AAC) and a hardware H.264 encoder. Converting ONCE at import means the
 * entire downstream pipeline (preview, whisper audio extraction, overlay
 * encode, export) keeps running on the boring, proven H.264 path — no
 * other part of the app learns that the original file was exotic.
 *
 * HOW: MP4Box demuxes the container and hands raw encoded samples to a
 * VideoDecoder/AudioDecoder; frames stream straight into a VideoEncoder
 * (H.264) / AudioEncoder (AAC); mp4-muxer writes the new MP4. Queues are
 * bounded and the pipeline is backpressured sample by sample, so peak
 * memory stays flat regardless of source length.
 *
 * This module never touches the DOM beyond lazy vendor loading and is
 * only imported after codec-detect has decided the source actually needs
 * conversion, so the normal H.264 workflow never loads a byte of it.
 */

/** Sources bigger than this are refused with an honest message. */
export const MAX_TRANSCODE_BYTES = 1.5 * 1024 * 1024 * 1024;

/** Chunk size used when streaming the source file into MP4Box. */
const READ_CHUNK = 16 * 1024 * 1024;

/** Queue bounds so memory stays flat on long sources. */
const MAX_DECODE_QUEUE = 24;
const MAX_AUDIO_DECODE_QUEUE = 300;

/** Error thrown when the user hits Cancel; callers check `isCancelled`. */
export class TranscodeCancelled extends Error {
    constructor() { super('Conversion cancelled.'); this.isCancelled = true; }
}

/** True when this browser plausibly supports the whole pipeline. */
export function webCodecsAvailable() {
    return typeof window !== 'undefined'
        && typeof window.VideoDecoder !== 'undefined'
        && typeof window.VideoEncoder !== 'undefined'
        && typeof window.AudioDecoder !== 'undefined'
        && typeof window.AudioEncoder !== 'undefined'
        && typeof window.EncodedVideoChunk !== 'undefined';
}

// ── pure helpers (unit-tested without a browser) ─────────────────────────

/**
 * Target H.264 bitrate from the source bitrate: ~1.25x so quality is
 * essentially preserved (x264 needs a little more than x265/AV1 per bit),
 * clamped into a sane band. Without source info fall back to a
 * resolution-based heuristic.
 */
export function pickOutputBitrate(srcBitrate, width, height, fps) {
    const pixels = Math.max(1, (width || 0) * (height || 0));
    const f = fps && fps > 0 && fps < 240 ? fps : 30;
    const floorBps = Math.max(800_000, pixels * f * 0.04);
    const ceilBps = Math.min(48_000_000, pixels * f * 0.30);
    if (Number.isFinite(srcBitrate) && srcBitrate > 50_000) {
        return Math.round(Math.min(ceilBps, Math.max(floorBps, srcBitrate * 1.25)));
    }
    return Math.round(Math.min(ceilBps, Math.max(floorBps, pixels * f * 0.10)));
}

/**
 * AVC level hex for the encoder codec string from the coded size.
 * Level 4.0 (0x28) covers 1080p30, level 5.1 (0x33) covers 4K30.
 */
export function chooseAvcLevel(width, height, fps) {
    const pixels = Math.max(1, (width || 0) * (height || 0));
    const f = fps && fps > 0 && fps < 240 ? fps : 30;
    if (pixels * f <= 2_450_000 * 30) return '640028'; // level 4.0
    return '640033'; // level 5.1 — up to 4K
}

/**
 * tkhd matrix is 9 numbers, the first six in 16.16 fixed point (last row
 * is raw). Rotation is atan2(b, a) in degrees snapped to the nearest 90°;
 * anything not near a multiple of 90 reports 0 — WebCodecs frames only
 * rotate in 90° steps, and skew cannot be represented anyway.
 */
export function rotationFromMatrix(m) {
    if (!Array.isArray(m) || m.length < 9) return 0;
    const a = m[0] / 65536, b = m[1] / 65536;
    if (!Number.isFinite(a) || !Number.isFinite(b) || (a === 0 && b === 0)) return 0;
    const deg = Math.atan2(b, a) * (180 / Math.PI);
    const snapped = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
    return Math.abs(deg - Math.round(deg / 90) * 90) <= 2 ? snapped : 0;
}

/**
 * Pull the AudioSpecificConfig bytes out of an esds box body (the only
 * thing Chrome's AAC AudioDecoder accepts as description). Returns null
 * when the descriptor layout is unexpected; the caller may then try a
 * description-less config.
 */
export function audioSpecificConfigFromEsds(esds) {
    if (!esds || esds.length < 12) return null;
    let i = 4; // skip version + flags
    const readLen = () => { // 1..4 expanding descriptor bytes
        let len = 0, n = 0, b;
        do { b = esds[i++]; len = (len << 7) | (b & 0x7f); } while (b & 0x80 && ++n < 4);
        return len;
    };
    if (esds[i++] !== 0x03) return null; readLen();
    i += 2; // ES_ID
    const flags = esds[i++];
    if (flags & 0x80) i += 2; // OCR
    if (flags & 0x40) i += 4; // stream priority
    if (flags & 0x20) i += 4; // URI
    if (i >= esds.length || esds[i++] !== 0x04) return null; readLen();
    i += 13; // objectType, streamType, buffers, max/avg bitrate
    if (i >= esds.length || esds[i++] !== 0x05) return null;
    const len = readLen();
    if (i + len > esds.length || len === 0) return null;
    return esds.subarray(i, i + len);
}

/** mp4 sample-entry box holding the decoder description per codec family. */
export function descriptionBoxName(codecString) {
    const fourcc = String(codecString || '').slice(0, 4);
    if (fourcc === 'avc1' || fourcc === 'avc3') return 'avcC';
    if (fourcc === 'hvc1' || fourcc === 'hev1') return 'hvcC';
    if (fourcc === 'av01') return 'av1C';
    if (fourcc === 'vp08' || fourcc === 'vp09') return 'vpcC';
    if (fourcc === 'mp4a') return 'esds';
    return null;
}

// ── lazy vendor loading ──────────────────────────────────────────────────

let mp4boxPromise = null;
function loadMp4Box() {
    if (!mp4boxPromise) {
        mp4boxPromise = new Promise((resolve, reject) => {
            if (window.MP4Box) return resolve(window.MP4Box);
            const s = document.createElement('script');
            // Anchor to THIS module's URL: a classic <script> src would
            // otherwise resolve against the page, not the assets/ dir.
            s.src = new URL('./vendor/mp4box.all.min.js', import.meta.url).href;
            s.onload = () => (window.MP4Box
                ? resolve(window.MP4Box)
                : reject(new Error('MP4Box failed to initialise.')));
            s.onerror = () => reject(new Error('Could not load the MP4 demuxer (vendor/mp4box.all.min.js missing?).'));
            document.head.appendChild(s);
        });
    }
    return mp4boxPromise;
}

let muxerPromise = null;
function loadMuxer() {
    if (!muxerPromise) muxerPromise = import('./vendor/mp4-muxer.mjs');
    return muxerPromise;
}

// ── the pipeline ─────────────────────────────────────────────────────────

/**
 * Convert `file` (an MP4 whose video+audio codecs the browser can decode)
 * into an H.264 + AAC MP4 Blob.
 *
 * @param {File} file source video
 * @param {object} opts
 *   onProgress(fraction01, detailText) — coarse progress feedback
 *   control {{ cancelled: boolean }}   — flipped by the caller to abort
 * @returns {Promise<Blob>} converted video/mp4 blob
 */
export async function transcodeToH264(file, { onProgress = () => {}, control = { cancelled: false } } = {}) {
    if (!webCodecsAvailable()) throw new Error('This browser does not support in-browser video conversion (WebCodecs). Try an up-to-date Chrome or Edge.');
    if (file.size > MAX_TRANSCODE_BYTES) {
        throw new Error(`Source is ${(file.size / 1e9).toFixed(1)} GB — in-app conversion is limited to ${Math.round(MAX_TRANSCODE_BYTES / 1e9)} GB. Convert with HandBrake instead.`);
    }
    const check = () => { if (control.cancelled) throw new TranscodeCancelled(); };
    const [MP4Box, { Muxer, ArrayBufferTarget }] = await Promise.all([loadMp4Box(), loadMuxer()]);

    // ---- wake machinery (no lost wakeups: every wait re-checks a seq) ----
    let wakeSeq = 0, samplesWake = null;
    const wake = () => { wakeSeq++; if (samplesWake) { const w = samplesWake; samplesWake = null; w(); } };
    const sleepUntilWake = async (sinceSeq) => {
        if (wakeSeq !== sinceSeq) return;
        await new Promise((r) => { samplesWake = r; });
    };

    // ---- demux plumbing ----------------------------------------------------
    const mp4 = MP4Box.createFile();
    let info = null, moovError = null;
    const readyP = new Promise((res, rej) => {
        mp4.onReady = (i) => { info = i; res(); };
        mp4.onError = (e) => { moovError = new Error(`Could not read this MP4 (${e}).`); rej(moovError); };
    });
    readyP.catch(() => {}); // handled at the await sites

    // mp4box 0.5.x hands samples with a ready `data` view; 2.x exposes
    // buffer/offset/size instead. Support both.
    const sampleBytes = (s) => (s.data ? s.data : new Uint8Array(s.buffer, s.offset, s.size));

    const queues = { v: [], a: [] };
    mp4.onSamples = (id, user, samples) => { queues[user].push(...samples); wake(); };

    // Stream the file in until the moov is parsed (first chunk when
    // faststart; for moov-at-end files like HandBrake's default, the
    // whole file — MP4Box has to see the last box first).
    let pos = 0;
    while (pos < file.size) {
        check();
        // MP4Box wants a raw ArrayBuffer carrying a fileStart property.
        const buf = await file.slice(pos, pos + READ_CHUNK).arrayBuffer();
        buf.fileStart = pos;
        pos += buf.byteLength;
        mp4.appendBuffer(buf);
        if (info || moovError) break;
    }
    if (!info && !moovError) { mp4.flush(); await readyP; }
    if (!info) throw moovError || new Error('Could not read this MP4 (no moov box found).');

    const vTrack = info.videoTracks && info.videoTracks[0];
    if (!vTrack) throw new Error('This file has no video track.');
    const aTrack = info.audioTracks && info.audioTracks[0];

    const getSampleEntry = (track) => {
        const trak = mp4.getTrackById(track.id);
        return trak.mdia.minf.stbl.stsd.entries[0];
    };

    const getBoxBytes = (track, boxName) => {
        const trak = mp4.getTrackById(track.id);
        for (const entry of trak.mdia.minf.stbl.stsd.entries) {
            const box = boxName && entry[boxName];
            if (box) {
                // Box → its wire bytes minus the 8-byte header, which is
                // exactly what a WebCodecs description wants. Pre-sized
                // buffer; trim to what write() actually advanced over.
                const stream = new window.DataStream(new ArrayBuffer(1 << 20), 0, window.DataStream.BIG_ENDIAN);
                box.write(stream);
                const len = stream.getPosition();
                if (len <= 8) return undefined;
                return new Uint8Array(stream.buffer, 8, len - 8);
            }
        }
        return undefined;
    };

    // ---- decoder configs ----------------------------------------------------
    const fps = vTrack.nb_samples && vTrack.duration && vTrack.timescale
        ? (vTrack.nb_samples * vTrack.timescale) / vTrack.duration
        : 0;
    const vConfig = { codec: vTrack.codec, description: getBoxBytes(vTrack, descriptionBoxName(vTrack.codec)) };
    let aConfig = null;
    if (aTrack) {
        // Samplerate/channelcount come from the sample entry: mp4box's
        // summary info may leave them undefined, and WebCodecs requires
        // both for AAC. (stsd samplerate is the 16.16 float part.)
        const aEntry = getSampleEntry(aTrack) || {};
        const rawRate = aEntry.samplerate || aTrack.samplerate;
        const sampleRate = rawRate ? Math.floor(rawRate > 0xFFFF ? rawRate >> 16 : rawRate) : undefined;
        const rawDesc = getBoxBytes(aTrack, descriptionBoxName(aTrack.codec));
        // AAC wants the bare AudioSpecificConfig, not the whole esds box.
        const aDesc = String(aTrack.codec).slice(0, 4) === 'mp4a'
            ? (audioSpecificConfigFromEsds(rawDesc) || undefined)
            : rawDesc;
        aConfig = {
            codec: aTrack.codec,
            description: aDesc,
            sampleRate: sampleRate || 48000,
            numberOfChannels: aEntry.channel_count || aEntry.channelcount || aTrack.channelcount || 2,
        };
        const aSupport = await window.AudioDecoder.isConfigSupported(aConfig);
        // NOTE: WebCodecs resolves { supported } — NOT { isSupported }.
        if (aSupport && aSupport.supported === false) {
            throw new Error(`Your browser cannot decode the audio in this file (${aTrack.codec}), and captions need that audio — convert with HandBrake instead.`);
        }
        // AAC re-encode must be available too — the converted file needs
        // it and captions need the audio; there is no middle ground.
        const aEncSupport = await window.AudioEncoder.isConfigSupported({
            codec: 'mp4a.40.2',
            sampleRate: aConfig.sampleRate || 48000,
            numberOfChannels: aConfig.numberOfChannels || 2,
        });
        if (aEncSupport && aEncSupport.supported === false) {
            throw new Error('Your browser cannot encode AAC audio, which the converted file needs. Update Chrome/Edge, or convert with HandBrake.');
        }
    }
    // No pre-flight blocking on VideoDecoder.isConfigSupported: it
    // resolves { supported } (NOT { isSupported }) and has been observed
    // to answer false where real decoding works. A decoder that truly
    // cannot open fails at configure() below and is reported honestly.

    // Rotation lives in the tkhd matrix, not the sample data.
    const tkhd = mp4.getTrackById(vTrack.id).tkhd;
    const rotation = tkhd ? rotationFromMatrix(tkhd.matrix) : 0;

    // ---- muxer. mp4-muxer wants both tracks declared at construction:
    //      coded dimensions (swapped for 90/270 rotation — we rotate every
    //      frame so the encoded stream is upright) and the audio format
    //      from the stsd entry. ------------------------------------------------
    const codedW = vTrack.video && vTrack.video.width ? vTrack.video.width & ~1 : (vTrack.track_width || 0);
    const codedH = vTrack.video && vTrack.video.height ? vTrack.video.height & ~1 : (vTrack.track_height || 0);
    if (!codedW || !codedH) throw new Error('Could not determine the video dimensions of this file.');
    const trackW = (rotation === 90 || rotation === 270) ? codedH : codedW;
    const trackH = (rotation === 90 || rotation === 270) ? codedW : codedH;
    const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        fastStart: 'in-memory',
        firstTimestampBehavior: 'offset',
        video: { codec: 'avc', width: trackW, height: trackH, frameRate: Math.round(fps) || undefined },
        audio: aTrack ? { codec: 'aac', sampleRate: aConfig.sampleRate, numberOfChannels: aConfig.numberOfChannels } : undefined,
    });

    const syncFlags = new Map(); // presentation ts (µs) -> is_sync
    let encoder = null, encodeError = null, encodedFrames = 0;
    const totalSamples = vTrack.nb_samples || 0;
    let firstFrame = true;

    const configureEncoder = (frame) => {
        const w = frame.displayWidth & ~1, h = frame.displayHeight & ~1; // even dims
        const bitrate = pickOutputBitrate(vTrack.bitrate, w, h, fps);
        encoder = new window.VideoEncoder({
            output: (chunk, meta) => { encodedFrames++; muxer.addVideoChunk(chunk, meta); wake(); },
            error: (e) => { encodeError = e; wake(); },
        });
        encoder.configure({
            codec: `avc1.${chooseAvcLevel(w, h, fps)}`,
            width: w, height: h, bitrate,
            framerate: Math.round(fps) || 30,
            hardwareAcceleration: 'prefer-hardware',
        });
    };

    let decodeError = null;
    const decoder = new window.VideoDecoder({
        output: (frame) => {
            if (encodeError || decodeError) { frame.close(); return; }
            if (!encoder) configureEncoder(frame);
            const ts = frame.timestamp;
            const key = syncFlags.get(ts);
            syncFlags.delete(ts);
            const keyFrame = key === undefined ? firstFrame : (key || firstFrame);
            if (rotation && typeof frame.rotate === 'function') frame.rotate(rotation);
            encoder.encode(frame, { keyFrame });
            firstFrame = false;
            frame.close();
            wake();
        },
        error: (e) => { decodeError = e; wake(); },
    });
    let decoderConfigOk = false;
    try { decoder.configure(vConfig); decoderConfigOk = true; } catch { /* surfaced at first sample */ }

    let audioDecoder = null, audioEncoder = null, audioError = null;
    if (aTrack) {
        try {
            audioDecoder = new window.AudioDecoder({
            output: (ad) => {
                if (audioError) { ad.close(); return; }
                if (!audioEncoder) {
                    audioEncoder = new window.AudioEncoder({
                        output: (chunk, meta) => { muxer.addAudioChunk(chunk, meta); wake(); },
                        error: (e) => { audioError = e; wake(); },
                    });
                    audioEncoder.configure({
                        codec: 'mp4a.40.2',
                        sampleRate: aConfig.sampleRate,
                        numberOfChannels: aConfig.numberOfChannels,
                        bitrate: 160_000,
                    });
                }
                audioEncoder.encode(ad);
                ad.close();
                wake();
            },
            error: (e) => { audioError = e; wake(); },
        });
            audioDecoder.configure(aConfig);
        } catch (e) {
            throw new Error(`Your browser could not open the ${aTrack.codec} audio decoder (${e && e.message || e}).`);
        }
    }

    // ---- pump -----------------------------------------------------------------
    mp4.setExtractionOptions(vTrack.id, 'v', { nbSamples: 100 });
    if (aTrack) mp4.setExtractionOptions(aTrack.id, 'a', { nbSamples: 400 });
    mp4.start();

    const feedNext = async () => {
        const buf = await file.slice(pos, pos + READ_CHUNK).arrayBuffer();
        buf.fileStart = pos;
        pos += buf.byteLength;
        mp4.appendBuffer(buf);
        if (pos >= file.size) mp4.flush();
    };

    const released = { v: 0, a: 0 };
    let videoDone = false, audioDone = !aTrack, lastUi = 0;

    while (!(videoDone && audioDone)) {
        check();
        if (decodeError) {
            const m = String(decodeError.message || decodeError);
            if (/unsupported|config/i.test(m)) {
                throw new Error(`This browser cannot decode ${vTrack.codec} on this machine (missing system decoder). `
                    + 'Update Chrome/Edge and make sure the HEVC video extension is installed, or convert the file with HandBrake first.');
            }
            throw new Error(`Decoding failed (${m}). The source may be corrupted.`);
        }
        if (encodeError) throw new Error(`H.264 encoding failed (${encodeError.message || encodeError}).`);
        if (audioError) throw new Error(`Audio processing failed (${audioError.message || audioError}).`);
        if (audioEncoder && audioEncoder.encodeQueueSize > 600) {
            // AAC encode lagging: stop consuming until it catches up.
            const lagSeq = wakeSeq;
            await sleepUntilWake(lagSeq);
            continue;
        }

        const seq = wakeSeq;

        while (queues.v.length && decoder.decodeQueueSize <= MAX_DECODE_QUEUE) {
            const s = queues.v.shift();
            if (!decoderConfigOk) {
                // configure() threw (e.g. hvc1 without a system HEVC decoder):
                // fail honestly with an actionable message instead of
                // starve-waiting for frames that will never arrive.
                throw new Error('Could not start the ' + vTrack.codec + ' decoder: this browser cannot decode ' + vTrack.codec + '. Update Chrome/Edge (HEVC on Windows also needs the HEVC video extension), or convert the file with HandBrake.');
            }
            const tsUs = Math.round((s.cts * 1e6) / vTrack.timescale);
            syncFlags.set(tsUs, !!s.is_sync);
            decoder.decode(new window.EncodedVideoChunk({
                type: s.is_sync ? 'key' : 'delta',
                timestamp: tsUs,
                duration: Math.round((s.duration * 1e6) / vTrack.timescale),
                data: sampleBytes(s),
            }));
            if (s.number >= released.v) { released.v = s.number + 1; mp4.releaseUsedSamples(vTrack.id, released.v); }
            if (onProgress && encodedFrames - lastUi > 40) {
                lastUi = encodedFrames;
                onProgress(totalSamples ? Math.min(0.99, encodedFrames / totalSamples) : 0,
                    `Encoding H.264… ${encodedFrames}${totalSamples ? ` / ${totalSamples} frames` : ''}`);
            }
        }
        while (queues.a.length && audioDecoder && audioDecoder.decodeQueueSize <= MAX_AUDIO_DECODE_QUEUE) {
            const s = queues.a.shift();
            audioDecoder.decode(new window.EncodedAudioChunk({
                type: 'key',
                timestamp: Math.round((s.cts * 1e6) / aTrack.timescale),
                duration: Math.round((s.duration * 1e6) / aTrack.timescale),
                data: sampleBytes(s),
            }));
            if (s.number >= released.a) { released.a = s.number + 1; mp4.releaseUsedSamples(aTrack.id, released.a); }
        }

        if (!queues.v.length && !queues.a.length && pos < file.size) { await feedNext(); continue; }

        if (!queues.v.length && pos >= file.size && !videoDone && decoder.decodeQueueSize === 0) {
            await decoder.flush();
            videoDone = true;
        }
        if (audioDecoder && !audioDone && !queues.a.length && pos >= file.size && audioDecoder.decodeQueueSize === 0) {
            await audioDecoder.flush();
            audioDone = true;
        }

        if (!(videoDone && audioDone)) await sleepUntilWake(seq);
    }

    // Drain the encoder queues (encoded chunks must reach the muxer
    // before finalize; wake() fires for every chunk so these waits end).
    check();
    await encoder.flush();
    if (audioEncoder) await audioEncoder.flush();
    if (encodeError) throw new Error(`H.264 encoding failed (${encodeError.message || encodeError}).`);
    decoder.close();
    if (audioDecoder) audioDecoder.close();
    muxer.finalize();

    const buffer = muxer.target.buffer;
    if (!buffer || buffer.byteLength === 0) throw new Error('Conversion produced an empty file.');
    onProgress(1, `Converted ${encodedFrames} frames to H.264.`);
    return new Blob([buffer], { type: 'video/mp4' });
}
