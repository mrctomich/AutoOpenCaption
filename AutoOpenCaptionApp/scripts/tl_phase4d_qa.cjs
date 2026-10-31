// Phase 4d browser QA: the mutation funnel. A released gesture must COMMIT
// to transcript.words through App.applyTimelineEdit: exactly one saveState()
// per committed gesture, only start/end/userAdjusted written, zero-delta and
// returned-to-origin drags no-op (no undo save), undo() restores the pre-edit
// snapshot, and a group-count change fires the R3 note path.
// Headless Chrome via playwright-core. Run from a dir whose node_modules has
// playwright-core, with SCRATCH env = native C:/ path holding tl_clip.mp4.
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = 'E:/CodingProjects/AutoCaption3';
const CLIP = process.env.SCRATCH + '/tl_clip.mp4';
const PORT = 8747;

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.mp4':'video/mp4', '.wasm':'application/wasm',
  '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const path_join = (a,b) => path.join(a, b.replace(/^\//,''));
const path_ext = (f) => path.extname(f).toLowerCase();
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/tl_clip.mp4') {
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
    const resp = await fetch('http://127.0.0.1:8747/tl_clip.mp4');
    const blob = await resp.blob();
    App.loadVideo(new File([blob], 'tl_clip.mp4', { type: 'video/mp4' }));
  });
  await page.waitForFunction(() => App.video && App.video.duration > 0, null, { timeout: 30000 });

  // Four separate groups (gaps 1.6–2.6 s > maxSeconds) so a merge is provable.
  // Side fields (orig*/original*/estimated*/deleted) ride along for R2 checks.
  const words = [
    { id: 'w0', text: 'Alpha',   start: 1.0, end: 1.4, deleted: false,
      origStart: 1.0, origEnd: 1.4, originalStart: 1.0, originalEnd: 1.4,
      estimated: true, estimatedStart: 1.0, estimatedEnd: 1.4 },
    { id: 'w1', text: 'bravo.',  start: 3.0, end: 3.4, deleted: false,
      origStart: 3.0, origEnd: 3.4, originalStart: 3.0, originalEnd: 3.4,
      estimated: true, estimatedStart: 3.0, estimatedEnd: 3.4 },
    { id: 'w2', text: 'Charlie', start: 5.0, end: 5.4, deleted: false,
      origStart: 5.0, origEnd: 5.4, originalStart: 5.0, originalEnd: 5.4,
      estimated: true, estimatedStart: 5.0, estimatedEnd: 5.4 },
    { id: 'w3', text: 'delta.',  start: 8.0, end: 8.6, deleted: false,
      origStart: 8.0, origEnd: 8.6, originalStart: 8.0, originalEnd: 8.6,
      estimated: true, estimatedStart: 8.0, estimatedEnd: 8.6 },
  ];
  await page.evaluate((ws) => {
    App.transcript = { words: ws, language: 'en' };
    App.style.grouping = { maxWords: 2, maxSeconds: 0.9, maxCharacters: 32 };
    App.rebuildLayout();
    App.renderTranscriptEditor();
    App.timeline.invalidate();
  }, words);
  await page.waitForTimeout(400);

  // Instrument WITHOUT bypassing the funnel: count real funnel invocations
  // and real undo saves; the view keeps calling App.applyTimelineEdit itself.
  await page.evaluate(() => {
    window.__applied = 0; window.__saves = 0; window.__last = null;
    const origApply = App.applyTimelineEdit.bind(App);
    App.applyTimelineEdit = (info) => {
      window.__applied++;
      window.__last = { kind: info && info.gesture && info.gesture.kind,
                        wordIndex: info && info.gesture && info.gesture.wordIndex,
                        delta: info && info.delta };
      return origApply(info);
    };
    const origSave = App.saveState.bind(App);
    App.saveState = () => { window.__saves++; return origSave(); };
    // Word-zoom level (pps 300 ≥ WORD_SUB_PPS 120), view pinned at 0.
    App.timeline.viewport = { ...App.timeline.viewport, pps: 300, fitMode: 'manual', viewStartSec: 0 };
    App.timeline.invalidate();
  });
  await page.waitForTimeout(300);

  const fullSnap = () => page.evaluate(() =>
    JSON.stringify(App.transcript.words.map(w => ({ s: w.start, e: w.end,
      us: w.userAdjusted, d: w.deleted, os: w.origStart, oe: w.origEnd,
      ops: w.originalStart, ope: w.originalEnd, es: w.estimatedStart,
      ee: w.estimatedEnd, est: w.estimated }))));
  const counts = () => page.evaluate(() => ({ applied: window.__applied, saves: window.__saves }));
  const groups = () => page.evaluate(() => App.captionGroups.length);
  const geo = () => page.evaluate(() => {
    const tl = App.timeline, r = tl.canvas.getBoundingClientRect();
    tl._refreshLanes(tl.canvas.clientHeight);
    const cy = (i) => r.top + tl._laneTop + (tl._laneOf[i] || 0) * 22 + 11;
    const byText = (t) => {
      const b = tl._laneBoxes.find(b => (b.group.words || []).some(w => w.text === t));
      return { x: r.left + b.x + b.w / 2, y: cy(b.index), bx: r.left + b.x, bw: b.w };
    };
    return { bravo: byText('bravo.'), alpha: byText('Alpha') };
  });

  const data0 = await fullSnap();
  const groups0 = await groups();
  ok('setup: 4 independent groups', groups0 === 4, `groups=${groups0}`);
  const c0 = await counts();

  // T1) ZERO PRESS: press+release on bravo body, no movement → no gesture,
  //     no funnel call, no undo save, data byte-identical.
  let g = await geo();
  await page.mouse.move(g.bravo.x, g.bravo.y);
  await page.mouse.down();
  await page.mouse.up();
  let c = await counts();
  ok('T1 zero press: no funnel call, no save',
     c.applied === c0.applied && c.saves === c0.saves, JSON.stringify(c));
  ok('T1 zero press: data unchanged', (await fullSnap()) === data0);

  // T2) WORD-MOVE COMMIT: bravo −120 px (−0.4 s) → real commit: exactly one
  //     funnel call + one save, word moved, userAdjusted set, side fields intact.
  await page.mouse.move(g.bravo.x, g.bravo.y);
  await page.mouse.down();
  await page.mouse.move(g.bravo.x - 60, g.bravo.y, { steps: 4 });
  await page.mouse.move(g.bravo.x - 120, g.bravo.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  c = await counts();
  ok('T2 word-move: funnel called once with word-move delta −0.4',
     c.applied === c0.applied + 1 && await page.evaluate(() =>
        window.__last && window.__last.kind === 'word-move'
        && window.__last.wordIndex === 1
        && Math.abs(window.__last.delta + 0.4) < 0.02),
     JSON.stringify(await page.evaluate(() => window.__last)));
  ok('T2 word-move: exactly one saveState for the gesture',
     c.saves === c0.saves + 1, JSON.stringify(c));
  const t2 = await page.evaluate(() => {
    const w = App.transcript.words[1];
    return { s: w.start, e: w.end, ua: w.userAdjusted,
             dur: w.end - w.start,
             sideOk: w.origStart === 3.0 && w.origEnd === 3.4
                 && w.originalStart === 3.0 && w.originalEnd === 3.4
                 && w.estimatedStart === 3.0 && w.estimatedEnd === 3.4
                 && w.estimated === true && w.deleted === false };
  });
  ok('T2 word-move: bravo committed to 2.6..3.0 (duration kept)',
     Math.abs(t2.s - 2.6) < 0.02 && Math.abs(t2.e - 3.0) < 0.02 && Math.abs(t2.dur - 0.4) < 1e-9,
     JSON.stringify(t2));
  ok('T2 word-move: userAdjusted set', t2.ua === true);
  ok('T2 word-move: orig*/original*/estimated*/deleted untouched (R2)', t2.sideOk);
  const untouched = await page.evaluate(() => JSON.stringify(
    [0, 2, 3].map(i => [App.transcript.words[i].start, App.transcript.words[i].end])));
  ok('T2 word-move: other words untouched', untouched === '[[1,1.4],[5,5.4],[8,8.6]]', untouched);
  ok('T2 word-move: group count unchanged', (await groups()) === groups0);

  // T3) UNDO INTEGRATION: the single save captured the PRE-edit snapshot.
  const undone = await page.evaluate(() => {
    App.undo();
    const w = App.transcript.words[1];
    return { s: w.start, e: w.end, ua: w.userAdjusted !== undefined };
  });
  ok('T3 undo: bravo restored to 3.0..3.4',
     Math.abs(undone.s - 3.0) < 1e-9 && Math.abs(undone.e - 3.4) < 1e-9, JSON.stringify(undone));

  // T4) RETURNED-TO-ORIGIN: out and back, then release → no commit, no save.
  g = await geo();
  await page.mouse.move(g.bravo.x, g.bravo.y);
  await page.mouse.down();
  await page.mouse.move(g.bravo.x - 90, g.bravo.y, { steps: 5 });
  await page.mouse.move(g.bravo.x, g.bravo.y, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  c = await counts();
  ok('T4 return-to-origin: no funnel commit, no save',
     c.saves === c0.saves + 1 && c.applied === c0.applied + 1, JSON.stringify(c));
  ok('T4 return-to-origin: data still the undo-restored original', (await fullSnap()) === data0);

  // T5) R3 REGROUP: drag bravo far left (clamped to alpha's end 1.4) →
  //     bravo touches alpha → groups merge 4 → 3 (funnel still 1+1).
  g = await geo();
  await page.mouse.move(g.bravo.x, g.bravo.y);
  await page.mouse.down();
  await page.mouse.move(g.bravo.x - 250, g.bravo.y, { steps: 6 });
  await page.mouse.move(g.bravo.x - 480, g.bravo.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  c = await counts();
  const t5 = await page.evaluate(() => ({
    groups: App.captionGroups.length,
    bravo: [App.transcript.words[1].start, App.transcript.words[1].end],
  }));
  ok('T5 regroup: clamped to alpha end (1.4..1.8)',
     Math.abs(t5.bravo[0] - 1.4) < 1e-9 && Math.abs(t5.bravo[1] - 1.8) < 1e-9, JSON.stringify(t5.bravo));
  ok('T5 regroup: group count 4 → 3 (R3 reflow)', t5.groups === groups0 - 1, `groups=${t5.groups}`);
  ok('T5 regroup: one funnel call + one save',
     c.applied === c0.applied + 2 && c.saves === c0.saves + 2, JSON.stringify(c));
  await page.screenshot({ path: process.env.SCRATCH + '/phase4d_regroup.png' });

  // T6) UNDO the regroup too — layout (derived groups) must follow back.
  const t6 = await page.evaluate(() => { App.undo(); return {
    groups: App.captionGroups.length, bravo: App.transcript.words[1].start }; });
  ok('T6 undo regroup: groups back to 4, bravo back to 3.0',
     t6.groups === groups0 && Math.abs(t6.bravo - 3.0) < 1e-9, JSON.stringify(t6));

  // T7) Final invariants: data at original, ghost cleared, no leaked errors.
  ok('T7: data byte-identical to original after undo pair', (await fullSnap()) === data0);
  ok('T7: ghost cleared', await page.evaluate(() => App.timeline._ghost === null));
  ok('T7: no page errors', !out.some(l => l.startsWith('PAGEERROR')));

  await page.screenshot({ path: process.env.SCRATCH + '/phase4d_final.png' });
  console.log(out.join('\n'));
  await browser.close();
  server.close();
  process.exit(out.some(l => l.startsWith('FAIL') || l.startsWith('PAGEERROR')) ? 1 : 0);
})().catch(e => { console.log(out.join('\n')); console.error('HARNESS ERROR', e); process.exit(2); });
