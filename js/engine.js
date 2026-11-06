/**
 * NOIR Photo Studio — development engine
 * ------------------------------------------------------------
 * A small, dependency-free monochrome pipeline. Everything works on
 * canvas pixels, in this order (matching a real darkroom's logic):
 *
 *   1. base draw            — the negative, scaled to the working surface
 *   2. local contrast       — clarity (unsharp mask on structure)
 *   3. halation             — glow / bloom from the dense areas
 *   4. tonal pass (1 loop)  — channel mix → exposure → curve → grain →
 *                             vignette → toning
 *
 * The tonal pass is a single `getImageData` round-trip so the cost stays
 * proportional to pixel count, not to the number of controls.
 */

import { drawFrame, frameSize, FRAME_DEFAULTS } from './geometry.js';

const PREVIEW_EDGE = 1600;   // interactive preview resolution (long edge)
const GRAIN_FIELD = 512;     // noise field size for film grain
const LUT_CACHE_LIMIT = 64;

/* ------------------------------------------------------------------ */
/* Capability detection                                                */
/* ------------------------------------------------------------------ */

const probe = document.createElement('canvas').getContext('2d');
export const SUPPORTS_FILTER = typeof probe.filter === 'string';

/* ------------------------------------------------------------------ */
/* Toning — duotone channel multipliers                                */
/* ------------------------------------------------------------------ */

const TONE_MULT = {
  neutral: [1, 1, 1],
  selenium: [0.985, 1.0, 1.055],
  warm: [1.065, 1.0, 0.915],
  platinum: [1.035, 1.0, 0.945],
  sepia: [1.105, 0.985, 0.815],
  cyan: [0.745, 0.965, 1.185],
  cool: [0.95, 1.0, 1.075],
};

/* ------------------------------------------------------------------ */
/* Film grain field                                                    */
/* ------------------------------------------------------------------ */

let grainField = null;

/** Value-noise field: a few octaves of smoothed lattice noise, [-1, 1]. */
function buildGrainField() {
  const N = GRAIN_FIELD;
  const field = new Float32Array(N * N);
  // Fine speckle dominates; the coarse octaves only add the faint clumping
  // that makes silver grain look organic rather than like digital noise.
  const octaves = [
    { size: 512, weight: 0.74 },
    { size: 256, weight: 0.18 },
    { size: 128, weight: 0.08 },
  ];

  for (const { size, weight } of octaves) {
    const lattice = new Float32Array(size * size);
    for (let i = 0; i < lattice.length; i++) lattice[i] = Math.random() * 2 - 1;

    const scale = size / N;
    for (let y = 0; y < N; y++) {
      const fy = y * scale;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const y0i = (y0 % size) * size;
      const y1i = ((y0 + 1) % size) * size;

      for (let x = 0; x < N; x++) {
        const fx = x * scale;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const x0i = x0 % size;
        const x1i = (x0 + 1) % size;

        const a = lattice[y0i + x0i];
        const b = lattice[y0i + x1i];
        const c = lattice[y1i + x0i];
        const d = lattice[y1i + x1i];

        const top = a + (b - a) * sx;
        const bot = c + (d - c) * sx;
        field[y * N + x] += (top + (bot - top) * sy) * weight;
      }
    }
  }

  // Normalise into a predictable range and slightly sharpen the distribution
  let peak = 0;
  for (let i = 0; i < field.length; i++) peak = Math.max(peak, Math.abs(field[i]));
  if (peak > 0) {
    const norm = 1 / peak;
    for (let i = 0; i < field.length; i++) field[i] *= norm;
  }

  return field;
}

function getGrainField() {
  if (!grainField) grainField = buildGrainField();
  return grainField;
}

/* Bilinear sample of the grain field, wrapping at the edges. */
function sampleGrain(field, x, y) {
  const N = GRAIN_FIELD;
  const N1 = N - 1;

  const fy = y;
  const y0 = fy | 0;
  const ty = fy - y0;
  const y0i = (y0 & N1) * N;
  const y1i = ((y0 + 1) & N1) * N;

  const fx = x;
  const x0 = fx | 0;
  const tx = fx - x0;
  const x0i = x0 & N1;
  const x1i = (x0 + 1) & N1;

  const a = field[y0i + x0i];
  const b = field[y0i + x1i];
  const c = field[y1i + x0i];
  const d = field[y1i + x1i];

  const top = a + (b - a) * tx;
  const bot = c + (d - c) * tx;
  return top + (bot - top) * ty;
}

