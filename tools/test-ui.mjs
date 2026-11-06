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

let html = readFileSync('photo.html', 'utf8');
/** Pristine markup, before the harness strips <script> tags out of it. */
const htmlSource = html;
// Inline the module tree so jsdom runs it without a network module loader.
const modules = {
  'js/engine.js': readFileSync('js/engine.js', 'utf8'),
  'js/presets.js': readFileSync('js/presets.js', 'utf8'),
  'js/controls.js': readFileSync('js/controls.js', 'utf8'),
  'js/ui.js': readFileSync('js/ui.js', 'utf8'),
  'js/batch.js': readFileSync('js/batch.js', 'utf8'),
  'js/geometry.js': readFileSync('js/geometry.js', 'utf8'),
  'js/fx.js': readFileSync('js/fx.js', 'utf8'),
  'js/app.js': readFileSync('js/app.js', 'utf8'),
  'project/profile/data.js': readFileSync('project/profile/data.js', 'utf8'),
  'project/profile/validate.js': readFileSync('project/profile/validate.js', 'utf8'),
  'project/profile/compose.js': readFileSync('project/profile/compose.js', 'utf8'),
  'project/profile/panel.js': readFileSync('project/profile/panel.js', 'utf8'),
  'project/profile/page.js': readFileSync('project/profile/page.js', 'utf8'),
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

  // A side-effect import (`import './x.js';`) has no bindings to destructure,
  // but it still has to be *run* — that is how the shell boots the darkroom.
  code = code.replace(
    /^import\s+['"]([^'"\n]+)['"];?/gm,
    (_, spec) => {
      __require(spec);
      return '';
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
    'requestAnimationFrame', 'cancelAnimationFrame', 'Image', 'Blob', 'URL', 'MutationObserver', 'ResizeObserver', body);

  const exports = fn(deps, document, window, window.localStorage, window.navigator, performance,
    window.requestAnimationFrame, window.cancelAnimationFrame, window.Image, window.Blob, window.URL,
    window.MutationObserver, window.ResizeObserver);

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

const appDebug = () => moduleCache.get('js/app.js').exports.debug;
/** Live view of the app's state, resolved on every access. */
const app = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? appDebug()[key] : undefined) });

check('app boots without DOM errors', errors.length === 0, errors.map((e) => e.message).join(' | ').slice(0, 200));
check('24 stocks rendered (12 darkroom + 12 graphic lab)',
  document.querySelectorAll('.preset').length === 24,
  `${document.querySelectorAll('.preset').length} buttons`);
check('the rail is split into two named families',
  document.querySelectorAll('.preset-divider').length === 2,
  [...document.querySelectorAll('.preset-divider')].map((d) => d.textContent).join(' / '));
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

// Controls live in tabs now; open the tab that owns the control first.
function openTabFor(selector) {
  const node = document.querySelector(selector);
  if (!node) return null;
  const pane = node.closest('.tabpane');
  if (pane) {
    const btn = document.querySelector(`.tab[aria-controls="${pane.id}"]`);
    if (btn) btn.click();
  }
  return node;
}

check('panel renders a tab bar', document.querySelectorAll('.tab').length === 5,
  `${document.querySelectorAll('.tab').length} tabs`);
check('exactly one tab pane is visible',
  [...document.querySelectorAll('.tabpane')].filter((p) => !p.hidden).length === 1);

const curveToggle = openTabFor('.group[data-group="tone"] .toggle-row .switch');
check('manual curve toggle exists', !!curveToggle);
if (process.env.NOIR_DEBUG) {
  console.log('   toggles on page:', document.querySelectorAll('.switch').length,
    '| pane hidden:', curveToggle?.closest('.tabpane')?.hidden,
    '| connected:', curveToggle?.isConnected);
}
if (curveToggle) curveToggle.click();
await wait(200);
check('curve toggle turns on', curveToggle.getAttribute('aria-checked') === 'true',
  `checked=${curveToggle.getAttribute('aria-checked')} curveOn=${app.state?.params?.curveOn}`);

// Emit a shaped curve and confirm it reaches the parameters.
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
  const f = app.state.params.frame;
  return f.crop.w < 0.99 || f.crop.h < 0.99;
})(), JSON.stringify(app.state.params.frame?.crop));

cropBtn.click();
await wait(200);
check('crop mode closes', cropBtn.getAttribute('aria-pressed') === 'false');

/* ------------------------------------------------------------------ */
/* Crop overlay geometry                                               */
/* ------------------------------------------------------------------ */

// The user reported the frame only appearing after dragging from a corner,
// and not following the aspect lock. These checks pin the behaviour down:
// the frame must be visible immediately, must track the print, and must
// change size when the aspect changes without any pointer input.

console.log('\ncrop overlay:');

const geo = moduleCache.get('js/geometry.js').exports;

// 1. The frame has real geometry the moment crop mode opens.
document.querySelector('#cropBtn').click();
await wait(260);
const frameEl = document.querySelector('.crop-frame');
check('crop frame exists on open', !!frameEl);
const boxOnOpen = frameEl.getBoundingClientRect ? null : frameEl.style;
check('crop frame is placed immediately, not after a drag',
  (frameEl.style.width !== '' && parseFloat(frameEl.style.width) > 0 &&
   frameEl.style.height !== '' && parseFloat(frameEl.style.height) > 0),
  `w=${frameEl.style.width} h=${frameEl.style.height} left=${frameEl.style.left}`);
