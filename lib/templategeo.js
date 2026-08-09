'use strict';
// Single source of truth for the printable template geometry. BOTH the PDF
// generator (lib/template.js) and the scanner (lib/templatescan.js) import this,
// so a cell drawn on paper and the region scanned from the photo are guaranteed
// to line up. All coordinates are in PDF points on a US Letter page (612x792),
// origin top-left.

const PAGE = { w: 612, h: 792 };
const MARKER_SIZE = 32; // filled black registration square, points

// Marker CENTERS define the registration rectangle the scanner locks onto.
// Pushed close to the page edges so the grid (and each box) is as large as
// possible on a printed US Letter sheet.
const REG = {
  tl: [46, 96],
  tr: [566, 96],
  bl: [46, 764],
  br: [566, 764],
};

// Grid area (inside the markers) where glyph cells live.
const GRID = { x0: 46, x1: 566, y0: 120, y1: 748 };

// Small black "which letter is this" hint, tucked in a cell's corner. It's
// real ink now (readable, not scanner-invisible light grey), so its POSITION
// is the only thing keeping it out of the writer's glyph: the scanner masks
// this exact box out of what it reads as ink, before thresholding. Fractions
// are of the full, un-inset cell rect (same space as a cell's `rect`). Used
// for letters and digits, which are unambiguous even as a single character.
const HINT = { x0: 0.04, y0: 0.04, x1: 0.34, y1: 0.30 };

// Symbols get a spelled-out word instead (e.g. "comma") along a thin strip
// across the cell's top — a single small glyph is too easy to mix up (a
// comma and an apostrophe look nearly identical at hint size). Same masking
// contract as HINT, just a different shape: full width, short.
const HINT_WORD = { x0: 0.03, y0: 0.03, x1: 0.97, y1: 0.20 };

// What the SCANNER masks out is deliberately bigger than what's actually
// printed (HINT/HINT_WORD above) — real scanned photos showed small slivers
// of the hint surviving. The real flaw wasn't that the box was too small
// overall: HINT starts at x0/y0 = 0.04, leaving a thin strip along the cell's
// absolute corner and top edge that was NEVER masked at all — exactly where
// the surviving fragments showed up. Reaching all the way to the true corner
// (0, 0) fixes that directly; the small bump to x1/y1 is just modest extra
// margin for camera/print drift, kept conservative since the writer's own
// ink can start fairly high and left in a cell (tall ascenders, capitals).
const HINT_MASK = { x0: 0.0, y0: 0.0, x1: 0.36, y1: 0.32 };
const HINT_WORD_MASK = { x0: 0.0, y0: 0.0, x1: 1.0, y1: 0.22 };

// Where the printed baseline guide sits within a cell, as a fraction of the
// full (un-inset) cell rect — shared so the PDF draws it and the scanner
// knows exactly which rectified row it lands on, without guessing from ink.
// This is the ONLY vertical anchor a glyph gets: no assumed cap-height or
// x-height band per character (see fontbuild.js) — a glyph's height above
// and below this line is simply whatever the writer actually drew.
const BASELINE_Y_FRAC = 0.74;

// Two more printed guides: a cap line and an x-height line. Unlike the
// baseline these are PURELY for the person holding the pen — the scanner
// never reads them and the font never assumes a letter reaches either one.
// That distinction is the whole point: a font built from letters that drift
// 20% in height reads as sloppy, because a word presses letters together in
// ways the sheet's separate boxes never do, but forcing every letter to a
// fixed height would kill the life in it. Guides let a careful writer stay
// consistent while leaving natural variation intact.
//
// Evenly spaced: 0.18 of a cell between each line. The first pass put the cap
// line at 0.24, matching where capitals landed on a real filled sheet — but
// that measurement came from letters written WITHOUT guides, and it left only
// 0.24 of headroom for anything reaching above the cap line. Swash capitals
// and tall ascenders ran out of room.
//
// Moving both upper lines down to 0.38 and 0.56 gives 0.38 of clear space
// above the cap line, slightly more than a full cap height, so a flourish has
// somewhere to go. The trade is real and deliberate: cap height drops from
// 0.50 of a cell to 0.36, so letters are drawn about 28% smaller and are
// scanned at correspondingly lower resolution. For a face with swashes that's
// the right side of the trade — a clipped flourish is a worse defect than a
// slightly softer curve.
//
// The BASELINE does not move. It's the only line the scanner reads, so
// keeping it fixed means photos of older sheets still scan identically.
const CAP_Y_FRAC = 0.38;
const XHEIGHT_Y_FRAC = 0.56;

