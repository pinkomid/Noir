/**
 * NOIR Photo Studio — application
 * ------------------------------------------------------------
 * Owns the state (negative, parameters, history, view) and wires the
 * DOM to the development engine.
 */

import { Darkroom, SUPPORTS_FILTER } from './engine.js';
import { BatchJob } from './batch.js';
import {
  FRAME_DEFAULTS, ASPECTS, aspectRatio, frameSize,
  fitCropToAspect, isNeutralFrame, cloneFrame,
  cropToPrintRect, printRectToCrop,
} from './geometry.js';
import { PRESETS, ALL_PRESETS, PRESET_BY_ID, paramsFor } from './presets.js';
import { DEFAULTS as CONTROL_DEFAULTS, CURVE_POINTS, ALL_CONTROLS } from './controls.js';
import {
  $, el, buildPresetRail, buildPanel, drawHistogram,
  initToasts, toast, initModals,
} from './ui.js';

const SAMPLE_THUMB = 'assets/sample-portrait.jpg';
const SAMPLES = [
  { src: 'assets/sample-portrait.jpg', label: 'Sample portrait' },
  { src: 'assets/sample-architecture.jpg', label: 'Sample architecture' },
];

const STORAGE_KEY = 'noir.preset';
const THEME_KEY = 'noir.theme';

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const engine = new Darkroom();

const state = {
  presetId: PRESETS[0].id,
  params: paramsFor(PRESETS[0].id),
  fileName: '',
  hasAlpha: false,
  compare: false,
  view: { zoom: 'fit', panX: 0, panY: 0 },
  sampleIndex: -1,
  busy: false,
  drafting: false,
  brush: false,
  erase: false,
  cropMode: false,
};

/**
 * The aspect lock lives in `params.aspect`, because that is where the select
 * control reads it from. Keeping a second copy on `state` and writing only
 * that one is exactly how the panel came to say "Free" while the frame was
 * square: applyAspect() set state.aspect, then applyFrame() re-synced the
 * panel from params and put the select back.
 *
 * One object, one accessor. There is no setter on purpose — writes have to go
 * through applyAspect() so the crop is actually reshaped; silently assigning
 * a lock that nothing applies would be a new bug, not a fix.
 */
function currentAspect() {
  return (state.params && state.params.aspect) || 'free';
}

const history = { stack: [], index: -1 };

/* ------------------------------------------------------------------ */
/* Elements                                                            */
/* ------------------------------------------------------------------ */

const view = $('#view');
// Pixel readback happens on every render, so keep the context on the CPU.
const vctx = view.getContext('2d', { willReadFrequently: true });
const stageFrame = $('#stageFrame');
const emptyState = $('#emptyState');
const dropOverlay = $('#dropOverlay');
const stageBadge = $('#stageBadge');
const histogramCanvas = $('#histogram');
const dimsEl = $('#dims');
const zoomValue = $('#zoomValue');
const statusText = $('#statusText');
const filmName = $('.film-name');
const filmDetail = $('.film-detail');
const fileInput = $('#fileInput');
const panelBody = $('#panelBody');

initToasts($('#toastStack'));
const modals = initModals();

/* ------------------------------------------------------------------ */
/* Panel & rail                                                        */
/* ------------------------------------------------------------------ */

let draftTimer = 0;

let panel = buildPanel(panelBody, {
  onChange: (id, value, { commit }) => {
    // Two controls in the transform group describe the frame rather than a
    // pixel parameter, so they are routed before the generic path.
    if (id === 'straighten') {
      state.params.straighten = Number(value);
      state.params.frame.straighten = Number(value);
      applyFrame(state.params.frame, { syncPanel: false });
      updateFrameReadout();
      repaintCrop();
      if (commit) pushHistory();
      return;
    }
    if (id === 'aspect') {
      applyAspect(value);
      if (commit) pushHistory();
      return;
    }

    // Mirror toggles live on the frame.
    if (id === 'flipH' || id === 'flipV') {
      toggleMirror(id);
      return;
    }

    state.params[id] = value;

    // Toggles and the curve commit on click, so they never need a draft.
    const isDiscrete = id === 'curvePoints' || typeof value === 'boolean';

    // While a slider is being dragged, render a lighter copy so the
    // preview keeps up; the full-quality pass lands on release.
    state.drafting = !commit && !isDiscrete;
    clearTimeout(draftTimer);
    if (!commit && !isDiscrete) {
      draftTimer = setTimeout(() => { state.drafting = false; scheduleRender(); }, 220);
    }

    scheduleRender();
    panel.sync(state.params);
    if (commit) pushHistory();
  },
  onReset: (id) => {
    if (id === 'straighten' || id === 'aspect') {
      if (id === 'aspect') { applyAspect('orig'); }
      else setParam(id, CONTROL_DEFAULTS[id], true);
      return;
    }
    setParam(id, CONTROL_DEFAULTS[id], true);
  },
  onAction: (id) => handleAction(id),
});

const rail = buildPresetRail($('#presetList'), ALL_PRESETS, SAMPLE_THUMB, (id) => applyPreset(id, true));

panel.setEnabled(false);

/* ------------------------------------------------------------------ */
/* Parameter helpers                                                   */
/* ------------------------------------------------------------------ */

function setParam(id, value, commit = false) {
  state.params[id] = value;
  panel.sync(state.params);
  scheduleRender();
  if (commit) pushHistory();
}

function withFrame(params, frame) {
  return { ...params, frame: frame ? cloneFrame(frame) : cloneFrame(FRAME_DEFAULTS) };
}

function setPresetSilently(id) {
  const previousFrame = state.params && state.params.frame;
  state.presetId = id;
  // Switching film stock must not disturb the crop or orientation.
  state.params = withFrame(paramsFor(id), previousFrame);
  rail.setActive(id);
  panel.sync(state.params);
  updateReadout();
}

function applyPreset(id, commit = false) {
  const preset = PRESET_BY_ID[id];
  if (!preset) return;

  setPresetSilently(id);

  // Reveal the groups this stock relies on.
  if (preset.params.grain > 40) panel.openGroup('grain', true);
  if (preset.params.toneStrength > 0) panel.openGroup('toning', true);
  // A graphic stock is defined by its effect; open the tab that owns it so
  // the look is visibly a dial you can turn, not a mystery.
  if (preset.params.fx && preset.params.fx !== 'none') panel.openGroup('fx', true);

  scheduleRender({ histogram: true });
  if (commit) pushHistory();

  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch { /* private mode */ }

  toast(`Loaded ${preset.name}`, { accent: true, timeout: 1600 });
}

function resetAll() {
  setPresetSilently(PRESETS[0].id);
  state.params = withFrame(paramsFor(PRESETS[0].id), FRAME_DEFAULTS);
  state.params.aspect = 'free';
  if (state.cropMode) toggleCropMode(false);
  engine.refreshSurface(state.params.frame);
  syncFrameControls();
  updateFrameReadout();
  state.brush = false;
  panel.sync(state.params);
  updateBrushUi();
  scheduleRender({ histogram: true });
  pushHistory();
  toast('Adjustments reset');
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

const THEMES = ['dark', 'light'];

function resolveTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch { /* private mode */ }
  if (saved && THEMES.includes(saved)) return saved;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

function applyTheme(theme, { persist = true } = {}) {
  const next = THEMES.includes(theme) ? theme : 'dark';
  document.documentElement.dataset.theme = next;
  const btn = $('#themeBtn');
  if (btn) {
    btn.setAttribute(
      'aria-label',
      next === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
    );
  }
  // The checkered plate and the canvas chrome are redrawn from CSS vars.
  if (engine.loaded) scheduleRender({ histogram: true });
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch { /* private mode */ }
  }
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  toast(next === 'light' ? 'Light theme' : 'Dark theme', { timeout: 1200 });
}

