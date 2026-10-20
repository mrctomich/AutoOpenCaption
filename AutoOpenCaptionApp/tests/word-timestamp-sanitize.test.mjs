// Headless test for whisper-adapter.js sanitizeWords() — run:
//   node tests/word-timestamp-sanitize.test.mjs
//
// Regression for the "same timecode / zero-duration captions" bug seen in
// exported SRTs (JohnOliverFakeChurchStunt cues all at 00:01:09.980;
// "Games with annoying popups" zero-duration run at 00:02:49.980).
// Whisper word alignment collapses deterministically on music/SFX/overlap;
// the adapter must repair it before words reach grouping/export.
//
//   T1  middle-run collapse (John Oliver pattern) — zero-duration +
//       backward-jumping words re-timed between valid neighbours
//   T2  trailing-run collapse (Games pattern) — run at end of audio
//   T3  leading collapse at t=0 (null timestamps arrive as 0/0)
//   T4  healthy transcript passes through UNTOUCHED (repaired === 0)
//   T5  whisperToTranscript() end-to-end reports repairedTimestamps
//   T6  groupWords() never emits zero-duration caption groups
//   T7  global invariants on every sanitized output: end > start,
//       non-decreasing starts, no overrun of the following word
import assert from 'node:assert';
import { sanitizeWords, whisperToTranscript } from '../app/assets/whisper-adapter.js';
import { groupWords } from '../app/assets/caption-renderer.js';

const grouping = { maxWords: 8, maxSeconds: 2, maxCharacters: 42 };

let _id = 0;
const W = (text, start, end) => ({ id: `t${_id++}`, text, start, end, deleted: false });

// Global sanity: no zero/negative durations, starts non-decreasing,
// no word extends past the next word's start.
function assertValid(words, label) {
    for (let k = 0; k < words.length; k++) {
        assert.ok(words[k].end > words[k].start,
            `${label}: word ${k} "${words[k].text}" has non-positive duration ` +
            `[${words[k].start}, ${words[k].end}]`);
        if (k + 1 < words.length) {
            assert.ok(words[k + 1].start >= words[k].start,
                `${label}: word ${k + 1} starts before word ${k}`);
            assert.ok(words[k].end <= words[k + 1].start + 1e-9,
                `${label}: word ${k} "${words[k].text}" overruns next start ` +
                `(${words[k].end} > ${words[k + 1].start})`);
        }
    }
}

// ── T1: middle-run collapse (John Oliver pattern) ──────────────────────
// words 0..11 are the valid lead-in ending at 69.98; then a run of words
// clamped to [69.98, 69.98] (zero duration), exactly the exported cue
// pattern; then valid words resume at 74.2.
{
    const words = [
        W('is', 65.10, 65.30), W('the', 65.30, 65.50), W('altar', 65.50, 65.90),
        W('of', 66.00, 66.20), W('the', 66.20, 66.35), W('church', 66.35, 66.80),
        W('or', 67.00, 67.20), W('is', 67.20, 67.35), W('it', 67.35, 67.45),
        W('a', 67.45, 67.60), W('lottery', 67.60, 68.10), W('ticket', 68.10, 68.60),
        // collapsed run — all identical zero-duration stamps:
        W('you', 69.98, 69.98), W('guys', 69.98, 69.98), W('know', 69.98, 69.98),
        W('i', 69.98, 69.98), W('mean', 69.98, 69.98), W('he', 69.98, 69.98),
        W('sounds', 69.98, 69.98), W('a', 69.98, 69.98), W('lot', 69.98, 69.98),
        W('like', 69.98, 69.98), W('jesus', 69.98, 69.98),
        // valid again:
        W('he', 74.20, 74.40), W('sounds', 74.40, 74.90), W('just', 74.90, 75.10),
    ];
    const savedLead = words[11].end;
    const { words: out, repaired } = sanitizeWords(words, 90);
    assert.strictEqual(repaired, 11, 'T1: expected 11 repaired words');
    assertValid(out, 'T1');
    // repaired run must sit inside the window between neighbours...
    assert.ok(out[12].start >= savedLead - 1e-9, 'T1: run starts before prev end');
    assert.ok(out[22].end <= out[23].start + 1e-9, 'T1: run overruns next valid word');
    // ...and valid words keep their own timestamps
    assert.strictEqual(out[0].start, 65.10, 'T1: valid word moved');
    assert.strictEqual(out[23].start, 74.20, 'T1: trailing valid word moved');
    console.log('T1 middle-run collapse repaired: PASS');
}

