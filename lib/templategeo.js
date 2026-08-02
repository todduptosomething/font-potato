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

const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...'abcdefghijklmnopqrstuvwxyz'];
const DIGITS = [...'0123456789'];
// every printable symbol on a US keyboard
const SYMBOLS = [...'`~!@#$%^&*()-_=+[]{}\\|;:\'",.<>/?'];

const CHARSETS = {
  basic: [...LETTERS, ...DIGITS],                 // 62
  full: [...LETTERS, ...DIGITS, ...SYMBOLS],      // 94 — all keyboard characters
};

function columnsFor(n) {
  if (n <= 72) return 7;
  return 8;
}

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
 */
function layout(chars) {
  const cols = columnsFor(chars.length);
  const rows = Math.ceil(chars.length / cols);
  const cw = (GRID.x1 - GRID.x0) / cols;
  const ch = (GRID.y1 - GRID.y0) / rows;
  const INSET_X = 0.1;  // skip cell borders / neighbour bleed
  const INSET_TOP = 0.06;
  const INSET_BOT = 0.06;

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
    return { char, index, col, row, rect: [x0, y0, x1, y1], scanUV };
  });

  return { cols, rows, cw, ch, cells };
}

module.exports = { PAGE, MARKER_SIZE, REG, GRID, CHARSETS, layout, toUV, columnsFor };
