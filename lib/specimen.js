'use strict';
// Render a sample sentence in a built font to a PNG — using a REAL text shaper
// (HarfBuzz via harfbuzzjs) so the OpenType `calt` feature is applied and the
// alternate letterforms actually cycle. (Canvas fillText and opentype.js
// getPath do NOT apply calt, which is why an earlier attempt showed identical
// repeats.) harfbuzzjs is ESM-only, so we load it with dynamic import().

const sharp = require('./sharp');

let hbPromise;
function hb() { if (!hbPromise) hbPromise = import('harfbuzzjs'); return hbPromise; }

// Funny potato-themed lines for the opt-in gallery — picked at random per
// specimen so the gallery fills up with variety instead of one repeated line.
// These don't need to be pangrams (cover every letter); renderSpecimenPNG only
// requires the font to cover whatever characters a given line actually uses.
const PHRASES = [
  'This spud has main character energy',
  'Mashed, baked, or fried — I stan all forms',
  'Warning: may cause intense potato cravings',
  'Handwritten by a very dedicated tuber',
  'Some people collect stamps. I collect potatoes.',
  'Small potato, big personality',
  "I whisked my hash browns into existence",
  'Certified 100% farm-to-font potato energy',
  'This font was baked, not installed',
  'Potato Potato Potato — still funny every time',
  'A wise spud once said: season generously',
  'Handwriting so good it deserves a gold star and a baked potato',
];

const ASCENT = 800, DESCENT = -200; // matches the fonts we build

function rand(n) { return Math.floor(Math.random() * n); }

/**
 * @param {Buffer} ttfBuffer a built TTF
 * @param {{emPx?:number, color?:string, text?:string}} opts
 * @returns {Promise<{png:Buffer, text:string}>}
 */
async function renderSpecimenPNG(ttfBuffer, { emPx = 200, color = '#111111', text = null } = {}) {
  const HB = await hb();
  const blob = new HB.Blob(new Uint8Array(ttfBuffer));
  const face = new HB.Face(blob, 0);
  const upem = face.upem || 1000;
  const font = new HB.Font(face);

  const shape = (str) => {
    const buffer = new HB.Buffer();
    buffer.addText(str);
    buffer.guessSegmentProperties();
    HB.shape(font, buffer);
    const glyphs = buffer.getGlyphInfosAndPositions();
    try { buffer.destroy(); } catch { /* noop */ }
    return glyphs;
  };
  // a glyph id of 0 is .notdef → the font is missing that character
  const covered = (glyphs) => !glyphs.some((g) => g.g === 0 || g.codepoint === 0);

  // pick a random pangram the font can fully render
  let chosen = text;
  if (!chosen) {
    const order = [...PHRASES].sort(() => Math.random() - 0.5);
    for (const p of order) { if (covered(shape(p))) { chosen = p; break; } }
    if (!chosen) chosen = order[rand(order.length)];
  }

  const glyphs = shape(chosen);
  let x = 0;
  const pad = 70;
  let paths = '';
  for (const g of glyphs) {
    const gid = g.g !== undefined ? g.g : g.codepoint;
    const ax = g.ax !== undefined ? g.ax : g.xAdvance;
    const dx = (g.dx !== undefined ? g.dx : g.xOffset) || 0;
    const dy = (g.dy !== undefined ? g.dy : g.yOffset) || 0;
    const d = font.glyphToPath(gid);
    if (d && d.length > 2) paths += `<g transform="translate(${(x + dx).toFixed(1)},${dy.toFixed(1)})"><path d="${d}"/></g>`;
    x += ax;
  }

  try { font.destroy(); face.destroy(); blob.destroy(); } catch { /* noop */ }

  // Draw into a canvas with generous margins so nothing clips (descenders reach
  // below the nominal descent, and warped variants can exceed both), then trim
  // to the real ink bounds and add a little breathing room.
  const MARGIN = 260;              // em units of slack above ascent / below descent
  const top = ASCENT + MARGIN;     // baseline sits here in the flipped canvas
  const H = (ASCENT + MARGIN) - (DESCENT - MARGIN);
  const W = x + pad * 2 + MARGIN;  // extra right room for wide/italic variants
  const scale = emPx / upem;
  // glyphToPath is font units, y-up; flip into SVG's y-down space.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(W * scale)}" height="${Math.round(H * scale)}" viewBox="0 0 ${W.toFixed(0)} ${H}">` +
    `<g transform="translate(${pad},${top}) scale(1,-1)" fill="${color}">${paths}</g></svg>`;

  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
  const png = await sharp(Buffer.from(svg))
    .trim()                                                   // crop away the transparent margins
    .extend({ top: 24, bottom: 24, left: 24, right: 24, background: transparent })
    .png()
    .toBuffer();
  return { png, text: chosen };
}

module.exports = { renderSpecimenPNG };
