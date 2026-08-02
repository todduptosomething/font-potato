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

const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...'abcdefghijklmnopqrstuvwxyz'];
const DIGITS = [...'0123456789'];
const SYMBOLS = [...'`~!@#$%^&*()-_=+[]{}\\|;:\'",.<>/?'];

const CHARSETS = {
  basic: [...LETTERS, ...DIGITS],
  full: [...LETTERS, ...DIGITS, ...SYMBOLS],
};

function columnsFor(n) {
  if (n <= 72) return 7;
  return 8;
}

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
    return { char, index, col, row, rect: [x0, y0, x1, y1], scanUV };
  });

  return { cols, rows, cw, ch, cells };
}

export { PAGE, MARKER_SIZE, REG, GRID, CHARSETS, layout, toUV, columnsFor };
