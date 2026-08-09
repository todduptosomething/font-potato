'use strict';
// Browser port of lib/templatescan.js. All the marker-detection / rectify /
// despeckle math is unchanged plain array logic (it never touched sharp) —
// only the two image decode/encode boundary calls are swapped for image.js's
// Canvas-based equivalents. See lib/templatescan.js for the original
// commentary; kept terse here to avoid duplicating it.

import { decodeToGray, grayToPNGBlob } from './image.js';

const PAD = 8;
// Working resolution cap for the long edge. The Node pipeline used 8000
// because `sharp` is native and SIMD-accelerated, so the cost was invisible;
// in the browser the per-cell rectify loop is plain JS, and every doubling of
// resolution quadruples its work — measured at 8000 a real 48MP iPhone photo
// took ~56s to rectify, versus ~3s at 4000. A US Letter sheet at 4000px on
// the long edge is still ~360 DPI, far finer than a pen stroke needs, and
// output was verified equivalent (94/94 cells, glyph advance widths within
// 0.4% of the Node build) at this size.
const MAX_SIDE = 4000;

function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

function sampleGray(data, W, H, x, y) {
  if (x < 0) x = 0; else if (x > W - 1) x = W - 1;
  if (y < 0) y = 0; else if (y > H - 1) y = H - 1;
  const x0 = x | 0, y0 = y | 0;
  const x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
  const fx = x - x0, fy = y - y0;
  const a = data[y0 * W + x0], b = data[y0 * W + x1];
  const c = data[y1 * W + x0], d = data[y1 * W + x1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

function components(mask, W, H) {
  const labels = new Int32Array(W * H);
  const stack = new Int32Array(W * H);
  const out = [];
  let next = 0;
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || labels[s]) continue;
    next++;
    let sp = 0; stack[sp++] = s; labels[s] = next;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0, sx = 0, sy = 0;
    while (sp) {
      const p = stack[--sp];
      const x = p % W, y = (p / W) | 0;
      area++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = next; stack[sp++] = p - 1; }
      if (x < W - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = next; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - W] && !labels[p - W]) { labels[p - W] = next; stack[sp++] = p - W; }
      if (y < H - 1 && mask[p + W] && !labels[p + W]) { labels[p + W] = next; stack[sp++] = p + W; }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    out.push({ area, w, h, cx: sx / area, cy: sy / area, fill: area / (w * h) });
  }
  return out;
}

function findMarkers(gray, W, H) {
  const dark = new Uint8Array(W * H);
  for (let i = 0; i < gray.length; i++) if (gray[i] < 80) dark[i] = 1;
  const comps = components(dark, W, H);
  const side = 0.049 * W;
  const cands = comps.filter((c) =>
    c.fill > 0.7 &&
    c.w > 0.4 * c.h && c.w < 2.2 * c.h &&
    c.w > side * 0.4 && c.w < side * 2.4 &&
    c.area > (0.02 * W) * (0.02 * W));
  if (cands.length < 4) return null;

  const corners = [[0, 0], [W, 0], [0, H], [W, H]];
  const picked = [];
  const used = new Set();
  for (const [cxCorner, cyCorner] of corners) {
    let best = null, bestD = Infinity, bestIdx = -1;
    cands.forEach((c, idx) => {
      if (used.has(idx)) return;
      const d = Math.hypot(c.cx - cxCorner, c.cy - cyCorner);
      if (d < bestD) { bestD = d; best = c; bestIdx = idx; }
    });
    if (!best || bestD > 0.6 * Math.hypot(W, H)) return null;
    used.add(bestIdx);
    picked.push([best.cx, best.cy]);
  }
  const [TL, TR, BL, BR] = picked;
  if (!(TL[0] < TR[0] && BL[0] < BR[0] && TL[1] < BL[1] && TR[1] < BR[1])) return null;
  return { TL, TR, BL, BR };
}

