/**
 * FFmpegService
 *
 * Application-level abstraction over FFmpeg. The rest of the app imports
 * only this module and never touches the worker or WASM directly.
 *
 * To swap FFmpeg implementations: replace this file (and the worker/wrapper)
 * without changing any other file in the project.
 */

import { FFmpegWrapper } from '../ffmpeg/wrapper.js';

const WASM_CORE_URL = '../wasm/ffmpeg-core.js';
const WASM_BINARY_URL = '../wasm/ffmpeg-core.wasm';
const WORKER_URL = 'ffmpeg/worker.js';

let wrapper = null;
let progressHandler = null;

export const FFmpegService = {
    get isLoaded() {
        return wrapper !== null && wrapper.loaded;
    },

    // Receives {progress: 0..1, time} events from ffmpeg while an exec runs.
    set onProgress(fn) {
        progressHandler = fn;
        if (wrapper) wrapper.onProgress = fn;
    },

    async init() {
        if (wrapper && wrapper.loaded) return;
        wrapper = new FFmpegWrapper(WORKER_URL);
        wrapper.onProgress = (p) => { if (progressHandler) progressHandler(p); };
        await wrapper.init({
            coreURL: WASM_CORE_URL,
            wasmURL: WASM_BINARY_URL
        });
    },

    async writeFile(path, data) {
        return wrapper.writeFile(path, data);
    },

    async exec(args, timeout) {
        return wrapper.exec(args, timeout);
    },

    async readFile(path, encoding) {
        return wrapper.readFile(path, encoding);
    },

    async deleteFile(path) {
        return wrapper.deleteFile(path);
    },

    // FFmpeg's own log tail (see wrapper): cleared before each exec whose
    // failure the user should see explained.
    clearLogs() {
        if (wrapper) wrapper.clearLogs();
    },

    getLogs() {
        return wrapper ? wrapper.getLogs() : [];
    },

    /**
     * Compact one-line summary of the most recent FFmpeg error lines,
     * suitable for appending to a Status error. '' when nothing is known.
     */
    lastErrorSummary(maxLines = 3) {
        const logs = this.getLogs();
        const interesting = logs.filter((l) =>
            /error|invalid|not found|not support|missing|cannot|failed|conversion failed/i.test(l) &&
            !/Last message repeated/i.test(l));
        const tail = interesting.slice(-maxLines);
        return tail.length ? ' FFmpeg said: ' + tail.join(' | ') : '';
    },

    /**
     * Bare codec transcode to H.264 + AAC (no overlays): the fallback for
     * videos the browser itself cannot decode (e.g. HEVC on a machine
     * without the HEVC extension) — the wasm core decodes those in
     * software, unlike WebCodecs. Slow (~real-time) but universal.
     * @param {Uint8Array} inputData - source file bytes
     * @param {Function} [onProgress] - receives fraction 0..1
     * @returns {Promise<Uint8Array>} H.264 + AAC MP4 bytes
     */
    async transcodeFile(inputData, onProgress) {
        this.clearLogs();
        await this.writeFile('input_video.mp4', inputData);
        if (onProgress) this.onProgress = (p) => onProgress(p && p.progress ? p.progress : 0);
        let ret;
        try {
            ret = await this.exec([
                '-i', 'input_video.mp4',
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
                '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
                '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-b:a', '160k',
                '-movflags', '+faststart', '-y',
                'output.mp4',
            ]);
        } finally {
            this.onProgress = null;
        }
        const bytes = await this.readFile('output.mp4');
        await this.deleteFile('input_video.mp4');
        if (!bytes || bytes.byteLength === 0) {
            throw new Error('FFmpeg produced an empty conversion.' + this.lastErrorSummary());
        }
        if (ret !== 0) {
            throw new Error('Conversion failed (FFmpeg exit ' + ret + ').' + this.lastErrorSummary());
        }
        return bytes;
    },

    async createDir(path) {
        return wrapper.createDir(path);
    },

    terminate() {
        if (wrapper) {
            wrapper.terminate();
            wrapper = null;
        }
    }
};
