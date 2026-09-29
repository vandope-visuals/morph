// m-or.ph test + benchmark harness.
//
//   node run.mjs                     smoke + bench + screenshots → results/latest.json
//   node run.mjs --only smoke        (smoke | bench | shots, comma separated)
//   node run.mjs --baseline other.json   compare bench against another run (default: baseline/bench.json)
//   node run.mjs --save-baseline     overwrite baseline/ with this run (bench.json and/or shots/)
//
// baseline/bench.json = original v1.5 numbers (M1, Chromium, ANGLE Metal). Keep it as the
// reference; only re-save shots when a visual change is intentional.
//
// Depends on these globals staying reachable from page scope (update here if renamed):
//   renderFrame, MODULE_PROCESSORS, addModule, removeModule, pickSource, sources, state,
//   _applyResolution, _governorTick, _perfLevel, outputCtx, W, H
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const RESULTS = path.join(HERE, 'results');
const FIXTURES = path.join(HERE, 'fixtures');
fs.mkdirSync(RESULTS, { recursive: true });
fs.mkdirSync(FIXTURES, { recursive: true });

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const only = (opt('--only') || 'smoke,bench,shots').split(',');
const BASELINE = path.join(HERE, 'baseline');
const baselinePath = opt('--baseline') || path.join(BASELINE, 'bench.json');
const saveBaseline = flag('--save-baseline');
const headed = flag('--headed');

const EFFECTS = {
  keyer: 'processor', color: 'processor', geometry: 'processor', feedback: 'processor',
  pixelops: 'processor', ascii: 'processor', vhs: 'glitch', signalnoise: 'glitch',
  rowshift: 'glitch', datamosh: 'glitch', blockcorrupt: 'glitch', pixelsort: 'glitch',
};
const MODULATORS = ['envelope', 'xypad', 'randwalk', 'sequencer', 'audio', 'perlin'];

// ── static server ──
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.ico': 'image/x-icon', '.webm': 'video/webm', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = p.endsWith('/') ? path.join(p, 'index.html') : p;
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

// ── fixtures ──
function makeTestCard() {
  const f = path.join(FIXTURES, 'testcard.png');
  if (fs.existsSync(f)) return f;
  const w = 1280, h = 720, png = new PNG({ width: w, height: h });
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, band = Math.floor(x / (w / 8));
    const bars = [[255,255,255],[255,255,0],[0,255,255],[0,255,0],[255,0,255],[255,0,0],[0,0,255],[0,0,0]][band];
    const g = (x / w) * 255, n = rnd() * 60;
    const top = y < h * 0.6;
    png.data[i] = top ? bars[0] : (g + n) % 256;
    png.data[i + 1] = top ? bars[1] : ((y / h) * 255 + n) % 256;
    png.data[i + 2] = top ? bars[2] : (255 - g) % 256;
    png.data[i + 3] = 255;
  }
  fs.writeFileSync(f, PNG.sync.write(png));
  return f;
}

async function makeTestVideo(browser) {
  const f = path.join(FIXTURES, 'test.webm');
  if (fs.existsSync(f)) return f;
  const page = await browser.newPage();
  await page.goto('about:blank');
  const b64 = await page.evaluate(async () => {
    const cv = document.createElement('canvas'); cv.width = 640; cv.height = 360;
    const ctx = cv.getContext('2d');
    const rec = new MediaRecorder(cv.captureStream(30), { mimeType: 'video/webm;codecs=vp8' });
    const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((r) => (rec.onstop = r));
    rec.start(); const t0 = performance.now();
    await new Promise((r) => {
      (function f() {
        const t = (performance.now() - t0) / 1000;
        ctx.fillStyle = `hsl(${t * 120},80%,50%)`; ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#fff'; ctx.fillRect(((t * 200) % 700) - 60, 120, 60, 120);
        ctx.font = '48px monospace'; ctx.fillText(t.toFixed(2), 20, 60);
        if (t < 4) requestAnimationFrame(f); else r();
      })();
    });
    rec.stop(); await done;
    const buf = await new Blob(chunks).arrayBuffer();
    let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
  });
  fs.writeFileSync(f, Buffer.from(b64, 'base64'));
  await page.close();
  return f;
}

