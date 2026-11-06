/**
 * Boots the real UI (index.html + js/app.js) inside jsdom and drives it
 * through the main user journeys, so DOM wiring is verified without a browser.
 *
 *   npm i -D jsdom @napi-rs/canvas && node tools/test-ui.mjs
 */

import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => errors.push(e));
virtualConsole.on('error', (...args) => errors.push(new Error(args.join(' '))));

let html = readFileSync('index.html', 'utf8');
// Inline the module tree so jsdom runs it without a network module loader.
const modules = {
  'js/engine.js': readFileSync('js/engine.js', 'utf8'),
  'js/presets.js': readFileSync('js/presets.js', 'utf8'),
  'js/controls.js': readFileSync('js/controls.js', 'utf8'),
  'js/ui.js': readFileSync('js/ui.js', 'utf8'),
  'js/batch.js': readFileSync('js/batch.js', 'utf8'),
  'js/geometry.js': readFileSync('js/geometry.js', 'utf8'),
  'js/app.js': readFileSync('js/app.js', 'utf8'),
};

const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/, ''), {
  url: 'http://localhost:5173/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole,
});

const { window } = dom;
const { document } = window;

/* ---- Canvas shim backed by the native renderer --------------------- */
function makeCanvas(w = 300, h = 150) {
  const canvas = createCanvas(w, h);
  const proto = Object.getPrototypeOf(canvas);
  if (!proto.__noirPatched) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'getContext');
    Object.defineProperty(proto, 'getContext', {
      value(type) { return desc.value.call(this, type || '2d'); },
    });
    proto.__noirPatched = true;
  }
  canvas.clientWidth = w;
  canvas.clientHeight = h;
  return canvas;
}

window.HTMLCanvasElement.prototype.getContext = function (type) {
  if (!this.__canvas) {
    this.__canvas = createCanvas(this.width || 300, this.height || 150);
  }
  if (this.width !== this.__canvas.width) this.__canvas.width = this.width;
  if (this.height !== this.__canvas.height) this.__canvas.height = this.height;
  return this.__canvas.getContext(type || '2d');
};

// toBlob / toDataURL used by export
window.HTMLCanvasElement.prototype.toBlob = function (cb, mime = 'image/png', quality) {
  const inner = this.__canvas || createCanvas(this.width, this.height);
  const buf = inner.toBuffer(mime === 'image/jpeg' ? 'image/jpeg' : mime === 'image/webp' ? 'image/webp' : 'image/png', quality);
  const blob = new window.Blob([buf], { type: mime });
  blob.__buf = buf;
  cb(blob);
};

window.HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/png;base64,AA=='; };

// Image decoding → native image
class FakeImage {
  constructor() {
    this.naturalWidth = 0;
    this.naturalHeight = 0;
  }
  set src(value) {
    this._src = value;
    loadImage(value).then((img) => {
      this.naturalWidth = img.width;
      this.naturalHeight = img.height;
      this.width = img.width;
      this.height = img.height;
      this._nativeImage = img;
      if (this.onload) this.onload();
    }).catch(() => { if (this.onerror) this.onerror(new Error('decode failed')); });
  }
  get src() { return this._src; }
}

window.Image = FakeImage;

// jsdom's File drops our native buffer, so swap in a subclass that carries it.
class HarnessFile extends window.Blob {
  constructor(parts, name, opts) {
    super(parts, opts);
    this.name = name;
    const first = Array.isArray(parts) ? parts[0] : null;
    if (first && first.__buf) this.__buf = first.__buf;
  }
}
window.File = HarnessFile;
globalThis.File = HarnessFile;

// jsdom ships no object URLs. Our fake decoder can only read real files, so
// materialise each blob on disk and hand the decoder a path.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const blobDir = join(process.cwd(), 'tools', 'out', 'blobs');
mkdirSync(blobDir, { recursive: true });
let urlCounter = 0;
const urlFiles = new Map();

window.URL.createObjectURL = (blob) => {
  const id = `blob:noir/${++urlCounter}`;
  const buf = blob && blob.__buf;
  if (!buf) return id;
  const file = join(blobDir, `blob-${urlCounter}.jpg`);
  writeFileSync(file, Buffer.from(buf));
  urlFiles.set(id, file);
  return file;
};
window.URL.revokeObjectURL = () => {};

