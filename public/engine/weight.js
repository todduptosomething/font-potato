'use strict';
// Browser port of draw-your-font's adjustWeight (src/trace.js). The dilate/
// erode logic is verbatim — only the sharp PNG decode/encode at the boundary
// is swapped for image.js's Canvas equivalents.

import { decodePNGToGray, grayToPNGBlob } from './image.js';

/**
 * @param {Blob} pngBlob binarized crop (black ink on white)
 * @param {number} weight integer; +n dilates (thicker) / -n erodes (thinner)
 * @returns {Promise<Blob>} PNG blob
 */
async function adjustWeight(pngBlob, weight) {
  if (!weight) return pngBlob;
  const { data, width, height } = await decodePNGToGray(pngBlob);
  let ink = new Uint8Array(width * height);
  for (let i = 0; i < ink.length; i++) ink[i] = data[i] < 128 ? 1 : 0;
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
  const out = new Uint8Array(width * height).fill(255);
  for (let i = 0; i < ink.length; i++) if (ink[i]) out[i] = 0;
  return grayToPNGBlob(out, width, height);
}

/**
 * Estimate pen-stroke width (in crop pixels) — browser port of fontbuild.js's
 * measureStroke. width ≈ 2·ink-area / boundary-pixels.
 * @param {Blob} pngBlob
 * @returns {Promise<number>}
 */
async function measureStroke(pngBlob) {
  const { data, width: w, height: h } = await decodePNGToGray(pngBlob);
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

export { adjustWeight, measureStroke };
