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

Twenty-four complete recipes — twelve darkroom stocks and twelve graphic lab processes — each a full parameter set rather than a one-tap filter.
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

### Themes

A **light** and **dark** theme, toggle with <kbd>T</kbd> or the icon in the
top bar. The choice is remembered, and the app follows your OS setting until
you pick one. The print itself is never tinted — both themes keep it on a
neutral mat so you are judging the photograph, not the UI.

### Graphic effects

The **Effects** tab holds the lab vocabulary: hard threshold, torn threshold,
halftone screens, ordered and error-diffusion dithering, photocopy grime,
risograph misregistration, line screens and print degradation. Thirteen in
all, each with Amount, Cut point and Scale.

Effects run **last** in the pipeline, after the tone curve, so the photograph
underneath still decides the result. Turn Amount to zero to get the plain
print back.

### Twelve graphic stocks

The rail has two families, separated by a rule. The **darkroom** stocks are
film emulations. The **graphic lab** stocks are print processes — Xerox, hard
light, torn edge, newsprint, 1-bit, fax, riso, decayed, burnt, weave,
duotone and poster. They load an effect as well as tone, and the Effects tab
opens with them so the look is a visible dial rather than a mystery.

### Crop & transform

Crop mode shows the **whole photograph**, with the crop window drawn on top —
you can only pull the window outwards if the pixels outside it are still
there. Drag inside the frame to move it, drag a handle to resize it. Changing
**Aspect** reshapes the window immediately, and the lock holds while you
drag. <kbd>Enter</kbd> keeps the crop, <kbd>Esc</kbd> puts it back.

Cropping never stretches: it changes which window of the negative you are
printing, and the print's pixel size follows from that window.



- **Crop** — drag the frame or any of its eight handles, with rule-of-thirds
  guides. <kbd>Enter</kbd> applies, <kbd>Esc</kbd> cancels.
- **Aspect lock** — Free, Original, 1:1, 4:5, 5:4, 3:2, 2:3, 16:9, Scope. The
  lock fits the largest window of that ratio inside the negative.
- **Straighten** — ±45° with an automatic safe crop, so tilting never exposes
  empty corners.
- **Rotate** — 90° steps either way (<kbd>Shift [</kbd> / <kbd>Shift ]</kbd>),
  and **mirror** horizontally (<kbd>M</kbd>) or vertically.

Geometry is applied before any development, so grain, toning and the dodge/burn
mask all follow the print — and the exported file is the crop, not the negative.

### Adjustments

The panel is split into five tabs — **Crop**, **Tone**, **Detail**,
**Effects** and **Print** — so related controls sit together instead of
competing for one long scroll.

- **Tone** — exposure (EV), contrast, highlights, shadows, whites, blacks
- **Manual curve** — drag control points to reshape the print; click to add a
  point, alt-click to remove one. Interpolated with a monotone cubic spline, so
  dragging a handle can never overshoot into a tonal inversion.
- **Density & structure** — clarity (local contrast), halation (bloom), matte fade
- **Grain** — amount and size, weighted toward the mid tones like real silver
- **Toning** — seven chemistries with independent strength
- **Channel mix** — red/green/blue weights for the panchromatic response
- **Local dodge & burn** — paint a mask with the brush, then pull *Strength*
  positive to dodge or negative to burn. Alt-drag erases. Strokes are stored
  as an 8-bit coverage map and applied per pixel, so the edit is genuinely
  local rather than a global gradient.
- **Frame & finish** — vignette (positive values brighten the corners)

### Batch develop

Press **Shift + B** (or hit **Batch** in the toolbar) to queue a whole shoot.
Add files by picking them or dropping them on the dialog, choose format, size
and quality once, then develop them all through the current recipe. Export
either as individual downloads or as a single ZIP — written by hand in
`js/batch.js`, since the app ships no dependencies.

### Workflow

