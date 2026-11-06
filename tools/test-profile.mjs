/**
 * Profile editor checks.
 *
 * Two things are being verified, and they are different in kind:
 *
 *   1. The composition rules — what the text says and how it is laid out.
 *      These are pure functions, so they are tested directly.
 *   2. The validation rules — what the game will accept. A profile that looks
 *      right but is rejected on paste is the failure this exists to prevent,
 *      so the tests assert on the rejections, not just on the happy path.
 *
 * The UI itself is driven through jsdom in test-ui.mjs; this file covers the
 * logic exhaustively, where a browser is not needed.
 *
 *   node tools/test-profile.mjs
 */

import { compose, centre, toFont, wrapWords, wrapText, divider, describeTraits } from '../project/profile/compose.js';
import { inspect, checkTags, countedLength, riskyGlyphs, isColour, visibleLength, stripTags, LIMITS } from '../project/profile/validate.js';
import { FONTS, FONT_ORDER, PALETTES, PALETTE_ORDER, FRAMES, FRAME_BY_ID, ACCENTS, ACCENT_ORDER, DEFAULT_FIELDS, TEMPLATES } from '../project/profile/data.js';

const results = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  results.push({ name, ok });
};

console.log('\nNOIR profile editor test\n');

/* ---- 1. Data integrity --------------------------------------------- */

console.log('Data:');

check('every font has 26 letters in both cases',
  FONT_ORDER.every((id) => [...FONTS[id].u].length === 26 && [...FONTS[id].l].length === 26),
  FONT_ORDER.join(', '));

check('every font is BMP-only',
  FONT_ORDER.every((id) => !riskyGlyphs(FONTS[id].u + FONTS[id].l).length),
  'a supplementary-plane font would render as tofu in the game');

check('every palette has six colours',
  PALETTE_ORDER.every((id) => PALETTES[id].hex.length === 6));

