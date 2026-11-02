// Phase 5f browser QA: the CREATE paths in the real browser (Phase 5 closeout).
// S1 toolbar + button: gated on transcript, creates at the PLAYHEAD behind one
//    save; new word is user data from birth (userAdjusted, orig*=own span).
// S2 empty-lane dbl-click creates at the cursor time; dbl-click on an EXISTING
//    box still selects+seeks (no create); no-room rejects with zero writes.
// S3 rapid mixed gestures (create → drag → F2 text edit) → one save each,
//    staged LIFO undo unwinds exactly one gesture per undo, redo re-applies.
//    Escape in F2 edit cancels without a save.
// S4 unique-id audit: fresh ids continue max numeric suffix (w251032 after a
//    seeded date-style w251031), all ids unique after a create burst.
// S5 export reflection: fresh captions appear as cues in SRT/VTT (empty text
//    line before typing, typed text after), SRT/VTT parity, display pane clean.
// Headless Chrome via playwright-core. Run from a dir whose node_modules has
// playwright-core, with SCRATCH env = native C:/ path holding tl_clip_60.mp4.
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = 'E:/CodingProjects/AutoCaption3';
const CLIP = process.env.SCRATCH + '/tl_clip_60.mp4';
const PORT = 8749;

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.mp4':'video/mp4', '.wasm':'application/wasm',
  '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const path_join = (a,b) => path.join(a, b.replace(/^\//,''));
const path_ext = (f) => path.extname(f).toLowerCase();
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/tl_clip_60.mp4') {
    res.writeHead(200, {'Access-Control-Allow-Origin':'*','Content-Type':'video/mp4'});
    fs.createReadStream(CLIP).pipe(res); return;
  }
  fs.readFile(path_join(ROOT, p), (e, buf) => {
    if (e) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, {'Access-Control-Allow-Origin':'*','Cross-Origin-Resource-Policy':'cross-origin','Content-Type': MIME[path_ext(path_join(ROOT,p))] || 'application/octet-stream'});
    res.end(buf);
  });
});

