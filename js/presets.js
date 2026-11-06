/**
 * NOIR Photo Studio — film stock definitions
 * ------------------------------------------------------------
 * Each preset is a complete darkroom recipe. `params` mirrors every
 * control in the Adjustments panel, so loading a stock and then
 * nudging it is lossless — a preset is just a starting state.
 *
 * Parameter ranges (all centred on 0 unless noted):
 *   exposure   -3 … +3 EV
 *   contrast   -100 … 100
 *   highlights -100 … 100
 *   shadows    -100 … 100
 *   whites     -100 … 100
 *   blacks     -100 … 100
 *   clarity      0 … 100   (local midtone contrast)
 *   glow         0 … 100   (halation / bloom)
 *   fade         0 … 100   (matte raised blacks)
 *   grain        0 … 100
 *   grainSize    1 … 3
 *   vignette  -100 … 100
 *   toneStrength 0 … 100
 */

// One source of truth for parameter defaults: the adjustment panel schema.
import { DEFAULTS as PANEL_DEFAULTS } from './controls.js';

export const TONES = [
  { id: 'neutral', name: 'Neutral' },
  { id: 'selenium', name: 'Selenium' },
  { id: 'warm', name: 'Warm' },
  { id: 'platinum', name: 'Platinum' },
  { id: 'sepia', name: 'Sepia' },
  { id: 'cyan', name: 'Cyanotype' },
  { id: 'cool', name: 'Cool' },
];

/**
 * `thumb` is a CSS filter used for the stock's swatch, sampled from the
 * bundled reference portrait. It should *evoke* the stock, not replicate
 * it — the real look is rendered on the canvas.
 */