// ── T2: trailing-run collapse (Games pattern) ──────────────────────────
{
    const words = [
        W('popups', 165.00, 165.40), W('every', 165.40, 165.70),
        W('ten', 169.98, 169.98), W('seconds', 169.98, 169.98),
        W('annoying', 169.98, 169.98), W('so', 169.98, 169.98),
        W('much', 169.98, 169.98),
    ];
    const { words: out, repaired } = sanitizeWords(words, 175);
    assert.strictEqual(repaired, 5, 'T2: expected 5 repaired words');
    assertValid(out, 'T2');
    assert.ok(out[4].end <= 175 + 1e-9, 'T2: trailing run exceeds audio duration');
    console.log('T2 trailing-run collapse repaired: PASS');
}

// ── T3: leading collapse at 0 (null → 0/0 from the adapter) ────────────
{
    const words = [
        W('um', 0, 0), W('yeah', 0, 0), W('so', 0, 0),
        W('anyway', 4.00, 4.40), W('let', 4.40, 4.60),
    ];
    const { words: out, repaired } = sanitizeWords(words, 30);
    assert.strictEqual(repaired, 3, 'T3: expected 3 repaired words');
    assertValid(out, 'T3');
    assert.ok(out[0].start >= 0, 'T3: negative start');
    console.log('T3 leading-collapse repair: PASS');
}

// ── T4: healthy transcript passes through untouched ────────────────────
{
    const words = [
        W('the', 1.00, 1.30), W('quick', 1.30, 1.65), W('brown', 1.65, 2.00),
        W('fox', 2.00, 2.30), W('jumps', 2.40, 2.75), W('over', 2.75, 3.05),
    ];
    const before = JSON.stringify(words);
    const { words: out, repaired } = sanitizeWords(words, 10);
    assert.strictEqual(repaired, 0, 'T4: healthy words reported as repaired');
    assert.strictEqual(JSON.stringify(out), before, 'T4: healthy timestamps altered');
    console.log('T4 healthy transcript untouched: PASS');
}

// ── T5: whisperToTranscript end-to-end (raw schema-A chunks) ───────────
{
    const result = {
        chunks: [{
            words: [
                { word: 'hello', timestamp: [1.00, 1.40] },
                { word: 'world', timestamp: [1.40, 1.80] },
                { word: 'laugh', timestamp: [2.50, 2.50] },   // collapsed
                { word: 'track', timestamp: [2.50, 2.50] },   // collapsed
                { word: 'music', timestamp: [3.20, 3.60] },
            ],
        }],
    };
    const t = whisperToTranscript(result, 5, 'video.mp4', 'en');
    assert.strictEqual(t.repairedTimestamps, 2, 'T5: adapter did not report repairs');
    assertValid(t.words, 'T5');
    console.log('T5 adapter end-to-end repair: PASS');
}

// ── T6: groupWords never emits zero-duration groups ────────────────────
{
    // words all at the same instant (worst case the sanitizer missed)
    const words = Array.from({ length: 4 }, (_, k) => W(`w${k}`, 10, 10 + k * 0.001));
    const groups = groupWords(words, grouping);
    for (const g of groups) {
        assert.ok(g.end > g.start, `T6: zero-duration group [${g.start}, ${g.end}]`);
    }
    console.log('T6 groupWords min duration: PASS');
}