/* ------------------------------------------------------------------ */
/* Geometry: crop, rotate, mirror                                      */
/* ------------------------------------------------------------------ */

/** Push a new frame into state, re-derive the surface, and repaint. */
function applyFrame(frame, { resetMask = false, histogram = true, syncPanel = true } = {}) {
  state.params.frame = cloneFrame(frame);
  // Mirror the frame's straighten angle into the flat parameter map, which
  // is what the panel reads and what the export path copies.
  state.params.straighten = state.params.frame.straighten;
  engine.refreshSurface(state.params.frame, resetMask);
  if (syncPanel) panel.sync(state.params);
  syncFrameControls();
  needHistogram = histogram;
  scheduleRender({ histogram });
}

function commitFrame(frame, opts) {
  applyFrame(frame, opts);
  pushHistory();
}

function handleAction(id) {
  switch (id) {
    case 'cropMode':
      toggleCropMode();
      break;
    case 'rotateLeft':
      rotateQuarter(-1);
      break;
    case 'rotateRight':
      rotateQuarter(1);
      break;
    default:
      break;
  }
}

function rotateQuarter(direction) {
  if (!engine.loaded) return;
  const frame = state.params.frame;
  frame.rotation = ((frame.rotation + direction) % 4 + 4) % 4;
  // A quarter turn swaps the print's axes, so an aspect lock may no longer hold.
  const locked = currentAspect();
  if (locked !== 'free') applyAspect(locked, { silent: true });
  commitFrame(frame, { resetMask: true });
  updateFrameReadout();
  repaintCrop();
}

function toggleMirror(axis) {
  if (!engine.loaded) return;
  const frame = state.params.frame;
  frame[axis] = !frame[axis];
  commitFrame(frame, { resetMask: true });
  updateFrameReadout();
  repaintCrop();
}

function applyAspect(aspectId, { silent = false } = {}) {
  if (!engine.loaded) return;
  // The write that keeps the select honest. applyFrame() -> panel.sync() runs
  // after this, so the control reads the value it was just given.
  state.params.aspect = aspectId;

  const ratio = aspectRatio(aspectId, engine.negative);
  const frame = state.params.frame;
  if (ratio) {
    // Fit against the whole negative, keeping the current centre. Fitting
    // against an already-cropped window compounds the reduction.
    frame.crop = fitCropToAspect({ x: 0, y: 0, w: 1, h: 1 }, ratio, engine.negative);
  }
  applyFrame(frame);
  updateFrameReadout();
  // The lock reshapes the window; the overlay has to show it straight away
  // rather than waiting for the next pointer move.
  repaintCrop();
  if (!silent && ratio) toast(`Aspect ${aspectId === 'orig' ? 'original' : aspectId}`, { timeout: 1400 });
}

function resetFrame() {
  if (!engine.loaded) return;
  state.params.aspect = 'free';
  commitFrame(FRAME_DEFAULTS, { resetMask: true });
  updateFrameReadout();
}

/**
 * Push frame state into every control that can change it. There are three
 * places (panel toggle, panel action, toolbar button) and they all have to
 * agree, otherwise a button keeps looking "on" after a reset.
 */
function syncFrameControls() {
  const frame = state.params.frame;
  const flipBtn = $('#flipBtn');
  if (flipBtn) flipBtn.setAttribute('aria-pressed', String(!!frame.flipH));
  const flipVBtn = $('#flipVBtn');
  if (flipVBtn) flipVBtn.setAttribute('aria-pressed', String(!!frame.flipV));
  syncCropAction();
  const rotateBadge = $('#rotateBadge');
  if (rotateBadge) {
    rotateBadge.textContent = frame.rotation ? `${frame.rotation * 90}°` : '';
    rotateBadge.hidden = !frame.rotation;
  }
}

function updateFrameReadout() {
  syncFrameControls();
  if (!engine.loaded) return;
  const size = frameSize(state.params.frame, engine.negative);
  dimsEl.textContent = `${size.width} × ${size.height}`;
  const mods = [];
  const f = state.params.frame;
  if (!isNeutralFrame(f)) {
    if (f.crop.w < 0.999 || f.crop.h < 0.999) mods.push('cropped');
    if (f.rotation % 4) mods.push(`${f.rotation * 90}°`);
    if (f.flipH) mods.push('mirror H');
    if (f.flipV) mods.push('mirror V');
    if (Math.abs(f.straighten) > 0.05) mods.push(`${f.straighten.toFixed(1)}° tilt`);
  }
  stageBadge.textContent = mods.length
    ? `${PRESET_BY_ID[state.presetId].name} · ${mods.join(' · ')}`
    : PRESET_BY_ID[state.presetId].name + (isModified() ? ' · adjusted' : '');
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

function cloneParams(params) {
  return {
    ...params,
    curvePoints: params.curvePoints ? params.curvePoints.map((pt) => [pt[0], pt[1]]) : CURVE_POINTS.map((pt) => [...pt]),
    frame: cloneFrame(params.frame),
  };
}

function snapshot() {
  return { presetId: state.presetId, aspect: currentAspect(), params: cloneParams(state.params) };
}

function pushHistory() {
  const snap = snapshot();
  const current = history.stack[history.index];
  if (current && JSON.stringify(current) === JSON.stringify(snap)) return;

  history.stack.length = history.index + 1;
  history.stack.push(snap);
  if (history.stack.length > 60) history.stack.shift();
  history.index = history.stack.length - 1;
  updateHistoryButtons();
}

function restoreSnap(snap) {
  state.presetId = snap.presetId;
  state.params = cloneParams(snap.params);
  // Older snapshots kept the lock on the snapshot rather than in params.
  if (state.params.aspect === undefined) state.params.aspect = snap.aspect || 'free';
  rail.setActive(snap.presetId);
  panel.sync(state.params);
  updateReadout();
  scheduleRender({ histogram: true });
  updateHistoryButtons();
}

function undo() {
  if (history.index <= 0) return;
  history.index--;
  restoreSnap(history.stack[history.index]);
}

function redo() {
  if (history.index >= history.stack.length - 1) return;
  history.index++;
  restoreSnap(history.stack[history.index]);
}

function updateHistoryButtons() {
  $('#undoBtn').disabled = history.index <= 0;
  $('#redoBtn').disabled = history.index >= history.stack.length - 1;
}

/* ------------------------------------------------------------------ */
/* Readouts                                                            */
/* ------------------------------------------------------------------ */

function updateReadout() {
  const preset = PRESET_BY_ID[state.presetId];
  if (!engine.loaded) {
    filmName.textContent = 'No negative loaded';
    filmDetail.textContent = 'Open a photo to begin';
    return;
  }

  const modified = isModified();
  filmName.textContent = preset.name + (modified ? ' *' : '');
  filmDetail.textContent = `${state.fileName} · ${engine.width} × ${engine.height}${
    preset.params.grain >= 60 ? ' · coarse grain' : ''
  }`;
  stageBadge.textContent = preset.name + (modified ? ' · adjusted' : '');
  stageBadge.hidden = false;
}

function isModified() {
  const base = paramsFor(state.presetId);
  // `aspect` now lives in params so the panel can read it, but it is a framing
  // lock rather than part of the look. Counting it would put a "*" on the
  // stock the moment you picked a crop ratio.
  for (const key of Object.keys(base)) {
    if (key === 'aspect') continue;
    if (String(base[key]) !== String(state.params[key])) return true;
  }
  return false;
}

function setStatus(text) {
  statusText.textContent = text;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

let rafId = 0;
let needHistogram = true;

function scheduleRender({ histogram = false } = {}) {
  if (histogram) needHistogram = true;
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    render();
  });
}