const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...'abcdefghijklmnopqrstuvwxyz'];
const DIGITS = [...'0123456789'];
// every printable symbol on a US keyboard
const SYMBOLS = [...'`~!@#$%^&*()-_=+[]{}\\|;:\'",.<>/?'];
const SYMBOL_SET = new Set(SYMBOLS);

const CHARSETS = {
  basic: [...LETTERS, ...DIGITS],                 // 62
  full: [...LETTERS, ...DIGITS, ...SYMBOLS],      // 94 — all keyboard characters
};

function columnsFor(n) {
  if (n <= 72) return 7;
  return 8;
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// Map a page-point to normalized (u,v) in [0,1] across the registration rect.
function toUV(px, py) {
  return [
    (px - REG.tl[0]) / (REG.tr[0] - REG.tl[0]),
    (py - REG.tl[1]) / (REG.bl[1] - REG.tl[1]),
  ];
}

/**
 * Full layout for a character list.
 * @returns {{cols,rows,cw,ch,cells:Array}} each cell has:
 *   char, index, col, row,
 *   rect:[x0,y0,x1,y1]           (points, for drawing)
 *   scanUV:[[u,v]x4]             (TL,TR,BR,BL of the region to scan)
 *   hintFrac:{x0,y0,x1,y1}       (HINT box, as a fraction of the scanned rect)
 */
function layout(chars) {
  const cols = columnsFor(chars.length);
  const rows = Math.ceil(chars.length / cols);
  const cw = (GRID.x1 - GRID.x0) / cols;
  const ch = (GRID.y1 - GRID.y0) / rows;
  // Just enough to clear the printed 0.6pt cell border (comfortably <1% of a
  // ~65-74pt cell) — anything more was needlessly eating into the drawing
  // area and clipping big tails/descenders that reach toward the box edge.
  const INSET_X = 0.025;
  const INSET_TOP = 0.025;
  const INSET_BOT = 0.025;

  const cells = chars.map((char, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x0 = GRID.x0 + col * cw;
    const y0 = GRID.y0 + row * ch;
    const x1 = x0 + cw;
    const y1 = y0 + ch;
    const sx0 = x0 + cw * INSET_X;
    const sx1 = x1 - cw * INSET_X;
    const sy0 = y0 + ch * INSET_TOP;
    const sy1 = y1 - ch * INSET_BOT;
    const scanUV = [
      toUV(sx0, sy0), // TL
      toUV(sx1, sy0), // TR
      toUV(sx1, sy1), // BR
      toUV(sx0, sy1), // BL
    ];
    // The applicable MASK box's corners (deliberately bigger than the printed
    // HINT/HINT_WORD — see above), re-expressed as a fraction of the INSET
    // (scanned) rect rather than the full cell — this is exactly the
    // coordinate space the scanner's rectified OUT_W x OUT_H grid is built
    // in, so it can mask the hint out with a direct fractional lookup, no
    // re-deriving the geometry.
    const box = SYMBOL_SET.has(char) ? HINT_WORD_MASK : HINT_MASK;
    const hintFrac = {
      x0: clamp01((x0 + cw * box.x0 - sx0) / (sx1 - sx0)),
      y0: clamp01((y0 + ch * box.y0 - sy0) / (sy1 - sy0)),
      x1: clamp01((x0 + cw * box.x1 - sx0) / (sx1 - sx0)),
      y1: clamp01((y0 + ch * box.y1 - sy0) / (sy1 - sy0)),
    };
    // Baseline row, re-expressed as a fraction of the INSET (scanned) rect —
    // same trick as hintFrac above, so the scanner can find it with a direct
    // fractional lookup into its rectified OUT_W x OUT_H grid.
    const baseY = y0 + ch * BASELINE_Y_FRAC;
    const baselineFrac = clamp01((baseY - sy0) / (sy1 - sy0));
    return { char, index, col, row, rect: [x0, y0, x1, y1], scanUV, hintFrac, baselineFrac };
  });

  return { cols, rows, cw, ch, cells };
}

module.exports = { PAGE, MARKER_SIZE, REG, GRID, HINT, HINT_WORD, HINT_MASK, HINT_WORD_MASK, BASELINE_Y_FRAC, CAP_Y_FRAC, XHEIGHT_Y_FRAC, CHARSETS, layout, toUV, columnsFor };
