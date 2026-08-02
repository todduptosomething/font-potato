'use strict';
// Build a font from an already-segmented workdir (blobs.json + crops) plus a
// label map, reusing draw-your-font's own trace/metrics/assemble internals so
// output quality matches the CLI exactly — then layering slant/width transforms
// that the CLI does not offer, applied to the placed glyph path in em space.

const fs = require('fs');
const path = require('path');
const svgpath = require('svgpath');
const sharp = require('./sharp');

// Deep-require the installed package's internals (no "exports" restriction).
const { adjustWeight } = require('draw-your-font/src/trace');
const { trace } = require('./trace2');
const { placeGlyph, band } = require('draw-your-font/src/metrics');
const { buildTTF, toWoff, toWoff2, fontFaceCSS } = require('draw-your-font/src/assemble');
const { buildVariants } = require('./variants');
const { buildTTFWithAlternates } = require('./assemble2');

const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
// Always-on auto-alternates: clearly different repeats (natural re-writing —
// tilt/size/baseline), but each variant stays true to the drawn letter.
const ALT_STRENGTH = 2.3;

function clamp(n, lo, hi) {
  n = Number(n);
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

// Edge Smoothness: pre-threshold blur + rethreshold, softening rough/jagged
// pen edges. amount is a blur sigma in [0.3, 3] (0 = off, true to the scan).
// This is the ONE smoothing control exposed to users — of several candidates
// tested (curve corner-rounding, gap-fill, curve-fit tolerance), it was the
// only one that meaningfully changed real photographed handwriting.
async function applyEdgeSmoothness(png, amount) {
  if (!amount) return png;
  const { data, info } = await sharp(png).grayscale().blur(amount).raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height);
  for (let i = 0; i < out.length; i++) out[i] = data[i] < 128 ? 0 : 255;
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
}

// Estimate pen-stroke width (in crop pixels) of a binarized crop. For a stroke
// of width w and length L, ink area ≈ w·L and edge (boundary) pixels ≈ 2·L, so
// width ≈ 2·area / boundary. Robust enough to even out weight across letters.
async function measureStroke(png) {
  const { data, info } = await sharp(png).grayscale().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const ink = (x, y) => x >= 0 && x < w && y >= 0 && y < h && data[y * w + x] < 128;
  let area = 0, boundary = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x] >= 128) continue;
      area++;
      if (!ink(x - 1, y) || !ink(x + 1, y) || !ink(x, y - 1) || !ink(x, y + 1)) boundary++;
    }
  }
  return boundary > 0 ? (2 * area) / boundary : 0;
}

/**
 * @param {string} dir workdir containing blobs.json and crops/
 * @param {Object<string,string>} labels blob id -> character (one blob per char)
 * @param {Object} opts
 *   name        font family name
 *   weight      integer -2..2 (thickness; dilate/erode ink)
 *   edgeSmooth  0..30 (pre-threshold blur amount / 10 = sigma; 0 = off)
 *   slant       degrees -20..20 (italic shear; + leans right)
 *   formats     array of 'ttf'|'woff'|'woff2'|'css'
 * @param {string} outDir where to write font files
 * @returns {Promise<{written:string[], glyphs:string[], missing:string[], base:string}>}
 */
