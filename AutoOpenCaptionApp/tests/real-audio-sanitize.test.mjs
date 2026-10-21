/**
 * Real-audio regression: whisper.cpp large-v3-turbo transcript of a real
 * John-Oliver-style clip (123.722 s, -ojf token JSON with entropy word
 * stamps). 13 tokens come back collapsed (start === end — mostly zero-width
 * punctuation, plus one token at the very audio end, 123.700 of 123.722).
 *
 * This is NOT synthetic: it checks sanitizeWords() against genuine model
 * output — repaired words must stay inside their neighbours, estimates must
 * be flagged with the raw stamps preserved, and the run at the audio
 * boundary must not expand past the real duration.
 *
 * NOTE: the transformers.js (browser) alignment path produced the famous
 * collapsed runs at 00:01:09.980 / 00:02:49.980 in the original bug report.
 * whisper.cpp's entropy stamps are a different alignment implementation and
 * are healthy in those zones, so this fixture covers the repair machinery
 * on real data, not those exact coordinates. Manual browser verification
 * procedure: docs/manual-sync-verification.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { whisperToTranscript } from '../app/assets/whisper-adapter.js';

const DURATION = 123.722; // exact WAV length (16 kHz mono PCM, header excluded)

function loadRealChunks(name = './fixtures/john_whispercpp_raw.json') {
    const raw = JSON.parse(readFileSync(
        new URL(name, import.meta.url), 'utf8'));
    return raw.transcription.map(seg => ({
        text: seg.text,
        timestamp: [seg.offsets.from / 1000, seg.offsets.to / 1000],
        words: seg.tokens
            .filter(t => !t.text.startsWith('<') && !t.text.startsWith('['))
            .map(t => ({
                word: t.text.trim() || t.text,
                timestamp: [t.offsets.from / 1000, t.offsets.to / 1000],
            })),
    }));
}

test('real whisper.cpp transcript repairs stay inside real neighbours', () => {
    const t = whisperToTranscript({ chunks: loadRealChunks() }, DURATION, 'john.wav', 'en');
    const W = t.words.filter(w => !w.deleted);
    assert.ok(W.length > 400, 'fixture loaded');

    // Every raw-collapsed stamp from the model was flagged as estimated,
    // and the summary agrees with the word flags.
    const rawCollapsed = loadRealChunks()
        .flatMap(c => c.words).filter(w => w.timestamp[0] === w.timestamp[1]).length;
    assert.equal(t.timing.repaired, rawCollapsed);
    assert.equal(t.timing.estimated, W.filter(w => w.estimated).length);
    assert.equal(t.timing.repaired + W.filter(w => !w.estimated).length, W.length);

    const durCap = Math.floor(DURATION * 100) / 100;
    for (let k = 0; k < W.length; k++) {
        const w = W[k];
        assert.ok(Number.isFinite(w.start) && Number.isFinite(w.end), `word ${k} stamps`);
        assert.ok(w.end >= w.start, `word ${k} negative duration`);
        if (k > 0) assert.ok(w.start >= W[k - 1].start, `word ${k} backward start`);
        if (w.estimated) {
            assert.ok(w.end <= durCap, `estimated word ${k} past audio end`);
            assert.ok('originalStart' in w && 'originalEnd' in w,
                `estimated word ${k} lost its raw stamps`);
            // Estimates never overrun the following word.
            if (k + 1 < W.length) {
                assert.ok(w.end <= W[k + 1].start + 1e-9,
                    `estimated word ${k} "${w.text}" overruns next start`);
            }
            // Unplaced = zero duration, and only then.
            assert.equal(!!w.unplaced, w.end === w.start,
                `word ${k} unplaced flag mismatch`);
        } else {
            // Healthy model stamps preserved exactly.
            assert.equal(w.end > w.start, true, `healthy word ${k} has no duration`);
        }
    }

    // The token at the real audio boundary (123.700 collapsed, audio ends
    // 123.722): repaired, kept at its anchor, clamped to the true duration.
    const last = W[W.length - 1];
    assert.equal(last.estimated, true);
    assert.deepEqual([last.originalStart, last.originalEnd], [123.7, 123.7]);
    assert.equal(last.start, 123.7);
    assert.equal(last.end, 123.72);

    // Leading collapsed run keeps its weak anchor (does not slide to 0).
    const first = W[0];
    assert.equal(first.estimated, true);
    assert.equal(first.start, 0.05);
});

test('games clip: real-word collapses repaired inside neighbours', () => {
    // 174.569 s clip; whisper.cpp returns 5 collapsed stamps here, all on
    // real words ("where", "what", "and", "it", "do"), not punctuation.
    const DUR = 174.569;
    const chunks = loadRealChunks('./fixtures/games_whispercpp_raw.json');
    const rawCollapsed = chunks
        .flatMap(c => c.words).filter(w => w.timestamp[0] === w.timestamp[1]).length;
    const t = whisperToTranscript({ chunks }, DUR, 'games.wav', 'en');
    assert.equal(t.timing.repaired, rawCollapsed);
    assert.equal(t.timing.repaired, 5);

    const W = t.words.filter(w => !w.deleted);
    const durCap = Math.floor(DUR * 100) / 100;
    for (let k = 0; k < W.length; k++) {
        const w = W[k];
        assert.ok(w.end >= w.start, `word ${k} negative duration`);
        if (k > 0) assert.ok(w.start >= W[k - 1].start, `word ${k} backward start`);
        if (w.estimated) {
            assert.ok(w.end <= durCap, `estimated word ${k} past audio end`);
            assert.deepEqual([w.originalStart, w.originalEnd], [w.originalEnd, w.originalEnd],
                `collapses must have start === end in raw stamps (word ${k})`);
            if (k + 1 < W.length)
                assert.ok(w.end <= W[k + 1].start + 1e-9,
                    `estimated word ${k} "${w.text}" overruns next start`);
            assert.equal(!!w.unplaced, w.end === w.start,
                `word ${k} unplaced flag mismatch`);
        }
    }

    // The reported failure coordinate 00:02:49.980: whisper.cpp's aligner is
    // healthy here (the original collapse came from the transformers.js
    // ONNX path) — the zone must pass through with no estimates.
    const zone = W.filter(w => Math.abs(w.start - 169.98) <= 4);
    assert.ok(zone.length >= 3, 'zone has words');
    assert.equal(zone.some(w => w.estimated), false,
        'healthy whisper.cpp zone must not be rewritten');
});
