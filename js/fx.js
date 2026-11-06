/**
 * NOIR Photo Studio — graphic effects
 * ------------------------------------------------------------
 * The lab effects that stop being photography and start being print:
 * thresholds, halftone screens, dithering, photocopy grime, risograph
 * misregistration and the rest of the xerox/zine vocabulary.
 *
 * Two things make these behave predictably.
 *
 * NORMALISED TONE
 *   Every effect reads from a normalised tone field rather than the raw
 *   buffer. The tone is stretched between its own 2nd and 98th percentile,
 *   so an effect quantises the *shape* of the picture instead of its
 *   exposure. Without this a threshold on a dark frame returns a black
 *   rectangle, and the halftone screen returns a flat checkerboard with no
 *   image inside it — which is precisely what a naive implementation does.
 *
 * RUNS AFTER TONE
 *   `fx` is applied last in the pass, so the curve, exposure and tone still
 *   shape the picture underneath. The effect is the last word on how that
 *   picture becomes ink.
 */

/** The effect menu. `hint` becomes the button tooltip. */
export const FX = [
  { id: 'none', name: 'None', sub: 'Straight print', hint: 'Photograph, no lab effect' },
  { id: 'threshold', name: 'Threshold', sub: 'Hard two-tone', hint: 'Crush to pure black and paper white' },
  { id: 'thresholdSoft', name: 'Soften', sub: 'Textured threshold', hint: 'Threshold with torn, uneven edges' },
  { id: 'halftone', name: 'Halftone', sub: 'Newsprint dots', hint: 'Rotated dot screen at 45°' },
  { id: 'dither', name: 'Dither', sub: 'Ordered 4×4', hint: 'Bayer matrix — classic 1-bit dithered look' },
  { id: 'ditherFine', name: 'Fine dither', sub: 'Ordered 8×8', hint: 'Finer Bayer screen, more grey' },
  { id: 'errorDiffuse', name: 'Diffusion', sub: 'Error diffusion', hint: 'Floyd–Steinberg, the photocopier staple' },
  { id: 'xerox', name: 'Xerox', sub: 'Copier grime', hint: 'Threshold plus dust, scratches and toner falloff' },
  { id: 'riso', name: 'Riso', sub: 'Misregistered', hint: 'Two offset plates, screen-print register' },
  { id: 'scanline', name: 'Scanline', sub: 'Line screen', hint: 'Horizontal line screen, fax and VHS' },
  { id: 'crosshatch', name: 'Crosshatch', sub: 'Woven lines', hint: 'Crossed line screen over a threshold' },
  { id: 'filmBurn', name: 'Burn', sub: 'Blown highlights', hint: 'Hot centre, crushed edges' },
  { id: 'distress', name: 'Distress', sub: 'Degraded print', hint: 'Scratches, dropouts and ink loss' },
];

export const FX_BY_ID = Object.fromEntries(FX.map((f) => [f.id, f]));

const HALFTONE_ANGLE = Math.PI / 4;

/** Ordered 4×4 Bayer matrix. */
const BAYER4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

/** Ordered 8×8 Bayer matrix — the finest ordered screen worth the arithmetic. */
const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

/* ------------------------------------------------------------------ */
/* Noise                                                               */
/* ------------------------------------------------------------------ */

/** Integer hash → 0…1. Deterministic, so a re-render is bit-identical. */
function hash2(x, y, seed) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1274126177;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

/** Smooth value noise on a coarse grid, so grime clumps instead of speckling. */
function valueNoise(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const top = a + (b - a) * sx;
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  const bottom = c + (d - c) * sx;
  return top + (bottom - top) * sy;
}

/* ------------------------------------------------------------------ */
/* Normalised tone                                                     */
/* ------------------------------------------------------------------ */

/**
 * Read the buffer into a tone field in 0…1.
 *
 * Two corrections, and both are load-bearing:
 *
 * 1. STRETCH between the 2nd and 98th percentile, so isolated specular
 *    highlights and stray blacks cannot decide the range.
 *
 * 2. MEDIAN MATCH to 0.5 with a gamma. A low-key photograph — a moody
 *    portrait, a night shot, most of what people put through these effects —
 *    sits at a median of 25/255. A plain stretch maps that to 0.09, which a
 *    threshold turns into a black rectangle and a dot screen turns into a
 *    uniform wall of dots with no picture inside it. Re-mapping the median to
 *    the middle restores the mid tones the screen needs to describe anything
 *    at all. This is auto-levels with a midtone correction, and without it
 *    every effect here only works on photographs that are already bright.
 */
