'use strict';
// Writes the printable template to public/handwriting-template.pdf.
//
// The sheet is identical for everybody, so there's no reason to generate it
// per request — as a file in public/ it's served straight off the CDN with
// no server involved, which is also what lets the whole app deploy as static
// files. Run this (via `npm run build:template`) after ANY change to
// lib/templategeo.js: the scanner reads the same geometry module, so a
// stale PDF means the printed sheet and the scanner disagree about where
// the cells are.
//
// Run it on macOS. The sheet is set in Georgia, which pdfkit reads from
// /System/Library/Fonts; elsewhere it silently falls back to Times and the
// printed sheet stops matching the one we've tested.

const fs = require('fs');
const path = require('path');
const { generateTemplatePDF } = require('../lib/template');

const OUT = path.join(__dirname, '..', 'public', 'handwriting-template.pdf');

generateTemplatePDF({ charset: 'full' })
  .then((pdf) => {
    fs.writeFileSync(OUT, pdf);
    console.log(`wrote ${path.relative(process.cwd(), OUT)} (${pdf.length} bytes)`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