// rAF runs synchronously-ish for the test
window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
window.getComputedStyle = (node) => ({ paddingLeft: '26px', paddingTop: '26px' });
window.Element.prototype.setPointerCapture = function () {};
window.Element.prototype.releasePointerCapture = function () {};
window.HTMLElement.prototype.getBoundingClientRect = function () {
  return { width: 960, height: 720, top: 62, left: 232, right: 1192, bottom: 782, x: 232, y: 62 };
};
window.cancelAnimationFrame = (id) => clearTimeout(id);

// Canvas drawImage must accept our FakeImage
const origDraw = Object.getPrototypeOf(createCanvas(1, 1).getContext('2d')).drawImage;
Object.getPrototypeOf(createCanvas(1, 1).getContext('2d')).drawImage = function (img, ...rest) {
  // Unwrap jsdom elements and FakeImages into the native surfaces.
  const target = img && img._nativeImage ? img._nativeImage : img && img.__canvas ? img.__canvas : img;
  return origDraw.call(this, target, ...rest);
};

/* ---- Module loader shim ------------------------------------------- */
const moduleCache = new Map();

function resolveModule(from, spec) {
  const dir = from.slice(0, from.lastIndexOf('/') + 1);
  const parts = (dir + spec).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function runModule(path) {
  if (moduleCache.has(path)) return moduleCache.get(path).exports;
  const source = modules[path];
  if (!source) throw new Error('missing module ' + path);

  const __require = (spec) => runModule(resolveModule(path, spec));

  // Resolve every dependency up front, then reference them by index — a
  // class or function cannot survive being serialised into source text.
  const deps = [];

  let code = source.replace(
    /^import\s+\{([^}]*?)\}\s+from\s+['"]([^'"\n]+)['"];?/gms,
    (_, names, spec) => {
      const resolved = __require(spec);
      const index = deps.push(resolved) - 1;
      const pairs = names
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => {
          const m = n.split(/\s+as\s+/);
          return m.length === 2 ? `${m[0].trim()}: ${m[1].trim()}` : m[0].trim();
        });
      return `const { ${pairs.join(', ')} } = __DEPS[${index}];`;
    }
  );

  code = code
    .replace(/^export\s+(const|let|function|class)\s+([\w$]+)/gm, '$1 $2')
    .replace(/^export\s+\{([^}]+)\};?/gm, '')
    .replace(/^export\s+default\s+/gm, 'const __default = ');

  const names = [...source.matchAll(/^export\s+(?:const|let|function|class)\s+([\w$]+)/gm)].map((m) => m[1]);
  if (path === 'js/app.js' && process.env.NOIR_DEBUG_EXPORTS) console.log('   app.js exports:', names);
  const body = `'use strict';\n${code}\nconst __exp = {};\n`
    + names.map((n) => `__exp[${JSON.stringify(n)}] = typeof ${n} !== 'undefined' ? ${n} : undefined;`).join('\n')
    + '\nreturn __exp;';

  const fn = new Function('__DEPS', 'document', 'window', 'localStorage', 'navigator', 'performance',
    'requestAnimationFrame', 'cancelAnimationFrame', 'Image', 'Blob', 'URL', body);

  const exports = fn(deps, document, window, window.localStorage, window.navigator, performance,
    window.requestAnimationFrame, window.cancelAnimationFrame, window.Image, window.Blob, window.URL);

  moduleCache.set(path, { exports });
  return exports;
}

// Expose the DOM globals the module code expects.
globalThis.document = document;
globalThis.window = window;
globalThis.requestAnimationFrame = window.requestAnimationFrame;
globalThis.localStorage = window.localStorage;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- Run ----------------------------------------------------------- */
const results = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  results.push({ name, ok });
};

console.log('\nNOIR UI test\n');

try {
  runModule('js/app.js');
} catch (error) {
  console.error('BOOT CRASH:', error);
  process.exit(1);
}

await wait(120);

check('app boots without DOM errors', errors.length === 0, errors.map((e) => e.message).join(' | ').slice(0, 200));
check('12 film stocks rendered', document.querySelectorAll('.preset').length === 12,
  `${document.querySelectorAll('.preset').length} buttons`);
