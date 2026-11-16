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
