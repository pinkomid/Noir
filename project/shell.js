/**
 * The workspace shell: two panes side by side.
 *
 * NOIR (right) is the existing darkroom, unchanged — it reads the same
 * #openBtn, #view, #stageFrame and #panel nodes it has always read. The
 * profile editor (left) is the new pane.
 *
 * The photo pane is a column, not a full page: NOIR's own phone layout keys
 * off the viewport width, which is the whole screen, so at half width it
 * would never reach its phone rules. The pane therefore carries a
 * `data-narrow` attribute and the stylesheet has a block for it.
 */

/* NOIR's darkroom. Importing it runs its own module, which binds the canvas,
   the rail, the panel and the file buttons. It is imported here rather than
   loaded by a second <script> tag so there is exactly one entry point. */
import '../js/app.js';

import { initProfilePanel } from './profile/panel.js';
import { inspect } from './profile/validate.js';

const PANES = ['profile', 'photo'];

/** Which pane a phone shows. Desktop shows both, so this only matters narrow. */
let activePane = 'photo';

function setActivePane(pane) {
  if (!PANES.includes(pane)) return;
  activePane = pane;
  document.body.dataset.pane = pane;
  for (const button of document.querySelectorAll('[data-pane-jump]')) {
    button.setAttribute('aria-selected', String(button.dataset.paneJump === pane));
  }
}

function initPaneSwitcher() {
  setActivePane(activePane);

  for (const button of document.querySelectorAll('[data-pane-jump]')) {
    button.addEventListener('click', () => setActivePane(button.dataset.paneJump));
  }
}

/**
 * NOIR sizes its canvas from the viewport. Inside a pane that is a different
 * number, so tell it to re-measure when the pane's own width changes.
 */
function initResizeBridge() {
  const stage = document.querySelector('#stageFrame');
  if (!stage || typeof ResizeObserver !== 'function') return;

  let frame = 0;
  const observer = new ResizeObserver(() => {
    // One re-measure per frame; the observer fires on every drag pixel.
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      window.dispatchEvent(new Event('resize'));
    });
  });
  observer.observe(stage);
}

/** Load the sample negative so the photo pane is never an empty box. */
function bootSample() {
  const sample = document.querySelector('#sampleBtn');
  if (!sample) return;
  // Wait for NOIR's own module to finish wiring the button.
  requestAnimationFrame(() => sample.click());
}

/**
 * The photo pane's badge. NOIR fills its own bar with the loaded negative; the
 * badge sits in the pane header above it and reports whether a photo is in
 * hand, which is the one thing that changes how the pane reads.
 */
function syncPhotoBadge() {
  const badge = document.querySelector('#photoBadge');
  const open = document.querySelector('#openBtn');
  if (!badge || !open) return;

  // NOIR hides the canvas until a photo loads; its hidden state is the
  // cheapest honest signal, and it is already maintained by the darkroom.
  const view = document.querySelector('#view');
  if (!view) return;

  const paint = () => {
    const loaded = !view.hidden;
    badge.textContent = loaded ? 'Photo loaded' : 'No photo';
    badge.classList.toggle('is-live', loaded);
  };

  paint();
  // The canvas is a DOM node whose `hidden` attribute NOIR toggles; observing
  // the attribute is how to follow it without reaching into the darkroom.
  // Guarded, because not every environment that renders this page has one.
  if (typeof MutationObserver === 'function') {
    new MutationObserver(paint).observe(view, { attributes: true, attributeFilter: ['hidden'] });
  }
}

/**
 * NOIR's top bar used to show the loaded negative. With a profile next to it,
 * that strip is a better place for whose profile this is — the photo pane's
 * file state is already in its own bar.
 */
function syncProfileName(profile) {
  const nameEl = document.querySelector('#filmReadout .film-name');
  const detailEl = document.querySelector('#filmReadout .film-detail');
  if (!nameEl) return;

  const paint = () => {
    const name = (profile?.fields?.name || '').trim();
    nameEl.textContent = name || 'Untitled profile';
    if (detailEl) detailEl.textContent = '3DXChat biography';
  };

  paint();
  const input = document.querySelector('#ppName');
  if (input) input.addEventListener('input', paint);
}

function boot() {
  const profileRoot = document.querySelector('#profilePanel');
  const profile = initProfilePanel(profileRoot);

  syncProfileName(profile);
  syncPhotoBadge();
  initPaneSwitcher();
  initResizeBridge();
  bootSample();

  document.body.classList.add('ready');

  return { profile, inspect };
}

/**
 * The pane API, for whatever loaded this module. It is a module export rather
 * than a global: a `window.NOIR_*` object is state anything can rewrite, and
 * the only consumer is the test harness.
 */
let api = null;

/** Boot once. Safe to call again; the second call returns the first result. */
export function start() {
  if (api) return Promise.resolve(api);
  if (document.readyState === 'loading') {
    return new Promise((resolve) => {
      document.addEventListener('DOMContentLoaded', () => { api = boot(); resolve(api); });
    });
  }
  api = boot();
  return Promise.resolve(api);
}

export const getApi = () => api;

start();
