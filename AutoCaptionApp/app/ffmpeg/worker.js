let ffmpeg = null;

const load = async ({ coreURL, wasmURL }) => {
    if (ffmpeg) return false;
    if (!coreURL) throw new Error('coreURL is required');
    if (!wasmURL) throw new Error('wasmURL is required');

    try {
        importScripts(coreURL);
    } catch {
        self.createFFmpegCore = (await import(coreURL)).default;
    }

    if (!self.createFFmpegCore) {
        throw new Error('Failed to load createFFmpegCore');
    }

    ffmpeg = await self.createFFmpegCore({
        mainScriptUrlOrBlob: coreURL + '#' + btoa(JSON.stringify({ wasmURL }))
    });

    ffmpeg.setLogger((msg) => self.postMessage({ type: 'LOG', data: msg }));
    ffmpeg.setProgress((p) => self.postMessage({ type: 'PROGRESS', data: p }));

    return true;
};

const exec = ({ args, timeout = -1 }) => {
    ffmpeg.setTimeout(timeout);
    ffmpeg.exec(...args);
    const ret = ffmpeg.ret;
    ffmpeg.reset();
    return ret;
};

const writeFile = ({ path, data }) => {
    ffmpeg.FS.writeFile(path, data);
    return true;
};

const readFile = ({ path, encoding }) => {
    return ffmpeg.FS.readFile(path, { encoding });
};

const deleteFile = ({ path }) => {
    ffmpeg.FS.unlink(path);
    return true;
};

const createDir = ({ path }) => {
    ffmpeg.FS.mkdir(path);
    return true;
};

self.onmessage = async ({ data: { id, type, data } }) => {
    let result;
    try {
        if (type !== 'LOAD' && !ffmpeg) {
            throw new Error('FFmpeg is not loaded. Call load() first.');
        }

        switch (type) {
            case 'LOAD':
                result = await load(data);
                break;
            case 'EXEC':
                result = exec(data);
                break;
            case 'WRITE_FILE':
                result = writeFile(data);
                break;
            case 'READ_FILE':
                result = readFile(data);
                break;
            case 'DELETE_FILE':
                result = deleteFile(data);
                break;
            case 'CREATE_DIR':
                result = createDir(data);
                break;
            default:
                throw new Error('Unknown message type: ' + type);
        }

        const transfer = result instanceof Uint8Array ? [result.buffer] : [];
        self.postMessage({ id, type, data: result }, transfer);
    } catch (e) {
        self.postMessage({ id, type: 'ERROR', data: e.toString() });
    }
};
