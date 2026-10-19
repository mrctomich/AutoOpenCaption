// ── Resumable Hugging Face downloader ───────────────────────────────
// HuggingFace's CDN (us.aws.cdn.hf.co, the Xet bridge) periodically drops
// long-lived connections on the big model files (net::ERR_CONNECTION_CLOSED
// ~300-500 MB into the 645 MB large-v3-turbo encoder). transformers.js
// buffers each whole file in memory in a single fetch with NO resume, so
// every dropout restarts a hundreds-of-MB download from zero and the large
// model effectively never completes.
//
// This module wraps fetch for GETs to huggingface.co "resolve" URLs and:
//   1. streams every byte to an OPFS partial file as it arrives;
//   2. on a mid-stream dropout, re-fetches with `Range: bytes=<saved>-`
//      and splices the remainder into the SAME response stream — the
//      library never sees the error and the progress bar keeps advancing;
//   3. keeps partials across page reloads, so clicking Download again
//      resumes from disk instead of from zero;
//   4. once a file is complete (and flagged so in its sidecar meta), it is
//      served straight from disk on every later load — this IS the model
//      cache, which is why app.js sets env.useBrowserCache = false and
//      avoids a second ~1 GB copy in the Cache API.
//
// The HF CDN advertises Accept-Ranges, answers 206 with a correct
// Content-Range (verified live), and replies access-control-allow-origin: *
// — and Range is a CORS-safelisted request-header in modern Chrome, so no
// preflight and no server-side changes are needed. If Range were ever NOT
// safelisted the first intercepted request would fail fast with a CORS
// TypeError instead of silently mis-downloading.
//
// The module is dependency-free and injectable (fetchImpl/getDirectory/
// sleep) so the Node test harness can drive it against a deliberately
// flaky local server.

const HF_RESOLVE_RE = /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/.+/i;

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

// Stable filesystem key for a model URL: the repo + revision + file path,
// non-alphanumerics collapsed (keeps the name readable and path-safe).
function keyFor(url) {
    return 'hf-' + url.replace(/^https:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '-').slice(-150);
}