function buildTone(data, w, h) {
  const n = w * h;

  // Coarse histogram on a sample of the image.
  const bins = new Uint32Array(64);
  let sampled = 0;
  const stride = n > 200000 ? 3 : 1;
  for (let p = 0; p < n; p += stride) {
    bins[Math.min(63, data[p * 4] >> 2)]++;
    sampled++;
  }

  const at = (q) => {
    const target = sampled * q;
    let acc = 0;
    for (let b = 0; b < 64; b++) {
      acc += bins[b];
      if (acc >= target) return b * 4 + 2;
    }
    return 255;
  };

  let lo = at(0.02);
  let hi = at(0.98);
  if (hi <= lo + 8) { lo = 0; hi = 255; }

  const median = at(0.5);
  const mid = Math.min(1, Math.max(0, (median - lo) / (hi - lo)));

  // The exponent that would put the median at 0.5: solve 0.5 = mid^p.
  //
  // Direction matters and is easy to invert. For a dark photograph (mid well
  // below 0.5) the exponent is BELOW one — 0.103 needs p = 0.31 — because
  // raising a small number to a small power makes it larger. Using the
  // reciprocal here instead, as an earlier version of this file did, pushes the
  // median down to 0.03 and makes every effect render a black rectangle.
  //
  // Damping keeps the photograph's own key: full correction drives the median
  // to exactly 0.5, which flattens the picture into a uniform dot field.
  let p = 1;
  if (mid > 0.02 && mid < 0.98) {
    p = Math.log(0.5) / Math.log(mid);
    p = Math.min(3.2, Math.max(0.3, p));
    p = 1 + (p - 1) * 0.85;
  }

  const span = 1 / (hi - lo);
  const tone = new Float32Array(n);

  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let t = (data[j] - lo) * span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    tone[i] = p === 1 ? t : Math.pow(t, p);
  }

  return tone;
}

/** Write a tone field back as greyscale, blended against the original. */
function writeTone(data, w, h, tone, amount) {
  const n = w * h;
  for (let p = 0, j = 0; p < n; p++, j += 4) {
    const out = tone[p] * 255;
    data[j] = data[j] * (1 - amount) + out * amount;
    data[j + 1] = data[j + 1] * (1 - amount) + out * amount;
    data[j + 2] = data[j + 2] * (1 - amount) + out * amount;
  }
}

/**
 * Gentle contrast curve about the midpoint. `strength` is the exponent
 * difference, not a gain, so 0 leaves the tone untouched.
 */
function sCurve(tone, n, strength) {
  if (strength <= 0) return;
  // Blend toward smoothstep, which fixes 0 and 1 while steepening the middle.
  // An exponent curve would be easy to reach for, but getting its endpoints
  // wrong lifts pure black off the floor and the whole frame goes white.
  const s = Math.min(1, strength);
  for (let i = 0; i < n; i++) {
    const t = tone[i];
    const curved = t * t * (3 - 2 * t);
    tone[i] = t + (curved - t) * s;
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Run the effect over an RGBA buffer, in place.
 *
 * @param {object} _ctx reserved
 * @param {Uint8ClampedArray} data RGBA bytes
 * @param {number} w
 * @param {number} h
 * @param {object} p params: fx, fxAmount, fxScale, fxLevel
 */
export function apply(_ctx, data, w, h, p) {
  const id = p.fx;
  if (!id || id === 'none') return;

  const amount = Math.max(0, Math.min(100, p.fxAmount === undefined ? 100 : p.fxAmount)) / 100;
  if (amount <= 0.002) return;

  const scale = Math.max(0.5, (p.fxScale || 100) / 100);
  // Level is the cut point: 0.5 at the default, so the shape of the picture
  // decides which side of the line each pixel falls on.
  const level = 0.16 + (Math.max(0, Math.min(100, p.fxLevel === undefined ? 50 : p.fxLevel)) / 100) * 0.68;

  const tone = buildTone(data, w, h);

  // A screen turns tone into area, so flat tone becomes a flat field. A gentle
  // S-curve before the screen keeps the picture's own contrasts legible as
  // differences in dot size. Thresholds get it too: it is what puts the edge
  // between black and white where the picture's shape actually is.
  const contrast = id === 'filmBurn' || id === 'distress' ? 0.25 : 0.55;
  sCurve(tone, tone.length, contrast);

  switch (id) {
    case 'threshold': threshold(tone, w, h, level, 0); break;
    case 'thresholdSoft': threshold(tone, w, h, level, 1); break;
    case 'xerox': xerox(tone, w, h, level); break;
    case 'halftone': halftone(tone, w, h, scale); break;
    case 'dither': dither(tone, w, h, scale, BAYER4, 4); break;
    case 'ditherFine': dither(tone, w, h, scale, BAYER8, 8); break;
    case 'errorDiffuse': errorDiffuse(tone, w, h); break;
    case 'scanline': scanline(tone, w, h, scale); break;
    case 'crosshatch': crosshatch(tone, w, h, scale); break;
    case 'riso': riso(tone, w, h, level, scale); break;
    case 'filmBurn': filmBurn(tone, w, h); break;
    case 'distress': distress(tone, w, h, scale); break;
    default: return;
  }

  writeTone(data, w, h, tone, amount);
}

/* ------------------------------------------------------------------ */
/* Two-tone                                                            */
/* ------------------------------------------------------------------ */

/**
 * Collapse to two levels. `soft` breaks the edge with noise, which gives the
 * torn, reprographed contour of a bad photocopy instead of a clean digital
 * cut — the difference between "Photoshop threshold" and "came off a copier".
 */
function threshold(tone, w, h, level, soft) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let edge = 0;
      if (soft) {
        edge = (valueNoise(x / 7, y / 7, 11) - 0.5) * 0.42
             + (hash2(x, y, 7) - 0.5) * 0.26;
      }
      tone[p] = tone[p] + edge >= level ? 1 : 0;
    }
  }
}

