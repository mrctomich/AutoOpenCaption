// Phase 6 browser QA: FULL-WORKFLOW regression pass (the real pipeline).
// S0 gating before/after video load.
// S1 REAL transcription: bundled whisper-base on an 8.7 s TTS-speech clip —
//    audio extraction, model load, word timestamps, orig* snapshots,
//    editor/display rendering, export-button enablement.
// S2 estimated-flag flow: forced estimated word → needs-attention chip;
//    inspector nudge → adjusted chip, one save, green beats attention.
// S3 REAL CTC realign (~91 MB wav2vec2 download + inference): aligned words
//    re-timed, user-adjusted words preserved, monotone order, estimated
//    cleared on aligned words; revert restores the exact pre-realign state.
// S4 styling + presets: live style update, preset save/load roundtrip,
//    preset export JSON.
// S5 create funnel regression on the real transcript (+1 word via playhead).
// S6 REAL burn-in export: ffmpeg.wasm encode → download captured, verified
//    with ffprobe (duration/streams) and frame PSNR vs source (caption
//    pixels present inside the speech window, untouched outside it).
// S7 cancel path on the 60 s clip: export cancelled mid-render, worker
//    re-initialises, no download.
// Zero page errors throughout.
// Run from a dir whose node_modules has playwright-core, SCRATCH env =
// native C:/ path holding tl_clip_60.mp4 AND tl_clip_speech.mp4.
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = 'E:/CodingProjects/AutoCaption3';
const SCRATCH = process.env.SCRATCH;
const CLIP60 = SCRATCH + '/tl_clip_60.mp4';
const SPEECH = SCRATCH + '/tl_clip_speech.mp4';
const PORT = 8750;
const OUT_MP4 = path.join(SCRATCH, 'tl_phase6_out.mp4');
const SRC_MP4 = path.join(SCRATCH, 'tl_phase6_src.mp4');
const FFMPEG = 'C:/ProgramData/chocolatey/bin/ffmpeg.exe';
const FFPROBE = 'C:/ProgramData/chocolatey/bin/ffprobe.exe';

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.mp4':'video/mp4', '.wasm':'application/wasm',
  '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon',
  '.mjs':'text/javascript' };
const path_join = (a,b) => path.join(a, b.replace(/^\//,''));
const path_ext = (f) => path.extname(f).toLowerCase();
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/tl_clip_60.mp4' || p === '/tl_clip_speech.mp4') {
    const f = p === '/tl_clip_60.mp4' ? CLIP60 : SPEECH;
    res.writeHead(200, {'Access-Control-Allow-Origin':'*','Content-Type':'video/mp4'});
    fs.createReadStream(f).pipe(res); return;
  }
  // probeModelLocal() treats Content-Length: 0 as a missing bundled file,
  // so HEAD must carry the real size like the production serve.ps1 does.
  fs.stat(path_join(ROOT, p), (e, s) => {
    if (e) { res.writeHead(404); res.end('nope'); return; }
    if (req.method === 'HEAD') {
      res.writeHead(200, {'Content-Length': s.size, 'Content-Type': MIME[path_ext(p)] || 'application/octet-stream'});
      res.end(); return;
    }
    fs.readFile(path_join(ROOT, p), (e2, buf) => {
      if (e2) { res.writeHead(404); res.end('nope'); return; }
      res.writeHead(200, {'Access-Control-Allow-Origin':'*','Cross-Origin-Resource-Policy':'cross-origin','Content-Type': MIME[path_ext(path_join(ROOT,p))] || 'application/octet-stream'});
      res.end(buf);
    });
  });
});

