/**
 * Render the profile templates to a PNG, the way the game would draw them.
 *
 * This is a headless preview, not a browser screenshot: it parses the
 * composed text, applies the colours, and draws it on a canvas. It proves the
 * text and the palette are right; it does not prove the layout of the app.
 *
 *   node tools/render-profile.mjs
 */

import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync, mkdirSync } from 'node:fs';
import { compose } from '../project/profile/compose.js';
import { DEFAULT_FIELDS, TEMPLATES } from '../project/profile/data.js';
import { stripTags } from '../project/profile/validate.js';

/** Split a composed line into runs of { text, colour }. */
function parseLine(line) {
  const runs = [];
  let rest = line;
  const re = /<color=(#[0-9a-f]{6})>(.*?)<\/color>/;
  let match;
  while ((match = re.exec(rest))) {
    if (match.index > 0) runs.push({ text: rest.slice(0, match.index), colour: null });
    runs.push({ text: match[2], colour: match[1] });
    rest = rest.slice(match.index + match[0].length);
  }
  if (rest) runs.push({ text: rest, colour: null });
  return runs;
}

function renderCard(fields, width = 460) {
  const text = compose({ ...fields, width: 44 });
  const lines = text.split('\n').map(parseLine);

  const lineHeight = 24;
  const padX = 26;
  const height = Math.max(320, lines.length * lineHeight + 100);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // The profile card: dark violet, with the soft top glow the game uses.
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, '#2a1226');
  bg.addColorStop(0.5, '#1b0d1a');
  bg.addColorStop(1, '#12080f');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createRadialGradient(width / 2, 0, 10, width / 2, 0, width);
  glow.addColorStop(0, 'rgba(178,58,126,0.30)');
  glow.addColorStop(1, 'rgba(178,58,126,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height * 0.8);

  ctx.textBaseline = 'middle';
  ctx.font = '15px sans-serif';

  let y = 56;
  for (const runs of lines) {
    // Centring is leading spaces in the source, so the drawing starts at an
    // x-offset rather than being centred by the canvas.
    let leading = 0;
    if (runs.length && runs[0].colour === null) {
      leading = (runs[0].text.match(/^ */) || [''])[0].length;
      runs[0] = { ...runs[0], text: runs[0].text.replace(/^ +/, '') };
    }

    let x = padX + leading * 4.6;
    for (const run of runs) {
      ctx.fillStyle = run.colour || '#e9d8e8';
      ctx.fillText(run.text, x, y);
      x += ctx.measureText(run.text).width;
    }
    y += lineHeight;
  }

  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = '10px sans-serif';
  ctx.fillText(`headless render · ${stripTags(text).length} visible chars`, padX, height - 18);

  return canvas;
}

const cards = [
  ['reference', { ...DEFAULT_FIELDS }],
  ...[...TEMPLATES].filter((t) => t.id !== 'reference')
    .map((t) => [t.id, { ...DEFAULT_FIELDS, ...t.patch }]),
].map(([, fields]) => renderCard(fields));

const width = cards.reduce((total, card) => total + card.width + 16, 16);
const height = Math.max(...cards.map((card) => card.height)) + 32;

const sheet = createCanvas(width, height);
const sctx = sheet.getContext('2d');
sctx.fillStyle = '#0a0a0b';
sctx.fillRect(0, 0, width, height);

let x = 16;
for (const card of cards) {
  sctx.drawImage(card, x, 16);
  x += card.width + 16;
}

mkdirSync('tools/out', { recursive: true });
writeFileSync('tools/out/profile-templates.png', sheet.toBuffer('image/png'));
console.log(`wrote tools/out/profile-templates.png ${width}x${height}`);