function fitScale() {
  const rect = stageFrame.getBoundingClientRect();
  const pad = parseFloat(window.getComputedStyle(stageFrame).paddingLeft) || 26;
  const availW = Math.max(40, rect.width - pad * 2);
  const availH = Math.max(40, rect.height - pad * 2);
  const w = engine.surfaceW || 1;
  const h = engine.surfaceH || 1;
  return Math.min(availW / w, availH / h);
}

function layoutView() {
  if (!engine.loaded) return;

  const fit = fitScale();
  const factor = state.view.zoom === 'fit' ? 1 : state.view.zoom;
  // Cropping shows the whole negative, so the print box is the frame's full
  // extent rather than the current crop.
  const box = state.cropMode
    ? frameSize({ ...state.params.frame, crop: { x: 0, y: 0, w: 1, h: 1 } }, engine.negative)
    : null;
  const srcW = box ? box.width : engine.surfaceW;
  const srcH = box ? box.height : engine.surfaceH;
  const cssW = Math.max(24, Math.round(srcW * fit * factor));
  const cssH = Math.max(24, Math.round(srcH * fit * factor));

  view.style.width = `${cssW}px`;
  view.style.height = `${cssH}px`;
  view.style.transform = `translate(${state.view.panX}px, ${state.view.panY}px)`;

  // Backing store: device pixels, capped so huge zoom levels stay fast.
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cap = state.drafting ? 1100 : 2600;
  let bw = Math.round(cssW * dpr);
  let bh = Math.round(cssH * dpr);
  const longEdge = Math.max(bw, bh);
  if (longEdge > cap) {
    const s = cap / longEdge;
    bw = Math.round(bw * s);
    bh = Math.round(bh * s);
  }
  bw = Math.max(1, bw);
  bh = Math.max(1, bh);

  if (view.width !== bw || view.height !== bh) {
    view.width = bw;
    view.height = bh;
  }

  zoomValue.textContent = state.view.zoom === 'fit' ? 'Fit' : `${Math.round(state.view.zoom * 100)}%`;
}

function render() {
  if (!engine.loaded) return;

  layoutView();

  const w = view.width;
  const h = view.height;

  if (state.compare) {
    // Straight from the negative, untouched.
    vctx.clearRect(0, 0, w, h);
    vctx.imageSmoothingQuality = 'high';
    vctx.drawImage(engine.surface, 0, 0, w, h);
  } else if (state.cropMode) {
    // Cropping needs the whole photograph, not the already-cropped print:
    // you cannot pull the window outwards if everything outside it has been
    // thrown away. Developing from the ORIGINAL negative with a full-frame
    // crop is what makes that possible — blitting the cropped surface into a
    // larger box would just stretch it, which is precisely the bug reported.
    engine.develop(vctx, w, h, cropPreviewParams(), { source: engine.source });
  } else {
    engine.develop(vctx, w, h, state.params);
  }

  if (needHistogram) {
    needHistogram = false;
    drawHistogram(histogramCanvas, engine.histogram(state.params), state.params);
  }

  // The overlay is positioned in stage coordinates, so it has to follow every
  // relayout — otherwise it drifts away from the print.
  if (state.cropMode) repaintCrop();
}

/** Parameters for the crop-mode preview: same look, no crop applied. */
function cropPreviewParams() {
  return {
    ...state.params,
    // The mask is painted against the print, so it cannot be aligned to a
    // full-frame view; leaving it out keeps the preview honest.
    maskAmount: 0,
    frame: { ...state.params.frame, crop: { x: 0, y: 0, w: 1, h: 1 } },
  };
}

/* ------------------------------------------------------------------ */
/* Loading a negative                                                  */
/* ------------------------------------------------------------------ */

async function loadFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    toast('That file is not an image');
    return;
  }

  setStatus(`Reading ${file.name}…`);

  const url = URL.createObjectURL(file);
  try {
    const img = await decodeImage(url);
    adoptImage(img, file.name);
    state.sampleIndex = -1;
  } catch (error) {
    console.error(error);
    toast('Could not open that image');
    setStatus('Ready');
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadSample(index = null) {
  const next = index ?? (state.sampleIndex + 1) % SAMPLES.length;
  const sample = SAMPLES[next];

  setStatus(`Loading ${sample.label.toLowerCase()}…`);

  try {
    const img = await decodeImage(sample.src);
    state.sampleIndex = next;
    adoptImage(img, sample.src.split('/').pop());
  } catch (error) {
    console.error(error);
    toast('Sample image unavailable');
    setStatus('Ready');
  }
}

function decodeImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}

function adoptImage(img, name) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;

  if (!w || !h) {
    toast('That image appears to be empty');
    return;
  }

  state.params.frame = cloneFrame(FRAME_DEFAULTS);
  state.params.aspect = 'free';
  if (state.cropMode) toggleCropMode(false);
  engine.load(img, w, h, state.params.frame);
  state.hasAlpha = engine.detectAlpha();
  state.fileName = name;
  state.view = { zoom: 'fit', panX: 0, panY: 0 };

  emptyState.hidden = true;
  view.hidden = false;
  stageFrame.classList.toggle('transparent', state.hasAlpha);

  dimsEl.textContent = `${frameSize(state.params.frame, engine.negative).width} × ${
    frameSize(state.params.frame, engine.negative).height
  }`;
  panel.setEnabled(true);
  panel.sync(state.params);
  needHistogram = true;

  layoutView();
  render();
  updateReadout();

  // Start a fresh history for the new negative.
  history.stack = [snapshot()];
  history.index = 0;
  updateHistoryButtons();

  setStatus(`${name} · ${w} × ${h} · ${PRESET_BY_ID[state.presetId].name}`);
  toast(`Opened ${name}`, { timeout: 2000 });
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

const exportModal = $('#exportModal');
const exportCanvas = $('#exportPreview');
const exportMeta = $('#exportMeta');
const exportFormat = $('#exportFormat');
const exportSize = $('#exportSize');
const exportQuality = $('#exportQuality');
const exportName = $('#exportName');
const exportQualityField = $('#qualityField');

function openExport() {
  if (!engine.loaded) {
    toast('Open a photo first');
    return;
  }

  const base = state.fileName.replace(/\.[^.]+$/, '') || 'noir';
  const preset = PRESET_BY_ID[state.presetId];
  const slug = preset.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  exportName.value = `${base}-${slug}-noir`;

  updateExportPreview();
  modals.openModal(exportModal);
}