- Drag a file anywhere onto the window, paste from the clipboard, or press <kbd>O</kbd>
- <kbd>\</kbd> (hold) or the **Compare** button to flash the untouched negative
- <kbd>⌘/Ctrl</kbd> + scroll or <kbd>+</kbd> / <kbd>−</kbd> to zoom; drag to pan
- <kbd>⌘/Ctrl Z</kbd> / <kbd>⇧⌘Z</kbd> for undo and redo
- <kbd>1</kbd>–<kbd>9</kbd> jump between stocks, <kbd>←</kbd> <kbd>→</kbd> step through the whole rail
- <kbd>T</kbd> switches light / dark theme
- <kbd>C</kbd> opens the crop frame, <kbd>M</kbd> mirrors, <kbd>Shift [</kbd> / <kbd>Shift ]</kbd> rotate 90°
- <kbd>B</kbd> toggles the brush, <kbd>[</kbd> / <kbd>]</kbd> change its size, <kbd>Alt</kbd> erases
- <kbd>Shift B</kbd> opens batch develop
- <kbd>?</kbd> shows the full shortcut sheet

Choose **Export** to bake the look into a JPEG, PNG or WebP at up to full
resolution. Metadata is not carried over.

---

## How it works

The pipeline mirrors a real darkroom's order of operations:

```
negative ──► geometry ──► clarity (unsharp) ──► halation (bloom) ──► tonal pass ──► print
                                                         ├ channel mix
                                                         ├ exposure
                                                         ├ tone curve (256-entry LUT,
                                                         │    including the manual curve)
                                                         ├ film grain
                                                         ├ vignette
                                                         ├ local mask (dodge/burn)
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
js/fx.js              graphic effects: threshold, halftone, dither, xerox, riso
js/presets.js         the darkroom stocks and the graphic lab
js/controls.js        adjustment panel schema (single source of truth for ranges)
js/ui.js              DOM builders: rail, panel, curve editor, histogram, modals
js/batch.js           batch runner and a dependency-free ZIP writer
js/app.js             state, history, view, brush, export, keyboard
tools/test-engine.mjs headless checks: pipeline, curve, mask, ZIP
tools/test-ui.mjs     boots the real UI in jsdom and drives the user journeys
tools/test-deploy.mjs verifies the Pages build is self-contained
```

---

## Tests

The engine is verified against real pixels, including a rendered proof sheet.

```bash
npm i -D @napi-rs/canvas jsdom
npm test                        # engine + UI suites
npm run build && node tools/test-deploy.mjs
```

- `test-engine.mjs` — 118 checks: tonal math, grain, toning, export, the monotone
  curve (including a monotonicity sweep), the dodge/burn mask, the ZIP writer,
  and the graphic effects (each one must leave both ink and paper and must
  modulate with the image rather than render a uniform screen)
- `test-ui.mjs` — 137 checks: boot, loading, sliders, undo/redo, compare, zoom,
  crop handles, rotation, mirror, straighten, aspect lock, export download,
  panel tabs, crop overlay geometry, aspect lock while dragging, crop
  cancel, the aspect lock staying in sync with its control, the effects tab
  and its menu, loading a graphic stock, light/dark theme, reset, keyboard
- `test-deploy.mjs` — 18 checks: the Pages build ships every referenced file,
  contains no root-absolute paths, and publishes no test tooling

`test-engine.mjs` also writes `tools/out/preset-sheet.png` and a full-resolution
export, so visual regressions are easy to spot.

---

## Deploying to GitHub Pages

The live site is **https://pinkomid.github.io/Noir-Photo-Studio/**.

`.github/workflows/deploy-pages.yml` assembles a minimal `_site` (app files only —
no tests, no tooling), fails the build if any root-absolute path slips in, and
publishes on every push to `main`.

**One-time setup:** in the repository, go to **Settings → Pages → Build and
deployment → Source** and choose **GitHub Actions**. After that the workflow
deploys automatically on each merge to `main`.

`npm run build` produces the same `_site` locally, and `node tools/test-deploy.mjs`
checks it — including that the app still works when served from the
`/Noir-Photo-Studio/` subpath a project page uses.

## Browser support

Chrome/Edge 100+, Safari 16.4+, Firefox 105+. Clarity and halation rely on the
Canvas `filter` property; where it is missing the rest of the pipeline degrades
gracefully.

## Licence

MIT
