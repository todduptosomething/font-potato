'use strict';
// Browser port of lib/templatescan.js. All the marker-detection / rectify /
// despeckle math is unchanged plain array logic (it never touched sharp) —
// only the two image decode/encode boundary calls are swapped for image.js's
// Canvas-based equivalents. See lib/templatescan.js for the original
// commentary; kept terse here to avoid duplicating it.

import { decodeToGray, grayToPNGBlob } from './image.js';

const PAD = 8;
const MAX_SIDE = 8000;

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

async function makeCropBlob(ink, iw, ih) {
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
  return { blob, cropSize: { width: cw, height: ch } };
}

/**
 * @param {File|Blob} photo
 * @param {(chars: string[]) => {cols,rows,cw,ch,cells:Array}} layout from templategeo.js
 * @param {string[]} chars the charset in use
 * @returns {Promise<{labels:Object, blobs:Array, cols, rows, found:number, total:number}>}
 *   blobs[i] = { id, char, blob: PNGBlob, cropSize }
 */
async function scanTemplate(photo, layout, chars) {
  const { data, width: W, height: H } = await decodeToGray(photo, { maxSide: MAX_SIDE });

  const markers = findMarkers(data, W, H);
  if (!markers) {
    const err = new Error('Could not find the four black corner markers. Make sure the whole sheet is in frame, flat and evenly lit, with all four corners visible.');
    err.code = 'NO_MARKERS';
    throw err;
  }
  const map = makeMapper(markers);
  const L = layout(chars);

  const blobs = [];
  const labels = {};
  for (const cell of L.cells) {
    const [uvTL, uvTR, uvBR, uvBL] = cell.scanUV;
    const Ptl = map(...uvTL), Ptr = map(...uvTR), Pbr = map(...uvBR), Pbl = map(...uvBL);
    const wpx = Math.hypot(Ptr[0] - Ptl[0], Ptr[1] - Ptl[1]);
    const hpx = Math.hypot(Pbl[0] - Ptl[0], Pbl[1] - Ptl[1]);
    const OUT_W = Math.max(160, Math.min(1400, Math.round(wpx)));
    const OUT_H = Math.max(160, Math.min(1800, Math.round(hpx)));

    const cellGray = new Float32Array(OUT_W * OUT_H);
    let mn = 255, mx = 0;
    for (let oy = 0; oy < OUT_H; oy++) {
      const t = oy / (OUT_H - 1);
      for (let ox = 0; ox < OUT_W; ox++) {
        const s = ox / (OUT_W - 1);
        const tp = lerp(Ptl, Ptr, s);
        const bt = lerp(Pbl, Pbr, s);
        const src = lerp(tp, bt, t);
        const val = sampleGray(data, W, H, src[0], src[1]);
        cellGray[oy * OUT_W + ox] = val;
        if (val < mn) mn = val; if (val > mx) mx = val;
      }
    }
    const T = Math.min(150, mn + 0.45 * (mx - mn));
    const ink = new Uint8Array(OUT_W * OUT_H);
    for (let i = 0; i < ink.length; i++) if (cellGray[i] < T) ink[i] = 1;

    if (mn > 150) continue;
    const minBlob = Math.max(6, Math.round(0.00035 * OUT_W * OUT_H));
    const kept = despeckle(ink, OUT_W, OUT_H, minBlob);
    if (kept < minBlob) continue;

    const crop = await makeCropBlob(ink, OUT_W, OUT_H);
    if (!crop) continue;
    blobs.push({ id: cell.index, char: cell.char, blob: crop.blob, cropSize: crop.cropSize });
    labels[cell.index] = cell.char;
  }

  return { labels, blobs, cols: L.cols, rows: L.rows, found: blobs.length, total: chars.length };
}

export { scanTemplate, PAD };