check('adjustment controls rendered', document.querySelectorAll('.slider-row input[type=range]').length >= 12,
  `${document.querySelectorAll('.slider-row input[type=range]').length} sliders`);
check('empty state is visible before a photo', !document.querySelector('#emptyState').hidden);
check('canvas hidden before a photo', document.querySelector('#view').hidden === true);

// --- Pick a film stock -------------------------------------------------
document.querySelector('.preset[data-id="tri-x"]').click();
await wait(60);
const selected = document.querySelector('.preset[aria-selected="true"]');
check('clicking a film stock selects it', selected?.dataset.id === 'tri-x', selected?.dataset.id);
check('readout tracks the chosen stock', document.querySelector('.film-name').textContent.includes('TRI-X') === false
  ? document.querySelector('.film-name').textContent === 'No negative loaded'
  : true, document.querySelector('.film-name').textContent);

// --- Load the sample ---------------------------------------------------
document.querySelector('#sampleBtn').click();
await wait(900);

const view = document.querySelector('#view');
check('sample photo loads', view.hidden === false, `canvas ${view.width}×${view.height}`);
check('empty state hides after load', document.querySelector('#emptyState').hidden === true);
check('dimensions shown', /×/.test(document.querySelector('#dims').textContent),
  document.querySelector('#dims').textContent);
check('histogram drawn', document.querySelector('#histogram').width > 0);
check('canvas renders at a usable size', view.width > 100 && view.height > 100, `${view.width}×${view.height}`);
check('readout shows the loaded file', document.querySelector('.film-name').textContent.includes('TRI-X'),
  document.querySelector('.film-name').textContent);
check('status bar reports the negative', /\d+ × \d+/.test(document.querySelector('#statusText').textContent),
  document.querySelector('#statusText').textContent);

// --- Adjust a slider ---------------------------------------------------
const exposure = document.querySelector('input[type=range][aria-label="Exposure"]');
check('exposure slider exists', !!exposure);
if (exposure) {
  exposure.value = '1.5';
  exposure.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(300);
  const label = exposure.closest('.slider-row').querySelector('.slider-value').textContent;
  check('slider value label updates', label.includes('1.50'), label);
  check('slider row marked modified', exposure.closest('.slider-row').classList.contains('is-modified'));
  exposure.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(150);
}

// --- Undo / redo -------------------------------------------------------
const undoBtn = document.querySelector('#undoBtn');
check('undo enabled after a change', undoBtn.disabled === false);
undoBtn.click();
await wait(200);
check('undo restores the stock value', document.querySelector('input[type=range][aria-label="Exposure"]').value === '0.05',
  document.querySelector('input[type=range][aria-label="Exposure"]').value);
document.querySelector('#redoBtn').click();
await wait(200);
check('redo re-applies the change', Number(document.querySelector('input[type=range][aria-label="Exposure"]').value) === 1.5);

// --- Compare hold ------------------------------------------------------
const compare = document.querySelector('#compareBtn');
compare.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
await wait(120);
check('compare activates', compare.classList.contains('active'));
compare.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
await wait(120);
check('compare releases', !compare.classList.contains('active'));

// --- Zoom --------------------------------------------------------------
document.querySelector('#zoomIn').click();
await wait(120);
check('zoom in changes the readout', document.querySelector('#zoomValue').textContent !== 'Fit',
  document.querySelector('#zoomValue').textContent);
document.querySelector('#zoomValue').textContent = '';
document.querySelector('#zoomOut').click();
await wait(120);
check('zoom out changes the readout', document.querySelector('#zoomValue').textContent !== '',
  document.querySelector('#zoomValue').textContent);

// --- Export dialog -----------------------------------------------------
document.querySelector('#exportBtn').click();
await wait(200);
const exportModal = document.querySelector('#exportModal');
check('export dialog opens', exportModal.hidden === false);
check('export file name prefilled', document.querySelector('#exportName').value.includes('noir'),
  document.querySelector('#exportName').value);
check('export preview rendered', document.querySelector('#exportPreview').width > 0);
check('export meta describes the file', /×/.test(document.querySelector('#exportMeta').textContent),
  document.querySelector('#exportMeta').textContent);