// True perspective transform (homography) from the unit square onto the quad
// the four markers describe.
//
// This used to interpolate in straight lines between the markers, which is
// only correct when the camera is exactly square-on to the paper. Photograph
// a sheet at any angle — as everyone does, holding a phone over a desk — and
// a real perspective view is not linear: equal steps across the page are not
// equal steps across the photo. Straight-line interpolation pins the four
// corners perfectly and drifts everywhere in between, worst in the MIDDLE of
// the sheet, which is why a cell in row 5 could sit far enough off its
// printed box to reach into the box below and pick up its printed hint.
//
// A homography is the correct model for a flat surface seen by a camera. It
// still matches the four markers exactly, but every point between them lands
// where it actually is, so a cell's scan region covers its own printed box
// and nothing else — which is the whole reason for putting markers on the
// page. Standard unit-square-to-quad formulation (Heckbert): the corners map
// (0,0)->TL, (1,0)->TR, (1,1)->BR, (0,1)->BL.
function makeMapper({ TL, TR, BL, BR }) {
  const [x0, y0] = TL, [x1, y1] = TR, [x2, y2] = BR, [x3, y3] = BL;

  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;

  let a, b, c, d, e, f, g, h;
  if (dx3 === 0 && dy3 === 0) {
    // The quad is a parallelogram: no perspective, so the affine case is exact
    // (and avoids dividing by a determinant that is zero here).
    a = x1 - x0; b = x2 - x1; c = x0;
    d = y1 - y0; e = y2 - y1; f = y0;
    g = 0; h = 0;
  } else {
    const den = dx1 * dy2 - dy1 * dx2;
    g = (dx3 * dy2 - dy3 * dx2) / den;
    h = (dx1 * dy3 - dy1 * dx3) / den;
    a = x1 - x0 + g * x1;
    b = x3 - x0 + h * x3;
    c = x0;
    d = y1 - y0 + g * y1;
    e = y3 - y0 + h * y3;
    f = y0;
  }

  return (u, v) => {
    const w = g * u + h * v + 1;
    return [(a * u + b * v + c) / w, (d * u + e * v + f) / w];
  };
}

