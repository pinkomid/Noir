# NOIR Photo Studio

A private, in-browser black & white darkroom. Drop in a photograph, choose a film
stock, and develop a finished monochrome print — then export it at full resolution.

Every pixel is processed on your own device with the Canvas API. **Nothing is
uploaded**; there is no backend, no account, and no tracking.

![Preset sheet](tools/out/preset-sheet.png)

---

## Run it

No build step, no dependencies. Any static server will do:

```bash
npm start                 # http://localhost:5173
# or
python3 -m http.server 5173
```

Opening `index.html` straight from disk also works in most browsers, but a real
server is recommended so the ES modules and sample images load cleanly.

---

## The darkroom

### Film stocks

Twelve complete recipes, each a full parameter set rather than a one-tap filter.
Pick one and keep adjusting — nothing is baked in.

| Stock | Character |
| --- | --- |
| NOIR 100 | Signature look: crisp, deep, slightly cool |
| TRI-X 400 | Reportage punch, visible grain, strong blacks |
| VÉRITÉ | Pushed to 1600 — coarse, glowing, contrasty |
| DELTA 3200 | Available-light mush, heavy grain, lifted shadows |
| PAN F 50 | Ultra-fine, tight grain, decisive black point |
| ACROS 100 | Smooth, long tonal ramp, almost grainless |
| T-MAX P3200 | Open shadows, chunky mid-tone grain |
| OPORTO | Soft portrait stock, gentle warm tone |
| SILVER GELATIN | Classic darkroom print with selenium |
| PLATINUM | Alt-process matte, compressed highlights |
| CYANOTYPE | Prussian-blue print, flat and dreamy |
| CARBON | Hard structural contrast, cool cast |

### Adjustments

- **Tone** — exposure (EV), contrast, highlights, shadows, whites, blacks
- **Density & structure** — clarity (local contrast), halation (bloom), matte fade
- **Grain** — amount and size, weighted toward the mid tones like real silver
- **Toning** — seven chemistries with independent strength
- **Channel mix** — red/green/blue weights for the panchromatic response
- **Frame & finish** — vignette (positive values brighten the corners)

### Workflow

- Drag a file anywhere onto the window, paste from the clipboard, or press <kbd>O</kbd>
- <kbd>\</kbd> (hold) or the **Compare** button to flash the untouched negative
- <kbd>⌘/Ctrl</kbd> + scroll or <kbd>+</kbd> / <kbd>−</kbd> to zoom; drag to pan
- <kbd>⌘/Ctrl Z</kbd> / <kbd>⇧⌘Z</kbd> for undo and redo
- <kbd>1</kbd>–<kbd>9</kbd> jump between stocks, <kbd>←</kbd> <kbd>→</kbd> step through all twelve
- <kbd>?</kbd> shows the full shortcut sheet

Choose **Export** to bake the look into a JPEG, PNG or WebP at up to full
resolution. Metadata is not carried over.

---

## How it works

The pipeline mirrors a real darkroom's order of operations:

```
negative ──► clarity (unsharp) ──► halation (bloom) ──► single tonal pass ──► print
                                                         ├ channel mix
                                                         ├ exposure
                                                         ├ tone curve (256-entry LUT)
                                                         ├ film grain
                                                         ├ vignette
                                                         └ toning
```

Two details keep it looking photographic rather than digital:

**A monotonic tone curve.** Contrast, zones and fade are each a monotone map of
`[0,1] → [0,1]`, composed with smooth complementary zone weights. The curve can
therefore never fold back on itself and invert detail, which is what naively
stacked brightness/contrast operations do.

**Grain that scales like film.** Noise is sampled from a three-octave value-noise
field, weighted toward the mid tones, and *resampled by the ratio of the render
surface to the working negative* — so a 1920px export shows the same relative
grain size as the on-screen preview, instead of grain that vanishes when you
upscale.

The tonal pass is a single `getImageData` round-trip for the whole frame, with
cached LUTs, so cost is proportional to pixel count and not to how many controls
you have moved. While a slider is being dragged the preview renders a smaller
draft buffer for responsiveness, then a full-quality pass on release.

### Source layout

```
index.html            markup and dialogs
styles/main.css       the entire design system
js/engine.js          canvas pipeline: LUT, grain field, toning, histogram
js/presets.js         the twelve film stocks
js/controls.js        adjustment panel schema (single source of truth for ranges)
js/ui.js              DOM builders: rail, panel, histogram, modals, toasts
js/app.js             state, history, view, export, keyboard
tools/test-engine.mjs headless checks for the development pipeline
tools/test-ui.mjs     boots the real UI in jsdom and drives the user journeys
```

---

## Tests

The engine is verified against real pixels, including a rendered proof sheet.

```bash
npm i -D @napi-rs/canvas jsdom acorn
node tools/test-engine.mjs      # 30 checks: tonal math, grain, toning, export
node tools/test-ui.mjs          # 36 checks: boot, loading, sliders, undo, export, keys
```

`test-engine.mjs` also writes `tools/out/preset-sheet.png` and a full-resolution
export, so visual regressions are easy to spot.

---

## Browser support

Chrome/Edge 100+, Safari 16.4+, Firefox 105+. Clarity and halation rely on the
Canvas `filter` property; where it is missing the rest of the pipeline degrades
gracefully.

## Licence

MIT