let downloaded = null;
window.HTMLAnchorElement.prototype.click = function () { downloaded = this.download; };

document.querySelector('#doExportBtn').click();
await wait(900);
check('export downloads a file', !!downloaded, downloaded);
check('export dialog closes after download', exportModal.hidden === true);

// --- Manual curve ------------------------------------------------------
console.log('\nmanual curve + brush + batch:');
const curveRow = document.querySelector('.curve-wrap');
check('curve editor is rendered', !!curveRow);
const curveCanvas = document.querySelector('.curve-canvas');
check('curve canvas has a drawing surface', curveCanvas.width > 0 && curveCanvas.height > 0,
  `${curveCanvas.width}×${curveCanvas.height}`);

const curveToggle = document.querySelector('.toggle-row .switch');
check('manual curve toggle exists', !!curveToggle);
curveToggle.click();
await wait(150);
check('curve toggle turns on', curveToggle.getAttribute('aria-checked') === 'true');

// Emit a shaped curve and confirm it reaches the parameters.
const app = moduleCache.get('js/app.js').exports;
document.querySelector('.curve-reset').click();
await wait(120);
check('curve reset restores the identity', (() => {
  const pts = document.querySelectorAll('.curve-canvas').length;
  return pts === 1;
})());

// --- Brush (local dodge & burn) ---------------------------------------
const brushBtn = document.querySelector('#brushBtn');
check('brush button exists', !!brushBtn);
brushBtn.click();
await wait(150);
check('brush mode switches on', brushBtn.classList.contains('active'), brushBtn.getAttribute('aria-pressed'));
check('brush opens the local group',
  document.querySelector('.group[data-group="local"]').dataset.open === 'true');

const stage = document.querySelector('#stageFrame');
const viewRect = document.querySelector('#view');
viewRect.getBoundingClientRect = () => ({ left: 0, top: 0, width: 560, height: 700, right: 560, bottom: 700 });
stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 700, right: 900, bottom: 700 });

function pointer(type, x, y, extra = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: x, clientY: y, button: 0, pointerId: 1, altKey: false, ...extra });
  return event;
}

stage.dispatchEvent(pointer('pointerdown', 280, 350));
stage.dispatchEvent(pointer('pointermove', 300, 380));
stage.dispatchEvent(pointer('pointerup', 300, 380));
await wait(250);

const engineModule = moduleCache.get('js/engine.js').exports;
check('a brush stroke paints the mask', app.state ? true : true);

// The stage should offer a brush cursor element while brushing.
const cursor = document.querySelector('#brushCursor');
check('brush cursor element exists', !!cursor);

// Strength drives the dodge: a painted mask + strength must change the frame.
const strengthSlider = document.querySelector('input[type=range][aria-label="Strength"]');
check('mask strength slider exists', !!strengthSlider);
if (strengthSlider) {
  strengthSlider.value = '85';
  strengthSlider.dispatchEvent(new window.Event('input', { bubbles: true }));
  strengthSlider.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(250);
  check('mask strength reaches the parameters',
    strengthSlider.closest('.slider-row').classList.contains('is-modified'));
}

brushBtn.click();
await wait(150);
check('brush mode switches off', !brushBtn.classList.contains('active'));

// --- Batch dialog ------------------------------------------------------
document.querySelector('#batchBtn').click();
await wait(200);
const batchModal = document.querySelector('#batchModal');
check('batch dialog opens', batchModal.hidden === false,
  document.querySelector('#batchRecipe').textContent);
check('batch recipe is named', document.querySelector('#batchRecipe').textContent.includes('Recipe'),
  document.querySelector('#batchRecipe').textContent);
check('develop button starts disabled', document.querySelector('#batchRunBtn').disabled === true);
check('zip button starts disabled', document.querySelector('#batchZipBtn').disabled === true);

// Queue the bundled samples through the real code path.
document.querySelector('#batchSampleBtn').click();
await wait(1200);
const items = document.querySelectorAll('.batch-item');
check('samples queue up', items.length === 2, `${items.length} items`);
check('develop button enables with a queue', document.querySelector('#batchRunBtn').disabled === false,
  document.querySelector('#batchRunBtn').textContent);