check('every palette colour is a valid hex value',
  PALETTE_ORDER.every((id) => PALETTES[id].hex.every((hex) => /^#[0-9a-f]{6}$/.test(hex))));

check('every frame is balanced and BMP-safe',
  FRAMES.every((f) => !riskyGlyphs(f.top + f.bottom).length),
  FRAMES.filter((f) => riskyGlyphs(f.top + f.bottom).length).map((f) => f.id).join(', '));

check('every accent is BMP-safe', ACCENT_ORDER.every((id) => !riskyGlyphs(ACCENTS[id]).length));

check('frame ids are unique', new Set(FRAMES.map((f) => f.id)).size === FRAMES.length);

check('every template patch names a real frame',
  TEMPLATES.every((t) => !t.patch.frame || FRAME_BY_ID[t.patch.frame]));

check('every template patch names a real palette',
  TEMPLATES.every((t) => !t.patch.palette || PALETTES[t.patch.palette]));

/* ---- 2. Font mapping ------------------------------------------------ */

console.log('\nFonts:');

check('small caps maps upper and lower case',
  toFont('Noir', 'smallcaps') === 'ɴᴏɪʀ',
  toFont('Noir', 'smallcaps'));

check('plain font is the identity',
  toFont('Noir Studio 42!', 'normal') === 'Noir Studio 42!');

check('non-letters pass through untouched',
  toFont('a·b 1 ✦', 'smallcaps').includes('·') && toFont('a·b 1 ✦', 'smallcaps').includes('✦'));

check('an unknown font id returns the text unchanged',
  toFont('Noir', 'does-not-exist') === 'Noir');

/* ---- 3. Line layout ------------------------------------------------- */

console.log('\nLayout:');

const centred = centre('abc', 9);
check('centring pads by visible width', centred.startsWith('   abc'), JSON.stringify(centred));

check('a tagged line is centred on its visible text, not its markup',
  centre('<color=#fff>abc</color>', 9).startsWith('   <color=#fff>abc</color>'),
  'otherwise every coloured line drifts to the right');

check('blank lines are never padded', centre('a\n\nb', 8).split('\n')[1] === '');

check('a line longer than the pane is not padded',
  centre('a'.repeat(20), 5) === 'a'.repeat(20));

const wrapped = wrapWords(['alpha', 'bravo', 'charlie', 'delta'], 20);
check('long rows are wrapped', wrapped.length > 1, `${wrapped.length} rows`);
check('no wrapped row starts with a hanging separator',
  wrapped.every((row) => !row.startsWith('·')), wrapped.join(' | '));
check('every wrapped row fits the width',
  wrapped.every((row) => visibleLength(row) <= 20), wrapped.map(visibleLength).join(','));

check('wrapping keeps every word', 
  ['alpha', 'bravo', 'charlie', 'delta'].every((w) => wrapped.join(' ').includes(w)));

const prose = wrapText('one two three four five six', 12);
check('prose wraps on spaces', prose.every((row) => row.length <= 12), prose.join(' | '));

check('the divider fits the pane', visibleLength(divider('star', 46)) <= 46, `${visibleLength(divider('star', 46))}`);
check('a divider with no accent is a plain rule', divider('none', 10) === '┈'.repeat(10));

/* ---- 4. Trait words ------------------------------------------------- */

console.log('\nTraits:');

check('a quiet profile emits no adjectives',
  describeTraits({ soft: 0, shy: 0, moody: 0, warm: 0 }).length === 0);

check('sliders speak at 2 and 4',
  describeTraits({ soft: 1, shy: 0, moody: 0, warm: 0 }).length === 0 &&
  describeTraits({ soft: 2, shy: 0, moody: 0, warm: 0 }).includes('Gentle') &&
  describeTraits({ soft: 4, shy: 0, moody: 0, warm: 0 }).includes('Soft-hearted'));

check('"Quiet soul" is added once, not per slider',
  describeTraits({ soft: 5, shy: 5, moody: 5, warm: 5 })
    .filter((w) => w === 'Quiet soul').length === 1);

/* ---- 5. Composition ------------------------------------------------- */

console.log('\nComposition:');

const full = compose({ ...DEFAULT_FIELDS, width: 46 });

check('the default draft composes without an undefined colour',
  !full.includes('undefined'), full.includes('undefined') ? 'a palette index is wrong' : '');

check('the default draft is valid',
  inspect(full).ok, JSON.stringify(inspect(full).problems));

check('the default draft fits the limit', !inspect(full).over, `${inspect(full).counted} chars`);

check('the default draft carries no risky glyphs', inspect(full).risky.length === 0);

check('a frame is emitted top and bottom',
  full.indexOf('╭') < full.indexOf('ɴᴏɪʀ') && full.indexOf('╰') > full.indexOf('ɴᴏɪʀ'));

check('the name appears in the chosen font', full.includes('ɴᴏɪʀ'));

check('every coloured line is centred on its visible text', (() => {
  for (const line of full.split('\n')) {
    const bare = line.trimStart();
    if (!bare || bare.startsWith('┈') || bare.startsWith('✧')) continue;
    const pad = line.length - bare.length;
    const expected = Math.max(0, Math.floor((46 - visibleLength(bare)) / 2));
    if (pad !== expected) return false;
  }
  return true;
})(), 'a mismatch means a line drifts off centre in the game');

check('every tag is closed', checkTags(full).length === 0, JSON.stringify(checkTags(full)));

check('no <align> is ever emitted',
  !full.includes('align'), 'the game rejects it');

check('colour tags use hex, never an unknown name',
  [...full.matchAll(/<color=([^>]+)>/g)].every((m) => isColour(m[1])));

check('centring is switched off cleanly', (() => {
  const left = compose({ ...DEFAULT_FIELDS, centreText: false });
  return left.split('\n').every((line) => !line.startsWith(' '));
})());

check('colouring is switched off cleanly', (() => {
  const plain = compose({ ...DEFAULT_FIELDS, colourText: false });
  return !plain.includes('<color');
})());

check('an empty form still composes something valid',
  inspect(compose({ name: '' })).ok, 'nothing should throw');

check('a name alone composes a short profile',
  compose({ name: 'A', frame: 'none', accent: 'none' }).includes('ᴀ'),
  'small caps renders A as ᴀ');

check('all 4 fonts compose validly',
  FONT_ORDER.every((font) => inspect(compose({ ...DEFAULT_FIELDS, font })).ok));

check('all 6 palettes compose validly',
  PALETTE_ORDER.every((palette) => inspect(compose({ ...DEFAULT_FIELDS, palette })).ok));

check('all 10 frames compose validly',
  FRAMES.every((f) => inspect(compose({ ...DEFAULT_FIELDS, frame: f.id })).ok),
  FRAMES.filter((f) => !inspect(compose({ ...DEFAULT_FIELDS, frame: f.id })).ok).map((f) => f.id).join(', '));

check('all accents compose validly',
  ACCENT_ORDER.every((accent) => inspect(compose({ ...DEFAULT_FIELDS, accent })).ok));

check('every template composes validly and fits',
  TEMPLATES.every((t) => {
    const out = compose({ ...DEFAULT_FIELDS, ...t.patch, width: 46 });
    const r = inspect(out);
    return r.ok && !r.over;
  }),
  TEMPLATES.filter((t) => !inspect(compose({ ...DEFAULT_FIELDS, ...t.patch })).ok).map((t) => t.id).join(', '));

check('a very long biography is still inside the limit',
  (() => {
    const out = compose({
      ...DEFAULT_FIELDS,
      greets: Array.from({ length: 8 }, (_, i) => `LINE ${i + 1}`),
      limits: Array.from({ length: 8 }, (_, i) => `LIMIT ${i + 1}`),
      quote: 'x'.repeat(120),
    });
    const r = inspect(out);
    return !r.over;
  })());

/* ---- 6. Validation -------------------------------------------------- */

console.log('\nValidation:');

check('a plain string is valid', inspect('hello').ok);

check('a balanced tag is valid', inspect('<b>hi</b>').ok);

check('an unclosed tag is rejected', !inspect('<b>hi').ok);

check('a bare closing tag is rejected', !inspect('</b>').ok);

check('mis-nested tags are rejected', !inspect('<b><i>x</b></i>').ok);

check('an unsupported tag is rejected', !inspect('<u>x</u>').ok);

check('a supported size is accepted', inspect('<size=14>x</size>').ok);

check('a non-numeric size is rejected', !inspect('<size=abc>x</size>').ok);

check('a colour with no value is rejected', !inspect('<color>x</color>').ok);

check('a hex colour is accepted', inspect('<color=#d9a55f>x</color>').ok);

check('a known colour name is accepted', inspect('<color=red>x</color>').ok);

check('an unknown colour name is rejected',
  !inspect('<color=chartreuse>x</color>').ok,
  'the client renders an unknown name as white rather than failing loudly');

check('"undefined" is not accepted as a colour',
  !inspect('<color=undefined>x</color>').ok,
  'a palette index bug once produced exactly this');

check('the count includes line breaks', countedLength('a\nb') === 4, `${countedLength('a\nb')}`);

check('CRLF counts twice', countedLength('a\r\nb') === 5, `${countedLength('a\r\nb')}`);

check('the limit boundary is exact', (() => {
  const at = 'x'.repeat(LIMITS.profile);
  const over = 'x'.repeat(LIMITS.profile + 1);
  return inspect(at).ok && !inspect(at).over && inspect(over).over;
})());

check('an emoji is reported as risky',
  riskyGlyphs('hi 🔥').length === 1,
  'a UTF-16 range test on code units would miss every emoji');

check('gothic letters are reported as risky',
  riskyGlyphs('𝔏𝔬𝔳𝔢𝔶').length === 5);

check('BMP symbols are not risky',
  riskyGlyphs('♱ ✟ ⊹ ▓ 「」 ═').length === 0);

check('a glyph inside the BMP but missing from the font is still risky',
  riskyGlyphs('⛧').length === 1,
  'U+26E7 is inside the plane, so a range test alone passes it and the client shows a box');

check('every frame avoids font-missing glyphs',
  FRAMES.every((f) => !riskyGlyphs(f.top + f.bottom).length),
  FRAMES.filter((f) => riskyGlyphs(f.top + f.bottom).length).map((f) => f.id).join(', '));

check('every accent avoids font-missing glyphs',
  ACCENT_ORDER.every((id) => !riskyGlyphs(ACCENTS[id]).length));

check('visible length ignores tags', visibleLength('<color=#fff>abc</color>') === 3);

check('stripTags returns the text alone', stripTags('<b>hi</b>') === 'hi');

check('every problem carries a line number',
  checkTags('x\n<b>hi').every((p) => typeof p.line === 'number'));

/* ---- Summary -------------------------------------------------------- */

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