// ── boot a fresh app page ──
async function bootApp(context, { theme } = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.addInitScript(() => {
    try { localStorage.setItem('morph_tut_done', '1'); localStorage.setItem('morph_tut_seen', '1'); } catch (e) {}
  });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.evaluate(() => { if (typeof dismissBoot === 'function') dismissBoot(); });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const ls = document.getElementById('boot-launch-screen'); if (ls) ls.style.display = 'none';
    const tc = document.getElementById('tut-card'); if (tc) tc.style.display = 'none';
    // pin the governor so benchmarks run at full resolution
    window._governorTick = () => {};
    try { _perfLevel = 0; } catch (e) {}
    if (typeof _applyResolution === 'function') _applyResolution(854, 480);
  });
  await page.waitForTimeout(200);
  return { page, errors };
}

// ── in-page helpers (installed per page) ──
const PAGE_HELPERS = () => {
  window.__h = {
    // Run renderFrame n times synchronously (rAF stubbed), force a GPU flush, return ms/frame.
    frames(n = 30) {
      const raf = window.requestAnimationFrame;
      window.requestAnimationFrame = () => 0;
      try {
        for (let i = 0; i < 3; i++) renderFrame();
        outputCtx.getImageData(0, 0, 1, 1);
        const t0 = performance.now();
        for (let i = 0; i < n; i++) renderFrame();
        outputCtx.getImageData(0, 0, 1, 1);
        return (performance.now() - t0) / n;
      } finally { window.requestAnimationFrame = raf; }
    },
    clearModules() { state.modules.slice().forEach((m) => removeModule(m.id)); },
    add(name, type) {
      // original addModule ids are 'm'+Date.now(): wait for the clock to tick so ids never collide
      const t = Date.now(); while (Date.now() === t) {}
      addModule(name, type, '#fff'); return state.modules[state.modules.length - 1];
    },
    outputStats() {
      const d = outputCtx.getImageData(0, 0, W, H).data; let sum = 0, nz = 0;
      for (let i = 0; i < d.length; i += 16) { sum += d[i] + d[i + 1] + d[i + 2]; if (d[i] | d[i + 1] | d[i + 2]) nz++; }
      return { mean: sum / (d.length / 16) / 3, nonBlack: nz / (d.length / 16) };
    },
  };
};

async function loadImage(page, slot, file) {
  await page.evaluate((s) => pickSource('image'), slot);
  await page.setInputFiles(slot === 'A' ? '#imageA' : '#imageB', file);
  await page.waitForFunction((s) => sources[s].active, slot, { timeout: 5000 });
}
async function loadVideo(page, slot, file) {
  await page.evaluate(() => pickSource('video'));
  await page.setInputFiles(slot === 'A' ? '#fileA' : '#fileB', file);
  await page.waitForFunction((s) => sources[s].active && sources[s].vidEl && sources[s].vidEl.readyState >= 2, slot, { timeout: 8000 });
}

const results = { when: new Date().toISOString(), smoke: {}, bench: {}, shots: {} };

const browser = await chromium.launch({
  headless: !headed,
  args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', '--enable-gpu',
    '--use-angle=metal', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  ],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] });
const card = makeTestCard();
const video = await makeTestVideo(browser);

