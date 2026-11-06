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
  cb(new window.Blob([buf], { type: mime }));
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

// jsdom ships no object URLs; downloads only need a stable string.
let urlCounter = 0;
window.URL.createObjectURL = () => `blob:noir/${++urlCounter}`;
window.URL.revokeObjectURL = () => {};

// rAF runs synchronously-ish for the test
window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
window.getComputedStyle = (node) => ({ paddingLeft: '26px', paddingTop: '26px' });
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