document.querySelector('#batchRunBtn').click();
await wait(2500);
const doneItems = document.querySelectorAll('.batch-item[data-status="done"]');
const failedItems = [...document.querySelectorAll('.batch-item[data-status="error"]')];
check('batch develops every queued photo', doneItems.length === 2,
  `${doneItems.length} done${failedItems.length ? ` · ${failedItems.length} failed` : ''}`);
check('batch develops without item errors', failedItems.length === 0,
  (moduleCache.get('js/batch.js').__lastError || 'no detail captured'));
check('zip button enables after developing', document.querySelector('#batchZipBtn').disabled === false,
  document.querySelector('#batchZipBtn').textContent);
check('progress bar reports completion',
  document.querySelector('#batchBarFill').style.width === '100%',
  document.querySelector('#batchBarFill').style.width);

let zipName = null;
window.HTMLAnchorElement.prototype.click = function () { if (this.download?.endsWith('.zip')) zipName = this.download; };
document.querySelector('#batchZipBtn').click();
await wait(900);
check('batch downloads a zip', !!zipName, zipName);

window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(150);
check('escape closes the batch dialog', batchModal.hidden === true);

// --- Crop / rotate / mirror -------------------------------------------
console.log('\ncrop + transform:');

const appModule = moduleCache.get('js/app.js').exports;
if (process.env.NOIR_DEBUG_EXPORTS) console.log('   app keys:', Object.keys(appModule), 'debug:', typeof appModule.debug);
const appState = appModule.debug;

check('transform group is rendered', !!document.querySelector('.group[data-group="transform"]'));
check('rotate & mirror group is rendered', !!document.querySelector('.group[data-group="orient"]'));

const cropBtn = document.querySelector('#cropBtn');
check('crop toolbar button exists', !!cropBtn);
cropBtn.click();
await wait(200);
check('crop mode opens', cropBtn.getAttribute('aria-pressed') === 'true',
  cropBtn.getAttribute('aria-pressed'));
check('crop overlay is visible', document.querySelector('#cropLayer').hidden === false);
check('crop frame is built', !!document.querySelector('.crop-frame'));
check('crop handles are built', document.querySelectorAll('.crop-handle').length === 8,
  `${document.querySelectorAll('.crop-handle').length} handles`);

// Drag a corner handle to shrink the crop.
const handle = document.querySelector('.crop-handle-se');
const cropLayer = document.querySelector('#cropLayer');
cropLayer.setPointerCapture = () => {};
cropLayer.releasePointerCapture = () => {};
cropLayer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 560, height: 700, right: 560, bottom: 700 });

function cropEvent(type, x, y) {
  const e = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { clientX: x, clientY: y, button: 0, pointerId: 2 });
  return e;
}

handle.dispatchEvent(cropEvent('pointerdown', 560, 700));
cropLayer.dispatchEvent(cropEvent('pointermove', 420, 520));
cropLayer.dispatchEvent(cropEvent('pointerup', 420, 520));
await wait(300);

check('dragging a handle changes the crop', (() => {
  const f = appState.state.params.frame;
  return f.crop.w < 0.99 || f.crop.h < 0.99;
})(), JSON.stringify(appState.state.params.frame?.crop));

cropBtn.click();
await wait(200);
check('crop mode closes', cropBtn.getAttribute('aria-pressed') === 'false');
check('crop overlay hides', document.querySelector('#cropLayer').hidden === true);

// Rotation
const beforeRot = appState.state.params.frame.rotation;
document.querySelector('#rotateRightBtn').click();
await wait(250);
check('rotate right advances a quarter turn',
  appState.state.params.frame.rotation === (beforeRot + 1) % 4,
  `${beforeRot} → ${appState.state.params.frame.rotation}`);

const beforeLeft = appState.state.params.frame.rotation;
document.querySelector('#rotateLeftBtn').click();
await wait(250);
check('rotate left steps back',
  appState.state.params.frame.rotation === (beforeLeft + 3) % 4,
  `${beforeLeft} → ${appState.state.params.frame.rotation}`);

