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

function makeMapper({ TL, TR, BL, BR }) {
  return (u, v) => {
    const top = lerp(TL, TR, u);
    const bot = lerp(BL, BR, u);
    return lerp(top, bot, v);
  };
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

// Drop small ink blobs far from the main glyph — cross-cell bleed from a
// neighboring box creeping in at the inset boundary. Left alone, a stray
// fleck stretches the tight crop bbox way past the real letter, so the letter
// then places as if it filled only a sliver of its box and renders tiny.
// Only a blob both clearly smaller than AND clearly separated from the main
// mass is dropped, so i-dots, colons and crossbars survive.
function dropFarStrays(ink, W, H) {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const blobs = [];
  for (let s = 0; s < ink.length; s++) {
    if (!ink[s] || seen[s]) continue;
    let sp = 0, n = 0;
    const members = [];
    let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
    stack[sp++] = s; seen[s] = 1;
    while (sp) {
      const p = stack[--sp]; members.push(p); n++;
      const x = p % W, y = (p / W) | 0;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
      if (y < by0) by0 = y; if (y > by1) by1 = y;
      if (x > 0 && ink[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < W - 1 && ink[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && ink[p - W] && !seen[p - W]) { seen[p - W] = 1; stack[sp++] = p - W; }
      if (y < H - 1 && ink[p + W] && !seen[p + W]) { seen[p + W] = 1; stack[sp++] = p + W; }
    }
    blobs.push({ members, n, bx0, by0, bx1, by1 });
  }
  if (blobs.length < 2) return;
  const main = blobs.reduce((a, b) => (b.n > a.n ? b : a));
  const gapThresh = 0.20 * Math.min(W, H);
  // The commonest intruder is the PRINTED hint from the next box down. Each
  // cell masks its own hint (see stripHintBlob), but nothing masks a
  // neighbour's, and the hint is deliberately real black ink so a person can
  // read it — so when the rectified grid drifts by a hair, the top of the
  // hint below lands inside the bottom of this cell and survives
  // thresholding. Observed as an 'i' carrying the tip of the 'q' printed in
  // the box beneath it, which then stretched the crop and wrecked the
  // letter's advance width.
  //
  // The size rule below can't catch it: it keeps anything ≥25% of the main
  // mass precisely so an i's dot survives, and an i is a thin stem, so a
  // sliver clears that bar easily. The guard built to protect the dot is what
  // waves the intruder through.
  //
  // The edge is what separates them. A letter's own detached parts — the dot
  // on an i or j, the two of a colon, the bar of an = — sit inside the box
  // with air around them. Anything arriving from outside crosses the boundary
  // to get here, so it runs off the edge: a fragment cut by the box rather
  // than a mark placed within it. That's a property of position, not of what
  // a character is supposed to look like, so a sheet of arrows or pictograms
  // is judged by the same rule.
  //
  // Only non-main blobs are tested, so a letter that genuinely overshoots its
  // own box is never harmed — it's the largest mass in the cell and is kept
  // whatever it touches.
  const EDGE = 1;
  for (const b of blobs) {
    if (b === main) continue;
    if (b.by0 <= EDGE || b.by1 >= H - 1 - EDGE) {
      for (const p of b.members) ink[p] = 0;
      continue;
    }
    if (b.n >= 0.25 * main.n) continue; // comparable size (colon, crossbar) -> keep
    const dx = Math.max(0, Math.max(main.bx0, b.bx0) - Math.min(main.bx1, b.bx1));
    const dy = Math.max(0, Math.max(main.by0, b.by0) - Math.min(main.by1, b.by1));
    if (Math.hypot(dx, dy) > gapThresh) { for (const p of b.members) ink[p] = 0; }
  }
}

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

  onProgress({ phase: 'locating' });
  const markers = findMarkers(data, W, H);
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
        cellGray[oy * OUT_W + ox] = sampleGray(data, W, H, src[0], src[1]);
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

    const T = Math.min(150, mn + 0.45 * (mx - mn));
    let ink = new Uint8Array(OUT_W * OUT_H);
    for (let i = 0; i < ink.length; i++) if (cellGray[i] < T) ink[i] = 1;

    stripHintBlob(ink, OUT_W, OUT_H, hx0, hy0, hx1, hy1);
    ink = dilate4(erode4(ink, OUT_W, OUT_H), OUT_W, OUT_H);

    if (mn > 150) continue;
    const minBlob = Math.max(6, Math.round(0.00035 * OUT_W * OUT_H));
    const kept = despeckle(ink, OUT_W, OUT_H, minBlob);
    if (kept < minBlob) continue;
    dropFarStrays(ink, OUT_W, OUT_H);

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
