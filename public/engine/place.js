'use strict';
// Baseline-anchored glyph placement + the ink silhouette that automatic
// kerning is computed from. Browser port of the corresponding pieces of
// lib/fontbuild.js. Shared by traceGlyph.js (inside the Worker) and
// fontbuild.js (main thread), so both agree on the same coordinate space.

import { svgpath, fixWinding } from './vendor.js';

// The ONLY vertical reference is the template's own printed baseline (see
// templategeo.js's BASELINE_Y_FRAC) — there is no per-character cap-height
// or x-height band. A glyph's height above and below that line is exactly
// what the writer drew, so small caps, swash capitals that dip below the
// baseline, or arrows and pictograms all place correctly: nothing here
// assumes what a given character "should" look like.
//
// capRefPx is the pixel distance from the top of the scanned cell area down
// to the baseline. Every cell shares it by construction (same grid, same
// baseline fraction), so it doubles as a stable pixels-per-font-unit
// reference: REF_UNITS is how many font units that span is worth.
const REF_UNITS = 700;
const LSB = 30, RSB = 30;

function placeGlyphBaseline(d, cropWidth, pad, capRefPx, baselineOffset, { lsb = LSB, rsb = RSB } = {}) {
  const inkW = cropWidth - 2 * pad;
  const scale = capRefPx > 0 ? REF_UNITS / capRefPx : 1;
  const placed = svgpath(d)
    .translate(-pad, -baselineOffset)
    .scale(scale, -scale)
    .translate(lsb, 0)
    .round(1)
    .toString();
  return { d: fixWinding(placed), advance: Math.round(lsb + inkW * scale + rsb) };
}

// A coarse silhouette of the glyph — for each ink row, how far left and
// right it reaches, in the same baseline-anchored font-unit space. This is
// what makes automatic kerning possible without assuming anything about a
// character's shape: a "T" naturally reports lots of empty space under its
// crossbar, an "l" almost none, purely from what was actually drawn.
// Takes the binarized ink array directly (no re-decode).
function inkProfileFromInk(ink, W, H, scale, pad, baselineOffset) {
  const rows = [];
  for (let y = 0; y < H; y++) {
    let left = -1, right = -1;
    const rowBase = y * W;
    for (let x = 0; x < W; x++) {
      if (ink[rowBase + x]) { if (left < 0) left = x; right = x; }
    }
    if (left < 0) continue;
    rows.push({
      y: (baselineOffset - y) * scale,
      l: LSB + (left - pad) * scale,
      r: LSB + (right - pad) * scale,
    });
  }
  return rows;
}

export { REF_UNITS, LSB, RSB, placeGlyphBaseline, inkProfileFromInk };