export const PRESETS = [
  {
    id: 'noir',
    name: 'NOIR 100',
    sub: 'Signature · stock',
    key: '1',
    thumb: 'contrast(1.22) brightness(0.98)',
    params: {
      exposure: 0, contrast: 24, highlights: -18, shadows: 8, whites: 12, blacks: -14,
      clarity: 18, glow: 6, fade: 0, grain: 26, grainSize: 1.6, vignette: -22,
      tone: 'neutral', toneStrength: 0, mixR: 0.34, mixG: 0.54, mixB: 0.12,
    },
  },
  {
    id: 'tri-x',
    name: 'TRI-X 400',
    sub: 'Reportage',
    key: '2',
    thumb: 'contrast(1.34) brightness(1.02)',
    params: {
      exposure: 0.05, contrast: 30, highlights: -10, shadows: 0, whites: 18, blacks: -22,
      clarity: 26, glow: 0, fade: 0, grain: 52, grainSize: 2, vignette: -30,
      tone: 'neutral', toneStrength: 0, mixR: 0.3, mixG: 0.58, mixB: 0.12,
    },
  },
  {
    id: 'verite',
    name: 'VÉRITÉ',
    sub: 'Pushed 1600',
    key: '3',
    thumb: 'contrast(1.5) brightness(1.08)',
    params: {
      exposure: 0.18, contrast: 20, highlights: 22, shadows: 14, whites: 24, blacks: -34,
      clarity: 34, glow: 14, fade: 0, grain: 78, grainSize: 2.6, vignette: -34,
      tone: 'neutral', toneStrength: 0, mixR: 0.32, mixG: 0.56, mixB: 0.12,
    },
  },
  {
    id: 'delta',
    name: 'DELTA 3200',
    sub: 'Available light',
    key: '4',
    thumb: 'contrast(1.06) brightness(1.12) blur(0.2px)',
    params: {
      exposure: 0.1, contrast: 8, highlights: -6, shadows: 20, whites: -6, blacks: -30,
      clarity: 10, glow: 18, fade: 8, grain: 88, grainSize: 2.2, vignette: -18,
      tone: 'neutral', toneStrength: 0, mixR: 0.3, mixG: 0.58, mixB: 0.12,
    },
  },
  {
    id: 'panf',
    name: 'PAN F 50',
    sub: 'Ultra fine',
    key: '5',
    thumb: 'contrast(1.42) brightness(0.94)',
    params: {
      exposure: -0.05, contrast: 26, highlights: -24, shadows: 2, whites: 10, blacks: -10,
      clarity: 40, glow: 0, fade: 0, grain: 8, grainSize: 1.1, vignette: -12,
      tone: 'neutral', toneStrength: 0, mixR: 0.28, mixG: 0.58, mixB: 0.14,
    },
  },
  {
    id: 'acros',
    name: 'ACROS 100',
    sub: 'Smooth tonal',
    key: '6',
    thumb: 'contrast(1.16) brightness(1.0)',
    params: {
      exposure: 0.02, contrast: 16, highlights: -16, shadows: 12, whites: 6, blacks: -10,
      clarity: 20, glow: 4, fade: 0, grain: 7, grainSize: 1.1, vignette: -10,
      tone: 'neutral', toneStrength: 0, mixR: 0.24, mixG: 0.62, mixB: 0.14,
    },
  },
  {
    id: 'tmax',
    name: 'T-MAX P3200',
    sub: 'Grain study',
    key: '7',
    thumb: 'contrast(1.18) brightness(1.06)',
    params: {
      exposure: 0.12, contrast: 12, highlights: -24, shadows: 24, whites: 0, blacks: -20,
      clarity: 14, glow: 10, fade: 6, grain: 68, grainSize: 2.4, vignette: -16,
      tone: 'neutral', toneStrength: 0, mixR: 0.3, mixG: 0.58, mixB: 0.12,
    },
  },
  {
    id: 'oporto',
    name: 'OPORTO',
    sub: 'Soft portrait',
    key: '8',
    thumb: 'contrast(0.9) brightness(1.1) sepia(0.16)',
    params: {
      exposure: 0.08, contrast: -4, highlights: -26, shadows: 26, whites: -8, blacks: 10,
      clarity: 4, glow: 34, fade: 8, grain: 16, grainSize: 1.4, vignette: -8,
      tone: 'warm', toneStrength: 22, mixR: 0.36, mixG: 0.52, mixB: 0.12,
    },
  },
  {
    id: 'silver',
    name: 'SILVER GELATIN',
    sub: 'Darkroom print',
    key: '9',
    thumb: 'contrast(1.26) brightness(1.0) sepia(0.1)',
    params: {
      exposure: 0, contrast: 24, highlights: -14, shadows: 4, whites: 14, blacks: -8,
      clarity: 22, glow: 4, fade: 4, grain: 30, grainSize: 1.5, vignette: -26,
      tone: 'selenium', toneStrength: 30, mixR: 0.3, mixG: 0.58, mixB: 0.12,
    },
  },
  {
    id: 'platinum',
    name: 'PLATINUM',
    sub: 'Alt process',
    key: '',
    thumb: 'contrast(1.04) brightness(1.06) sepia(0.3)',
    params: {
      exposure: 0.04, contrast: 6, highlights: -18, shadows: 18, whites: -14, blacks: 16,
      clarity: 8, glow: 22, fade: 26, grain: 22, grainSize: 1.7, vignette: -14,
      tone: 'platinum', toneStrength: 55, mixR: 0.3, mixG: 0.58, mixB: 0.12,
    },
  },
  {
    id: 'cyanotype',
    name: 'CYANOTYPE',
    sub: 'Prussian blue',
    key: '',
    thumb: 'contrast(1.0) brightness(1.04) sepia(0.5) hue-rotate(165deg) saturate(2.4)',
    params: {
      exposure: 0.05, contrast: 2, highlights: -10, shadows: 20, whites: -18, blacks: 8,
      clarity: 6, glow: 10, fade: 20, grain: 20, grainSize: 1.8, vignette: -10,
      tone: 'cyan', toneStrength: 72, mixR: 0.3, mixG: 0.58, mixB: 0.12,
    },
  },
  {
    id: 'carbon',
    name: 'CARBON',
    sub: 'Hard structure',
    key: '',
    thumb: 'contrast(1.6) brightness(0.94)',
    params: {
      exposure: -0.02, contrast: 34, highlights: -30, shadows: -2, whites: 8, blacks: -30,
      clarity: 30, glow: 0, fade: 12, grain: 14, grainSize: 1.2, vignette: -30,
      tone: 'cool', toneStrength: 12, mixR: 0.3, mixG: 0.58, mixB: 0.12,
    },
  },
];

/**
 * Hard-graphic stocks. These are not film emulations — they are print
 * processes: photocopiers, risographs, screen prints and zine layouts, where
 * the picture has been quantised and the surface has started to fail.
 *
 * They live in their own group because they behave differently from the
 * darkroom stocks: tone carries far less of the look and `fx` carries most of
 * it, so the two families would read as one confusing list together.
 *
 * Each entry's `params.fx` matches an id in fx.js; `fxAmount` and `fxScale`
 * are the same controls the Effects tab exposes, so loading a stock and then
 * dialling it back is lossless.
 */
