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
import { Potrace, Buffer, placeGlyph } from './vendor.js';

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
 * @param {{weight:number, fillIters:number, smooth:number, detail:number}} opts
 * @returns {Promise<{d:string, advance:number}|null>} placed glyph in em space (pre slant/spacing), or null if trace produced nothing
 */
async function traceGlyph(cropBlob, cropSize, pad, char, { weight, fillIters, smooth, detail }) {
  const { data, width, height } = await decodePNGToGray(cropBlob);
  let ink = new Uint8Array(width * height);
  for (let i = 0; i < ink.length; i++) ink[i] = data[i] < 128 ? 1 : 0;

  ink = dilateErode(ink, width, height, weight);
  if (fillIters > 0) {
    ink = dilateErode(ink, width, height, fillIters);
    ink = dilateErode(ink, width, height, -fillIters);
  }

  const gray = new Uint8Array(width * height).fill(255);
  for (let i = 0; i < ink.length; i++) if (ink[i]) gray[i] = 0;
  const pngBlob = await grayToPNGBlob(gray, width, height);

  const d = await tracePotrace(pngBlob, { smooth, detail });
  if (!d) return null;
  return placeGlyph(d, cropSize, pad, char, { lsb: 30, rsb: 30 });
}

export { traceGlyph };
