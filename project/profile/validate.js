/**
 * Validation for 3DXChat profile text.
 *
 * The game's profile editor is stricter than a browser: it accepts only
 * `<b>`, `<i>`, `<color>` and `<size>`, requires the tags to be balanced and
 * correctly nested, and counts every tag character against the limit. Text
 * that looks fine in a browser can be rejected outright by the game, so the
 * rules are enforced here rather than discovered after pasting.
 *
 * Verified against the reference editor:
 *   - the counter is `text.length + newlineCount`, capped at 1000
 *   - a CRLF counts twice
 *   - `color` takes a lowercase name or a hex value
 *   - nested tags must close in the reverse order they opened
 */

/** The four tags the 3DXChat profile editor understands. */
export const ALLOWED_TAGS = ['b', 'i', 'color', 'size'];

export const LIMITS = {
  profile: 1000,
  /* Name and title are card fields, not the biography. */
  name: 32,
  title: 12,
};

/** A recognised tag: `<b>`, `</b>`, `<color=#fff>`, `<size=3>`. */
const TAG_RE = /<(\/?)([a-zA-Z]+)(?:=([^<>]*))?>/g;

/**
 * Count the way 3DXChat counts: characters plus line breaks, with CRLF
 * costing two. This is the number the game shows next to the field.
 */
export function countedLength(text) {
  return text.length + (text.match(/\r\n|\r|\n/g) || []).length;
}

/**
 * Walk the tags and report balance, nesting, and unsupported tags.
 * Returns a list of problems; an empty list means the game will accept it.
 */
export function checkTags(text) {
  const problems = [];
  const stack = [];
  let match;

  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(text))) {
    const [full, closing, rawName, value] = match;
    const name = rawName.toLowerCase();
    const line = text.slice(0, match.index).split(/\r\n|\r|\n/).length;

    if (!ALLOWED_TAGS.includes(name)) {
      problems.push({
        line,
        kind: 'unsupported',
        message: `<${rawName}> is not supported by the game; only <b>, <i>, <color> and <size> are`,
      });
      continue;
    }

    if (closing) {
      if (value !== undefined) {
        problems.push({ line, kind: 'syntax', message: `</${name}> must not take a value` });
      }
      if (!stack.length) {
        problems.push({ line, kind: 'unbalanced', message: `</${name}> closes a tag that was never opened` });
        continue;
      }
      const open = stack.pop();
      if (open.name !== name) {
        problems.push({
          line,
          kind: 'nesting',
          message: `</${name}> closes <${open.name}>, which was opened first — tags must close in reverse order`,
        });
      }
      continue;
    }

    if (name === 'color') {
      if (value === undefined || value.trim() === '') {
        problems.push({ line, kind: 'syntax', message: '<color> needs a value, for example <color=#d9a55f>' });
      } else if (!isColour(value.trim())) {
        problems.push({
          line,
          kind: 'syntax',
          message: `<color=${value}> is not a hex colour or a name the client knows — it will render white`,
        });
      }
    }

    if (name === 'size') {
      if (value === undefined || !/^\d{1,2}$/.test(value.trim())) {
        problems.push({ line, kind: 'syntax', message: `<size=${value ?? ''}> needs a whole number, for example <size=14>` });
      }
    }

    if (name === 'b' || name === 'i') {
      if (value !== undefined) {
        problems.push({ line, kind: 'syntax', message: `<${name}> does not take a value (${full})` });
      }
    }

    stack.push({ name, line });
  }

  for (const open of stack) {
    problems.push({
      line: open.line,
      kind: 'unbalanced',
      message: `<${open.name}> is never closed`,
    });
  }

  return problems;
}

/**
 * Colour names the Unity-based client knows. An unrecognised name is not a
 * syntax error the editor reports — it is silently rendered as white, which is
 * worse, because the profile looks fine in the editor and wrong in the game.
 * So a name outside this list is flagged.
 */
export const COLOUR_NAMES = [
  'red', 'green', 'blue', 'white', 'black', 'yellow', 'cyan', 'magenta',
  'gray', 'grey', 'clear',
];

/** A known colour name, or a 3/4/6/8-digit hex value. */
export function isColour(value) {
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) return true;
  return COLOUR_NAMES.includes(value.toLowerCase());
}

/**
 * Glyphs that live inside the Basic Multilingual Plane but are still missing
 * from the client's font, because they come from blocks added only recently.
 *
 * Being BMP is necessary, not sufficient. `⛧` is U+26E7 — inside the plane —
 * and it renders as a box. Checking only the code point range passes it, which
 * is how a "validated" profile ends up full of tofu.
 */
const RISKY_CODEPOINTS = new Set([
  0x26e4, // ⛤ pentagram
  0x26e5, // ⛥
  0x26e6, // ⛦
  0x26e7, // ⛧ inverted pentagram
  0x262c, // ☬
  0x269c, // ⚜
  0x26b2, // ⚲
  0x26d4, // ⛔
  0x1f000, // start of the mahjong / domino blocks
]);

/**
 * Characters that will most likely render as a box in the game client.
 * Returns the distinct offending characters so the UI can name them.
 */
export function riskyGlyphs(text) {
  const bad = new Map();
  for (const char of text) {
    if (char === '\n' || char === '\r' || char === '\t') continue;
    // Compare CODE POINTS, not UTF-16 code units. An emoji is a surrogate
    // pair, so both halves sit inside U+0000–U+FFFF and a range test on the
    // code units would pass every emoji as safe.
    const cp = char.codePointAt(0);
    if (cp <= 0xffff && !RISKY_CODEPOINTS.has(cp)) continue;
    bad.set(char, (bad.get(char) || 0) + 1);
  }
  return [...bad.keys()];
}

/**
 * How many characters a line will actually occupy in the game, ignoring the
 * markup. Centring has to measure this rather than the raw string, or a
 * coloured line gets padded for the length of its own <color> tags and drifts
 * to the right.
 */
export function visibleLength(text) {
  return [...text.replace(TAG_RE_SOURCE, '')].length;
}

const TAG_RE_SOURCE = /<\/?[a-zA-Z]+(?:=[^<>]*)?>/g;

/** Strip the tags, for measuring or for offering a plain-text copy. */
export function stripTags(text) {
  return text.replace(TAG_RE_SOURCE, '');
}

/** Everything the panel needs to report, in one call. */
export function inspect(text) {
  const problems = checkTags(text);
  const risky = riskyGlyphs(text);
  const counted = countedLength(text);

  return {
    counted,
    limit: LIMITS.profile,
    over: counted > LIMITS.profile,
    remaining: LIMITS.profile - counted,
    problems,
    risky,
    ok: problems.length === 0 && counted <= LIMITS.profile,
  };
}
