/**
 * Browser QA for Word Editor selection integrity (fix/word-editor-selection).
 *
 * R1  clicking a word previews AND highlights that word (maxWords=1 and
 *     multi-word cues); a cue join resolves to the incoming word; live
 *     playback still follows the playhead, never the selection.
 * R2  the inspector bar is always present; with no selection it is idle
 *     (dimmed, disabled, hint shown) and exactly as tall as when editing.
 * R3  Escape, text-selection drags and near-miss presses inside the bar keep
 *     the selection (the disappearing-bar bug).
 * R4  regressions: click-away still deselects, find-bar Replace and the
 *     timeline toolbar still act ON the selection.
 * R6  the export state sampler switches a cue at its start time.
 * R7  create-caption still lands focus in the (just re-enabled) TEXT field.
 *
 * Run from a directory whose node_modules holds playwright-core (e.g. install
 * it here, or copy this file to a scratch dir with it), with SCRATCH set to a
 * native C:/ path holding a >=6 s tl_clip.mp4:
 *   ffmpeg -f lavfi -i testsrc=size=640x360:rate=25 -f lavfi -i sine=frequency=440 \n     -t 10 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest tl_clip.mp4
 *   SCRATCH=C:/path/to/scratch node word_editor_qa.cjs
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const SCRATCH = process.env.SCRATCH;
const CLIP = SCRATCH + '/tl_clip.mp4';
const PORT = 8764;
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.mp4':'video/mp4', '.wasm':'application/wasm',
  '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.mjs':'text/javascript' };
const pjoin = (a,b) => path.join(a, b.replace(/^\//,''));
const pext = (f) => path.extname(f).toLowerCase();
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/tl_clip.mp4') {
    const s = fs.statSync(CLIP);
    res.writeHead(200, {'Content-Length': s.size, 'Access-Control-Allow-Origin':'*','Content-Type':'video/mp4'});
    fs.createReadStream(CLIP).pipe(res); return;
  }
  fs.stat(pjoin(ROOT, p), (e, s) => {
    if (e) { res.writeHead(404); res.end('nope'); return; }
    if (req.method === 'HEAD') { res.writeHead(200, {'Content-Length': s.size, 'Content-Type': MIME[pext(p)] || 'application/octet-stream'}); res.end(); return; }
    fs.readFile(pjoin(ROOT, p), (e2, buf) => {
      if (e2) { res.writeHead(404); res.end('nope'); return; }
      res.writeHead(200, {'Access-Control-Allow-Origin':'*','Cross-Origin-Resource-Policy':'cross-origin','Content-Type': MIME[pext(pjoin(ROOT,p))] || 'application/octet-stream'});
      res.end(buf);
    });
  });
});
const out = [];
const ok = (n, cond, extra='') => { out.push((cond?'PASS':'FAIL') + ' | ' + n + (extra?' | '+extra:'')); console.log(out[out.length-1]); };
const info = (n, e='') => { out.push('INFO | ' + n + (e?' | '+e:'')); console.log(out[out.length-1]); };

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => out.push('PAGEERROR | ' + e.message));
  await page.goto(`http://127.0.0.1:${PORT}/AutoOpenCaptionApp/app/index.html`);
  await page.waitForFunction(() => window.App && App.timeline, null, { timeout: 60000 });
  await page.evaluate(async () => {
    const blob = await (await fetch('/tl_clip.mp4')).blob();
    App.loadVideo(new File([blob], 'clip.mp4', { type: 'video/mp4' }));
  });
  await page.waitForFunction(() => App.video.duration > 5, null, { timeout: 30000 });

  // Contiguous words exactly like the reported case (22.66… 24.76-24.92 'along',
  // 24.92-25.12 'with'): 0.16 s words, no gaps.
  await page.evaluate(() => {
    App.style.grouping = { maxWords: 1, maxSeconds: 2.2, maxCharacters: 32 };
    const words = [];
    for (let i = 0; i < 30; i++) words.push({ id: 100+i, text: 'w'+i, start: +(4 + i*0.16).toFixed(2), end: +(4 + (i+1)*0.16).toFixed(2) });
    App.transcript = { durationSec: 30, language: 'en', words };
    App.rebuildLayout(); App.renderTranscriptEditor();
  });
  await page.waitForTimeout(250);

  const R5idle = await page.evaluate(() => {
    const el = document.getElementById('word-inspector');
    const hint = document.getElementById('inspector-hint');
    const r = el.getBoundingClientRect(), hr = hint.getBoundingClientRect();
    return { hidden: el.classList.contains('hidden'), idle: el.classList.contains('inspector-idle'),
      h: Math.round(r.height), w: Math.round(r.width), hintVisible: getComputedStyle(hint).visibility === 'visible',
      textDisabled: document.getElementById('inspector-text').disabled,
      splitDisabled: document.getElementById('inspector-split').disabled,
      hintBox: [Math.round(hr.x), Math.round(hr.y), Math.round(hr.width), Math.round(hr.height)] };
  });
  ok('R2a bar is present and idle before any selection', !R5idle.hidden && R5idle.idle && R5idle.h > 50 && R5idle.hintVisible && R5idle.textDisabled && R5idle.splitDisabled, JSON.stringify(R5idle));

  // ── R1: click a chip → preview + chip highlight = the clicked word ──
  for (const idx of [1, 5, 12]) {
    const res = await page.evaluate(async (i) => {
      const v = App.video;
      document.querySelector(`.word-chip[data-index="${i}"]`).click();
      await new Promise(r => { const d = () => { v.removeEventListener('seeked', d); r(); }; v.addEventListener('seeked', d); setTimeout(r, 2000); });
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const w = App.transcript.words[i];
      const chips = [...document.querySelectorAll('.word-chip')];
      const a = chips.findIndex(c => c.classList.contains('playback-active'));
      const s = chips.findIndex(c => c.classList.contains('selected'));
      return { want: w.text, wantStart: w.start, gotTime: v.currentTime,
        active: a >= 0 ? chips[a].querySelector('.word-text').textContent : 'none',
        sel: s >= 0 ? chips[s].querySelector('.word-text').textContent : 'none' };
    }, idx);
    info(`R1 idx=${idx}`, `want=${res.want}@${res.wantStart} currentTime=${res.gotTime.toFixed(4)} activeChip=${res.active} selChip=${res.sel}`);
    ok(`R1a idx=${idx}: previewed word = clicked word`, res.active === res.want, `active=${res.active}`);
    ok(`R1b idx=${idx}: only the clicked chip is highlighted`, res.sel === res.want && res.active === res.want, `sel=${res.sel} active=${res.active}`);
  }

  // Exact boundary while paused with NO selection → incoming cue wins.
  const boundary = await page.evaluate(async () => {
    App.selectWord(-1);
    App.video.currentTime = 4.32;   // = w1.end = w2.start (frame-aligned: 25 fps clip)
    await new Promise(r => setTimeout(r, 250));
    App.updatePreview();
    const chips = [...document.querySelectorAll('.word-chip')];
    const a = chips.findIndex(c => c.classList.contains('playback-active'));
    return a >= 0 ? chips[a].querySelector('.word-text').textContent : 'none';
  });
  ok('R1c paused boundary (cue join) activates the incoming word', boundary === 'w2', `active=${boundary}`);

  // Multi-word cues still resolve (maxWords = 3).
  const multi = await page.evaluate(async () => {
    App.style.grouping = { maxWords: 3, maxSeconds: 2.2, maxCharacters: 32 };
    App.rebuildLayout(); App.renderTranscriptEditor();
    App.selectWord(7);            // inside the 3rd cue
    await new Promise(r => setTimeout(r, 250));
    App.updatePreview();
    const chips = [...document.querySelectorAll('.word-chip')];
    const a = chips.findIndex(c => c.classList.contains('playback-active'));
    return { active: a >= 0 ? chips[a].querySelector('.word-text').textContent : 'none', want: App.transcript.words[7].text, groups: App.captionGroups.length };
  });
  ok('R1d multi-word cue: active word = clicked word', multi.active === multi.want, JSON.stringify(multi));

  // ── R3: gestures inside the bar keep the selection ──
  await page.evaluate(() => { App.style.grouping = { maxWords: 1, maxSeconds: 2.2, maxCharacters: 32 }; App.rebuildLayout(); });
  const st = () => page.evaluate(() => ({ idle: document.getElementById('word-inspector').classList.contains('inspector-idle'),
    h: Math.round(document.getElementById('word-inspector').getBoundingClientRect().height),
    sel: App.selectedWordIndex, text: document.getElementById('inspector-text').value }));
  const pick = (i) => page.evaluate((n) => document.querySelector(`.word-chip[data-index="${n}"]`).click(), i);

  // dblclick word-select inside the TEXT field
  await pick(5); await page.waitForTimeout(120);
  const box = await page.locator('#inspector-text').boundingBox();
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(120);
  let s = await st();
  ok('R3a double-click word-select in TEXT field keeps the word selected', !s.idle && s.sel === 5, JSON.stringify(s));

  // Escape while the caret is in the TEXT field
  await page.mouse.click(box.x + 6, box.y + box.height / 2);
  await page.keyboard.type('xx');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  s = await st();
  ok('R3b Escape in TEXT field cancels the edit, keeps the selection', !s.idle && s.sel === 5 && s.text === 'w5', JSON.stringify(s));

  // drag-select text and release well outside the bar
  await page.mouse.move(box.x + box.width - 6, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 120, box.y + 90, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  s = await st();
  ok('R3c text-selection drag releasing outside the bar keeps the selection', !s.idle && s.sel === 5, JSON.stringify(s));

  // near-miss press on the bar's own divider and the panel padding
  { const d = await page.locator('.inspector-divider').boundingBox();
    await page.mouse.click(d.x + d.width / 2, d.y + 0.5); }
  await page.waitForTimeout(80);
  s = await st();
  ok('R3d click on the bar divider keeps the selection', !s.idle && s.sel === 5, JSON.stringify(s));
  await page.click('.panel-word-editor .word-editor-header h2');
  await page.waitForTimeout(80);
  s = await st();
  ok('R3e click on the Word Editor header keeps the selection', !s.idle && s.sel === 5, JSON.stringify(s));

  // Escape with nothing focused deselects (intended) and the bar stays visible
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  s = await st();
  ok('R3f Escape with no focus deselects but the bar stays visible', s.idle && s.sel === -1 && s.h > 50, JSON.stringify(s));

  // ── R4 regressions ──
  await pick(9); await page.waitForTimeout(120);
  await page.click('#panel-transcript-display');
  await page.waitForTimeout(100);
  s = await st();
  ok('R4a click away (transcript panel) still deselects', s.sel === -1 && s.idle, JSON.stringify(s));

  // find bar Replace acts ON the selection and keeps it
  await pick(4); await page.waitForTimeout(120);
  await page.fill('#find-input', 'w12');
  await page.fill('#replace-input', 'seed');
  await page.click('#btn-replace-once');
  await page.waitForTimeout(150);
  s = await page.evaluate(() => ({ sel: App.selectedWordIndex, idle: document.getElementById('word-inspector').classList.contains('inspector-idle'),
    text: document.getElementById('inspector-text').value }));
  ok('R4b Replace keeps the selection it just moved', !s.idle && s.text === 'seed', JSON.stringify(s));

  // timeline dock: its toolbar buttons act ON the selection and must not clear
  // it (the reason the dock is exempt from click-away deselect).
  await pick(6); await page.waitForTimeout(120);
  const dockPress = await page.evaluate(() => {
    const btn = document.querySelector('#timeline-dock button:not([disabled])');
    if (!btn) return 'no toolbar button';
    const before = App.selectedWordIndex;
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    btn.click();
    return { before, after: App.selectedWordIndex, btn: btn.id || btn.className };
  });
  ok('R4c press on the timeline toolbar does not clear the selection', typeof dockPress === 'object' && dockPress.before === dockPress.after, JSON.stringify(dockPress));

  // press on the video deselects (outside the Word Editor)
  await pick(6); await page.waitForTimeout(120);
  const beforeVid = await page.evaluate(() => App.selectedWordIndex);
  const vv = await page.locator('video').boundingBox();
  await page.mouse.click(vv.x + vv.width / 2, vv.y + vv.height / 2);
  await page.waitForTimeout(120);
  s = await st();
  ok('R4d press on the video still deselects', s.sel === -1, JSON.stringify({ beforeVid, ...s }));

  // ── R5: identical bar geometry in both states (no jump) ──
  const R5 = await page.evaluate(() => {
    const el = document.getElementById('word-inspector');
    const r = el.getBoundingClientRect();
    return { h: Math.round(r.height), w: Math.round(r.width), idle: el.classList.contains('inspector-idle') };
  });
  await pick(5); await page.waitForTimeout(150);
  const R5b = await page.evaluate(() => {
    const el = document.getElementById('word-inspector');
    const r = el.getBoundingClientRect();
    const hint = getComputedStyle(document.getElementById('inspector-hint')).visibility;
    return { h: Math.round(r.height), w: Math.round(r.width), idle: el.classList.contains('inspector-idle'), hint };
  });
  info('R5', 'idle=' + JSON.stringify(R5) + ' selected=' + JSON.stringify(R5b));
  ok('R5 bar height identical idle vs selected', R5.h === R5b.h && R5b.h > 50 && R5b.hint === 'hidden', `${R5.h}px vs ${R5b.h}px`);
  info('R5 note', 'idle bar was ' + R5idle.h + 'px at boot; selected ' + R5b.h + 'px; bar width ' + R5idle.w + 'px');

  // ── R1e: while PLAYING, time alone decides (selection must not lead audio) ──
  const playback = await page.evaluate(async () => {
    App.selectWord(-1);
    App.video.currentTime = 4.0;
    await App.video.play();
    await new Promise(r => {
      const tick = () => { if (App.video.currentTime > 4.9 || App.video.paused) return r(); requestAnimationFrame(tick); };
      tick();
    });
    App.video.pause();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const t = App.video.currentTime;
    const words = App.transcript.words;
    let want = null;
    for (let i = 0; i < words.length; i++) {
      if (words[i].start === t) { want = words[i].text; break; }
      if (words[i].start < t && words[i].end >= t) want = words[i].text;
    }
    const chips = [...document.querySelectorAll('.word-chip')];
    const a = chips.findIndex(c => c.classList.contains('playback-active'));
    return { t: +t.toFixed(2), active: a >= 0 ? chips[a].querySelector('.word-text').textContent : 'none', want };
  });
  info('R1e playback', JSON.stringify(playback));
  ok('R1e playback highlights the word under the playhead', playback.active === playback.want, JSON.stringify(playback));

  // ── R6: export state sampling switches a cue at its START, not a step late ──
  const exportStates = await page.evaluate(() => {
    App.video.pause();
    App.selectWord(-1);
    App.style.grouping = { maxWords: 1, maxSeconds: 2.2, maxCharacters: 32 };
    // Cues aligned to the sampler's 0.1 s grid so a boundary lands on a sample.
    App.transcript = { durationSec: 10, language: 'en', words: [
      { id: 901, text: 'A', start: 1, end: 2 },
      { id: 902, text: 'B', start: 2, end: 3 },
      { id: 903, text: 'C', start: 3, end: 4 },
    ] };
    App.rebuildLayout(); App.renderTranscriptEditor();
    return App.getCaptionStateChanges().map(s => ({ t: +s.time.toFixed(2), word: s.activeWordId }));
  });
  info('R6 export states', JSON.stringify(exportStates));
  const bStart = exportStates.find(s => s.word === 902);
  const cStart = exportStates.find(s => s.word === 903);
  ok('R6 burned-in cue switch happens at its start time', !!bStart && bStart.t === 2 && !!cStart && cStart.t === 3, JSON.stringify({ bStart, cStart }));

  // ── R7: type-at-once still works (a field that was disabled must take focus) ──
  const focusCheck = await page.evaluate(() => {
    const okCreate = App.addCaptionAt({ startSec: 9.5, endSec: 9.9, text: '' });
    const ae = document.activeElement;
    const bar = document.getElementById('word-inspector');
    return { okCreate, focus: ae ? (ae.id || ae.tagName) : 'none',
      disabled: document.getElementById('inspector-text').disabled,
      idle: bar.classList.contains('inspector-idle') };
  });
  info('R7', JSON.stringify(focusCheck));
  ok('R7 new caption focuses the (just re-enabled) TEXT field', focusCheck.okCreate && focusCheck.focus === 'inspector-text' && !focusCheck.disabled && !focusCheck.idle, JSON.stringify(focusCheck));
  const typed = await page.evaluate(async () => {
    document.getElementById('inspector-text').value = 'hello';
    document.getElementById('inspector-text').dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    const w = App.transcript.words[App.transcript.words.length - 1];
    return { text: w.text, focus: document.activeElement.id };
  });
  ok('R7 typing into the enabled field commits', typed.text === 'hello', JSON.stringify(typed));

  const fails = out.filter(l => l.startsWith('FAIL') || l.startsWith('PAGEERROR'));
  console.log('---- summary: ' + out.filter(l => l.startsWith('PASS')).length + ' pass, ' + fails.length + ' fail');
  fails.forEach(f => console.log('  ' + f));
  await browser.close(); server.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