export const EFFECT_PRESETS = [
  {
    family: 'lab',
    id: 'xerox',
    name: 'XEROX',
    sub: 'Copier · two-tone',
    key: '',
    thumb: 'contrast(2.6) brightness(1.06) grayscale(1)',
    params: {
      exposure: 0.06, contrast: 18, highlights: -6, shadows: 10, whites: 14, blacks: -16,
      clarity: 30, glow: 0, fade: 0, grain: 18, grainSize: 1.4, vignette: -14,
      tone: 'neutral', toneStrength: 0, mixR: 0.32, mixG: 0.56, mixB: 0.12,
      fx: 'xerox', fxAmount: 100, fxScale: 100, fxLevel: 50,
    },
  },
  {
    family: 'lab',
    id: 'hardlight',
    name: 'HARD LIGHT',
    sub: 'Threshold · blown',
    key: '',
    thumb: 'contrast(3) brightness(1.14) grayscale(1)',
    params: {
      exposure: 0.1, contrast: 16, highlights: 14, shadows: 12, whites: 18, blacks: -18,
      clarity: 24, glow: 0, fade: 0, grain: 10, grainSize: 1.2, vignette: 0,
      tone: 'neutral', toneStrength: 0, mixR: 0.32, mixG: 0.56, mixB: 0.12,
      fx: 'threshold', fxAmount: 100, fxScale: 100, fxLevel: 50,
    },
  },
  {
    family: 'lab',
    id: 'torn',
    name: 'TORN EDGE',
    sub: 'Soft threshold',
    key: '',
    thumb: 'contrast(2.2) brightness(1.05) grayscale(1)',
    params: {
      exposure: 0.06, contrast: 14, highlights: 4, shadows: 8, whites: 10, blacks: -14,
      clarity: 20, glow: 8, fade: 0, grain: 34, grainSize: 2.2, vignette: -8,
      tone: 'neutral', toneStrength: 0, mixR: 0.32, mixG: 0.56, mixB: 0.12,
      fx: 'thresholdSoft', fxAmount: 100, fxScale: 100, fxLevel: 50,
    },
  },
  {
    family: 'lab',
    id: 'newsprint',
    name: 'NEWSPRINT',
    sub: 'Halftone · 45°',
    key: '',
    thumb: 'contrast(2) brightness(1.04) grayscale(1)',
    params: {
      exposure: 0.04, contrast: 14, highlights: -2, shadows: 8, whites: 10, blacks: -12,
      clarity: 18, glow: 0, fade: 0, grain: 12, grainSize: 1.2, vignette: -10,
      tone: 'neutral', toneStrength: 0, mixR: 0.32, mixG: 0.56, mixB: 0.12,
      fx: 'halftone', fxAmount: 100, fxScale: 110, fxLevel: 50,
    },
  },
  {
    family: 'lab',
    id: 'onedbit',
    name: '1-BIT',
    sub: 'Ordered dither',
    key: '',
    thumb: 'contrast(2.4) brightness(1.06) grayscale(1)',
    params: {
      exposure: 0.04, contrast: 12, highlights: 2, shadows: 6, whites: 10, blacks: -12,
      clarity: 26, glow: 0, fade: 0, grain: 0, grainSize: 1.2, vignette: -8,
      tone: 'neutral', toneStrength: 0, mixR: 0.32, mixG: 0.56, mixB: 0.12,
      fx: 'dither', fxAmount: 100, fxScale: 100, fxLevel: 50,
    },
  },
  {
    family: 'lab',
    id: 'fax',
    name: 'FAX',
    sub: 'Line screen',
    key: '',
    thumb: 'contrast(2.2) brightness(1.05) grayscale(1)',
    params: {
      exposure: 0.04, contrast: 16, highlights: 2, shadows: 6, whites: 10, blacks: -14,
      clarity: 22, glow: 0, fade: 0, grain: 8, grainSize: 1.2, vignette: -6,
      tone: 'cool', toneStrength: 8, mixR: 0.32, mixG: 0.56, mixB: 0.12,
      fx: 'scanline', fxAmount: 100, fxScale: 90, fxLevel: 50,
    },
  },
  {
    family: 'lab',
    id: 'riso',
    name: 'RISO',
    sub: 'Misregistered',
    key: '',
    thumb: 'contrast(1.8) brightness(1.04) grayscale(1)',
    params: {
      exposure: 0.02, contrast: 12, highlights: 4, shadows: 8, whites: 8, blacks: -10,
      clarity: 16, glow: 10, fade: 6, grain: 22, grainSize: 1.8, vignette: -8,
      tone: 'cool', toneStrength: 16, mixR: 0.32, mixG: 0.56, mixB: 0.12,
      fx: 'riso', fxAmount: 100, fxScale: 100, fxLevel: 50,
    },
  },
  {
    family: 'lab',
    id: 'decayed',
    name: 'DECAYED',
    sub: 'Scratched print',
    key: '',
    thumb: 'contrast(1.9) brightness(0.98) grayscale(1)',
    params: {
      exposure: -0.02, contrast: 16, highlights: -6, shadows: 2, whites: 8, blacks: -14,
      clarity: 22, glow: 6, fade: 10, grain: 44, grainSize: 2.6, vignette: -26,
      tone: 'neutral', toneStrength: 0, mixR: 0.32, mixG: 0.56, mixB: 0.12,
      fx: 'distress', fxAmount: 100, fxScale: 100, fxLevel: 50,
    },
  },
  {
    family: 'lab',
    id: 'burnt',
    name: 'BURNT',
    sub: 'Blown centre',
    key: '',
    thumb: 'contrast(2.1) brightness(1.1) grayscale(1)',
    params: {
      exposure: 0.08, contrast: 14, highlights: 12, shadows: -4, whites: 16, blacks: -16,
      clarity: 18, glow: 18, fade: 0, grain: 26, grainSize: 2, vignette: -34,
      tone: 'neutral', toneStrength: 0, mixR: 0.32, mixG: 0.56, mixB: 0.12,
      fx: 'filmBurn', fxAmount: 100, fxScale: 100, fxLevel: 50,
    },
  },
  {
    family: 'lab',
    id: 'weave',
    name: 'WEAVE',
    sub: 'Crossed lines',
    key: '',
    thumb: 'contrast(2.1) brightness(1.02) grayscale(1)',
    params: {
      exposure: 0.02, contrast: 14, highlights: 2, shadows: 8, whites: 8, blacks: -12,
      clarity: 20, glow: 0, fade: 0, grain: 10, grainSize: 1.2, vignette: -8,
      tone: 'neutral', toneStrength: 0, mixR: 0.32, mixG: 0.56, mixB: 0.12,
      fx: 'crosshatch', fxAmount: 100, fxScale: 100, fxLevel: 50,
    },
  },
  {
    family: 'lab',
    id: 'duotone',
    name: 'DUOTONE',
    sub: 'Diffusion · cool',
    key: '',
    thumb: 'contrast(1.7) brightness(1.02) grayscale(1)',
    params: {
      exposure: 0.02, contrast: 10, highlights: 2, shadows: 8, whites: 8, blacks: -10,
      clarity: 14, glow: 12, fade: 8, grain: 20, grainSize: 1.8, vignette: -10,
      tone: 'cyan', toneStrength: 22, mixR: 0.32, mixG: 0.56, mixB: 0.12,
      fx: 'errorDiffuse', fxAmount: 100, fxScale: 100, fxLevel: 50,
    },
  },
  {
    family: 'lab',
    id: 'poster',
    name: 'POSTER',
    sub: 'Three-plate',
    key: '',
    thumb: 'contrast(2) brightness(1.04) grayscale(1)',
    params: {
      exposure: 0.04, contrast: 16, highlights: 6, shadows: 6, whites: 12, blacks: -14,
      clarity: 26, glow: 0, fade: 0, grain: 16, grainSize: 1.6, vignette: -12,
      tone: 'neutral', toneStrength: 0, mixR: 0.32, mixG: 0.56, mixB: 0.12,
      fx: 'ditherFine', fxAmount: 100, fxScale: 120, fxLevel: 50,
    },
  },
];

/** Everything the rail lists: darkroom stocks first, then the graphic lab. */
export const ALL_PRESETS = [...PRESETS, ...EFFECT_PRESETS];

export const PRESET_BY_ID = Object.fromEntries(ALL_PRESETS.map((p) => [p.id, p]));

/** Which family a stock belongs to. */
export function familyOf(id) {
  return EFFECT_PRESETS.some((p) => p.id === id) ? 'lab' : 'darkroom';
}

/** Merge a preset's params over the defaults. */
export function paramsFor(id) {
  const preset = PRESET_BY_ID[id] || PRESETS[0];
  return { ...PANEL_DEFAULTS, ...preset.params };
}