function exportDimensions() {
  // The file is the *print*, not the negative, so crop and rotation count.
  const size = frameSize(state.params.frame, engine.negative);
  const target = Number(exportSize.value);
  const long = Math.max(size.width, size.height);
  if (!target || target >= long) return { w: size.width, h: size.height };
  const s = target / long;
  return { w: Math.max(1, Math.round(size.width * s)), h: Math.max(1, Math.round(size.height * s)) };
}

function updateExportPreview() {
  if (!engine.loaded) return;

  const { w, h } = exportDimensions();
  const scale = Math.min(1, 320 / Math.max(w, h));
  const pw = Math.max(1, Math.round(w * scale));
  const ph = Math.max(1, Math.round(h * scale));

  exportCanvas.width = pw;
  exportCanvas.height = ph;
  const pctx = exportCanvas.getContext('2d');

  // Develop from the full-resolution negative so the preview matches the file.
  engine.develop(pctx, pw, ph, state.params, { source: engine.source });

  exportMeta.textContent = `${w} × ${h} · ${exportFormat.value.split('/')[1].toUpperCase()}`;
  exportQualityField.style.display = exportFormat.value === 'image/png' ? 'none' : '';
}

async function doExport() {
  if (!engine.loaded) return;

  const button = $('#doExportBtn');
  button.disabled = true;
  button.textContent = 'Developing…';

  try {
    const { w, h } = exportDimensions();
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const octx = out.getContext('2d');

    const mime = exportFormat.value;
    if (mime === 'image/jpeg') {
      octx.fillStyle = '#0a0a0b';
      octx.fillRect(0, 0, w, h);
    }

    engine.develop(octx, w, h, state.params, { source: engine.source });

    const quality = Number(exportQuality.value) / 100;
    const blob = await new Promise((resolve) =>
      out.toBlob(resolve, mime, mime === 'image/png' ? undefined : quality)
    );

    if (!blob) {
      toast('Export failed — try a smaller size');
      return;
    }

    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    const name = (exportName.value.trim() || 'noir') + '.' + ext;
    downloadBlob(blob, name);

    toast(`Exported ${name} · ${formatBytes(blob.size)}`, { accent: true, timeout: 3400 });
    setStatus(`Exported ${name} · ${w} × ${h} · ${formatBytes(blob.size)}`);
    modals.closeModal(exportModal);
  } catch (error) {
    console.error(error);
    toast('Export failed');
  } finally {
    button.disabled = false;
    button.textContent = 'Download';
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ */
/* Zoom                                                                */
/* ------------------------------------------------------------------ */

const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6, 8];

function zoomBy(direction) {
  const current = state.view.zoom === 'fit' ? 1 : state.view.zoom;
  let index = ZOOM_STEPS.findIndex((z) => z >= current - 0.001);
  if (index < 0) index = ZOOM_STEPS.length - 1;

  index = Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction));
  state.view.zoom = ZOOM_STEPS[index] === 1 && direction < 0 ? 'fit' : ZOOM_STEPS[index];
  if (state.view.zoom === 'fit') {
    state.view.panX = 0;
    state.view.panY = 0;
  }
  layoutView();
}

function zoomFit() {
  state.view = { zoom: 'fit', panX: 0, panY: 0 };
  layoutView();
}

/* ------------------------------------------------------------------ */
/* Crop overlay                                                        */
/* ------------------------------------------------------------------ */

const cropLayer = $('#cropLayer');

function toggleCropMode(force) {
  if (!engine.loaded) {
    toast('Open a photo first');
    return;
  }
  state.cropMode = force === undefined ? !state.cropMode : !!force;
  if (state.cropMode) {
    // Remembered so Escape can back out of a drag that was already applied
    // to the live preview.
    cropEntry = cloneFrame(state.params.frame).crop;
    // Painting and cropping compete for the pointer; brush wins only when
    // explicitly requested, so leave it here.
    if (state.brush) { state.brush = false; updateBrushUi(); }
    cropLayer.hidden = false;
    stageFrame.classList.add('cropping');
    setStatus('Crop · drag the frame, then press Enter to apply or Esc to cancel');
    buildCropHandles();
    // Build the chrome, then immediately place it. Without this the frame
    // sits at zero size in the stage corner until the first pointer move.
    scheduleRender();
    requestAnimationFrame(repaintCrop);
  } else {
    cropEntry = null;
    cropLayer.hidden = true;
    cropLayer.innerHTML = '';
    stageFrame.classList.remove('cropping');
    setStatus('Ready');
    // Leaving crop mode returns the view to the cropped print.
    scheduleRender();
  }
  updateCropButton();
}

let cropEntry = null;

/** Escape: put the crop window back to where it was when the tool opened. */
function cancelCrop() {
  const restore = cropEntry;
  toggleCropMode(false);
  if (!restore) return;
  const frame = state.params.frame;
  frame.crop = restore;
  applyFrame(frame);
  updateFrameReadout();
  toast('Crop cancelled', { timeout: 1400 });
}

function updateCropButton() {
  syncCropAction();
}

let cropBtnState = null;

// The crop control lives in the panel (as an action row) and in the toolbar;
// both must reflect the same mode.
function syncCropAction() {
  const row = panel.rows.get('cropMode');
  if (row && row.button) row.button.setAttribute('aria-pressed', String(state.cropMode));
  const toolbarBtn = document.querySelector('#cropBtn');
  if (toolbarBtn) toolbarBtn.setAttribute('aria-pressed', String(state.cropMode));
}

const CROP_HANDLES = [
  { id: 'nw', x: 0, y: 0, cursor: 'nwse-resize' },
  { id: 'n', x: 0.5, y: 0, cursor: 'ns-resize' },
  { id: 'ne', x: 1, y: 0, cursor: 'nesw-resize' },
  { id: 'e', x: 1, y: 0.5, cursor: 'ew-resize' },
  { id: 'se', x: 1, y: 1, cursor: 'nwse-resize' },
  { id: 's', x: 0.5, y: 1, cursor: 'ns-resize' },
  { id: 'sw', x: 0, y: 1, cursor: 'nesw-resize' },
  { id: 'w', x: 0, y: 0.5, cursor: 'ew-resize' },
];

function buildCropHandles() {
  cropLayer.innerHTML = '';

  const shade = ['n', 's', 'e', 'w'].map((side) =>
    el('div', { class: `crop-shade crop-shade-${side}`, 'aria-hidden': 'true' })
  );

  const frame = el('div', { class: 'crop-frame' }, [
    el('div', { class: 'crop-thirds', 'aria-hidden': 'true' }),
    el('div', { class: 'crop-label', 'aria-hidden': 'true' }),
  ]);

  for (const h of CROP_HANDLES) {
    const handle = el('div', {
      class: `crop-handle crop-handle-${h.id}`,
      dataset: { handle: h.id },
      'aria-hidden': 'true',
    });
    handle.style.cursor = h.cursor;
    frame.append(handle);
  }

  cropLayer.append(...shade, frame);

  // Drag the body to move the window; drag a handle to resize it.
  frame.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('[data-handle]');
    startCropDrag(event, handle ? handle.dataset.handle : 'move');
  });
}

let cropDrag = null;

/**
 * The pixel rectangle of the print inside the stage. Everything in the crop
 * overlay is expressed relative to this, so the frame and the photograph
 * cannot drift apart.
 */
