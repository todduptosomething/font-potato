'use strict';
// Printable template PDF. Everything the scanner must ignore (cell borders,
// baseline guides, the faint target letter) is drawn in light grey so
// draw-your-font's binarize `cap` drops it; only the writer's dark pen survives.
// The four solid black corner squares are the registration markers.

const fs = require('fs');
const PDFDocument = require('pdfkit');
const { PAGE, MARKER_SIZE, REG, GRID, layout, CHARSETS } = require('./templategeo');

const GHOST = '#d0d0d0';   // faint hint letter / baseline
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

  // --- glyph cells (target letter left in the built-in sans, unchanged) -----
  const cellFont = Math.min(L.cw, L.ch) * 0.5;
  for (const cell of L.cells) {
    const [x0, y0, x1, y1] = cell.rect;
    const w = x1 - x0, h = y1 - y0;
    doc.rect(x0 + 1, y0 + 1, w - 2, h - 2).lineWidth(0.6).stroke(BORDER);
    const baseY = y0 + h * 0.74;
    doc.moveTo(x0 + w * 0.12, baseY).lineTo(x1 - w * 0.12, baseY).lineWidth(0.5).stroke(GHOST);
    doc.fillColor(GHOST).font('Helvetica').fontSize(cellFont);
    const th = doc.currentLineHeight();
    doc.text(cell.char, x0, baseY - th * 0.78, { width: w, align: 'center', lineBreak: false });
  }

  doc.end();
  return done;
}

module.exports = { generateTemplatePDF };
