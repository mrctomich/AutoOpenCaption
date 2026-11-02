// Phase 4b browser QA: ghost drag rendering, word sub-boxes, hover cursors.
// Headless Chrome via playwright-core. Run from a dir whose node_modules has
// playwright-core, with SCRATCH env pointing at tl_clip.mp4, stdin </dev/null.
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');

const ROOT = 'E:/CodingProjects/AutoCaption3';
const CLIP = process.env.SCRATCH + '/tl_clip.mp4';
const PORT = 8745;

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
    const resp = await fetch('http://127.0.0.1:8745/tl_clip.mp4');
    const blob = await resp.blob();
    App.loadVideo(new File([blob], 'tl_clip.mp4', { type: 'video/mp4' }));
  });
  await page.waitForFunction(() => App.video && App.video.duration > 0, null, { timeout: 30000 });

  // Synthetic transcript: group 0 = 2 words (Alpha+bravo, tight so they group),
  // group 1 = Charlie, overlapping pair forces a second lane, zero-duration tail.
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

  // In-page pixel probe helper (CSS coords → [r,g,b]).
  await page.evaluate(() => {
    window.__px = (cssX, cssY) => {
      const tl = App.timeline;
      const rect = tl.canvas.getBoundingClientRect();
      const dpr = tl.canvas.width / rect.width;
      const d = tl.canvas.getContext('2d').getImageData(
        Math.round(cssX * dpr), Math.round(cssY * dpr), 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    // distinct-color count inside a CSS-rect region (rounded to 16 to absorb AA)
    window.__colorsIn = (x, y, w, h) => {
      const tl = App.timeline;
      const rect = tl.canvas.getBoundingClientRect();
      const dpr = tl.canvas.width / rect.width;
      const d = tl.canvas.getContext('2d').getImageData(
        Math.round(x*dpr), Math.round(y*dpr), Math.max(1,Math.round(w*dpr)), Math.max(1,Math.round(h*dpr))).data;
      const set = new Set();
      for (let i = 0; i < d.length; i += 4) set.add((d[i]>>4)+','+(d[i+1]>>4)+','+(d[i+2]>>4));
      return set.size;
    };
    window.__box0 = () => {
      const tl = App.timeline;
      tl._refreshLanes(tl.canvas.clientHeight);
      const gi = App.captionGroups.findIndex(g => g.words.some(w => w.id === 'w0'));
      const b = tl._laneBoxes.find(b => b.index === gi);
      const lane = tl._laneOf[b.index];
      return { gi, x: b.x, w: b.w, cy: tl._laneTop + lane*22 + 11,
               wordIndex: b.wordIndex };
    };
  });

  // ── 1. Word sub-boxes: OFF below threshold, ON at/above WORD_SUB_PPS ──
  await page.evaluate(() => { const tl = App.timeline; tl.viewport.pps = 80; tl.viewport.viewStartSec = 0; tl.invalidate(); });
  await page.waitForTimeout(250);
  const lowZoom = await page.evaluate(() => {
    const b = window.__box0();
    // interior only: skip 3px border ring; box spans [b.x, b.x+b.w]
    return { colors: window.__colorsIn(b.x + 4, b.cy - 5, b.w - 8, 10), w: b.w };
  });
  await page.evaluate(() => { const tl = App.timeline; tl.viewport.pps = 200; tl.viewport.viewStartSec = 0.2; tl.invalidate(); });
  await page.waitForTimeout(250);
  const hiZoom = await page.evaluate(() => {
    const b = window.__box0();
    return { colors: window.__colorsIn(b.x + 4, b.cy - 5, b.w - 8, 10), w: b.w, wi: b.wordIndex };
  });
  ok('sub-boxes OFF below WORD_SUB_PPS', lowZoom.colors === 1, `colors=${lowZoom.colors} @80pps`);
  ok('sub-boxes ON at pps>=120 (outlines+text)', hiZoom.colors >= 3 && hiZoom.colors > lowZoom.colors, `colors=${hiZoom.colors} @200pps vs ${lowZoom.colors} @80pps`);
  ok('groupBoxes wordIndex maps group words to transcript indices', JSON.stringify(hiZoom.wi) === '[0,1]', JSON.stringify(hiZoom.wi));

  // ── 2. Hover cursors ──
  const geom = await page.evaluate(() => ({ ...window.__box0(), rect: App.timeline.canvas.getBoundingClientRect().toJSON() }));
  const hover = async (cssX, label) => {
    await page.mouse.move(geom.rect.left + cssX, geom.rect.top + geom.cy);
    await page.waitForTimeout(120);
    return page.evaluate(() => App.timeline.canvas.style.cursor);
  };
  const cBody = await hover(geom.x + geom.w / 2);
  const cLeft = await hover(geom.x + 2);
  const cRight = await hover(geom.x + geom.w - 2);
  const cEmpty = await hover(geom.x + geom.w + 60);
  ok('hover box body → move cursor', cBody === 'move', `'${cBody}'`);
  ok('hover left edge → ew-resize', cLeft === 'ew-resize', `'${cLeft}'`);
  ok('hover right edge → ew-resize', cRight === 'ew-resize', `'${cRight}'`);
  ok('hover empty lane → no cursor', cEmpty === '', `'${cEmpty}'`);

  // ── 3. Ghost lifecycle: start, move, pixels, DATA PURITY ──
  const before = await page.evaluate(() => JSON.stringify(App.transcript.words));
  const groupsBefore = await page.evaluate(() => App.captionGroups.length);
  const g = await page.evaluate(() => {
    const tl = App.timeline;
    const b = window.__box0();
    const pxBefore = window.__px(b.x + b.w + 50, b.cy); // future ghost spot (0.5 s right)
    const started = tl.beginGhost({ kind: 'group-move', groupIndex: b.gi }, b.gi);
    const delta = tl.moveGhost(100); // 0.5 s at pps 200
    const proposal = [...tl._ghost.proposal.entries()].map(([i, p]) => [i, +p.start.toFixed(4), +p.end.toFixed(4)]);
    return { started, delta, pxBefore,
             proposal, words: JSON.stringify(App.transcript.words), groups: App.captionGroups.length };
  });
  await page.waitForTimeout(250); // let rAF paint the ghost
  g.moved = await page.evaluate((pxBefore) => {
    const b = window.__box0();
    return String(window.__px(b.x + b.w + 50, b.cy)) !== String(pxBefore);
  }, g.pxBefore);
  delete g.pxBefore;
  ok('beginGhost starts on group box', g.started === true);
  ok('moveGhost returns requested delta (within bounds)', Math.abs(g.delta - 0.5) < 1e-9, `delta=${g.delta}`);
  ok('ghost proposal translates EVERY group word by delta', JSON.stringify(g.proposal) === JSON.stringify([[0,1.5,1.9],[1,2.0,2.4]]), JSON.stringify(g.proposal));
  ok('ghost renders (pixels change at proposed spot)', g.moved === true);
  ok('NO data written during ghost drag', g.words === before);
  ok('captionGroups not rebuilt mid-drag', g.groups === groupsBefore, `groups=${g.groups} (before=${groupsBefore})`);

  // ── 4. Ghost clamping ──
  const cl = await page.evaluate(() => {
    const tl = App.timeline;
    const lo = tl.moveGhost(-1e6);
    const pLo = [...tl._ghost.proposal.entries()].map(([i,p]) => [i, +p.start.toFixed(4)]);
    const hi = tl.moveGhost(1e6);
    return { lo, hi, bounds: tl._ghost.bounds, pLo };
  });
  // group0 spans 1.0..1.9; prevEnd=-Inf → lo=-1.0 (start hits 0); next word w2 starts 3.0 → hi=3.0-1.9=1.1
  ok('ghost clamps at lo (start ≥ 0)', Math.abs(cl.lo + 1.0) < 1e-9 && Math.abs(cl.pLo[0][1] - 0) < 1e-9, `lo=${cl.lo} pStart=${cl.pLo[0][1]}`);
  ok('ghost clamps at neighbour hi', Math.abs(cl.hi - 1.1) < 1e-9, `hi=${cl.hi} bounds=${JSON.stringify(cl.bounds)}`);

  // ── 5. endGhost returns final delta, clears, pixels revert, STILL no commit ──
  const end = await page.evaluate(() => {
    const tl = App.timeline;
    const b = window.__box0();
    tl.moveGhost(100);
    const pxGhost = window.__px(b.x + b.w + 50, b.cy);
    const d = tl.endGhost();
    return { d, ghostNull: tl._ghost === null, pxGhost,
             words: JSON.stringify(App.transcript.words) };
  });
  await page.waitForTimeout(250); // let the rAF dirty-flag redraw clear the ghost
  const pxGone = await page.evaluate(() => {
    const b = window.__box0();
    return window.__px(b.x + b.w + 50, b.cy);
  });
  end.reverted = String(pxGone) !== String(end.pxGhost);
  delete end.pxGhost;
  ok('endGhost returns final clamped delta', Math.abs(end.d - 0.5) < 1e-9, `d=${end.d}`);
  ok('endGhost clears ghost + pixels revert', end.ghostNull && end.reverted);
  ok('endGhost does NOT commit (words still untouched)', end.words === before);

  // ── 6. cancelGhost aborts cleanly ──
  const canc = await page.evaluate(() => {
    const tl = App.timeline;
    tl.beginGhost({ kind: 'group-move', groupIndex: 0 }, 0);
    tl.moveGhost(50);
    tl.cancelGhost();
    return { ghostNull: tl._ghost === null, words: JSON.stringify(App.transcript.words) };
  });
  ok('cancelGhost clears ghost, no data change', canc.ghostNull && canc.words === before);

  // ── 7. word-resize (end edge): only end moves, clamped by next word ──
  const wr = await page.evaluate(() => {
    const tl = App.timeline;
    const b = window.__box0();
    const started = tl.beginGhost({ kind: 'word-resize', wordIndex: 0, edge: 'end' }, b.gi);
    const delta = tl.moveGhost(1e6);
    const p = [...tl._ghost.proposal.entries()].map(([i, q]) => [i, +q.start.toFixed(4), +q.end.toFixed(4)]);
    tl.cancelGhost();
    return { started, delta, p, words: JSON.stringify(App.transcript.words) };
  });
  ok('word-resize grabbable via beginGhost', wr.started === true);
  ok('word-resize clamps at next word start (hi=0.1)', Math.abs(wr.delta - 0.1) < 1e-9, `delta=${wr.delta}`);
  ok('word-resize moves ONLY grabbed word end', JSON.stringify(wr.p) === JSON.stringify([[0,1,1.5]]), JSON.stringify(wr.p));

  // ── 8. word-move ghost at high zoom rides correct lane, both edges move ──
  const wm = await page.evaluate(() => {
    const tl = App.timeline;
    const started = tl.beginGhost({ kind: 'word-move', wordIndex: 0 }, 0);
    const delta = tl.moveGhost(20);
    const p = [...tl._ghost.proposal.entries()].map(([i, q]) => [i, +q.start.toFixed(4), +q.end.toFixed(4)]);
    const lane = tl._ghost.lane;
    tl.cancelGhost();
    return { started, delta, p, lane, words: JSON.stringify(App.transcript.words) };
  });
  ok('word-move ghost: duration preserved, lane resolved', wm.started && Math.abs(wm.delta - 0.1) < 1e-9 && wm.lane === 0 && JSON.stringify(wm.p) === JSON.stringify([[0,1.1,1.5]]), `delta=${wm.delta} p=${JSON.stringify(wm.p)} lane=${wm.lane}`);

  // ── 9. Final purity ──
  const after = await page.evaluate(() => JSON.stringify(App.transcript.words));
  ok('FINAL: word data byte-identical after all ghost interactions', after === before);

  ok('no page errors', !out.some(l => l.startsWith('PAGEERROR')));

  console.log(out.join('\n'));
  await browser.close();
  server.close();
  process.exit(out.some(l => l.startsWith('FAIL')) || out.some(l => l.startsWith('PAGEERROR')) ? 1 : 0);
})().catch(e => { console.error('QA CRASH:', e); process.exit(2); });
