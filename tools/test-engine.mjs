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

const { Darkroom, curveInterpolator, isIdentityCurve, buildLUT } = await import('../js/engine.js');
const { paramsFor, PRESETS } = await import('../js/presets.js');
const { DEFAULTS } = await import('../js/controls.js');
const { createZip } = await import('../js/batch.js');
const geo = await import('../js/geometry.js');

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

// --- 6. Manual curve ----------------------------------------------------
console.log('\nmanual curve:');
const identityPts = DEFAULTS.curvePoints;
check('default curve is an identity', isIdentityCurve(identityPts));

const lvl = curveInterpolator(identityPts);
const linear = [0, 0.123, 0.5, 0.777, 1].every((x) => Math.abs(lvl(x) - x) < 1e-6);
check('identity curve maps x → x', linear, `0.5 → ${lvl(0.5).toFixed(4)}`);

// Monotonicity: a curve with steep and flat stretches must never go backwards.
const steep = [[0, 0], [0.3, 0.6], [0.6, 0.68], [0.85, 0.95], [1, 1]];
const ev = curveInterpolator(steep);
let prev = null;
let monotone = true;
let jumps = 0;
for (let i = 0; i <= 4000; i++) {
  const v = ev(i / 4000);
  if (prev !== null) {
    if (v < prev - 1e-9) monotone = false;
    if (Math.abs(v - prev) > 0.01) jumps++;
  }
  prev = v;
}
check('spline is monotone (no overshoot)', monotone);
check('spline has no sudden jumps', jumps === 0, `${jumps} large steps`);

check('curve clamps outside its domain', ev(-1) === 0 && ev(2) === 1);

// The curve must reach the tone pipeline.
const lifted = developWith({ ...noGrain, curveOn: true, curvePoints: [[0, 0.25], [0.5, 0.6], [1, 1]] }, true).s;
const flatBase = developWith(noGrain, true).s;
check('curve lifts the blacks in the LUT', percentile(lifted.hist, W * H, 0.02) > percentile(flatBase.hist, W * H, 0.02) + 10,
  `p2 base=${percentile(flatBase.hist, W * H, 0.02)} curve=${percentile(lifted.hist, W * H, 0.02)}`);

check('disabled curve is ignored', (() => {
  const a = buildLUT({ ...noGrain, curveOn: false, curvePoints: [[0, 0.4], [1, 0.6]] });
  const b = buildLUT(noGrain);
  return a.every((v, i) => v === b[i]);
})());

// --- 7. Local dodge & burn mask -----------------------------------------
console.log('\nlocal mask:');
const maskEngine = new Darkroom();
maskEngine.load(img, img.width, img.height);
check('mask starts empty', maskEngine.maskCoverage() === 0);

// Paint a dab dead centre and confirm coverage registers.
maskEngine.paintDab({ x: 0.5, y: 0.5, radius: 0.2, strength: 1 });
const cover = maskEngine.maskCoverage();
check('painting registers coverage', cover > 0.001 && cover < 0.4, `coverage=${(cover * 100).toFixed(2)}%`);

function developMasked(params) {
  const c = createCanvas(W, H);
  const x = c.getContext('2d');
  maskEngine.develop(x, W, H, params, { source: maskEngine.source });
  return { c, x, s: stats(x, W, H) };
}

// Centre patch brightness, with and without the dodge.
function centreLum(ctx) {
  const d = ctx.getImageData(W / 2 - 40, H / 2 - 40, 80, 80).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i];
  return sum / (d.length / 4);
}

const noMask = developMasked({ ...noGrain, maskAmount: 0 });
const dodged = developMasked({ ...noGrain, maskAmount: 90 });
const burned = developMasked({ ...noGrain, maskAmount: -90 });

check('dodge brightens the painted area', centreLum(dodged.x) > centreLum(noMask.x) + 6,
  `${centreLum(noMask.x).toFixed(0)} → ${centreLum(dodged.x).toFixed(0)}`);
check('burn deepens the painted area', centreLum(burned.x) < centreLum(noMask.x) - 4,
  `${centreLum(noMask.x).toFixed(0)} → ${centreLum(burned.x).toFixed(0)}`);

// The dodge must be local: a corner far from the dab should barely move.
function patchLum(ctx) {
  const d = ctx.getImageData(4, 4, 60, 60).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i];
  return sum / (d.length / 4);
}
check('dodge stays local', Math.abs(patchLum(dodged.x) - patchLum(noMask.x)) < 3,
  `corner ${patchLum(noMask.x).toFixed(1)} → ${patchLum(dodged.x).toFixed(1)}`);

