// Phase 4e browser QA: edge cases of the COMMITTED state (no new features).
// S1 rapid successive gestures → one save each, LIFO undo unwinds all.
// S2 drag while the video is playing → commit lands, playback continues.
// S3 long media (60 s clip) → right-drag clamps at media end, no overrun.
// S4 resize/re-render after a commit → boxes rebuilt from committed data.
// S5 dense transcript (30 words) → exactly one word changes per gesture.
// S6 long word + RTL word → hit-test and commit work, text not mangled.
// Headless Chrome via playwright-core. Run from a dir whose node_modules has
// playwright-core, with SCRATCH env = native C:/ path holding tl_clip_60.mp4.
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = 'E:/CodingProjects/AutoCaption3';
const CLIP = process.env.SCRATCH + '/tl_clip_60.mp4';
const PORT = 8748;

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
    const resp = await fetch('http://127.0.0.1:8748/tl_clip_60.mp4');
    const blob = await resp.blob();
    App.loadVideo(new File([blob], 'tl_clip_60.mp4', { type: 'video/mp4' }));
  });
  await page.waitForFunction(() => App.video && App.video.duration > 0, null, { timeout: 30000 });

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

  // Instrument WITHOUT bypassing the funnel (4d lesson: never replace the
  // hook). Also time the funnel for the dense-transcript perf sanity.
  await page.evaluate(() => {
    window.__applied = 0; window.__saves = 0; window.__last = null; window.__lastMs = 0;
    const origApply = App.applyTimelineEdit.bind(App);
    App.applyTimelineEdit = (info) => {
      window.__applied++;
      const t0 = performance.now();
      const r = origApply(info);
      window.__lastMs = performance.now() - t0;
      window.__last = { kind: info && info.gesture && info.gesture.kind,
                        wordIndex: info && info.gesture && info.gesture.wordIndex,
                        delta: info && info.delta };
      return r;
    };
    const origSave = App.saveState.bind(App);
    App.saveState = () => { window.__saves++; return origSave(); };
    App.timeline.viewport = { ...App.timeline.viewport, pps: 300, fitMode: 'manual', viewStartSec: 0 };
    App.timeline.invalidate();
  });
  await page.waitForTimeout(300);

  const fullSnap = () => page.evaluate(() =>
    JSON.stringify(App.transcript.words.map(w => ({ id: w.id, t: w.text, s: w.start, e: w.end,
      us: w.userAdjusted, d: w.deleted, os: w.origStart, oe: w.origEnd,
      ops: w.originalStart, ope: w.originalEnd, es: w.estimatedStart,
      ee: w.estimatedEnd, est: w.estimated }))));
  const counts = () => page.evaluate(() => ({ applied: window.__applied, saves: window.__saves }));
  const groups = () => page.evaluate(() => App.captionGroups.length);
  // Geometry for the CURRENT transcript: box center/edges by word text.
  const geo = (texts) => page.evaluate((ts) => {
    const tl = App.timeline, r = tl.canvas.getBoundingClientRect();
    tl._refreshLanes(tl.canvas.clientHeight);
    const res = {};
    for (const t of ts) {
      const b = tl._laneBoxes.find(b => (b.group.words || []).some(w => w.text === t));
      if (!b) continue;
      res[t] = { x: r.left + b.x + b.w / 2, y: r.top + tl._laneTop + (tl._laneOf[b.index] || 0) * 22 + 11,
                 bx: r.left + b.x, bw: b.w };
    }
    return res;
  }, texts);

  const data0 = await fullSnap();
  const groups0 = await groups();
  ok('setup: 4 independent groups, 60 s media', groups0 === 4 && (await page.evaluate(() => App.timeline.viewport.durationSec)) > 59, `groups=${groups0}`);

  // ── S1 RAPID SUCCESSIVE GESTURES ──────────────────────────────────────
  // Three word-moves fired back-to-back: each must get its own single
  // undo save, and undo() ×3 must unwind LIFO to the original snapshot.
  let c0 = await counts();
  let g = await geo(['Alpha', 'bravo.']);
  await page.mouse.move(g.Alpha.x, g.Alpha.y);
  await page.mouse.down();
  await page.mouse.move(g.Alpha.x - 90, g.Alpha.y, { steps: 3 });
  await page.mouse.up();
  g = await geo(['bravo.']);
  await page.mouse.move(g['bravo.'].x, g['bravo.'].y);
  await page.mouse.down();
  await page.mouse.move(g['bravo.'].x - 90, g['bravo.'].y, { steps: 3 });
  await page.mouse.up();
  g = await geo(['Alpha']);
  await page.mouse.move(g.Alpha.x, g.Alpha.y);
  await page.mouse.down();
  await page.mouse.move(g.Alpha.x - 90, g.Alpha.y, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  let c = await counts();
  ok('S1 three rapid gestures: 3 funnel calls + 3 saves',
     c.applied === c0.applied + 3 && c.saves === c0.saves + 3, JSON.stringify(c));
  const s1 = await page.evaluate(() => ({
    a: [App.transcript.words[0].start, App.transcript.words[1].start] }));
  ok('S1 state: alpha 0.4, bravo 2.7 (two −0.4 s, one −0.3 s applied)',
     Math.abs(s1.a[0] - 0.4) < 0.02 && Math.abs(s1.a[1] - 2.7) < 0.02, JSON.stringify(s1));
  await page.evaluate(() => App.undo());
  const s1u1 = await page.evaluate(() => [App.transcript.words[0].start, App.transcript.words[1].start]);
  ok('S1 undo #1: alpha back to 0.7, bravo STILL moved (LIFO)',
     Math.abs(s1u1[0] - 0.7) < 1e-9 && Math.abs(s1u1[1] - 2.7) < 1e-9, JSON.stringify(s1u1));
  await page.evaluate(() => { App.undo(); App.undo(); });
  ok('S1 undo ×3 unwinds to original snapshot', (await fullSnap()) === data0);

  // ── S2 DRAG DURING PLAYBACK ───────────────────────────────────────────
  // muted play (headless autoplay pitfall), commit mid-stream, assert the
  // commit lands AND playback keeps running through the funnel refresh.
  await page.evaluate(async () => { App.video.muted = true; await App.video.play(); });
  await page.waitForTimeout(400);
  c0 = await counts();
  const tPlay0 = await page.evaluate(() => App.video.currentTime);
  g = await geo(['bravo.']);
  await page.mouse.move(g['bravo.'].x, g['bravo.'].y);
  await page.mouse.down();
  await page.mouse.move(g['bravo.'].x - 60, g['bravo.'].y, { steps: 3 });
  await page.mouse.move(g['bravo.'].x - 120, g['bravo.'].y, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  c = await counts();
  const s2 = await page.evaluate(() => ({
    paused: App.video.paused, t: App.video.currentTime,
    bravo: [App.transcript.words[1].start, App.transcript.words[1].end],
    ua: App.transcript.words[1].userAdjusted }));
  ok('S2 commit during playback: one funnel call + one save',
     c.applied === c0.applied + 1 && c.saves === c0.saves + 1, JSON.stringify(c));
  ok('S2 bravo committed 2.6..3.0 while playing',
     Math.abs(s2.bravo[0] - 2.6) < 0.02 && Math.abs(s2.bravo[1] - 3.0) < 0.02, JSON.stringify(s2.bravo));
  ok('S2 playback survived the commit (not paused, clock advanced)',
     s2.paused === false && s2.t > tPlay0, JSON.stringify({ tPlay0, ...s2 }));
  await page.evaluate(() => { App.video.pause(); App.undo(); });
  await page.waitForTimeout(150);
  ok('S2 undo restores pre-playback-edit snapshot', (await fullSnap()) === data0);

  // ── S3 LONG MEDIA: RIGHT-DRAG CLAMPS AT MEDIA END ─────────────────────
  // Zoom out to pps 10 (whole 60 s visible, group-level grab), drag delta.
  // far right; the commit must pin end == durationSec, never overrun.
  await page.evaluate(() => {
    App.timeline.viewport = { ...App.timeline.viewport, pps: 10, viewStartSec: 0 };
    App.timeline.invalidate();
  });
  await page.waitForTimeout(250);
  c0 = await counts();
  g = await geo(['delta.']);
  await page.mouse.move(g['delta.'].x, g['delta.'].y);
  await page.mouse.down();
  await page.mouse.move(g['delta.'].x + 600, g['delta.'].y, { steps: 5 });
  await page.mouse.move(g['delta.'].x + 1150, g['delta.'].y, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const s3 = await page.evaluate(() => ({
    dur: App.timeline.viewport.durationSec,
    delta: [App.transcript.words[3].start, App.transcript.words[3].end] }));
  c = await counts();
  ok('S3 right-drag clamps end to media end (60.0)',
     s3.delta[1] <= s3.dur + 1e-9 && Math.abs(s3.delta[1] - 60.0) < 0.01, JSON.stringify(s3));
  ok('S3 one commit for the clamped drag',
     c.applied === c0.applied + 1 && c.saves === c0.saves + 1, JSON.stringify(c));
  await page.evaluate(() => App.undo());
  ok('S3 undo restores delta. to 8.0..8.6', (await fullSnap()) === data0);

  // ── S4 RESIZE / RE-RENDER AFTER COMMIT ────────────────────────────────
  // Commit bravo −0.4 s at word zoom, then shrink the window: lanes must
  // rebuild from COMMITTED data (box x invariant under the same transform)
  // and the canvas must actually repaint.
  await page.evaluate(() => {
    App.timeline.viewport = { ...App.timeline.viewport, pps: 300 };
    App.timeline.invalidate();
  });
  await page.waitForTimeout(250);
  c0 = await counts();
  g = await geo(['bravo.']);
  await page.mouse.move(g['bravo.'].x, g['bravo.'].y);
  await page.mouse.down();
  await page.mouse.move(g['bravo.'].x - 120, g['bravo.'].y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  ok('S4 pre-resize commit landed', (await counts()).saves === c0.saves + 1);
  g = await geo(['bravo.']);
  const xBefore = g['bravo.'].bx;
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForTimeout(500); // RO → _measure → dirty-flag rAF repaint
  const s4 = await page.evaluate(() => {
    const tl = App.timeline, r = tl.canvas.getBoundingClientRect();
    tl._refreshLanes(tl.canvas.clientHeight);
    const b = tl._laneBoxes.find(b => (b.group.words || []).some(w => w.text === 'bravo.'));
    const ctx = tl.canvas.getContext('2d');
    const img = ctx.getImageData(0, Math.max(0, tl._laneTop), Math.min(1400, tl.canvas.width), 60).data;
    const colors = new Set();
    for (let i = 0; i < img.length; i += 16) colors.add((img[i] >> 4) + ',' + (img[i+1] >> 4) + ',' + (img[i+2] >> 4));
    return { bx: b ? b.x : -1, bw: b ? b.w : -1, colors: colors.size, w: tl.canvas.width };
  });
  ok('S4 bravo box rebuilt after resize at same transform x',
     s4.bx >= 0 && Math.abs(s4.bx - xBefore) <= 1.5, JSON.stringify({ xBefore, ...s4 }));
  ok('S4 canvas repainted after resize (lane band has content)',
     s4.colors >= 3, `distinctColors=${s4.colors}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
  await page.evaluate(() => App.undo());
  ok('S4 undo after resize restores original', (await fullSnap()) === data0);

  // ── S5 DENSE TRANSCRIPT ───────────────────────────────────────────────
  // 30 words at 0.35 s pitch; grab whichever word sub-box sits under the
  // group-box centre. EXACTLY that one word (== __last.wordIndex) changes;
  // the other 29 stay byte-identical; funnel cost stays sane.
  const dense = [];
  for (let i = 0; i < 30; i++) dense.push(mk('d' + i, 'w' + i, 1.0 + i * 0.35, 1.3 + i * 0.35));
  await page.evaluate((ws) => {
    App.transcript = { words: ws, language: 'en' };
    App.style.grouping = { maxWords: 4, maxSeconds: 0.9, maxCharacters: 32 };
    App.rebuildLayout(); App.renderTranscriptEditor(); App.timeline.invalidate();
  }, dense);
  await page.waitForTimeout(500);
  c0 = await counts();
  const dense0 = await fullSnap();
  const denseGroups0 = await groups();
  const gd = await page.evaluate(() => {
    const tl = App.timeline, r = tl.canvas.getBoundingClientRect();
    tl._refreshLanes(tl.canvas.clientHeight);
    // Calibrate the box transform from group 0's box (dense word w0 starts
    // at 1.0 s), then press the CENTRE of word d6 (3.1..3.4 s) so the grab
    // lands inside its sub-box, never in an inter-word gap.
    const ab = tl._laneBoxes.find(b => b.index === 0);
    const p = ab.x - (App.transcript.words[0].start - tl.viewport.viewStartSec) * tl.viewport.pps;
    const b = tl._laneBoxes.find(b => b.index === 1);
    const tC = (App.transcript.words[6].start + App.transcript.words[6].end) / 2;
    return { x: r.left + (tC - tl.viewport.viewStartSec) * tl.viewport.pps + p,
             y: r.top + tl._laneTop + (tl._laneOf[b.index] || 0) * 22 + 11 };
  });
  await page.mouse.move(gd.x, gd.y);
  await page.mouse.down();
  await page.mouse.move(gd.x - 60, gd.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const s5 = await page.evaluate(() => ({
    last: window.__last, ms: window.__lastMs,
    changed: App.transcript.words
      .map((w, i) => [w.start, w.end].join(',')).join(';') }));
  const changedIdx = [];
  const base = JSON.parse(dense0);
  const pairsNow = s5.changed.split(';');
  for (let i = 0; i < 30; i++) {
    if (pairsNow[i] !== `${base[i].s},${base[i].e}`) changedIdx.push(i);
  }
  c = await counts();
  ok('S5 dense: exactly one word changed per gesture',
     changedIdx.length === 1, `changed=${JSON.stringify(changedIdx)}`);
  ok('S5 dense: changed word == gesture wordIndex',
     changedIdx[0] === s5.last.wordIndex, JSON.stringify({ idx: changedIdx[0], last: s5.last }));
  ok('S5 dense: left-drag clamps at prev word end (word-move never overlaps)',
     s5.last && Math.abs(s5.last.delta + 0.05) < 0.02, JSON.stringify(s5.last));
  const s5b = await page.evaluate(() => ({
    w6: [App.transcript.words[6].start, App.transcript.words[6].end],
    prevEnd: App.transcript.words[5].end,
    dur: App.transcript.words[6].end - App.transcript.words[6].start }));
  ok('S5 dense: word 6 pinned to prev end 3.05, duration preserved',
     Math.abs(s5b.w6[0] - s5b.prevEnd) < 1e-9 && Math.abs(s5b.dur - 0.3) < 1e-9, JSON.stringify(s5b));
  ok('S5 dense: one save for the gesture', c.saves === c0.saves + 1, JSON.stringify(c));
  ok('S5 dense: funnel (incl. full editor re-render) under 500 ms',
     s5.ms > 0 && s5.ms < 500, `ms=${s5.ms.toFixed(1)}`);
  ok('S5 dense: group count unchanged', (await groups()) === denseGroups0, `g=${denseGroups0}`);

  // ── S6 LONG WORD + RTL WORD ───────────────────────────────────────────
  const mixed = [ mk('m0', 'Alpha', 1.0, 1.4),
                  mk('m1', 'مرحبا', 3.0, 3.4),
                  mk('m2', 'Supercalifragilisticexpialidocious', 5.0, 5.4),
                  mk('m3', 'delta.', 8.0, 8.4) ];
  await page.evaluate((ws) => {
    App.transcript = { words: ws, language: 'ar' };
    App.style.grouping = { maxWords: 2, maxSeconds: 0.9, maxCharacters: 32 };
    App.rebuildLayout(); App.renderTranscriptEditor(); App.timeline.invalidate();
  }, mixed);
  await page.waitForTimeout(500);
  c0 = await counts();
  const gm = await geo(['مرحبا', 'Supercalifragilisticexpialidocious']);
  ok('S6 long word and RTL word both get lane boxes',
     !!gm['مرحبا'] && !!gm['Supercalifragilisticexpialidocious'] &&
     gm['Supercalifragilisticexpialidocious'].bw > 4, JSON.stringify({ rtlBw: gm['مرحبا'] && gm['مرحبا'].bw }));
  const r0 = gm['مرحبا'];
  await page.mouse.move(r0.x, r0.y);
  await page.mouse.down();
  await page.mouse.move(r0.x - 60, r0.y, { steps: 3 });
  await page.mouse.move(r0.x - 120, r0.y, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const s6 = await page.evaluate(() => {
    const w = App.transcript.words[1];
    return { s: w.start, e: w.end, ua: w.userAdjusted, text: w.text,
      sideOk: w.origStart === 3.0 && w.origEnd === 3.4 && w.originalStart === 3.0
           && w.originalEnd === 3.4 && w.estimatedStart === 3.0 && w.estimatedEnd === 3.4
           && w.estimated === true && w.deleted === false };
  });
  ok('S6 RTL word committed 2.6..3.0 (duration kept)',
     Math.abs(s6.s - 2.6) < 0.02 && Math.abs(s6.e - 3.0) < 0.02 && Math.abs((s6.e - s6.s) - 0.4) < 1e-9, JSON.stringify(s6));
  ok('S6 RTL text not mangled', s6.text === 'مرحبا', JSON.stringify(s6.text));
  ok('S6 side fields intact (R2)', s6.sideOk === true);
  ok('S6 one funnel call + one save',
     (await counts()).saves === c0.saves + 1);

  // ── FINAL INVARIANTS ──────────────────────────────────────────────────
  ok('final: ghost cleared', await page.evaluate(() => App.timeline._ghost === null));
  ok('final: no page errors', !out.some(l => l.startsWith('PAGEERROR')));
  await page.screenshot({ path: process.env.SCRATCH + '/phase4e_final.png' });

  console.log(out.join('\n'));
  await browser.close();
  server.close();
  process.exit(out.some(l => l.startsWith('FAIL') || l.startsWith('PAGEERROR')) ? 1 : 0);
})().catch(e => { console.log(out.join('\n')); console.error('HARNESS ERROR', e); process.exit(2); });