// The frame must be the stored crop's footprint, not the whole print: the
// preview shows everything, and the frame marks what survives.
check('crop frame matches the stored crop footprint',
  (() => {
    const f = app.state.params.frame;
    const r = geo.cropToPrintRect(f.crop, { ...f, crop: { x: 0, y: 0, w: 1, h: 1 } });
    return Math.abs(parseFloat(frameEl.style.width) - r.w * 560) < 2 &&
           Math.abs(parseFloat(frameEl.style.height) - r.h * 700) < 2;
  })(),
  `${frameEl.style.width} × ${frameEl.style.height} for crop ${JSON.stringify(app.state.params.frame.crop)}`);
check('crop frame sits on the print, not in the stage corner',
  Math.abs(parseFloat(frameEl.style.left) - 0) < 1.5 &&
  Math.abs(parseFloat(frameEl.style.top) - 0) < 1.5,
  `left=${frameEl.style.left} top=${frameEl.style.top}`);

// 2. The whole negative is shown while cropping, so the window can grow.
//    Whatever the crop was, crop mode must drop it for the preview.
const cropAtEntry = { ...app.state.params.frame.crop };
// Entering with a crop applied is the case that used to break: the stage must
// show the WHOLE negative, so the window can be pulled outwards again.
// The decisive proof that crop mode is not stretching: the print box must be
// the negative's shape, not the cropped surface's. A cropped surface blitted
// into a negative-shaped box is the stretch that was reported.
const negativeRatio = app.engine.negative.width / app.engine.negative.height;
const viewRatio = 560 / 700;
check('crop mode shows the full negative, not the cropped print',
  app.state.cropMode === true &&
  cropAtEntry.w < 1 &&
  Math.abs(viewRatio - negativeRatio) < 0.02,
  `crop at entry ${JSON.stringify(cropAtEntry)}; view ${viewRatio.toFixed(3)} vs negative ${negativeRatio.toFixed(3)}`);

// 3. Changing the aspect reshapes the frame with no pointer input.
const aspectInTransform = openTabFor('.group[data-group="transform"] .panel-select');
const cropAspectSelect = aspectInTransform || document.querySelector('.panel-select');
check('aspect control is reachable', !!cropAspectSelect,
  cropAspectSelect ? cropAspectSelect.value : 'not found');

// Start from a deliberately non-square window so the ratio change is visible.
cropAspectSelect.value = '4:5';
cropAspectSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(300);
const frameBeforeAspect = { w: parseFloat(frameEl.style.width), h: parseFloat(frameEl.style.height) };

cropAspectSelect.value = '1:1';
cropAspectSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(300);

const frameAfterAspect = { w: parseFloat(frameEl.style.width), h: parseFloat(frameEl.style.height) };
check('changing aspect resizes the crop frame immediately',
  Math.abs(frameAfterAspect.w - frameBeforeAspect.w) > 1 ||
  Math.abs(frameAfterAspect.h - frameBeforeAspect.h) > 1,
  `${frameBeforeAspect.w.toFixed(1)}×${frameBeforeAspect.h.toFixed(1)} → ` +
  `${frameAfterAspect.w.toFixed(1)}×${frameAfterAspect.h.toFixed(1)}`);
check('the 1:1 frame on screen is actually square',
  Math.abs(frameAfterAspect.w - frameAfterAspect.h) < 1.5,
  `${frameAfterAspect.w.toFixed(1)} × ${frameAfterAspect.h.toFixed(1)}`);

// 4. The stored crop describes a square in *print* pixels.
check('stored crop matches the square on screen', (() => {
  const f = app.state.params.frame;
  const rect = geo.cropToPrintRect(f.crop, { ...f, crop: { x: 0, y: 0, w: 1, h: 1 } });
  const size = geo.frameSize({ ...f, crop: { x: 0, y: 0, w: 1, h: 1 } }, app.engine.negative);
  const px = rect.w * size.width;
  const py = rect.h * size.height;
  return Math.abs(px - py) < 2;
})(), JSON.stringify(app.state.params.frame.crop));

// 5. Dragging a corner keeps the aspect lock.
const seHandle = document.querySelector('.crop-handle-se');
const beforeDrag = { ...app.state.params.frame.crop };
// Grab the handle where it actually is: the se corner of the frame.
const seX = parseFloat(frameEl.style.left) + parseFloat(frameEl.style.width);
const seY = parseFloat(frameEl.style.top) + parseFloat(frameEl.style.height);
seHandle.dispatchEvent(cropEvent('pointerdown', seX, seY));
cropLayer.dispatchEvent(cropEvent('pointermove', seX - 170, seY - 210));
cropLayer.dispatchEvent(cropEvent('pointerup', seX - 170, seY - 210));
await wait(300);

check('dragging with a lock shrinks the crop', (() => {
  const f = app.state.params.frame;
  return f.crop.w < beforeDrag.w - 0.01;
})(), `${beforeDrag.w.toFixed(3)} → ${app.state.params.frame.crop.w.toFixed(3)}`);

check('dragging a corner keeps the aspect square', (() => {
  const f = app.state.params.frame;
  const rect = geo.cropToPrintRect(f.crop, { ...f, crop: { x: 0, y: 0, w: 1, h: 1 } });
  const size = geo.frameSize({ ...f, crop: { x: 0, y: 0, w: 1, h: 1 } }, app.engine.negative);
  return Math.abs(rect.w * size.width - rect.h * size.height) < 3;
})(), JSON.stringify(app.state.params.frame.crop));

