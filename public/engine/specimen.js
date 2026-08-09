'use strict';
// Renders a sample line in the user's own font to a PNG, for the opt-in
// gallery. This used to happen on the server via HarfBuzz, because Node's
// canvas does NOT apply OpenType features — a specimen rendered there showed
// identical repeated letters instead of cycling alternates. A *browser*
// canvas has no such problem: it shapes text through the same engine the page
// itself uses, so `calt` alternates and `kern` pairs both apply, which is the
// whole point of showing off one of these fonts.

const PHRASES = [
  'This spud has main character energy',
  'Mashed, baked, or fried — I stan all forms',
  'Warning: may cause intense potato cravings',
  'Handwritten by a very dedicated tuber',
  'Some people collect stamps. I collect potatoes.',
  'Small potato, big personality',
  'I whisked my hash browns into existence',
  'Certified 100% farm-to-font potato energy',
  'This font was baked, not installed',
  'Potato Potato Potato — still funny every time',
  'A wise spud once said: season generously',
  'Handwriting so good it deserves a gold star and a baked potato',
];

function pickPhrase() {
  return PHRASES[Math.floor(Math.random() * PHRASES.length)];
}

/**
 * @param {string} fontFamily a font-family already added to document.fonts
 * @param {{text?:string, sizePx?:number, padPx?:number}} [opts]
 * @returns {Promise<{png:Blob, text:string}>}
 */
async function renderSpecimen(fontFamily, { text = null, sizePx = 140, padPx = 48 } = {}) {
  const phrase = text || pickPhrase();
  const font = `${sizePx}px "${fontFamily}"`;

  // Measure first so the canvas fits the line exactly. The ascent/descent
  // actualBoundingBox values come from the real shaped run, so a deep swash
  // or a tall capital won't get clipped.
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font;
  const m = measure.measureText(phrase);
  const ascent = Math.ceil(m.actualBoundingBoxAscent || sizePx * 0.8);
  const descent = Math.ceil(m.actualBoundingBoxDescent || sizePx * 0.25);
  const width = Math.ceil(m.width) + padPx * 2;
  const height = ascent + descent + padPx * 2;

  const canvas = document.createElement('canvas');
  // Render at 2x so the PNG still looks sharp if it's shown large.
  const dpr = 2;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#111111';
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(phrase, padPx, padPx + ascent);

  const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return { png, text: phrase };
}

export { renderSpecimen, pickPhrase, PHRASES };
