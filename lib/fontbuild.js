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

// X-only dilate/erode: a pixel only grows/shrinks based on its LEFT/RIGHT
// neighbors, never up/down. Used to restore horizontal stroke thickness after
// a horizontal-only resize, without touching vertical thickness (which the
// resize never changed in the first place).
//
// MIN_RUN is a floor applied to BOTH ink runs and background runs: never
// erode an ink run, or dilate a background run, down below this width. This
// is a single, symmetric safety rule rather than trying to classify "this
// background is an enclosed counter, that one is just open space" — direct
// testing showed that classification is unreliable on real handwriting
// (topological flood-fill misses a counter with even a tiny natural pen-lift
// gap, which is common — a cursive "a"'s bowl often doesn't fully close).
// Without the ink-side floor, eroding a naturally tapered stroke tip (pen
// lift, thin serif) erased it entirely, reading as the letter getting
// cropped. Without the background-side floor, dilating to compensate a
// condensed letter grows into ANY nearby gap — including a bowl's counter —
// until it seals shut, and an "a" traces as an "x". The floor fixes both by
// simply refusing to fully consume a run that's already thin, whichever side
// it's on.
const MIN_RUN = 2;
function xDilateErode(ink, width, height, amount) {
  if (!amount) return ink;
  const grow = amount > 0;
  for (let it = 0; it < Math.abs(amount); it++) {
    const next = new Uint8Array(ink);
    for (let y = 0; y < height; y++) {
      let x = 0;
      while (x < width) {
        const rowBase = y * width;
        const isInk = !!ink[rowBase + x];
        const x0 = x;
        while (x < width && !!ink[rowBase + x] === isInk) x++;
        if (x - x0 <= MIN_RUN) continue; // already thin — protect this run, ink or background
        for (let xi = x0; xi < x; xi++) {
          const p = rowBase + xi;
          const hasLeft = xi > 0 && ink[p - 1];
          const hasRight = xi < width - 1 && ink[p + 1];
          if (grow && !isInk && (hasLeft || hasRight)) next[p] = 1;
          if (!grow && isInk && !(hasLeft && hasRight)) next[p] = 0;
        }
      }
    }
    ink.set(next);
  }
  return ink;
}

// True condense/expand: scale just the ink region horizontally (leaving the
// fixed padding border alone — placeGlyph subtracts an exact `pad` on each
// side, so the padding itself must not shrink/grow), then compensate with an
// X-only dilate/erode so stroke thickness stays close to the original instead
// of thinning (condense) or fattening (expand) the way a plain non-uniform
// scale of the traced outline would. Approximate for diagonals/curves (a
// single global compensation amount can't perfectly correct every stroke
// angle), but a large, clear improvement over naive scaling for the common
// case of mostly-vertical strokes.
async function scaleWidthPreserveStroke(png, sx, pad) {
  const meta = await sharp(png).metadata();
  if (sx === 1) return { png, width: meta.width };
  const strokeBefore = await measureStroke(png);
  const innerW = meta.width - 2 * pad;
  const newInnerW = Math.max(1, Math.round(innerW * sx));

  const { data, info } = await sharp(png).grayscale()
    .extract({ left: pad, top: 0, width: innerW, height: meta.height })
    .resize(newInnerW, meta.height, { fit: 'fill' })
    .raw().toBuffer({ resolveWithObject: true });

  // Damped: the full formula assumes one uniform stroke width across the
  // whole glyph, but a single compensation amount applied everywhere
  // over/undershoots on complex, multi-stroke letters (confirmed on real
  // handwriting: "m"/"e"/"R"/"G" came out visibly heavier when condensed
  // and visibly lighter when expanded, while a simple isolated stroke like
  // "l" was fine — junctions and curves throw off the whole-glyph average).
  // Under-correcting is the safer failure mode than over-correcting, so
  // this trades some thickness accuracy for not visibly fattening/thinning
  // the letterform.
  const COMPENSATE_DAMPING = 0.6;
  const compensate = Math.round((strokeBefore * (1 - sx)) / 2 * COMPENSATE_DAMPING);
  // Condensing dilates (grows) ink to restore thickness — give it room to
  // grow into on both sides, or it hits the shrunk canvas edge and clips.
  const margin = Math.max(0, compensate);
  const workW = info.width + 2 * margin;
  let ink = new Uint8Array(workW * info.height);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x] < 128) ink[y * workW + (x + margin)] = 1;
    }
  }
  ink = xDilateErode(ink, workW, info.height, compensate);

  const newWidth = workW + 2 * pad;
  const out = Buffer.alloc(newWidth * meta.height, 255);
  for (let y = 0; y < meta.height; y++) {
    for (let x = 0; x < workW; x++) {
      if (ink[y * workW + x]) out[y * newWidth + (x + pad)] = 0;
    }
  }
  const resultPng = await sharp(out, { raw: { width: newWidth, height: meta.height, channels: 1 } }).png().toBuffer();
  return { png: resultPng, width: newWidth };
}

/**
 * @param {string} dir workdir containing blobs.json and crops/
 * @param {Object<string,string>} labels blob id -> character (one blob per char)
 * @param {Object} opts
 *   name        font family name
 *   weight      integer -2..2 (thickness; dilate/erode ink)
 *   width       0=Condensed, 1=Regular (default), 2=Wide (horizontal scale, stroke-thickness-preserving)
 *   edgeSmooth  0..30 (pre-threshold blur amount / 10 = sigma; 0 = off)
 *   slant       degrees -20..20 (italic shear; + leans right)
 *   formats     array of 'ttf'|'woff'|'woff2'|'css'
 * @param {string} outDir where to write font files
 * @returns {Promise<{written:string[], glyphs:string[], missing:string[], base:string}>}
 */
async function buildFont(dir, labels, opts, outDir) {
  const blobs = JSON.parse(fs.readFileSync(path.join(dir, 'blobs.json'), 'utf8'));

  const name = opts.name && String(opts.name).trim();
  if (!name) {
    const err = new Error('Name your font before building.');
    err.code = 'NO_NAME';
    throw err;
  }
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
  const WIDTH_SCALES = [0.65, 1, 1.3]; // Condensed, Regular, Wide — Wide pulled in from 1.5, was too aggressive
  const widthIdx = Math.round(clamp(opts.width == null ? 1 : opts.width, 0, 2));
  const width = WIDTH_SCALES[widthIdx];
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
    let cropSize = e.blob.cropSize;
    if (width !== 1) {
      const scaled = await scaleWidthPreserveStroke(png, width, blobs.pad);
      png = scaled.png;
      cropSize = { width: scaled.width, height: e.blob.cropSize.height };
    }
    png = await applyEdgeSmoothness(png, edgeSmoothSigma);
    const d = await trace(png);
    if (!d) continue;

    // Tighter side bearings than the engine default (50/50) so letters sit
    // closer, like natural handwriting, instead of typewriter-spaced.
    let { d: placed, advance } = placeGlyph(d, cropSize, blobs.pad, e.char, { lsb: 30, rsb: 30 });

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