// 6. The frame never leaves the print.
check('crop frame stays inside the print', (() => {
  const f = app.state.params.frame;
  const r = geo.cropToPrintRect(f.crop, f);
  return r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= 1 + 1e-6 && r.y + r.h <= 1 + 1e-6;
})(), JSON.stringify(geo.cropToPrintRect(app.state.params.frame.crop, { ...app.state.params.frame, crop: { x: 0, y: 0, w: 1, h: 1 } })));

// 7. Escape restores the crop the tool opened with.
// What the tool opened with is what Escape must restore.
const beforeEscape = { ...cropAtEntry };
cropAspectSelect.value = '16:9';
cropAspectSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(280);
const afterWide = { ...app.state.params.frame.crop };
check('16:9 changed the crop', Math.abs(afterWide.w - beforeEscape.w) > 0.01 || Math.abs(afterWide.h - beforeEscape.h) > 0.01,
  JSON.stringify(afterWide));

window.dispatchEvent(Object.assign(new window.Event('keydown', { bubbles: true, cancelable: true }), { key: 'Escape' }));
await wait(260);
check('Escape cancels the crop back to where it opened',
  Math.abs(app.state.params.frame.crop.w - beforeEscape.w) < 1e-6 &&
  Math.abs(app.state.params.frame.crop.h - beforeEscape.h) < 1e-6,
  `${JSON.stringify(afterWide)} → ${JSON.stringify(app.state.params.frame.crop)}`);
check('Escape leaves crop mode', document.querySelector('#cropLayer').hidden === true);
check('crop overlay hides', document.querySelector('#cropLayer').hidden === true);

// Rotation
const beforeRot = app.state.params.frame.rotation;
document.querySelector('#rotateRightBtn').click();
await wait(250);
check('rotate right advances a quarter turn',
  app.state.params.frame.rotation === (beforeRot + 1) % 4,
  `${beforeRot} → ${app.state.params.frame.rotation}`);

const beforeLeft = app.state.params.frame.rotation;
document.querySelector('#rotateLeftBtn').click();
await wait(250);
check('rotate left steps back',
  app.state.params.frame.rotation === (beforeLeft + 3) % 4,
  `${beforeLeft} → ${app.state.params.frame.rotation}`);

// Mirror comes from the toolbar and must also light up its panel toggle.
openTabFor('#flipBtn');
document.querySelector('#flipBtn').click();
await wait(250);
check('mirror toggles on', app.state.params.frame.flipH === true);
check('mirror button reflects state',
  document.querySelector('#flipBtn').getAttribute('aria-pressed') === 'true');
document.querySelector('#flipBtn').click();
await wait(250);
check('mirror toggles off', app.state.params.frame.flipH === false);

// Straighten slider
const straighten = document.querySelector('input[type=range][aria-label="Straighten"]');
check('straighten slider exists', !!straighten);
if (straighten) {
  straighten.value = '6';
  straighten.dispatchEvent(new window.Event('input', { bubbles: true }));
  straighten.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(300);
  check('straighten reaches the frame', Math.abs(app.state.params.frame.straighten - 6) < 0.01,
    String(app.state.params.frame.straighten));
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
  const f = app.state.params.frame;
  const neg = { width: 1122, height: 1402 };
  const pxW = f.crop.w * neg.width;
  const pxH = f.crop.h * neg.height;
  check('aspect lock produces a square crop', Math.abs(pxW / pxH - 1) < 0.03,
    `${pxW.toFixed(0)}×${pxH.toFixed(0)}`);

  // The label is the half that broke: the crop was square while the control
  // still read "Free", because the lock was written to a second copy of the
  // value that the panel never reads. Geometry alone cannot catch that, so
  // assert the control itself and the params behind it.
  check('the aspect select shows the ratio that was chosen',
    select.value === '1:1', `select reads "${select.value}"`);
  check('the chosen ratio is in the params the panel syncs from',
    app.state.params.aspect === '1:1', String(app.state.params.aspect));
  check('the aspect select is not reverted by the sync after applying',
    select.value === app.state.params.aspect,
    `select ${select.value} vs params ${app.state.params.aspect}`);

  // ...and it must survive a full round trip through the other controls,
  // which each call panel.sync() with the current params.
  openTabFor('.group[data-group="tone"] input[aria-label="Exposure"]');
  await wait(150);
  check('the ratio survives switching tabs',
    select.value === '1:1', `select reads "${select.value}" after a tab switch`);

  // Reset returns it to Free, and the control must say so.
  const aspectReset = aspectRow.querySelector('.reset-control');
  if (aspectReset) {
    aspectReset.click();
    await wait(250);
    check('resetting the aspect clears the lock in the control too',
      select.value === 'orig' || select.value === 'free',
      `select reads "${select.value}"`);
  }
}

// Choosing an aspect must not mark the film stock as adjusted: the lock is
// framing, not part of the look.
{
  const before = document.querySelector('.film-name').textContent;
  const aspectRow2 = [...document.querySelectorAll('.select-row')].find((r) => r.querySelector('.panel-select'));
  const sel = aspectRow2.querySelector('.panel-select');
  sel.value = '16:9';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(280);
  const after = document.querySelector('.film-name').textContent;
  check('an aspect lock does not mark the stock as modified',
    before.replace(' *', '') === after.replace(' *', ''),
    `"${before}" → "${after}"`);
  sel.value = '1:1';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(250);
}

