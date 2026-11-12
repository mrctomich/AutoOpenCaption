/**
 * Phase 5a — planNewCaption / nextWordId (pure caption-creation planning).
 * No DOM, no App: the plan is data in, data out; the App funnel (5b) commits it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planNewCaption, nextWordId, DEFAULT_CAPTION_SEC } from '../app/assets/timeline-model.js';

const W = (id, start, end, extra = {}) => ({ id, text: id, start, end, deleted: false, ...extra });
const span = (r) => [r.word.start, r.word.end];

test('nextWordId: continues w#### max; covers splitWord date-style ids', () => {
    assert.equal(nextWordId([]), 'w0001');
    assert.equal(nextWordId(null), 'w0001');
    assert.equal(nextWordId([W('w0001', 0, 1), W('w0003', 1, 2)]), 'w0004');
    // splitWord injects large 6-digit ids — a plain count would collide
    assert.equal(nextWordId([W('w0002', 0, 1), W('w987654', 1, 2)]), 'w987655');
    // non-conforming ids are ignored for numbering but never reused
    assert.equal(nextWordId([{ id: 'zzz' }, W('w0007', 0, 1)]), 'w0008');
});

test('planNewCaption: empty transcript, defaults, flags, index 0', () => {
    const r = planNewCaption({ words: [], startSec: 10 });
    assert.equal(r.ok, true);
    assert.deepEqual(span(r), [10, 10 + DEFAULT_CAPTION_SEC]);
    assert.equal(r.word.id, 'w0001');
    assert.equal(r.word.text, '');
    assert.equal(r.word.deleted, false);
    assert.equal(r.word.userAdjusted, true);   // user-created ⇒ CTC never moves it
    assert.equal(r.word.estimated, false);
    assert.equal(r.word.origStart, r.word.start); // own span ⇒ never "modified"
    assert.equal(r.word.origEnd, r.word.end);
    assert.equal(r.index, 0);
    assert.equal(r.shrunk, false);
});

test('planNewCaption: never mutates the input words', () => {
    const words = [W('w0001', 0, 1), W('w0002', 2, 3)];
    const before = JSON.stringify(words);
    planNewCaption({ words, startSec: 1, endSec: 2 });
    planNewCaption({ words, startSec: 0.5, endSec: 2.5 });
    planNewCaption({ words, startSec: 0, endSec: 100, durationSec: 5 });
    assert.equal(JSON.stringify(words), before);
});

test('planNewCaption: sorted insert index lands between neighbours', () => {
    const words = [W('w0001', 0, 1), W('w0002', 4, 5), W('w0003', 8, 9)];
    assert.equal(planNewCaption({ words, startSec: 2 }).index, 1);
    assert.equal(planNewCaption({ words, startSec: 6 }).index, 2);
    assert.equal(planNewCaption({ words, startSec: 11 }).index, 3);
    // deleted words keep their array place for counting
    const withDel = [W('w0001', 0, 1), W('w0002', 2, 3, { deleted: true }), W('w0003', 6, 7)];
    assert.equal(planNewCaption({ words: withDel, startSec: 4 }).index, 2);
});

test('planNewCaption: end clamps to media duration; late click extends back', () => {
    const r = planNewCaption({ words: [], startSec: 9.6, durationSec: 10 });
    assert.deepEqual(span(r), [9.6, 10]);
    // click AT the end: full min-length caption pulled backwards
    const late = planNewCaption({ words: [], startSec: 10, durationSec: 10 });
    assert.equal(late.ok, true);
    assert.deepEqual(span(late), [10 - DEFAULT_CAPTION_SEC, 10]);
    // negative start clamps to 0
    assert.deepEqual(span(planNewCaption({ words: [], startSec: -3 })), [0, DEFAULT_CAPTION_SEC]);
    // non-finite start rejected
    assert.deepEqual(planNewCaption({ words: [], startSec: NaN }), { ok: false, reason: 'bad-start' });
    assert.equal(planNewCaption({ words: [], startSec: '5' }).ok, false);
});

test('planNewCaption: shrinks into the gap between neighbours', () => {
    const words = [W('w0001', 0, 2), W('w0002', 3, 5)];
    // requested 2.5→3.5: next word START at 3 pulls the end left
    const r = planNewCaption({ words, startSec: 2.5, endSec: 3.5 });
    assert.equal(r.ok, true);
    assert.deepEqual(span(r), [2.5, 3]);
    assert.equal(r.shrunk, true);
    // requested 1.5→3.5: word END at 2 pushes start right AND start-at-3 pulls end left
    const both = planNewCaption({ words, startSec: 1.5, endSec: 3.5 });
    assert.deepEqual(span(both), [2, 3]);
});

test('planNewCaption: deleted words do not block', () => {
    const words = [W('w0001', 0, 2), W('w0002', 2.2, 2.8, { deleted: true })];
    const r = planNewCaption({ words, startSec: 2, endSec: 3 });
    assert.equal(r.ok, true);
    assert.deepEqual(span(r), [2, 3]); // deleted timing ignored entirely
});

test('planNewCaption: no-room rejection inside dense runs', () => {
    const words = [W('w0001', 0, 2), W('w0002', 2.05, 4)];
    // gap 2→2.05 is < MIN_CAPTION_SEC
    assert.deepEqual(planNewCaption({ words, startSec: 2, endSec: 2.02 }), { ok: false, reason: 'no-room' });
    // fully covered span: a word containing it leaves no room
    assert.deepEqual(planNewCaption({ words: [W('w0001', 0, 10)], startSec: 3, endSec: 5 }),
                     { ok: false, reason: 'no-room' });
    // click inside a word (default 1 s span fully inside a 10 s word)
    assert.equal(planNewCaption({ words: [W('w0001', 0, 10)], startSec: 4 }).ok, false);
});

test('planNewCaption: adjacent captions may touch but never overlap', () => {
    const words = [W('w0001', 0, 2)];
    const r = planNewCaption({ words, startSec: 2 });
    assert.equal(r.ok, true);
    assert.equal(r.word.start, 2); // touching allowed
    assert.ok(r.word.end > r.word.start);
});

test('planNewCaption: id unique against the full existing set', () => {
    const words = [W('w0001', 0, 1), W('w999999', 4, 5)];
    const ids = new Set(words.map((w) => w.id));
    const r = planNewCaption({ words, startSec: 2 });
    assert.ok(!ids.has(r.word.id));
    assert.match(r.word.id, /^w\d{4,}$/);
});

test('planNewCaption: explicit text is carried verbatim', () => {
    const r = planNewCaption({ words: [], startSec: 1, text: 'HELLO, world — 世界' });
    assert.equal(r.word.text, 'HELLO, world — 世界');
});

test('planNewCaption: tolerate junk entries in the words array', () => {
    const words = [null, { id: 'x' }, W('w0001', 0, 1)];
    const r = planNewCaption({ words, startSec: 2 });
    assert.equal(r.ok, true);
    assert.deepEqual(span(r), [2, 3]);
});

test('planNewCaption: degenerate end==start restored to DEFAULT length', () => {
    const r = planNewCaption({ words: [], startSec: 5, endSec: 5 });
    assert.equal(r.ok, true);
    assert.ok(Math.abs((r.word.end - r.word.start) - DEFAULT_CAPTION_SEC) < 1e-9);
});