/** Photocopier: threshold plus the grime a dirty platen leaves behind. */
function xerox(tone, w, h, level) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      // Toner density wanders across the page.
      const blotch = (valueNoise(x / 46, y / 46, 3) - 0.5) * 0.22;
      // Fine tooth on every edge.
      const tooth = (hash2(x, y, 19) - 0.5) * 0.16;
      // Hard toner specks scattered over the white.
      const speck = hash2(x >> 1, y >> 1, 41) > 0.996 ? 0.5 : 0;
      // Dropouts where the drum did not take.
      const drop = hash2(x >> 2, y >> 2, 53) > 0.995 ? 0.45 : 0;

      tone[p] = tone[p] + blotch + tooth + speck - drop >= level ? 1 : 0;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

/**
 * Rotated dot screen at 45°, the angle a real halftone plate uses because it
 * is the least visible to the eye. The tone becomes the AREA of the dot: a
 * dark area is a big dot, a light area a small one.
 */
function halftone(tone, w, h, scale) {
  // Pitch is proportional to the print, not a fixed pixel count. A real
  // halftone plate has a fixed line screen — so many cells per inch — which
  // means the same number of cells across a given print at any resolution.
  // A constant pixel pitch instead makes the screen finer as the file gets
  // bigger, which is why a 560px render read as noise while the 1400px export
  // looked right.
  const pitch = Math.max(4, (Math.min(w, h) / 58) * scale);
  const inv = 1 / pitch;
  const cos = Math.cos(HALFTONE_ANGLE);
  const sin = Math.sin(HALFTONE_ANGLE);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const u = (x * cos + y * sin) * inv;
      const v = (-x * sin + y * cos) * inv;

      const du = u - Math.floor(u) - 0.5;
      const dv = v - Math.floor(v) - 0.5;
      const d = Math.sqrt(du * du + dv * dv);

      // The dot must be able to grow until it fills the cell. The cell's
      // corner sits at sqrt(0.5) = 0.707, not at 0.5 — sizing the radius
      // against 0.5 leaves the corners permanently white, so a shadow area
      // prints as a lattice of pinholes instead of merging to solid black.
      // sqrt keeps perceived density roughly linear in tone, which is how a
      // screened print actually reads.
      const radius = Math.sqrt(1 - tone[p]) * 0.7072;
      tone[p] = d <= radius ? 0 : 1;
    }
  }
}

/** Ordered dithering with a Bayer matrix of the given order. */
function dither(tone, w, h, scale, matrix, order) {
  const max = order * order;
  const step = Math.max(1, Math.round((Math.min(w, h) / 900) * scale));

  for (let y = 0; y < h; y++) {
    const my = ((y / step) | 0) % order;
    for (let x = 0; x < w; x++) {
      const mx = ((x / step) | 0) % order;
      const t = (matrix[my * order + mx] + 0.5) / max;
      const p = y * w + x;
      tone[p] = tone[p] > t ? 1 : 0;
    }
  }
}

/**
 * Floyd–Steinberg error diffusion — the photocopier's own algorithm, and the
 * one that gives the characteristic granular, contour-following texture.
 *
 * The accumulated value is clamped at every step. Without that the error
 * feeds back on itself and the frame fills with a fan of streaks radiating
 * from the first pixel.
 */
