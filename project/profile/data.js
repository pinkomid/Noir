/**
 * Static data for the profile editor: fonts, palettes, frames, accents.
 *
 * Everything here is chosen for one constraint: the 3DXChat client renders
 * characters from the Basic Multilingual Plane and shows a box for anything
 * above it. So the gothic and double-struck fonts that look good in the
 * browser are deliberately absent — a profile full of tofu is worse than a
 * plain one.
 *
 * The reference profiles this mirrors use small caps, box-drawing rules and
 * a handful of marker glyphs, all of which are BMP.
 */

/** BMP-safe text fonts. `u` and `l` are the 26-letter maps. */
export const FONTS = {
  normal: {
    label: 'Plain',
    u: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    l: 'abcdefghijklmnopqrstuvwxyz',
  },
  smallcaps: {
    label: 'Small caps',
    u: 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘQʀꜱᴛᴜᴠᴡXʏᴢ',
    l: 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘqʀꜱᴛᴜᴠᴡxʏᴢ',
  },
  fullwidth: {
    label: 'Wide',
    u: 'ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ',
    l: 'ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ',
  },
  circled: {
    label: 'Circled',
    u: 'ⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈⓉⓊⓋⓌⓍⓎⓏ',
    l: 'ⓐⓑⓒⓓⓔⓕⓖⓗⓘⓙⓚⓛⓜⓝⓞⓟⓠⓡⓢⓣⓤⓥⓦⓧⓨⓩ',
  },
};

export const FONT_ORDER = ['smallcaps', 'normal', 'fullwidth', 'circled'];

/** Palettes: [name colour, secondary, accent, limits, tertiary, quote]. */
export const PALETTES = {
  'dark-gothic': {
    label: 'Dark gothic',
    hex: ['#e9c4d6', '#d891b2', '#b23a7e', '#9b4fae', '#8464ce', '#e9c4d6'],
  },
  'bright-pink': {
    label: 'Bright pink',
    hex: ['#ffd9e8', '#ffb6c1', '#ff8fc8', '#f863b0', '#e07bcb', '#ca8ffa'],
  },
  midnight: {
    label: 'Midnight',
    hex: ['#c9c6e8', '#9e97d6', '#7168b8', '#4c4694', '#332f70', '#c9c6e8'],
  },
  'rose-gold': {
    label: 'Rose gold',
    hex: ['#fbe6d8', '#f3c9b4', '#e7a98f', '#d98c78', '#c97b6e', '#e0a98f'],
  },
  mono: {
    label: 'Silver',
    hex: ['#ffffff', '#e2e2e2', '#c4c4c4', '#a0a0a0', '#7a7a7a', '#c4c4c4'],
  },
  noir: {
    label: 'NOIR (amber)',
    hex: ['#eae5db', '#d9a55f', '#b8823c', '#8f5d13', '#c9bda6', '#d9a55f'],
  },
};

export const PALETTE_ORDER = ['dark-gothic', 'noir', 'bright-pink', 'midnight', 'rose-gold', 'mono'];

/**
 * Frame pairs. `top`/`bottom` are BMP-only, so they survive the game font.
 * Names describe the corner style, matching the reference profiles.
 */