function printRect() {
  const stageRect = stageFrame.getBoundingClientRect();
  const viewRect = view.getBoundingClientRect();
  return {
    stage: stageRect,
    left: viewRect.left - stageRect.left,
    top: viewRect.top - stageRect.top,
    width: viewRect.width,
    height: viewRect.height,
  };
}

/**
 * The frame with only its orientation kept (turn + mirrors + straighten).
 * In crop mode the print on screen is the WHOLE negative, so rectangles are
 * mapped through orientation alone. Mapping through the crop as well would
 * divide the window by itself and pin it to the full frame — which is
 * exactly why the frame used to sit outside the photograph.
 */
function orientationOnly(frame) {
  return { ...frame, crop: { x: 0, y: 0, w: 1, h: 1 } };
}

/** The crop window, as a rectangle of the photograph shown in crop mode. */
function currentPrintCrop() {
  return cropToPrintRect(state.params.frame.crop, orientationOnly(state.params.frame));
}

/**
 * Resize the crop window inside the print. `rect` is in print space, where
 * the long edge may be pinned by an aspect lock.
 *
 * The lock is enforced by deriving the missing dimension from the one the
 * pointer actually moved, anchored on the opposite corner, then clamping the
 * whole rectangle back inside the print. Returning a rectangle that still
 * satisfies the ratio matters: the caller re-derives both the crop and the
 * print size from it.
 */
function resizePrintRect(rect, mode, dx, dy, ratio, printRatio) {
  const min = 0.04;
  let { x, y, w, h } = rect;

  if (mode === 'move') {
    return {
      x: Math.min(1 - w, Math.max(0, x + dx)),
      y: Math.min(1 - h, Math.max(0, y + dy)),
      w,
      h,
    };
  }

  const west = mode.includes('w');
  const east = mode.includes('e');
  const north = mode.includes('n');
  const south = mode.includes('s');

  // Grow or shrink along each axis the pointer is actively dragging.
  if (west) {
    const nx = Math.min(x + w - min, Math.max(0, x + dx));
    w = x + w - nx;
    x = nx;
  }
  if (east) {
    w = Math.min(1 - x, Math.max(min, w + dx));
  }
  if (north) {
    const ny = Math.min(y + h - min, Math.max(0, y + dy));
    h = y + h - ny;
    y = ny;
  }
  if (south) {
    h = Math.min(1 - y, Math.max(min, h + dy));
  }

  if (ratio) {
    // The ratio is in PIXELS, while w and h here are fractions of a print
    // that is not square. Converting once, up front, keeps the rest of the
    // maths independent of the photograph's proportions — getting this wrong
    // produced a square in unit space, which is not a square on screen.
    const unit = ratio / (printRatio || 1);
    const horizontalOnly = west || east;
    const verticalOnly = north || south;

    if (horizontalOnly && !verticalOnly) {
      const nh = w / unit;
      if (north) { y = y + h - nh; h = nh; }
      else if (south) { h = nh; }
      else { const cy = y + h / 2; h = nh; y = cy - nh / 2; }
    } else if (verticalOnly && !horizontalOnly) {
      const nw = h * unit;
      if (west) { x = x + w - nw; w = nw; }
      else if (east) { w = nw; }
      else { const cx = x + w / 2; w = nw; x = cx - nw / 2; }
    } else {
      // Corner: keep the corner opposite the dragged one fixed.
      const nw = Math.max(min, w);
      const nh = nw / unit;
      if (north) y = y + h - nh;
      h = nh;
      w = nw;
      if (west) x = x + rect.w - nw;
    }
  }

  // Clamp inside the print without breaking the ratio.
  if (ratio) {
    const unit = ratio / (printRatio || 1);
    if (w > 1) { w = 1; h = w / unit; }
    if (h > 1) { h = 1; w = h * unit; }
  }
  x = Math.max(0, Math.min(1 - w, x));
  y = Math.max(0, Math.min(1 - h, y));
  return { x, y, w, h };
}

function startCropDrag(event, mode) {
  if (!engine.loaded) return;
  event.preventDefault();
  event.stopPropagation();

  const box = printRect();
  cropDrag = {
    mode,
    startX: event.clientX,
    startY: event.clientY,
    box,
    // Work in print space: the overlay lives on the print, while the stored
    // crop is expressed against the negative.
    rect: currentPrintCrop(),
    ratio: aspectRatio(currentAspect(), engine.negative),
    printRatio: box.width / Math.max(1, box.height),
  };
  cropLayer.setPointerCapture(event.pointerId);
  cropLayer.classList.add('dragging');
}

cropLayer.addEventListener('pointermove', (event) => {
  if (!cropDrag) return;
  const { box, rect, mode, ratio, printRatio } = cropDrag;
  if (!box.width || !box.height) return;

  const dx = (event.clientX - cropDrag.startX) / box.width;
  const dy = (event.clientY - cropDrag.startY) / box.height;

  const next = resizePrintRect(rect, mode, dx, dy, ratio, printRatio);
  cropDrag.current = next;
  paintCropRect(next);
});

function endCropDrag() {
  if (!cropDrag) return;
  const next = cropDrag.current;
  cropDrag = null;
  cropLayer.classList.remove('dragging');
  if (!next) return;

  const frame = state.params.frame;
  frame.crop = printRectToCrop(next, orientationOnly(frame));
  // Carry the straighten angle across: it belongs to the frame, and the
  // preview is showing it already.
  applyFrame(frame);
  repaintCrop();
  updateFrameReadout();
}

cropLayer.addEventListener('pointerup', endCropDrag);
cropLayer.addEventListener('pointercancel', endCropDrag);

/** Repaint the overlay from current state. Safe to call at any time. */
function repaintCrop() {
  if (!state.cropMode || !engine.loaded) return;
  paintCropRect(currentPrintCrop());
}

/** Position the crop chrome over the print, given a print-space rectangle. */
function paintCropRect(rect) {
  if (!state.cropMode || !engine.loaded) return;
  const frameEl = cropLayer.querySelector('.crop-frame');
  if (!frameEl) return;

  const box = printRect();
  if (!box.width || !box.height) return;

  const x = box.left + rect.x * box.width;
  const y = box.top + rect.y * box.height;
  const w = rect.w * box.width;
  const h = rect.h * box.height;

  frameEl.style.left = `${x}px`;
  frameEl.style.top = `${y}px`;
  frameEl.style.width = `${w}px`;
  frameEl.style.height = `${h}px`;

  // Shading around the crop, so the discarded area reads as discarded.
  const shades = cropLayer.querySelectorAll('.crop-shade');
  const set = (node, l, t, ww, hh) => {
    node.style.left = `${l}px`;
    node.style.top = `${t}px`;
    node.style.width = `${Math.max(0, ww)}px`;
    node.style.height = `${Math.max(0, hh)}px`;
  };
  set(shades[0], 0, 0, box.stage.width, y);                                   // north
  set(shades[1], 0, y + h, box.stage.width, box.stage.height - (y + h));      // south
  set(shades[2], 0, y, x, h);                                                // west
  set(shades[3], x + w, y, box.stage.width - (x + w), h);                    // east

  // Readout on the frame itself: the aspect is the thing the user is
  // manipulating, so it belongs where the eye already is.
  const label = cropLayer.querySelector('.crop-label');
  if (label) {
    const pxW = Math.round(rect.w * frameSize(
      { ...state.params.frame, crop: { x: 0, y: 0, w: 1, h: 1 } }, engine.negative).width);
    const pxH = Math.round(rect.h * frameSize(
      { ...state.params.frame, crop: { x: 0, y: 0, w: 1, h: 1 } }, engine.negative).height);
    label.textContent = `${pxW} × ${pxH}`;
  }
}

