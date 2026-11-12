/**
 * splitWord must break BETWEEN words when the slot holds a phrase
 * (users type whole lines into one slot after missing auto-captioning),
 * and only cut a single word in half when there is nothing to break on.
 *
 * Same two-layer discipline as the other App-side suites:
 *  1. behavioral tests on the REAL splitWord extracted from app.js,
 *     invoked with a stub `this` (no DOM needed);
 *  2. source-level guards pinning the word-boundary-first structure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── extract the real function from app.js ─────────────────────────

const appSrc = readFileSync(
    fileURLToPath(new URL('../app/assets/app.js', import.meta.url)), 'utf8',
).replace(/\r\n/g, '\n'); // repo files are CRLF; normalize for needle matching

const SIG = 'splitWord(index) {';
const start = appSrc.indexOf(SIG);
assert.ok(start >= 0, 'splitWord not found in app.js');
const end = appSrc.indexOf('\n    },', start);
assert.ok(end > start, 'end of splitWord not found');
const src = appSrc.slice(start, end + '\n    }'.length);
const body = src.slice(src.indexOf(SIG) + SIG.length, src.lastIndexOf('}'));
const splitWord = new Function('return function (index) {' + body + '}')();

// ── 1. behavioral ──────────────────────────────────────────────────

function stubApp(words) {
    const calls = [];
    const app = {
        transcript: words ? { words: Array.isArray(words) ? words : [words] } : null,
        selectedWordIndex: 0,
        saveState: () => calls.push('saveState'),
        rebuildLayout: () => calls.push('rebuildLayout'),
        renderTranscriptEditor: () => calls.push('renderTranscriptEditor'),
        updateInspector: () => calls.push('updateInspector'),
        updatePreview: () => calls.push('updatePreview'),
    };
    return { app, calls };
}

const mkWord = (text, start = 0, endT = 10) => ({
    id: 'w0001', text, start, end: endT, deleted: false,
});

test('phrase slot splits at the space, never inside a word', () => {
    const word = mkWord('Hello world');
    const { app } = stubApp(word);
    splitWord.call(app, 0);
    assert.equal(app.transcript.words.length, 2);
    assert.equal(app.transcript.words[0].text, 'Hello');
    assert.equal(app.transcript.words[1].text, 'world');
});

test('multi-space phrase breaks at the space nearest the midpoint', () => {
    const word = mkWord('one two three four'); // len 18, target 9, spaces 3/7/13
    const { app } = stubApp(word);
    splitWord.call(app, 0);
    assert.equal(app.transcript.words[0].text, 'one two');
    assert.equal(app.transcript.words[1].text, 'three four');
});

test('single word slot still splits at the character midpoint', () => {
    const word = mkWord('abcdef'); // no spaces → halves
    const { app } = stubApp(word);
    splitWord.call(app, 0);
    assert.equal(app.transcript.words[0].text, 'abc');
    assert.equal(app.transcript.words[1].text, 'def');
});

test('split timing stays proportional to character counts', () => {
    const word = mkWord('Hello world', 0, 10); // space at index 5, len 11
    const { app } = stubApp(word);
    splitWord.call(app, 0);
    const [a, b] = app.transcript.words;
    const expected = 10 * (5.5 / 11); // 5.0
    assert.ok(Math.abs(a.end - expected) < 1e-9, `a.end=${a.end}`);
    assert.equal(b.start, a.end);
    assert.equal(a.start, 0);
    assert.equal(b.end, 10);
});

test('leading/trailing and doubled spaces are normalized, not orphaned', () => {
    const word = mkWord('  hello   world  ');
    const { app } = stubApp(word);
    splitWord.call(app, 0);
    assert.equal(app.transcript.words[0].text, 'hello');
    assert.equal(app.transcript.words[1].text, 'world');
});

test('repeated splitting of a phrase never cuts a word while spaces remain', () => {
    const { app } = stubApp(mkWord('the quick brown fox jumps'));
    for (let guard = 0; guard < 10; guard++) {
        const idx = app.transcript.words.findIndex(w => w.text.includes(' '));
        if (idx < 0) break;
        splitWord.call(app, idx);
        for (const w of app.transcript.words) {
            assert.ok(!/\s/.test(w.text.trim()) || w.text.includes(' '),
                `half-word produced: '${w.text}'`);
            assert.ok(!/^\s|\s$/.test(w.text), `untrimmed half: '${w.text}'`);
        }
    }
    assert.deepEqual(app.transcript.words.map(w => w.text),
        ['the', 'quick', 'brown', 'fox', 'jumps']);
});

test('metadata: first half keeps id, second gets fresh w######; both userAdjusted', () => {
    const word = { ...mkWord('two words'), estimated: 'segment-split', origStart: 1 };
    const { app } = stubApp(word);
    splitWord.call(app, 0);
    const [a, b] = app.transcript.words;
    assert.equal(a.id, 'w0001');
    assert.match(b.id, /^w\d{6}$/);
    assert.notEqual(a.id, b.id);
    assert.equal(a.userAdjusted, true);
    assert.equal(b.userAdjusted, true);
    assert.equal(b.estimated, 'segment-split'); // spread keeps metadata
    assert.equal(b.origStart, 1);
});

test('guards: unbreakable text / no transcript / bad index never mutate or save', () => {
    const a = stubApp(mkWord('x'));
    splitWord.call(a.app, 0);
    assert.equal(a.app.transcript.words.length, 1);
    assert.equal(a.calls.length, 0);

    const blank = stubApp(mkWord('   '));
    splitWord.call(blank.app, 0);
    assert.equal(blank.calls.length, 0);

    const b = stubApp(null);
    splitWord.call(b.app, 0);
    assert.equal(b.calls.length, 0);

    const c = stubApp(mkWord('hello there'));
    splitWord.call(c.app, 7); // no such word
    assert.equal(c.app.transcript.words.length, 1);
    assert.equal(c.calls.length, 0);
});

test('a real split saves undo exactly once and refreshes downstream', () => {
    const { app, calls } = stubApp(mkWord('one two'));
    splitWord.call(app, 0);
    assert.equal(calls.filter(c => c === 'saveState').length, 1);
    for (const c of ['rebuildLayout', 'renderTranscriptEditor',
        'updateInspector', 'updatePreview']) {
        assert.ok(calls.includes(c), `must call ${c}`);
    }
});

// ── 2. source guards ───────────────────────────────────────────────

test('word-boundary path takes precedence over the character midpoint', () => {
    assert.match(src, /const text = word\.text\.trim\(\)\.replace\(\/\\s\+\/g, ' '\)/);
    // Nearest-space selection comes BEFORE the single-word fallback.
    const nearestAt = src.search(/Math\.abs\(s - target\)/);
    const fallbackAt = src.indexOf('Math.floor(text.length / 2)');
    assert.ok(nearestAt > 0, 'nearest-space selection missing');
    assert.ok(fallbackAt > nearestAt, 'character midpoint must be the fallback branch');
    // The space branch must gate the midpoint split: it lives in the else.
    assert.match(src, /if \(spaces\.length > 0\) \{[\s\S]*?\} else \{[\s\S]*?Math\.floor\(text\.length \/ 2\)/);
});

test('splits stay one saveState after all guards, before mutation', () => {
    const saveAt = src.indexOf('this.saveState();');
    assert.ok(saveAt > 0);
    assert.equal(src.indexOf('this.saveState();', saveAt + 1), -1,
        'splitWord must saveState exactly once');
    assert.ok(saveAt < src.indexOf('this.transcript.words.splice('),
        'saveState must happen before mutation');
});
