'use strict';
// Browser replacements for the two things `sharp` did in the Node pipeline:
// (1) decode a photo to a rotated, grayscale, contrast-normalized, size-capped
//     raw pixel buffer, and (2) encode a raw 1-channel buffer back to a PNG.
// Everything downstream (marker-finding, rectify, despeckle, trace, weight
// dilate/erode) is already plain array math and needs no porting — only the
// image decode/encode boundary does.

// --- HEIC ------------------------------------------------------------------
// iPhone photos are HEIC by default, and no browser except Safari can decode
// them natively — createImageBitmap simply fails. The Node pipeline handled
// this with `sips`/heic-convert; in the browser we run libheif compiled to
// wasm. The bundle is ~1.4MB, so it's imported LAZILY and only when a HEIC
// is actually detected: anyone uploading a JPEG or PNG never downloads it.

const HEIF_BRANDS = new Set([
  'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs',
  'mif1', 'msf1', 'avif', 'avis',
]);

// Same magic-byte sniff as lib/imageprep.js: an ISO-BMFF 'ftyp' box whose
// major brand is one of the HEIF family. Extension and MIME type are both
// unreliable (browsers frequently report '' for .HEIC files).
function isHeif(head12) {
  if (head12.length < 12) return false;
  const tag = String.fromCharCode(head12[4], head12[5], head12[6], head12[7]);
  if (tag !== 'ftyp') return false;
  const brand = String.fromCharCode(head12[8], head12[9], head12[10], head12[11]).toLowerCase();
  return HEIF_BRANDS.has(brand.replace('\0', ' ').trim());
}

// Kick off the decoder download + wasm compile ahead of time (e.g. as soon
// as the upload step is on screen). Costs nothing if never used and turns a
// multi-second stall at photo-pick time into an already-warm module.
function warmHeif() {
  loadHeif().catch(() => { /* if it fails here it'll surface at decode time */ });
}

let heifPromise = null;
function loadHeif() {
  // Emscripten default export is a factory that may return a promise.
  if (!heifPromise) {
    heifPromise = import('./vendor-libheif.mjs').then(async (m) => {
      const factory = m.default || m;
      const mod = typeof factory === 'function' ? factory() : factory;
      const lib = mod && typeof mod.then === 'function' ? await mod : mod;
      if (lib && lib.ready) await lib.ready;
      return lib;
    });
  }
  return heifPromise;
}

async function decodeHeicToGray(fileOrBlob, maxSide) {
  const libheif = await loadHeif();
  const buf = new Uint8Array(await fileOrBlob.arrayBuffer());
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(buf);
  if (!images || !images.length) throw new Error('No image found inside this HEIC file.');
  const image = images[0];
  const width = image.get_width(), height = image.get_height();
  try {
    const displayData = await new Promise((resolve, reject) => {
      image.display({ data: new Uint8ClampedArray(width * height * 4), width, height },
        (d) => (d ? resolve(d) : reject(new Error('Could not read this HEIC photo.'))));
    });

    // Go straight from libheif's RGBA to downscaled grayscale. Routing it
    // through a canvas instead (putImageData -> createImageBitmap ->
    // drawImage -> getImageData) copies a 48-megapixel buffer four times;
    // measured, that path took ~10s on a real iPhone photo versus ~2s for
    // this one. Box-averaging every source pixel that lands in an output
    // pixel is also a better downsample than nearest-neighbour, and matches
    // what an image library would do closely enough for ink thresholding.
    const rgba = displayData.data;
    const scale = Math.min(1, maxSide / Math.max(width, height)); // never upscale
    const outW = Math.max(1, Math.round(width * scale));
    const outH = Math.max(1, Math.round(height * scale));
    const gray = new Float32Array(outW * outH);

    for (let oy = 0; oy < outH; oy++) {
      const sy0 = Math.floor((oy * height) / outH);
      const sy1 = Math.max(sy0 + 1, Math.floor(((oy + 1) * height) / outH));
      for (let ox = 0; ox < outW; ox++) {
        const sx0 = Math.floor((ox * width) / outW);
        const sx1 = Math.max(sx0 + 1, Math.floor(((ox + 1) * width) / outW));
        let sum = 0, n = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          let i = (sy * width + sx0) * 4;
          for (let sx = sx0; sx < sx1; sx++, i += 4) {
            // Rec. 601 luma, same weighting as the canvas path above.
            sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
            n++;
          }
        }
        gray[oy * outW + ox] = sum / n;
      }
    }
    return { data: gray, width: outW, height: outH };
  } finally {
    for (const im of images) { try { im.free(); } catch { /* already freed */ } }
    try { decoder.decoder.delete(); } catch { /* not all builds expose this */ }
  }
}

/**
 * Decode an image file/blob to grayscale, contrast-normalized pixel data,
 * capped at maxSide on the long edge (never upscaled) — the browser
 * equivalent of `sharp(path).rotate().grayscale().normalise().resize(...)`.
 * @param {File|Blob} fileOrBlob
 * @param {{maxSide?: number}} opts
 * @returns {Promise<{data: Float32Array, width: number, height: number}>}
 */
async function decodeToGray(fileOrBlob, { maxSide = 8000 } = {}) {
  const head = new Uint8Array(await fileOrBlob.slice(0, 12).arrayBuffer());

  let gray, width, height;
  if (isHeif(head)) {
    // libheif applies HEIC's own rotation/mirror boxes during decode, so what
    // comes back is already upright.
    ({ data: gray, width, height } = await decodeHeicToGray(fileOrBlob, maxSide));
  } else {
    // imageOrientation: 'from-image' applies EXIF rotation during decode, same
    // as sharp's .rotate() with no args (auto-orient from EXIF).
    const bitmap = await createImageBitmap(fileOrBlob, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height)); // withoutEnlargement
    width = Math.max(1, Math.round(bitmap.width * scale));
    height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const { data: rgba } = ctx.getImageData(0, 0, width, height);
    gray = new Float32Array(width * height);
    for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
      // Rec. 601 luma, matching sharp's default grayscale() weighting closely
      // enough for this use (thresholding ink vs. paper, not color-critical work).
      gray[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    }
  }

  // normalise(): sharp's is histogram-based, clipping to the 1%–99%
  // percentile range rather than the true min/max, so a single dust speck or
  // blown highlight can't crush the contrast of everything else. Match that
  // exactly — with a plain min/max stretch the image comes out lower-contrast
  // than the server's, faint pen strokes read lighter, and the tapered tip of
  // a stroke falls below the ink threshold (measured: it truncated real tails
  // on G/E/I versus the Node pipeline on the same photo).
  const hist = new Uint32Array(256);
  for (let p = 0; p < gray.length; p++) {
    const v = gray[p] < 0 ? 0 : gray[p] > 255 ? 255 : Math.round(gray[p]);
    hist[v]++;
  }
  const total = gray.length;
  const loTarget = total * 0.01, hiTarget = total * 0.99;
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > loTarget) { lo = v; break; } }
  acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= hiTarget) { hi = v; break; } }
  const range = (hi - lo) || 1;
  for (let p = 0; p < gray.length; p++) {
    const v = ((gray[p] - lo) / range) * 255;
    gray[p] = v < 0 ? 0 : v > 255 ? 255 : v;
  }

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

export { decodeToGray, grayToPNGBlob, decodePNGToGray, warmHeif, isHeif };
