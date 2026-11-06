/**
 * NOIR Photo Studio — batch development
 * ------------------------------------------------------------
 * Queue several negatives, develop them all through the current recipe,
 * and export as a set of files or a single ZIP (written by hand, since
 * the browser has no archiver and we ship no dependencies).
 */

import { Darkroom } from './engine.js';
import { frameSize, FRAME_DEFAULTS } from './geometry.js';

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/* ------------------------------------------------------------------ */
/* Minimal ZIP writer (store-only, no compression)                     */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Build a ZIP archive from [{ name, data: Uint8Array }].
 * Store method only — the payloads are already-compressed images, so
 * deflating them would add cost for no gain.
 */
export function createZip(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  const dosTime = 0;
  const dosDate = (() => {
    const d = new Date();
    return ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  })();

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);

    // Local file header
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);   // signature
    lv.setUint16(4, 20, true);           // version needed
    lv.setUint16(6, 0x0800, true);       // UTF-8 filenames
    lv.setUint16(8, 0, true);            // store
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);           // extra length
    local.set(nameBytes, 30);

    chunks.push(local, data);

    // Central directory record
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);           // version made by
    cv.setUint16(6, 20, true);           // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);           // comment length
    cv.setUint16(34, 0, true);           // disk
    cv.setUint16(36, 0, true);           // internal attrs
    cv.setUint32(38, 0, true);           // external attrs
    cv.setUint32(42, offset, true);      // local header offset
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const chunk of chunks) { out.set(chunk, p); p += chunk.length; }
  for (const c of central) { out.set(c, p); p += c.length; }
  out.set(end, p);
  return out;
}

/* ------------------------------------------------------------------ */
/* Batch runner                                                        */
/* ------------------------------------------------------------------ */

export class BatchJob {
  constructor() {
    this.items = [];       // { id, file, name, status, blob, error }
    this.running = false;
    this.cancelled = false;
    this.engine = new Darkroom();
  }

  get count() {
    return this.items.length;
  }

  get pending() {
    return this.items.filter((item) => item.status === 'queued').length;
  }

  get done() {
    return this.items.filter((item) => item.status === 'done').length;
  }

  add(file) {
    if (!file || !file.type.startsWith('image/')) return null;
    const item = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      file,
      name: file.name || 'untitled',
      status: 'queued',
      blob: null,
      error: null,
      thumb: null,
    };
    this.items.push(item);
    return item;
  }

  remove(id) {
    this.items = this.items.filter((item) => item.id !== id);
  }

  clear() {
    this.items = [];
  }

  cancel() {
    this.cancelled = true;
  }

  /**
   * Develop every queued negative.
   * @param {object} params the current recipe
   * @param {{ format?: string, quality?: number, longEdge?: number, onProgress?: Function }} options
   */
  async run(params, options = {}) {
    if (this.running) return [];
    this.running = true;
    this.cancelled = false;

    const {
      format = 'image/jpeg',
      quality = 0.92,
      longEdge = 0,
      onProgress = () => {},
    } = options;

    const queue = this.items.filter((item) => item.status === 'queued' || item.status === 'error');
    const results = [];

    for (let i = 0; i < queue.length; i++) {
      if (this.cancelled) break;
      const item = queue[i];
      item.status = 'working';
      item.error = null;
      onProgress({ index: i, total: queue.length, item });

      try {
        const blob = await this._developOne(item.file, params, { format, quality, longEdge });
        item.blob = blob;
        item.status = 'done';
        results.push({ item, blob });
      } catch (error) {
        item.status = 'error';
        item.error = error && error.message ? error.message : String(error);
        // Keep the reason reachable for diagnostics and tests.
        BatchJob.lastError = item.error;
        if (typeof console !== 'undefined') console.warn('[noir batch]', item.name, item.error);
      }

      onProgress({ index: i + 1, total: queue.length, item });
      // Yield so the UI can paint between frames.
      await new Promise((resolve) => setTimeout(resolve, 12));
    }

    this.running = false;
    return results;
  }

  async _developOne(file, params, { format, quality, longEdge }) {
    const url = URL.createObjectURL(file);
    try {
      const img = await decode(url);

      // Every negative gets the same crop recipe as the one on screen. If the
      // crop would land outside a differently-shaped photo, fall back to the
      // full frame rather than cutting off the subject.
      const frame = params.frame && this._frameFits(params.frame, img.naturalWidth, img.naturalHeight)
        ? params.frame
        : FRAME_DEFAULTS;

      this.engine.load(img, img.naturalWidth, img.naturalHeight, frame);

      const size = frameSize(frame, this.engine.negative);
      const long = Math.max(size.width, size.height);
      const scale = longEdge && longEdge < long ? longEdge / long : 1;
      const w = Math.max(1, Math.round(size.width * scale));
      const h = Math.max(1, Math.round(size.height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');

      if (format === 'image/jpeg') {
        ctx.fillStyle = '#0a0a0b';
        ctx.fillRect(0, 0, w, h);
      }

      this.engine.develop(ctx, w, h, params, { source: this.engine.source });

      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, format, format === 'image/png' ? undefined : quality)
      );
      if (!blob) throw new Error('encoder failed');
      return blob;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** A crop is only safe on negatives at least as large as the reference. */
  _frameFits(frame, width, height) {
    if (!frame || !frame.crop) return true;
    const c = frame.crop;
    if (c.w <= 0 || c.h <= 0) return false;
    // Refuse crops that were drawn on a much smaller source.
    return !this._reference || (width >= this._reference.width * 0.85 && height >= this._reference.height * 0.85);
  }

  /** Remember the negative the crop was authored on. */
  setReference(width, height) {
    this._reference = { width, height };
  }

  /** Build the archive for everything that finished. */
  async archive(baseName, format) {
    const finished = this.items.filter((item) => item.status === 'done' && item.blob);
    const used = new Set();
    const entries = [];

    for (const item of finished) {
      const stem = (item.name.replace(/\.[^.]+$/, '') || 'noir')
        .replace(/[^\w\-. ]+/g, '-')
        .slice(0, 80);
      let name = `${stem}-noir.${EXT[format] || 'jpg'}`;
      let n = 2;
      while (used.has(name)) {
        name = `${stem}-noir-${n++}.${EXT[format] || 'jpg'}`;
      }
      used.add(name);
      entries.push({ name, data: new Uint8Array(await item.blob.arrayBuffer()) });
    }

    return createZip(entries);
  }
}

function decode(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode failed'));
    img.src = src;
  });
}