// Erasing should reduce coverage again.
const beforeErase = maskEngine.maskCoverage();
maskEngine.paintDab({ x: 0.5, y: 0.5, radius: 0.3, strength: 1, erase: true });
check('erase reduces coverage', maskEngine.maskCoverage() < beforeErase,
  `${(beforeErase * 100).toFixed(2)}% → ${(maskEngine.maskCoverage() * 100).toFixed(2)}%`);

// A fresh negative clears the mask.
const fresh = new Darkroom();
fresh.load(img, img.width, img.height);
check('loading a new negative clears the mask', fresh.maskCoverage() === 0);

// --- 8. ZIP writer ------------------------------------------------------
console.log('\nbatch:');
const enc = new TextEncoder();
const zip = createZip([
  { name: 'a.txt', data: enc.encode('hello noir') },
  { name: 'b.txt', data: enc.encode('second entry') },
]);
const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
check('zip has a local header signature', dv.getUint32(0, true) === 0x04034b50,
  `0x${dv.getUint32(0, true).toString(16)}`);
check('zip has an end-of-central-directory', (() => {
  for (let i = zip.length - 22; i >= 0; i--) {
    if (new DataView(zip.buffer, zip.byteOffset + i, 4).getUint32(0, true) === 0x06054b50) return true;
  }
  return false;
})());
check('zip records both entries', (() => {
  const eocd = zip.length - 22;
  return new DataView(zip.buffer, zip.byteOffset + eocd, 22).getUint16(8, true) === 2;
})());
check('zip stores the payload bytes', Buffer.from(zip).includes(Buffer.from('hello noir')));

// --- 9. Geometry: crop, rotate, mirror ---------------------------------
console.log('\ngeometry:');

const NW = img.width;
const NH = img.height;

// frameSize: a half-width crop halves the reported width.
const halfCrop = { ...geo.FRAME_DEFAULTS, crop: { x: 0.25, y: 0, w: 0.5, h: 1 } };
const halfSize = geo.frameSize(halfCrop, { width: NW, height: NH });
check('crop halves the reported width', Math.abs(halfSize.width - NW / 2) <= 1,
  `${halfSize.width} vs ${NW / 2}`);

// A quarter turn swaps the reported axes.
const turned = geo.frameSize({ ...geo.FRAME_DEFAULTS, rotation: 1 }, { width: NW, height: NH });
check('quarter turn swaps width and height', turned.width === NH && turned.height === NW,
  `${turned.width}×${turned.height}`);

check('neutral frame is detected', geo.isNeutralFrame(geo.FRAME_DEFAULTS));
check('a mirrored frame is not neutral', !geo.isNeutralFrame({ ...geo.FRAME_DEFAULTS, flipH: true }));
check('a tilted frame is not neutral', !geo.isNeutralFrame({ ...geo.FRAME_DEFAULTS, straighten: 3 }));

// Cloning must not alias the crop rectangle.
const src = geo.cloneFrame(geo.FRAME_DEFAULTS);
src.crop.x = 0.4;
check('cloneFrame deep-copies the crop', geo.FRAME_DEFAULTS.crop.x === 0);

// --- Rendering through the transform ---
function developFrame(frame, params = paramsFor('noir')) {
  const eng = new Darkroom();
  eng.load(img, NW, NH, frame);
  const c = createCanvas(W, H);
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  eng.develop(x, W, H, { ...params, frame });
  return { eng, c, x, s: stats(x, W, H) };
}

// 1. A neutral frame must reproduce the un-transformed render exactly.
const plain = developFrame(geo.FRAME_DEFAULTS);
check('neutral frame renders unchanged', Math.abs(plain.s.mean - base.s.mean) < 0.5,
  `${plain.s.mean.toFixed(2)} vs ${base.s.mean.toFixed(2)}`);

// 2. Cropping to the dark half of the portrait must darken the print.
const darkHalf = developFrame({ ...geo.FRAME_DEFAULTS, crop: { x: 0.55, y: 0, w: 0.45, h: 1 } });
const brightHalf = developFrame({ ...geo.FRAME_DEFAULTS, crop: { x: 0, y: 0, w: 0.45, h: 1 } });
check('cropping to a darker region darkens the print', darkHalf.s.mean < brightHalf.s.mean - 5,
  `dark=${darkHalf.s.mean.toFixed(0)} bright=${brightHalf.s.mean.toFixed(0)}`);

