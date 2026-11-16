/**
 * CaptionImport
 *
 * Parses a user-supplied caption file (SRT or WebVTT) into the app's
 * internal transcript model — the "bring your own captions" path that
 * replaces transcription for files that already exist.
 *
 * Honest-estimate contract (mirrors whisper-adapter's policy):
 *   SRT/VTT time WHOLE CUE BLOCKS, not words. Word timestamps inside a
 *   block are ESTIMATES (spread across the cue window, weighted by word
 *   length) — every imported word carries estimated:true with reason
 *   'caption-import' so the Word Editor shows the red attention outline
 *   until the user touches the word.
 *
 * Guarantees the downstream pipeline relies on:
 *   - word stream is monotone (start >= running max of previous ends),
 *     so caption groups can never overlap from import alone (same rule
 *     as applyCtcResult in ctc-apply.js);
 *   - the last word of a cue ends exactly on the cue end, the first one
 *     starts exactly on the cue start;
 *   - every word carries the origText/origStart/origEnd snapshot so the
 *     chip outline turns green once the user adjusts it.
 *
 * language stays null: imported captions are not a transcription, so the
 * English-only CTC realign gate (canCtcRealign) refuses them by design.
 */

// Timestamp token: optional hours, ',' (SRT) or '.' (VTT) before a 1-3
// digit fraction; VTT also allows short MM:SS.mmm forms.
const TS_TOKEN = String.raw`(\d{1,2}:)?([0-5]?\d):([0-5]\d)[.,](\d{1,3})`;
const TS_LINE = new RegExp(
    String.raw`^\s*${TS_TOKEN}\s*(?:-->|→)\s*${TS_TOKEN}\s*(.*)$`
);

function toSeconds(h, m, s, frac) {
    const hours = h ? parseInt(h.replace(/:$/, ''), 10) : 0;
    return hours * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10)
        + parseInt(frac.padEnd(3, '0').slice(0, 3), 10) / 1000;
}

const HTML_ENTITIES = {
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
    '&quot;': '"', '&#39;': "'", '&apos;': "'",
};

// Strip VTT/SRT inline markup (<i>, <v Speaker>, <c.class>, <00:00:01.5>)
// and decode the handful of entities caption files actually use.
function stripCaptionTags(text) {
    return text
        .replace(/<[^>]*>/g, '')
        .replace(/&(?:nbsp|amp|lt|gt|quot|#39|apos);/g, (m) => HTML_ENTITIES[m] ?? m)
        .trim();
}

/**
 * Parse SRT/WebVTT text into cue blocks. Tolerant by design (files come
 * from many tools): BOM, CRLF, optional cue identifiers, NOTE/STYLE/
 * REGION blocks, cue settings after the arrow, tags in text, cues in
 * arbitrary order. A line that merely looks corrupt is skipped, but if NO
 * usable cue survives the whole file is rejected — importing silence
 * instead of an error would read as "the app is broken".
 *
 * @param {string} text raw file text
 * @returns {{ format: 'srt'|'vtt', cues: Array<{start:number,end:number,text:string}>, skippedLines: number }}
 * @throws {Error} when no cue with a parseable timestamp + text is found
 */
export function parseCaptionFile(text) {
    if (typeof text !== 'string' || !text.trim()) {
        throw new Error('the file is empty');
    }
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    let format = 'srt';
    let i = 0;

    // VTT: mandatory WEBVTT header, optionally followed by a metadata
    // block; both are skipped before cue parsing starts.
    if (/^\s*WEBVTT(\s|$)/.test(lines[0] ?? '')) {
        format = 'vtt';
        while (i < lines.length && lines[i].trim() !== '') i++;
    }

    const cues = [];
    let skippedLines = 0;

    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) { i++; continue; }

        // VTT comment/style blocks span to the next blank line.
        if (/^(NOTE|STYLE|REGION|Voices)(\s|$|:)/.test(line)) {
            while (i < lines.length && lines[i].trim() !== '') i++;
            continue;
        }

        // Anything before the timestamp line (numeric SRT id, VTT cue id)
        // is skipped; if it is NOT followed by a timestamp the block is
        // corrupt text — skip the whole block instead of misparsing it.
        let m = TS_LINE.exec(line);
        if (!m) {
            const blockStart = i;
            i++;
            while (i < lines.length && lines[i].trim() !== '' && !TS_LINE.test(lines[i])) i++;
            m = TS_LINE.exec(lines[i] ?? '');
            if (!m) { skippedLines += i - blockStart; continue; }
        }

        const start = toSeconds(m[1], m[2], m[3], m[4]);
        const end = toSeconds(m[5], m[6], m[7], m[8]);
        // m[9] = cue settings (line:/position:/...) — layout hints we
        // intentionally drop; the app renders with its own style.
        i++;

        const textLines = [];
        while (i < lines.length && lines[i].trim() !== '') { i++; textLines.push(lines[i - 1]); }

        const cueText = stripCaptionTags(textLines.join(' '));
        if (!cueText) continue; // styling-only or empty cue — nothing to show
        if (!(end >= start)) { skippedLines++; continue; } // reversed time is unrecoverable
        cues.push({ start, end, text: cueText });
    }

    if (!cues.length) {
        throw new Error('no caption cues found — is this really an SRT or VTT file?');
    }
    return { format, cues, skippedLines };
}