const out = [];
const ok = (name, cond, extra='') => { out.push((cond?'PASS':'FAIL') + ' | ' + name + (extra?' | '+extra:'')); console.log(out[out.length-1]); };
const statusMsgs = [];
// Node-side status polling (statusMsgs lives in Node, NOT in the page —
// referencing it inside page.waitForFunction throws on the first poll).
async function waitStatus(re, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = statusMsgs.filter(s => re.test(s)).pop();
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}
let t0 = Date.now();
const stamp = () => `[${((Date.now()-t0)/1000).toFixed(1)}s]`;

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
    args: ['--js-flags=--max-old-space-size=6144', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  page.on('pageerror', e => out.push('PAGEERROR | ' + e.message));
  page.on('console', m => { const t = m.text(); if (t.startsWith('[Status:')) statusMsgs.push(t); });
  page.on('dialog', d => d.type() === 'prompt' ? d.accept('QA P6 Preset') : d.accept());
  // Headless must not try the File System Access save picker → anchor download.
  await page.addInitScript(() => { try { delete window.showSaveFilePicker; } catch {} window.showSaveFilePicker = undefined; });

  await page.goto(`http://127.0.0.1:${PORT}/AutoOpenCaptionApp/app/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.App && App.timeline, null, { timeout: 60000 });

  // Counting pass-through on the one funnel that stages history (never replace).
  await page.evaluate(() => {
    window.__saves = 0;
    const orig = App.saveState.bind(App);
    App.saveState = (...a) => { window.__saves++; return orig(...a); };
  });

  const state = () => page.evaluate(() => ({
    transcribeDisabled: document.getElementById('btn-transcribe').disabled,
    generateDisabled: document.getElementById('btn-generate').disabled,
    srtDisabled: document.getElementById('btn-export-srt').disabled,
    ctcHidden: document.getElementById('btn-ctc-realign').classList.contains('hidden'),
    hasTranscript: !!App.transcript,
    ffmpegLoaded: App.ffmpegLoaded,
  }));

  // ── S0 gating ─────────────────────────────────────────────────────────
  let st = await state();
  ok('S0 transcribe+generate disabled before video', st.transcribeDisabled && st.generateDisabled, JSON.stringify(st));

  await page.evaluate(async () => {
    const resp = await fetch('http://127.0.0.1:8750/tl_clip_speech.mp4');
    const blob = await resp.blob();
    App.loadVideo(new File([blob], 'tl_clip_speech.mp4', { type: 'video/mp4' }));
  });
  await page.waitForFunction(() => App.video && App.video.duration > 0, null, { timeout: 30000 });
  await page.waitForFunction(() => App.ffmpegLoaded === true, null, { timeout: 60000 });
  st = await state();
  ok('S0 transcribe enabled after video, generate still gated',
     !st.transcribeDisabled && st.generateDisabled && st.srtDisabled && !st.hasTranscript);

  // ── S1 real transcription (bundled whisper-base, real WASM inference) ──
  await page.click('#btn-transcribe');
  const tt0 = Date.now();
  let tr = null;
  try {
    await page.waitForFunction(() => (App.transcript && App.transcript.words && App.transcript.words.length > 0)
      || !App._transcribeRunning, null, { timeout: 600000 });
    await page.waitForFunction(() => !App._transcribeRunning, null, { timeout: 30000 });
  } catch (e) { /* assertions below report what state we landed in */ }
  tr = await page.evaluate(() => App.transcript ? {
    words: App.transcript.words.length,
    text: App.transcript.words.map(w => w.text).join(' ').toLowerCase(),
    missing: App.transcript.words.filter(w => w.origText === undefined || w.origStart === undefined || w.origEnd === undefined).length,
    bad: App.transcript.words.filter(w => !(w.start >= 0) || !(w.end >= w.start)).length,
    estimated: App.transcript.words.filter(w => !!w.estimated).length,
    repaired: App.transcript.repairedTimestamps,
    audioCached: !!App._audioCache && App._audioCache.file === App.videoFile,
    lang: App.transcript.language,
  } : null);
  const tsecs = ((Date.now()-tt0)/1000).toFixed(1);
  ok('S1 transcription produced words', !!tr && tr.words > 3, tr ? `${tr.words} words in ${tsecs}s` : 'no transcript');
  if (tr) {
    const hits = ['quick','brown','fox','lazy','dog','caption','timing','check'].filter(w => tr.text.includes(w)).length;
    ok('S1 speech recognisable (>=5 expected tokens)', hits >= 5, `${hits}/8: "${tr.text.slice(0,90)}"`);
    ok('S1 orig* snapshot on every word', tr.missing === 0);
    ok('S1 timestamps sane (start>=0, end>=start)', tr.bad === 0);
    ok('S1 audio cached for CTC (same file)', tr.audioCached === true);
    console.log(stamp(), `S1 estimated=${tr.estimated} repaired=${tr.repaired} lang=${tr.lang}`);
  }
  st = await state();
  ok('S1 SRT export enabled + CTC button shown after transcript', !st.srtDisabled && !st.ctcHidden, JSON.stringify(st));
  const rendered = await page.evaluate(() => ({
    chips: document.querySelectorAll('.word-chip').length,
    display: (document.querySelector('#transcript-display')?.innerText || document.body.innerText).length,
    srtCues: (App.generateSRT().match(/\d+\r?\n\d\d:/g) || []).length,
  }));
  ok('S1 editor chips render; SRT groups words into cues', rendered.chips === tr.words && rendered.srtCues >= 1 && rendered.srtCues <= tr.words, JSON.stringify(rendered));

  // ── S2 estimated-flag flow via inspector ──────────────────────────────
  await page.evaluate(() => {
    // Simulate an ASR word whose timing was estimated (sanitize output shape).
    App.transcript.words[1].estimated = true;
    App.renderTranscriptEditor();
    App.selectWord(1, { seek: false });
  });
  await page.waitForTimeout(150);
  let chip = await page.evaluate(() => {
    const c = document.querySelector('.word-chip[data-index="1"]');
    return c ? c.className : null;
  });
  ok('S2 estimated word shows needs-attention', !!chip && /needs-attention/.test(chip), chip);
  const savesBefore = await page.evaluate(() => window.__saves);
  const startBefore = await page.evaluate(() => App.transcript.words[1].start);
  await page.click('#inspector-start-plus');
  await page.waitForTimeout(150);
  chip = await page.evaluate(() => document.querySelector('.word-chip[data-index="1"]').className);
  const startAfter = await page.evaluate(() => App.transcript.words[1].start);
  const savesAfter = await page.evaluate(() => window.__saves);
  ok('S2 nudge: +0.05 s, one save, chip flips to adjusted (green beats attention)',
     Math.abs((startAfter - startBefore) - 0.05) < 1e-6 && (savesAfter - savesBefore) === 1
     && /adjusted/.test(chip) && !/needs-attention/.test(chip), `d=${(startAfter-startBefore).toFixed(3)} chip="${chip}"`);

  // ── S3 real CTC realign + revert ──────────────────────────────────────
  const preCtc = await page.evaluate(() => JSON.stringify(App.transcript.words.map(w => [w.start, w.end, w.estimated || false])));
  const savesBeforeCtc = await page.evaluate(() => window.__saves);
  console.log(stamp(), 'S3 realign start (91 MB CTC model may download)');
  const realignStartLen = statusMsgs.length;
  await page.click('#btn-ctc-realign');
  const ctcLine = await waitStatus(/\[Status:(success|error|warning)\].*(Realigned|Realign failed|Realign cancelled)/, 900000)
    || statusMsgs.slice(realignStartLen).filter(s => /Realign|Realigned/.test(s)).pop() || null;
  await page.waitForFunction(() => !App._ctcRunning, null, { timeout: 60000 });
  console.log(stamp(), 'S3 status:', ctcLine);
  ok('S3 realign completed without error', !!ctcLine && /Realigned/.test(ctcLine), ctcLine || 'no status line');
  if (ctcLine && /Realigned/.test(ctcLine)) {
    const c = await page.evaluate((preJson) => {
      const pre = JSON.parse(preJson);
      const post = App.transcript.words.map(w => [w.start, w.end, w.estimated || false]);
      let changed = 0, monotone = true, changedButEstimated = 0;
      const adjusted = App.transcript.words.map((w) => App.isWordAdjusted(w));
      const preservedOk = pre.every((p, i) => !adjusted[i] || (p[0] === post[i][0] && p[1] === post[i][1]));
      for (let i = 0; i < post.length; i++) {
        if (post[i][0] !== pre[i][0] || post[i][1] !== pre[i][1]) { changed++; if (post[i][2]) changedButEstimated++; }
        if (i > 0 && post[i][0] < post[i-1][0] - 1e-9) monotone = false;
      }
      return { changed, monotone, preservedOk, changedButEstimated, hasSnapshot: !!App._ctcSnapshot,
               savesDelta: window.__saves, adjustedCount: adjusted.filter(Boolean).length };
    }, preCtc);
    ok('S3 some words re-timed by CTC, snapshot stored', c.changed > 0 && c.hasSnapshot, `changed=${c.changed} snapshot=${c.hasSnapshot}`);
    ok('S3 user-adjusted words preserved', c.preservedOk === true, `adjusted=${c.adjustedCount}`);
    ok('S3 word order stays monotonic', c.monotone === true);
    ok('S3 re-timed words no longer estimated', c.changedButEstimated === 0);
    // Revert
    await page.click('#btn-ctc-revert');
    const revLine = await waitStatus(/Reverted timing/, 60000);
    const back = await page.evaluate((preJson) => JSON.stringify(App.transcript.words.map(w => [w.start, w.end, w.estimated || false])) === preJson && !App._ctcSnapshot, preCtc);
    ok('S3 revert restores pre-realign timings+flags exactly', back === true);
  }

  // ── S4 styling + presets ──────────────────────────────────────────────
  await page.evaluate(() => {
    const set = (id, v, evs) => { const el = document.getElementById(id); el.value = v; for (const e of evs) el.dispatchEvent(new Event(e, { bubbles: true })); };
    set('range-main-size', 58, ['input', 'change']);
    set('color-text', '#ff0000', ['input', 'change']);
  });
  await page.waitForTimeout(250);
  let sty = await page.evaluate(() => ({ mainSize: App.style.mainSize, color: App.style.textColor }));
  ok('S4 style controls drive App.style live', sty.mainSize === 58 && /ff0000/i.test(sty.color), JSON.stringify(sty));
  await page.click('#btn-save-preset');   // prompt dialog answers 'QA P6 Preset'
  let presetInList = false;
  const pl0 = Date.now();
  while (Date.now() - pl0 < 30000) {
    presetInList = await page.evaluate(() => [...document.getElementById('sel-preset').options]
      .some(o => o.value === 'QA P6 Preset' || o.text === 'QA P6 Preset'));
    if (presetInList) break;
    await page.waitForTimeout(500);
  }
  ok('S4 preset saved and listed', presetInList);
  await page.evaluate(() => { const el = document.getElementById('color-text'); el.value = '#00ff00'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForTimeout(150);
  await page.evaluate(() => { document.getElementById('sel-preset').value = 'QA P6 Preset'; });
  await page.click('#btn-load-preset');
  await page.waitForTimeout(300);
  sty = await page.evaluate(() => ({ color: App.style.textColor, mainSize: App.style.mainSize, uiColor: document.getElementById('color-text').value }));
  ok('S4 preset load restores style (roundtrip)', /ff0000/i.test(sty.color) && sty.mainSize === 58, JSON.stringify(sty));
  const dlPreset = page.waitForEvent('download', { timeout: 30000 });
  await page.evaluate(() => { document.getElementById('sel-preset').value = 'QA P6 Preset'; });
  await page.click('#btn-export-preset');
  let presetJsonOk = false, presetName = '';
  try {
    const d = await dlPreset;
    presetName = d.suggestedFilename();
    const p = path.join(SCRATCH, 'tl_phase6_preset.json');
    await d.saveAs(p);
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    presetJsonOk = !!(j.name && j.font && j.effects && j.grouping);
  } catch (e) { presetName = 'ERR ' + e.message; }
  ok('S4 preset export JSON has name/font/effects/grouping', presetJsonOk, presetName);

  // ── S5 create funnel on the real transcript ───────────────────────────
  // Park the playhead in a real gap: default 1.0 s caption would otherwise
  // legitimately collide with a neighbouring word ("no room" rejection).
  const firstStart = await page.evaluate(() => Math.min(...App.transcript.words.filter(w => !w.deleted).map(w => w.start)));
  const parkAt = Math.max(0.05, firstStart - 1.05);
  console.log(stamp(), `S5 parking playhead at ${parkAt.toFixed(2)} (first word ${firstStart.toFixed(2)})`);
  await page.evaluate((t) => { App.video.currentTime = t; }, parkAt);
  await page.waitForTimeout(300);
  const wordCountBefore = await page.evaluate(() => App.transcript.words.length);
  const savesBeforeCreate = await page.evaluate(() => window.__saves);
  await page.click('#btn-tl-add-caption');
  await page.waitForTimeout(300);
  const createRes = await page.evaluate((before) => ({
    words: App.transcript.words.length, saves: window.__saves - before,
  }), savesBeforeCreate);
  ok('S5 playhead create: +1 word, one save', createRes.words === wordCountBefore + 1 && createRes.saves === 1, JSON.stringify(createRes));

  // ── S6 real burn-in export ────────────────────────────────────────────
  await page.evaluate(() => {
    const set = (id, v, evs) => { const el = document.getElementById(id); el.value = v; for (const e of evs) el.dispatchEvent(new Event(e, { bubbles: true })); };
    set('sel-render-fps', '', ['change']);
    set('range-render-crf-num', '26', ['input', 'change']);
    set('sel-render-preset', 'ultrafast', ['change']);
    set('sel-render-audio', 'copy', ['change']);
  });
  fs.copyFileSync(SPEECH, SRC_MP4); // local copy of the source for frame diffs
  console.log(stamp(), 'S6 encode start (ffmpeg.wasm)');
  const dl = page.waitForEvent('download', { timeout: 1200000 });
  await page.click('#btn-generate');
  let outPath = null;
  try {
    const d = await dl;
    outPath = path.join(SCRATCH, 'tl_phase6_out.mp4');
    await d.saveAs(outPath);
  } catch (e) { console.log(stamp(), 'S6 download wait failed:', e.message); }
  const expLine0 = await waitStatus(/Video exported|export failed/, 30000);
  const expLine = expLine0 || statusMsgs.filter(s => /Video exported|export failed/.test(s)).pop() || null;
  ok('S6 export finished with success status', !!expLine && /Video exported/.test(expLine), expLine || 'no status line');
  if (outPath && fs.existsSync(outPath)) {
    const size = fs.statSync(outPath).size;
    ok('S6 output file non-trivial', size > 40000, `${size} bytes`);
    let dur = 0, codecs = [];
    try {
      const j = JSON.parse(execFileSync(FFPROBE, ['-v','error','-show_streams','-show_format','-of','json', outPath]).toString());
      dur = parseFloat(j.format.duration);
      codecs = j.streams.map(s => s.codec_name);
    } catch (e) { console.log('ffprobe error', e.message); }
    ok('S6 output duration ~ source (8.7 s ± 0.8)', Math.abs(dur - 8.744) < 0.8, `${dur}s`);
    ok('S6 output has h264 video + aac audio', codecs.includes('h264') && codecs.includes('aac'), codecs.join(','));
    const frame = (src, t, dst) => execFileSync(FFMPEG, ['-v','error','-ss',String(t),'-i',src,'-frames:v','1','-y',dst]);
    // PSNR between an output frame and the source frame at the same time:
    // high = untouched, low = captions burned into the frame.
    const diffMetric = (a, b) => {
      const r = require('child_process').spawnSync(FFMPEG, ['-nostats','-hide_banner','-i',a,'-i',b,'-lavfi','psnr','-f','null','-'], { encoding: 'utf8' });
      const m = ((r.stderr || '') + (r.stdout || '')).match(/average:([0-9inf\.]+)/);
      return m ? m[1] : 'n/a';
    };
    const f = (tag) => path.join(SCRATCH, `tl_phase6_${tag}.png`);
    // Quiet frame must sit BEFORE every caption that exists now — including
    // the S5 playhead create parked at parkAt seconds earlier.
    const quietT = Math.max(0.02, parkAt - 0.04);
    frame(outPath, quietT, f('out_04')); frame(SRC_MP4, quietT, f('src_04'));
    frame(outPath, 3.0, f('out_30')); frame(SRC_MP4, 3.0, f('src_30'));
    const psQuiet = diffMetric(f('out_04'), f('src_04'));
    const psCaption = diffMetric(f('out_30'), f('src_30'));
    console.log(stamp(), `S6 frame PSNR vs source: silent-window=${psQuiet} caption-window=${psCaption}`);
    const num = (x) => { if (x === 'inf') return 999; const v = parseFloat(x); return isNaN(v) ? -1 : v; };
    ok('S6 silent window frames match source (caption-free region untouched)', num(psQuiet) > 25, `PSNR=${psQuiet}`);
    ok('S6 caption window frames visibly differ (captions burned in)', num(psCaption) >= 0 && num(psCaption) < Math.min(num(psQuiet), 32), `PSNR=${psCaption}`);
  } else {
    ok('S6 output file exists', false, outPath || 'no download');
  }

  // ── S7 cancel path on the 60 s clip ───────────────────────────────────
  await page.evaluate(async () => {
    const resp = await fetch('http://127.0.0.1:8750/tl_clip_60.mp4');
    const blob = await resp.blob();
    App.loadVideo(new File([blob], 'tl_clip_60.mp4', { type: 'video/mp4' }));
  });
  await page.waitForFunction(() => App.video && App.video.duration > 50, null, { timeout: 30000 });
  await page.evaluate(() => {
    const mk = (id, text, s, e) => ({ id, text, start: s, end: e, deleted: false,
      origStart: s, origEnd: e, originalStart: s, originalEnd: e,
      estimated: false, userAdjusted: true, origText: text });
    const ws = [];
    for (let i = 0; i < 20; i++) ws.push(mk('w' + i, 'word' + i, 2 + i * 2.4, 2.6 + i * 2.4));
    App.transcript = { words: ws, language: 'en' };
    App.rebuildLayout();
    App.renderTranscriptEditor();
    App.timeline.invalidate();
  });
  await page.waitForTimeout(400);
  let extraDownload = false;
  page.once('download', () => { extraDownload = true; });
  await page.click('#btn-generate');
  await page.waitForFunction(() => !document.getElementById('progress-overlay').classList.contains('hidden'), null, { timeout: 20000 });
  await page.waitForTimeout(2500);
  await page.click('#btn-cancel-progress');
  const cancelLine = await waitStatus(/Export cancelled/, 120000);
  ok('S7 export cancel mid-render reported', !!cancelLine, cancelLine || 'no status line');
  let reinit = false;
  try { await page.waitForFunction(() => App.ffmpegLoaded === true && !App._exportRunning, null, { timeout: 120000 }); reinit = true; } catch {}
  ok('S7 FFmpeg worker re-initialised after cancel', reinit);
  await page.waitForTimeout(1000);
  ok('S7 no download after cancelled export', extraDownload === false);

  // ── summary ───────────────────────────────────────────────────────────
  const errs = out.filter(l => l.startsWith('PAGEERROR'));
  ok('no page errors', errs.length === 0, errs.map(e => e.slice(0, 140)).join(' || ') || 'clean');
  server.close();
  await browser.close();
  const fails = out.filter(l => l.startsWith('FAIL') || l.startsWith('PAGEERROR'));
  console.log('\n===== PHASE 6 FULL-WORKFLOW QA: ' + (out.filter(l=>l.startsWith('PASS')).length) + ' PASS / ' + fails.length + ' FAIL =====');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); try { server.close(); } catch {} process.exit(2); });
