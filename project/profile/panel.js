/**
 * The profile editor pane: fields on the left of the pane, live preview in the
 * middle, validation underneath.
 *
 * It composes text for the 3DXChat profile field, so every output is checked
 * against that editor's rules before it is offered for copying: only <b>, <i>,
 * <color> and <size>, balanced tags, and 1000 characters counting line breaks.
 */

import {
  PALETTES, PALETTE_ORDER, FRAMES, FRAME_BY_ID, ACCENTS, ACCENT_ORDER,
  FONTS, FONT_ORDER, DEFAULT_FIELDS, TEMPLATES,
} from './data.js';
import { compose, toFont, describeTraits } from './compose.js';
import { inspect, LIMITS } from './validate.js';

const STORE_KEY = 'noir.profile.draft.v1';

/** Read the saved draft, falling back to the defaults. */
function loadDraft() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...DEFAULT_FIELDS };
    const parsed = JSON.parse(raw);
    // Only take keys that still exist, so an older draft cannot resurrect a
    // field that has since been removed.
    const clean = { ...DEFAULT_FIELDS };
    for (const key of Object.keys(DEFAULT_FIELDS)) {
      if (key in parsed) clean[key] = parsed[key];
    }
    return clean;
  } catch {
    return { ...DEFAULT_FIELDS };
  }
}

function saveDraft(fields) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(fields));
  } catch {
    /* Storage can be full or blocked; the draft still works in memory. */
  }
}

const escapeHtml = (text) => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/**
 * Render the composed text the way the game will: <color> becomes a span,
 * <b>/<i> map onto real tags, and everything else is shown literally so an
 * unsupported tag is visible rather than silently swallowed.
 */
function previewHtml(text) {
  let out = escapeHtml(text);
  out = out.replace(/&lt;color=([^&]+)&gt;/g, '<span style="color:$1">');
  out = out.replace(/&lt;\/color&gt;/g, '</span>');
  out = out.replace(/&lt;(\/?)(b|i)&gt;/g, '<$1$2>');
  out = out.replace(/&lt;size=(\d+)&gt;/g, '<span style="font-size:$1px">');
  out = out.replace(/&lt;\/size&gt;/g, '</span>');
  return out;
}

