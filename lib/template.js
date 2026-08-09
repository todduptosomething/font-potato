'use strict';
// Printable template PDF. Cell borders and the baseline guide are drawn in
// light grey so the scanner's threshold drops them; only the writer's dark
// pen survives. The target-letter hint is real black ink (it needs to be
// readable) tucked in each cell's corner instead — the scanner masks that
// exact spot out geometrically (see templategeo.js's HINT + templatescan.js).
// The four solid black corner squares are the registration markers.

const fs = require('fs');
const PDFDocument = require('pdfkit');
const { PAGE, MARKER_SIZE, REG, GRID, HINT, HINT_WORD, BASELINE_Y_FRAC, layout, CHARSETS } = require('./templategeo');

// Symbols are spelled out as a word instead of shown as a single tiny glyph
// — a comma and an apostrophe look nearly identical at hint size. Pairs that
// only differ by open/close (parens, brackets, braces) share one word: the
// shape itself makes which-is-which obvious once it's actually drawn.
const SYMBOL_WORDS = {
  '`': 'backtick', '~': 'tilde', '!': 'exclamation', '@': 'at', '#': 'hash',
  '$': 'dollar', '%': 'percent', '^': 'caret', '&': 'ampersand', '*': 'asterisk',
  '(': 'parenthesis', ')': 'parenthesis', '-': 'hyphen', '_': 'underscore',
  '=': 'equals', '+': 'plus', '[': 'bracket', ']': 'bracket', '{': 'brace', '}': 'brace',
  '\\': 'backslash', '|': 'pipe', ';': 'semicolon', ':': 'colon',
  "'": 'apostrophe', '"': 'quote', ',': 'comma', '.': 'period',
  '<': 'less than', '>': 'greater than', '/': 'slash', '?': 'question mark',
};

// Shrink a label until it fits both the available width and height, down to
// a floor small enough to still be legible in print.
function fitFontSize(doc, text, maxWidth, maxHeight, maxSize) {
  let size = maxSize;
  while (size > 4.5) {
    doc.fontSize(size);
    if (doc.widthOfString(text) <= maxWidth && doc.currentLineHeight() <= maxHeight) break;
    size -= 0.5;
  }
  return size;
}

// Lighter than it looks like it needs to be on-screen: real photos of a
// printed page rarely capture the page as true white (uneven room lighting,
// shadow, phone auto-exposure), which compresses the gap between "paper" and
// this hint print. #d0d0d0 was measured crossing the scanner's ink threshold
// in cell photos where the paper itself only reached ~188/255 gray — this
// value trades some on-paper legibility of the hint for headroom against that.
const GHOST = '#e6e6e6';   // faint hint letter / baseline
const BORDER = '#dcdcdc';  // cell outline
const INK = '#1b1a17';

// Match the app's serif where we can. Georgia ships on macOS and is in the
// app's font stack; fall back to pdfkit's built-in Times if it's missing.
const GEORGIA = '/System/Library/Fonts/Supplemental/Georgia.ttf';
const GEORGIA_BOLD = '/System/Library/Fonts/Supplemental/Georgia Bold.ttf';
function registerSerif(doc) {
  try {
    if (fs.existsSync(GEORGIA) && fs.existsSync(GEORGIA_BOLD)) {
      doc.registerFont('Serif', GEORGIA);
      doc.registerFont('Serif-Bold', GEORGIA_BOLD);
      return { reg: 'Serif', bold: 'Serif-Bold' };
    }
  } catch { /* fall through */ }
  return { reg: 'Times-Roman', bold: 'Times-Bold' };
}

function drawMarker(doc, cx, cy) {
  const s = MARKER_SIZE;
  doc.rect(cx - s / 2, cy - s / 2, s, s).fill('#000000');
}

/**
 * @param {{charset?:string}} opts
 * @returns {Promise<Buffer>} the PDF
 */
function generateTemplatePDF({ charset = 'full' } = {}) {
  const chars = CHARSETS[charset] || CHARSETS.full;
  const L = layout(chars);

  const doc = new PDFDocument({ size: 'LETTER', margin: 0 });
  const font = registerSerif(doc);
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  // --- header (serif, matching the app) -------------------------------------
  doc.fillColor(INK).font(font.bold).fontSize(19)
    .text('Font Potato', GRID.x0, 26, { lineBreak: false });
  doc.font(font.reg).fontSize(9.5).fillColor('#6b6b6b')
    .text('Write one letter per box with a dark pen. Then photograph the whole sheet — flat, evenly lit, with all four black corners visible.',
      GRID.x0, 52, { width: GRID.x1 - GRID.x0 });

  // --- registration markers -------------------------------------------------
  drawMarker(doc, ...REG.tl);
  drawMarker(doc, ...REG.tr);
  drawMarker(doc, ...REG.bl);
  drawMarker(doc, ...REG.br);

  // --- glyph cells -----------------------------------------------------------
  // The hint is real black ink now (readable, not scanner-invisible grey) —
  // so it only stays out of the writer's glyph because of WHERE it sits. It's
  // drawn inside the exact HINT/HINT_WORD box (shared with the scanner via
  // templategeo.js) so the scanner can mask that same region out of what it
  // reads as ink before thresholding. The baseline stays full-width, thin,
  // and light grey, unchanged: writers still need it to keep every letter's
  // foot landing at a consistent height.
  const cellFont = Math.min(L.cw, L.ch) * 0.22;
  for (const cell of L.cells) {
    const [x0, y0, x1, y1] = cell.rect;
    const w = x1 - x0, h = y1 - y0;
    doc.rect(x0 + 1, y0 + 1, w - 2, h - 2).lineWidth(0.6).stroke(BORDER);
    const baseY = y0 + h * BASELINE_Y_FRAC;
    doc.moveTo(x0 + w * 0.12, baseY).lineTo(x1 - w * 0.12, baseY).lineWidth(0.5).stroke(GHOST);
    doc.fillColor(INK).font('Helvetica');
    const word = SYMBOL_WORDS[cell.char];
    if (word) {
      // The word alone ("backtick") doesn't say which key that is — show the
      // actual character too, and bigger: it's the real target, the word is
      // just a caption disambiguating it from lookalikes (comma/apostrophe).
      const maxW = w * (HINT_WORD.x1 - HINT_WORD.x0);
      const maxH = h * (HINT_WORD.y1 - HINT_WORD.y0);
      const baseX = x0 + w * HINT_WORD.x0, topY = y0 + h * HINT_WORD.y0;
      const gap = maxW * 0.03;

      const charSize = fitFontSize(doc, cell.char, maxW * 0.4, maxH, 13);
      doc.fontSize(charSize);
      const charW = doc.widthOfString(cell.char);
      const charLH = doc.currentLineHeight();
      doc.text(cell.char, baseX, topY, { lineBreak: false });

      const wordSize = fitFontSize(doc, word, maxW - charW - gap, maxH, 7);
      doc.fontSize(wordSize);
      const wordLH = doc.currentLineHeight();
      doc.text(word, baseX + charW + gap, topY + (charLH - wordLH), { width: maxW - charW - gap, lineBreak: false });
    } else {
      doc.fontSize(cellFont);
      doc.text(cell.char, x0 + w * HINT.x0, y0 + h * HINT.y0, { width: w * (HINT.x1 - HINT.x0), lineBreak: false });
    }
  }

  doc.end();
  return done;
}

module.exports = { generateTemplatePDF };