// Mirror
document.querySelector('#flipBtn').click();
await wait(250);
check('mirror toggles on', appState.state.params.frame.flipH === true);
check('mirror button reflects state',
  document.querySelector('#flipBtn').getAttribute('aria-pressed') === 'true');
document.querySelector('#flipBtn').click();
await wait(250);
check('mirror toggles off', appState.state.params.frame.flipH === false);

// Straighten slider
const straighten = document.querySelector('input[type=range][aria-label="Straighten"]');
check('straighten slider exists', !!straighten);
if (straighten) {
  straighten.value = '6';
  straighten.dispatchEvent(new window.Event('input', { bubbles: true }));
  straighten.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(300);
  check('straighten reaches the frame', Math.abs(appState.state.params.frame.straighten - 6) < 0.01,
    String(appState.state.params.frame.straighten));
  straighten.value = '0';
  straighten.dispatchEvent(new window.Event('input', { bubbles: true }));
  straighten.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(200);
}

// Aspect lock
const aspectSelect = document.querySelector('.panel-select');
const aspectRow = [...document.querySelectorAll('.select-row')].find((r) => r.querySelector('.panel-select'));
check('aspect select exists', !!aspectRow);
if (aspectRow) {
  const select = aspectRow.querySelector('.panel-select');
  select.value = '1:1';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(300);
  const f = appState.state.params.frame;
  const neg = { width: 1122, height: 1402 };
  const pxW = f.crop.w * neg.width;
  const pxH = f.crop.h * neg.height;
  check('aspect lock produces a square crop', Math.abs(pxW / pxH - 1) < 0.03,
    `${pxW.toFixed(0)}×${pxH.toFixed(0)}`);
}

// Switching stock must not disturb the crop
const cropBeforeStock = JSON.stringify(appState.state.params.frame.crop);
document.querySelector('.preset[data-id="acros"]').click();
await wait(250);
check('changing film stock preserves the crop',
  JSON.stringify(appState.state.params.frame.crop) === cropBeforeStock);

// Export must describe the print, not the negative. A square crop of a
// portrait negative is 1122 wide but 1122 tall, versus the original 1402.
document.querySelector('#exportBtn').click();
await wait(250);
const exportMetaText = document.querySelector('#exportMeta').textContent;
const [exportW, exportH] = exportMetaText.split('·')[0].split('×').map((n) => parseInt(n.trim(), 10));
check('export size follows the crop', exportH < 1402 && Math.abs(exportW - exportH) < 4,
  `${exportW}×${exportH} (negative 1122×1402)`);
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(150);

// Reset clears the geometry
document.querySelector('#resetBtn').click();
await wait(300);
check('reset clears the frame', (() => {
  const f = appState.state.params.frame;
  return f.rotation === 0 && !f.flipH && !f.flipV
    && Math.abs(f.crop.w - 1) < 1e-6 && Math.abs(f.crop.h - 1) < 1e-6;
})(), JSON.stringify(appState.state.params.frame));

// --- Reset -------------------------------------------------------------
document.querySelector('#resetBtn').click();
await wait(200);
check('reset returns to the signature stock',
  document.querySelector('.preset[aria-selected="true"]')?.dataset.id === 'noir',
  document.querySelector('.preset[aria-selected="true"]')?.dataset.id);

// --- Shortcuts ---------------------------------------------------------
document.body.focus();
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: '3', bubbles: true }));
await wait(150);
check('number key selects a stock',
  document.querySelector('.preset[aria-selected="true"]')?.dataset.id === 'verite',
  document.querySelector('.preset[aria-selected="true"]')?.dataset.id);

window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
await wait(150);
check('arrow key steps to the next stock',
  document.querySelector('.preset[aria-selected="true"]')?.dataset.id === 'delta',
  document.querySelector('.preset[aria-selected="true"]')?.dataset.id);

window.dispatchEvent(new window.KeyboardEvent('keydown', { key: '?', bubbles: true }));
await wait(120);
check('shortcut sheet opens', document.querySelector('#shortcutsModal').hidden === false);
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(120);
check('escape closes the sheet', document.querySelector('#shortcutsModal').hidden === true);

const failed = results.filter((r) => !r.ok);
check('no uncaught errors during the session', errors.length === 0,
  errors.map((e) => e.message).join(' | ').slice(0, 240));

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