export function initProfilePanel(root) {
  if (!root) return null;

  const fields = loadDraft();
  let copiedTimer = 0;

  root.innerHTML = `
    <div class="pp-form" id="ppForm">
      <div class="pp-section">
        <h3>Identity</h3>
        <label class="pp-field">
          <span>Name <em id="ppNameCount">0 / ${LIMITS.name}</em></span>
          <input type="text" id="ppName" maxlength="${LIMITS.name}" autocomplete="off" />
        </label>
        <div class="pp-row">
          <label class="pp-field">
            <span>Pronouns</span>
            <input type="text" id="ppPronouns" autocomplete="off" />
          </label>
          <label class="pp-field">
            <span>Orientation</span>
            <input type="text" id="ppOrientation" autocomplete="off" />
          </label>
        </div>
        <label class="pp-field">
          <span>Languages</span>
          <input type="text" id="ppLanguages" autocomplete="off" />
        </label>
      </div>

      <div class="pp-section">
        <h3>Personality <em id="ppTraitWords"></em></h3>
        <label class="pp-slider"><span>Soft</span><input type="range" id="ppSoft" min="0" max="5" /><output></output></label>
        <label class="pp-slider"><span>Shy</span><input type="range" id="ppShy" min="0" max="5" /><output></output></label>
        <label class="pp-slider"><span>Moody</span><input type="range" id="ppMoody" min="0" max="5" /><output></output></label>
        <label class="pp-slider"><span>Warm</span><input type="range" id="ppWarm" min="0" max="5" /><output></output></label>
        <p class="pp-hint">Sliders only emit words at 2 and 4, so a quiet profile stays quiet.</p>
      </div>

      <div class="pp-section">
        <h3>Lines</h3>
        <label class="pp-field">
          <span>Greetings <em>one per line</em></span>
          <textarea id="ppGreets" rows="2" placeholder="ꜱʜʏ ᴀᴛ ꜰɪʀꜱᴛ&#10;ᴡᴀʀᴍ ᴏɴᴄᴇ ʏᴏᴜ ꜱᴛᴀʏ"></textarea>
        </label>
        <label class="pp-field">
          <span>Limits <em>one per line</em></span>
          <textarea id="ppLimits" rows="2" placeholder="ɴᴏ ᴄᴏɴᴛʀᴏʟ"></textarea>
        </label>
        <label class="pp-field">
          <span>Signature line</span>
          <input type="text" id="ppQuote" autocomplete="off" />
        </label>
      </div>

      <div class="pp-section">
        <h3>Style</h3>
        <label class="pp-field">
          <span>Font</span>
          <select id="ppFont"></select>
        </label>
        <label class="pp-field">
          <span>Palette</span>
          <select id="ppPalette"></select>
        </label>
        <div class="pp-row">
          <label class="pp-field">
            <span>Frame</span>
            <select id="ppFrame"></select>
          </label>
          <label class="pp-field">
            <span>Accent</span>
            <select id="ppAccent"></select>
          </label>
        </div>
        <div class="pp-toggles">
          <label class="pp-check"><input type="checkbox" id="ppCentre" /><span>Centre lines with spaces</span></label>
          <label class="pp-check"><input type="checkbox" id="ppColour" /><span>Colour the text</span></label>
        </div>
        <p class="pp-hint">The game has no <code>&lt;align&gt;</code>, so centring uses real spaces.</p>
      </div>

      <div class="pp-section">
        <h3>Templates</h3>
        <div class="pp-templates" id="ppTemplates"></div>
      </div>
    </div>

    <div class="pp-result">
      <div class="pp-card" id="ppCard">
        <div class="pp-card-head">
          <h2 id="ppCardName">Profile</h2>
          <span class="pp-tag">3DXChat</span>
        </div>
        <div class="pp-rule" id="ppRule"></div>
        <pre class="pp-preview" id="ppPreview"></pre>
      </div>

      <div class="pp-stats" id="ppStats"></div>
      <ul class="pp-checks" id="ppChecks"></ul>

      <div class="pp-actions">
        <button class="pp-btn pp-btn-primary" type="button" id="ppCopy">Copy profile text</button>
        <button class="pp-btn" type="button" id="ppDownload">Download .txt</button>
        <button class="pp-btn" type="button" id="ppReset">Reset</button>
      </div>
      <p class="pp-hint pp-privacy">Everything stays in this browser. The draft is saved locally and never uploaded.</p>
    </div>
  `;

  /* ---- populate the selects ---------------------------------------- */

  const $ = (id) => root.querySelector(`#${id}`);

  const fontSel = $('ppFont');
  fontSel.innerHTML = FONT_ORDER
    .map((id) => `<option value="${id}">${FONTS[id].label}</option>`)
    .join('');

  const paletteSel = $('ppPalette');
  paletteSel.innerHTML = PALETTE_ORDER
    .map((id) => `<option value="${id}">${PALETTES[id].label}</option>`)
    .join('');

  const frameSel = $('ppFrame');
  frameSel.innerHTML = FRAMES
    .map((f) => `<option value="${f.id}">${f.label}</option>`)
    .join('');

  const accentSel = $('ppAccent');
  accentSel.innerHTML = ACCENT_ORDER
    .map((id) => `<option value="${id}">${ACCENTS[id] || 'None'}</option>`)
    .join('');

  const templatesEl = $('ppTemplates');
  templatesEl.innerHTML = TEMPLATES
    .map((t) => `<button type="button" class="pp-template" data-template="${t.id}" title="${t.hint}">${t.label}</button>`)
    .join('');

  /* ---- bind ------------------------------------------------------- */

  const inputs = {
    name: $('ppName'),
    pronouns: $('ppPronouns'),
    orientation: $('ppOrientation'),
    languages: $('ppLanguages'),
    greets: $('ppGreets'),
    limits: $('ppLimits'),
    quote: $('ppQuote'),
    soft: $('ppSoft'),
    shy: $('ppShy'),
    moody: $('ppMoody'),
    warm: $('ppWarm'),
    font: fontSel,
    palette: paletteSel,
    frame: frameSel,
    accent: accentSel,
    centreText: $('ppCentre'),
    colourText: $('ppColour'),
  };

  const linesToArray = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean);

  function pullFromInputs() {
    fields.name = inputs.name.value.trim();
    fields.pronouns = inputs.pronouns.value.trim();
    fields.orientation = inputs.orientation.value.trim();
    fields.languages = inputs.languages.value.trim();
    fields.greets = linesToArray(inputs.greets.value);
    fields.limits = linesToArray(inputs.limits.value);
    fields.quote = inputs.quote.value.trim();
    fields.soft = Number(inputs.soft.value);
    fields.shy = Number(inputs.shy.value);
    fields.moody = Number(inputs.moody.value);
    fields.warm = Number(inputs.warm.value);
    fields.font = inputs.font.value;
    fields.palette = inputs.palette.value;
    fields.frame = inputs.frame.value;
    fields.accent = inputs.accent.value;
    fields.centreText = inputs.centreText.checked;
    fields.colourText = inputs.colourText.checked;
  }

  function pushToInputs() {
    inputs.name.value = fields.name;
    inputs.pronouns.value = fields.pronouns;
    inputs.orientation.value = fields.orientation;
    inputs.languages.value = fields.languages;
    inputs.greets.value = fields.greets.join('\n');
    inputs.limits.value = fields.limits.join('\n');
    inputs.quote.value = fields.quote;
    inputs.soft.value = fields.soft;
    inputs.shy.value = fields.shy;
    inputs.moody.value = fields.moody;
    inputs.warm.value = fields.warm;
    inputs.font.value = fields.font;
    inputs.palette.value = fields.palette;
    inputs.frame.value = fields.frame;
    inputs.accent.value = fields.accent;
    inputs.centreText.checked = fields.centreText;
    inputs.colourText.checked = fields.colourText;
  }

  /* ---- render ----------------------------------------------------- */

  /**
   * The width used for centring tracks the preview pane, because a line that
   * is centred for a 46-character pane drifts off-centre in a 30-character
   * one. Falls back to the stored width when the pane has no layout yet
   * (jsdom, or a hidden tab).
   */
  function measureWidth() {
    const el = $('ppPreview');
    const px = el.getBoundingClientRect().width;
    if (!px) return fields.width;
    // Roughly 6.6px per character at the preview's size, clamped so a very
    // narrow pane does not produce a one-character column.
    return Math.max(24, Math.min(64, Math.floor(px / 6.6)));
  }

  let lastText = '';

  function render() {
    const text = compose({ ...fields, width: measureWidth() });
    lastText = text;

    const report = inspect(text);
    const hues = PALETTES[fields.palette] ?? PALETTES['dark-gothic'];

    // Preview
    $('ppPreview').textContent = text || 'Fill in a field to see the profile.';
    $('ppCardName').textContent = fields.name || 'Profile';
    $('ppRule').style.background = `linear-gradient(90deg, ${hues.hex[0]}, ${hues.hex[2]}, ${hues.hex[5]})`;

    // Counters
    const counted = report.counted;
    const counter = $('ppStats');
    counter.innerHTML = `
      <span class="${report.over ? 'pp-bad' : ''}">${counted} / ${LIMITS.profile} characters</span>
      <span>${report.remaining >= 0 ? `${report.remaining} left` : `${-report.remaining} over`}</span>
    `;

    $('ppNameCount').textContent = `${fields.name.length} / ${LIMITS.name}`;

    // Trait words, so the sliders show what they will say.
    const words = describeTraits(fields);
    $('ppTraitWords').textContent = words.length ? words.join(' · ') : 'no trait words yet';

    // Problems, in the order the game would hit them.
    const checks = [];
    if (report.problems.length) {
      for (const p of report.problems.slice(0, 6)) {
        checks.push({ ok: false, text: `line ${p.line}: ${p.message}` });
      }
    }
    if (report.risky.length) {
      const named = report.risky.slice(0, 8).join(' ');
      checks.push({
        ok: false,
        text: `${report.risky.length} glyph(s) above the Basic Multilingual Plane may show as a box in the game: ${named}`,
      });
    }
    if (!fields.name.trim()) checks.push({ ok: false, text: 'A name is expected' });

    // Positive confirmations, so an empty panel never looks like a failure.
    if (!report.problems.length) {
      checks.push({ ok: true, text: 'Tags are balanced and supported' });
    }
    if (!report.over) {
      checks.push({ ok: true, text: `Within the ${LIMITS.profile}-character limit (counting line breaks)` });
    }
    if (!report.risky.length) {
      checks.push({ ok: true, text: 'Every glyph is inside the Basic Multilingual Plane' });
    }

    $('ppChecks').innerHTML = checks
      .map((c) => `<li class="${c.ok ? 'pp-ok' : 'pp-bad'}"><span aria-hidden="true">${c.ok ? '✓' : '✕'}</span> ${escapeHtml(c.text)}</li>`)
      .join('');

    $('ppCopy').disabled = !report.ok;
    $('ppCopy').title = report.ok
      ? 'Copy the game-ready text'
      : 'Fix the problems below first — the game would reject this';
  }

  /* ---- actions ---------------------------------------------------- */

  function refresh({ save = true } = {}) {
    pullFromInputs();
    if (save) saveDraft(fields);
    render();
  }

  for (const el of Object.values(inputs)) {
    el.addEventListener('input', () => refresh());
    el.addEventListener('change', () => refresh());
  }
  // Sliders should also update their own readout immediately.
  for (const key of ['soft', 'shy', 'moody', 'warm']) {
    inputs[key].addEventListener('input', () => {
      inputs[key].nextElementSibling.textContent = inputs[key].value;
    });
  }

  templatesEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-template]');
    if (!button) return;
    const template = TEMPLATES.find((t) => t.id === button.dataset.template);
    if (!template) return;
    Object.assign(fields, template.patch);
    pushToInputs();
    refresh();
    syncSliderOutputs();
  });

  function syncSliderOutputs() {
    for (const key of ['soft', 'shy', 'moody', 'warm']) {
      inputs[key].nextElementSibling.textContent = inputs[key].value;
    }
  }

  async function copy() {
    const button = $('ppCopy');
    try {
      await navigator.clipboard.writeText(lastText);
      button.textContent = 'Copied';
    } catch {
      // Clipboard is blocked outside a secure context or without permission;
      // selecting the text is the honest fallback.
      button.textContent = 'Select the preview and copy';
    }
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { button.textContent = 'Copy profile text'; }, 1800);
  }

  $('ppCopy').addEventListener('click', copy);

  $('ppDownload').addEventListener('click', () => {
    const blob = new Blob([lastText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(fields.name || 'profile').replace(/[^\w-]+/g, '-').toLowerCase()}-3dxchat.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $('ppReset').addEventListener('click', () => {
    Object.assign(fields, DEFAULT_FIELDS);
    pushToInputs();
    syncSliderOutputs();
    refresh();
  });

  /* ---- boot ------------------------------------------------------- */

  pushToInputs();
  syncSliderOutputs();
  render();

  // The centring width depends on the pane size, so recompose when it changes.
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => render());
    observer.observe(root.querySelector('.pp-result'));
  }

  return {
    get text() { return lastText; },
    get fields() { return { ...fields }; },
    render,
    set(next) {
      Object.assign(fields, next);
      pushToInputs();
      syncSliderOutputs();
      refresh();
    },
  };
}
