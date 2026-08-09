'use strict';
// Browser (ESM) copy of lib/templategeo.js — the shared geometry contract
// between the printed template and the scanner. MUST stay byte-identical to
// lib/templategeo.js (only the export style differs) or a printed template
// and a browser scan will silently misalign. This duplication is a temporary
// side effect of the Node server and the browser engine coexisting during the
// migration; once server.js goes away, only this copy remains.

const PAGE = { w: 612, h: 792 };
const MARKER_SIZE = 32;

const REG = {
  tl: [46, 96],
  tr: [566, 96],
  bl: [46, 764],
  br: [566, 764],
};

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

const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...'abcdefghijklmnopqrstuvwxyz'];
const DIGITS = [...'0123456789'];
const SYMBOLS = [...'`~!@#$%^&*()-_=+[]{}\\|;:\'",.<>/?'];
const SYMBOL_SET = new Set(SYMBOLS);

const CHARSETS = {
  basic: [...LETTERS, ...DIGITS],
  full: [...LETTERS, ...DIGITS, ...SYMBOLS],
};

function columnsFor(n) {
  if (n <= 72) return 7;
  return 8;
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

function toUV(px, py) {
  return [
    (px - REG.tl[0]) / (REG.tr[0] - REG.tl[0]),
    (py - REG.tl[1]) / (REG.bl[1] - REG.tl[1]),
  ];
}

function layout(chars) {
  const cols = columnsFor(chars.length);
  const rows = Math.ceil(chars.length / cols);
  const cw = (GRID.x1 - GRID.x0) / cols;
  const ch = (GRID.y1 - GRID.y0) / rows;
  // Kept in sync with lib/templategeo.js — just enough to clear the printed
  // 0.6pt cell border, not eat into the drawing area and clip descenders.
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
      toUV(sx0, sy0), toUV(sx1, sy0), toUV(sx1, sy1), toUV(sx0, sy1),
    ];
    const box = SYMBOL_SET.has(char) ? HINT_WORD_MASK : HINT_MASK;
    const hintFrac = {
      x0: clamp01((x0 + cw * box.x0 - sx0) / (sx1 - sx0)),
      y0: clamp01((y0 + ch * box.y0 - sy0) / (sy1 - sy0)),
      x1: clamp01((x0 + cw * box.x1 - sx0) / (sx1 - sx0)),
      y1: clamp01((y0 + ch * box.y1 - sy0) / (sy1 - sy0)),
    };
    const baseY = y0 + ch * BASELINE_Y_FRAC;
    const baselineFrac = clamp01((baseY - sy0) / (sy1 - sy0));
    return { char, index, col, row, rect: [x0, y0, x1, y1], scanUV, hintFrac, baselineFrac };
  });

  return { cols, rows, cw, ch, cells };
}

export { PAGE, MARKER_SIZE, REG, GRID, HINT, HINT_WORD, HINT_MASK, HINT_WORD_MASK, BASELINE_Y_FRAC, CHARSETS, layout, toUV, columnsFor };
