/**
 * Draw the profile sliders the way the browser will, from the same CSS values.
 *
 * This is headless: it reads --track out of the stylesheet and paints the
 * control with it, so a token that resolves to nothing is visible as a
 * missing track rather than merely suspected. It is not a screenshot.
 *
 *   node tools/render-sliders.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

const css = readFileSync('styles/main.css', 'utf8');
const darkTrack = /:root\s*\{[\s\S]*?--track:\s*([^;]+);/.exec(css)[1].trim();

const W = 620, H = 230;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

// The panel background from the screenshots.
ctx.fillStyle = '#0c0c0e';
ctx.fillRect(0, 0, W, H);

const rows = [['Soft', 2], ['Shy', 4], ['Moody', 4], ['Warm', 4]];
const left = 90, right = W - 50, trackH = 6, thumb = 16;
let y = 46;

ctx.font = '12px sans-serif';
for (const [label, value] of rows) {
  const ratio = value / 5;
  const cy = y;

  ctx.fillStyle = '#b8b2a6';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 20, cy);

  // Unfilled track — this is the part that used to be invisible.
  ctx.fillStyle = darkTrack;
  ctx.beginPath();
  ctx.roundRect(left, cy - trackH / 2, right - left, trackH, 3);
  ctx.fill();
  ctx.strokeStyle = 'rgba(234,229,219,0.16)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Filled portion.
  const fillW = (right - left) * ratio;
  ctx.fillStyle = '#d9a55f';
  ctx.beginPath();
  ctx.roundRect(left, cy - trackH / 2, fillW, trackH, 3);
  ctx.fill();

  // Thumb.
  const tx = left + fillW;
  ctx.fillStyle = '#efeae0';
  ctx.beginPath();
  ctx.arc(tx, cy, thumb / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#0a0a0b';
  ctx.stroke();

  ctx.fillStyle = '#eae5db';
  ctx.textAlign = 'right';
  ctx.fillText(String(value), W - 20, cy);
  ctx.textAlign = 'left';

  y += 46;
}

// Tick labels.
ctx.fillStyle = '#7a746b';
ctx.font = '9.5px sans-serif';
for (let i = 0; i <= 5; i++) {
  const x = left + (right - left) * (i / 5);
  ctx.fillText(String(i), x - 2, y - 6);
}

ctx.fillStyle = 'rgba(255,255,255,0.3)';
ctx.font = '10px sans-serif';
ctx.fillText('headless · track ' + darkTrack + ' · fill ' + '#d9a55f', 20, H - 14);

mkdirSync('tools/out', { recursive: true });
writeFileSync('tools/out/sliders.png', canvas.toBuffer('image/png'));
console.log('wrote tools/out/sliders.png using --track:', darkTrack);