// ── T7: randomized fuzz — invariants always hold ───────────────────────
{
    let seed = 123456789;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let trial = 0; trial < 200; trial++) {
        const n = 5 + Math.floor(rnd() * 40);
        const words = [];
        let t = rnd() * 10;
        for (let k = 0; k < n; k++) {
            const mode = rnd();
            if (mode < 0.25) {                       // collapse
                words.push(W(`w${k}`, t, t));
            } else if (mode < 0.35) {                // backward jump
                t -= rnd() * 2;
                words.push(W(`w${k}`, t, t + 0.3));
            } else if (mode < 0.40) {                // null-ish
                words.push(W(`w${k}`, 0, 0));
            } else {                                 // normal
                const d = 0.2 + rnd() * 0.5;
                words.push(W(`w${k}`, t, t + d));
                t += d + rnd() * 0.3;
            }
        }
        const dur = t + 5;
        const { words: out } = sanitizeWords(words, dur);
        assertValid(out, `T7 trial ${trial}`);
        for (const w of out) {
            assert.ok(Number.isFinite(w.start) && Number.isFinite(w.end),
                `T7 trial ${trial}: non-finite timestamp`);
            // End clamping rounds the audio duration up to whole
            // centiseconds, so that is the exact bound.
            assert.ok(w.end <= Math.ceil(dur * 100) / 100 + 1e-9,
                `T7 trial ${trial}: past audio end`);
        }
    }
    console.log('T7 fuzz 200 transcripts, invariants hold: PASS');
}

// ── T8: adjacent groups never overlap after the min-duration floor ─────
{
    // Two groups separated by <100 ms: group A's +0.1 floor would run
    // past group B's start without the overlap clamp.
    const words = [
        W('first', 5.00, 5.40), W('line', 5.40, 5.80),
        W('next', 5.85, 6.20), W('line', 6.20, 6.60),
        W('third', 6.65, 7.00), W('line', 7.00, 7.40),
    ];
    // force small groups so each pair splits
    const groups = groupWords(words, { maxWords: 2, maxSeconds: 5, maxCharacters: 42 });
    assert.ok(groups.length >= 2, 'T8: expected multiple groups');
    for (let k = 0; k < groups.length; k++) {
        assert.ok(groups[k].end > groups[k].start, `T8: zero-duration group ${k}`);
        if (k + 1 < groups.length) {
            assert.ok(groups[k].end <= groups[k + 1].start,
                `T8: group ${k} overlaps group ${k + 1} ` +
                `(${groups[k].end} > ${groups[k + 1].start})`);
        }
    }
    console.log('T8 adjacent groups do not overlap: PASS');
}

// ── T9: full pipeline (raw collapse → sanitize → group) ────────────────
{
    const raw = [];
    let t = 10;
    for (let k = 0; k < 30; k++) {
        if (k >= 12 && k < 18) {
            raw.push(W(`c${k}`, 14.98, 14.98));          // collapsed run
        } else {
            raw.push(W(`w${k}`, t, t + 0.35));
            t += 0.35 + (k % 3 === 0 ? 0.02 : 0.12);     // occasional <100ms gap
        }
    }
    const { words: clean } = sanitizeWords(raw, 30);
    assertValid(clean, 'T9');
    const groups = groupWords(clean, grouping);
    for (let k = 0; k < groups.length; k++) {
        assert.ok(groups[k].end > groups[k].start, `T9: zero-duration cue ${k}`);
        if (k + 1 < groups.length) {
            assert.ok(groups[k].end <= groups[k + 1].start,
                `T9: cue ${k} overlaps cue ${k + 1}`);
            assert.ok(groups[k + 1].start >= groups[k].start,
                `T9: cue starts go backward at ${k + 1}`);
        }
        assert.ok(groups[k].start >= 0, `T9: negative cue start`);
    }
    console.log(`T9 sanitize→group pipeline (${groups.length} cues, no zero-dur, no overlap): PASS`);
}

console.log('\nAll word-timestamp sanitize tests PASSED');
