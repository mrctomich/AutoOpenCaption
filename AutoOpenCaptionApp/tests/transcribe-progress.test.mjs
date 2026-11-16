/**
 * Transcription progress bar regression: the bar sat at 0% for the whole
 * whisper pass because nothing hooked the per-window generate() calls the
 * transformers.js ASR pipeline makes. whisperWindowCount mirrors the
 * library's chunk loop (30 s windows, hop = chunk - 2*stride) to produce
 * the denominator; makeWindowProgressStreamer counts streamer.end() —
 * fired once per finished audio window — as the numerator.
 *
 * The pure helpers run for real (direct module import); the app wiring is
 * source-guarded because it lives inside the DOM-bound transcribe().
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { whisperWindowCount, makeWindowProgressStreamer } from '../app/assets/whisper-adapter.js';

const SR = 16000;
const samples = (sec) => Math.round(sec * SR);

// ── whisperWindowCount (real function) ─────────────────────────────

test('whisperWindowCount: single window when the audio fits in one chunk', () => {
    assert.equal(whisperWindowCount({ sampleCount: samples(1) }), 1);
    assert.equal(whisperWindowCount({ sampleCount: samples(30) }), 1);   // exactly one window
    assert.equal(whisperWindowCount({ sampleCount: samples(30.1) }), 2);
});

test('whisperWindowCount: hop = chunk - 2*stride drives the total', () => {
    // Defaults mirror _call_whisper: 30 s windows advancing by 20 s.
    assert.equal(whisperWindowCount({ sampleCount: samples(50) }), 2);    // windows start 0, 20
    assert.equal(whisperWindowCount({ sampleCount: samples(50.1) }), 3);  // 20 s window ends before the audio
    assert.equal(whisperWindowCount({ sampleCount: samples(90) }), 4);    // 0, 20, 40, 60
    assert.equal(whisperWindowCount({ sampleCount: samples(420) }), 21);  // 1 + ceil(390/20)
});

test('whisperWindowCount: non-positive/non-finite input degrades to one window', () => {
    assert.equal(whisperWindowCount({ sampleCount: 0 }), 1);
    assert.equal(whisperWindowCount({ sampleCount: -5 }), 1);
    assert.equal(whisperWindowCount({ sampleCount: NaN }), 1);
});

test('whisperWindowCount: stride that stalls the library loop throws', () => {
    // The library only validates chunk > stride; stride >= chunk/2 would
    // make its window loop never advance. We must NOT hand the bar a
    // plausible-looking count for a run that cannot terminate.
    assert.throws(
        () => whisperWindowCount({ sampleCount: samples(60), strideLengthS: 15 }),
        /stride_length_s/
    );
});

// ── makeWindowProgressStreamer (real function) ─────────────────────

test('makeWindowProgressStreamer: end() counts windows; put() stays silent', () => {
    const seen = [];
    const s = makeWindowProgressStreamer(3, (done, total) => seen.push([done, total]));
    s.put([[1, 2]]); // token batch tick — must not move the bar
    assert.deepEqual(seen, []);
    s.end(); s.end(); s.end();
    assert.deepEqual(seen, [[1, 3], [2, 3], [3, 3]]);
});

test('makeWindowProgressStreamer: stray end() never overshoots the total', () => {
    const seen = [];
    const s = makeWindowProgressStreamer(2, (done, total) => seen.push([done, total]));
    s.end(); s.end(); s.end(); s.end();
    assert.equal(seen.length, 2);
    assert.deepEqual(seen.at(-1), [2, 2]);
});

test('makeWindowProgressStreamer: degenerate total still yields one clamped tick', () => {
    const seen = [];
    const s = makeWindowProgressStreamer(0, (done, total) => seen.push([done, total]));
    s.end(); s.end();
    assert.deepEqual(seen, [[1, 1]]);
});

// ── app.js wiring (source guards) ──────────────────────────────────

const appSrc = readFileSync(new URL('../app/assets/app.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n');

test('app.js: chunking constants feed BOTH the pipeline call and the progress total', () => {
    assert.match(appSrc, /const TRANSCRIBE_CHUNK_LENGTH_S = 30;/);
    assert.match(appSrc, /const TRANSCRIBE_STRIDE_LENGTH_S = 5;/);
    assert.match(appSrc,
        /whisperWindowCount\(\{[^)]*chunkLengthS: TRANSCRIBE_CHUNK_LENGTH_S[^)]*strideLengthS: TRANSCRIBE_STRIDE_LENGTH_S/s);
});

test('app.js: the whisper call carries the streamer and its callback moves the bar', () => {
    const call = appSrc.match(/await whisperPipeline\(audioSamples, \{[\s\S]*?\}\);/);
    assert.ok(call, 'whisperPipeline(...) call not found');
    assert.match(call[0], /chunk_length_s: TRANSCRIBE_CHUNK_LENGTH_S,/);
    assert.match(call[0], /stride_length_s: TRANSCRIBE_STRIDE_LENGTH_S,/);
    assert.match(call[0], /streamer: progressStreamer/);
    // Callback: honours cancellation, maps windows onto 0..85%
    // (90% stays 'Building transcript...', 100% the pipeline resolve).
    assert.match(appSrc,
        /const progressStreamer = makeWindowProgressStreamer\(windows, \(done, total\) => \{[\s\S]{0,400}?if \(cancelled\) return;[\s\S]{0,300}?Progress\.update\(\(done \/ total\) \* 85,/);
});

test('app.js: streamer helpers are imported from the adapter module', () => {
    assert.match(appSrc,
        /import \{ whisperToTranscript, whisperWindowCount, makeWindowProgressStreamer \} from '\.\/whisper-adapter\.js';/);
});
