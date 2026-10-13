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
