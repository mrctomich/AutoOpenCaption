// Phase 4f supplementary QA: P4 acceptance item "SRT/VTT re-export reflects
// edits" — end-to-end. A committed drag must change the generated SRT/VTT
// cue times; undo must restore them. Scaffold from tl_phase4d_qa.cjs (same
// non-bypassing real wiring). Headless Chrome via playwright-core; run from
// a dir whose node_modules has playwright-core, SCRATCH env = native C:/
// path holding tl_clip.mp4.
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = 'E:/CodingProjects/AutoCaption3';
const CLIP = process.env.SCRATCH + '/tl_clip.mp4';
const PORT = 8751;

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
    const resp = await fetch('http://127.0.0.1:8751/tl_clip.mp4');
    const blob = await resp.blob();
    App.loadVideo(new File([blob], 'tl_clip.mp4', { type: 'video/mp4' }));
  });
  await page.waitForFunction(() => App.video && App.video.duration > 0, null, { timeout: 30000 });

  // Same 4-group synthetic transcript as the 4d harness (bravo = word 1).
  const words = [
    { id: 'w0', text: 'Alpha',   start: 1.0, end: 1.4, deleted: false,
      origStart: 1.0, origEnd: 1.4, originalStart: 1.0, originalEnd: 1.4 },
    { id: 'w1', text: 'bravo.',  start: 3.0, end: 3.4, deleted: false,
      origStart: 3.0, origEnd: 3.4, originalStart: 3.0, originalEnd: 3.4 },
    { id: 'w2', text: 'Charlie', start: 5.0, end: 5.4, deleted: false,
      origStart: 5.0, origEnd: 5.4, originalStart: 5.0, originalEnd: 5.4 },
    { id: 'w3', text: 'delta.',  start: 8.0, end: 8.6, deleted: false,
      origStart: 8.0, origEnd: 8.6, originalStart: 8.0, originalEnd: 8.6 },
  ];
  await page.evaluate((ws) => {
    App.transcript = { words: ws, language: 'en' };
    App.style.grouping = { maxWords: 2, maxSeconds: 0.9, maxCharacters: 32 };
    App.rebuildLayout();
    App.renderTranscriptEditor();
    App.timeline.invalidate();
  }, words);
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    App.timeline.viewport = { ...App.timeline.viewport, pps: 300, fitMode: 'manual', viewStartSec: 0 };
    App.timeline.invalidate();
  });
  await page.waitForTimeout(300);

  const exports = () => page.evaluate(() => ({ srt: App.generateSRT(), vtt: App.generateVTT() }));
  const geo = () => page.evaluate(() => {
    const tl = App.timeline, r = tl.canvas.getBoundingClientRect();
    tl._refreshLanes(tl.canvas.clientHeight);
    const b = tl._laneBoxes.find(b => (b.group.words || []).some(w => w.text === 'bravo.'));
    return { x: r.left + b.x + b.w / 2, y: r.top + tl._laneTop + (tl._laneOf[b.index] || 0) * 22 + 11 };
  });

  // E1) BASELINE: 4 cues each format, bravo at 3.000 --> 3.400.
  let x = await exports();
  ok('E1 baseline SRT: 4 cues, bravo 00:00:03,000 --> 00:00:03,400',
     x.srt.split('\n\n').length === 4 && x.srt.includes('00:00:03,000 --> 00:00:03,400\nbravo.'),
     JSON.stringify(x.srt.slice(0, 120)));
  ok('E1 baseline VTT: WEBVTT header + bravo cue',
     x.vtt.startsWith('WEBVTT\n\n') && x.vtt.includes('00:00:03.000 --> 00:00:03.400\nbravo.'));

  // E2) COMMITTED DRAG: bravo −0.4 s via real pointer gesture (word-move).
  const g = await geo();
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  await page.mouse.move(g.x - 60, g.y, { steps: 4 });
  await page.mouse.move(g.x - 120, g.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const e2 = await page.evaluate(() => ({ s: App.transcript.words[1].start }));
  ok('E2 drag committed bravo to 2.6', Math.abs(e2.s - 2.6) < 0.02, JSON.stringify(e2));
  x = await exports();
  ok('E2 SRT reflects edit: 00:00:02,600 --> 00:00:03,000',
     x.srt.includes('00:00:02,600 --> 00:00:03,000\nbravo.'), JSON.stringify(x.srt.slice(0, 140)));
  ok('E2 VTT reflects edit (dot separators)',
     x.vtt.includes('00:00:02.600 --> 00:00:03.000\nbravo.'));
  ok('E2 cue count and other cues unchanged',
     x.srt.split('\n\n').length === 4 && x.srt.includes('00:00:01,000 --> 00:00:01,400\nAlpha')
     && x.srt.includes('00:00:05,000 --> 00:00:05,400\nCharlie')
     && x.srt.includes('00:00:08,000 --> 00:00:08,600\ndelta.'));

  // E3) UNDO restores the exported times too.
  const e3 = await page.evaluate(() => { App.undo(); return { srt: App.generateSRT() }; });
  ok('E3 undo: SRT back to bravo 3,000 --> 3,400',
     e3.srt.includes('00:00:03,000 --> 00:00:03,400\nbravo.')
     && !e3.srt.includes('00:00:02,600'));

  // E4) REGROUP reflow shows in SRT: bravo merged into alpha's group →
  //     3 cues, first cue text 'Alpha bravo.'
  const g2 = await geo();
  await page.mouse.move(g2.x, g2.y);
  await page.mouse.down();
  await page.mouse.move(g2.x - 250, g2.y, { steps: 6 });
  await page.mouse.move(g2.x - 480, g2.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  x = await exports();
  ok('E4 regroup: SRT 3 cues, first cue "Alpha bravo." spanning 1.0 --> 1.8',
     x.srt.split('\n\n').length === 3 && x.srt.includes('00:00:01,000 --> 00:00:01,800\nAlpha bravo.'),
     JSON.stringify(x.srt.slice(0, 120)));

  ok('E5: no page errors', !out.some(l => l.startsWith('PAGEERROR')));

  await page.screenshot({ path: process.env.SCRATCH + '/phase4f_export.png' });
  console.log(out.join('\n'));
  await browser.close();
  server.close();
  process.exit(out.some(l => l.startsWith('FAIL') || l.startsWith('PAGEERROR')) ? 1 : 0);
})().catch(e => { console.log(out.join('\n')); console.error('HARNESS ERROR', e); process.exit(2); });
