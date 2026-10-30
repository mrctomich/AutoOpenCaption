// Phase 4c browser QA: pointer FSM — ghost drag start/move/release, gesture
// resolution (group-move / word-move / word-resize), Esc cancel, pan-only on
// empty lane, click/dblclick regression, zero data mutation (4d commits).
// Headless Chrome via playwright-core. Run from a dir whose node_modules has
// playwright-core, with SCRATCH env pointing at tl_clip.mp4, stdin </dev/null.
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');

const ROOT = 'E:/CodingProjects/AutoCaption3';
const CLIP = process.env.SCRATCH + '/tl_clip.mp4';
const PORT = 8746;

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.mp4':'video/mp4', '.wasm':'application/wasm',
  '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const path = require('path');
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
    const resp = await fetch('http://127.0.0.1:8746/tl_clip.mp4');
    const blob = await resp.blob();
    App.loadVideo(new File([blob], 'tl_clip.mp4', { type: 'video/mp4' }));
  });
  await page.waitForFunction(() => App.video && App.video.duration > 0, null, { timeout: 30000 });

  // Same synthetic transcript as the 4b QA.
  const words = [
    { id: 'w0', text: 'Alpha', start: 1.0, end: 1.4, deleted: false },
    { id: 'w1', text: 'bravo.', start: 1.5, end: 1.9, deleted: false },
    { id: 'w2', text: 'Charlie', start: 3.0, end: 3.4, deleted: false },
    { id: 'w3', text: 'Overlapping', start: 5.0, end: 6.5, deleted: false },
    { id: 'w4', text: 'cue.', start: 6.0, end: 6.3, deleted: false },
  ];
  await page.evaluate((ws) => {
    App.transcript = { words: ws, language: 'en' };
    App.style.grouping = { maxWords: 2, maxSeconds: 0.9, maxCharacters: 32 };
    App.rebuildLayout();
    App.renderTranscriptEditor();
    App.timeline.invalidate();
  }, words);
  await page.waitForTimeout(400);

  // Instrument: record gestures + selections without altering App behavior.
  await page.evaluate(() => {
    const tl = App.timeline;
    window.__ges = []; window.__sel = []; window.__seek = 0;
    tl.onGestureEnd = (info) => window.__ges.push({
      kind: info.gesture.kind, wordIndex: info.gesture.wordIndex,
      edge: info.gesture.edge, delta: info.delta,
      proposalChanged: JSON.stringify([...info.proposal.entries()]) !== '[]',
    });
    const origSel = tl.onSelectGroup;
    tl.onSelectGroup = (p) => { window.__sel.push(p); origSel(p); };
    const origSeek = tl.onSeek;
    tl.onSeek = (t) => { window.__seek++; origSeek(t); };
    // Word-zoom level (pps 300 ≥ WORD_SUB_PPS 120).
    tl.viewport = { ...tl.viewport, pps: 300, fitMode: 'manual' };
    tl.invalidate();
  });
  await page.waitForTimeout(300);
  const snap = () => page.evaluate(() => JSON.stringify(
    App.transcript.words.map(w => [w.start, w.end, w.deleted])));
  const data0 = await snap();

  // Screen coords for box 0 (Alpha+bravo, x 300..570) and box 1 (Charlie).
  const geo = await page.evaluate(() => {
    const tl = App.timeline, r = tl.canvas.getBoundingClientRect();
    const b = tl._laneBoxes;
    // Lane rows live at laneTop + laneOf*22 (LANE_H); boxes carry no y/h.
    const cy = (i) => r.top + tl._laneTop + (tl._laneOf[i] || 0) * 22 + 11;
    return {
      left: r.left, top: r.top,
      b0gapX: r.left + b[0].x + 135,      // gap between Alpha and bravo → group-move
      b0rightX: r.left + b[0].x + b[0].w - 4, // right edge zone, on 'bravo.'
      b1midX: r.left + b[1].x + b[1].w / 2,   // Charlie word body → word-move
      laneY: cy(0), b1Y: cy(1),
    };
  });

  // 1) GROUP-MOVE: drag box0 body (word gap) +60 px → 0.2 s proposal, no data write.
  await page.mouse.move(geo.b0gapX, geo.laneY);
  await page.mouse.down();
  await page.mouse.move(geo.b0gapX + 30, geo.laneY, { steps: 4 });
  const midGhost = await page.evaluate(() => {
    const g = App.timeline._ghost;
    return g ? { kind: g.gesture.kind, delta: g.delta } : null;
  });
  await page.screenshot({ path: process.env.SCRATCH + '/phase4c_ghost.png' });
  await page.mouse.move(geo.b0gapX + 60, geo.laneY, { steps: 4 });
  await page.mouse.up();
  ok('group-move: ghost active mid-drag', midGhost && midGhost.kind === 'group-move',
     JSON.stringify(midGhost));
  ok('group-move: onGestureEnd delta ≈ 0.2 s',
     await page.evaluate(() => window.__ges.length === 1
        && window.__ges[0].kind === 'group-move'
        && Math.abs(window.__ges[0].delta - 0.2) < 0.005),
     JSON.stringify(await page.evaluate(() => window.__ges)));
  ok('group-move: proposal flagged changed', await page.evaluate(() => window.__ges[0].proposalChanged));
  ok('ghost cleared after release', await page.evaluate(() => App.timeline._ghost === null));
  ok('no data mutation after commit-less drag', (await snap()) === data0);

  // 2) WORD-MOVE: drag Charlie word body +30 px → word-move idx 2, 0.1 s.
  await page.mouse.move(geo.b1midX, geo.b1Y);
  await page.mouse.down();
  await page.mouse.move(geo.b1midX + 30, geo.b1Y, { steps: 4 });
  await page.mouse.up();
  ok('word-move: word gesture at word zoom',
     await page.evaluate(() => window.__ges.length === 2
        && window.__ges[1].kind === 'word-move' && window.__ges[1].wordIndex === 2
        && Math.abs(window.__ges[1].delta - 0.1) < 0.005),
     JSON.stringify(await page.evaluate(() => window.__ges[1])));

  // 3) WORD-RESIZE: box0 right edge (on 'bravo.') +45 px → word-resize end.
  await page.mouse.move(geo.b0rightX, geo.laneY);
  await page.mouse.down();
  await page.mouse.move(geo.b0rightX + 45, geo.laneY, { steps: 4 });
  await page.mouse.up();
  ok('word-resize: edge grab drills to word end',
     await page.evaluate(() => window.__ges.length === 3
        && window.__ges[2].kind === 'word-resize' && window.__ges[2].wordIndex === 1
        && window.__ges[2].edge === 'end'
        && Math.abs(window.__ges[2].delta - 0.15) < 0.005),
     JSON.stringify(await page.evaluate(() => window.__ges[2])));

  // 4) CLAMP: drag box0 body 400 px left → delta pinned at -1.0 (start ≥ 0).
  await page.mouse.move(geo.b0gapX, geo.laneY);
  await page.mouse.down();
  await page.mouse.move(geo.b0gapX - 200, geo.laneY, { steps: 6 });
  await page.mouse.move(geo.b0gapX - 400, geo.laneY, { steps: 6 });
  await page.screenshot({ path: process.env.SCRATCH + '/phase4c_clamp.png' });
  await page.mouse.up();
  ok('clamp: left over-drag pins delta to -1.0 s',
     await page.evaluate(() => window.__ges.length === 4
        && Math.abs(window.__ges[3].delta + 1.0) < 1e-9),
     JSON.stringify(await page.evaluate(() => window.__ges[3])));
  ok('still zero data mutation', (await snap()) === data0);

  // 5) ESC CANCEL: ghost appears, Esc kills it, release reports nothing,
  //    and the cancelled press must NOT fall through to a pan.
  const seekBeforeEsc = await page.evaluate(() => App.timeline.viewport.viewStartSec);
  await page.mouse.move(geo.b0gapX, geo.laneY);
  await page.mouse.down();
  await page.mouse.move(geo.b0gapX + 40, geo.laneY, { steps: 4 });
  const ghostOn = await page.evaluate(() => App.timeline._ghost !== null);
  await page.keyboard.press('Escape');
  const ghostOff = await page.evaluate(() => App.timeline._ghost === null);
  await page.mouse.move(geo.b0gapX + 90, geo.laneY, { steps: 4 });
  await page.mouse.up();
  const afterEsc = await page.evaluate(() => ({
    ges: window.__ges.length,
    viewStart: App.timeline.viewport.viewStartSec,
  }));
  ok('esc: ghost was active before Esc', ghostOn);
  ok('esc: Esc cleared the ghost', ghostOff);
  ok('esc: release after Esc reports nothing', afterEsc.ges === 4);
  ok('esc: cancelled drag does not pan the view',
     Math.abs(afterEsc.viewStart - seekBeforeEsc) < 1e-9,
     `${seekBeforeEsc} → ${afterEsc.viewStart}`);
  ok('esc: no data mutation', (await snap()) === data0);

  // 6) CLICK regression: no ghost, no gesture, selection fires.
  const selBefore = await page.evaluate(() => window.__sel.length);
  await page.mouse.click(geo.b1midX, geo.b1Y);
  const clickState = await page.evaluate((sb) => ({
    sel: window.__sel.length, ges: window.__ges.length, ghost: App.timeline._ghost !== null,
  }), selBefore);
  ok('click: selects, no ghost, no gesture',
     clickState.sel === selBefore + 1 && clickState.ges === 4 && !clickState.ghost,
     JSON.stringify(clickState));

  // 7) DBLCLICK regression: seeks (via onSelectGroup seek:true), no ghost.
  const selBefore7 = await page.evaluate(() => window.__sel.length);
  await page.mouse.dblclick(geo.b1midX, geo.b1Y);
  ok('dblclick: seek request fired, no ghost',
     await page.evaluate((sb) => {
       const last = window.__sel[window.__sel.length - 1];
       return window.__sel.length >= sb + 1 && last && last.seek === true
           && App.timeline._ghost === null;
     }, selBefore7),
     JSON.stringify(await page.evaluate(() => window.__sel[window.__sel.length - 1] || null)));

  // 8) EMPTY-LANE drag: pans, no gesture. Reset the view first (the dblclick
  //    seek may have auto-scrolled), then pick a lane x in a real gap.
  await page.evaluate(() => {
    const tl = App.timeline;
    tl.viewport = { ...tl.viewport, viewStartSec: 0 };
    tl.invalidate();
  });
  await page.waitForTimeout(200);
  const emptyX = await page.evaluate(() => {
    const tl = App.timeline, r = tl.canvas.getBoundingClientRect();
    tl._refreshLanes(tl.canvas.clientHeight);
    const spans = tl._laneBoxes.map(b => [b.x, b.x + b.w]).sort((a, b) => a[0] - b[0]);
    let cursor = 10, ex = -1;
    for (const [s, e] of spans) {
      if (s - cursor >= 30) { ex = cursor + 15; break; }
      cursor = Math.max(cursor, e);
    }
    if (ex < 0) ex = Math.min(cursor + 40, r.width - 10);
    return r.left + ex;
  });
  const vsBefore = await page.evaluate(() => App.timeline.viewport.viewStartSec);
  await page.mouse.move(emptyX, geo.laneY);
  await page.mouse.down();
  await page.mouse.move(emptyX - 80, geo.laneY, { steps: 5 });
  const laneGhost = await page.evaluate(() => App.timeline._ghost !== null);
  await page.mouse.up();
  const vsAfter = await page.evaluate(() => App.timeline.viewport.viewStartSec);
  ok('empty-lane: pans without a ghost',
     vsAfter > vsBefore + 0.1 && !laneGhost &&
     await page.evaluate(() => window.__ges.length === 4),
     `viewStart ${vsBefore} → ${vsAfter}`);

  // 9) Final invariants.
  ok('no gesture leaked into data at any point', (await snap()) === data0);
  ok('no page errors', !out.some(l => l.startsWith('PAGEERROR')));

  await page.screenshot({ path: process.env.SCRATCH + '/phase4c_final.png' });
  console.log(out.join('\n'));
  await browser.close();
  server.close();
  process.exit(out.some(l => l.startsWith('FAIL') || l.startsWith('PAGEERROR')) ? 1 : 0);
})().catch(e => { console.log(out.join('\n')); console.error('HARNESS ERROR', e); process.exit(2); });
