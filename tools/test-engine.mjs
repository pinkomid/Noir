/**
 * Headless smoke test for the development engine.
 * Runs the real pipeline against the bundled samples using a canvas shim,
 * so tonal math, grain, toning and export paths are verified outside a browser.
 *
 *   npm i -D @napi-rs/canvas && node tools/test-engine.mjs
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { writeFileSync, mkdirSync } from 'node:fs';

// --- Minimal DOM surface that engine.js expects ---------------------------
globalThis.document = {
  createElement(tag) {
    if (tag === 'canvas') return createCanvas(1, 1);
    return {};
  },
};

const { Darkroom } = await import('../js/engine.js');
const { paramsFor, PRESETS } = await import('../js/presets.js');

// --- Helpers --------------------------------------------------------------
function stats(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  let sum = 0, min = 255, max = 0, sat = 0, n = d.length / 4;
  const hist = new Uint32Array(256);
  let chroma = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
    hist[Math.round(v)]++;
    chroma += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
    if (v < 2 || v > 253) sat++;
  }
  return { mean: sum / n, min, max, hist, clipped: sat / n, chroma: chroma / n };
}

function percentile(hist, total, p) {
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc / total >= p) return i;
  }
  return 255;
}

const SAMPLE = process.argv[2] || 'assets/sample-portrait.jpg';
const img = await loadImage(SAMPLE);

console.log(`\nNOIR engine test — ${SAMPLE} (${img.width}×${img.height})\n`);

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const engine = new Darkroom();
engine.load(img, img.width, img.height);
console.log(`preview surface: ${engine.surfaceW}×${engine.surfaceH}`);

const W = 640;
const H = Math.round((img.height / img.width) * W);

function developWith(params, skipGrain = false) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  engine.develop(ctx, W, H, params, { skipGrain });
  return { canvas, ctx, s: stats(ctx, W, H) };
}

// --- 1. Baseline is monochrome -------------------------------------------
const base = developWith(paramsFor('noir'));
check('output is monochrome', base.s.chroma < 1.5, `chroma=${base.s.chroma.toFixed(2)}`);
check('baseline has full tonal range', base.s.min < 20 && base.s.max > 235,
  `min=${base.s.min} max=${base.s.max}`);
// Faithfulness, not brightness: a good develop should land near the
// negative's own density instead of silently lifting every photograph.
const rawMean = (() => {
  const c = createCanvas(W, H);
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0, W, H);
  const d = x.getImageData(0, 0, W, H).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  return sum / (d.length / 4);
})();
check('baseline keeps the negative\'s density', Math.abs(base.s.mean - rawMean) < 26,
  `negative=${rawMean.toFixed(1)} developed=${base.s.mean.toFixed(1)}`);

// --- 2. Every preset develops to a distinct, sane image ------------------
console.log('\npresets:');
const signatures = new Map();
for (const preset of PRESETS) {
  const { s, ctx } = developWith(paramsFor(preset.id));
  const p5 = percentile(s.hist, W * H, 0.05);
  const p95 = percentile(s.hist, W * H, 0.95);
  const sig = `${s.mean.toFixed(1)}/${p5}/${p95}`;
  const dup = signatures.get(sig);
  signatures.set(sig, preset.id);

  const sane = s.min >= 0 && s.max <= 255 && s.mean > 15 && s.mean < 245 && s.clipped < 0.22;
  check(`  ${preset.name.padEnd(14)}`, sane && !dup,
    `mean=${s.mean.toFixed(0)} p5=${p5} p95=${p95} clip=${(s.clipped * 100).toFixed(1)}%${dup ? ` (dup of ${dup})` : ''}`);
}

// --- 3. Controls move the image in the expected direction ---------------
console.log('\ncontrols:');
const noir = paramsFor('noir');
const noGrain = { ...noir, grain: 0 };

const dim = developWith({ ...noGrain, exposure: -1 }, true).s;
const bright = developWith({ ...noGrain, exposure: 1 }, true).s;
check('exposure +1 brightens / -1 darkens', bright.mean > base.s.mean && dim.mean < base.s.mean,
  `-1EV=${dim.mean.toFixed(0)} 0=${base.s.mean.toFixed(0)} +1EV=${bright.mean.toFixed(0)}`);

const soft = developWith({ ...noGrain, contrast: -80 }, true).s;
const hard = developWith({ ...noGrain, contrast: 80 }, true).s;
const spread = (s) => percentile(s.hist, W * H, 0.95) - percentile(s.hist, W * H, 0.05);
check('contrast widens the tonal spread', spread(hard) > spread(soft),
  `soft=${spread(soft)} hard=${spread(hard)}`);

const faded = developWith({ ...noGrain, fade: 80 }, true).s;
check('matte fade lifts the blacks', percentile(faded.hist, W * H, 0.01) > percentile(base.s.hist, W * H, 0.01) + 5,
  `p1 base=${percentile(base.s.hist, W * H, 0.01)} fade=${percentile(faded.hist, W * H, 0.01)}`);

const vig = developWith({ ...noGrain, vignette: -90 }, true);
const cornerLum = (() => {
  const d = vig.ctx.getImageData(0, 0, 40, 40).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
  return sum / (d.length / 4);
})();
const baseCorner = (() => {
  const d = developWith(noGrain, true).ctx.getImageData(0, 0, 40, 40).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
  return sum / (d.length / 4);
})();
check('vignette darkens the corners', cornerLum < baseCorner, `${baseCorner.toFixed(0)} → ${cornerLum.toFixed(0)}`);

// Grain: a uniform patch should get noisier
const flatGrain = developWith({ ...noGrain, grain: 90, grainSize: 1.4 }, false);
function patchSigma(ctx) {
  const d = ctx.getImageData(0, 0, 120, 120).data;
  const vals = [];
  for (let i = 0; i < d.length; i += 4) vals.push(d[i]);
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  const v = vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length;
  return Math.sqrt(v);
}
const sigmaClean = patchSigma(developWith({ ...noGrain }, true).ctx);
check('grain adds texture', patchSigma(flatGrain.ctx) > sigmaClean + 1.5,
  `sigma clean=${sigmaClean.toFixed(2)} grain=${patchSigma(flatGrain.ctx).toFixed(2)}`);

// Toning
for (const tone of ['sepia', 'cyan', 'selenium']) {
  const t = developWith({ ...noGrain, tone, toneStrength: 90 }, true);
  const d = t.ctx.getImageData(0, 0, W, H).data;
  let dr = 0, db = 0;
  for (let i = 0; i < d.length; i += 4) { dr += d[i]; db += d[i + 2]; }
  const warm = tone === 'sepia';
  check(`  toning ${tone}`, warm ? dr > db : tone === 'cyan' ? db > dr : db >= dr,
    `R=${(dr / (W * H)).toFixed(1)} B=${(db / (W * H)).toFixed(1)}`);
}

// Channel mix
const redLift = developWith({ ...noGrain, mixR: 0.9, mixG: 0.05, mixB: 0.05 }, true).s;
const blueLift = developWith({ ...noGrain, mixR: 0.05, mixG: 0.05, mixB: 0.9 }, true).s;
check('channel mix changes the density', Math.abs(redLift.mean - blueLift.mean) > 3,
  `red-mix=${redLift.mean.toFixed(0)} blue-mix=${blueLift.mean.toFixed(0)}`);

// --- 4. Histogram agrees with the render --------------------------------
const hist = engine.histogram(paramsFor('tri-x'));
check('histogram returns 256 bins with data', hist && hist.bins.length === 256 && hist.max > 0,
  hist ? `max=${hist.max} nonEmpty=${Array.from(hist.bins).filter(Boolean).length}` : 'null');

// --- 5. Full-resolution export path ------------------------------------
const full = createCanvas(img.width, img.height);
const fctx = full.getContext('2d');
const t0 = Date.now();
engine.develop(fctx, img.width, img.height, paramsFor('verite'), { source: engine.source });
const ms = Date.now() - t0;
const fs = stats(fctx, img.width, img.height);
check('full-resolution export develops', fs.chroma < 2 && fs.max > 200,
  `${img.width}×${img.height} in ${ms}ms, mean=${fs.mean.toFixed(0)}`);

// --- 6. Write visual proofs --------------------------------------------
mkdirSync('tools/out', { recursive: true });
const sheet = createCanvas(W * 3, H * 4);
const sctx = sheet.getContext('2d');
sctx.fillStyle = '#0a0a0b';
sctx.fillRect(0, 0, sheet.width, sheet.height);
PRESETS.slice(0, 12).forEach((preset, i) => {
  const { canvas } = developWith(paramsFor(preset.id));
  const x = (i % 3) * W;
  const y = Math.floor(i / 3) * H;
  sctx.drawImage(canvas, x, y, W - 4, H - 4);
  sctx.fillStyle = 'rgba(0,0,0,.72)';
  sctx.fillRect(x, y + H - 34, W - 4, 30);
  sctx.fillStyle = '#d9a55f';
  sctx.font = '15px sans-serif';
  sctx.fillText(preset.name, x + 10, y + H - 13);
});
writeFileSync('tools/out/preset-sheet.png', sheet.toBuffer('image/png'));

writeFileSync('tools/out/export-full.jpg', full.toBuffer('image/jpeg', 0.92));

console.log(`\nwrote tools/out/preset-sheet.png and tools/out/export-full.jpg`);
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);

process.exit(failures === 0 ? 0 : 1);
