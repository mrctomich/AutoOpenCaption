
// Phase 3 browser QA: caption lanes & selection (headless Chrome via playwright-core)
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');

const ROOT = 'E:/CodingProjects/AutoCaption3';
const CLIP = process.env.SCRATCH + '/tl_clip.mp4';
const PORT = 8744;

// tiny static server with CORS (needs CORS: fetch -> File -> loadVideo path)
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.mp4':'video/mp4', '.wasm':'application/wasm',
  '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/tl_clip.mp4') {
    res.writeHead(200, {'Access-Control-Allow-Origin':'*','Content-Type':'video/mp4'});
    fs.createReadStream(CLIP).pipe(res); return;
  }
  let f = path_join(ROOT, p);
  fs.readFile(f, (e, buf) => {
    if (e) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, {'Access-Control-Allow-Origin':'*','Cross-Origin-Resource-Policy':'cross-origin','Content-Type': MIME[path_ext(f)] || 'application/octet-stream'});
    res.end(buf);
  });
});
const path = require('path');
const path_join = (a,b) => path.join(a, b.replace(/^\//,''));
const path_ext = (f) => path.extname(f).toLowerCase();

const out = [];
const ok = (name, cond, extra='') => { out.push((cond?'PASS':'FAIL') + ' | ' + name + (extra?' | '+extra:'')); };

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => out.push('PAGEERROR | ' + e.message));
  await page.goto(`http://127.0.0.1:${PORT}/AutoOpenCaptionApp/app/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.App && App.timeline, null, { timeout: 60000 });

  // Load clip through the real loadVideo(file) path
  await page.evaluate(async () => {
    const resp = await fetch('http://127.0.0.1:8744/tl_clip.mp4');
    const blob = await resp.blob();
    const file = new File([blob], 'tl_clip.mp4', { type: 'video/mp4' });
    App.loadVideo(file);
  });
  await page.waitForFunction(() => App.video && App.video.duration > 0, null, { timeout: 30000 });

  // Synthetic transcript: two normal cues, one overlapping (forces lane 2),
  // one zero-duration (must render as MIN_BOX_PX sliver)
  const words = [
    { id: 'w0', text: 'Alpha',   start: 1.0, end: 1.6, deleted: false },
    { id: 'w1', text: 'bravo.',  start: 3.0, end: 3.6, deleted: false },
    { id: 'w2', text: 'Overlapping', start: 5.0, end: 6.5, deleted: false },
    { id: 'w4', text: 'Second',  start: 6.0, end: 6.3, deleted: false },
    { id: 'w3', text: 'cue.',    start: 7.2, end: 7.8, deleted: false },
    { id: 'w5', text: 'zero',    start: 10.5, end: 10.5, deleted: false },
  ];
  await page.evaluate((ws) => {
    App.transcript = { words: ws, language: 'en' };
    App.style.grouping = { maxWords: 2, maxSeconds: 0.9, maxCharacters: 32 };
    App.rebuildLayout();
    App.renderTranscriptEditor();
    App.timeline.invalidate();
  }, words);
  await page.waitForTimeout(400);

  let geom = await page.evaluate(() => {
    const tl = App.timeline;
    tl._refreshLanes ? tl._refreshLanes(tl.canvas.clientHeight) : null;
    return {
      groupCount: App.captionGroups.length,
      boxes: tl._laneBoxes.map(b => ({ i: b.index, x: b.x, w: b.w, deg: b.degenerate, word: b.word && b.word.id })),
      laneOf: tl._laneOf, laneTop: tl._laneTop,
      rect: tl.canvas.getBoundingClientRect().toJSON(),
    };
  });
  ok('groups derived from captionGroups', geom.groupCount >= 4, 'count=' + geom.groupCount);
  const laneTest = await page.evaluate(() => {
    const tl = App.timeline;
    const real = App.captionGroups;
    const mk = (a, b, id) => ({ words: [{ id, text: 'x', start: a, end: b }], start: a, end: b });
    App.captionGroups = [mk(1, 3, 'o1'), mk(2, 4, 'o2'), mk(5, 6, 'o3')];
    tl._refreshLanes(tl.canvas.clientHeight);
    const res = { laneOf: tl._laneOf.slice(), boxes: tl._laneBoxes.length };
    App.captionGroups = real;
    tl._refreshLanes(tl.canvas.clientHeight);
    return res;
  });
  ok('lanes: overlapping cues pack into a second lane (injected)', laneTest.laneOf.join(',') === '0,1,0', JSON.stringify(laneTest));
  await page.evaluate(() => { App.timeline.viewport.pps = 15; App.timeline._refreshLanes(App.timeline.canvas.clientHeight); });
  const zgeom = await page.evaluate(() => ({
    boxes: App.timeline._laneBoxes.map(b => ({ i: b.index, w: b.w, deg: b.degenerate })),
    gi: App.captionGroups.findIndex(g => g.words.some(w => w.id === 'w5')),
  }));
  const zeroBox = zgeom.boxes.find(b => b.i === zgeom.gi);
  ok('collapsed cue renders MIN_BOX_PX sliver when zoomed out', !!zeroBox && zeroBox.w >= 4, zeroBox ? 'w=' + zeroBox.w.toFixed(1) + ' deg=' + zeroBox.deg : 'none');
  await page.evaluate(() => App.timeline.fit());
  ok('box x/w match group times at current pps', await page.evaluate((bx) => {
    return bx.every(b => { const g = App.captionGroups[b.i]; const vp = App.timeline.viewport;
      const x0 = (g.start - vp.viewStartSec) * vp.pps; return Math.abs(x0 - b.x) < 0.01 || b.deg; });
  }, geom.boxes));

  const getGeom = () => page.evaluate(() => {
    const tl = App.timeline;
    tl._refreshLanes(tl.canvas.clientHeight);
    return {
      boxes: tl._laneBoxes.map(b => ({ i: b.index, x: b.x, w: b.w, deg: b.degenerate, word: b.word && b.word.id })),
      laneOf: tl._laneOf, laneTop: tl._laneTop,
      rect: tl.canvas.getBoundingClientRect().toJSON(),
      canvasH: tl.canvas.clientHeight,
    };
  });
  geom = await getGeom();
  console.log('GEOM | ' + JSON.stringify({ groups: geom.boxes.length, laneOf: geom.laneOf, laneTop: Math.round(geom.laneTop), canvasH: geom.canvasH, boxes: geom.boxes.map(b => [b.i, Math.round(b.x), Math.round(b.w), b.deg]) }));
  const laneY = () => geom.rect.top + geom.laneTop + 11;
  // probe: what does the page itself see under the intended click point?

  // 1) click box -> select first word, NO seek
  await page.evaluate(() => { App.video.pause(); App.video.currentTime = 0; });
  await page.waitForTimeout(150);
  geom = await getGeom();
  const b0 = geom.boxes[0];
  // instrument callbacks, then click
  await page.evaluate(() => {
    window.__calls = [];
    const orig = App.onTimelineSelectGroup.bind(App);
    App.onTimelineSelectGroup = (sel) => { window.__calls.push({ gi: sel.groupIndex, word: sel.word && sel.word.id, seek: sel.seek, toggle: sel.toggle }); orig(sel); };
  });
  await page.mouse.click(geom.rect.left + b0.x + b0.w/2, laneY());
  await page.waitForTimeout(200);
  let st = await page.evaluate(() => ({ sel: App.selectedWordIndex, word: App.transcript.words[App.selectedWordIndex] && App.transcript.words[App.selectedWordIndex].id, t: App.video.currentTime, tlSel: App.timeline.selectedGroupIndex }));
  ok('click box selects first word of group', st.word === 'w0', JSON.stringify(st) + ' calls=' + JSON.stringify(await page.evaluate(() => window.__calls)) + ' ev=' + JSON.stringify(await page.evaluate(() => window.__ev)) + ' ev2=' + JSON.stringify(await page.evaluate(() => window.__ev2)));
  ok('click box does NOT seek', Math.abs(st.t) < 0.01, 't=' + st.t);
  ok('timeline highlights selected group', st.tlSel === 0, 'tlSel=' + st.tlSel);

  // 2) double-click box -> seek to group start
  geom = await getGeom();
  const b1 = geom.boxes[1] || geom.boxes[0];
  await page.mouse.dblclick(geom.rect.left + b1.x + b1.w/2, laneY());
  await page.waitForTimeout(300);
  st = await page.evaluate(() => ({ t: App.video.currentTime, g: App.captionGroups[App.timeline.selectedGroupIndex] && App.captionGroups[App.timeline.selectedGroupIndex].start }));
  ok('double-click box seeks to group start', Math.abs(st.t - st.g) < 0.05, JSON.stringify(st));

  // 3) editor -> timeline reverse sync
  await page.evaluate(() => App.selectWord(3)); // 'Second' (w4) in the overlapping group
  await page.waitForTimeout(200);
  st = await page.evaluate(() => ({ tlSel: App.timeline.selectedGroupIndex, gi: App.captionGroups.findIndex(g => g.words.some(w => w.id === 'w4')) }));
  ok('editor word select highlights its caption box', st.tlSel === st.gi && st.tlSel >= 0, JSON.stringify(st));

  // 4) shift-click selected box deselects
  await page.evaluate(() => App.selectWord(0));
  await page.waitForTimeout(100);
  await page.keyboard.down('Shift');
  await page.mouse.click(geom.rect.left + b0.x + b0.w/2, laneY());
  await page.keyboard.up('Shift');
  await page.waitForTimeout(200);
  st = await page.evaluate(() => ({ sel: App.selectedWordIndex, tlSel: App.timeline.selectedGroupIndex }));
  ok('shift-click deselects', st.sel === -1 && st.tlSel === -1, JSON.stringify(st));

  // 5) zoom-to-selection frames the selected box
  await page.evaluate(() => { App.selectWord(3); App.timeline.fit(); });
  await page.waitForTimeout(150);
  // snapshot the selected cue BEFORE clicking: the button lives outside the
  // word-selector, so the global outside-click deselect fires with the click.
  const gSpan = await page.evaluate(() => {
    const tl = App.timeline;
    const g = App.captionGroups[tl.selectedGroupIndex];
    return g ? { gs: g.start, ge: g.end } : null;
  });
  // (a) At fit zoom the whole video is visible: the stay-put rule means the
  // viewport must NOT change (framing is already satisfied).
  const beforeFit = await page.evaluate(() => ({ ...App.timeline.viewport }));
  await page.click('#btn-tl-zoom-sel');
  await page.waitForTimeout(250);
  const afterFit = await page.evaluate(() => ({ ...App.timeline.viewport }));
  ok('zoom-to-selection stays put when cue is fully visible',
     gSpan && Math.abs(afterFit.pps - beforeFit.pps) < 1e-9 &&
     Math.abs(afterFit.viewStartSec - beforeFit.viewStartSec) < 1e-9,
     JSON.stringify({ gSpan, beforeFit, afterFit }));
  // (b) Zoom in hard and pan far away so the cue is OFF-screen; the button
  // must bring it back: fully visible and roughly centered.
  await page.evaluate(() => {
    const tl = App.timeline;
    tl.viewport = { ...tl.viewport, pps: 550 };
    tl.followTime(tl.viewport.durationSec - 0.1);
    tl.requestDraw && tl.requestDraw();
  });
  const beforeOff = await page.evaluate(() => {
    const vp = App.timeline.viewport;
    return { pps: vp.pps, start: vp.viewStartSec, end: vp.viewStartSec + vp.viewWidthPx / vp.pps };
  });
  const cueStillSel = await page.evaluate(() => App.timeline.selectedGroupIndex);
  await page.click('#btn-tl-zoom-sel');
  await page.waitForTimeout(250);
  const afterFrame = await page.evaluate(() => {
    const vp = App.timeline.viewport;
    return { pps: vp.pps, start: vp.viewStartSec, end: vp.viewStartSec + vp.viewWidthPx / vp.pps,
             viewWidthPx: vp.viewWidthPx };
  });
  const centered = gSpan &&
     afterFrame.start <= gSpan.gs + 1e-9 && afterFrame.end >= gSpan.ge - 1e-9 &&
     Math.abs(((gSpan.gs + gSpan.ge) / 2) - (afterFrame.start + (afterFrame.end - afterFrame.start) / 2)) <
        (afterFrame.end - afterFrame.start) * 0.25;
  ok('zoom-to-selection frames an off-screen cue (visible + centered)',
     cueStillSel >= 0 && (beforeOff.start > gSpan.ge || beforeOff.end < gSpan.gs) && afterFrame.pps >= beforeOff.pps && centered,
     JSON.stringify({ gSpan, beforeOff, afterFrame, cueStillSel, centered }));

  // 5b) multi-lane packing: inject synthetic overlapping caption groups
  const laneInfo = await page.evaluate(() => {
    const saved = App.captionGroups;
    const W = (id, st, en) => ({ id, text: id, start: st, end: en, deleted: false });
    const mk = (gi, a, b, tag) => {
      const words = [W(tag + 'a', a, a + 0.3), W(tag + 'b', a + 0.3, b)];
      return { words, start: a, end: b, text: words.map(w => w.text).join(' ') };
    };
    App.captionGroups = [mk(1, 1, 3, 'o1'), mk(2, 2, 4, 'o2'), mk(3, 5, 6, 'o3')];
    const tl = App.timeline;
    tl._refreshLanes(tl.canvas.clientHeight);
    const out = { laneOf: tl._laneOf.slice(), laneCount: tl._laneCount, n: tl._laneBoxes.length };
    App.captionGroups = saved;
    tl._refreshLanes(tl.canvas.clientHeight);
    return out;
  });
  ok('overlapping cues pack into separate lanes',
     laneInfo.laneOf.join(',') === '0,1,0', JSON.stringify(laneInfo));

  // 5c) zero-duration cue renders as MIN_BOX_PX sliver when zoomed out
  const sliver = await page.evaluate(() => {
    const tl = App.timeline;
    tl.viewport.pps = 15;
    tl._refreshLanes(tl.canvas.clientHeight);
    const zi = App.captionGroups.findIndex(g => g.words.some(w => w.id === 'w5'));
    const b = tl._laneBoxes[zi];
    const res = b ? { w: b.w, deg: b.degenerate } : null;
    tl.fit();
    return res;
  });
  ok('zero-duration cue renders MIN_BOX_PX sliver',
     sliver && sliver.deg === true && Math.abs(sliver.w - 4) < 0.01, JSON.stringify(sliver));

  // 6) stored times never modified by selection interactions
  const times = await page.evaluate(() => App.transcript.words.map(w => [w.start, w.end]).flat().join(','));
  ok('stored word times unchanged after all interactions',
     times === words.map(w => [w.start, w.end]).flat().join(','), times.slice(0, 60));

  await page.screenshot({ path: process.env.SCRATCH + '/phase3_lanes.png', clip: { x: geom.rect.left, y: geom.rect.top, width: geom.rect.width, height: Math.min(geom.rect.height, 260) } });

  console.log(out.join('\n'));
  await browser.close();
  server.close();
  process.exit(out.some(l => l.startsWith('FAIL') || l.startsWith('PAGEERROR')) ? 1 : 0);
})().catch(e => { console.log(out.join('\n')); console.log('SCRIPT ERROR: ' + (e && e.stack || e)); process.exit(2); });
