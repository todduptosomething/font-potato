'use strict';
// One self-contained unit of the build pipeline: crop PNG -> weight-adjusted,
// gap-filled ink -> traced SVG path -> placed in em space. This is the actual
// bottleneck (potrace/Jimp are pure JS, no GPU/native speedup like sharp had),
// so it's written to run standalone inside a Worker (see trace-worker.js) and
// to do only ONE PNG decode + ONE PNG encode per glyph — everything between
// (weight dilate/erode, gap-fill close) is raw Uint8Array math, where the old
// per-step adjustWeight() did a wasteful decode+encode on every call (3x for
// weight + fill-dilate + fill-erode).

import { decodePNGToGray, grayToPNGBlob } from './image.js';
import { Potrace, Buffer } from './vendor.js';
import { REF_UNITS, LSB, RSB, placeGlyphBaseline, inkProfileFromInk } from './place.js';

const lerp = (a, b, t) => a + (b - a) * t;

function dilateErode(ink, width, height, weight) {
  if (!weight) return ink;
  const grow = weight > 0;
  for (let it = 0; it < Math.abs(weight); it++) {
    const next = new Uint8Array(ink);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const n4 =
          (x > 0 && ink[p - 1]) || (x < width - 1 && ink[p + 1]) ||
          (y > 0 && ink[p - width]) || (y < height - 1 && ink[p + width]);
        if (grow && !ink[p] && n4) next[p] = 1;
        if (!grow && ink[p] && !((x > 0 && ink[p - 1]) && (x < width - 1 && ink[p + 1]) && (y > 0 && ink[p - width]) && (y < height - 1 && ink[p + width]))) next[p] = 0;
      }
    }
    ink = next;
  }
  return ink;
}

// Estimate pen-stroke width, in crop pixels, straight off the ink array. For
// a stroke of width w and length L, ink area ≈ w·L and boundary pixels ≈ 2·L,
// so width ≈ 2·area / boundary.
function measureStroke(ink, W, H) {
  const at = (x, y) => x >= 0 && x < W && y >= 0 && y < H && ink[y * W + x];
  let area = 0, boundary = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!ink[y * W + x]) continue;
      area++;
      if (!at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1)) boundary++;
    }
  }
  return boundary > 0 ? (2 * area) / boundary : 0;
}

// X-only dilate/erode: a pixel grows or shrinks based on its LEFT/RIGHT
// neighbours only, never up/down. Restores horizontal stroke thickness after
// a horizontal-only resize without touching vertical thickness, which the
// resize never changed.
//
// MIN_RUN floors BOTH ink runs and background runs: never erode an ink run,
// or dilate a background run, below this width. One symmetric rule, rather
// than trying to tell an enclosed counter from open space — that
// classification proved unreliable on real handwriting, since a flood fill
// misses a counter with even a tiny pen-lift gap and a cursive "a"'s bowl
// often doesn't fully close. Without the ink floor, eroding a tapered stroke
// tip erased it and the letter looked cropped. Without the background floor,
// dilating a condensed letter grew into any nearby gap until it sealed shut,
// and an "a" traced as an "x".
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
        if (x - x0 <= MIN_RUN) continue; // already thin — protect it, ink or background
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

// True condense/expand. Scales only the INK region horizontally — the fixed
// padding border is left alone, because placement subtracts an exact `pad`
// from each side and would mis-anchor if the padding scaled with it — then
// compensates with an X-only dilate/erode so stroke thickness stays close to
// the original, instead of thinning when condensed or fattening when
// expanded, the way a plain non-uniform scale of the outline would.
//
// The compensation is damped because the formula assumes one uniform stroke
// width across the glyph, and a single amount applied everywhere over- or
// undershoots on multi-stroke letters — on real handwriting "m", "e", "R"
// and "G" came out visibly heavier when condensed while an isolated stroke
// like "l" was fine. Under-correcting is the safer failure, so this trades
// some thickness accuracy for never visibly fattening the letterform.
const COMPENSATE_DAMPING = 0.6;
function scaleWidthPreserveStroke(ink, W, H, pad, sx) {
  if (sx === 1) return { ink, W };
  const strokeBefore = measureStroke(ink, W, H);
  const innerW = W - 2 * pad;
  const newInnerW = Math.max(1, Math.round(innerW * sx));
  const compensate = Math.round((strokeBefore * (1 - sx)) / 2 * COMPENSATE_DAMPING);
  // Condensing dilates ink back to thickness — it needs room to grow into on
  // both sides, or it hits the canvas edge and clips.
  const margin = Math.max(0, compensate);
  const workW = newInnerW + 2 * margin;

  // Nearest-neighbour resample: the source is already binary, so there is
  // nothing for interpolation to preserve.
  let scaled = new Uint8Array(workW * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < newInnerW; x++) {
      const srcX = Math.min(innerW - 1, Math.floor((x + 0.5) / sx));
      if (ink[y * W + pad + srcX]) scaled[y * workW + margin + x] = 1;
    }
  }
  scaled = xDilateErode(scaled, workW, H, compensate);

  const outW = workW + 2 * pad;
  const out = new Uint8Array(outW * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < workW; x++) {
      if (scaled[y * workW + x]) out[y * outW + pad + x] = 1;
    }
  }
  return { ink: out, W: outW };
}