// ─────────────────────────── SMOKE ───────────────────────────
if (only.includes('smoke')) {
  const { page, errors } = await bootApp(context);
  await page.evaluate(PAGE_HELPERS);
  const s = results.smoke;
  s.gl = await page.evaluate(() => {
    const c = document.createElement('canvas').getContext('webgl2');
    const ext = c && c.getExtension('WEBGL_debug_renderer_info');
    return { ready: typeof GLProcessor !== 'undefined' && GLProcessor.ready(), renderer: ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null };
  });
  const step = async (name, fn) => {
    const before = errors.length;
    try { await fn(); } catch (e) { errors.push(`${name}: ${e.message}`); }
    s[name] = errors.length === before ? 'ok' : errors.slice(before);
  };
  await step('source:image', () => loadImage(page, 'A', card));
  await step('source:video', () => loadVideo(page, 'B', video));
  await step('frames:image+video', () => page.evaluate(() => __h.frames(10)));
  for (const t of ['pattern', 'math', 'color', 'text', 'webcam']) {
    await step('source:' + t, async () => {
      await page.evaluate((t) => { startPickMode('A'); pickSource(t); }, t);
      await page.waitForTimeout(t === 'webcam' ? 1500 : 150);
      await page.evaluate(() => __h.frames(5));
    });
  }
  await step('source:pattern-presets', () => page.evaluate(async () => {
    startPickMode('A'); pickSource('pattern');
    for (let p = 0; p < 8; p++) { sources.A.genParam = { ...(sources.A.genParam || {}), preset: p }; sources.A.genState = null; __h.frames(3); }
  }));
  await step('source:math-presets', () => page.evaluate(async () => {
    startPickMode('A'); pickSource('math');
    for (let p = 0; p < 8; p++) { sources.A.genParam = { ...(sources.A.genParam || {}), preset: p }; sources.A.genState = null; __h.frames(3); }
  }));
  for (const [name, type] of Object.entries(EFFECTS)) {
    await step('fx:' + name, () => page.evaluate(([name, type]) => {
      __h.clearModules(); const m = __h.add(name, type);
      for (let fx = 0; fx < 8; fx++) { if (typeof setFx === 'function') { try { setFx(m.id, fx); } catch (e) { m.activeFx = fx; } } else m.activeFx = fx; __h.frames(3); }
    }, [name, type]));
  }
  for (const name of MODULATORS) {
    await step('mod:' + name, async () => {
      await page.evaluate((name) => { __h.clearModules(); __h.add('color', 'processor'); __h.add(name, 'modulator'); }, name);
      await page.waitForTimeout(name === 'audio' ? 1200 : 100);
      await page.evaluate(() => __h.frames(10));
    });
  }
  await step('max-chain', () => page.evaluate(() => {
    __h.clearModules(); ['color', 'geometry', 'vhs'].forEach((n) => __h.add(n, n === 'vhs' ? 'glitch' : 'processor'));
    __h.add('feedback', 'processor'); __h.add('pixelsort', 'glitch'); __h.frames(10);
    const st = __h.outputStats(); if (st.nonBlack < 0.05) throw new Error('output is black: ' + JSON.stringify(st));
  }));
  await step('output-window', async () => {
    const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 5000 }), page.evaluate(() => openOutput())]);
    await popup.waitForLoadState();
    await page.waitForTimeout(300);
    const hasKey = await popup.evaluate(() => !!document.querySelector('script') );
    if (!hasKey) throw new Error('output window has no <script> (F-to-fullscreen handler missing)');
    await popup.close(); await page.waitForTimeout(1300);
    const streaming = await page.evaluate(() => state.outputStreaming);
    if (streaming) throw new Error('outputStreaming still true after popup closed');
  });
  await step('theme+crt toggles', () => page.evaluate(() => { toggleTheme(); toggleTheme(); toggleCRT(); toggleCRT(); toggleCRT(); toggleCRT(); }));
  s._errorCount = errors.length;
  await page.close();
}