/* ------------------------------------------------------------------ */
/* Tone curve                                                          */
/* ------------------------------------------------------------------ */

export function lutKey(p) {
  return [
    p.contrast, p.highlights, p.shadows, p.whites, p.blacks, p.fade,
    p.curveOn ? curveKey(p.curvePoints) : 'off',
  ].join(':');
}

/** Stable signature for a point list, used for LUT cache lookups. */
function curveKey(points) {
  if (!points || !points.length) return 'id';
  return points.map(([x, y]) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`).join(';');
}

/** Is this curve an exact identity (or effectively absent)? */
export function isIdentityCurve(points) {
  if (!points || points.length < 2) return true;
  for (const [x, y] of points) {
    if (Math.abs(x - y) > 0.002) return false;
  }
  return true;
}

/**
 * Monotone cubic (Fritsch–Carlson) interpolation through the control points.
 * This is the standard choice for tone curves: unlike a natural cubic
 * spline it cannot overshoot between points, so dragging a handle never
 * introduces a ring or a tonal inversion next to it.
 *
 * @returns {(x: number) => number} evaluator over 0…1
 */
export function curveInterpolator(points) {
  const pts = (points || []).slice().sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return (x) => x;

  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);

  // Secant slopes between neighbouring points.
  const dx = new Array(n - 1);
  const dy = new Array(n - 1);
  const slope = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = xs[i + 1] - xs[i] || 1e-6;
    dy[i] = ys[i + 1] - ys[i];
    slope[i] = dy[i] / dx[i];
  }

  // Tangents, then the Fritsch–Carlson monotonicity clamp.
  const m = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }

  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];

    // Binary search for the segment.
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }

    const h = dx[lo];
    const t = (x - xs[lo]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    // Hermite basis
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * ys[lo] + h10 * h * m[lo] + h01 * ys[lo + 1] + h11 * h * m[lo + 1];
  };
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Build a 256-entry transfer function from the tonal controls.
 * Deliberately monotonic: each stage is a monotone map of [0,1] → [0,1]
 * so the curve can never fold back on itself and invert detail.
 */
export function buildLUT(p) {
  const lut = new Uint8Array(256);

  const contrast = 1 + (p.contrast / 100) * 0.85;   // 0.15 … 1.85
  const hi = (p.highlights / 100) * 0.22;
  const sh = (p.shadows / 100) * 0.22;
  const wh = (p.whites / 100) * 0.14;
  const bl = (p.blacks / 100) * 0.14;
  const fade = Math.max(0, p.fade) / 100;

  // The manual curve runs after the tonal zones, before the matte lift:
  // it is the last word on the shape of the print.
  const useCurve = !!p.curveOn && p.curvePoints && !isIdentityCurve(p.curvePoints);
  const curve = useCurve ? curveInterpolator(p.curvePoints) : null;

  for (let i = 0; i < 256; i++) {
    let x = i / 255;

    // Contrast about the mid point, with soft shoulders so highlights and
    // shadows roll off instead of clipping into flat white or black.
    if (contrast !== 1) {
      const signed = x - 0.5;
      const shaped = Math.sign(signed) * Math.pow(Math.abs(signed) * 2, 1 / contrast) * 0.5;
      x = 0.5 + shaped;
    }

    // Regional tonal zones. Weights are smooth and complementary so a
    // combined move in two directions stays monotonic.
    const wHi = smoothstep(0.35, 1.0, x);
    const wSh = smoothstep(0.65, 0.0, x);
    const wWh = smoothstep(0.62, 1.0, x) * (x * x);
    const wBl = smoothstep(0.38, 0.0, x) * ((1 - x) * (1 - x));

    x += hi * wHi + sh * wSh + wh * wWh + bl * wBl;

    if (curve) {
      x = curve(Math.min(1, Math.max(0, x)));
    }

    // Matte / fade: lift the blacks and pull the whites back toward paper.
    if (fade > 0) {
      x = x * (1 - fade * 0.42) + fade * 0.13;
    }

    lut[i] = x <= 0 ? 0 : x >= 1 ? 255 : (x * 255 + 0.5) | 0;
  }

  return lut;
}

const lutCache = new Map();

function cachedLUT(p) {
  const key = lutKey(p);
  let lut = lutCache.get(key);
  if (lut) return lut;
  lut = buildLUT(p);
  if (lutCache.size >= LUT_CACHE_LIMIT) lutCache.delete(lutCache.keys().next().value);
  lutCache.set(key, lut);
  return lut;
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export class Darkroom {
  constructor() {
    this.source = null;        // full-resolution canvas (the negative)
    this.width = 0;
    this.height = 0;
    this.surface = null;       // downscaled working canvas for preview
    this.surfaceW = 0;
    this.surfaceH = 0;

    // Local-adjustment mask: an 8-bit coverage map the size of the preview
    // surface. One overlay (dodge/burn) is stored as a single channel.
    this.mask = null;
    this.maskCtx = null;
    this.frame = FRAME_DEFAULTS;
    this.negative = { width: 0, height: 0 };

    this.scratch = document.createElement('canvas');   // blur target
    this.scratchCtx = this.scratch.getContext('2d', { willReadFrequently: true });
    this.histCanvas = document.createElement('canvas');
    this.histCanvas.width = 256;
    this.histCanvas.height = 128;
    this.histCtx = this.histCanvas.getContext('2d', { willReadFrequently: true });
  }

  get loaded() {
    return this.source !== null;
  }

  /**
   * Recompute the preview surface for a given frame. Called on load and
   * whenever the crop changes, so the mask and the grain scale always
   * match what is actually on screen.
   */
  refreshSurface(frame) {
    if (!this.source) return;
    const size = frameSize(frame, this.negative);
    const longEdge = Math.max(size.width, size.height);
    const s = Math.min(1, PREVIEW_EDGE / longEdge);

    this.surfaceW = Math.max(1, Math.round(size.width * s));
    this.surfaceH = Math.max(1, Math.round(size.height * s));

    if (!this.surface) this.surface = document.createElement('canvas');
    this.surface.width = this.surfaceW;
    this.surface.height = this.surfaceH;

    const sctx = this.surface.getContext('2d');
    sctx.resetTransform?.();
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    sctx.globalAlpha = 1;
    sctx.clearRect(0, 0, this.surfaceW, this.surfaceH);
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    drawFrame(sctx, this.surfaceW, this.surfaceH, this.source, frame || FRAME_DEFAULTS);

    this.frame = frame;
    this.ensureMask();
  }

  /** Adopt a decoded image. Returns the intrinsic dimensions. */
  load(source, width, height, frame) {
    this.source = source;
    this.width = width;
    this.height = height;
    // Intrinsic size, kept separately: `width`/`height` describe the
    // negative, while the frame describes the print taken from it.
    this.negative = { width, height };

    this.refreshSurface(frame || FRAME_DEFAULTS);
    return { width, height };
  }

  /** Create (or clear) the local-adjustment mask. */
  ensureMask(clear = true) {
    if (!this.mask) {
      this.mask = document.createElement('canvas');
      this.maskCtx = this.mask.getContext('2d', { willReadFrequently: true });
    }
    if (this.mask.width !== this.surfaceW || this.mask.height !== this.surfaceH) {
      this.mask.width = this.surfaceW;
      this.mask.height = this.surfaceH;
      clear = true;
    }
    if (clear) {
      this.maskCtx.setTransform(1, 0, 0, 1, 0, 0);
      this.maskCtx.globalCompositeOperation = 'source-over';
      this.maskCtx.fillStyle = '#000';
      this.maskCtx.fillRect(0, 0, this.surfaceW, this.surfaceH);
    }
    return this.mask;
  }

  /**
   * Paint one dab of the mask. Coordinates are normalised (0…1) so the
   * same stroke lands in the same place at any zoom level.
   * @param {{x:number,y:number,radius:number,strength:number,erase?:boolean}} dab
   */
  paintDab({ x, y, radius, strength = 1, erase = false }) {
    const ctx = this.maskCtx;
    if (!ctx) return null;

    const w = this.mask.width;
    const h = this.mask.height;
    const cx = x * w;
    const cy = y * h;
    const r = Math.max(0.5, radius * Math.min(w, h));

    ctx.globalCompositeOperation = erase ? 'source-over' : 'lighter';

    if (erase) {
      // Painterly erase: knock coverage back down with a soft dab.
      ctx.globalCompositeOperation = 'source-over';
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, `rgba(0,0,0,${Math.min(1, strength)})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
    } else {
      // Additive, so overlapping dabs build coverage toward full white.
      const a = Math.min(1, strength * 0.42);
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, `rgba(255,255,255,${a})`);
      grad.addColorStop(0.62, `rgba(255,255,255,${a * 0.55})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
    }

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    return true;
  }

  /** How much of the frame has been painted, 0…1 (drives the "modified" dot). */
  maskCoverage() {
    if (!this.maskCtx) return 0;
    const { width: w, height: h } = this.mask;
    const step = 4;
    let data;
    try {
      data = this.maskCtx.getImageData(0, 0, w, h).data;
    } catch {
      return 0;
    }
    let hit = 0;
    let total = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        if (data[i] > 24) hit++;
        total++;
      }
    }
    return total ? hit / total : 0;
  }

  /** Does the negative carry transparency? (drives the checkerboard) */
  detectAlpha() {
    const probe = document.createElement('canvas');
    probe.width = 64;
    probe.height = 64;
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    pctx.drawImage(this.source, 0, 0, 64, 64);
    try {
      const data = pctx.getImageData(0, 0, 64, 64).data;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 250) return true;
      }
    } catch { /* tainted — assume opaque */ }
    return false;
  }

  /**
   * Develop into a destination context.
   * @param {CanvasRenderingContext2D} dctx
   * @param {number} w destination width
   * @param {number} h destination height
   * @param {object} p parameters
   * @param {{ source?: HTMLCanvasElement, skipGrain?: boolean }} [opts]
   */
  develop(dctx, w, h, p, opts = {}) {
    // Two sources, two very different jobs:
    //
    //   opts.source = the ORIGINAL negative. Geometry has not been applied
    //                 to it yet, so drawFrame() must run. Used by export
    //                 and batch, where the output is full resolution.
    //
    //   no source   = this.surface, which refreshSurface() already drew
    //                 through the frame. It is a finished crop, so it must
    //                 be blitted 1:1. Running drawFrame() on it too was
    //                 applying crop/rotate/mirror twice, which stretched
    //                 the preview and left the mirror looking dead.
    const usesOriginal = !!opts.source;
    const source = opts.source || this.surface;
    if (!source) return;

    dctx.save();
    dctx.globalCompositeOperation = 'source-over';
    dctx.globalAlpha = 1;
    dctx.clearRect(0, 0, w, h);
    if (dctx.setTransform) dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.imageSmoothingEnabled = true;
    dctx.imageSmoothingQuality = 'high';

    if (usesOriginal) {
      // Geometry first: crop, quarter turns, mirrors and straightening all
      // land in one transform so the rest of the pipeline is unaware of it.
      drawFrame(dctx, w, h, source, p.frame || FRAME_DEFAULTS);
    } else {
      dctx.drawImage(source, 0, 0, w, h);
    }

    const minEdge = Math.min(w, h);

    if (SUPPORTS_FILTER) {
      if (p.clarity > 0) this._clarity(dctx, w, h, minEdge, p.clarity);
      if (p.glow > 0) this._glow(dctx, w, h, minEdge, p.glow);
    }

    this._tonalPass(dctx, w, h, p, opts);
    dctx.restore();
  }

  /** Local midtone contrast: overlay the blurred luminance back on top. */
  _clarity(dctx, w, h, minEdge, amount) {
    const radius = Math.max(1.2, minEdge * 0.0075);
    this._blurInto(dctx.canvas, w, h, radius, 1.0, 1.0);

    dctx.save();
    dctx.globalCompositeOperation = 'overlay';
    dctx.globalAlpha = Math.min(0.85, (amount / 100) * 1.05);
    dctx.drawImage(this.scratch, 0, 0, w, h);
    dctx.restore();
  }

  /** Halation: bloom bleeding out of the densest areas of the negative. */
  _glow(dctx, w, h, minEdge, amount) {
    const radius = Math.max(2, minEdge * 0.022);
    this._blurInto(dctx.canvas, w, h, radius, 1.35, 1.7);

    dctx.save();
    dctx.globalCompositeOperation = 'screen';
    dctx.globalAlpha = (amount / 100) * 0.62;
    dctx.drawImage(this.scratch, 0, 0, w, h);
    dctx.restore();
  }

  /** Render the destination's current composite into the scratch buffer, blurred. */
  _blurInto(from, w, h, radius, brightness, contrast) {
    const s = this.scratch;
    if (s.width !== w || s.height !== h) {
      s.width = w;
      s.height = h;
    }
    const sctx = this.scratchCtx;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    sctx.globalAlpha = 1;
    sctx.filter = 'none';
    sctx.clearRect(0, 0, w, h);

    sctx.filter = `blur(${radius.toFixed(2)}px) brightness(${brightness}) contrast(${contrast})`;
    sctx.drawImage(from, 0, 0, w, h);
    sctx.filter = 'none';
  }

  /**
   * Read the mask into a Float32Array of coverage (0…1) at `w`×`h`.
   * Returns null when there is nothing to apply.
   */
  _readMask(w, h) {
    if (!this.maskCtx || !this.mask) return null;
    let data;
    try {
      data = this.maskCtx.getImageData(0, 0, this.mask.width, this.mask.height).data;
    } catch {
      return null;
    }

    const mw = this.mask.width;
    const mh = this.mask.height;
    const out = new Float32Array(w * h);
    let any = false;

    for (let y = 0; y < h; y++) {
      const sy = Math.min(mh - 1, (y * mh / h) | 0);
      const row = sy * mw;
      const drow = y * w;
      for (let x = 0; x < w; x++) {
        const sx = Math.min(mw - 1, (x * mw / w) | 0);
        const v = data[(row + sx) * 4] / 255;
        if (v > 0.002) any = true;
        out[drow + x] = v;
      }
    }

    return any ? out : null;
  }

  /** One pixel pass: mix → exposure → curve → grain → vignette → mask → tone. */
  _tonalPass(dctx, w, h, p, opts) {
    const lut = cachedLUT(p);

    let img;
    try {
      img = dctx.getImageData(0, 0, w, h);
    } catch {
      return; // tainted canvas — leave the base draw in place
    }

    const data = img.data;
    const len = data.length;

    // Channel mix (panchromatic response), normalised so the neutral
    // setting reproduces the standard luminance weights.
    const mr = p.mixR;
    const mg = p.mixG;
    const mb = p.mixB;
    const mixSum = mr + mg + mb || 1;
    const wr = (mr / mixSum) * 3;
    const wg = (mg / mixSum) * 3;
    const wb = (mb / mixSum) * 3;

    const exposure = Math.pow(2, p.exposure);

    // Toning
    const tint = TONE_MULT[p.tone] || TONE_MULT.neutral;
    const ts = Math.max(0, Math.min(100, p.toneStrength)) / 100;
    const tr = 1 + (tint[0] - 1) * ts;
    const tg = 1 + (tint[1] - 1) * ts;
    const tb = 1 + (tint[2] - 1) * ts;

    // Grain
    const grain = opts.skipGrain ? 0 : Math.max(0, Math.min(100, p.grain)) / 100;
    const grainAmp = grain * 0.17;
    // Grain must keep the same relative size on screen and in the exported
    // file, so scale the sampling rate by how much this surface is upsampled.
    const relScale = this.surfaceW ? Math.max(0.05, w / this.surfaceW) : 1;
    const grainScale = 1 / Math.max(0.6, p.grainSize) / relScale;
    const field = grain > 0 ? getGrainField() : null;

    // Vignette
    const vig = p.vignette / 100;
    const cx = w / 2;
    const cy = h / 2;
    const rx = w / 2;
    const ry = h / 2;
    const invRX = rx > 0 ? 1 / rx : 0;
    const invRY = ry > 0 ? 1 / ry : 0;

    // Local adjustment through the mask. Amount of 0 disables the pass
    // entirely so an unpainted frame costs nothing.
    const maskAmt = Math.max(-100, Math.min(100, p.maskAmount || 0)) / 100;
    const mask = Math.abs(maskAmt) > 0.004 ? this._readMask(w, h) : null;

    const doVig = Math.abs(vig) > 0.001;
    const doTone = ts > 0.001;
    const doMix = Math.abs(wr - 1) > 0.002 || Math.abs(wg - 1) > 0.002 || Math.abs(wb - 1) > 0.002;

    let idx = 0;
    for (let y = 0; y < h; y++) {
      const gy = y * grainScale;
      const dy = (y + 0.5 - cy) * invRY;

      for (let x = 0; x < w; x++) {
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        // 1 — grayscale with the channel mix
        let v;
        if (doMix) {
          v = r * wr * 0.299 + g * wg * 0.587 + b * wb * 0.114;
        } else {
          v = r * 0.299 + g * 0.587 + b * 0.114;
        }

        // 2 — exposure
        if (exposure !== 1) v *= exposure;

        // 3 — tone curve
        let ii = v <= 0 ? 0 : v >= 255 ? 255 : v | 0;
        let out = lut[ii];

        // 4 — film grain, strongest through the mid tones
        if (field !== null) {
          const t = out * (1 / 255);
          // Silver halide grain lives in the mid tones; shadows stay quieter.
          const midWeight = 0.30 + 2.2 * t * (1 - t);
          const n = sampleGrain(field, x * grainScale, gy);
          out += n * grainAmp * midWeight * 255;
        }

        // 5 — vignette
        if (doVig) {
          const dx = (x + 0.5 - cx) * invRX;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const fall = smoothstep(0.42, 1.08, dist);
          if (fall > 0) {
            if (vig < 0) out *= 1 - fall * -vig * 0.92;
            else out += (255 - out) * fall * vig * 0.55;
          }
        }

        // 6 — local dodge / burn through the painted mask
        if (mask !== null) {
          const cover = mask[idx >> 2];
          if (cover > 0) {
            const k = cover * maskAmt;
            if (k > 0) out += (255 - out) * k * 0.92;   // dodge: lift
            else out *= 1 + k * 0.92;                    // burn: deepen
          }
        }

        // 7 — clamp and tone
        if (out < 0) out = 0;
        else if (out > 255) out = 255;

        if (doTone) {
          data[idx] = out * tr > 255 ? 255 : out * tr;
          data[idx + 1] = out * tg > 255 ? 255 : out * tg;
          data[idx + 2] = out * tb > 255 ? 255 : out * tb;
        } else {
          data[idx] = out;
          data[idx + 1] = out;
          data[idx + 2] = out;
        }

        idx += 4;
      }
    }

    dctx.putImageData(img, 0, 0);
  }

  /** Histogram of the developed preview (luminance, 256 bins). */
  histogram(params) {
    const W = this.histCanvas.width;
    const H = this.histCanvas.height;
    const hctx = this.histCtx;
    hctx.clearRect(0, 0, W, H);
    hctx.drawImage(this.surface, 0, 0, W, H);

    let data;
    try {
      data = hctx.getImageData(0, 0, W, H).data;
    } catch {
      return null;
    }

    // Develop the small copy through the tonal pipeline so the histogram
    // reflects the look, not the original file.
    const lut = cachedLUT(params);
    const exposure = Math.pow(2, params.exposure);

    const bins = new Uint32Array(256);
    let max = 0;

    for (let i = 0; i < data.length; i += 4) {
      let v = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      v *= exposure;
      const ii = v <= 0 ? 0 : v >= 255 ? 255 : v | 0;
      const o = lut[ii];
      bins[o]++;
      if (bins[o] > max) max = bins[o];
    }

    return { bins, max };
  }
}
