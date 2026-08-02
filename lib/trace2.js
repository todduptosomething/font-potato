'use strict';
// Trace a binarized glyph crop to an SVG path. Always traces at a fine base
// level; the `detail` value (0 = fine & thin, 1 = filled) then decides how much
// small structure to keep vs. simplify. Gap-filling (closing small breaks) is
// done in fontbuild before this runs.
const { Potrace } = require('potrace');

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * @param {Buffer} png binarized crop (black ink on white)
 * @param {{smooth?:number, detail?:number}} opts
 *   smooth 0..2 (corner roundness), detail 0..1 (fine .. filled)
 * @returns {Promise<string>} SVG path `d` in crop pixel coordinates
 */
function trace(png, { smooth = 1, detail = 0.25 } = {}) {
  const d = Math.max(0, Math.min(1, detail));
  return new Promise((resolve, reject) => {
    const t = new Potrace({
      threshold: 128,
      blackOnWhite: true,
      // fine end keeps tiny features; filled end drops specks and simplifies
      turdSize: Math.round(lerp(1, 10, d)),
      alphaMax: 0.8 + 0.25 * smooth,             // corner rounding = Smoothness
      optCurve: true,
      optTolerance: lerp(0.02, 0.45, d),         // hug outline (fine) .. simplify (filled)
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
