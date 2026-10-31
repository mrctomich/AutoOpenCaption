// Lane-packing regression QA: short cues at LOW zoom must render as ONE
// lane (old bug: MIN_BOX_PX widening made every sliver its own dashed lane).
// Headless Chrome; run with playwright-core on NODE_PATH, SCRATCH = C:/ path.
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = 'E:/CodingProjects/AutoCaption3';
const CLIP = process.env.SCRATCH + '/tl_clip.mp4';
const PORT = 8757;
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.mp4':'video/mp4','.wasm':'application/wasm','.png':'image/png','.svg':'image/svg+xml' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/tl_clip.mp4') { res.writeHead(200, {'Access-Control-Allow-Origin':'*','Content-Type':'video/mp4'}); fs.createReadStream(CLIP).pipe(res); return; }
  const f = path.join(ROOT, p.replace(/^\//,''));
  fs.readFile(f, (e, buf) => { if (e) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, {'Access-Control-Allow-Origin':'*','Cross-Origin-Resource-Policy':'cross-origin','Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream'}); res.end(buf); });
});
const out = [];
const ok = (n, c, x='') => out.push((c?'PASS':'FAIL') + ' | ' + n + (x?' | '+x:''));
(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => out.push('PAGEERROR | ' + e.message));
  await page.goto(`http://127.0.0.1:${PORT}/AutoOpenCaptionApp/app/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.App && App.timeline, null, { timeout: 60000 });
  await page.evaluate(async () => {
    const b = await (await fetch('http://127.0.0.1:8757/tl_clip.mp4')).blob();
    App.loadVideo(new File([b], 'tl_clip.mp4', { type: 'video/mp4' }));
  });
  await page.waitForFunction(() => App.video && App.video.duration > 0, null, { timeout: 30000 });

  // 10 short valid cues (0.15 s) every 0.8 s, maxWords 1 → 10 groups.
  const setup = (extra) => page.evaluate(([extraWords]) => {
    const words = [];
    for (let i = 0; i < 10; i++) {
      const s = 1 + i * 0.8;
      words.push({ id: 'w' + i, text: 'w' + i, start: s, end: s + 0.15, deleted: false });
    }
    for (const w of extraWords) words.push(w);
    App.transcript = { words, language: 'en' };
    App.style.grouping = { maxWords: 1, maxSeconds: 0.5, maxCharacters: 20 };
    App.rebuildLayout();
    App.timeline.viewport = { ...App.timeline.viewport, pps: 8, fitMode: 'manual', viewStartSec: 0 };
    App.timeline.invalidate();
  }, [extra]);

  const probe = () => page.evaluate(() => {
    const tl = App.timeline;
    const h = tl.canvas.clientHeight;
    const stripH = tl._refreshLanes(h);
    const boxes = tl._laneBoxes, laneOf = tl._laneOf;
    return {
      groups: App.captionGroups.length,
      lanes: Math.max(1, ...laneOf.map(l => l + 1)),
      widenedAll: boxes.length > 0 && boxes.every(b => b.widened === true && b.degenerate === false),
      stripH, laneTop: tl._laneTop,
    };
  });

  const pixelRows = () => page.evaluate(async () => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const tl = App.timeline, c = tl.canvas;
    tl._refreshLanes(c.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    const ctx = c.getContext('2d');
    const midX = Math.round((c.width / dpr) / 2) * dpr;
    const lit = (row) => {
      // any non-background pixel across the row band?
      const y = Math.round((tl._laneTop + row * 22 + 11) * dpr);
      const img = ctx.getImageData(Math.round(20 * dpr), y, Math.round((c.width / dpr - 40) * dpr), 1).data;
      // background is the dark dock color; look for any lighter pixel
      for (let i = 0; i < img.length; i += 4) {
        if (img[i] > 90 || img[i + 1] > 90 || img[i + 2] > 110) return true;
      }
      return false;
    };
    return { row0: lit(0), row1: lit(1), row2: lit(2) };
  });

  // A) baseline: 10 short cues at low zoom → ONE lane, boxes widened not dashed
  await setup([]);
  await page.waitForTimeout(300);
  let p = await probe();
  ok('A setup: 10 groups', p.groups === 10, JSON.stringify(p));
  ok('A: one lane at low zoom', p.lanes === 1, `lanes=${p.lanes}`);
  ok('A: boxes widened, none dashed-degenerate', p.widenedAll);
  let px = await pixelRows();
  ok('A: pixels only in lane row 0', px.row0 && !px.row1 && !px.row2, JSON.stringify(px));
  await page.screenshot({ path: process.env.SCRATCH + '/lanes_lowzoom.png' });

  // B) genuine overlap still splits into 2 lanes with 2 rendered rows
  await setup([{ id: 'x1', text: 'ov', start: 2.4, end: 2.95, deleted: false }]);
  await page.waitForTimeout(300);
  p = await probe();
  ok('B: real overlap splits to 2 lanes', p.lanes === 2, JSON.stringify(p));
  px = await pixelRows();
  ok('B: both lane rows render', px.row0 && px.row1, JSON.stringify(px));
  await page.screenshot({ path: process.env.SCRATCH + '/lanes_overlap.png' });

  // C) invalid cue (NaN) does not invent lanes nor poison the valid lane
  await setup([{ id: 'bad', text: 'bad', start: NaN, end: 3, deleted: false }]);
  await page.waitForTimeout(300);
  p = await probe();
  ok('C: invalid cue reserves 1 extra lane only', p.lanes === 2, JSON.stringify(p));

  ok('no page errors', !out.some(l => l.startsWith('PAGEERROR')));
  console.log(out.join('\n'));
  await browser.close();
  server.close();
  process.exit(out.some(l => l.startsWith('FAIL') || l.startsWith('PAGEERROR')) ? 1 : 0);
})().catch(e => { console.log(out.join('\n')); console.error('HARNESS ERROR', e); process.exit(2); });