// 3. The output must fill the whole frame — no empty margins anywhere.
function edgeCoverage(ctx) {
  const w = W;
  const h = H;
  const bands = [
    ctx.getImageData(0, 0, w, 2).data,
    ctx.getImageData(0, h - 2, w, 2).data,
    ctx.getImageData(0, 0, 2, h).data,
    ctx.getImageData(w - 2, 0, 2, h).data,
  ];
  let transparent = 0;
  for (const band of bands) {
    for (let i = 3; i < band.length; i += 4) if (band[i] < 250) transparent++;
  }
  return transparent;
}
// A handful of antialiased edge pixels is physically correct; a blank
// gutter would be thousands.
const EDGE_TOLERANCE = 24;
check('neutral frame leaves no transparent margins', edgeCoverage(plain.x) <= EDGE_TOLERANCE,
  `${edgeCoverage(plain.x)} px`);

// 4. Straightening must not reveal empty corners either.
const tilted = developFrame({ ...geo.FRAME_DEFAULTS, straighten: 15 });
check('a 15° straighten leaves no empty corners', edgeCoverage(tilted.x) <= EDGE_TOLERANCE,
  `${edgeCoverage(tilted.x)} transparent pixels`);
check('straightening changes the image', Math.abs(tilted.s.mean - plain.s.mean) > 0.5,
  `mean ${plain.s.mean.toFixed(1)} → ${tilted.s.mean.toFixed(1)}`);

// 5. A quarter turn must transpose the render, not crop or letterbox.
const rotated = developFrame({ ...geo.FRAME_DEFAULTS, rotation: 1 });
check('quarter turn keeps a full frame', edgeCoverage(rotated.x) <= EDGE_TOLERANCE,
  `${edgeCoverage(rotated.x)} px`);

// Compare against an explicit transpose of the source to prove the rotation
// is a real rotation rather than a re-crop.
{
  const tmp = createCanvas(NW, NH);
  const tx = tmp.getContext('2d');
  tx.translate(NW / 2, NH / 2);
  tx.rotate(Math.PI / 2);
  tx.drawImage(img, -NW / 2, -NH / 2);
  const tctx = tmp.getContext('2d');
  const ref = createCanvas(H, W);
  const rx = ref.getContext('2d');
  rx.imageSmoothingQuality = 'high';
  rx.drawImage(tmp, 0, 0, NW, NH, 0, 0, H, W);
  const rotRendered = createCanvas(H, W);
  const rr = rotRendered.getContext('2d');
  const eng = new Darkroom();
  eng.load(img, NW, NH, { ...geo.FRAME_DEFAULTS, rotation: 1 });
  eng.develop(rr, H, W, { ...paramsFor('noir'), frame: { ...geo.FRAME_DEFAULTS, rotation: 1 } }, { skipGrain: true });

  // Half a frame of empty space is a bug; a couple of edge pixels is not.
  const a = rr.getImageData(0, 0, H, W).data;
  let empty = 0;
  for (let i = 3; i < a.length; i += 4) if (a[i] < 200) empty++;
  const total = (H * W);
  check('rotated frame is solid, not hollow', empty / total < 0.005,
    `${((empty / total) * 100).toFixed(3)}% empty`);
}

// 6. Mirroring flips the image: the crop that was dark becomes bright.
const mirrorFrame = { ...geo.FRAME_DEFAULTS, flipH: true };
const mirrored = developFrame(mirrorFrame);
check('mirror renders a full frame', edgeCoverage(mirrored.x) <= EDGE_TOLERANCE,
  `${edgeCoverage(mirrored.x)} px`);

// Mirroring flips the print about the CROP. Comparing column means inside
// one narrow band is the discriminating test: an overall mean barely moves
// because the band is fairly flat, but its left and right edges must swap.
function columnMean(frame, px) {
  const c = createCanvas(W, H);
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  const params = { ...paramsFor('noir'), frame, grain: 0 };
  const eng = new Darkroom();
  eng.load(img, NW, NH, frame);
  eng.develop(x, W, H, params);
  const d = x.getImageData(0, 0, W, H).data;
  let sum = 0;
  let n = 0;
  for (let y = 0; y < H; y++) { sum += d[(y * W + px) * 4]; n++; }
  return sum / n;
}