/* ------------------------------------------------------------------ */
/* Brush (local dodge & burn)                                          */
/* ------------------------------------------------------------------ */

const brushBtn = $('#brushBtn');
const eraseBtn = $('#eraseBtn');

function updateBrushUi() {
  brushBtn.classList.toggle('active', state.brush);
  brushBtn.setAttribute('aria-pressed', String(state.brush));
  eraseBtn.classList.toggle('active', state.brush && state.erase);
  stageFrame.classList.toggle('brushing', state.brush);
  stageFrame.classList.toggle('erasing', state.brush && state.erase);
  view.style.cursor = state.brush ? 'none' : '';
  if (state.brush) {
    // Painting only makes sense with the mask panel's strength wired up.
    panel.openGroup('local', true);
  } else {
    hideBrushCursor();
    stageFrame.style.cursor = '';
  }
}

function toggleBrush(force) {
  if (!engine.loaded) {
    toast('Open a photo first');
    return;
  }
  state.brush = force === undefined ? !state.brush : !!force;
  if (!state.brush) state.erase = false;
  updateBrushUi();
  if (state.brush) {
    setStatus(state.erase ? 'Erase mode · paint to clear the mask' : 'Brush mode · paint to dodge or burn');
  } else {
    setStatus('Ready');
    pushHistory();
  }
}

function toggleErase() {
  if (!state.brush) toggleBrush(true);
  state.erase = !state.erase;
  updateBrushUi();
  setStatus(state.erase ? 'Erase mode · paint to clear the mask' : 'Brush mode · paint to dodge or burn');
}

/** Where is the pointer, in normalised negative coordinates? */
function stagePoint(event) {
  const rect = view.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  if (x < -0.02 || x > 1.02 || y < -0.02 || y > 1.02) return null;
  return { x, y };
}

let brushCursor = null;
let lastPointerEvent = null;

function showBrushCursor(event) {
  if (!brushCursor) {
    brushCursor = el('div', { class: 'brush-cursor', 'aria-hidden': 'true' });
    stageFrame.append(brushCursor);
  }
  const size = (state.params.maskSize / 100) * 2 * view.getBoundingClientRect().height;
  brushCursor.style.width = `${size}px`;
  brushCursor.style.height = `${size}px`;
  brushCursor.style.transform = `translate(${event.clientX - stageFrame.getBoundingClientRect().left}px, ${
    event.clientY - stageFrame.getBoundingClientRect().top
  }px) translate(-50%, -50%)`;
  brushCursor.classList.toggle('erasing', state.erase);
  brushCursor.style.opacity = '1';
}

function hideBrushCursor() {
  if (brushCursor) brushCursor.style.opacity = '0';
}

// Brush size follows maskSize (2 … 40 → 2% … 28% of the short edge).
function brushRadius() {
  return Math.max(0.012, (state.params.maskSize / 100) * 0.62);
}

let strokeStarted = false;
let lastDab = null;

function paintAt(event, strength) {
  const point = stagePoint(event);
  if (!point) return;

  const radius = brushRadius();
  const dab = {
    x: point.x,
    y: point.y,
    radius,
    strength,
    erase: state.erase,
  };

  engine.paintDab(dab);

  // Interpolate between dabs so a fast stroke stays continuous.
  if (lastDab) {
    const dx = dab.x - lastDab.x;
    const dy = dab.y - lastDab.y;
    const dist = Math.hypot(dx, dy);
    const step = radius * 0.35;
    const steps = Math.min(40, Math.floor(dist / Math.max(0.001, step)));
    for (let i = 1; i <= steps; i++) {
      engine.paintDab({
        x: lastDab.x + (dx * i) / (steps + 1),
        y: lastDab.y + (dy * i) / (steps + 1),
        radius,
        strength,
        erase: state.erase,
      });
    }
  }

  lastDab = dab;
  state.drafting = true;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { state.drafting = false; scheduleRender(); }, 200);
  scheduleRender({ histogram: true });
}

/* Pan the zoomed view */
let panStart = null;
stageFrame.addEventListener('pointerdown', (event) => {
  if (state.brush && engine.loaded) {
    if (event.button !== 0 && event.button !== 2) return;
    if (event.button === 2) state.erase = true;

    event.preventDefault();
    strokeStarted = true;
    lastDab = null;
    stageFrame.setPointerCapture(event.pointerId);
    // A single tap should register even without movement.
    paintAt(event, 1);
    return;
  }

  if (!engine.loaded || state.view.zoom === 'fit') return;
  if (event.button !== 0) return;
  panStart = { x: event.clientX, y: event.clientY, px: state.view.panX, py: state.view.panY };
  stageFrame.setPointerCapture(event.pointerId);
  stageFrame.style.cursor = 'grabbing';
});

stageFrame.addEventListener('pointermove', (event) => {
  lastPointerEvent = event;
  if (state.brush && engine.loaded) {
    // Holding Alt flips to erase without leaving the stroke.
    if (event.altKey !== state.erase && !eraseBtn.dataset.locked) {
      state.erase = event.altKey;
      updateBrushUi();
    }
    showBrushCursor(event);
    if (strokeStarted) paintAt(event, 0.55);
    return;
  }

  if (!panStart) return;
  state.view.panX = panStart.px + (event.clientX - panStart.x);
  state.view.panY = panStart.py + (event.clientY - panStart.y);
  view.style.transform = `translate(${state.view.panX}px, ${state.view.panY}px)`;
});

function endPan() {
  if (strokeStarted) {
    strokeStarted = false;
    lastDab = null;
    state.drafting = false;
    scheduleRender({ histogram: true });
    pushHistory();
    return;
  }
  if (!panStart) return;
  panStart = null;
  stageFrame.style.cursor = '';
}
stageFrame.addEventListener('pointerup', endPan);
stageFrame.addEventListener('pointercancel', endPan);
stageFrame.addEventListener('pointerleave', () => {
  if (state.brush) hideBrushCursor();
});
stageFrame.addEventListener('contextmenu', (event) => {
  if (state.brush) event.preventDefault();
});

stageFrame.addEventListener(
  'wheel',
  (event) => {
    if (!engine.loaded) return;
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1 : -1);
  },
  { passive: false }
);

/* ------------------------------------------------------------------ */
/* Compare (hold)                                                      */
/* ------------------------------------------------------------------ */

const compareBtn = $('#compareBtn');

function startCompare() {
  if (!engine.loaded || state.compare) return;
  state.compare = true;
  compareBtn.classList.add('active');
  render();
}

function stopCompare() {
  if (!state.compare) return;
  state.compare = false;
  compareBtn.classList.remove('active');
  render();
}

compareBtn.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  startCompare();
});
compareBtn.addEventListener('pointerup', stopCompare);
compareBtn.addEventListener('pointerleave', stopCompare);
compareBtn.addEventListener('pointercancel', stopCompare);

/* ------------------------------------------------------------------ */
/* File input, drag & drop, paste                                      */
/* ------------------------------------------------------------------ */