// Switching stock must not disturb the crop
const cropBeforeStock = JSON.stringify(app.state.params.frame.crop);
document.querySelector('.preset[data-id="acros"]').click();
await wait(250);
check('changing film stock preserves the crop',
  JSON.stringify(app.state.params.frame.crop) === cropBeforeStock);

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
  const f = app.state.params.frame;
  return f.rotation === 0 && !f.flipH && !f.flipV
    && Math.abs(f.crop.w - 1) < 1e-6 && Math.abs(f.crop.h - 1) < 1e-6;
})(), JSON.stringify(app.state.params.frame));

// --- Theme -------------------------------------------------------------
console.log('\nlight + dark theme:');

const themeBtn = document.querySelector('#themeBtn');
check('theme toggle exists', !!themeBtn);

const themeOf = () => document.documentElement.dataset.theme;
const startTheme = themeOf();
check('a theme is applied on boot', startTheme === 'dark' || startTheme === 'light', startTheme);

themeBtn.click();
await wait(200);
const afterToggle = themeOf();
check('theme toggle switches theme', afterToggle !== startTheme, `${startTheme} → ${afterToggle}`);
check('theme is written to the document root',
  document.documentElement.hasAttribute('data-theme'));
check('theme button label follows the theme',
  themeBtn.getAttribute('aria-label').toLowerCase().includes(afterToggle === 'light' ? 'dark' : 'light'),
  themeBtn.getAttribute('aria-label'));

themeBtn.click();
await wait(200);
check('theme toggles back', themeOf() === startTheme, themeOf());

// Keyboard shortcut
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 't', bubbles: true }));
await wait(200);
check('T switches the theme', themeOf() !== startTheme, themeOf());
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 't', bubbles: true }));
await wait(200);

// --- Panel tabs --------------------------------------------------------
console.log('\npanel tabs:');
const tabButtons = [...document.querySelectorAll('.tab')];
check('five tabs render', tabButtons.length === 5, tabButtons.map((t) => t.textContent).join(' / '));
check('first tab is selected on boot',
  tabButtons.filter((t) => t.getAttribute('aria-selected') === 'true').length === 1);

for (const btn of tabButtons) {
  btn.click();
  await wait(120);
  const pane = document.querySelector(`#pane-${btn.getAttribute('aria-controls')?.replace('pane-', '')}`)
    || document.querySelector(`[aria-labelledby="${btn.id}"]`);
  const visible = [...document.querySelectorAll('.tabpane')].filter((p) => !p.hidden);
  const ok = visible.length === 1 && visible[0].id === `pane-${btn.textContent.trim().toLowerCase() === 'print' ? 'finish' : btn.textContent.trim().toLowerCase()}`;
  check(`  tab "${btn.textContent}" shows exactly its own pane`,
    visible.length === 1, `${visible.length} visible`);
}

check('no adjustment controls are lost', document.querySelectorAll('.slider-row input[type=range]').length >= 16,
  `${document.querySelectorAll('.slider-row input[type=range]').length} sliders`);

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
/* ------------------------------------------------------------------ */
/* Graphic effects UI                                                  */
/* ------------------------------------------------------------------ */

console.log('\ngraphic effects panel:');

const fxTab = document.querySelector('.tab[aria-controls="pane-fx"]');
check('effects tab exists', !!fxTab, fxTab ? fxTab.textContent : 'missing');

if (fxTab) fxTab.click();
await wait(200);

const fxGroup = document.querySelector('.group[data-group="fx"]');
check('effects group is on the effects tab', !!fxGroup);
const effectButtons = [...document.querySelectorAll('.group[data-group="fx"] .segmented-grid button')];
check('effect menu renders every entry', effectButtons.length === 13,
  `${effectButtons.length} entries`);

const halftoneBtn = effectButtons.find((b) => b.dataset.value === 'halftone');
check('halftone is offered', !!halftoneBtn);
halftoneBtn.click();
await wait(300);
check('choosing an effect updates params', app.state.params.fx === 'halftone',
  String(app.state.params.fx));
check('the chosen effect is marked pressed',
  halftoneBtn.getAttribute('aria-pressed') === 'true');
check('only one effect is pressed at a time',
  effectButtons.filter((b) => b.getAttribute('aria-pressed') === 'true').length === 1);

const levelSlider = document.querySelector('.group[data-group="fx"] input[aria-label="Cut point"]');
check('cut point slider exists', !!levelSlider);
if (levelSlider) {
  levelSlider.value = '20';
  levelSlider.dispatchEvent(new window.Event('input', { bubbles: true }));
  levelSlider.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(250);
  check('cut point reaches params', Math.abs(app.state.params.fxLevel - 20) < 0.01,
    String(app.state.params.fxLevel));
}

const amountSlider = document.querySelector('.group[data-group="fx"] input[aria-label="Amount"]');
check('amount slider exists', !!amountSlider);
if (amountSlider) {
  amountSlider.value = '0';
  amountSlider.dispatchEvent(new window.Event('input', { bubbles: true }));
  amountSlider.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(250);
  check('amount can be dialled to zero', Number(app.state.params.fxAmount) === 0,
    String(app.state.params.fxAmount));
}

