/**
 * NOIR Photo Studio — adjustment panel schema
 * ------------------------------------------------------------
 * The panel is generated from this description, so every control,
 * its range, its default and its reset behaviour live in one place.
 */

export const GROUPS = [
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
    id: 'frame',
    title: 'Frame & finish',
    open: false,
    controls: [
      { id: 'vignette', type: 'slider', label: 'Vignette', min: -100, max: 100, step: 1, def: 0 },
    ],
  },
];

export const ALL_CONTROLS = GROUPS.flatMap((g) =>
  g.controls.filter((c) => c.type !== 'note').map((c) => ({ ...c, group: g.id }))
);

export const CONTROL_BY_ID = Object.fromEntries(ALL_CONTROLS.map((c) => [c.id, c]));

export const DEFAULTS = Object.fromEntries(ALL_CONTROLS.map((c) => [c.id, c.def]));

/** Format a value for display. */
export function formatValue(control, value) {
  if (control.type === 'segmented') return value;
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
