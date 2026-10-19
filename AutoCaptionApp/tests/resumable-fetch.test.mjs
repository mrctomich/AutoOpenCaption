// Headless test for resumable-fetch.js — run:  node tests/resumable-fetch.test.mjs
// Drives the wrapper against a local Range-capable server that deliberately
// destroys the socket mid-body, and asserts:
//   T1  mid-file drops are resumed via Range and the bytes are intact
//   T2  a completed file is served from the OPFS shim with ZERO new requests
//   T3  a fresh download interrupted and RESTARTED later resumes from disk
//       (prefix replay: consumer still receives byte 0..N in order)
//   T4  server ignoring Range (200 after we asked to resume) restarts cleanly
//   T5  HTTP 404 passes through untouched (the local-cache probe path)
//   T6  clean early end (fewer bytes than content-length) errors, partial kept
//   T7  non-matching URLs bypass the wrapper entirely
//   T8  isFileCached reports only COMPLETE, size-matching downloads
import http from 'node:http';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { makeResumableFetch, isFileCached } from '../app/assets/resumable-fetch.js';

// ── OPFS shim (subset of the FileSystemDirectoryHandle API) ──────────
function makeDir(root) {
    fs.mkdirSync(root, { recursive: true });
    return {
        async getFileHandle(name, { create = false } = {}) {
            const p = path.join(root, name);
            if (!create && !fs.existsSync(p)) throw new Error('NotFoundError: ' + name);
            return {
                name,
                async getFile() {
                    const st = fs.statSync(p);
                    return {
                        size: st.size,
                        async text() { return fs.readFileSync(p, 'utf8'); },
                        stream() { return Readable.toWeb(fs.createReadStream(p)); },
                    };
                },
                async createWritable({ keepExistingData = false } = {}) {
                    // Real OPFS: creates the file if absent; keepExistingData
                    // preserves content and starts writing at EOF.
                    const wantKeep = keepExistingData && fs.existsSync(p);
                    const fh = await fsp.open(p, wantKeep ? 'r+' : 'w');
                    OPEN_HANDLES.set(fh, new Error('opened ' + name).stack);
                    let pos = wantKeep ? fs.statSync(p).size : 0;
                    return {
                        async seek(n) { pos = n; },
                        async write(data) {
                            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer ?? data);
                            await fh.write(buf, 0, buf.length, pos);
                            pos += buf.length;
                        },
                        async close() { OPEN_HANDLES.delete(fh); await fh.close(); },
                        async abort() { OPEN_HANDLES.delete(fh); await fh.close(); await fsp.rm(p, { force: true }); },
                    };
                },
            };
        },
        async removeEntry(name) { await fsp.rm(path.join(root, name), { force: true }); },
    };
}

// ── Flaky Range-capable server ───────────────────────────────────────
// routes:  /ok/file      drops the socket after dropAfter bytes on the first
//                         `dropCount` requests for that file, then completes
//            /ok/norange same file but always answers 200 (ignores Range)
//            /gone/file  always 404
// server.requests[path] = [{range, status}] log
function startServer(payload, tmp) {
    const state = { requests: {}, dropAfter: 200_000, dropCount: 3 };
    const server = http.createServer((req, res) => {
        const key = req.url;
        (state.requests[key] ||= []).push(req.headers.range || null);
        const n = state.requests[key].length;

        if (key.startsWith('/gone/')) { res.writeHead(404); res.end('nope'); return; }
        const noRange = key.startsWith('/ok/norange');

        let start = 0;
        const total = payload.length;
        if (!noRange && req.headers.range) {
            const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range);
            start = m && m[1] ? Number(m[1]) : 0;
            if (start >= total) { res.writeHead(416); res.end(); return; }
            res.writeHead(206, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(total - start),
                'Content-Range': `bytes ${start}-${total - 1}/${total}`,
                'Accept-Ranges': 'bytes',
            });
        } else {
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(total),
                'Accept-Ranges': 'bytes',
            });
        }
        // Kill the socket after dropAfter bytes on the first dropCount requests.
        const shouldDrop = !noRange && n <= state.dropCount && (total - start) > state.dropAfter;
        let sent = 0;
        const STREAM_CHUNK = 64 * 1024;
        (async () => {
            while (sent < total - start) {
                const end = Math.min(sent + STREAM_CHUNK, total - start);
                const ok = res.write(payload.subarray(start + sent, start + end));
                sent = end;
                if (shouldDrop && sent >= state.dropAfter) {
                    res.socket.destroy();
                    return;
                }
                if (!ok) await new Promise((r) => res.once('drain', r));
            }
            res.end();
        })().catch(() => {});
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state })));
}

