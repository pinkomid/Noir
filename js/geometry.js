/**
 * NOIR Photo Studio — geometry
 * ------------------------------------------------------------
 * Crop, rotation, straightening and flips, expressed as a single
 * normalised transform so every consumer (engine, brush, crop overlay,
 * export) agrees on exactly where the print sits.
 *
 * Model
 * -----
 * `params.frame` describes what to do to the ORIGINAL photograph, in
 * normalised 0…1 space of the original:
 *
 *   { x, y, w, h }   the cropped window, in original-image coordinates
 *   rotation         90° steps, 0…3
 *   flipH, flipV     mirrors
 *   straighten       fine rotation in degrees, +-45
 *
 * `frameSize()` then reports the print's pixel dimensions, and
 * `drawFrame()` paints the original through that transform onto a
 * destination canvas — the single place the geometry is applied.
 */

export const FRAME_DEFAULTS = {
  crop: { x: 0, y: 0, w: 1, h: 1 },
  rotation: 0,
  flipH: false,
  flipV: false,
  straighten: 0,
};

/** Aspect presets. `ratio` is width / height of the print. */
export const ASPECTS = [
  { id: 'free', name: 'Free', ratio: null },
  { id: 'orig', name: 'Original', ratio: 'original' },
  { id: '1:1', name: '1:1', ratio: 1 },
  { id: '4:5', name: '4:5', ratio: 4 / 5 },
  { id: '5:4', name: '5:4', ratio: 5 / 4 },
  { id: '3:2', name: '3:2', ratio: 3 / 2 },
  { id: '2:3', name: '2:3', ratio: 2 / 3 },
  { id: '16:9', name: '16:9', ratio: 16 / 9 },
  { id: '2.39:1', name: 'Scope', ratio: 2.39 },
];

export function aspectRatio(id, original) {
  const found = ASPECTS.find((a) => a.id === id);
  if (!found || found.ratio === null) return null;
  if (found.ratio === 'original') return original.width / original.height;
  return found.ratio;
}

/* ------------------------------------------------------------------ */
/* Geometry math                                                       */
/* ------------------------------------------------------------------ */

/**
 * Dimensions of the developed print, in negative pixels.
 * The crop is taken in original space, then the 90° rotation swaps the
 * axes.
 */
export function frameSize(frame, negative) {
  const c = frame.crop || FRAME_DEFAULTS.crop;
  const rawW = Math.max(1, negative.width * c.w);
  const rawH = Math.max(1, negative.height * c.h);
  const rotated = frame.rotation % 2 === 1;
  return rotated
    ? { width: Math.round(rawH), height: Math.round(rawW) }
    : { width: Math.round(rawW), height: Math.round(rawH) };
}

/**
 * Largest axis-aligned rectangle of a given aspect that fits inside the
 * straightened crop, so rotating never reveals empty corners.
 */
function straightenedInnerBox(w, h, degrees) {
  const rad = (Math.abs(degrees) * Math.PI) / 180;
  if (rad < 1e-6) return { w, h };

  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const longer = Math.max(w, h);
  const shorter = Math.min(w, h);

  // Try each of the two natural fits and take the roomier one.
  let scaleW = w / (w * cos + h * sin);
  let scaleH = h / (w * sin + h * cos);
  let scale = Math.min(scaleW, scaleH);

  // Guard against the degenerate case where the maths would collapse.
  if (!isFinite(scale) || scale <= 0) {
    scale = Math.min(longer, shorter) / (longer * (cos + sin));
  }
  return { w: w * scale, h: h * scale };
}

/**
 * Paint the original photograph into a destination context through the
 * frame transform. This is the single source of truth for the geometry.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w destination width in pixels
 * @param {number} h destination height in pixels
 * @param {HTMLCanvasElement} source the negative (or its preview surface)
 * @param {object} frame
 * @param {{ cover?: boolean }} [opts] cover fills the frame after straightening
 */
