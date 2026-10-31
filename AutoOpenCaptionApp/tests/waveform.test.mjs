/**
 * Timeline editor Phase 2 — waveform peak extraction / column aggregation
 * (app/assets/waveform.js). No DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createPeakBuilder, peaksFromSamples, peaksDuration, columnsFromPeaks,
    DEFAULT_BUCKET_SIZE,
} from '../app/assets/waveform.js';

const Q = 32767;

function naivePeaks(samples, bucket) {
    const count = Math.ceil(samples.length / bucket);
    const min = [], max = [];
    for (let b = 0; b < count; b++) {
        const end = Math.min((b + 1) * bucket, samples.length);
        let lo = Infinity, hi = -Infinity;
        for (let i = b * bucket; i < end; i++) {
            lo = Math.min(lo, samples[i]);
            hi = Math.max(hi, samples[i]);
        }
        min.push(lo); max.push(hi);
    }
    return { min, max, count };
}

test('peaksFromSamples: exact min/max per bucket incl. partial tail', () => {
    // Deterministic pseudo-random signal in [-1, 1], 1200 samples (2.34 buckets)
    const n = 1200;
    const samples = new Float32Array(n);
    let seed = 42;
    for (let i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        samples[i] = (seed / 2147483648) * 2 - 1;
    }
    const bucket = DEFAULT_BUCKET_SIZE;
    const p = peaksFromSamples(samples);
    const ref = naivePeaks(samples, bucket);
    assert.equal(p.count, ref.count);
    for (let b = 0; b < ref.count; b++) {
        assert.ok(Math.abs(p.min[b] / Q - ref.min[b]) <= 1.5 / Q, `bucket ${b} min`);
        assert.ok(Math.abs(p.max[b] / Q - ref.max[b]) <= 1.5 / Q, `bucket ${b} max`);
    }
    // Tail bucket only covers the remaining 176 samples
    assert.equal(p.count, 3);
    assert.ok(Math.abs(p.min[2] / Q - ref.min[2]) <= 1.5 / Q);
});

test('quantization: full-scale and silence', () => {
    const p = peaksFromSamples(new Float32Array([1, 0, -1, 0.5]), { bucketSize: 4 });
    assert.equal(p.count, 1);
    assert.equal(p.max[0], Q);
    assert.equal(p.min[0], -Q);
});

test('streaming feeds match one-shot for many chunk sizes', () => {
    const n = 40000;
    const samples = new Float32Array(n);
    let seed = 7;
    for (let i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        samples[i] = (seed / 2147483648) * 2 - 1;
    }
    const ref = peaksFromSamples(samples);
    for (const chunkSize of [1, 7, 511, 512, 513, 1000, 12345, n]) {
        const b = createPeakBuilder();
        for (let i = 0; i < n; i += chunkSize) {
            b.feed(samples.subarray(i, Math.min(i + chunkSize, n)));
        }
        const p = b.finish();
        assert.equal(p.count, ref.count, `chunk ${chunkSize} count`);
        assert.deepEqual(Array.from(p.min), Array.from(ref.min), `chunk ${chunkSize} min`);
        assert.deepEqual(Array.from(p.max), Array.from(ref.max), `chunk ${chunkSize} max`);
    }
});

test('snapshot mid-build exposes only complete buckets', () => {
    const b = createPeakBuilder({ bucketSize: 512 });
    b.feed(new Float32Array(1000));
    let snap = b.snapshot();
    assert.equal(snap.count, 1);        // buckets: 512 complete + 488 pending
    assert.equal(snap.builtSamples, 1000);
    b.feed(new Float32Array(24));       // completes the tail
    snap = b.finish();
    assert.equal(snap.count, 2);
});

test('peaksDuration reflects completed buckets', () => {
    const p = peaksFromSamples(new Float32Array(5120), { bucketSize: 512, sampleRate: 16000 });
    assert.equal(p.count, 10);
    assert.equal(peaksDuration(p), 0.32);
});

test('columnsFromPeaks: 1 px = 1 bucket maps exactly', () => {
    // pps such that samples-per-pixel == bucketSize: pps = 16000/512 = 31.25… no:
    // samplesPerPx = sampleRate / pps ⇒ pps = 16000 / 512 = 31.25 px/s? That's
    // 512 samples (0.032 s) per pixel ⇒ pps = 1/0.032 = 31.25.
    const bucket = 512, sr = 16000;
    const p = peaksFromSamples(
        new Float32Array(bucket * 20).map((_, i) => Math.sin(i / 50) * 0.8),
        { bucketSize: bucket, sampleRate: sr },
    );
    const vp = { viewStartSec: 0, pps: 31.25 };
    const { data, columns } = columnsFromPeaks(p, vp, 20);
    assert.equal(columns, 20);
    for (let c = 0; c < 20; c++) {
        assert.ok(Math.abs(data[c * 2] - p.min[c] / Q) < 1e-6, `col ${c} min`);
        assert.ok(Math.abs(data[c * 2 + 1] - p.max[c] / Q) < 1e-6, `col ${c} max`);
    }
});

test('columnsFromPeaks: zoom-out aggregates min-of-mins/max-of-maxes', () => {
    const bucket = 512, sr = 16000;
    // 4 buckets with distinct amplitudes
    const samples = new Float32Array(bucket * 4);
    for (let b = 0; b < 4; b++) {
        const amp = [0.1, 0.4, 0.2, 0.9][b];
        for (let i = 0; i < bucket; i++) samples[b * bucket + i] = (i % 2 ? amp : -amp);
    }
    const p = peaksFromSamples(samples, { bucketSize: bucket, sampleRate: sr });
    // pps halved vs 1:1 ⇒ 2 buckets per column
    const { data } = columnsFromPeaks(p, { viewStartSec: 0, pps: 15.625 }, 2);
    assert.ok(Math.abs(data[0] + 0.4) < 1e-3 && Math.abs(data[1] - 0.4) < 1e-3);  // buckets 0-1
    assert.ok(Math.abs(data[2] + 0.9) < 1e-3 && Math.abs(data[3] - 0.9) < 1e-3);  // buckets 2-3
});

test('columnsFromPeaks: zoom-in repeats the covering bucket', () => {
    const bucket = 512, sr = 16000;
    const samples = new Float32Array(bucket).fill(0.5);
    const p = peaksFromSamples(samples, { bucketSize: bucket, sampleRate: sr });
    // 2× zoom-in: 4 columns span the single 0.032 s bucket
    const { data, builtColumnsPx } = columnsFromPeaks(p, { viewStartSec: 0, pps: 125 }, 4);
    for (let c = 0; c < 4; c++) {
        assert.ok(Math.abs(data[c * 2 + 1] - 0.5) < 1e-3, `col ${c} max ≈ 0.5`);
    }
    assert.ok(builtColumnsPx >= 3);
});

test('columnsFromPeaks: partial build — tail is zero, builtColumnsPx exact', () => {
    const bucket = 512, sr = 16000;
    const b = createPeakBuilder({ bucketSize: bucket, sampleRate: sr });
    b.feed(new Float32Array(bucket * 10).fill(0.7)); // 0.32 s built
    const p = b.snapshot();
    // Window: 0..2 s at pps=10 ⇒ 1600 samples/px; px 0..2 fully built,
    // px 3 partially, px 4+ silent.
    const { data, builtColumnsPx } = columnsFromPeaks(p, { viewStartSec: 0, pps: 10 }, 8);
    assert.equal(builtColumnsPx, 3);
    assert.ok(Math.abs(data[3 * 2 + 1] - 0.7) < 1e-3);   // px 3 sees partial bucket data
    for (let c = 4; c < 8; c++) {
        assert.equal(data[c * 2], 0);
        assert.equal(data[c * 2 + 1], 0);
    }
});

test('columnsFromPeaks: panned window reads the right slice', () => {
    const bucket = 512, sr = 16000;
    const samples = new Float32Array(bucket * 4);
    samples.set(new Float32Array(bucket).fill(0.2), 0);
    samples.set(new Float32Array(bucket).fill(-0.3), bucket);
    for (let i = 0; i < bucket; i++) {
        samples[bucket * 2 + i] = (i % 2 ? 0.4 : -0.4);
        samples[bucket * 3 + i] = (i % 2 ? 0.5 : -0.5);
    }
    const p = peaksFromSamples(samples, { bucketSize: bucket, sampleRate: sr });
    // View starts at 0.064 s (= bucket 2) at 1 px/bucket
    const { data } = columnsFromPeaks(p, { viewStartSec: 0.064, pps: 31.25 }, 2);
    assert.ok(Math.abs(data[1] - 0.4) < 1e-3);
    assert.ok(Math.abs(data[0] + 0.4) < 1e-3); // bucket 2 alternates ±0.4
    assert.ok(Math.abs(data[2] + 0.5) < 1e-3 && Math.abs(data[3] - 0.5) < 1e-3); // bucket 3 ±0.5
});

test('columnsFromPeaks: empty input is all-silent, never throws', () => {
    const empty = { bucketSize: 512, sampleRate: 16000, count: 0, min: new Int16Array(0), max: new Int16Array(0), builtSamples: 0 };
    const r = columnsFromPeaks(empty, { viewStartSec: 0, pps: 31.25 }, 100);
    assert.equal(r.columns, 100);
    assert.equal(r.builtColumnsPx, 0);
    assert.ok(r.data.every(v => v === 0));
    assert.equal(columnsFromPeaks(empty, { viewStartSec: 0, pps: 0 }, 50).data.length, 100);
});