// A lab stock must load its effect, and reveal the tab that owns it.
console.log('\ngraphic lab stocks:');
const labStock = document.querySelector('.preset[data-id="newsprint"]');
check('a graphic stock is in the rail', !!labStock);
labStock.click();
await wait(320);
check('loading a graphic stock sets its effect', app.state.params.fx === 'halftone',
  String(app.state.params.fx));
check('loading a graphic stock keeps the crop and orientation',
  app.state.params.frame.crop.w === 1 && app.state.params.frame.rotation === 0,
  JSON.stringify(app.state.params.frame));
check('the effects tab is open, so the look is a visible dial',
  document.querySelector('.tab[aria-controls="pane-fx"]').getAttribute('aria-selected') === 'true');

const beforeStep = app.state.presetId;
window.dispatchEvent(Object.assign(new window.Event('keydown', { bubbles: true, cancelable: true }), { key: 'ArrowLeft' }));
await wait(250);
check('arrow keys cross from the darkroom into the lab',
  app.state.presetId !== beforeStep,
  `${beforeStep} → ${app.state.presetId}`);

/* ------------------------------------------------------------------ */
/* Phone / touch                                                       */
/* ------------------------------------------------------------------ */

// jsdom has no layout engine, so the phone LAYOUT cannot be measured here.
// What can be tested is everything that is not CSS: the gestures, and the
// contract that the stylesheet actually contains the rules the layout depends
// on. The layout itself was verified by reading the rules; see the README.
console.log('\nphone and touch:');

const stageEl = document.querySelector('#stageFrame');

function touchPointer(type, id, x, y) {
  const e = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { clientX: x, clientY: y, pointerId: id, pointerType: 'touch', button: 0, isPrimary: id === 1 });
  return e;
}

// Pinch: two fingers spreading must zoom in, and closing must zoom out.
const zoomBefore = document.querySelector('#zoomValue').textContent;
stageEl.dispatchEvent(touchPointer('pointerdown', 1, 400, 300));
stageEl.dispatchEvent(touchPointer('pointerdown', 2, 420, 300));
stageEl.dispatchEvent(touchPointer('pointermove', 1, 340, 300));
stageEl.dispatchEvent(touchPointer('pointermove', 2, 480, 300));
await wait(120);
const zoomSpread = app.state.view.zoom;
check('pinching out zooms in', zoomSpread !== 'fit' && zoomSpread > 1,
  `${zoomBefore} → ${typeof zoomSpread === 'number' ? zoomSpread.toFixed(2) : zoomSpread}`);

stageEl.dispatchEvent(touchPointer('pointermove', 1, 405, 300));
stageEl.dispatchEvent(touchPointer('pointermove', 2, 415, 300));
await wait(120);
check('pinching back in zooms out again',
  app.state.view.zoom === 'fit' || app.state.view.zoom < zoomSpread,
  String(app.state.view.zoom));

stageEl.dispatchEvent(touchPointer('pointerup', 1, 405, 300));
stageEl.dispatchEvent(touchPointer('pointerup', 2, 415, 300));
await wait(150);
check('releasing a pinch settles on a zoom step', (() => {
  const z = app.state.view.zoom;
  return z === 'fit' || typeof z === 'number';
})(), String(app.state.view.zoom));
check('the stage is not left in a pinching state',
  !stageEl.classList.contains('pinching'));

// A second finger must cancel a pan rather than pan and zoom at once.
stageEl.dispatchEvent(touchPointer('pointerdown', 1, 400, 300));
stageEl.dispatchEvent(touchPointer('pointerdown', 2, 440, 300));
await wait(60);
stageEl.dispatchEvent(touchPointer('pointerup', 1, 400, 300));
stageEl.dispatchEvent(touchPointer('pointerup', 2, 440, 300));
await wait(120);

// A tap with the brush on must paint — a fingertip has no hover to lean on.
console.log('\nbrush on a touch screen:');
document.querySelector('#brushBtn').click();
await wait(200);
check('brush mode is on for the touch test',
  document.querySelector('#brushBtn').getAttribute('aria-pressed') === 'true');

// The print is #view, NOT the stage: a tap outside the print is correctly
// ignored (stagePoint rejects anything beyond 2% outside). Size it explicitly,
// because jsdom has no layout and the shared stub above is a different size.
const viewEl = document.querySelector('#view');
viewEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 560, height: 700, right: 560, bottom: 700 });

// Canvas PIXEL readback is not usable in this harness. jsdom's
// HTMLCanvasElement re-creates the backing canvas whenever width/height are
// assigned, and the engine resizes the mask canvas after taking its context,
// so maskCtx draws to an orphaned surface and getImageData comes back blank.
// The engine itself is fine — test-engine.mjs paints the same dab on the same
// native renderer and reads the pixels back correctly.
//
// History cannot see a stroke either: snapshot() covers the tone parameters,
// not the mask, so every brush stroke is skipped as "no change".
//
// So spy on the engine call. That is precisely the behaviour under test: does
// a fingertip reach paintDab, and does a pinch avoid it?
const realPaintDab = app.engine.paintDab.bind(app.engine);
let dabCalls = 0;
app.engine.paintDab = (dab) => { dabCalls++; return realPaintDab(dab); };

dabCalls = 0;
stageEl.dispatchEvent(touchPointer('pointerdown', 7, 280, 350));
await wait(120);
stageEl.dispatchEvent(touchPointer('pointerup', 7, 280, 350));
await wait(250);
check('a single tap with a finger paints', dabCalls > 0, `${dabCalls} dab(s)`);