$('#openBtn').addEventListener('click', () => fileInput.click());
$('#emptyOpen').addEventListener('click', () => fileInput.click());
$('#sampleBtn').addEventListener('click', () => loadSample());
$('#emptySample').addEventListener('click', () => loadSample());

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = '';
  if (file) loadFile(file);
});

let dragDepth = 0;

window.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) return;
  event.preventDefault();
  dragDepth++;
  dropOverlay.classList.add('active');
});

window.addEventListener('dragover', (event) => {
  if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.remove('active');
});

window.addEventListener('drop', (event) => {
  if (!event.dataTransfer) return;
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove('active');
  const file = Array.from(event.dataTransfer.files || [])[0];
  if (file) loadFile(file);
});

window.addEventListener('paste', (event) => {
  const items = Array.from(event.clipboardData?.items || []);
  const imageItem = items.find((item) => item.type.startsWith('image/'));
  if (!imageItem) return;
  const file = imageItem.getAsFile();
  if (file) {
    event.preventDefault();
    loadFile(file);
  }
});

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

$('#resetBtn').addEventListener('click', resetAll);
$('#panelResetBtn').addEventListener('click', resetAll);
$('#exportBtn').addEventListener('click', openExport);
$('#exportBtn2').addEventListener('click', openExport);
$('#zoomIn').addEventListener('click', () => zoomBy(1));
$('#zoomOut').addEventListener('click', () => zoomBy(-1));
$('#undoBtn').addEventListener('click', undo);
$('#redoBtn').addEventListener('click', redo);
$('#shortcutsBtn').addEventListener('click', () => modals.openModal($('#shortcutsModal')));
$('#themeBtn').addEventListener('click', toggleTheme);
brushBtn.addEventListener('click', () => toggleBrush());
eraseBtn.addEventListener('click', () => toggleErase());

$('#cropBtn').addEventListener('click', () => toggleCropMode());
$('#rotateLeftBtn').addEventListener('click', () => rotateQuarter(-1));
$('#rotateRightBtn').addEventListener('click', () => rotateQuarter(1));
$('#flipBtn').addEventListener('click', () => toggleMirror('flipH'));

exportFormat.addEventListener('change', updateExportPreview);
exportSize.addEventListener('change', updateExportPreview);
exportQuality.addEventListener('input', () => {
  $('#qualityValue').textContent = exportQuality.value;
});
$('#doExportBtn').addEventListener('click', doExport);

/* ------------------------------------------------------------------ */
/* Batch develop                                                       */
/* ------------------------------------------------------------------ */

const batch = new BatchJob();
const batchModal = $('#batchModal');
const batchList = $('#batchList');
const batchInput = $('#batchInput');
const batchRunBtn = $('#batchRunBtn');
const batchZipBtn = $('#batchZipBtn');
const batchCancelBtn = $('#batchCancelBtn');
const batchProgress = $('#batchProgress');
const batchBarFill = $('#batchBarFill');
const batchStatusText = $('#batchStatus');
const batchFormat = $('#batchFormat');
const batchSize = $('#batchSize');
const batchQuality = $('#batchQuality');
const batchQualityField = $('#batchQualityField');
const batchDrop = $('#batchDrop');

const STATUS_LABEL = {
  queued: 'queued',
  working: 'developing…',
  done: 'done',
  error: 'failed',
};

function openBatch() {
  if (engine.loaded) batch.setReference(engine.negative.width, engine.negative.height);
  renderBatchList();
  modals.openModal(batchModal);
}

function addToBatch(files) {
  let added = 0;
  for (const file of files) {
    if (batch.add(file)) added++;
  }
  if (added) {
    renderBatchList();
    toast(added === 1 ? '1 photo queued' : `${added} photos queued`, { timeout: 1500 });
  } else {
    toast('No images in that selection');
  }
}

function renderBatchList() {
  batchList.innerHTML = '';

  for (const item of batch.items) {
    const thumb = el('img', { class: 'batch-item-thumb', alt: '', loading: 'lazy' });
    thumb.src = item.thumb || URL.createObjectURL(item.file);
    if (!item.thumb) item.thumb = thumb.src;

    const row = el('li', { class: 'batch-item', dataset: { status: item.status } }, [
      thumb,
      el('span', { class: 'batch-item-name', text: item.name, title: item.name }),
      el('span', { class: 'batch-item-status', text: STATUS_LABEL[item.status] || item.status }),
      el('button', {
        class: 'batch-item-remove',
        type: 'button',
        text: '✕',
        'aria-label': `Remove ${item.name}`,
        onclick: () => {
          batch.remove(item.id);
          renderBatchList();
        },
      }),
    ]);
    batchList.append(row);
  }

  const preset = PRESET_BY_ID[state.presetId];
  const recipe = $('#batchRecipe');
  recipe.innerHTML = '';
  recipe.append(document.createTextNode('Recipe: '));
  recipe.append(el('strong', { text: preset.name + (isModified() ? ' *' : '') }));

  const pending = batch.pending;
  batchRunBtn.disabled = pending === 0 || batch.running;
  batchRunBtn.textContent = batch.running ? 'Developing…' : pending ? `Develop ${pending}` : 'Develop all';
  batchZipBtn.disabled = batch.done === 0 || batch.running;
  batchZipBtn.textContent = batch.done ? `Download ZIP (${batch.done})` : 'Download ZIP';
  updateBatchQualityField();
}

function updateBatchQualityField() {
  batchQualityField.style.display = batchFormat.value === 'image/png' ? 'none' : '';
}

async function runBatch() {
  if (batch.running || batch.pending === 0) return;

  batchRunBtn.disabled = true;
  batchCancelBtn.hidden = false;
  batchProgress.hidden = false;
  batchBarFill.style.width = '0%';

  const params = cloneParams(state.params);

  const results = await batch.run(params, {
    format: batchFormat.value,
    quality: Number(batchQuality.value) / 100,
    longEdge: Number(batchSize.value),
    onProgress: ({ index, total }) => {
      const pct = total ? (index / total) * 100 : 0;
      batchBarFill.style.width = `${pct.toFixed(1)}%`;
      batchStatusText.textContent = `${index} / ${total}`;
      renderBatchList();
    },
  });

  batchCancelBtn.hidden = true;
  batchProgress.hidden = false;
  batchBarFill.style.width = '100%';
  batchStatusText.textContent = batch.cancelled ? 'stopped' : `${results.length} developed`;
  renderBatchList();

  const failed = batch.items.filter((i) => i.status === 'error').length;
  if (results.length) {
    toast(
      failed ? `${results.length} developed · ${failed} failed` : `${results.length} photos developed`,
      { accent: true, timeout: 2600 }
    );
  }
}

async function downloadBatchZip() {
  if (batch.done === 0) return;
  batchZipBtn.disabled = true;
  const label = batchZipBtn.textContent;
  batchZipBtn.textContent = 'Packing…';

  try {
    const bytes = await batch.archive('noir-batch', batchFormat.value);
    const stem = PRESET_BY_ID[state.presetId].name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const name = `noir-batch-${stem}-${new Date().toISOString().slice(0, 10)}.zip`;
    downloadBlob(new Blob([bytes], { type: 'application/zip' }), name);
    toast(`Packaged ${batch.done} files · ${formatBytes(bytes.length)}`, { accent: true, timeout: 3000 });
  } catch (error) {
    console.error(error);
    toast('Could not build the archive');
  } finally {
    batchZipBtn.textContent = label;
    renderBatchList();
  }
}