async function buildFont(dir, labels, opts, outDir) {
  const blobs = JSON.parse(fs.readFileSync(path.join(dir, 'blobs.json'), 'utf8'));

  const name = (opts.name && String(opts.name).trim()) || 'My Handwriting';
  const weight = Math.round(clamp(opts.weight, -2, 2));
  const slantDeg = clamp(opts.slant, -20, 20);
  const spacing = opts.spacing == null ? 0 : clamp(opts.spacing, -80, 260);
  const shear = Math.tan((slantDeg * Math.PI) / 180);
  // Edge Smoothness slider 0..30 (UI shows it as 0.0..3.0): pre-threshold blur
  // sigma, 0 = off. The only smoothing control exposed — gap-fill and curve
  // corner-rounding/tolerance are fixed internally (see trace2.js) since
  // testing showed they barely affect real photographed handwriting.
  const edgeSmoothRaw = clamp(opts.edgeSmooth == null ? 0 : opts.edgeSmooth, 0, 30);
  const edgeSmoothSigma = edgeSmoothRaw > 0 ? Math.max(0.3, edgeSmoothRaw / 10) : 0;
  const formats = (opts.formats && opts.formats.length ? opts.formats : ['ttf', 'woff', 'woff2', 'css'])
    .map((s) => String(s).trim().toLowerCase());

  const byId = new Map(blobs.blobs.map((b) => [String(b.id), b]));
  const glyphs = [];
  const seen = new Set();

  // --- Pass 1: collect glyphs and measure each stroke width in em units ------
  // A letter is scaled to fill its type band, so its final stroke width = the
  // pen width in the photo × that scale. Letters drawn smaller get scaled up
  // more and come out heavier, so caps (often drawn large) look thin next to
  // lowercase. Measuring lets us even the weight out below.
  const entries = [];
  for (const [id, rawChar] of Object.entries(labels)) {
    if (!rawChar) continue;
    const char = String(rawChar).normalize('NFC');
    if ([...char].length !== 1) continue; // one codepoint per glyph
    if (seen.has(char)) continue;         // first assignment wins
    const blob = byId.get(String(id));
    if (!blob) continue;
    seen.add(char);

    const cropBuf = fs.readFileSync(path.join(dir, blob.crop));
    const swPx = await measureStroke(cropBuf);
    const [bot, top] = band(char);
    const inkH = blob.cropSize.height - 2 * blobs.pad;
    const scale = inkH > 0 ? (top - bot) / inkH : 1;
    entries.push({ char, blob, cropBuf, swPx, scale, emSw: swPx * scale });
  }
  if (!entries.length) {
    const err = new Error('No glyphs to build — nothing is labeled yet.');
    err.code = 'NO_GLYPHS';
    throw err;
  }
  // Target = median em stroke width across all letters.
  const strokes = entries.map((e) => e.emSw).filter((v) => v > 0).sort((a, b) => a - b);
  const target = strokes.length ? strokes[Math.floor(strokes.length / 2)] : 0;

  // --- Pass 2: re-trace each glyph, nudging its weight toward the target -----
  for (const e of entries) {
    let w = weight;
    if (target > 0 && e.swPx > 0 && e.scale > 0) {
      const desiredCropSw = target / e.scale;      // crop-pixel stroke that hits target
      const norm = Math.round((desiredCropSw - e.swPx) / 2); // dilate/erode ± per side
      w = Math.max(-6, Math.min(7, weight + Math.max(-4, Math.min(4, norm))));
    }
    let png = await adjustWeight(e.cropBuf, w);
    png = await applyEdgeSmoothness(png, edgeSmoothSigma);
    const d = await trace(png);
    if (!d) continue;

    // Tighter side bearings than the engine default (50/50) so letters sit
    // closer, like natural handwriting, instead of typewriter-spaced.
    let { d: placed, advance } = placeGlyph(d, e.blob.cropSize, blobs.pad, e.char, { lsb: 30, rsb: 30 });

    // Slant (shear about the baseline) + letter spacing (split as extra room on
    // both sides). Shear determinant is 1, so winding is preserved.
    if (shear !== 0 || spacing !== 0) {
      let sp = svgpath(placed);
      if (shear !== 0) sp = sp.matrix([1, 0, shear, 1, 0, 0]);
      if (spacing !== 0) sp = sp.translate(spacing / 2, 0);
      placed = sp.round(1).toString();
      advance = Math.round(advance + spacing);
    }
    glyphs.push({ char: e.char, d: placed, advance, source: e.blob.crop });
  }

  if (!glyphs.length) {
    const err = new Error('No glyphs to build — nothing is labeled yet.');
    err.code = 'NO_GLYPHS';
    throw err;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const id = name.replace(/[^A-Za-z0-9_-]+/g, '') || 'MyHandwriting';
  const base = path.join(outDir, id);

  // Always give each letter a few gentle auto-alternates + a GSUB `calt` feature
  // so repeated letters cycle through them (kills the "identical stamp" tell)
  // while staying faithful to the one sample that was drawn.
  // Default + 3 alternates: a run cascades default→alt1→alt2→alt3 then loops back
  // to the true default (see assemble2 cascade), so repeats stay lively but the
  // real drawn letter reappears every 4th — no drift into over-warped forms.
  const glyphList = glyphs.map((g) => ({
    char: g.char,
    advance: g.advance,
    variants: buildVariants({ d: g.d, advance: g.advance }, g.char, 4, ALT_STRENGTH),
  }));
  const ttf = buildTTFWithAlternates(name, glyphList);

  const written = [];
  const wants = (f) => formats.includes(f);
  // Always emit ttf + woff so the browser has something to preview.
  fs.writeFileSync(`${base}.ttf`, ttf);
  written.push(`${id}.ttf`);
  fs.writeFileSync(`${base}.woff`, toWoff(ttf));
  written.push(`${id}.woff`);
  if (wants('woff2')) {
    fs.writeFileSync(`${base}.woff2`, await toWoff2(ttf));
    written.push(`${id}.woff2`);
  }
  if (wants('css')) {
    fs.writeFileSync(`${base}.css`, fontFaceCSS(name, id));
    written.push(`${id}.css`);
  }

  const missing = [...ALPHA].filter((c) => !seen.has(c));
  return { written, glyphs: glyphs.map((g) => g.char), missing, base: id, family: name };
}

module.exports = { buildFont };