const OPEN_HANDLES = new Map();
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const collect = async (resp) => {
    const chunks = [];
    for await (const c of resp.body) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
};

// ── Run ──────────────────────────────────────────────────────────────
const TOTAL = 1_000_000;                       // 1 MB test "model file"
const payload = crypto.randomBytes(TOTAL);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-test-'));
const dir = makeDir(tmp);
const { server, state } = await startServer(payload, tmp);
const base = `http://127.0.0.1:${server.address().port}`;

const logs = [];
const rf = makeResumableFetch({
    fetchImpl: globalThis.fetch,
    getDirectory: async () => dir,
    urlPattern: /^http:\/\/127\.0\.0\.1:\d+\/ok\//,
    backoffMs: () => 10,
    log: (m) => logs.push(m),
});

// T1 — mid-file drops resume transparently
{
    const resp = await rf(`${base}/ok/file`);
    assert.strictEqual(resp.status, 200);
    assert.strictEqual(resp.headers.get('content-length'), String(TOTAL));
    const got = await collect(resp);
    assert.strictEqual(got.length, TOTAL, 'T1 length');
    assert.strictEqual(sha(got), sha(payload), 'T1 bytes intact');
    assert.ok(state.requests['/ok/file'].length >= 4, 'T1 made multiple ranged requests');
    assert.ok(state.requests['/ok/file'].some((r, i) => i > 0 && /^bytes=\d+-/.test(r || '')), 'T1 sent Range on retries');
    const meta = JSON.parse(fs.readFileSync(path.join(tmp, shaKey(`${base}/ok/file`) + '.meta'), 'utf8'));
    assert.strictEqual(meta.complete, true, 'T1 meta complete');
    console.log('T1 PASS — resumed through', state.requests['/ok/file'].length - 1, 'drops, bytes intact');
}

// T2 — completed file served from disk with zero new requests
{
    const before = state.requests['/ok/file'].length;
    const resp = await rf(`${base}/ok/file`);
    assert.strictEqual(resp.headers.get('content-length'), String(TOTAL));
    const got = await collect(resp);
    assert.strictEqual(sha(got), sha(payload), 'T2 bytes intact');
    assert.strictEqual(state.requests['/ok/file'].length, before, 'T2 no new server requests');
    console.log('T2 PASS — served from OPFS cache, zero network');
}

// T3 — fresh download interrupted, then restarted later, resumes from disk
{
    // first pass: consume only part of the stream, then cancel it (simulates
    // popup close / reload mid-download)
    const resp = await rf(`${base}/ok/file2`);
    const reader = resp.body.getReader();
    let seen = 0;
    for (let i = 0; i < 8; i++) { const { value } = await reader.read(); seen += value.byteLength; }
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 50)); // let the writer flush
    const partName = shaKey(`${base}/ok/file2`) + '.part';
    const partSize = fs.statSync(path.join(tmp, partName)).size;
    assert.ok(partSize >= seen * 0.5, `T3 partial kept on disk (${partSize} >= ~${seen})`);

    // second pass: restart — must resume with a Range request and replay 0..N
    const resp2 = await rf(`${base}/ok/file2`);
    const got = await collect(resp2);
    assert.strictEqual(got.length, TOTAL, 'T3 full length');
    assert.strictEqual(sha(got), sha(payload), 'T3 bytes intact after restart-resume');
    console.log(`T3 PASS — restarted download resumed from ${partSize} disk bytes, bytes intact`);
}