$('#batchBtn').addEventListener('click', openBatch);
$('#batchAddBtn').addEventListener('click', () => batchInput.click());
$('#batchSampleBtn').addEventListener('click', async () => {
  batchSampleBtnBusy(true);
  try {
    for (const sample of SAMPLES) {
      const img = await decodeImage(sample.src);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
      if (!blob) throw new Error('could not encode the sample');
      const name = sample.src.split('/').pop();
      // File is nicer, but Blob keeps this working where File is unavailable.
      const entry = typeof File === 'function'
        ? new File([blob], name, { type: 'image/jpeg' })
        : Object.assign(blob, { name });
      addToBatch([entry]);
    }
  } catch (error) {
    console.error(error);
    toast('Could not load the samples');
  } finally {
    batchSampleBtnBusy(false);
  }
});

function batchSampleBtnBusy(busy) {
  const btn = $('#batchSampleBtn');
  btn.disabled = busy;
  btn.textContent = busy ? 'Loading…' : 'Add samples';
}

$('#batchClearBtn').addEventListener('click', () => {
  batch.clear();
  batchProgress.hidden = true;
  renderBatchList();
});

batchInput.addEventListener('change', () => {
  addToBatch(Array.from(batchInput.files || []));
  batchInput.value = '';
});

batchRunBtn.addEventListener('click', runBatch);
batchZipBtn.addEventListener('click', downloadBatchZip);
batchCancelBtn.addEventListener('click', () => batch.cancel());
batchFormat.addEventListener('change', renderBatchList);
batchSize.addEventListener('change', renderBatchList);
batchQuality.addEventListener('input', () => {
  $('#batchQualityValue').textContent = batchQuality.value;
});

// Drag & drop straight onto the dialog.
let batchDrag = 0;
batchDrop.addEventListener('dragenter', (event) => {
  event.preventDefault();
  batchDrag++;
  batchDrop.classList.add('active');
});
batchDrop.addEventListener('dragover', (event) => event.preventDefault());
batchDrop.addEventListener('dragleave', () => {
  batchDrag = Math.max(0, batchDrag - 1);
  if (!batchDrag) batchDrop.classList.remove('active');
});
batchDrop.addEventListener('drop', (event) => {
  event.preventDefault();
  event.stopPropagation();
  batchDrag = 0;
  batchDrop.classList.remove('active');
  addToBatch(Array.from(event.dataTransfer?.files || []));
});

// While the batch dialog is open, drops belong to it, not the editor.
batchModal.addEventListener('dragover', (event) => event.preventDefault());
batchModal.addEventListener('drop', (event) => event.stopPropagation());

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

const TYPING = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (modals.closeTop()) return;
    // Crop mode comes first: it has its own meaning for Escape (revert the
    // window), and the generic handler must not swallow it.
    if (state.cropMode) { event.preventDefault(); cancelCrop(); return; }
    if (state.brush) { toggleBrush(false); return; }
    stopCompare();
    return;
  }

  if (TYPING.has(event.target.tagName) || modals.isOpen) return;

  const mod = event.metaKey || event.ctrlKey;

  if (mod && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }

  if (mod || event.altKey) return;

  // Crop mode owns Enter and Escape.
  if (state.cropMode) {
    if (event.key === 'Enter') { event.preventDefault(); toggleCropMode(false); return; }
    if (event.key === 'Escape') { event.preventDefault(); cancelCrop(); return; }
    return;
  }

  switch (event.key) {
    case 't': case 'T':
      event.preventDefault();
      toggleTheme();
      break;
    case 'c': case 'C':
      event.preventDefault();
      toggleCropMode();
      break;
    case 'm': case 'M':
      event.preventDefault();
      toggleMirror('flipH');
      break;
    case '[':
      if (event.shiftKey) { event.preventDefault(); rotateQuarter(-1); }
      else setParam('maskSize', Math.max(2, state.params.maskSize - 2));
      break;
    case ']':
      if (event.shiftKey) { event.preventDefault(); rotateQuarter(1); }
      else setParam('maskSize', Math.min(40, state.params.maskSize + 2));
      break;
    case 'b': case 'B':
      event.preventDefault();
      if (event.shiftKey) openBatch();
      else toggleBrush();
      break;
    case 'o': case 'O':
      event.preventDefault();
      fileInput.click();
      break;
    case 'e': case 'E':
      event.preventDefault();
      openExport();
      break;
    case 'r': case 'R':
      event.preventDefault();
      resetAll();
      break;
    case '\\':
      event.preventDefault();
      startCompare();
      break;
    case '+': case '=':
      zoomBy(1);
      break;
    case '-': case '_':
      zoomBy(-1);
      break;
    case '0':
      zoomFit();
      break;
    case '?':
      modals.openModal($('#shortcutsModal'));
      break;
    case 'ArrowRight': {
      const i = ALL_PRESETS.findIndex((p) => p.id === state.presetId);
      applyPreset(ALL_PRESETS[(i + 1) % ALL_PRESETS.length].id, true);
      break;
    }
    case 'ArrowLeft': {
      const i = ALL_PRESETS.findIndex((p) => p.id === state.presetId);
      applyPreset(ALL_PRESETS[(i - 1 + ALL_PRESETS.length) % ALL_PRESETS.length].id, true);
      break;
    }
    default: {
      const preset = ALL_PRESETS.find((p) => p.key === event.key);
      if (preset) applyPreset(preset.id, true);
    }
  }
});

window.addEventListener('keyup', (event) => {
  if (event.key === '\\') stopCompare();
});

/* ------------------------------------------------------------------ */
/* Resize                                                              */
/* ------------------------------------------------------------------ */

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!engine.loaded) return;
    layoutView();
    render();
    repaintCrop();
  }, 120);
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function boot() {
  if (!SUPPORTS_FILTER) {
    // Clarity/halation degrade gracefully; everything else still works.
    console.info('Canvas filters unavailable — clarity and halation disabled.');
  }

  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && PRESET_BY_ID[saved]) {
    setPresetSilently(saved);
  } else {
    setPresetSilently(state.presetId);
  }

  applyTheme(resolveTheme(), { persist: false });

  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      let saved = null;
      try { saved = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
      if (!saved) applyTheme(mq.matches ? 'light' : 'dark', { persist: false });
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
  }

  panel.sync(state.params);
  rail.setActive(state.presetId);
  updateHistoryButtons();
  setStatus('Ready · drag a photo anywhere to begin');

  // Warm the sample decode so the first click feels instant.
  decodeImage(SAMPLES[0].src).catch(() => {});
}

// Remember the chosen stock between visits.
window.addEventListener('beforeunload', () => {
  try {
    localStorage.setItem(STORAGE_KEY, state.presetId);
  } catch { /* private mode */ }
});

// A read-only handle for tests and for debugging from the console. It is
// deliberately not used by any UI code path.
export const debug = {
  get state() { return state; },
  get preset() { return PRESET_BY_ID[state.presetId]; },
  get engine() { return engine; },
  get history() { return history; },
  get batch() { return batch; },
  get frame() { return state.params.frame; },
  get printSize() {
    return engine.loaded ? frameSize(state.params.frame, engine.negative) : null;
  },
};

boot();
