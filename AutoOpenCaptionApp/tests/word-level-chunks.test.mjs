/**
 * Regression: transformers.js with return_timestamps:'word' flattens the
 * transcript so EVERY word is its own chunk — chunks[].{ text, timestamp }
 * with no `words` array (see _decode_asr: `x={chunks:e}` of collated
 * {text,timestamp} word objects).
 *
 * Before the wordLevelTimestamps option, these flat word chunks hit the
 * segment-split branch and EVERY word got estimated:'segment-split' — the
 * "all word chips have a red outline" bug, while the log (which only counts
 * sanitize repairs) reported a handful of words. Real model alignments must
 * NOT be flagged as estimates; only genuinely broken stamps get repaired.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { whisperToTranscript } from '../app/assets/whisper-adapter.js';

// Mimics the exact shape the bundled transformers.umd.js produces in word
// mode: single (often space-padded) word per chunk, already rounded to 2dp.
function wordChunks() {
    const t = (a, b) => ({ text: a, timestamp: b });
    return [
        t(' Hello', [0.0, 0.42]),
        t(' there', [0.42, 0.86]),
        t(' I', [0.86, 1.02]),
        t(' said', [1.02, 1.4]),
        // collapsed alignment run (start === end) — genuinely broken:
        t(' quiet', [1.4, 1.4]),
        t(' words', [1.4, 1.4]),
        // healthy neighbour resumes
        t(' over', [2.1, 2.4]),
        t(' here', [2.4, 2.9]),
        // last token of the audio has a null end stamp — must be repaired
        t(' end.', [3.2, null]),
    ];
}

test('word-mode flat chunks keep real stamps, no blanket estimates', () => {
    const t = whisperToTranscript(
        { chunks: wordChunks() }, 3.6, 'clip.wav', 'en',
        { wordLevelTimestamps: true });

    assert.equal(t.words.length, 9);
    assert.equal(t.words[0].text, 'Hello', 'word text trimmed');

    // Healthy alignments are NOT flagged estimated (the bug flagged all 9).
    const healthy = t.words.filter(w => !w.estimated);
    assert.ok(healthy.length >= 6, `healthy words stay unflagged, got ${healthy.length}/9`);
    const hello = t.words[0];
    assert.equal(hello.estimated, undefined);
    assert.deepEqual([hello.start, hello.end], [0.0, 0.42]);

    // The collapsed run IS flagged and repaired inside its neighbours.
    const flagged = t.words.filter(w => w.estimated);
    assert.ok(flagged.length >= 2);
    for (const w of flagged) {
        assert.ok(w.end >= w.start, `repaired ${w.text} negative duration`);
        assert.ok(w.end <= 3.6, `repaired ${w.text} past audio end`);
    }
    assert.equal(t.timing.estimated, flagged.length);
    assert.ok(t.repairedTimestamps > 0, 'log counter still reflects real repairs');
});

test('without the option the old segment-split behaviour is preserved', () => {
    // Schema B callers (segment-level output) must still pace words over a
    // segment window with estimated stamps.
    const t = whisperToTranscript(
        { chunks: [{ text: 'one two three', timestamp: [1, 4] }] }, 5, 'seg.wav', 'en');
    assert.equal(t.words.length, 3);
    assert.ok(t.words.every(w => w.estimated && w.estimatedReason === 'segment-split'));
});
