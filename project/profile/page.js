/**
 * The profile editor page.
 *
 * The panel does the work; this wires it to the page and keeps the document
 * title in step with the profile it is editing, so a tab does not read
 * "Profile editor" while the visitor has named it something else.
 */

import { initProfilePanel } from './panel.js';

function boot() {
  const root = document.querySelector('#profilePanel');
  const panel = initProfilePanel(root);
  if (!panel) return null;

  const baseTitle = 'NOIR Profile Editor';

  const syncTitle = () => {
    const name = (panel.fields.name || '').trim();
    document.title = name ? `${name} · ${baseTitle}` : baseTitle;
  };

  syncTitle();
  const nameInput = document.querySelector('#ppName');
  if (nameInput) nameInput.addEventListener('input', syncTitle);

  return panel;
}

/**
 * The panel API, for the tests. Exported rather than hung off `window`.
 */
let api = null;

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