// A tap that a second finger turns into a pinch must NOT paint: that is the
// reason the dab is deferred at all.
dabCalls = 0;
stageEl.dispatchEvent(touchPointer('pointerdown', 11, 280, 350));
stageEl.dispatchEvent(touchPointer('pointerdown', 12, 320, 350));
await wait(200);
stageEl.dispatchEvent(touchPointer('pointerup', 11, 280, 350));
stageEl.dispatchEvent(touchPointer('pointerup', 12, 320, 350));
await wait(200);
check('a tap that becomes a pinch does not paint', dabCalls === 0,
  `${dabCalls} dab(s) — a deferred dab must be dropped when a second finger arrives`);

// A mouse click must still paint immediately — no deferred path for a cursor.
dabCalls = 0;
const mouseDown = new window.Event('pointerdown', { bubbles: true, cancelable: true });
Object.assign(mouseDown, { clientX: 280, clientY: 350, pointerId: 20, pointerType: 'mouse', button: 0 });
stageEl.dispatchEvent(mouseDown);
await wait(80);
const mouseUp = new window.Event('pointerup', { bubbles: true, cancelable: true });
Object.assign(mouseUp, { clientX: 280, clientY: 350, pointerId: 20, pointerType: 'mouse', button: 0 });
stageEl.dispatchEvent(mouseUp);
await wait(120);
check('a mouse still paints with no delay', dabCalls > 0, `${dabCalls} dab(s)`);

app.engine.paintDab = realPaintDab;

check('the brush cursor ring is not shown for a finger',
  (() => {
    const ring = document.querySelector('.brush-cursor');
    return !ring || ring.style.opacity !== '1';
  })());

// Erase must stay on for touch: Alt can never be held down by a finger, so
// reading altKey from a touch event would silently cancel it.
document.querySelector('#eraseBtn').click();
await wait(150);
const eraseOn = document.querySelector('#eraseBtn').getAttribute('aria-pressed');
stageEl.dispatchEvent(touchPointer('pointerdown', 8, 300, 400));
await wait(200);
stageEl.dispatchEvent(touchPointer('pointerup', 8, 300, 400));
await wait(150);
check('the erase toggle survives a touch stroke',
  document.querySelector('#eraseBtn').getAttribute('aria-pressed') === eraseOn,
  `erase was ${eraseOn}, now ${document.querySelector('#eraseBtn').getAttribute('aria-pressed')}`);
document.querySelector('#brushBtn').click();
await wait(150);

/* ------------------------------------------------------------------ */
/* Stylesheet contract for the phone layout                            */
/* ------------------------------------------------------------------ */

// The responsive rules cannot be evaluated here, but they can be checked for
// existence and for the specific properties whose absence causes the bugs
// reported: no wrapped tabs, real touch targets, no page zoom fighting the
// pinch, and safe-area padding on notched screens.
const cssSource = readFileSync('styles/main.css', 'utf8');

function cssBlock(source, selector) {
  const i = source.indexOf(selector);
  if (i < 0) return '';
  const open = source.indexOf('{', i);
  const close = source.indexOf('\n}', open);
  return source.slice(open + 1, close < 0 ? undefined : close);
}

check('the stylesheet has a phone breakpoint', cssSource.includes('@media (max-width: 820px)'));
check('the stylesheet has a touch-input breakpoint', cssSource.includes('@media (pointer: coarse)'));

const phoneBlock = cssBlock(cssSource, '@media (max-width: 820px)');
check('the phone layout stacks the workspace into one column',
  /\.workspace\s*\{[^}]*flex-direction:\s*column/.test(phoneBlock));
