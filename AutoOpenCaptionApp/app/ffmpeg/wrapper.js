/**
 * FFmpeg Wrapper
 *
 * A thin wrapper around a web worker that communicates with @ffmpeg/core.
 * All URLs are provided by the caller. This file contains zero hardcoded paths.
 *
 * The worker is loaded from a URL provided at construction time.
 * The WASM core URLs are provided at init() time.
 */

export class FFmpegWrapper {
    #worker = null;
    #nextId = 1;
    #resolves = {};
    #rejects = {};
    #loaded = false;
    // Ring buffer of the core's log lines. ffmpeg errors are otherwise
    // invisible: an unsupported codec makes exec return non-zero (or OOM-
    // kills the worker), and the user just sees a failed export with no
    // reason. Kept capped so a chatty encode cannot grow memory.
    #logs = [];
    static #LOG_LIMIT = 300;

    /**
     * @param {string} workerURL - Path to the worker script (relative to page)
     */
    constructor(workerURL) {
        this.#worker = new Worker(workerURL);
        this.#worker.onmessage = (e) => this.#handleMessage(e);
        // A dead worker never answers pending requests: reject them with a
        // real error instead of leaving the export bar stuck forever (a
        // silent hang reads to the user as "it is still working").
        this.#worker.onerror = (e) => {
            console.error('FFmpeg worker error:', e);
            this.#failAllPending(new Error(
                'FFmpeg worker crashed (the page ran out of memory, or the video is too large). ' +
                'Try a shorter or lower-resolution video.'));
            this.#loaded = false;
        };
    }

    /** Recent FFmpeg log lines (oldest first), for error reporting. */
    getLogs() {
        return this.#logs.slice();
    }

    clearLogs() {
        this.#logs.length = 0;
    }

    #failAllPending(err) {
        if (!this.#worker) return;
        this.#worker.terminate();
        this.#worker = null;
        for (const id of Object.keys(this.#rejects)) {
            this.#rejects[id](err);
            delete this.#rejects[id];
            delete this.#resolves[id];
        }
    }

    get loaded() {
        return this.#loaded;
    }

    /**
     * Initialize the FFmpeg WASM core.
     * @param {{ coreURL: string, wasmURL: string }} urls - Paths to ffmpeg-core.js and ffmpeg-core.wasm
     */
    async init({ coreURL, wasmURL }) {
        const result = await this.#send('LOAD', { coreURL, wasmURL });
        this.#loaded = true;
        return result;
    }

    /**
     * Write a file into FFmpeg's in-memory filesystem.
     * @param {string} path - Virtual filesystem path
     * @param {Uint8Array|string} data - File contents
     */
    async writeFile(path, data) {
        return this.#send('WRITE_FILE', { path, data });
    }

    /**
     * Execute an ffmpeg command.
     * @param {string[]} args - Command-line arguments (e.g. ['-i', 'input.mp4', 'output.wav'])
     * @param {number} [timeout=-1] - Timeout in milliseconds (-1 = no timeout)
     * @returns {number} Exit code (0 = success)
     */
    async exec(args, timeout = -1) {
        return this.#send('EXEC', { args, timeout });
    }

    /**
     * Read a file from FFmpeg's in-memory filesystem.
     * @param {string} path - Virtual filesystem path
     * @param {string} [encoding='binary'] - 'binary' returns Uint8Array, 'utf8' returns string
     * @returns {Uint8Array|string}
     */
    async readFile(path, encoding = 'binary') {
        return this.#send('READ_FILE', { path, encoding });
    }

    /**
     * Delete a file from FFmpeg's in-memory filesystem.
     * @param {string} path - Virtual filesystem path
     */
    async deleteFile(path) {
        return this.#send('DELETE_FILE', { path });
    }

    /**
     * Create a directory in FFmpeg's in-memory filesystem.
     * @param {string} path - Directory path
     */
    async createDir(path) {
        return this.#send('CREATE_DIR', { path });
    }

    /**
     * Terminate the worker. The wrapper cannot be reused after this.
     */
    terminate() {
        if (this.#worker) {
            this.#worker.terminate();
            this.#worker = null;
            this.#loaded = false;
            for (const id of Object.keys(this.#rejects)) {
                this.#rejects[id](new Error('FFmpeg terminated'));
                delete this.#rejects[id];
                delete this.#resolves[id];
            }
        }
    }

    #send(type, data) {
        if (!this.#worker) {
            return Promise.reject(new Error('FFmpeg worker is not running'));
        }
        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            this.#resolves[id] = resolve;
            this.#rejects[id] = reject;
            this.#worker.postMessage({ id, type, data });
        });
    }

    #handleMessage(event) {
        const { id, type, data } = event.data || {};
        // Progress events carry no request id — forward them to the callback.
        if (type === 'PROGRESS') {
            if (this.onProgress) this.onProgress(data);
            return;
        }
        if (type === 'LOG') {
            // Keep a bounded tail of ffmpeg's own output; the app surfaces
            // it whenever an exec fails. Message shape: { type, message }.
            const line = (data && data.message) ? String(data.message).trimEnd() : String(data);
            if (line) {
                this.#logs.push(line);
                if (this.#logs.length > FFmpegWrapper.#LOG_LIMIT) {
                    this.#logs.splice(0, this.#logs.length - FFmpegWrapper.#LOG_LIMIT);
                }
            }
            return;
        }
        if (id == null) return;
        if (type === 'ERROR') {
            if (this.#rejects[id]) {
                this.#rejects[id](new Error(data));
                delete this.#rejects[id];
                delete this.#resolves[id];
            }
            return;
        }
        if (this.#resolves[id]) {
            this.#resolves[id](data);
            delete this.#resolves[id];
            delete this.#rejects[id];
        }
    }
}
