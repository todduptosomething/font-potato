'use strict';
// Browser port of lib/fontbuild.js. Same two-pass build (measure stroke width
// across all glyphs -> re-trace each, nudging weight toward the median so caps
// and lowercase come out even), same slant/spacing math, same always-on
// alternates. Operates directly on the in-memory scan result (no disk, no
// blobs.json/session dir — the browser has no equivalent and doesn't need one).
//
// Scope note: only emits the TTF (WOFF/WOFF2/CSS conversion isn't vendored
// yet — ttf2woff/wawoff2 aren't in the vendor bundle). TTF alone is enough to
// preview (via harfbuzzjs) and install.

import { svgpath, placeGlyph, band } from './vendor.js';
import { adjustWeight, measureStroke } from './weight.js';
import { trace } from './trace.js';
import { buildVariants } from './variants.js';
import { buildTTFWithAlternates } from './assemble.js';
import { PAD } from './templatescan.js';

const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ALT_STRENGTH = 2.3;

function clamp(n, lo, hi) {
  n = Number(n);
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * @param {{labels:Object, blobs:Array<{id,char,blob:Blob,cropSize}>}} scanResult from templatescan.js
 * @param {Object} opts name/weight/smooth/slant/spacing/detail
 * @returns {Promise<{ttf:Uint8Array, glyphs:string[], missing:string[], family:string}>}
 */
async function buildFont(scanResult, opts) {
  const { labels, blobs } = scanResult;
  const byId = new Map(blobs.map((b) => [String(b.id), b]));

  const name = (opts.name && String(opts.name).trim()) || 'My Handwriting';
  const weight = Math.round(clamp(opts.weight, -2, 2));
  const smooth = clamp(opts.smooth, 0, 2);
  const slantDeg = clamp(opts.slant, -20, 20);
  const spacing = opts.spacing == null ? 0 : clamp(opts.spacing, -80, 260);
  const shear = Math.tan((slantDeg * Math.PI) / 180);
  const fineness = clamp(opts.detail == null ? 75 : opts.detail, 0, 100) / 100;
  const traceDetail = 1 - fineness;
  const fillIters = Math.round(6 * (1 - fineness));

  const glyphs = [];
  const seen = new Set();

  // --- Pass 1: collect + measure stroke width in em units --------------------
  const entries = [];
  for (const [id, rawChar] of Object.entries(labels)) {
    if (!rawChar) continue;
    const char = String(rawChar).normalize('NFC');
    if ([...char].length !== 1) continue;
    if (seen.has(char)) continue;
    const b = byId.get(String(id));
    if (!b) continue;
    seen.add(char);

    const swPx = await measureStroke(b.blob);
    const [bot, top] = band(char);
    const inkH = b.cropSize.height - 2 * PAD;
    const scale = inkH > 0 ? (top - bot) / inkH : 1;
    entries.push({ char, blob: b, swPx, scale, emSw: swPx * scale });
  }
  if (!entries.length) {
    const err = new Error('No glyphs to build — nothing is labeled yet.');
    err.code = 'NO_GLYPHS';
    throw err;
  }
  const strokes = entries.map((e) => e.emSw).filter((v) => v > 0).sort((a, b) => a - b);
  const target = strokes.length ? strokes[Math.floor(strokes.length / 2)] : 0;

  // --- Pass 2: re-trace each glyph, nudging weight toward the target ---------
  for (const e of entries) {
    let w = weight;
    if (target > 0 && e.swPx > 0 && e.scale > 0) {
      const desiredCropSw = target / e.scale;
      const norm = Math.round((desiredCropSw - e.swPx) / 2);
      w = Math.max(-6, Math.min(7, weight + Math.max(-4, Math.min(4, norm))));
    }
    let png = await adjustWeight(e.blob.blob, w);
    if (fillIters > 0) {
      png = await adjustWeight(png, fillIters);
      png = await adjustWeight(png, -fillIters);
    }
    const d = await trace(png, { smooth, detail: traceDetail });
    if (!d) continue;

    let { d: placed, advance } = placeGlyph(d, e.blob.cropSize, PAD, e.char, { lsb: 30, rsb: 30 });

    if (shear !== 0 || spacing !== 0) {
      let sp = svgpath(placed);
      if (shear !== 0) sp = sp.matrix([1, 0, shear, 1, 0, 0]);
      if (spacing !== 0) sp = sp.translate(spacing / 2, 0);
      placed = sp.round(1).toString();
      advance = Math.round(advance + spacing);
    }
    glyphs.push({ char: e.char, d: placed, advance });
  }

  if (!glyphs.length) {
    const err = new Error('No glyphs to build — nothing is labeled yet.');
    err.code = 'NO_GLYPHS';
    throw err;
  }

  const glyphList = glyphs.map((g) => ({
    char: g.char,
    advance: g.advance,
    variants: buildVariants({ d: g.d, advance: g.advance }, g.char, 4, ALT_STRENGTH),
  }));
  const ttf = buildTTFWithAlternates(name, glyphList);

  const missing = [...ALPHA].filter((c) => !seen.has(c));
  return { ttf, glyphs: glyphs.map((g) => g.char), missing, family: name };
}

export { buildFont };
