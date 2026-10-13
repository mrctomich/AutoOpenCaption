/**
 * WhisperAdapter
 *
 * Converts Whisper pipeline output into the application's internal
 * transcript model. Handles multiple output schemas from different
 * Whisper ONNX exports:
 *
 *   Schema A (word-level):  chunks[].words[].{ word, timestamp }
 *   Schema B (segment-level): chunks[].{ text, timestamp }
 *   Schema C (no chunks):   { text } only
 *
 * Internal Transcript Model:
 *   { version, sourceFile, language, words: Word[] }
 *   Word = { id, text, start, end, deleted }
 */

let _nextId = 0;

function makeId() {
    return `w${String(_nextId++).padStart(4, '0')}`;
}

function splitSegmentToWords(text, start, end) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const duration = end - start;
    const timePerWord = duration / words.length;

    return words.map((word, i) => ({
        id: makeId(),
        text: word,
        start: start + i * timePerWord,
        end: start + (i + 1) * timePerWord,
        deleted: false
    }));
}

export function whisperToTranscript(result, audioDuration, sourceFile, language) {
    _nextId = 0;

    const words = [];

    if (result.chunks && result.chunks.length > 0) {
        result.chunks.forEach((chunk, ci) => {
            if (chunk.words && chunk.words.length > 0) {
                chunk.words.forEach(w => {
                    words.push({
                        id: makeId(),
                        text: w.word || w.text || '',
                        start: w.timestamp?.[0] ?? 0,
                        end: w.timestamp?.[1] ?? 0,
                        deleted: false
                    });
                });
            } else if (chunk.text && chunk.timestamp) {
                const chunkWords = splitSegmentToWords(
                    chunk.text,
                    chunk.timestamp[0],
                    chunk.timestamp[1]
                );
                words.push(...chunkWords);
            }
        });
    } else if (result.text) {
        const textWords = result.text.trim().split(/\s+/).filter(Boolean);
        const timePerWord = audioDuration / textWords.length;
        textWords.forEach((word, i) => {
            words.push({
                id: makeId(),
                text: word,
                start: Math.min(i * timePerWord, audioDuration),
                end: Math.min((i + 1) * timePerWord, audioDuration),
                deleted: false
            });
        });
    }

    return {
        version: 1,
        sourceFile: sourceFile,
        language: language,
        words: words
    };
}
