'use strict';
// Trace a binarized glyph crop to an SVG path. Speck-removal and curve
// fidelity are fixed, sensible constants now — the only user-facing
// smoothing control is Edge Smoothness (a pre-threshold blur, applied by
// fontbuild.js before this runs), which testing showed is the one that
// actually matters on real photographed handwriting; corner-rounding and
// curve-fit tolerance barely moved the needle on real photos.
const { Potrace } = require('potrace');

const TURD_SIZE = 2;        // low: keeps small features (dots, serifs) — a future brush font keeps its specks
const ALPHA_MAX = 1.05;     // moderate corner rounding
const OPT_TOLERANCE = 0.15; // moderate curve-fit fidelity

/**
 * @param {Buffer} png binarized crop (black ink on white)
 * @returns {Promise<string>} SVG path `d` in crop pixel coordinates
 */
function trace(png) {
  return new Promise((resolve, reject) => {
    const t = new Potrace({
      threshold: 128,
      blackOnWhite: true,
      turdSize: TURD_SIZE,
      alphaMax: ALPHA_MAX,
      optCurve: true,
      optTolerance: OPT_TOLERANCE,
      turnPolicy: Potrace.TURNPOLICY_MINORITY,
    });
    t.loadImage(png, function (err) {
      if (err) return reject(err);
      const m = /d="([^"]*)"/.exec(this.getPathTag());
      resolve(m ? m[1] : '');
    });
  });
}

module.exports = { trace };
