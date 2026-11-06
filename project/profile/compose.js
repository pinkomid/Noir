/**
 * Compose 3DXChat profile text from the fields the user fills in.
 *
 * The output has to survive the game's editor, which rejects `<align>`,
 * renders supplementary-plane glyphs as boxes, and counts every tag
 * character against 1000. So composition follows a tight rule set:
 *
 *   - centring uses real leading spaces, never `<align>`
 *   - fonts are limited to scripts inside the Basic Multilingual Plane
 *   - long rows are wrapped, because the client does not wrap them for you
 *   - every emitted tag is closed by construction
 */

import { FONTS, FRAMES, PALETTES, ACCENTS } from './data.js';
import { visibleLength } from './validate.js';

/** Map a string through a BMP font. Characters the font lacks pass through. */
export function toFont(text, fontId) {
  const font = FONTS[fontId];
  if (!font || !text) return text;
  const upper = [...font.u];
  const lower = [...font.l];
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code >= 65 && code <= 90) out += upper[code - 65] ?? char;
    else if (code >= 97 && code <= 122) out += lower[code - 97] ?? char;
    else out += char;
  }
  return out;
}

/**
 * 3DXChat has no <align>, so centring is done the only way the game accepts:
 * pad each line with real spaces. Empty lines stay empty — padding them just
 * spends characters against the limit.
 */
export function centre(text, width = 46) {
  return text
    .split('\n')
    .map((line) => {
      const bare = line.trim();
      if (!bare) return '';
      // Measure what the game will draw, not the tags around it.
      const pad = Math.max(0, Math.floor((width - visibleLength(bare)) / 2));
      return ' '.repeat(pad) + bare;
    })
    .join('\n');
}

/** Wrap a list of words into rows no longer than `max`, breaking on separators. */
export function wrapWords(words, max, separator = '  ·  ') {
  const rows = [];
  let row = '';
  for (const word of words) {
    const next = row ? row + separator + word : word;
    if (row && visibleLength(next) > max) {
      rows.push(row);
      // Start the next row with the word alone, not with a hanging separator.
      row = word;
    } else {
      row = next;
    }
  }
  if (row) rows.push(row);
  return rows;
}

/** Wrap a plain sentence on spaces. */
export function wrapText(text, max) {
  const words = text.split(/\s+/).filter(Boolean);
  const rows = [];
  let row = '';
  for (const word of words) {
    const next = row ? `${row} ${word}` : word;
    if (row && visibleLength(next) > max) {
      rows.push(row);
      row = word;
    } else {
      row = next;
    }
  }
  if (row) rows.push(row);
  return rows;
}

/** Wrap a string in a colour span. */
function colour(text, hex) {
  return text ? `<color=${hex}>${text}</color>` : '';
}

/** The divider row: ┈┈┈ ✦ ┈┈┈, sized so it fits the pane. */
export function divider(accentId, width = 46) {
  const accent = ACCENTS[accentId] ?? '';
  // A divider spans the same space the text is centred in.
  const rule = accent ? Math.max(4, Math.floor((width - 5) / 2)) : Math.floor(width / 2);
  if (!accent) return '┈'.repeat(width);
  return `${'┈'.repeat(rule)}  ${accent}  ${'┈'.repeat(rule)}`;
}

/**
 * Apply colour to a block of already-wrapped lines, unless colouring is off.
 * The switch has to reach every block: one that still emits <color> after the
 * user turned colour off is a bug they cannot work around.
 */
function colouredLines(rows, hex, enabled = true) {
  const kept = rows.filter(Boolean);
  if (!enabled) return kept.join('\n');
  return kept.map((row) => colour(row, hex)).join('\n');
}

/**
 * Build the full profile text.
 *
 * Every field is optional except `name`, so an empty form produces a short,
 * valid profile rather than a skeleton of empty tags.
 */
export function compose(fields) {
  const {
    name = '',
    pronouns = '',
    orientation = '',
    languages = '',
    soft = 0,
    shy = 0,
    moody = 0,
    warm = 0,
    greets = [],
    limits = [],
    quote = '',
    frame = 'none',
    accent = 'star',
    palette = 'dark-gothic',
    font = 'smallcaps',
    centreText = true,
    colourText = true,
    width = 46,
  } = fields;

  const paletteDef = PALETTES[palette] ?? PALETTES['dark-gothic'];
  const [ink, secondary, accentHex, limitHex, tertiary] = paletteDef.hex;

  // The widest a line can get once centred, which is what wrapping has to fit.
  const textWidth = width;

  const blocks = [];
  const frameDef = FRAMES.find((f) => f.id === frame);

  if (frameDef && frameDef.top) blocks.push(frameDef.top);

  const head = [];
  if (name) head.push(colourText ? colour(toFont(name, font), ink) : toFont(name, font));
  const identity = [pronouns, orientation].filter(Boolean).join('  ·  ');
  if (identity) head.push(colourText ? colour(identity, secondary) : identity);
  if (languages) head.push(colourText ? colour(languages, tertiary) : languages);
  if (head.length) blocks.push(head.join('\n'));

  // A divider under the name block, as in the reference profiles.
  if (accent !== 'none' && head.length) blocks.push(divider(accent, width));

  const traits = describeTraits({ soft, shy, moody, warm });
  if (traits.length) {
    blocks.push(colouredLines(wrapWords(traits, textWidth), tertiary, colourText));
  }

  if (greets.length) {
    const rows = wrapWords(greets, textWidth);
    blocks.push(rows.join('\n'));
  }

  if (limits.length) {
    const rows = wrapWords(limits, textWidth);
    blocks.push(colouredLines(rows, limitHex, colourText));
  }

  if (quote) {
    const quoted = `"${quote}"`;
    const rows = wrapText(quoted, textWidth);
    blocks.push(colourText ? colouredLines(rows, secondary) : rows.join('\n'));
  }

  if (frameDef && frameDef.bottom) blocks.push(frameDef.bottom);

  const body = blocks.join('\n\n');
  return centreText ? centre(body, width) : body;
}

/**
 * Turn the four personality sliders into words. A slider only speaks at 2 and
 * 4, so a quiet profile stays quiet instead of being padded with adjectives.
 */
export function describeTraits({ soft = 0, shy = 0, moody = 0, warm = 0 }) {
  const out = [];
  if (soft >= 4) out.push('Soft-hearted');
  else if (soft >= 2) out.push('Gentle');
  if (shy >= 4) out.push('Shy at first');
  else if (shy >= 2) out.push('Reserved');
  if (moody >= 4) out.push('A little moody');
  else if (moody >= 2) out.push('Wistful');
  if (warm >= 4) out.push('Warm with the right people');
  else if (warm >= 2) out.push('Friendly');
  if (out.length) out.push('Quiet soul');
  return [...new Set(out)];
}