export function makeResumableFetch({
    fetchImpl,                                  // underlying fetch (required)
    getDirectory,                               // () => Promise<FileSystemDirectoryHandle> (OPFS root)
    maxResumes = 10,                            // mid-file reconnects per file
    backoffMs = (n) => Math.min(1000 * n, 5000),// wait before reconnect n
    urlPattern = HF_RESOLVE_RE,                 // which URLs to intercept (tests point this at a local server)
    sleep = sleepDefault,
    log = () => {},
} = {}) {
    if (!fetchImpl || !getDirectory) throw new Error('fetchImpl and getDirectory are required');

    async function removeEntry(dir, name) {
        try { await dir.removeEntry(name); } catch { /* absent — fine */ }
    }

    async function readMeta(dir, key) {
        try {
            const fh = await dir.getFileHandle(key + '.meta');
            return JSON.parse(await (await fh.getFile()).text()) || {};
        } catch { return {}; }
    }

    async function writeMeta(dir, key, meta) {
        const fh = await dir.getFileHandle(key + '.meta', { create: true });
        const w = await fh.createWritable();
        await w.write(JSON.stringify(meta));
        await w.close();
    }

    // Fetch with retry for the RESPONSE HEADERS phase only (the body phase
    // resumes inside the stream below). Returns { resp, have } — `have` is
    // the prefix already on disk that the 206 continues from (0 = full body).
    async function startFetch(dir, url, key, signal) {
        const partName = key + '.part';
        let attempt = 0;
        for (;;) {
            let have = 0;
            let meta = await readMeta(dir, key);
            if (!meta.complete) {
                try {
                    const f = await (await dir.getFileHandle(partName)).getFile();
                    have = f.size;
                } catch { have = 0; }
                if (meta.total && have > meta.total) have = 0; // corrupt — restart
            }

            try {
                const headers = have > 0 ? { 'Range': `bytes=${have}-` } : undefined;
                const resp = await fetchImpl(url, { method: 'GET', headers, signal });

                if (resp.status === 206) {
                    const m = /bytes\s+\d+-\d+\/(\d+)/.exec(resp.headers.get('content-range') || '');
                    const total = m ? Number(m[1]) : 0;
                    if (meta.total && total && meta.total !== total) {
                        // The repo changed under us — the partial is garbage.
                        log(`remote size changed (${meta.total} -> ${total}); discarding partial for ${key}`);
                        await removeEntry(dir, partName);
                        await removeEntry(dir, key + '.meta');
                        continue;
                    }
                    if (!meta.total) await writeMeta(dir, key, { total, complete: false });
                    log(`resuming ${key} at ${have} of ${total || '?'} bytes`);
                    return { resp, have, total: total || meta.total || 0 };
                }

                if (resp.ok) {
                    // 200: no usable Range (fresh file, or server ignored it) —
                    // any partial is stale or unusable; stream the whole body.
                    await removeEntry(dir, partName);
                    const total = Number(resp.headers.get('content-length') || 0);
                    await writeMeta(dir, key, { total, complete: false });
                    return { resp, have: 0, total };
                }

                if (resp.status === 416 && have > 0) {
                    // Our partial claims to be >= the remote file. Usually
                    // means the meta was lost/corrupted — discard and restart.
                    log(`416 on resume for ${key}; discarding ${have}-byte partial`);
                    await removeEntry(dir, partName);
                    await removeEntry(dir, key + '.meta');
                    continue;
                }

                // 4xx/5xx: pass the error response through untouched — this is
                // how the harmless "is it cached locally?" 404 probe and real
                // HTTP failures reach the library's own handling.
                return { resp, passthrough: true };
            } catch (err) {
                if (signal?.aborted || ++attempt > maxResumes) throw err;
                log(`fetch failed (${err && err.message}); retry ${attempt}/${maxResumes} in ${backoffMs(attempt)}ms`);
                await sleep(backoffMs(attempt));
            }
        }
    }

    // Builds the Response whose stream = [prefix on disk] + [live network
    // body], transparently re-issuing Range requests when the CDN drops the
    // connection mid-file. The consumer (transformers.js) sees one clean,
    // full-length byte stream or a final error after exhausting resumes.
    function buildStreamedResponse(dir, url, key, first, signal) {
        const partName = key + '.part';
        const state = { cancelled: false, reader: null, writer: null, resumePull: null };
        let resolveDone;
        const settled = new Promise((r) => { resolveDone = r; });

        // Byte-sized queue with a small high-water mark: enqueues below block
        // until the consumer pulls, so a slow (or dead) reader cannot make us
        // buffer a 600 MB model in memory — the stream applies real
        // backpressure to the network read instead.
        const QUEUE_BYTES = 1024 * 1024;
        const body = new ReadableStream({
            start(controller) { run(controller).catch(() => {}); },
            pull() {
                if (state.resumePull) { const r = state.resumePull; state.resumePull = null; r(); }
            },
            cancel() {
                state.cancelled = true;
                if (state.resumePull) { const r = state.resumePull; state.resumePull = null; r(); }
                try { state.reader && state.reader.cancel(); } catch { /* ignore */ }
                // close (not abort) the writer so the bytes already written
                // survive — a cancelled download can still resume later.
                try { state.writer && state.writer.close(); } catch { /* ignore */ }
                state.writer = null;
                resolveDone();
            },
        }, { highWaterMark: QUEUE_BYTES, size: (c) => (c && c.byteLength) || 1 });

        async function run(controller) {
            const fail = (e) => { if (!state.cancelled) { try { controller.error(e); } catch { /* ignore */ } } resolveDone(); };
            // Enqueue one chunk, then block until the consumer asks for more.
            const pump = async (value) => {
                controller.enqueue(value);
                if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                    await new Promise((r) => { state.resumePull = r; });
                }
            };
            try {
                // Phase A — replay the prefix already saved on disk so the
                // consumer's byte counter starts at 0 and content-length,
                // progress %, and file integrity all line up.
                let pos = first.have;
                if (first.have > 0) {
                    const preader = (await (await dir.getFileHandle(partName)).getFile()).stream().getReader();
                    for (;;) {
                        const { done, value } = await preader.read();
                        if (done) break;
                        if (state.cancelled) { preader.cancel(); return; }
                        await pump(value);
                    }
                    if (state.cancelled) return;
                }

                // Phase B — stream the network body into disk + consumer,
                // reconnecting with Range from `pos` whenever it drops.
                let reader = first.resp.body.getReader();
                state.reader = reader;
                const fh = await dir.getFileHandle(partName, { create: true });
                let writer = await fh.createWritable({ keepExistingData: true });
                if (pos > 0) await writer.seek(pos);
                state.writer = writer;
                if (state.cancelled) { // cancelled while phase A was wrapping up
                    try { await writer.close(); } catch { /* ignore */ }
                    state.writer = null;
                    resolveDone();
                    return;
                }

                let attempt = 0;
                for (;;) {
                    let value, done;
                    try {
                        ({ value, done } = await reader.read());
                        if (done) break;
                        if (state.cancelled) return; // writer already closed by cancel()
                        await writer.write(value);
                        pos += value.byteLength;
                        await pump(value);
                        if (state.cancelled) return; // writer closed by cancel()
                        attempt = 0; // progress resets the backoff ladder
                        continue;
                    } catch (err) {
                        if (state.cancelled || signal?.aborted) {
                            if (state.writer) { try { await state.writer.close(); } catch { /* ignore */ } state.writer = null; }
                            resolveDone();
                            return;
                        }
                        // Mid-file dropout: flush what we have, then reconnect.
                        try { await writer.close(); } catch { /* ignore */ }
                        state.writer = null;
                        if (++attempt > maxResumes) return fail(err);
                        log(`connection lost at ${pos} bytes — reconnect ${attempt}/${maxResumes} in ${backoffMs(attempt)}ms`);
                        await sleep(backoffMs(attempt));
                        if (state.cancelled || signal?.aborted) { resolveDone(); return; }
                    }

                    try {
                        const resp = await fetchImpl(url, { method: 'GET', headers: { 'Range': `bytes=${pos}-` }, signal });
                        if (resp.status !== 206) throw new Error(`resume refused (HTTP ${resp.status})`);
                        const w2 = await fh.createWritable({ keepExistingData: true });
                        await w2.seek(pos);
                        reader = resp.body.getReader();
                        state.reader = reader;
                        writer = w2;
                        state.writer = w2;
                    } catch (err) {
                        if (state.cancelled || signal?.aborted) { resolveDone(); return; }
                        if (++attempt > maxResumes) return fail(err);
                        await sleep(backoffMs(attempt));
                    }
                }

                // Stream ended cleanly.
                try { await state.writer.close(); } catch { /* already closed */ }
                state.writer = null;

                if (first.total && pos !== first.total) {
                    return fail(new Error(`download ended early (${pos}/${first.total} bytes) — click Download again to resume`));
                }
                await writeMeta(dir, key, { total: first.total || pos, complete: true });
                log(`cached ${key} (${pos} bytes) in OPFS`);
                controller.close();
                resolveDone();
            } catch (err) {
                if (state.writer) { try { await state.writer.close(); } catch { /* ignore */ } state.writer = null; }
                fail(err);
            }
        }

        const headers = { 'Content-Type': first.resp.headers.get('Content-Type') || 'application/octet-stream' };
        if (first.total) headers['Content-Length'] = String(first.total);
        return { response: new Response(body, { status: 200, headers }), settled };
    }

    return async function resumableFetch(input, init) {
        // Intercept only plain GETs of HF resolve URLs; everything else
        // (local server files, Request objects, POSTs) passes straight through.
        let url = null;
        if (typeof input === 'string') url = input;
        else if (input instanceof URL) url = input.href;
        else if (typeof Request !== 'undefined' && input instanceof Request) {
            if (input.method !== 'GET') return fetchImpl(input, init);
            url = input.url;
        }
        const method = (init && init.method) || 'GET';
        if (!url || method !== 'GET' || !urlPattern.test(url)) return fetchImpl(input, init);

        const dir = await getDirectory();
        const key = keyFor(url);

        // Completed file? Serve from disk — zero network, instant.
        const meta = await readMeta(dir, key);
        if (meta.complete) {
            try {
                const f = await (await dir.getFileHandle(key + '.part')).getFile();
                if (!meta.total || f.size === meta.total) {
                    log(`serving ${key} from OPFS cache (${f.size} bytes)`);
                    return new Response(f.stream(), {
                        status: 200,
                        headers: {
                            'Content-Type': 'application/octet-stream',
                            'Content-Length': String(f.size),
                        },
                    });
                }
                // Size disagrees with the meta — drop the bad copy and refetch.
                await removeEntry(dir, key + '.part');
                await removeEntry(dir, key + '.meta');
            } catch { /* fall through to network */ }
        }

        const signal = (init && init.signal) || (typeof Request !== 'undefined' && input instanceof Request ? input.signal : null);
        const first = await startFetch(dir, url, key, signal);
        if (first.passthrough) return first.resp;
        const { response } = buildStreamedResponse(dir, url, key, first, signal);
        return response;
    };
}

// Patches window.fetch in place. Call once at app startup, before any
// model load. Returns the wrapped function (mainly for tests/debugging).
export function installResumableFetch(options = {}) {
    const orig = options.fetchImpl || window.fetch.bind(window);
    const wrapped = makeResumableFetch({
        fetchImpl: orig,
        getDirectory: () => navigator.storage.getDirectory(),
        log: (m) => console.info('[resumable]', m),
        ...options,
    });
    window.fetch = wrapped;
    return wrapped;
}