// T4 — server ignores Range: restart from zero, bytes intact
{
    const resp = await rf(`${base}/ok/norange`);
    const got = await collect(resp);
    assert.strictEqual(sha(got), sha(payload), 'T4 bytes intact');
    console.log('T4 PASS — Range-ignoring server handled');
}

// T5 — 404 passthrough
{
    const resp = await rf(`http://127.0.0.1:${server.address().port}/gone/file`);
    assert.strictEqual(resp.status, 404, 'T5 404 passed through');
    console.log('T5 PASS — 404 probe passthrough');
}

// T6 — clean early end (truncated without a socket error) errors out
{
    const kill = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Length': String(TOTAL), 'Content-Type': 'application/octet-stream' });
        res.write(payload.subarray(0, 100_000));
        setTimeout(() => res.end(), 20); // ends early, no RST
    });
    await new Promise((r) => kill.listen(0, '127.0.0.1', r));
    const rf6 = makeResumableFetch({
        fetchImpl: globalThis.fetch, getDirectory: async () => dir,
        urlPattern: /.*/, backoffMs: () => 5, maxResumes: 1, log: () => {},
    });
    let threw = null;
    try { await collect(await rf6(`http://127.0.0.1:${kill.address().port}/ok/early`)); }
    catch (e) { threw = e; }
    kill.close();
    assert.ok(threw && /ended early|resume/i.test(threw.message), 'T6 early-end error mentions resume: ' + (threw && threw.message));
    console.log('T6 PASS — early end surfaced as resumable error');
}

// T7 — non-matching URLs bypass the wrapper (no OPFS handling; raw fetch error)
{
    let threw = null;
    try { await rf('http://example.invalid/not-intercepted'); }
    catch (e) { threw = e; }
    assert.ok(threw, 'T7 raw fetch rejection passed through (bypassed wrapper)');
    console.log('T7 PASS — non-HF URL bypassed');
}

// T8 — isFileCached: true only for a complete sidecar + size-matching .part.
// This is what flips the model button from Download to Load, so a partial
// or corrupt spool must NEVER read as cached.
{
    const ANY = /.*/;
    const url = 'https://huggingface.co/onnx-community/whisper-base_timestamped/resolve/main/onnx/encoder_model.onnx';
    const key = shaKey(url);
    const part = path.join(tmp, key + '.part');
    const meta = path.join(tmp, key + '.meta');

    assert.strictEqual(await isFileCached(url, async () => dir, ANY), false,
        'T8 nothing spooled yet is not cached');

    fs.writeFileSync(part, 'x'.repeat(1000));
    fs.writeFileSync(meta, JSON.stringify({ size: 1000, total: 1000, complete: false }));
    assert.strictEqual(await isFileCached(url, async () => dir, ANY), false,
        'T8 partial download (complete:false) is not cached');

    fs.writeFileSync(meta, JSON.stringify({ size: 4000, total: 4000, complete: true }));
    assert.strictEqual(await isFileCached(url, async () => dir, ANY), false,
        'T8 sidecar total disagreeing with .part size is not cached');

    fs.writeFileSync(meta, JSON.stringify({ size: 1000, total: 1000, complete: true }));
    assert.strictEqual(await isFileCached(url, async () => dir, ANY), true,
        'T8 complete sidecar + matching .part is cached');

    fs.rmSync(meta);
    assert.strictEqual(await isFileCached(url, async () => dir, ANY), false,
        'T8 missing sidecar is not cached');

    // Default pattern: only HF resolve URLs are cacheable at all.
    assert.strictEqual(await isFileCached('http://127.0.0.1:1/models/config.json'), false,
        'T8 non-HF URL is never cached under the default pattern');
    console.log('T8 PASS — isFileCached true only for complete downloads');
}

if (OPEN_HANDLES.size) { for (const stack of OPEN_HANDLES.values()) console.log('UNCLOSED handle:\n', stack); throw new Error(OPEN_HANDLES.size + ' file handles leaked'); }
process.exit(0);

function shaKey(url) {
    return 'hf-' + url.replace(/^https:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '-').slice(-150);
}

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nALL TESTS PASSED');