// ─────────────────────────── BENCH ───────────────────────────
if (only.includes('bench')) {
  const { page } = await bootApp(context);
  await page.evaluate(PAGE_HELPERS);
  const b = results.bench;
  b.resolution = await page.evaluate(() => [W, H]);
  b.idle = await page.evaluate(() => __h.frames(60));
  await loadImage(page, 'A', card);
  b.imageOnly = await page.evaluate(() => __h.frames(60));

  // per effect × mode, image source only; value = ms/frame minus imageOnly
  b.fx = {};
  for (const [name, type] of Object.entries(EFFECTS)) {
    b.fx[name] = await page.evaluate(([name, type, base]) => {
      __h.clearModules(); const m = __h.add(name, type); const out = [];
      for (let fx = 0; fx < 8; fx++) {
        try { setFx(m.id, fx); } catch (e) { m.activeFx = fx; }
        out.push(+(__h.frames(20) - base).toFixed(2));
      }
      __h.clearModules(); return out;
    }, [name, type, b.imageOnly]);
  }

  // generator sources (A only, no effects)
  b.pattern = []; b.math = [];
  for (const kind of ['pattern', 'math']) {
    b[kind] = await page.evaluate((kind) => {
      __h.clearModules(); startPickMode('A'); pickSource(kind); const out = [];
      for (let p = 0; p < 8; p++) { sources.A.genParam = { ...(sources.A.genParam || {}), preset: p, speed: 0.5 }; sources.A.genState = null; out.push(+__h.frames(20).toFixed(2)); }
      return out;
    }, kind);
  }

  // realistic scenarios, end to end
  const scenario = async (label, setup) => {
    await page.evaluate(() => { __h.clearModules(); });
    await setup();
    await page.waitForTimeout(300);
    b['scenario:' + label] = await page.evaluate(() => +__h.frames(60).toFixed(2));
  };
  await scenario('typical (plasma + lorenz → color, geometry, vhs, feedback)', () => page.evaluate(() => {
    startPickMode('A'); pickSource('pattern'); sources.A.genParam = { preset: 0, speed: 0.5 };
    startPickMode('B'); pickSource('math'); sources.B.genParam = { preset: 0, speed: 0.5 };
    __h.add('color', 'processor'); const g = __h.add('geometry', 'processor'); try { setFx(g.id, 3); } catch (e) {}
    const v = __h.add('vhs', 'glitch'); try { setFx(v.id, 7); } catch (e) {}
    __h.add('feedback', 'processor');
  }));
  await scenario('video + image → keyer, pixelops bloom, rowshift, lfo', async () => {
    await loadVideo(page, 'A', video); await loadImage(page, 'B', card);
    await page.evaluate(() => {
      __h.add('keyer', 'processor'); const p = __h.add('pixelops', 'processor'); try { setFx(p.id, 6); } catch (e) {}
      __h.add('rowshift', 'glitch'); __h.add('envelope', 'modulator');
    });
  });
  await scenario('GL-only chain x4 (color, geometry, vhs, rowshift)', () => page.evaluate(() => {
    startPickMode('A'); pickSource('color');
    __h.add('color', 'processor'); __h.add('geometry', 'processor'); __h.add('vhs', 'glitch'); __h.add('rowshift', 'glitch');
  }));
  await page.close();
}

