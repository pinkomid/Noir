/**
 * NOIR Photo Studio — UI construction helpers
 * ------------------------------------------------------------
 * Pure DOM builders. No application state lives here; callers own the
 * parameters and get told when the user changes one.
 */

import { GROUPS, formatValue, valueRatio, CURVE_POINTS } from './controls.js';
import { TONES } from './presets.js';
import { curveInterpolator } from './engine.js';

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}

/* ------------------------------------------------------------------ */
/* Film stock rail                                                     */
/* ------------------------------------------------------------------ */

export function buildPresetRail(container, presets, thumbUrl, onSelect) {
  const buttons = new Map();

  for (const preset of presets) {
    const thumb = el('span', { class: 'preset-thumb', 'aria-hidden': 'true' });
    thumb.style.backgroundImage = `url("${thumbUrl}")`;
    if (preset.thumb) thumb.style.setProperty('--thumb-filter', preset.thumb);

    const button = el(
      'button',
      {
        class: 'preset',
        type: 'button',
        role: 'option',
        'aria-selected': 'false',
        dataset: { id: preset.id },
        title: `${preset.name} — ${preset.sub}`,
      },
      [
        thumb,
        el('span', { class: 'preset-meta' }, [
          el('span', { class: 'preset-name', text: preset.name }),
          el('span', { class: 'preset-sub', text: preset.sub }),
        ]),
        preset.key ? el('span', { class: 'preset-key', text: preset.key, 'aria-hidden': 'true' }) : null,
      ]
    );

    button.addEventListener('click', () => onSelect(preset.id));
    buttons.set(preset.id, button);
    container.append(button);
  }

  return {
    setActive(id) {
      for (const [key, button] of buttons) {
        button.setAttribute('aria-selected', String(key === id));
        button.tabIndex = key === id ? 0 : -1;
      }
      const active = buttons.get(id);
      if (active && container.scrollHeight > container.clientHeight + 4) {
        const top = active.offsetTop - container.offsetTop;
        if (top < container.scrollTop || top + active.offsetHeight > container.scrollTop + container.clientHeight) {
          container.scrollTo({ top: top - container.clientHeight / 2 + active.offsetHeight / 2, behavior: 'smooth' });
        }
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Adjustment panel                                                    */
/* ------------------------------------------------------------------ */

/**
 * @param {HTMLElement} container
 * @param {object} handlers { onChange(id, value, {commit}), onReset(id) }
 */
export function buildPanel(container, handlers) {
  const rows = new Map();      // id → { row, input, valueEl, control, group }
  const groups = new Map();    // id → { node, dot }

  for (const group of GROUPS) {
    const body = el('div', { class: 'group-body' }, [el('div')]);
    const inner = body.firstElementChild;

    const dot = el('span', { class: 'group-dot', 'aria-hidden': 'true' });
    const chevron = el('span', { class: 'group-chevron', text: '▾', 'aria-hidden': 'true' });

    const head = el(
      'button',
      {
        class: 'group-head',
        type: 'button',
        'aria-expanded': String(group.open !== false),
      },
      [el('span', { class: 'group-title', text: group.title }), dot, chevron]
    );

    const node = el('section', { class: 'group', dataset: { group: group.id, open: String(group.open !== false) } }, [head, body]);

    head.addEventListener('click', () => {
      const open = node.dataset.open === 'true' ? 'false' : 'true';
      node.dataset.open = open;
      head.setAttribute('aria-expanded', open);
    });

    for (const control of group.controls) {
      if (control.type === 'note') {
        inner.append(el('p', { class: 'group-note', text: control.label }));
        continue;
      }
      if (control.type === 'slider') {
        const built = buildSlider(control, handlers);
        rows.set(control.id, { ...built, control, group: group.id });
        inner.append(built.row);
      } else if (control.type === 'segmented') {
        const built = buildSegmented(control, handlers);
        rows.set(control.id, { ...built, control, group: group.id });
        inner.append(built.row);
      } else if (control.type === 'toggle') {
        const built = buildToggle(control, handlers);
        rows.set(control.id, { ...built, control, group: group.id });
        inner.append(built.row);
      } else if (control.type === 'curve') {
        const built = buildCurve(control, handlers);
        rows.set(control.id, { ...built, control, group: group.id });
        inner.append(built.row);
      }
    }

    groups.set(group.id, { node, dot });
    container.append(node);
  }

  return {
    rows,
    groups,

    /** Push parameter values into the controls. */
    sync(params, presetParams) {
      const modifiedGroups = new Set();

      for (const [id, entry] of rows) {
        const value = params[id];
        const isModified = String(value) !== String(entry.control.def);
        if (isModified) modifiedGroups.add(entry.group);

        if (entry.control.type === 'slider') {
          if (entry.input.value !== String(value)) {
            entry.input.value = String(value);
          }
          entry.input.style.setProperty('--fill', `${(valueRatio(entry.control, value) * 100).toFixed(2)}%`);
          entry.valueEl.textContent = formatValue(entry.control, value);
          entry.row.classList.toggle('is-modified', isModified);
        } else if (entry.control.type === 'toggle') {
          entry.switch.setAttribute('aria-checked', String(!!value));
          entry.row.classList.toggle('is-modified', isModified);
        } else if (entry.control.type === 'curve') {
          entry.setPoints(value);
          entry.row.classList.toggle('is-modified', isModified);
        } else {
          for (const button of entry.buttons) {
            button.setAttribute('aria-pressed', String(button.dataset.value === String(value)));
          }
          entry.row.classList.toggle('is-modified', isModified);
        }
      }

      for (const [id, group] of groups) {
        group.node.classList.toggle('modified', modifiedGroups.has(id));
      }
    },

    setEnabled(enabled) {
      container.classList.toggle('is-empty', !enabled);
    },

    openGroup(id, open = true) {
      const group = groups.get(id);
      if (!group) return;
      group.node.dataset.open = String(open);
      group.node.querySelector('.group-head').setAttribute('aria-expanded', String(open));
    },
  };
}

function buildSlider(control, handlers) {
  const valueEl = el('output', { class: 'slider-value' });
  const labelEl = el('span', { class: 'slider-label', text: control.label });

  const input = el('input', {
    type: 'range',
    min: control.min,
    max: control.max,
    step: control.step,
    value: control.def,
    'aria-label': control.label,
  });

  input.style.setProperty('--fill', `${(valueRatio(control, control.def) * 100).toFixed(2)}%`);

  input.addEventListener('input', () => {
    const value = Number(input.value);
    input.style.setProperty('--fill', `${(valueRatio(control, value) * 100).toFixed(2)}%`);
    valueEl.textContent = formatValue(control, value);
    handlers.onChange(control.id, value, { commit: false });
  });

  input.addEventListener('change', () => {
    handlers.onChange(control.id, Number(input.value), { commit: true });
  });

  // Double-click the label to return the control to its default.
  const head = el('div', { class: 'slider-top' }, [labelEl, valueEl]);
  labelEl.addEventListener('dblclick', () => handlers.onReset(control.id));
  labelEl.title = 'Double-click to reset';

  const row = el('div', { class: 'slider-row' }, [head, input]);
  return { row, input, valueEl };
}

function buildSegmented(control, handlers) {
  const buttons = TONES.map((tone) =>
    el('button', {
      type: 'button',
      text: tone.name,
      'aria-pressed': String(tone.id === control.def),
      dataset: { value: tone.id },
      title: tone.name,
      onclick: () => handlers.onChange(control.id, tone.id, { commit: true }),
    })
  );

  const row = el('div', { class: 'slider-row' }, [
    el('div', { class: 'slider-top' }, [el('span', { class: 'slider-label', text: control.label })]),
    el('div', { class: 'segmented', role: 'group', 'aria-label': control.label }, buttons),
  ]);

  return { row, buttons };
}

function buildToggle(control, handlers) {
  const switchEl = el('button', {
    class: 'switch',
    type: 'button',
    role: 'switch',
    'aria-checked': 'false',
    'aria-label': control.label,
  });

  const row = el('div', { class: 'toggle-row' }, [
    el('span', { class: 'toggle-label', text: control.label }),
    switchEl,
  ]);

  const flip = () => {
    const next = switchEl.getAttribute('aria-checked') !== 'true';
    switchEl.setAttribute('aria-checked', String(next));
    handlers.onChange(control.id, next, { commit: true });
  };

  switchEl.addEventListener('click', flip);
  row.addEventListener('click', (event) => {
    if (event.target !== switchEl) flip();
  });

  return { row, switch: switchEl };
}

/**
 * Interactive tone curve. Drag a point to reshape, click empty space to add
 * a point, right-click (or Alt-click) a point to remove it. The curve is
 * evaluated with the same monotone spline the engine uses, so what you see
 * here is exactly what the print gets.
 */
function buildCurve(control, handlers) {
  const CURVE_W = 260;
  const CURVE_H = 160;
  const canvas = el('canvas', {
    class: 'curve-canvas',
    width: CURVE_W,
    height: CURVE_H,
    role: 'application',
    'aria-label': 'Tone curve — drag points to reshape',
    tabindex: '0',
  });

  const hint = el('div', { class: 'curve-hint', text: 'Click to add · alt-click to remove · drag to shape' });
  const resetBtn = el('button', { class: 'link-btn curve-reset', type: 'button', text: 'Reset curve' });

  const row = el('div', { class: 'curve-wrap' }, [canvas, el('div', { class: 'curve-foot' }, [hint, resetBtn])]);

  let points = CURVE_POINTS.map((p) => [p[0], p[1]]);
  let dragIndex = -1;
  let hoverIndex = -1;

  const ctx = canvas.getContext('2d');

  function draw() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== CURVE_W * dpr) {
      canvas.width = CURVE_W * dpr;
      canvas.height = CURVE_H * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, CURVE_W, CURVE_H);

    // Plate
    ctx.fillStyle = '#0a0a0b';
    ctx.fillRect(0, 0, CURVE_W, CURVE_H);

    // Grid
    ctx.strokeStyle = 'rgba(234,229,219,0.07)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const gx = (CURVE_W / 4) * i;
      const gy = (CURVE_H / 4) * i;
      ctx.beginPath();
      ctx.moveTo(gx, 0); ctx.lineTo(gx, CURVE_H);
      ctx.moveTo(0, gy); ctx.lineTo(CURVE_W, gy);
      ctx.stroke();
    }

    // Identity reference
    ctx.strokeStyle = 'rgba(234,229,219,0.12)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, CURVE_H);
    ctx.lineTo(CURVE_W, 0);
    ctx.stroke();
    ctx.setLineDash([]);

    // The curve itself
    const evalCurve = curveInterpolator(points);
    ctx.beginPath();
    for (let i = 0; i <= CURVE_W; i++) {
      const x = i / CURVE_W;
      const y = Math.min(1, Math.max(0, evalCurve(x)));
      const px = x * CURVE_W;
      const py = CURVE_H - y * CURVE_H;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = '#d9a55f';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // Fill under the curve
    ctx.lineTo(CURVE_W, CURVE_H);
    ctx.lineTo(0, CURVE_H);
    ctx.closePath();
    ctx.fillStyle = 'rgba(217,165,95,0.08)';
    ctx.fill();

    // Handles
    points.forEach(([x, y], i) => {
      const px = x * CURVE_W;
      const py = CURVE_H - y * CURVE_H;
      const active = i === dragIndex || i === hoverIndex;
      ctx.beginPath();
      ctx.arc(px, py, active ? 5 : 3.6, 0, Math.PI * 2);
      ctx.fillStyle = active ? '#f2eee4' : '#d9a55f';
      ctx.fill();
      ctx.strokeStyle = '#0a0a0b';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    });
  }

  function toLocal(event) {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / (rect.width || CURVE_W);
    const y = 1 - (event.clientY - rect.top) / (rect.height || CURVE_H);
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
  }

  function nearest(event, tolerance = 0.055) {
    const rect = canvas.getBoundingClientRect();
    const [mx, my] = toLocal(event);
    let best = -1;
    let bestDist = Infinity;
    points.forEach(([x, y], i) => {
      const dx = (x - mx) * ((rect.width || CURVE_W) / CURVE_W);
      const dy = (y - my) * ((rect.height || CURVE_H) / CURVE_H);
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    return bestDist <= tolerance ? best : -1;
  }

  function emit(commit) {
    points.sort((a, b) => a[0] - b[0]);
    handlers.onChange(control.id, points.map((p) => [p[0], p[1]]), { commit });
  }

  canvas.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const hit = nearest(event);

    if (hit >= 0 && (event.altKey || event.button === 2)) {
      // Endpoints stay put so the curve always spans the full range.
      if (hit !== 0 && hit !== points.length - 1) {
        points.splice(hit, 1);
        dragIndex = -1;
        draw();
        emit(true);
      }
      return;
    }

    if (hit >= 0) {
      dragIndex = hit;
    } else {
      const [x, y] = toLocal(event);
      points.push([x, y]);
      points.sort((a, b) => a[0] - b[0]);
      dragIndex = points.findIndex((p) => p[0] === x && p[1] === y);
    }
    draw();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (dragIndex < 0) {
      const hit = nearest(event);
      if (hit !== hoverIndex) {
        hoverIndex = hit;
        canvas.style.cursor = hit >= 0 ? 'grab' : 'crosshair';
        draw();
      }
      return;
    }

    const [rawX, rawY] = toLocal(event);
    const isFirst = dragIndex === 0;
    const isLast = dragIndex === points.length - 1;
    const minGap = 0.02;

    // Endpoints are locked to the edges horizontally, free vertically.
    const x = isFirst ? 0 : isLast ? 1
      : Math.min(points[dragIndex + 1][0] - minGap, Math.max(points[dragIndex - 1][0] + minGap, rawX));

    points[dragIndex] = [x, rawY];
    draw();
    handlers.onChange(control.id, points.map((p) => [p[0], p[1]]), { commit: false });
  });

  function endDrag() {
    if (dragIndex < 0) return;
    dragIndex = -1;
    canvas.style.cursor = 'crosshair';
    draw();
    emit(true);
  }

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    if (dragIndex < 0 && hoverIndex !== -1) { hoverIndex = -1; draw(); }
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  resetBtn.addEventListener('click', () => {
    points = CURVE_POINTS.map((p) => [p[0], p[1]]);
    draw();
    emit(true);
  });

  canvas.style.cursor = 'crosshair';
  draw();

  return {
    row,
    canvas,
    setPoints(value) {
      if (!Array.isArray(value) || !value.length) return;
      // Ignore echoes of the array we just emitted.
      if (dragIndex >= 0) return;
      if (value.length === points.length && value.every((p, i) => Math.abs(p[0] - points[i][0]) < 1e-6 && Math.abs(p[1] - points[i][1]) < 1e-6)) return;
      points = value.map((p) => [p[0], p[1]]);
      draw();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Histogram                                                           */
/* ------------------------------------------------------------------ */

const TONE_HUE = {
  neutral: [234, 229, 219],
  selenium: [206, 216, 236],
  warm: [232, 200, 152],
  platinum: [222, 210, 186],
  sepia: [214, 168, 112],
  cyan: [128, 186, 224],
  cool: [180, 206, 232],
};

export function drawHistogram(canvas, hist, params) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || 190;
  const cssH = canvas.clientHeight || 34;

  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  if (!hist) return;

  const { bins } = hist;
  const rgb = TONE_HUE[params.tone] || TONE_HUE.neutral;
  const strength = Math.max(0, Math.min(1, params.toneStrength / 100));
  const r = Math.round(234 + (rgb[0] - 234) * strength);
  const g = Math.round(229 + (rgb[1] - 229) * strength);
  const b = Math.round(219 + (rgb[2] - 219) * strength);

  // Log-ish scaling keeps the shadow spikes readable.
  const scaled = new Float32Array(256);
  let max = 0;
  for (let i = 0; i < 256; i++) {
    const v = Math.log1p(bins[i]);
    scaled[i] = v;
    if (v > max) max = v;
  }
  if (max <= 0) return;

  const gradient = ctx.createLinearGradient(0, 0, cssW, 0);
  gradient.addColorStop(0, `rgba(${r},${g},${b},0.30)`);
  gradient.addColorStop(0.55, `rgba(${r},${g},${b},0.85)`);
  gradient.addColorStop(1, `rgba(${r},${g},${b},0.30)`);

  // Fill
  ctx.beginPath();
  ctx.moveTo(0, cssH);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * cssW;
    const y = cssH - (scaled[i] / max) * (cssH - 1.5);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(cssW, cssH);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.globalAlpha = 0.55;
  ctx.fill();
  ctx.globalAlpha = 1;

  // Line
  ctx.beginPath();
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * cssW;
    const y = cssH - (scaled[i] / max) * (cssH - 1.5);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = `rgba(${r},${g},${b},0.9)`;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Baseline
  ctx.beginPath();
  ctx.moveTo(0, cssH - 0.5);
  ctx.lineTo(cssW, cssH - 0.5);
  ctx.strokeStyle = 'rgba(234,229,219,0.12)';
  ctx.stroke();
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

let toastStack = null;

export function initToasts(node) {
  toastStack = node;
}

export function toast(message, { accent = false, timeout = 2600 } = {}) {
  if (!toastStack) return;
  const node = el('div', { class: `toast${accent ? ' toast-accent' : ''}`, role: 'status', text: message });
  toastStack.append(node);

  // Keep the stack short.
  while (toastStack.children.length > 3) toastStack.firstElementChild.remove();

  setTimeout(() => {
    node.classList.add('out');
    node.addEventListener('animationend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 400);
  }, timeout);
}

/* ------------------------------------------------------------------ */
/* Modals                                                              */
/* ------------------------------------------------------------------ */

export function initModals() {
  const stack = [];

  for (const modal of $$('.modal')) {
    modal.addEventListener('click', (event) => {
      if (event.target.closest('[data-close-modal]')) closeModal(modal);
    });
  }

  function openModal(modal) {
    if (!modal || stack.includes(modal)) return;
    modal.hidden = false;
    stack.push(modal);
    const focusable = modal.querySelector('select, input, button');
    if (focusable) setTimeout(() => focusable.focus(), 40);
  }

  function closeModal(modal) {
    const target = modal || stack[stack.length - 1];
    if (!target) return;
    target.hidden = true;
    const i = stack.indexOf(target);
    if (i >= 0) stack.splice(i, 1);
  }

  function closeTop() {
    if (stack.length) closeModal(stack[stack.length - 1]);
    return stack.length > 0;
  }

  return { openModal, closeModal, closeTop, get isOpen() { return stack.length > 0; } };
}
