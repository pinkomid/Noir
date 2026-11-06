/**
 * NOIR Photo Studio — application
 * ------------------------------------------------------------
 * Owns the state (negative, parameters, history, view) and wires the
 * DOM to the development engine.
 */

import { Darkroom, SUPPORTS_FILTER } from './engine.js';
import { PRESETS, PRESET_BY_ID, paramsFor } from './presets.js';
import { DEFAULTS as CONTROL_DEFAULTS } from './controls.js';
import {
  $, buildPresetRail, buildPanel, drawHistogram,
  initToasts, toast, initModals,
} from './ui.js';

const SAMPLE_THUMB = 'assets/sample-portrait.jpg';
const SAMPLES = [
  { src: 'assets/sample-portrait.jpg', label: 'Sample portrait' },
  { src: 'assets/sample-architecture.jpg', label: 'Sample architecture' },
];

const STORAGE_KEY = 'noir.preset';

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
};

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
    state.params[id] = value;

    // While a slider is being dragged, render a lighter copy so the
    // preview keeps up; the full-quality pass lands on release.
    state.drafting = !commit;
    clearTimeout(draftTimer);
    if (!commit) draftTimer = setTimeout(() => { state.drafting = false; scheduleRender(); }, 220);

    scheduleRender();
    panel.sync(state.params);
    if (commit) pushHistory();
  },
  onReset: (id) => {
    setParam(id, CONTROL_DEFAULTS[id], true);
  },
});

const rail = buildPresetRail($('#presetList'), PRESETS, SAMPLE_THUMB, (id) => applyPreset(id, true));

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

function setPresetSilently(id) {
  state.presetId = id;
  state.params = paramsFor(id);
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

  scheduleRender({ histogram: true });
  if (commit) pushHistory();

  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch { /* private mode */ }

  toast(`Loaded ${preset.name}`, { accent: true, timeout: 1600 });
}

function resetAll() {
  setPresetSilently(PRESETS[0].id);
  state.params = { ...paramsFor(PRESETS[0].id) };
  panel.sync(state.params);
  scheduleRender({ histogram: true });
  pushHistory();
  toast('Adjustments reset');
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

function snapshot() {
  return { presetId: state.presetId, params: { ...state.params } };
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
  state.params = { ...snap.params };
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
  for (const key of Object.keys(base)) {
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
  const cssW = Math.max(24, Math.round(engine.surfaceW * fit * factor));
  const cssH = Math.max(24, Math.round(engine.surfaceH * fit * factor));

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
  } else {
    engine.develop(vctx, w, h, state.params);
  }

  if (needHistogram) {
    needHistogram = false;
    drawHistogram(histogramCanvas, engine.histogram(state.params), state.params);
  }
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

  engine.load(img, w, h);
  state.hasAlpha = engine.detectAlpha();
  state.fileName = name;
  state.view = { zoom: 'fit', panX: 0, panY: 0 };

  emptyState.hidden = true;
  view.hidden = false;
  stageFrame.classList.toggle('transparent', state.hasAlpha);

  dimsEl.textContent = `${w} × ${h}`;
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
  const target = Number(exportSize.value);
  const long = Math.max(engine.width, engine.height);
  if (!target || target >= long) return { w: engine.width, h: engine.height };
  const s = target / long;
  return { w: Math.max(1, Math.round(engine.width * s)), h: Math.max(1, Math.round(engine.height * s)) };
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

/* Pan the zoomed view */
let panStart = null;
stageFrame.addEventListener('pointerdown', (event) => {
  if (!engine.loaded || state.view.zoom === 'fit') return;
  if (event.button !== 0) return;
  panStart = { x: event.clientX, y: event.clientY, px: state.view.panX, py: state.view.panY };
  stageFrame.setPointerCapture(event.pointerId);
  stageFrame.style.cursor = 'grabbing';
});

stageFrame.addEventListener('pointermove', (event) => {
  if (!panStart) return;
  state.view.panX = panStart.px + (event.clientX - panStart.x);
  state.view.panY = panStart.py + (event.clientY - panStart.y);
  view.style.transform = `translate(${state.view.panX}px, ${state.view.panY}px)`;
});

function endPan() {
  if (!panStart) return;
  panStart = null;
  stageFrame.style.cursor = '';
}
stageFrame.addEventListener('pointerup', endPan);
stageFrame.addEventListener('pointercancel', endPan);

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

exportFormat.addEventListener('change', updateExportPreview);
exportSize.addEventListener('change', updateExportPreview);
exportQuality.addEventListener('input', () => {
  $('#qualityValue').textContent = exportQuality.value;
});
$('#doExportBtn').addEventListener('click', doExport);

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

const TYPING = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    modals.closeTop();
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

  switch (event.key) {
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
      const i = PRESETS.findIndex((p) => p.id === state.presetId);
      applyPreset(PRESETS[(i + 1) % PRESETS.length].id, true);
      break;
    }
    case 'ArrowLeft': {
      const i = PRESETS.findIndex((p) => p.id === state.presetId);
      applyPreset(PRESETS[(i - 1 + PRESETS.length) % PRESETS.length].id, true);
      break;
    }
    default: {
      const preset = PRESETS.find((p) => p.key === event.key);
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

boot();