// ───────────────────────── SCREENSHOTS ─────────────────────────
if (only.includes('shots')) {
  const shotDir = path.join(RESULTS, 'shots');
  const baseDir = path.join(BASELINE, 'shots');
  fs.mkdirSync(shotDir, { recursive: true });
  const { page } = await bootApp(context);
  await page.evaluate(PAGE_HELPERS);
  await page.addStyleTag({ content: `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}
    #crt-glitch-line,#crt-glitch-band,#crt-roller,#crt-flicker{opacity:0!important}
    canvas,video{visibility:hidden!important}
    #fps-big{visibility:hidden!important}` });
  await page.evaluate(() => { __h.add('color', 'processor'); __h.add('ascii', 'processor'); __h.add('xypad', 'modulator'); });
  await page.waitForTimeout(1200);
  const states = {
    'dark+crt': { dark: true, crt: true }, dark: { dark: true, crt: false },
    light: { dark: false, crt: false }, 'light+crt': { dark: false, crt: true },
  };
  for (const [label, st] of Object.entries(states)) {
    await page.evaluate((st) => {
      if (document.body.classList.contains('dark') !== st.dark) toggleTheme();
      if (document.body.classList.contains('crt') !== st.crt) toggleCRT();
    }, st);
    await page.waitForTimeout(250);
    await page.evaluate(() => document.querySelectorAll('.chain-scroll,.mod-list,.helper-body').forEach((el) => (el.scrollTop = 0)));
    const file = path.join(shotDir, label + '.png');
    await page.screenshot({ path: file });
    const entry = { file: path.relative(HERE, file) };
    const basef = path.join(baseDir, label + '.png');
    if (fs.existsSync(basef) && !saveBaseline) {
      const a = PNG.sync.read(fs.readFileSync(basef)), c = PNG.sync.read(fs.readFileSync(file));
      if (a.width === c.width && a.height === c.height) {
        const diff = new PNG({ width: a.width, height: a.height });
        const n = pixelmatch(a.data, c.data, diff.data, a.width, a.height, { threshold: 0.1 });
        entry.diffPct = +((n / (a.width * a.height)) * 100).toFixed(3);
        fs.writeFileSync(path.join(shotDir, label + '.diff.png'), PNG.sync.write(diff));
      } else entry.diffPct = 'size-mismatch';
    }
    results.shots[label] = entry;
  }
  if (saveBaseline) { fs.mkdirSync(baseDir, { recursive: true }); for (const f of fs.readdirSync(shotDir)) if (!f.includes('.diff')) fs.copyFileSync(path.join(shotDir, f), path.join(baseDir, f)); }
  await page.close();
}

await browser.close();
server.close();

fs.writeFileSync(path.join(RESULTS, 'latest.json'), JSON.stringify(results, null, 2));
if (saveBaseline && only.includes('bench')) { fs.mkdirSync(BASELINE, { recursive: true }); fs.writeFileSync(path.join(BASELINE, 'bench.json'), JSON.stringify(results, null, 2)); }

// ── report ──
const fmt = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v));
console.log('\n== smoke ==');
for (const [k, v] of Object.entries(results.smoke)) if (k !== 'gl') console.log((v === 'ok' ? '  ok   ' : '  FAIL ') + k + (v === 'ok' || typeof v === 'number' ? '' : '\n        ' + JSON.stringify(v).slice(0, 400)));
if (results.smoke.gl) console.log('  gl:', JSON.stringify(results.smoke.gl));
if (only.includes('bench')) {
  const base = baselinePath && fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath)).bench : null;
  console.log('\n== bench (ms/frame at ' + results.bench.resolution + ') ==' + (base ? '   [baseline → now]' : ''));
  for (const [k, v] of Object.entries(results.bench)) {
    if (k === 'resolution') continue;
    if (Array.isArray(v)) console.log('  ' + k.padEnd(14) + (base && base[k] ? base[k].map((x, i) => fmt(x) + '→' + fmt(v[i])).join('  ') : v.map(fmt).join('  ')));
    else if (typeof v === 'object') for (const [n, arr] of Object.entries(v)) console.log('  fx:' + n.padEnd(13) + (base && base[k] && base[k][n] ? base[k][n].map((x, i) => fmt(x) + '→' + fmt(arr[i])).join('  ') : arr.map(fmt).join('  ')));
    else console.log('  ' + k.padEnd(14) + (base && base[k] != null ? fmt(base[k]) + ' → ' : '') + fmt(v));
  }
}
if (only.includes('shots')) { console.log('\n== screenshots =='); for (const [k, v] of Object.entries(results.shots)) console.log('  ' + k.padEnd(10) + (v.diffPct != null ? 'diff ' + v.diffPct + '%' : 'saved')); }
const failed = Object.entries(results.smoke).filter(([k, v]) => k !== 'gl' && k !== '_errorCount' && v !== 'ok');
process.exit(failed.length ? 1 : 0);