export function drawFrame(ctx, w, h, source, frame, opts = {}) {
  const sw = source.width;
  const sh = source.height;
  const crop = frame.crop || FRAME_DEFAULTS.crop;

  const cw = Math.max(1, crop.w * sw);
  const ch = Math.max(1, crop.h * sh);
  const cx = crop.x * sw;
  const cy = crop.y * sh;

  // Straightening shrinks the visible crop so nothing empty shows.
  const box = opts.cover === false ? { w: cw, h: ch } : straightenedInnerBox(cw, ch, frame.straighten || 0);

  const rot = ((frame.rotation % 4) + 4) % 4;
  const axisSwap = rot % 2 === 1;
  const targetW = axisSwap ? h : w;
  const targetH = axisSwap ? w : h;
  const fitX = targetW / box.w;
  const fitY = targetH / box.h;

  ctx.save();
  ctx.translate(w / 2, h / 2);

  if (rot) ctx.rotate((rot * Math.PI) / 2);

  // Clip to the print. Cropping is expressed by drawing the whole negative
  // and letting this clip discard the rest, which keeps the sampling inside
  // the source and avoids the seam artefacts some canvas backends produce
  // when a rotated draw also samples a sub-rectangle.
  ctx.beginPath();
  ctx.rect(-targetW / 2, -targetH / 2, targetW, targetH);
  ctx.clip();

  // Rotation is applied in square pixel space; scaling comes after, so a
  // tilt can never shear the geometry.
  if (frame.straighten) ctx.rotate((frame.straighten * Math.PI) / 180);

  ctx.scale(frame.flipH ? -1 : 1, frame.flipV ? -1 : 1);
  ctx.scale(fitX, fitY);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Position the crop window's centre at the origin, at native scale.
  const tox = -(cx + cw / 2);
  const toy = -(cy + ch / 2);
  ctx.drawImage(source, 0, 0, sw, sh, tox, toy, sw, sh);

  ctx.restore();
}

/**
 * Map a point from print space (0…1 of the developed frame) back to
 * original-image space, so painting the mask and the crop handles both
 * address the right pixels.
 */
export function printToOriginal(u, v, frame) {
  const rot = ((frame.rotation % 4) + 4) % 4;
  // Undo the quarter turns by rotating the unit square back.
  let x = u;
  let y = v;
  for (let i = 0; i < (4 - rot) % 4; i++) {
    const nx = y;
    const ny = 1 - x;
    x = nx;
    y = ny;
  }
  if (frame.flipH) x = 1 - x;
  if (frame.flipV) y = 1 - y;

  const c = frame.crop || FRAME_DEFAULTS.crop;
  return { x: c.x + x * c.w, y: c.y + y * c.h };
}

/** Centre-crop a window to an aspect ratio, keeping it inside the frame. */
export function fitCropToAspect(crop, ratio, negative) {
  if (!ratio) return crop;

  // Work in normalised units where the image is ratio-corrected, so the
  // requested aspect means the same thing in pixels.
  const imgRatio = negative.width / negative.height;

  const cx = crop.x + crop.w / 2;
  const cy = crop.y + crop.h / 2;

  // Current size in "aspect units".
  let wAspect = crop.w * imgRatio;
  let hAspect = crop.h;

  if (wAspect / hAspect > ratio) wAspect = hAspect * ratio;
  else hAspect = wAspect / ratio;

  let w = wAspect / imgRatio;
  let h = hAspect;

  // Shrink to fit the image.
  const scale = Math.min(1 / w, 1 / h, 1);
  w *= scale;
  h *= scale;

  let x = cx - w / 2;
  let y = cy - h / 2;
  x = Math.max(0, Math.min(1 - w, x));
  y = Math.max(0, Math.min(1 - h, y));

  return { x, y, w, h };
}

/** Is the frame doing anything at all? */
export function isNeutralFrame(frame) {
  if (!frame) return true;
  const c = frame.crop || FRAME_DEFAULTS.crop;
  return (
    Math.abs(c.x) < 1e-4 &&
    Math.abs(c.y) < 1e-4 &&
    Math.abs(c.w - 1) < 1e-4 &&
    Math.abs(c.h - 1) < 1e-4 &&
    (frame.rotation % 4) === 0 &&
    !frame.flipH &&
    !frame.flipV &&
    Math.abs(frame.straighten || 0) < 1e-4
  );
}

export function cloneFrame(frame) {
  const f = frame || FRAME_DEFAULTS;
  return {
    crop: { ...f.crop },
    rotation: f.rotation || 0,
    flipH: !!f.flipH,
    flipV: !!f.flipV,
    straighten: f.straighten || 0,
  };
}