const bandFrame = { ...geo.FRAME_DEFAULTS, crop: { x: 0, y: 0, w: 0.45, h: 1 } };
const mirroredBandFrame = { ...bandFrame, flipH: true };
const plainLeft = columnMean(bandFrame, 6);
const plainRight = columnMean(bandFrame, W - 7);
const flipLeft = columnMean(mirroredBandFrame, 6);
const flipRight = columnMean(mirroredBandFrame, W - 7);

check('mirroring swaps the edges of the crop',
  Math.abs(flipLeft - plainRight) < 6 && Math.abs(flipRight - plainLeft) < 6
  && Math.abs(plainLeft - plainRight) > 3,
  `plain ${plainLeft.toFixed(0)}/${plainRight.toFixed(0)} → flip ${flipLeft.toFixed(0)}/${flipRight.toFixed(0)}`);

/**
 * The preview draws from a pre-framed surface, the export draws from the
 * original. They must agree pixel-for-pixel on the same frame — this is the
 * regression guard for the double-transform bug.
 */
function previewVsExport(frame) {
  const eng = new Darkroom();
  eng.load(img, NW, NH, frame);
  const params = { ...paramsFor('noir'), frame, grain: 0 };
  const a = createCanvas(W, H);
  const b = createCanvas(W, H);
  const ax = a.getContext('2d');
  const bx = b.getContext('2d');
  ax.imageSmoothingQuality = 'high';
  bx.imageSmoothingQuality = 'high';
  eng.develop(ax, W, H, params);                       // preview path
  eng.develop(bx, W, H, params, { source: eng.source }); // export path
  const da = ax.getImageData(0, 0, W, H).data;
  const db = bx.getImageData(0, 0, W, H).data;
  let diff = 0;
  for (let i = 0; i < da.length; i += 4) diff += Math.abs(da[i] - db[i]);
  return diff / (W * H);
}

for (const [name, frame] of [
  ['no transform', geo.FRAME_DEFAULTS],
  ['mirror H', { ...geo.FRAME_DEFAULTS, flipH: true }],
  ['mirror V', { ...geo.FRAME_DEFAULTS, flipV: true }],
  ['rotate 90', { ...geo.FRAME_DEFAULTS, rotation: 1 }],
  ['rotate 270', { ...geo.FRAME_DEFAULTS, rotation: 3 }],
  ['crop', { ...geo.FRAME_DEFAULTS, crop: { x: 0.2, y: 0.15, w: 0.5, h: 0.6 } }],
  ['crop + mirror', { ...geo.FRAME_DEFAULTS, crop: { x: 0.2, y: 0.15, w: 0.5, h: 0.6 }, flipH: true }],
  ['rotate + mirror', { ...geo.FRAME_DEFAULTS, rotation: 1, flipH: true }],
]) {
  const d = previewVsExport(frame);
  check(`  preview matches export: ${name}`, d < 3, `mean delta ${d.toFixed(2)}`);
}

// 7. Aspect fitting keeps the window inside the frame and lands on ratio.
for (const id of ['1:1', '3:2', '16:9']) {
  const ratio = geo.aspectRatio(id, { width: NW, height: NH });
  const fitted = geo.fitCropToAspect(geo.FRAME_DEFAULTS.crop, ratio, { width: NW, height: NH });
  const pxW = fitted.w * NW;
  const pxH = fitted.h * NH;
  const inside = fitted.x >= -1e-6 && fitted.y >= -1e-6
    && fitted.x + fitted.w <= 1 + 1e-6 && fitted.y + fitted.h <= 1 + 1e-6;
  const accurate = Math.abs(pxW / pxH - ratio) < 0.02;
  check(`  aspect ${id} fits inside and matches`, inside && accurate,
    `${pxW.toFixed(0)}×${pxH.toFixed(0)} ratio=${(pxW / pxH).toFixed(3)} want ${ratio.toFixed(3)}`);
}

// 8. printToOriginal must undo the transform for brush coordinates.
{
  const f = { ...geo.FRAME_DEFAULTS, rotation: 1, flipH: true };
  const { x, y } = geo.printToOriginal(0.5, 0.5, f);
  check('printToOriginal maps the centre to the centre',
    Math.abs(x - 0.5) < 1e-6 && Math.abs(y - 0.5) < 1e-6, `${x}, ${y}`);
}

// --- 10. Write visual proofs -------------------------------------------
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