const out = [];
const ok = (name, cond, extra='') => { out.push((cond?'PASS':'FAIL') + ' | ' + name + (extra?' | '+extra:'')); };

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => out.push('PAGEERROR | ' + e.message));
  await page.goto(`http://127.0.0.1:${PORT}/AutoOpenCaptionApp/app/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.App && App.timeline, null, { timeout: 60000 });

  await page.evaluate(async () => {
    const resp = await fetch('http://127.0.0.1:8749/tl_clip_60.mp4');
    const blob = await resp.blob();
    App.loadVideo(new File([blob], 'tl_clip_60.mp4', { type: 'video/mp4' }));
  });
  await page.waitForFunction(() => App.video && App.video.duration > 0, null, { timeout: 30000 });

  // ── S0 button gating (before any transcript) ──────────────────────────
  ok('S0 add-caption button disabled with no transcript',
     await page.evaluate(() => document.getElementById('btn-tl-add-caption').disabled === true));

  const mk = (id, text, s, e) => ({ id, text, start: s, end: e, deleted: false,
    origStart: s, origEnd: e, originalStart: s, originalEnd: e,
    estimated: true, estimatedStart: s, estimatedEnd: e });
  const base4 = () => [ mk('w0','Alpha',1.0,1.4), mk('w1','bravo.',3.0,3.4),
                        mk('w2','Charlie',5.0,5.4), mk('w3','delta.',8.0,8.6) ];

  await page.evaluate((ws) => {
    App.transcript = { words: ws, language: 'en' };
    App.style.grouping = { maxWords: 2, maxSeconds: 0.9, maxCharacters: 32 };
    App.rebuildLayout();
    App.renderTranscriptEditor();
    App.timeline.invalidate();
  }, base4());
  await page.waitForTimeout(400);
  ok('S0 add-caption button enabled once a transcript exists',
     await page.evaluate(() => document.getElementById('btn-tl-add-caption').disabled === false));

  // Instrument WITHOUT bypassing the funnel (4d lesson: never replace the
  // hooks) — count funnel create calls + their results, and saves.
  await page.evaluate(() => {
    window.__adds = 0; window.__addResults = []; window.__saves = 0;
    const origAdd = App.addCaptionAt.bind(App);
    App.addCaptionAt = (opts) => {
      window.__adds++;
      const r = origAdd(opts);
      window.__addResults.push(r);
      return r;
    };
    const origSave = App.saveState.bind(App);
    App.saveState = () => { window.__saves++; return origSave(); };
    App.timeline.viewport = { ...App.timeline.viewport, pps: 100, fitMode: 'manual', viewStartSec: 0 };
    App.timeline.invalidate();
  });
  await page.waitForTimeout(300);

  const fullSnap = () => page.evaluate(() =>
    JSON.stringify(App.transcript.words.map(w => ({ id: w.id, t: w.text, s: w.start, e: w.end,
      us: w.userAdjusted, est: w.estimated, d: w.deleted, os: w.origStart, oe: w.origEnd }))));
  const counts = () => page.evaluate(() => ({ adds: window.__adds, saves: window.__saves }));
  const wordCount = () => page.evaluate(() => App.transcript.words.length);

  // Geometry: lane y for a box by word text + canvas rect for time→x math.
  const geo = (texts) => page.evaluate((ts) => {
    const tl = App.timeline, r = tl.canvas.getBoundingClientRect();
    tl._refreshLanes(tl.canvas.clientHeight);
    const res = { _r: { left: r.left, top: r.top }, _laneTop: tl._laneTop,
                  _viewStart: tl.viewport.viewStartSec, _pps: tl.viewport.pps };
    for (const t of ts) {
      const b = tl._laneBoxes.find(b => (b.group.words || []).some(w => w.text === t));
      if (!b) continue;
      res[t] = { x: r.left + b.x + b.w / 2, y: r.top + tl._laneTop + (tl._laneOf[b.index] || 0) * 22 + 11,
                 bx: r.left + b.x, bw: b.w };
    }
    return res;
  }, texts);
  // Viewport x/y for an arbitrary TIME on the first lane row (empty spot ok).
  const spotAt = (t) => page.evaluate((tt) => {
    const tl = App.timeline, r = tl.canvas.getBoundingClientRect();
    return { x: r.left + (tt - tl.viewport.viewStartSec) * tl.viewport.pps,
             y: r.top + tl._laneTop + 11 };
  }, t);

  const data0 = await fullSnap();
  ok('setup: 4 base words @ 100 pps on 60 s media',
     (await wordCount()) === 4 && (await page.evaluate(() => App.timeline.viewport.durationSec)) > 59);

  // ── S1 TOOLBAR + BUTTON → CREATE AT PLAYHEAD ─────────────────────────
  let c0 = await counts();
  await page.evaluate(() => { App.video.currentTime = 20.4; });
  await page.click('#btn-tl-add-caption');
  await page.waitForTimeout(250);
  let c = await counts();
  const s1 = await page.evaluate(() => {
    const w = App.transcript.words.find(w => w.start > 19 && w.start < 21);
    return { n: App.transcript.words.length, idx: App.selectedWordIndex,
      w: w && { id: w.id, t: w.text, s: w.start, e: w.end, us: w.userAdjusted,
                est: w.estimated, os: w.origStart, oe: w.origEnd },
      vt: App.video.currentTime };
  });
  ok('S1 button creates one word at the playhead (20.4 → 20.4–21.4)',
     s1.n === 5 && s1.w && Math.abs(s1.w.s - 20.4) < 0.01 && Math.abs(s1.w.e - 21.4) < 0.01, JSON.stringify(s1));
  ok('S1 exactly one funnel create + one save',
     c.adds === c0.adds + 1 && c.saves === c0.saves + 1, JSON.stringify(c));
  ok('S1 new word is user data from birth (userAdjusted, not estimated, orig*=own span)',
     s1.w && s1.w.us === true && s1.w.est === false && s1.w.os === s1.w.s && s1.w.oe === s1.w.e, JSON.stringify(s1.w));
  ok('S1 new word selected, playhead not moved by selection',
     s1.idx >= 0 && Math.abs(s1.vt - 20.4) < 0.05, JSON.stringify({ idx: s1.idx, vt: s1.vt }));

  // ── S2 EMPTY-LANE DBL-CLICK CREATE / BOX DBL-CLICK STILL SELECTS ─────
  c0 = await counts();
  const gA = await spotAt(11.0);
  await page.mouse.dblclick(gA.x, gA.y);
  await page.waitForTimeout(250);
  c = await counts();
  const s2 = await page.evaluate(() => {
    const w = App.transcript.words.find(w => w.start > 10 && w.start < 12);
    return { n: App.transcript.words.length,
      w: w && { id: w.id, s: w.start, e: w.end, us: w.userAdjusted } };
  });
  ok('S2 empty-lane dbl-click creates at cursor time (11.0, ±1px)',
     s2.n === 6 && s2.w && Math.abs(s2.w.s - 11.0) < 0.02 && Math.abs(s2.w.e - (s2.w.s + 1.0)) < 0.02, JSON.stringify(s2));
  ok('S2 one funnel create + one save',
     c.adds === c0.adds + 1 && c.saves === c0.saves + 1, JSON.stringify(c));

  // Dbl-click an EXISTING box: select + seek, NOT create.
  c0 = await counts();
  const gD = await geo(['delta.']);
  await page.mouse.dblclick(gD['delta.'].x, gD['delta.'].y);
  await page.waitForTimeout(250);
  c = await counts();
  const s2b = await page.evaluate(() => ({ n: App.transcript.words.length,
    vt: App.video.currentTime, idx: App.selectedWordIndex }));
  ok('S2 dbl-click on existing box selects+seeks, creates nothing',
     s2b.n === 6 && (await counts()).adds === c0.adds && Math.abs(s2b.vt - 8.0) < 0.05, JSON.stringify(s2b));

  // No-room: dbl-click exactly on Charlie's start (span collapses) → reject.
  c0 = await counts();
  const s2c = await page.evaluate(() => {
    const r = App.addCaptionAt({ startSec: 5.0 }); // Charlie 5.0..5.4 kills the span
    return { r, n: App.transcript.words.length };
  });
  c = await counts();
  ok('S2 no-room rejected: false, zero words added, zero saves',
     s2c.r === false && s2c.n === 6 && c.adds === c0.adds + 1 && c.saves === c0.saves, JSON.stringify({ ...s2c, ...c }));

  // ── S3 RAPID MIXED GESTURES: create → drag → F2 edit, LIFO ───────────
  const a0 = await fullSnap();
  // g1: create at 30 s (large empty gap; delta. untouched).
  c0 = await counts();
  await page.evaluate(() => App.addCaptionAt({ startSec: 30 }));
  await page.waitForTimeout(150);
  c = await counts();
  const freshIdx = await page.evaluate(() => App.transcript.words.findIndex(w => Math.abs(w.start - 30) < 0.01));
  ok('S3 g1 create: +1 word, +1 save, new word selected',
     c.adds === c0.adds + 1 && c.saves === c0.saves + 1 && freshIdx >= 0
     && (await page.evaluate(() => App.selectedWordIndex)) === freshIdx, JSON.stringify({ ...c, freshIdx }));
  const a1 = await fullSnap();

  // g2: drag Alpha box −0.6 s (−60 px @ pps 100) back-to-back.
  c0 = await counts();
  const gAl = await geo(['Alpha']);
  await page.mouse.move(gAl.Alpha.x, gAl.Alpha.y);
  await page.mouse.down();
  await page.mouse.move(gAl.Alpha.x - 60, gAl.Alpha.y, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  c = await counts();
  const s3drag = await page.evaluate(() => [App.transcript.words[0].start, App.transcript.words[0].end]);
  ok('S3 g2 drag: Alpha committed 0.4..0.8, one save',
     c.saves === c0.saves + 1 && Math.abs(s3drag[0] - 0.4) < 0.02 && Math.abs(s3drag[1] - 0.8) < 0.02, JSON.stringify({ ...c, s3drag }));
  const a2 = await fullSnap();

  // g3: F2 text edit on the fresh word (still selected from g1).
  c0 = await counts();
  await page.evaluate(() => App.selectWord(-1));
  await page.evaluate((i) => App.selectWord(i, { seek: false }), freshIdx);
  await page.keyboard.press('F2');
  await page.waitForTimeout(200);
  const editActive = await page.evaluate((i) => {
    const chip = document.querySelector(`#word-selector [data-index="${i}"] .word-text`);
    return chip && chip.contentEditable === 'true';
  }, freshIdx);
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  c = await counts();
  const s3text = await page.evaluate((i) => App.transcript.words[i].text, freshIdx);
  ok('S3 g3 F2 opened contentEditable on the fresh word', editActive === true);
  ok('S3 g3 typed text committed, one save',
     s3text === 'hello' && c.saves === c0.saves + 1, JSON.stringify({ ...c, s3text }));
  const a3 = await fullSnap();

  // Staged LIFO undo: each undo unwinds exactly the last gesture.
  await page.evaluate(() => App.undo());
  ok('S3 undo #1 reverts ONLY the text edit (word still created, Alpha still moved)',
     (await fullSnap()) === a2);
  await page.evaluate(() => App.undo());
  ok('S3 undo #2 reverts ONLY the drag', (await fullSnap()) === a1);
  await page.evaluate(() => App.undo());
  ok('S3 undo #3 reverts the create (word count back to 6)',
     (await fullSnap()) === a0 && (await wordCount()) === 6);
  // Redo re-applies in order.
  await page.evaluate(() => { App.redo(); App.redo(); App.redo(); });
  await page.waitForTimeout(200);
  ok('S3 redo ×3 restores the full mixed state', (await fullSnap()) === a3);

  // Escape in F2 edit: cancel, no save, no text change.
  c0 = await counts();
  await page.evaluate((i) => App.selectWord(i, { seek: false }), freshIdx);
  await page.keyboard.press('F2');
  await page.waitForTimeout(150);
  await page.keyboard.type('xyz');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  c = await counts();
  const s3esc = await page.evaluate((i) => App.transcript.words[i].text, freshIdx);
  ok('S3 Escape cancels the edit: text stays "hello", zero saves',
     s3esc === 'hello' && c.saves === c0.saves, JSON.stringify({ ...c, s3esc }));

  // ── S4 UNIQUE-ID AUDIT (date-style ids included) ─────────────────────
  await page.evaluate((ws) => {
    App.transcript = { words: ws, language: 'en' };
    App.rebuildLayout(); App.renderTranscriptEditor(); App.timeline.invalidate();
  }, [ mk('w0','one',1.0,1.4), mk('w251031','two',5.0,5.4),
       mk('x9','three',9.0,9.4), mk('w7','four',13.0,13.4) ]);
  await page.waitForTimeout(300);
  const s4 = await page.evaluate(() => {
    const r = [App.addCaptionAt({ startSec: 3.0 }), App.addCaptionAt({ startSec: 7.0 }), App.addCaptionAt({ startSec: 11.0 })];
    const ids = App.transcript.words.map(w => w.id);
    return { r, ids, unique: new Set(ids).size, n: ids.length };
  });
  ok('S4 three creates all succeed, 7 words, all ids unique',
     s4.r.every(x => x === true) && s4.n === 7 && s4.unique === 7, JSON.stringify(s4));
  ok('S4 fresh ids continue the MAX numeric suffix (w251032/33/34, not w4)',
     s4.ids.includes('w251032') && s4.ids.includes('w251033') && s4.ids.includes('w251034'), JSON.stringify(s4.ids));

  // ── S5 EXPORT REFLECTION (SRT / VTT / display pane) ───────────────────
  await page.evaluate((ws) => {
    App.transcript = { words: ws, language: 'en' };
    App.style.grouping = { maxWords: 2, maxSeconds: 0.9, maxCharacters: 32 };
    App.rebuildLayout(); App.renderTranscriptEditor(); App.renderTranscriptDisplay();
    App.timeline.invalidate();
  }, base4());
  await page.waitForTimeout(300);
  // Fresh EMPTY caption (no typing) must still be a cue — empty text line.
  await page.evaluate(() => App.addCaptionAt({ startSec: 20 }));
  await page.waitForTimeout(200);
  const s5a = await page.evaluate(() => {
    const srt = App.generateSRT();
    const cues = srt.split('\n\n');
    const fresh = cues.find(b => /^00:00:20,000 -->/.test(b.split('\n')[1] || ''));
    const lines = fresh ? fresh.split('\n') : [];
    return { cues: cues.length, groups: App.captionGroups.length,
             freshFound: !!fresh, freshThird: lines.length === 3 ? lines[2] : null,
             dblSpace: / {2}/.test(srt), leadWs: srt.split('\n').some(l => /^\s+\S/.test(l)) };
  });
  ok('S5 empty fresh caption exports as a cue with an empty text line',
     s5a.freshFound && s5a.freshThird === '' && s5a.cues === s5a.groups, JSON.stringify(s5a));
  ok('S5 SRT clean: no double/leading spaces on any line',
     s5a.dblSpace === false && s5a.leadWs === false);
  // Type into the fresh word via the real F2 path, then re-check exports.
  const freshIdx2 = await page.evaluate(() => App.transcript.words.findIndex(w => Math.abs(w.start - 20) < 0.01));
  await page.evaluate((i) => App.selectWord(i, { seek: false }), freshIdx2);
  await page.keyboard.press('F2');
  await page.waitForTimeout(150);
  await page.keyboard.type('fresh caption');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const s5b = await page.evaluate(() => {
    const srt = App.generateSRT(), vtt = App.generateVTT();
    const srtTexts = srt.split('\n\n').map(b => b.split('\n').slice(2).join(' '));
    const vttTexts = vtt.replace(/^WEBVTT\n\n/, '').split('\n\n').map(b => b.split('\n').slice(1).join(' '));
    const display = document.getElementById('transcript-text').textContent;
    return { has: srt.includes('fresh caption'), srt: srtTexts, vtt: vttTexts,
             display, dblSpace: / {2}/.test(srt + vtt + display) };
  });
  ok('S5 typed fresh text appears in SRT cue', s5b.has === true);
  ok('S5 SRT/VTT cue-text parity (shared joinWordTexts)',
     JSON.stringify(s5b.srt) === JSON.stringify(s5b.vtt), JSON.stringify({ srt: s5b.srt, vtt: s5b.vtt }));
  ok('S5 display pane contains fresh text, no double spaces',
     s5b.display.includes('fresh caption') && s5b.dblSpace === false, JSON.stringify(s5b.display));

  // Inspector text path must refresh the display pane too (5f bug fix #2).
  await page.evaluate((i) => {
    App.selectWord(i, { seek: false });
    const inp = document.getElementById('inspector-text');
    inp.value = 'inspected edit';
    inp.dispatchEvent(new Event('change'));
  }, freshIdx2);
  await page.waitForTimeout(250);
  const s5c = await page.evaluate(() => ({
    t: App.transcript.words.find(w => Math.abs(w.start - 20) < 0.01).text,
    display: document.getElementById('transcript-text').textContent }));
  ok('S5 inspector text edit refreshes display pane',
     s5c.t === 'inspected edit' && s5c.display.includes('inspected edit'), JSON.stringify(s5c));

  // ── FINAL INVARIANTS ──────────────────────────────────────────────────
  ok('final: ghost cleared', await page.evaluate(() => App.timeline._ghost === null));
  ok('final: no page errors', !out.some(l => l.startsWith('PAGEERROR')));
  await page.screenshot({ path: process.env.SCRATCH + '/phase5f_final.png' });

  console.log(out.join('\n'));
  await browser.close();
  server.close();
  process.exit(out.some(l => l.startsWith('FAIL') || l.startsWith('PAGEERROR')) ? 1 : 0);
})().catch(e => { console.log(out.join('\n')); console.error('HARNESS ERROR', e); process.exit(2); });
