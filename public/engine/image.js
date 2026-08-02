'use strict';
// Browser replacements for the two things `sharp` did in the Node pipeline:
// (1) decode a photo to a rotated, grayscale, contrast-normalized, size-capped
//     raw pixel buffer, and (2) encode a raw 1-channel buffer back to a PNG.
// Everything downstream (marker-finding, rectify, despeckle, trace, weight
// dilate/erode) is already plain array math and needs no porting — only the
// image decode/encode boundary does.

/**
 * Decode an image file/blob to grayscale, contrast-normalized pixel data,
 * capped at maxSide on the long edge (never upscaled) — the browser
 * equivalent of `sharp(path).rotate().grayscale().normalise().resize(...)`.
 * @param {File|Blob} fileOrBlob
 * @param {{maxSide?: number}} opts
 * @returns {Promise<{data: Float32Array, width: number, height: number}>}
 */
async function decodeToGray(fileOrBlob, { maxSide = 8000 } = {}) {
  // imageOrientation: 'from-image' applies EXIF rotation during decode, same
  // as sharp's .rotate() with no args (auto-orient from EXIF).
  const bitmap = await createImageBitmap(fileOrBlob, { imageOrientation: 'from-image' });

  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height)); // withoutEnlargement
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const { data: rgba } = ctx.getImageData(0, 0, width, height);
  const gray = new Float32Array(width * height);
  let mn = 255, mx = 0;
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    // Rec. 601 luma, matching sharp's default grayscale() weighting closely
    // enough for this use (thresholding ink vs. paper, not color-critical work).
    const v = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    gray[p] = v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  // normalise(): stretch the observed range to fill 0..255.
  const range = mx - mn || 1;
  for (let p = 0; p < gray.length; p++) gray[p] = ((gray[p] - mn) / range) * 255;

  return { data: gray, width, height };
}

/**
 * Encode a raw single-channel (grayscale) buffer to a PNG Blob — the browser
 * equivalent of `sharp(buf, {raw:{width,height,channels:1}}).png().toBuffer()`.
 * @param {Uint8Array} gray values 0..255, length = width*height
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Blob>}
 */
async function grayToPNGBlob(gray, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
    const v = gray[p];
    img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

/**
 * Decode a PNG (or any image) Blob/File to a raw grayscale buffer — the
 * browser equivalent of `sharp(png).grayscale().raw().toBuffer()`, used for
 * re-reading a crop (e.g. before measuring stroke width or dilating/eroding).
 * No rotation/normalise here — crops are already upright, already normalized.
 * @param {Blob} blob
 * @returns {Promise<{data: Uint8Array, width: number, height: number}>}
 */
async function decodePNGToGray(blob) {
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data: rgba } = ctx.getImageData(0, 0, width, height);
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    gray[p] = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
  }
  return { data: gray, width, height };
}

export { decodeToGray, grayToPNGBlob, decodePNGToGray };