async function tracePotrace(pngBlob, { smooth, detail }) {
  const d = Math.max(0, Math.min(1, detail));
  const buf = Buffer.from(await pngBlob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const t = new Potrace({
      threshold: 128,
      blackOnWhite: true,
      turdSize: Math.round(lerp(1, 10, d)),
      // Corner rounding, 0.8 (potrace's own default) up to 1.334 (every
      // corner rounded away). The bottom of the slider deliberately sits at
      // 0.8 rather than 0: the roughest setting is meant to be exactly what
      // the scan gave us, not a deliberately coarsened version of it.
      alphaMax: lerp(0.8, 1.334, Math.max(0, Math.min(1, smooth))),
      optCurve: true,
      // How far the fitted curve may stray from the traced outline. THIS is
      // the parameter that reads as smoothness: low and the curve follows
      // every wobble of the pen line, high and it sails past them into long
      // clean arcs. It used to be pinned at its finest value regardless of
      // the slider, which is why the control barely registered.
      optTolerance: lerp(0.02, 1.2, Math.max(0, Math.min(1, smooth))),
      turnPolicy: Potrace.TURNPOLICY_MINORITY,
    });
    t.loadImage(buf, function (err) {
      if (err) return reject(err);
      const m = /d="([^"]*)"/.exec(this.getPathTag());
      resolve(m ? m[1] : '');
    });
  });
}

/**
 * @param {Blob} cropBlob binarized PNG crop (black ink on white)
 * @param {{width,height}} cropSize
 * @param {number} pad
 * @param {string} char
 * @param {{weight:number, fillIters:number, smooth:number, detail:number,
 *          capRefPx:number, baselineOffset:number}} opts
 * @returns {Promise<{d:string, advance:number, profile:Array}|null>} placed glyph
 *   in em space (pre slant/spacing), or null if the trace produced nothing
 */
async function traceGlyph(cropBlob, cropSize, pad, char, { weight, fillIters, smooth, detail, widthScale = 1, capRefPx, baselineOffset }) {
  const { data, width, height } = await decodePNGToGray(cropBlob);

  // Dilation (positive weight) pushes ink up to `weight` px outward in every
  // direction, but the crop only carries `pad` px of blank margin around the
  // tight ink bbox. Growing in place eats that margin, and once ink reaches
  // past it the glyph places wider than its own advance and overlaps its
  // neighbour. So grow the canvas first — and shift the baseline anchor by
  // the same amount, since every row moves down with it.
  // Morphological smoothing rounds the SHAPE before it's traced, which curve
  // fitting alone can't do — fitting only draws a neater line around whatever
  // outline it's handed. A close (dilate then erode) fills the little notches
  // and nicks along a pen edge and rounds sharp inner points, while leaving
  // stroke width unchanged, because every pixel grown is taken back again.
  // It also closes small gaps, which is the agreed trade at higher settings.
  //
  // Close, not open: opening starts with an erosion, and erosion deletes a
  // stroke only a pixel or two wide outright — the exact fault that put breaks
  // in a W's stem. Convex corners are left to potrace's alphaMax, which rounds
  // them without ever removing ink.
  const smoothIters = Math.round(Math.max(0, Math.min(1, smooth)) * 3);

  const grow = Math.max(0, weight) + smoothIters;
  const W = width + 2 * grow, H = height + 2 * grow;
  const effPad = pad + grow;
  const effBaseline = baselineOffset + grow;

  let ink = new Uint8Array(W * H);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x] < 128) ink[(y + grow) * W + (x + grow)] = 1;
    }
  }

  ink = dilateErode(ink, W, H, weight);
  if (smoothIters > 0) {
    ink = dilateErode(ink, W, H, smoothIters);    // grow: bridge notches + gaps
    ink = dilateErode(ink, W, H, -smoothIters);   // shrink back: width restored
  }
  if (fillIters > 0) {
    ink = dilateErode(ink, W, H, fillIters);
    ink = dilateErode(ink, W, H, -fillIters);
  }

  // Width comes last of the bitmap steps, so it condenses/expands the letter
  // at its final weight. Only the horizontal extent changes, so the baseline
  // anchor and the padding are both untouched.
  const scaledW = scaleWidthPreserveStroke(ink, W, H, effPad, widthScale);
  ink = scaledW.ink;
  const FW = scaledW.W;

  const gray = new Uint8Array(FW * H).fill(255);
  for (let i = 0; i < ink.length; i++) if (ink[i]) gray[i] = 0;
  const pngBlob = await grayToPNGBlob(gray, FW, H);

  const d = await tracePotrace(pngBlob, { smooth, detail });
  if (!d) return null;

  const scale = capRefPx > 0 ? REF_UNITS / capRefPx : 1;
  const profile = inkProfileFromInk(ink, FW, H, scale, effPad, effBaseline);
  const { d: placed, advance } = placeGlyphBaseline(d, FW, effPad, capRefPx, effBaseline, { lsb: LSB, rsb: RSB });
  return { d: placed, advance, profile };
}

export { traceGlyph };