// Even out the lighting across the whole sheet, once, before any box is read.
//
// This step was missing entirely. Decoding stretches the image's overall
// brightness, which rescales everything equally and so cannot fix one side of
// the page being darker than the other — and that is the normal case, because
// people photograph a sheet on a desk with a lamp off to one side, or with
// their own shadow falling across it. Every later stage then had to cope with
// a moving target, and the per-box threshold was really compensating for a
// page-wide problem one box at a time.
//
// The fix is flat-fielding, the same idea as a scanner's calibration pass:
// estimate what the PAPER's brightness is at every point, then divide it out,
// so white paper reads the same everywhere and only ink stands out.
//
// The paper estimate takes the brightest pixel in each coarse block. Paper is
// brighter than ink by definition, so the maximum inside a block much larger
// than a pen stroke is paper, whatever was written on top of it. Those block
// values are then interpolated smoothly, giving an illumination map free of
// the writing itself. Coarse on purpose: it should follow a lamp's falloff
// across the page, not the shape of anyone's letters.
function flattenIllumination(gray, W, H) {
  const BLOCKS = 40;                       // far coarser than a letter
  const bw = Math.max(1, Math.ceil(W / BLOCKS));
  const bh = Math.max(1, Math.ceil(H / BLOCKS));
  const cols = Math.ceil(W / bw), rows = Math.ceil(H / bh);

  const paper = new Float32Array(cols * rows);
  for (let by = 0; by < rows; by++) {
    const yEnd = Math.min(H, (by + 1) * bh);
    for (let bx = 0; bx < cols; bx++) {
      const xEnd = Math.min(W, (bx + 1) * bw);
      let mx = 0;
      for (let y = by * bh; y < yEnd; y++) {
        const row = y * W;
        for (let x = bx * bw; x < xEnd; x++) { const v = gray[row + x]; if (v > mx) mx = v; }
      }
      paper[by * cols + bx] = mx;
    }
  }

  // Widen each block's estimate to its 3x3 neighbourhood. A registration
  // marker is a solid black square bigger than one block, so a block landing
  // wholly inside one would otherwise report the marker's own darkness as
  // "paper" — and dividing by that turns the marker white and loses it. Taking
  // the brightest of the surrounding blocks means any block within one block
  // of real paper still sees paper, so large dark objects survive the
  // correction intact. This is what lets the markers be found on the corrected
  // image, which is the whole point: they were being missed in shadow.
  const widened = new Float32Array(paper.length);
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      let mx = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const y = by + dy; if (y < 0 || y >= rows) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const x = bx + dx; if (x < 0 || x >= cols) continue;
          const v = paper[y * cols + x]; if (v > mx) mx = v;
        }
      }
      widened[by * cols + bx] = mx;
    }
  }
  paper.set(widened);

  // Bilinear between block centres, so the correction varies smoothly instead
  // of printing block edges across the page.
  const out = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(rows - 1, Math.max(0, y / bh - 0.5));
    const gy0 = Math.floor(fy), gy1 = Math.min(rows - 1, gy0 + 1), ty = fy - gy0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(cols - 1, Math.max(0, x / bw - 0.5));
      const gx0 = Math.floor(fx), gx1 = Math.min(cols - 1, gx0 + 1), tx = fx - gx0;
      const p =
        paper[gy0 * cols + gx0] * (1 - tx) * (1 - ty) +
        paper[gy0 * cols + gx1] * tx * (1 - ty) +
        paper[gy1 * cols + gx0] * (1 - tx) * ty +
        paper[gy1 * cols + gx1] * tx * ty;
      // Guard a near-black estimate (a photo so dark there is no paper to
      // find) from turning into a divide-by-nothing explosion.
      out[y * W + x] = p > 8 ? (gray[y * W + x] * 255) / p : gray[y * W + x];
    }
  }
  return out;
}

// Local adaptive threshold (Sauvola) — decides ink vs paper per PIXEL, from
// the paper immediately around it, instead of one cutoff number for a whole
// box.
//
// A single threshold assumes the box is evenly lit. Real photos are not:
// people shoot on a desk under one lamp, or with their own shadow across the
// page, so one side of a box is darker than the other. Any single number is
// then wrong somewhere — too low on the shady side and thin strokes fall the
// wrong side of it and simply disappear, which is what put breaks in a W's
// stem and an f that have none on paper.
//
// Sauvola compares each pixel to the local mean, and pulls the threshold down
// where the local variation is low. On blank paper (low variation) it demands
// a genuinely dark pixel, so it doesn't hallucinate ink out of noise; across a
// stroke (high variation) it accepts a lighter pixel, so faint and thin parts
// survive. Computed with integral images, so the window costs the same at any
// size.
//
// R = 128 is the standard dynamic-range constant for 8-bit input; k controls
// how eagerly faint ink is accepted — lower keeps more of a light pen.
function sauvolaInk(gray, W, H, win, k, inkCeiling) {
  const stride = W + 1;
  const sum = new Float64Array(stride * (H + 1));
  const sumSq = new Float64Array(stride * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0, rowSumSq = 0;
    for (let x = 0; x < W; x++) {
      const v = gray[y * W + x];
      rowSum += v; rowSumSq += v * v;
      sum[(y + 1) * stride + (x + 1)] = sum[y * stride + (x + 1)] + rowSum;
      sumSq[(y + 1) * stride + (x + 1)] = sumSq[y * stride + (x + 1)] + rowSumSq;
    }
  }
  const r = win >> 1;
  const R = 128;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const a = (y1 + 1) * stride + (x1 + 1), b = y0 * stride + (x1 + 1);
      const c = (y1 + 1) * stride + x0, d = y0 * stride + x0;
      const mean = (sum[a] - sum[b] - sum[c] + sum[d]) / area;
      const varr = Math.max(0, (sumSq[a] - sumSq[b] - sumSq[c] + sumSq[d]) / area - mean * mean);
      const T = mean * (1 + k * (Math.sqrt(varr) / R - 1));
      // Local contrast alone is not enough to call something ink. The printed
      // guide lines and cell borders are light grey on white — faint to the
      // eye, but a big LOCAL step, so a purely relative rule happily promotes
      // them to ink and welds the baseline through every letter. A pen mark
      // is dark in absolute terms as well as relative ones, so require both.
      const v = gray[y * W + x];
      if (v < T && v < inkCeiling) out[y * W + x] = 1;
    }
  }
  return out;
}

