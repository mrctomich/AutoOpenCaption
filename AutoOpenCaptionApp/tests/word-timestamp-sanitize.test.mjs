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
//   T7  global invariants on every sanitized output: starts non-decreasing,
//       no overrun of the following word, repaired ≤ audio end,
//       healthy byte-identical
//   T8  groupWords min-duration never overlaps adjacent cues
//   T9  full pipeline raw-collapse → sanitize → group
//   T10 run with insufficient space between valid neighbours: confined,
//       neighbour untouched, words flagged unplaced (no invented space)
//   T11 trailing run adjacent to the audio boundary (feasible + infeasible)
//   T12 missing stamps stay null (never coerced to 0); t=0 stays legal
//   T13 healthy stamps preserved (overlap is a rendering concern);
//       out-of-order starts repaired
//   T14 estimate diagnostics + transcript timing summary
import assert from 'node:assert';
import { sanitizeWords, whisperToTranscript } from '../app/assets/whisper-adapter.js';
import { groupWords } from '../app/assets/caption-renderer.js';

const grouping = { maxWords: 8, maxSeconds: 2, maxCharacters: 42 };

let _id = 0;
const W = (text, start, end) => ({ id: `t${_id++}`, text, start, end, deleted: false });

// Global sanity: starts non-decreasing, no word extends past the next
// word's start. Positive duration is required EXCEPT for `unplaced` words —
// a run whose bounded window is shorter than the run deliberately keeps
// zero-duration words instead of inventing space (see sanitizeWords docs).
function assertValid(words, label) {
    for (let k = 0; k < words.length; k++) {
        const w = words[k];
        if (w.unplaced === true) {
            assert.ok(w.end >= w.start,
                `${label}: unplaced word ${k} "${w.text}" end < start ` +
                `[${w.start}, ${w.end}]`);
            assert.ok(w.estimated === true,
                `${label}: unplaced word ${k} must carry estimated: true`);
        } else {
            assert.ok(w.end > w.start,
                `${label}: word ${k} "${w.text}" has non-positive duration ` +
                `[${w.start}, ${w.end}]`);
        }
        assert.ok(w.start >= 0, `${label}: word ${k} starts before 0: ${w.start}`);
        if (k + 1 < words.length) {
            assert.ok(words[k + 1].start >= w.start,
                `${label}: word ${k + 1} starts before word ${k}`);
            // Repaired words must never overrun the following word (that is
            // the whole point of the bounded window). Healthy words are
            // emitted untouched — the model occasionally stamps overlapping
            // words, which sanitize deliberately preserves (item 3).
            if (w.estimated === true) {
                assert.ok(w.end <= words[k + 1].start + 1e-9,
                    `${label}: repaired word ${k} "${w.text}" overruns next start ` +
                    `(${w.end} > ${words[k + 1].start})`);
            }
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
        for (let k = 0; k < out.length; k++) {
            assert.ok(Number.isFinite(out[k].start) && Number.isFinite(out[k].end),
                `T7 trial ${trial}: non-finite timestamp`);
            if (out[k].estimated) {
                // Repaired words are bounded by floor(audio duration) and
                // must never overrun a healthy neighbour (assertValid).
                assert.ok(out[k].end <= Math.floor(dur * 100) / 100 + 1e-9,
                    `T7 trial ${trial}: repaired word past audio end`);
            } else {
                // Healthy words are the model's own values, byte-identical.
                assert.strictEqual(out[k].start, words[k].start,
                    `T7 trial ${trial}: healthy word start modified`);
                assert.strictEqual(out[k].end, words[k].end,
                    `T7 trial ${trial}: healthy word end modified`);
            }
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

// ── T10: insufficient space between valid neighbours (item 1) ──────────
// A collapsed run squeezed between two healthy words with less room than
// the run needs. The OLD code expanded the run past the next word's start
// (min-duration fallback ignoring the upper bound). The repair must stay
// inside [prev.end, next.start], leave the neighbour untouched, and flag
// the honest outcome: the words are estimates AND unplaced.
{
    const words = [
        W('lead', 10.00, 10.05),
        W('a', 10.05, 10.05), W('b', 10.05, 10.05), W('c', 10.05, 10.05),
        W('d', 10.05, 10.05), W('e', 10.05, 10.05),
        W('next', 10.07, 10.60),
    ];
    const { words: out, repaired, unplaced } = sanitizeWords(words, 30);
    assert.strictEqual(repaired, 5, 'T10: expected 5 repaired');
    assert.strictEqual(unplaced, 5, 'T10: 2cs window for 5 words must be unplaced');
    assert.strictEqual(out[6].start, 10.07, 'T10: next valid word was pushed');
    assert.strictEqual(out[6].end, 10.60, 'T10: next valid word was modified');
    assert.ok(out[1].start >= 10.05 - 1e-9, 'T10: run starts before prev end');
    assert.ok(out[5].end <= 10.07 + 1e-9, 'T10: run overruns next word start');
    assert.ok(out.slice(1, 6).every(w => w.estimated === true && w.unplaced === true),
        'T10: unplaced run must carry estimated + unplaced flags');
    assert.ok(out.slice(1, 6).some(w => w.end === w.start),
        'T10: expected zero-duration words (no invented space)');
    assertValid(out, 'T10');
    console.log('T10 insufficient-space run confined + flagged unplaced: PASS');
}

// ── T11: trailing run adjacent to the audio boundary (item 1) ──────────
{
    // Feasible: 7cs window for 3 words — ends exactly AT the audio end.
    const mk = () => [
        W('last', 169.90, 169.98),
        W('hey', 169.98, 169.98), W('ho', 169.98, 169.98), W('hey', 169.98, 169.98),
    ];
    const fit = sanitizeWords(mk(), 170.05);
    assert.strictEqual(fit.repaired, 3, 'T11a: expected 3 repaired');
    assert.strictEqual(fit.unplaced, 0, 'T11a: 7cs/3 words is feasible');
    assert.ok(Math.abs(fit.words[3].end - 170.05) < 1e-9,
        `T11a: run must end exactly at audio end, got ${fit.words[3].end}`);
    assertValid(fit.words, 'T11a');

    // Infeasible: audio ends 1cs after the collapsed stamp — no room.
    const tight = sanitizeWords(mk(), 170.00);
    assert.strictEqual(tight.repaired, 3, 'T11b: expected 3 repaired');
    assert.strictEqual(tight.unplaced, 3, 'T11b: 2cs window for 3 words must be unplaced');
    assert.ok(tight.words[3].end <= 170.00 + 1e-9,
        `T11b: trailing run expanded past audio duration: ${tight.words[3].end} > 170.00`);
    assert.ok(tight.words.slice(1).every(w => w.estimated && w.unplaced === true),
        'T11b: honest estimate flags required');
    assertValid(tight.words, 'T11b');
    console.log('T11 trailing run bounded by audio end (feasible + infeasible): PASS');
}

// ── T12: missing stamps stay null, never coerced to 0 (item 2) ─────────
{
    // Regression: `w.timestamp?.[0] ?? 0` used to turn a MISSING start into
    // 0.0 — a legal timestamp — hiding the gap and pinning the word to t=0.
    const raw = {
        chunks: [{
            words: [
                { word: 'hello', timestamp: [1.0, 1.4] },
                { word: 'world', timestamp: [null, 3.0] },   // missing start, valid end
                { word: 'again', timestamp: [3.2, 3.8] },
            ],
        }],
    };
    const t = whisperToTranscript(raw, 10, 't.mp4', 'en');
    const bad = t.words[1];
    assert.strictEqual(bad.estimated, true, 'T12: missing start must be treated as invalid');
    assert.strictEqual(bad.estimatedReason, 'missing', 'T12: wrong reason');
    assert.ok(bad.start >= 1.4 - 1e-9 && bad.end <= 3.2 + 1e-9,
        `T12: repair must stay between healthy neighbours, got ${bad.start}-${bad.end}`);
    assert.strictEqual(bad.originalStart, null, 'T12: missing start must be preserved as null');
    assert.strictEqual(bad.originalEnd, 3.0, 'T12: valid end must be preserved for diagnostics');
    assert.strictEqual(t.repairedTimestamps, 1, 'T12: expected 1 repair reported');
    assert.strictEqual(t.timing.runs, 1, 'T12: expected 1 repair run');

    // A word with NO timestamp at all is invalid too (both null, not 0).
    const raw2 = {
        chunks: [{
            words: [
                { word: 'x', timestamp: [0.5, 1.0] },
                { word: 'y' },
                { word: 'z', timestamp: [2.0, 2.5] },
            ],
        }],
    };
    const t2 = whisperToTranscript(raw2, 10, 't.mp4', 'en');
    assert.strictEqual(t2.words[1].estimatedReason, 'missing');
    assert.ok(t2.words[1].start >= 1.0 - 1e-9 && t2.words[1].end <= 2.0 + 1e-9,
        'T12: null-stamped word must not be pinned to t=0');

    // A legitimate t=0 start must NOT be flagged.
    const raw3 = { chunks: [{ words: [{ word: 'zero', timestamp: [0, 0.5] }] }] };
    const t3 = whisperToTranscript(raw3, 10, 't.mp4', 'en');
    assert.strictEqual(t3.words[0].start, 0, 'T12: t=0 must pass through');
    assert.ok(t3.words[0].estimated === undefined, 'T12: t=0 wrongly flagged as estimate');
    assert.strictEqual(t3.repairedTimestamps, 0, 'T12: t=0 start triggered a repair');
    console.log('T12 missing stamps stay null; t=0 stays legal: PASS');
}

// ── T13: healthy timestamps are never modified (item 3) ────────────────
// sanitizeWords enforces positive durations, valid ORDER and in-audio
// starts — NOT non-overlap. Slight model overlap is a rendering concern
// (CaptionRenderer.groupWords resolves cue overlap); altering model data
// here would destroy accuracy the model actually had.
{
    const words = [
        W('five', 5.00, 6.00),
        W('overlap', 5.50, 5.90),   // inside the previous word: healthy-ish
        W('six', 6.20, 6.80),
    ];
    const r = sanitizeWords(words, 10);
    assert.strictEqual(r.repaired, 0, 'T13: overlapping-but-ordered words must not be rewritten');
    assert.strictEqual(JSON.stringify(r.words), JSON.stringify(words),
        'T13: healthy words must be emitted byte-identical');

    // A healthy word that runs past the (known) audio end keeps its model
    // value (start < dur ⇒ valid); the renderer clamps playback.
    const over = [W('tail', 9.50, 12.00)];
    const r2 = sanitizeWords(over, 10);
    assert.strictEqual(r2.repaired, 0, 'T13: end past audio end is not an invalid stamp');
    assert.strictEqual(r2.words[0].end, 12.00, 'T13: healthy end was clamped');

    // Out-of-order starts ARE invalid (grouping/highlight assume monotone).
    const bad = [
        W('a', 5.00, 6.00),
        W('b', 4.20, 4.70),
        W('c', 6.50, 7.00),
    ];
    const r3 = sanitizeWords(bad, 10);
    assert.strictEqual(r3.repaired, 1, 'T13: out-of-order word not repaired');
    assert.strictEqual(r3.words[1].estimatedReason, 'out-of-order');
    assert.ok(r3.words[1].start >= 6.00 - 1e-9 && r3.words[1].end <= 6.50 + 1e-9,
        'T13: out-of-order repair escaped the neighbour window');
    assertValid(r3.words, 'T13c');
    console.log('T13 healthy stamps preserved; order enforced, overlap not: PASS');
}

// ── T14: estimates carry diagnostics; transcript reports timing quality ─
{
    const words = [
        W('ok', 1.00, 1.50),
        W('bad', 2.00, 2.00),
        W('fine', 3.00, 3.50),
    ];
    const r = sanitizeWords(words, 10);
    assert.ok(r.words[0].estimated === undefined && r.words[2].estimated === undefined,
        'T14: healthy words must not carry estimate fields');
    const est = r.words[1];
    assert.strictEqual(est.estimated, true);
    assert.strictEqual(est.estimatedReason, 'collapsed');
    assert.strictEqual(est.originalStart, 2.00, 'T14: original model start not preserved');
    assert.strictEqual(est.originalEnd, 2.00, 'T14: original model end not preserved');
    assert.ok(est.start >= 1.50 - 1e-9 && est.end <= 3.00 + 1e-9, 'T14: estimate outside window');

    const t = whisperToTranscript({
        chunks: [{ words: [
            { word: 'a', timestamp: [1, 1] },        // collapsed
            { word: 'b', timestamp: [2, 2.5] },
        ] }],
    }, 10, 'x.mp4', 'en');
    assert.strictEqual(t.timing.hasEstimates, true);
    assert.strictEqual(t.timing.repaired, 1);
    assert.strictEqual(t.timing.estimated, 1);
    assert.strictEqual(t.timing.runs, 1);

    const clean = whisperToTranscript({
        chunks: [{ words: [{ word: 'a', timestamp: [1, 1.5] }] }],
    }, 10, 'x.mp4', 'en');
    assert.strictEqual(clean.timing.hasEstimates, false);
    assert.strictEqual(clean.timing.repaired, 0);
    console.log('T14 estimate diagnostics + transcript timing summary: PASS');
}

console.log('\nAll word-timestamp sanitize tests PASSED');
