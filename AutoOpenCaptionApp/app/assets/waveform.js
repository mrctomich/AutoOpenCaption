/**
 * Waveform peak extraction — pure logic (Phase 2 of the timeline editor).
 *
 * Input: the decoded 16 kHz mono Float32Array already cached by the app
 * (`App._audioCache.samples`) — no new decoding happens here.
 *
 * Strategy (per the timeline design doc): ONE fixed-bucket peak table
 * (default 512 samples ≈ 32 ms) storing min/max as Int16 — ~450 KB per
 * hour of audio, independent of zoom. Every zoom level aggregates the same
 * table; no multi-level pyramid (single level verified sufficient).
 */

export const DEFAULT_BUCKET_SIZE = 512;      // samples per peak bucket
export const DEFAULT_SAMPLE_RATE = 16000;    // matches extractAudio()
const Q = 32767;

function quantize(v) {
    if (Number.isNaN(v)) return 0;
    if (v <= -1) return -Q;
    if (v >= 1) return Q;
    return Math.round(v * Q);
}

/**
 * Incremental peak builder. Feed samples in arbitrary chunks (the UI builds
 * progressively in ~5 s slices to stay responsive); a partial bucket
 * carries across feeds. `snapshot()` is safe to call after every feed and
 * returns only COMPLETE buckets, so the view can draw while building.
 */
export function createPeakBuilder({ bucketSize = DEFAULT_BUCKET_SIZE, sampleRate = DEFAULT_SAMPLE_RATE } = {}) {
    if (!(bucketSize > 0) || !(sampleRate > 0)) throw new Error('bucketSize and sampleRate must be positive');

    const cap = 1 << 16; // grow geometrically below this, then double
    let min = new Int16Array(cap);
    let max = new Int16Array(cap);
    let count = 0;            // completed buckets
    let curMin = 0, curMax = 0;
    let curFilled = 0;
    let totalSamples = 0;

    function growIfNeeded() {
        if (count < min.length) return;
        const newLen = min.length * 2;
        const nMin = new Int16Array(newLen); nMin.set(min);
        const nMax = new Int16Array(newLen); nMax.set(max);
        min = nMin; max = nMax;
    }

    function closeBucket() {
        growIfNeeded();
        min[count] = curMin;
        max[count] = curMax;
        count++;
        curFilled = 0;
    }

    return {
        bucketSize,
        sampleRate,

        /** Append a Float32Array chunk. Returns total samples fed so far. */
        feed(chunk) {
            let i = 0;
            const n = chunk.length;
            totalSamples += n;
            while (i < n) {
                if (curFilled === 0) { curMin = Q; curMax = -Q; }
                const v = quantize(chunk[i]);
                if (v < curMin) curMin = v;
                if (v > curMax) curMax = v;
                curFilled++;
                i++;
                if (curFilled === bucketSize) closeBucket();
            }
            return totalSamples;
        },

        /** Finalize: flush a partial tail bucket (zero-padded min/max stay). */
        finish() {
            if (curFilled > 0) closeBucket();
            return this.snapshot();
        },

        /** Currently complete buckets only — callable mid-build. */
        snapshot() {
            return {
                bucketSize,
                sampleRate,
                count,
                min: min.subarray(0, count),
                max: max.subarray(0, count),
                builtSamples: totalSamples,
            };
        },
    };
}

/** One-shot convenience: full peak table for a complete sample array. */
export function peaksFromSamples(samples, opts = {}) {
    const b = createPeakBuilder(opts);
    b.feed(samples);
    return b.finish();
}

/** Duration in seconds covered by completed buckets. */
export function peaksDuration(peaks) {
    return peaks.count * peaks.bucketSize / peaks.sampleRate;
}

/**
 * Per-pixel-column min/max for drawing the waveform.
 *
 * @param peaks  snapshot from the builder / peaksFromSamples
 * @param viewport  { viewStartSec, pps } (seconds are the source of truth)
 * @param widthPx   number of device-independent columns to produce
 * @returns { data: Float32Array, columns: number, builtColumnsPx: number }
 *   `data` holds interleaved [min, max] pairs normalized to [-1, 1];
 *   `builtColumnsPx` = columns whose pixel range lies fully within built
 *   audio (later columns may be partially built; the view dims past it).
 */
export function columnsFromPeaks(peaks, viewport, widthPx) {
    const cols = Math.max(0, Math.floor(widthPx));
    const data = new Float32Array(cols * 2);
    if (cols === 0 || !(peaks.count > 0) || !(viewport.pps > 0)) {
        return { data, columns: cols, builtColumnsPx: 0 };
    }
    const { bucketSize, sampleRate, min, max, count } = peaks;
    const samplesPerPx = sampleRate / viewport.pps;   // audio samples per column
    const builtSample = peaks.builtSamples;

    let builtColumns = 0;
    for (let c = 0; c < cols; c++) {
        const sA = (viewport.viewStartSec + c / viewport.pps) * sampleRate;   // start sample of column
        const sB = sA + samplesPerPx;                                          // end sample (exclusive)
        if (sB <= 0 || sA >= builtSample) continue; // fully outside audio
        let b0 = Math.floor(Math.max(0, sA) / bucketSize);
        let b1 = Math.floor(Math.max(0, Math.min(sB - 1, builtSample - 1)) / bucketSize);
        if (b0 >= count) continue;
        if (b1 >= count) b1 = count - 1;
        let lo = 1, hi = -1;
        for (let b = b0; b <= b1; b++) {
            if (min[b] / Q < lo) lo = min[b] / Q;
            if (max[b] / Q > hi) hi = max[b] / Q;
        }
        data[c * 2] = lo;
        data[c * 2 + 1] = hi;
        if (sB <= builtSample) builtColumns = c + 1;
    }
    return { data, columns: cols, builtColumnsPx: builtColumns };
}