// Morphological open (erode then dilate, 4-connected): erosion drops any ink
// pixel touching a background neighbor, wiping single-pixel noise and the
// hairline bridges that fuse it to real strokes, while a solid stroke keeps
// an untouched interior; dilation grows that interior back out.
function erode4(mask, W, H) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      if (x === 0 || x === W - 1 || y === 0 || y === H - 1) continue;
      if (mask[i - 1] && mask[i + 1] && mask[i - W] && mask[i + W]) out[i] = 1;
    }
  }
  return out;
}
function dilate4(mask, W, H) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let v = mask[i];
      if (!v && x > 0) v = mask[i - 1];
      if (!v && x < W - 1) v = mask[i + 1];
      if (!v && y > 0) v = mask[i - W];
      if (!v && y < H - 1) v = mask[i + W];
      out[i] = v ? 1 : 0;
    }
  }
  return out;
}

// The printed corner hint letter is real black ink, so thresholding alone
// can't tell it from the writer's pen — strip ONLY its own connected blob.
// A hint fragment is entirely CONTAINED in the hint box, while a real letter
// that merely starts near that corner keeps going past it, so its bounding
// box is never fully inside and it survives untouched. (A blind rectangular
// erase clipped real "H"/"S"/"J" ascenders; this doesn't.)
function stripHintBlob(ink, W, H, hx0, hy0, hx1, hy1) {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const tol = 1;
  for (let s = 0; s < ink.length; s++) {
    if (!ink[s] || seen[s]) continue;
    let sp = 0;
    const members = [];
    let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
    stack[sp++] = s; seen[s] = 1;
    while (sp) {
      const p = stack[--sp]; members.push(p);
      const x = p % W, y = (p / W) | 0;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
      if (y < by0) by0 = y; if (y > by1) by1 = y;
      if (x > 0 && ink[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < W - 1 && ink[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && ink[p - W] && !seen[p - W]) { seen[p - W] = 1; stack[sp++] = p - W; }
      if (y < H - 1 && ink[p + W] && !seen[p + W]) { seen[p + W] = 1; stack[sp++] = p + W; }
    }
    const withinHint = bx0 >= hx0 - tol && by0 >= hy0 - tol && bx1 <= hx1 + tol && by1 <= hy1 + tol;
    if (withinHint) { for (const p of members) ink[p] = 0; }
  }
}

// NOTE: there is deliberately no stray-removal pass here any more.
//
// There used to be one, to delete ink that had leaked in from a neighbouring
// box. That leak was a symptom of rectifying the photo with straight-line
// interpolation instead of a real perspective transform (see makeMapper); now
// that a cell's scan region actually lands on its own printed box, there is
// nothing foreign to remove.
//
// Guessing which marks belong is also the wrong job to be doing. Every rule
// for it — too small, too far away, touching an edge — is a rule about what a
// letter is supposed to look like, and this app must not care: a sheet of
// arrows or pictograms has to scan exactly as well as a sheet of letters.
// Whatever is inside the box is the character. despeckle() still drops
// specks below a pixel-area floor, which is sensor noise, not intent.

function despeckle(ink, W, H, minArea) {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let kept = 0;
  for (let s = 0; s < ink.length; s++) {
    if (!ink[s] || seen[s]) continue;
    let sp = 0, n = 0;
    const members = [];
    stack[sp++] = s; seen[s] = 1;
    while (sp) {
      const p = stack[--sp]; members.push(p); n++;
      const x = p % W, y = (p / W) | 0;
      if (x > 0 && ink[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < W - 1 && ink[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && ink[p - W] && !seen[p - W]) { seen[p - W] = 1; stack[sp++] = p - W; }
      if (y < H - 1 && ink[p + W] && !seen[p + W]) { seen[p + W] = 1; stack[sp++] = p + W; }
    }
    if (n < minArea) { for (const p of members) ink[p] = 0; }
    else kept += n;
  }
  return kept;
}

async function makeCropBlob(ink, iw, ih, baseRowOutH) {
  let x0 = iw, y0 = ih, x1 = -1, y1 = -1;
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
    if (ink[y * iw + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const cw = w + 2 * PAD, ch = h + 2 * PAD;
  const buf = new Uint8Array(cw * ch).fill(255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (ink[(y0 + y) * iw + (x0 + x)]) buf[(y + PAD) * cw + (x + PAD)] = 0;
  }
  const blob = await grayToPNGBlob(buf, cw, ch);
  // Baseline row relative to THIS crop's own top-left (after tight-cropping
  // to ink + adding PAD) — valid even when it falls outside the visible crop
  // (a glyph drawn entirely above or below it), since it's only ever used as
  // a placement anchor, never as a bound.
  const baselineOffset = baseRowOutH - y0 + PAD;
  return { blob, cropSize: { width: cw, height: ch }, baselineOffset };
}

/**
 * @param {File|Blob} photo
 * @param {(chars: string[]) => {cols,rows,cw,ch,cells:Array}} layout from templategeo.js
 * @param {string[]} chars the charset in use
 * @param {(p:{phase:string, done?:number, total?:number})=>void} [onProgress]
 *   'decoding' (the slowest single step for a HEIC), 'locating' (finding the
 *   corner marks), then 'reading' with done/total as each cell is cut out.
 * @returns {Promise<{labels:Object, blobs:Array, cols, rows, found:number, total:number}>}
 *   blobs[i] = { id, char, blob: PNGBlob, cropSize, baselineOffset, capRefPx }
 */
async function scanTemplate(photo, layout, chars, onProgress = () => {}) {
  onProgress({ phase: 'decoding' });
  const { data, width: W, height: H } = await decodeToGray(photo, { maxSide: MAX_SIDE });

  // Even out the lighting FIRST, so everything after it — markers included —
  // sees a page with uniform white paper. Marker detection uses a fixed
  // darkness cutoff, which silently fails on a page lit from one side: the
  // markers on the shaded half stop qualifying, a wrong point gets picked, and
  // the whole grid shifts while still reporting success.
  const flat = flattenIllumination(data, W, H);

  onProgress({ phase: 'locating' });
  const markers = findMarkers(flat, W, H);
  if (!markers) {
    const err = new Error('Could not find the four black corner markers. Make sure the whole sheet is in frame, flat and evenly lit, with all four corners visible.');
    err.code = 'NO_MARKERS';
    throw err;
  }
  const map = makeMapper(markers);

  const L = layout(chars);
  let cellsDone = 0;
  onProgress({ phase: 'reading', done: 0, total: L.cells.length });

  const blobs = [];
  const labels = {};
  for (const cell of L.cells) {
    cellsDone++;
    onProgress({ phase: 'reading', done: cellsDone, total: L.cells.length });
    const [uvTL, uvTR, uvBR, uvBL] = cell.scanUV;
    const Ptl = map(...uvTL), Ptr = map(...uvTR), Pbr = map(...uvBR), Pbl = map(...uvBL);
    const wpx = Math.hypot(Ptr[0] - Ptl[0], Ptr[1] - Ptl[1]);
    const hpx = Math.hypot(Pbl[0] - Ptl[0], Pbl[1] - Ptl[1]);
    const OUT_W = Math.max(160, Math.min(1400, Math.round(wpx)));
    const OUT_H = Math.max(160, Math.min(1800, Math.round(hpx)));

    // rectify the cell (left unmasked — stripHintBlob removes the printed
    // hint by connected component below, not by blind geometry)
    const cellGray = new Float32Array(OUT_W * OUT_H);
    for (let oy = 0; oy < OUT_H; oy++) {
      const t = oy / (OUT_H - 1);
      for (let ox = 0; ox < OUT_W; ox++) {
        const s = ox / (OUT_W - 1);
        const tp = lerp(Ptl, Ptr, s);
        const bt = lerp(Pbl, Pbr, s);
        const src = lerp(tp, bt, t);
        cellGray[oy * OUT_W + ox] = sampleGray(flat, W, H, src[0], src[1]);
      }
    }
    const hx0 = Math.round(cell.hintFrac.x0 * OUT_W), hx1 = Math.round(cell.hintFrac.x1 * OUT_W);
    const hy0 = Math.round(cell.hintFrac.y0 * OUT_H), hy1 = Math.round(cell.hintFrac.y1 * OUT_H);
    // Distance (in this cell's own rectified pixels) from the top of the
    // scanned area down to the baseline — doubles as the build's per-glyph
    // scale reference, since every cell shares it by construction.
    const baseRowOutH = cell.baselineFrac * OUT_H;

    // mn/mx exclude the hint region, so a cell holding nothing but the hint's
    // own ink still reads as blank below.
    let mn = 255, mx = 0;
    for (let oy = 0; oy < OUT_H; oy++) {
      for (let ox = 0; ox < OUT_W; ox++) {
        if (ox >= hx0 && ox < hx1 && oy >= hy0 && oy < hy1) continue;
        const v = cellGray[oy * OUT_W + ox];
        if (v < mn) mn = v; if (v > mx) mx = v;
      }
    }

    // Window a few stroke-widths across: wide enough to hold both ink and the
    // paper beside it (so the local mean means something), narrow enough to
    // track a shadow moving across the box.
    const win = (Math.max(15, Math.round(OUT_W / 8)) | 1);
    // Absolute ink ceiling, from this cell's own range. mn is the darkest
    // pixel (pen), mx the lightest (paper); real pen sits near mn, the printed
    // guides sit near mx. Anything above 45% of the way from pen to paper is
    // page furniture, not a mark someone made.
    const inkCeiling = mn + 0.45 * (mx - mn);
    let ink = sauvolaInk(cellGray, OUT_W, OUT_H, win, 0.18, inkCeiling);

    stripHintBlob(ink, OUT_W, OUT_H, hx0, hy0, hx1, hy1);
    // The morphological open that used to run here is gone. Erosion strips a
    // pixel off every edge of every stroke, which erases outright any stroke
    // only a pixel or two wide — dilation then has nothing to grow back. It
    // was there to kill speckle, but despeckle() below already does that by
    // blob area, which is a measure of noise that doesn't also punish a thin
    // line for being thin.

    if (mn > 150) continue;
    const minBlob = Math.max(6, Math.round(0.00035 * OUT_W * OUT_H));
    const kept = despeckle(ink, OUT_W, OUT_H, minBlob);
    if (kept < minBlob) continue;

    const crop = await makeCropBlob(ink, OUT_W, OUT_H, baseRowOutH);
    if (!crop) continue;
    blobs.push({
      id: cell.index, char: cell.char, blob: crop.blob, cropSize: crop.cropSize,
      baselineOffset: crop.baselineOffset, capRefPx: baseRowOutH,
    });
    labels[cell.index] = cell.char;
  }

  return { labels, blobs, cols: L.cols, rows: L.rows, found: blobs.length, total: chars.length };
}

export { scanTemplate, PAD };