function errorDiffuse(tone, w, h) {
  const step = 1;

  for (let y = 0; y < h; y++) {
    // Serpentine: sweep right on even rows, left on odd ones. Sweeping the
    // same direction every row lets the carried error build into a visible
    // fan radiating from the first pixel; alternating cancels most of it.
    const reverse = (y & 1) === 1;
    const from = reverse ? w - 1 : 0;
    const to = reverse ? -1 : w;
    const dir = reverse ? -step : step;

    for (let x = from; x !== to; x += dir) {
      const p = y * w + x;
      const old = tone[p];
      const next = old < 0.5 ? 0 : 1;
      const err = old - next;
      tone[p] = next;

      const spread = (dx, dy, factor) => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= w || ny >= h) return;
        const q = ny * w + nx;
        const v = tone[q] + err * factor;
        tone[q] = v < 0 ? 0 : v > 1 ? 1 : v;
      };

      // The classic 7/16, 3/16, 5/16, 1/16 kernel, mirrored on reverse rows.
      spread(dir, 0, 7 / 16);
      spread(-dir, 1, 3 / 16);
      spread(0, 1, 5 / 16);
      spread(dir, 1, 1 / 16);
    }
  }
}

/** Horizontal line screen. Reads as fax, thermal print or a mistuned CRT. */
function scanline(tone, w, h, scale) {
  const pitch = Math.max(2, (Math.min(w, h) / 150) * scale);

  for (let y = 0; y < h; y++) {
    // Duty cycle follows tone: a dark band is a wide band.
    const phase = (y % pitch) / pitch;
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      tone[p] = phase < 1 - tone[p] ? 0 : 1;
    }
  }
}

/** Crossed line screen: mid-grey becomes a woven mesh of black lines. */
function crosshatch(tone, w, h, scale) {
  const pitch = Math.max(3, (Math.min(w, h) / 55) * scale);

  for (let y = 0; y < h; y++) {
    const py = (y % pitch) / pitch;
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const px = (x % pitch) / pitch;
      const dark = 1 - tone[p];
      // Line width follows tone, but each axis only carries half of it: if
      // both axes ran the full width a dark frame saturates into flat ink and
      // the photograph disappears. At the extremes one axis fills first, so
      // shadow still reads as solid and highlight as open paper.
      const lineW = Math.min(1, dark * 1.35);
      const filled = py < lineW * 0.62 || px < lineW * 0.62;
      tone[p] = filled ? 0 : 1;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Print defects                                                       */
/* ------------------------------------------------------------------ */

/**
 * Risograph: two plates printed slightly out of register, so the duotone
 * separates along one edge. This only reads if the plates are quantised
 * first — a misregistered copy of a continuous-tone image just looks blurry.
 */
function riso(tone, w, h, level, scale) {
  const offset = Math.max(1, Math.round(2.5 * scale));
  const src = Float32Array.from(tone);

  // Plate one: the key threshold. Plate two: the same, pulled off-register.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const key = src[p] >= level ? 1 : 0;
      const sx = Math.min(w - 1, x + offset);
      const sy = Math.min(h - 1, y + offset);
      const plate = src[sy * w + sx] >= level ? 1 : 0;

      // Overprint: whichever plate laid ink wins, so a shifted edge shows.
      tone[p] = Math.min(key, plate);
    }
  }
}

/** Blown-out centre, crushed edges — a print held too long under the lamp. */
function filmBurn(tone, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const inv = 1 / Math.max(1, Math.min(w, h) * 0.5);

  for (let y = 0; y < h; y++) {
    const dy = (y + 0.5 - cy) * inv;
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const dx = (x + 0.5 - cx) * inv;
      const d = Math.sqrt(dx * dx + dy * dy);

      const hot = 1 - Math.min(1, d * 1.05);
      let out = tone[p] + hot * hot * 0.62 - Math.max(0, d - 0.66) * 1.9;

      // Snap to two tones in the burned region, keep detail near the core.
      if (d > 0.7) out = out > 0.45 ? 1 : 0;
      tone[p] = out < 0 ? 0 : out > 1 ? 1 : out;
    }
  }
}

/** Aged print: scratches, ink dropout and the odd white gouge. */
function distress(tone, w, h, scale) {
  // A few long vertical scratches, positioned deterministically.
  const scratches = [];
  for (let s = 0; s < 3; s++) {
    scratches.push({
      x: Math.floor(hash2(s, 1, 71) * w),
      width: Math.max(1, Math.floor(1 + hash2(s, 2, 71) * 2 * scale)),
      start: hash2(s, 3, 71) * h * 0.6,
      len: h * (0.3 + hash2(s, 4, 71) * 0.7),
    });
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let out = tone[p];

      // Speckle: missing toner and stray ink.
      const n = hash2(x, y, 97);
      if (n > 0.9965) out = 0;
      else if (n < 0.0022) out = 1;

      // Scratches read as a line of blown-out pixels.
      for (const sc of scratches) {
        if (x >= sc.x && x < sc.x + sc.width && y >= sc.start && y < sc.start + sc.len) {
          out = 1;
        }
      }

      // Broad ink loss, so large areas thin out unevenly.
      const loss = valueNoise(x / 60, y / 60, 131);
      if (loss > 0.72) out = Math.min(1, out + (loss - 0.72) * 1.6);

      tone[p] = out;
    }
  }
}
