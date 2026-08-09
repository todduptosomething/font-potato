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

async function tracePotrace(pngBlob, { smooth, detail }) {
  const d = Math.max(0, Math.min(1, detail));
  const buf = Buffer.from(await pngBlob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const t = new Potrace({
      threshold: 128,
      blackOnWhite: true,
      turdSize: Math.round(lerp(1, 10, d)),
      alphaMax: 0.8 + 0.25 * smooth,
      optCurve: true,
      optTolerance: lerp(0.02, 0.45, d),
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
async function traceGlyph(cropBlob, cropSize, pad, char, { weight, fillIters, smooth, detail, capRefPx, baselineOffset }) {
  const { data, width, height } = await decodePNGToGray(cropBlob);

  // Dilation (positive weight) pushes ink up to `weight` px outward in every
  // direction, but the crop only carries `pad` px of blank margin around the
  // tight ink bbox. Growing in place eats that margin, and once ink reaches
  // past it the glyph places wider than its own advance and overlaps its
  // neighbour. So grow the canvas first — and shift the baseline anchor by
  // the same amount, since every row moves down with it.
  const grow = Math.max(0, weight);
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
  if (fillIters > 0) {
    ink = dilateErode(ink, W, H, fillIters);
    ink = dilateErode(ink, W, H, -fillIters);
  }

  const gray = new Uint8Array(W * H).fill(255);
  for (let i = 0; i < ink.length; i++) if (ink[i]) gray[i] = 0;
  const pngBlob = await grayToPNGBlob(gray, W, H);

  const d = await tracePotrace(pngBlob, { smooth, detail });
  if (!d) return null;

  const scale = capRefPx > 0 ? REF_UNITS / capRefPx : 1;
  const profile = inkProfileFromInk(ink, W, H, scale, effPad, effBaseline);
  const { d: placed, advance } = placeGlyphBaseline(d, W, effPad, capRefPx, effBaseline, { lsb: LSB, rsb: RSB });
  return { d: placed, advance, profile };
}

export { traceGlyph };