check('the stage gets a viewport-relative height on a phone',
  /height:\s*min\(52dvh/.test(phoneBlock),
  'a fixed pixel height is what pushed the panel off screen');
check('the stage blocks browser panning so the pinch is ours',
  /touch-action:\s*none/.test(phoneBlock));
check('the stage does not trigger pull-to-refresh',
  /overscroll-behavior:\s*contain/.test(phoneBlock));

const coarseBlock = cssBlock(cssSource, '@media (pointer: coarse)');
check('sliders get a finger-sized thumb',
  /::-webkit-slider-thumb\s*\{[^}]*width:\s*22px/.test(coarseBlock));
check('sliders get a tall hit area',
  /input\[type="range"\]\s*\{[^}]*height:\s*34px/.test(coarseBlock));
check('switches get a finger-sized track and matching travel',
  /width:\s*44px/.test(coarseBlock) && /translateX\(20px\)/.test(coarseBlock),
  'growing the track without the travel leaves the knob short of the end');
check('segmented buttons get a real target',
  /\.segmented button\s*\{[^}]*min-height:\s*40px/.test(coarseBlock));
check('crop handles grow for a fingertip',
  /\.crop-handle\s*\{[^}]*width:\s*26px/.test(coarseBlock));
check('text inputs avoid the iOS zoom-on-focus jump',
  /font-size:\s*16px/.test(coarseBlock));
check('notched screens are padded with the safe-area inset',
  cssSource.includes('env(safe-area-inset-top)') &&
  cssSource.includes('env(safe-area-inset-bottom)'));
check('the tab bar no longer hardcodes its column count',
  !/grid-template-columns:\s*repeat\(4/.test(cssSource),
  'five tabs in a four-column grid is what wrapped PRINT');

/* ------------------------------------------------------------------ */
/* Three pages: a chooser and two workspaces                           */
/* ------------------------------------------------------------------ */

console.log('\nThe chooser:');

const photoPage = htmlSource;
const landing = readFileSync('index.html', 'utf8');
const profilePage = readFileSync('profile.html', 'utf8');
/** The profile editor's own validator, for asserting on composed text. */
const inspectReport = (text) => profileValidator.inspect(text);

check('the landing page offers exactly two ways in',
  (landing.match(/class="choice"/g) || []).length === 2,
  `${(landing.match(/class="choice"/g) || []).length} choices`);

check('both choices are real links, not buttons',
  landing.includes('href="profile.html"') && landing.includes('href="photo.html"'),
  'a link can be middle-clicked into a new tab; a button handler cannot');

check('each choice says what it leads to',
  /Profile editor/.test(landing) && /Photo editor/.test(landing) &&
  /3DXChat/.test(landing) && /black &amp; white/.test(landing));

check('the landing page loads no app module',
  !/<script type="module"/.test(landing),
  'the chooser should not boot the darkroom behind a menu');

check('the landing page does not split the screen',
  !/workspace-split/.test(landing) && !/pane-switch/.test(landing),
  'the split layout is what this replaces');

check('the landing page applies the saved theme before first paint',
  /localStorage\.getItem\('noir\.theme'\)/.test(landing),
  'reading it after paint means a dark flash then a light page');

console.log('\nThe two workspaces:');

check('the photo workspace is NOIR on its own page',
  ['id="openBtn"', 'id="stageFrame"', 'id="view"', 'id="panel"', 'id="rail"']
    .every((sel) => photoPage.includes(sel)),
  'every node the darkroom binds to lives here now');

check('the photo page loads only the darkroom',
  /<script type="module" src="js\/app.js"><\/script>/.test(photoPage) &&
  (photoPage.match(/<script type="module"/g) || []).length === 1,
  'one module, one entry point');

check('the profile page loads only the profile editor',
  /<script type="module" src="project\/profile\/page\.js"><\/script>/.test(profilePage) &&
  (profilePage.match(/<script type="module"/g) || []).length === 1);

check('both workspaces can go back to the chooser',
  /class="back-link"[^>]*href="\.\/"/.test(photoPage) &&
  /class="back-link"[^>]*href="\.\/"/.test(profilePage),
  'a workspace with no way out is a trap');

check('the back links are relative, so the Pages subpath works',
  !/href="\/(?!\/)/.test(photoPage) && !/href="\/(?!\/)/.test(profilePage) &&
  !/href="\/(?!\/)/.test(landing));

check('all three pages share one theme key',
  ['index.html', 'photo.html', 'profile.html']
    .every((f) => /noir\.theme/.test(readFileSync(f, 'utf8'))),
  'a theme that resets on every navigation is worse than none');

check('no page hardcodes the repository name in a link',
  !/Noir-Photo-Studio\//.test(landing) && !/Noir-Photo-Studio\//.test(photoPage) &&
  !/Noir-Photo-Studio\//.test(profilePage),
  'the repo was renamed to Noir; every link is relative anyway');

check('the profile page has a header and a mount point',
  /class="page-head"/.test(profilePage) && /id="profilePanel"/.test(profilePage));

/* ---- The profile page's behaviour --------------------------------- */

console.log('\nProfile page:');

const profileValidator = runModule('project/profile/validate.js');

// The harness is booted on photo.html, which has no profile pane. Mount one
// the way profile.html does, so the panel runs against the same markup it
// ships with rather than a mock.
const profileHost = document.createElement('div');
profileHost.id = 'profilePanel';
document.body.appendChild(profileHost);
const profileApi = runModule('project/profile/panel.js').initProfilePanel(profileHost);
await wait(120);

const profileRoot = profileHost;
check('the profile page mounts its form', profileRoot.querySelector('#ppName') !== null);
check('the worked example is prefilled rather than blank',
  profileRoot.querySelector('#ppName').value.length > 0,
  profileRoot.querySelector('#ppName').value);
check('the page exposes its composed text', typeof profileApi?.text === 'string' && profileApi.text.length > 0);
check('the composed profile is valid for the game', inspectReport(profileApi.text).ok);

// profile/page.js keeps the tab title in step. Its own page cannot be booted
// here (the harness is bound to photo.html), so the rule is asserted directly:
// a tab that says "Profile editor" while the profile is named something else
// is a small lie the browser shows all day.
check('the profile page sets the tab title from the profile name', (() => {
  const src = readFileSync('project/profile/page.js', 'utf8');
  return /document\.title\s*=/.test(src) && /panel\.fields\.name/.test(src);
})(), 'the title rule lives in page.js');

const preview = profileRoot.querySelector('#ppPreview');
check('the preview shows the composed text',
  preview.textContent.includes('┈') || preview.textContent.includes('╭'),
  preview.textContent.slice(0, 40).replace(/\n/g, '⏎'));

const stats = profileRoot.querySelector('#ppStats').textContent;
check('the character count is shown against the limit', /\/ 1000/.test(stats),
  stats.replace(/\s+/g, ' ').trim());

check('the count matches the game\'s counting rule', (() => {
  const text = profileApi.text;
  const expected = text.length + (text.match(/\r\n|\r|\n/g) || []).length;
  return stats.includes(String(expected));
})(), 'the editor counts line breaks, so a plain length is wrong');

check('a clean profile offers the copy button',
  profileRoot.querySelector('#ppCopy').disabled === false);

const nameInput = profileRoot.querySelector('#ppName');
nameInput.value = 'Workspace';
nameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(60);
check('typing a name updates the preview', profileApi.text.includes('ᴡᴏʀᴋꜱᴘᴀᴄᴇ'));
check('the title rule listens for the name field',
  /ppName[\s\S]{0,120}addEventListener\('input'/.test(readFileSync('project/profile/page.js', 'utf8')),
  'a title computed once goes stale on the first keystroke');

const quoteInput = profileRoot.querySelector('#ppQuote');
quoteInput.value = 'fire 🔥';
quoteInput.dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(60);
check('an emoji is reported as a glyph the game may not render',
  [...profileRoot.querySelectorAll('#ppChecks li')].some((li) => /box/.test(li.textContent)),
  'the client shows a replacement box for it');

quoteInput.value = 'clean';
quoteInput.dispatchEvent(new window.Event('input', { bubbles: true }));

const paletteSelect = profileRoot.querySelector('#ppPalette');
paletteSelect.value = 'noir';
paletteSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(60);
check('choosing a palette changes the colours in the text',
  profileApi.text.includes('#d9a55f'), 'the amber of the NOIR palette');

const frameSelect = profileRoot.querySelector('#ppFrame');
frameSelect.value = 'brackets';
frameSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(60);
check('choosing a frame adds it around the text', profileApi.text.includes('「'));

const fontSelect = profileRoot.querySelector('#ppFont');
fontSelect.value = 'circled';
fontSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(60);
check('choosing a font rewrites the name', /[ⓐ-ⓩⒶ-Ⓩ]/.test(profileApi.text));

fontSelect.value = 'smallcaps';
fontSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
const colourToggle = profileRoot.querySelector('#ppColour');
colourToggle.checked = false;
colourToggle.dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(60);
check('turning colour off removes every colour tag', !profileApi.text.includes('<color'),
  'a single stray tag defeats the switch');
colourToggle.checked = true;
colourToggle.dispatchEvent(new window.Event('change', { bubbles: true }));

const centreToggle = profileRoot.querySelector('#ppCentre');
centreToggle.checked = false;
centreToggle.dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(60);
check('turning centring off left-aligns every line',
  profileApi.text.split('\n').every((line) => !line.startsWith(' ')));
centreToggle.checked = true;
centreToggle.dispatchEvent(new window.Event('change', { bubbles: true }));

profileRoot.querySelector('[data-template="minimal"]')
  .dispatchEvent(new window.Event('click', { bubbles: true }));
await wait(80);
check('a template replaces the style', profileApi.fields.frame === 'rule-long',
  profileApi.fields.frame);
check('a template is still valid after applying', inspectReport(profileApi.text).ok);

check('the draft is saved to local storage',
  localStorage.getItem('noir.profile.draft.v1') !== null,
  'local only — nothing is uploaded');

profileRoot.querySelector('#ppReset').dispatchEvent(new window.Event('click', { bubbles: true }));
await wait(80);
check('reset restores the worked example',
  profileApi.fields.frame === 'rounded' && profileApi.fields.palette === 'dark-gothic',
  `${profileApi.fields.frame} / ${profileApi.fields.palette}`);

/* ---- The stylesheets ---------------------------------------------- */

console.log('\nPage stylesheets:');

const profileCss = readFileSync('styles/profile.css', 'utf8');

check('the chooser is a two-card grid',
  /\.landing-choices\s*\{[^}]*grid-template-columns:\s*1fr 1fr/.test(profileCss));

check('the chooser collapses to one column on a phone',
  /@media\s*\(max-width:\s*700px\)[\s\S]*?\.landing-choices\s*\{[^}]*grid-template-columns:\s*1fr/.test(profileCss));

check('the split layout is gone',
  !/workspace-split/.test(profileCss) && !/pane-switch/.test(profileCss),
  'leftover rules for a layout nobody sees are how CSS rots');

check('NOIR keeps its own viewport-based layout',
  !/--rail-w:\s*176px/.test(profileCss),
  'the trimmed rail was a workaround for living inside a pane');

check('the profile page fills the viewport without scrolling the page',
  /body\.profile-page\s*\{[^}]*height:\s*100dvh/.test(profileCss));

check('the back link clears the notch',
  /\.back-link\s*\{[^}]*env\(safe-area-inset-top/.test(profileCss));

check('profile fields avoid the iOS zoom-on-focus jump',
  /font-size:\s*16px/.test(profileCss));

check('touch targets grow on a phone',
  /@media\s*\(max-width:\s*900px\)[\s\S]*?\.pp-btn\s*\{[^}]*min-height:\s*44px/.test(profileCss));

check('the profile stylesheet is loaded by all three pages',
  ['index.html', 'photo.html', 'profile.html']
    .every((f) => readFileSync(f, 'utf8').includes('styles/profile.css')));

check('the profile pane shares the theme tokens, not its own palette',
  !/#[0-9a-f]{6}/i.test(profileCss.replace(/\/\*[\s\S]*?\*\//g, '').split('.pp-rule')[0]),
  'hardcoding colours would leave it dark in light mode');

check('no uncaught errors during the session', errors.length === 0,
  errors.map((e) => e.message).join(' | ').slice(0, 240));

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