export const FRAMES = [
  { id: 'none', label: 'None', top: '', bottom: '' },
  // ╭ ╮ ╰ ╯ rounded, the style used in the reference biography
  { id: 'rounded', label: 'Rounded', top: '✧ ╭┈┈┈ ✦ ┈┈┈╮ ✧', bottom: '✧ ╰┈┈┈ ✦ ┈┈┈╯ ✧' },
  { id: 'rounded-star', label: 'Rounded star', top: '✧ ╭┈┈┈ ✦ ┈┈┈╮ ✧', bottom: '✧ ╰┈┈┈ ✦ ┈┈┈╯ ✧' },
  { id: 'rounded-heart', label: 'Rounded heart', top: '♡ ╭┈┈┈ ♡ ┈┈┈╮ ♡', bottom: '♡ ╰┈┈┈ ♡ ┈┈┈╯ ♡' },
  // ╔ ╗ ╚ ╝ heavy, the gothic look
  { id: 'double', label: 'Heavy', top: '✟ ╔═══ ✞ ═══╗ †', bottom: '† ╚═══ ✞ ═══╝ ✟' },
  { id: 'double-moon', label: 'Heavy moon', top: '☾ ╔═══ ☽ ═══╗ ☾', bottom: '☾ ╚═══ ☽ ═══╝ ☾' },
  // ─── rules only, the minimal banded style
  { id: 'rule', label: 'Rules', top: '─── ✦ ───', bottom: '─── ✦ ───' },
  { id: 'rule-long', label: 'Long rule', top: '─────── ◇ ───────', bottom: '─────── ◇ ───────' },
  // ┌ ┐ └ ┘ square
  { id: 'square', label: 'Square', top: '· ┌─── ◈ ───┐ ·', bottom: '· └─── ◈ ───┘ ·' },
  // 「 」 cjk brackets
  { id: 'brackets', label: 'Brackets', top: '☾ 「⋯ ✦ ⋯」 ☽', bottom: '☽ 「⋯ ✦ ⋯」 ☾' },
  // floral
  { id: 'floral', label: 'Floral', top: '♡ ❀⋅⋅⋅ ✦ ⋅⋅⋅❀ ♡', bottom: '♡ ✿⋅⋅⋅ ✦ ⋅⋅⋅✿ ♡' },
];

export const FRAME_BY_ID = Object.fromEntries(FRAMES.map((f) => [f.id, f]));

/** Marker glyphs that sit in the middle of a divider. */
export const ACCENTS = {
  none: '',
  star: '✦',
  sparkle: '✧',
  diamond: '◇',
  cross: '♱',
  shadow: '✞',
  moon: '☾',
  heart: '♡',
  dot: '·',
  flower: '❀',
};

export const ACCENT_ORDER = Object.keys(ACCENTS);

/** The draft's starting point, taken from the reference profile. */
export const DEFAULT_FIELDS = {
  name: 'Noir',
  pronouns: 'sʜᴇ / ʜᴇʀ',
  orientation: 'ᴘᴀɴsᴇxᴜᴀʟ',
  languages: 'ᴇɴ · ꜰᴀ',
  soft: 4,
  shy: 3,
  moody: 2,
  warm: 4,
  greets: ['ꜱʜʏ ᴀᴛ ꜰɪʀꜱᴛ', 'ᴡᴀʀᴍ ᴏɴᴄᴇ ʏᴏᴜ ꜱᴛᴀʏ'],
  limits: ['ɴᴏ ᴄᴏɴᴛʀᴏʟ', 'ɴᴏ ᴠɪᴏʟᴇɴᴄᴇ', 'ɴᴏ ᴘᴜꜱʜʏ ᴇɴᴇʀɢʏ'],
  quote: 'ʙᴇ ɢᴇɴᴛʟᴇ, ʙᴇ ʀᴇᴀʟ.',
  frame: 'rounded',
  accent: 'star',
  palette: 'dark-gothic',
  font: 'smallcaps',
  centreText: true,
  colourText: true,
  width: 46,
};

/** Ready-made starting points, so nobody has to fill a form from scratch. */
export const TEMPLATES = [
  {
    id: 'reference',
    label: 'Reference',
    hint: 'The dark gothic biography this tool is modelled on',
    patch: {},
  },
  {
    id: 'noir',
    label: 'NOIR',
    hint: 'Amber on charcoal, rules instead of corners',
    patch: {
      palette: 'noir',
      frame: 'rule',
      accent: 'diamond',
      name: 'Noir',
      quote: 'ꜱᴛɪʟʟ ᴅᴇᴠᴇʟᴏᴘɪɴɢ.',
    },
  },
  {
    id: 'soft',
    label: 'Soft',
    hint: 'Bright, floral, gentle',
    patch: {
      palette: 'bright-pink',
      frame: 'floral',
      accent: 'heart',
      soft: 5,
      shy: 2,
      moody: 1,
      warm: 5,
    },
  },
  {
    id: 'minimal',
    label: 'Minimal',
    hint: 'A name, two lines, nothing else',
    patch: {
      palette: 'mono',
      frame: 'rule-long',
      accent: 'dot',
      greets: [],
      limits: [],
      quote: '',
    },
  },
];