/**
 * Turn cues into the app's flat word array. Cues are sorted forward and
 * clamped to a monotone stream (a cue starting inside its predecessor is
 * pushed to the predecessor's end — overlapping cues would leak into
 * export as double-cover, see ctc-apply.js for the same guard). Within a
 * cue, words get the block window spread over them weighted by word
 * length in whole milliseconds; a block shorter than 1 ms per word just
 * collapses toward the same instant (still monotone, still exported as
 * one readable cue thanks to the group minimum duration).
 *
 * @param {Array<{start:number,end:number,text:string}>} cues
 * @returns {{ words: object[], clampedCues: number }}
 */
export function cuesToTranscriptWords(cues) {
    let nextId = 0;
    const makeId = () => `i${String(nextId++).padStart(4, '0')}`;

    const sorted = cues
        .map((c, order) => ({ ...c, order }))
        .sort((a, b) => a.start - b.start || a.order - b.order);

    const words = [];
    let prevEnd = -Infinity;
    let clampedCues = 0;

    for (const cue of sorted) {
        let start = cue.start;
        let end = cue.end;
        if (start < prevEnd) { start = prevEnd; clampedCues++; }
        if (end < start) end = start;

        const tokens = cue.text.split(/\s+/).filter(Boolean);
        const weights = tokens.map((t) => Math.max(1, t.length));
        const totalW = weights.reduce((a, b) => a + b, 0);

        // Boundaries in whole ms, weighted, clamped into the cue window.
        const boundsMs = [Math.round(start * 1000)];
        let cum = 0;
        for (let k = 0; k < tokens.length; k++) {
            cum += weights[k];
            let b = Math.round(start * 1000 + (end - start) * 1000 * cum / totalW);
            if (b > Math.round(end * 1000)) b = Math.round(end * 1000);
            if (b < boundsMs[k]) b = boundsMs[k];
            boundsMs.push(b);
        }
        boundsMs[boundsMs.length - 1] = Math.round(end * 1000);

        for (let k = 0; k < tokens.length; k++) {
            words.push({
                id: makeId(),
                text: tokens[k],
                start: boundsMs[k] / 1000,
                end: boundsMs[k + 1] / 1000,
                deleted: false,
                estimated: true,
                estimatedReason: 'caption-import',
            });
        }
        // After the clamps above, end >= start >= prevEnd always holds.
        prevEnd = end;
    }
    return { words, clampedCues };
}

/**
 * Assemble the full transcript object from a parse result, in the exact
 * shape the rest of the app consumes (see whisper-adapter's internal
 * model). Every word gets the orig* snapshot (the chip-outline baseline)
 * and the transcript is marked imported so the CTC gate declines it.
 *
 * @param {{ format: string, cues: object[] }} parsed from parseCaptionFile
 * @param {{ sourceFile?: string }} options
 */
export function buildImportedTranscript(parsed, { sourceFile = '' } = {}) {
    const { words, clampedCues } = cuesToTranscriptWords(parsed.cues);
    for (const w of words) {
        w.origText = w.text;
        w.origStart = w.start;
        w.origEnd = w.end;
    }
    return {
        version: 1,
        sourceFile,
        language: null, // not a transcription — keeps the CTC realign gate closed
        imported: true,
        sourceFormat: parsed.format,
        words,
        repairedTimestamps: 0,
        timing: {
            repaired: 0,
            estimated: words.length,
            unplaced: 0,
            runs: 0,
            hasEstimates: true,
            importedCues: parsed.cues.length,
            clampedCues,
        },
    };
}
