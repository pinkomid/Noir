/**
 * NOIR Photo Studio — adjustment panel schema
 * ------------------------------------------------------------
 * The panel is generated from this description, so every control,
 * its range, its default and its reset behaviour live in one place.
 */

/**
 * Default control points for the manual curve, in 0…1 space.
 * With no curve enabled this is an exact identity, so the darkroom looks
 * identical whether or not the curve stage is in play.
 */
export const CURVE_POINTS = [
  [0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1],
];

export const GROUPS = [
  {
    id: 'transform',
    title: 'Crop & transform',
    open: true,
    controls: [
      { id: 'cropMode', type: 'action', label: 'Crop', def: null },
      { id: 'straighten', type: 'slider', label: 'Straighten', min: -45, max: 45, step: 0.1, def: 0, digits: 1, unit: '°' },
      { id: 'aspect', type: 'select', label: 'Aspect', def: 'free',
        options: [
          { value: 'free', label: 'Free' },
          { value: 'orig', label: 'Original' },
          { value: '1:1', label: '1:1 Square' },
          { value: '4:5', label: '4:5 Portrait' },
          { value: '5:4', label: '5:4' },
          { value: '3:2', label: '3:2' },
          { value: '2:3', label: '2:3' },
          { value: '16:9', label: '16:9' },
          { value: '2.39:1', label: 'Scope 2.39' },
        ] },
      { id: 'frameNote', type: 'note', label: 'Crop opens a draggable frame on the print. Rotation and mirrors are applied to the whole frame.' },
    ],
  },
  {
    id: 'tone',
    title: 'Tone',
    open: true,
    controls: [
      { id: 'exposure', type: 'slider', label: 'Exposure', min: -3, max: 3, step: 0.01, def: 0, unit: 'EV', digits: 2 },
      { id: 'contrast', type: 'slider', label: 'Contrast', min: -100, max: 100, step: 1, def: 0 },
      { id: 'highlights', type: 'slider', label: 'Highlights', min: -100, max: 100, step: 1, def: 0 },
      { id: 'shadows', type: 'slider', label: 'Shadows', min: -100, max: 100, step: 1, def: 0 },
      { id: 'whites', type: 'slider', label: 'Whites', min: -100, max: 100, step: 1, def: 0 },
      { id: 'blacks', type: 'slider', label: 'Blacks', min: -100, max: 100, step: 1, def: 0 },
      { id: 'curveOn', type: 'toggle', label: 'Manual curve', def: false },
      { id: 'curvePoints', type: 'curve', label: 'Tone curve' },
    ],
  },
  {
    id: 'density',
    title: 'Density & structure',
    open: true,
    controls: [
      { id: 'clarity', type: 'slider', label: 'Clarity', min: 0, max: 100, step: 1, def: 0 },
      { id: 'glow', type: 'slider', label: 'Halation', min: 0, max: 100, step: 1, def: 0 },
      { id: 'fade', type: 'slider', label: 'Matte fade', min: 0, max: 100, step: 1, def: 0 },
    ],
  },
  {
    id: 'grain',
    title: 'Grain',
    open: false,
    controls: [
      { id: 'grain', type: 'slider', label: 'Amount', min: 0, max: 100, step: 1, def: 0 },
      { id: 'grainSize', type: 'slider', label: 'Size', min: 0.8, max: 3, step: 0.05, def: 1.6, digits: 2 },
    ],
  },
  {
    id: 'toning',
    title: 'Toning',
    open: false,
    controls: [
      { id: 'tone', type: 'segmented', label: 'Chemistry', def: 'neutral' },
      { id: 'toneStrength', type: 'slider', label: 'Strength', min: 0, max: 100, step: 1, def: 0 },
    ],
  },
  {
    id: 'mix',
    title: 'Channel mix',
    open: false,
    controls: [
      { id: 'mixR', type: 'slider', label: 'Red', min: 0, max: 1, step: 0.01, def: 0.3, digits: 2 },
      { id: 'mixG', type: 'slider', label: 'Green', min: 0, max: 1, step: 0.01, def: 0.59, digits: 2 },
      { id: 'mixB', type: 'slider', label: 'Blue', min: 0, max: 1, step: 0.01, def: 0.11, digits: 2 },
      { id: 'sepiaReset', type: 'note', label: 'Red lifts skin and sky; blue darkens them. Panchromatic film sits near 30/59/11.' },
    ],
  },
  {
    id: 'local',
    title: 'Local dodge & burn',
    open: false,
    controls: [
      { id: 'maskAmount', type: 'slider', label: 'Strength', min: -100, max: 100, step: 1, def: 0 },
      { id: 'maskSize', type: 'slider', label: 'Brush size', min: 2, max: 40, step: 1, def: 12 },
      { id: 'maskNote', type: 'note', label: 'Turn on Brush mode (B), paint an area, then pull Strength positive to dodge or negative to burn.' },
    ],
  },
  {
    id: 'frame',
    title: 'Frame & finish',
    open: false,
    controls: [
      { id: 'vignette', type: 'slider', label: 'Vignette', min: -100, max: 100, step: 1, def: 0 },
    ],
  },
  {
    id: 'orient',
    title: 'Rotate & mirror',
    open: false,
    controls: [
      { id: 'rotateLeft', type: 'action', label: 'Rotate left 90°', def: null },
      { id: 'rotateRight', type: 'action', label: 'Rotate right 90°', def: null },
      { id: 'flipH', type: 'toggle', label: 'Mirror horizontally', def: false },
      { id: 'flipV', type: 'toggle', label: 'Mirror vertically', def: false },
    ],
  },
];

export const ALL_CONTROLS = GROUPS.flatMap((g) =>
  g.controls
    .filter((c) => c.type !== 'note')
    .map((c) => ({ ...c, group: g.id, def: c.def !== undefined ? c.def : CURVE_POINTS }))
);

export const CONTROL_BY_ID = Object.fromEntries(ALL_CONTROLS.map((c) => [c.id, c]));

export const DEFAULTS = Object.fromEntries(ALL_CONTROLS.map((c) => [c.id, c.def]));

/** Format a value for display. */
export function formatValue(control, value) {
  if (control.type === 'segmented') return value;
  if (control.type === 'toggle') return value ? 'on' : 'off';
  if (control.type === 'curve') return '';
  const digits = control.digits ?? 0;
  const n = Number(value);
  const text = n.toFixed(digits);
  if (control.unit === 'EV') {
    const signed = n > 0 ? `+${text}` : text;
    return `${signed} ${control.unit}`;
  }
  if (n > 0 && control.min < 0) return `+${text}`;
  return text;
}

/** Position of a value within its control, 0…1 (drives the fill track). */
export function valueRatio(control, value) {
  const span = control.max - control.min;
  if (!span) return 0;
  return Math.min(1, Math.max(0, (Number(value) - control.min) / span));
}
