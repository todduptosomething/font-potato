'use strict';
// Browser port of lib/trace2.js — identical potrace options, only the input
// (PNG Blob instead of Node Buffer) and the vendor-bundled Potrace differ.

import { Potrace, Buffer } from './vendor.js';

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * @param {Blob} pngBlob binarized crop (black ink on white)
 * @param {{smooth?:number, detail?:number}} opts
 * @returns {Promise<string>} SVG path `d` in crop pixel coordinates
 */
async function trace(pngBlob, { smooth = 1, detail = 0.25 } = {}) {
  const d = Math.max(0, Math.min(1, detail));
  const buf = Buffer.from(await pngBlob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const t = new Potrace({
      threshold: 128,
      blackOnWhite: true,
      turdSize: Math.round(lerp(1, 10, d)),
      alphaMax: 0.8 + 0.25 * smooth,
      optCurve: true,
      optTolerance: lerp(0.02, 0.45, d),
      turnPolicy: Potrace.TURNPOLICY_MINORITY,
    });
    t.loadImage(buf, function (err) {
      if (err) return reject(err);
      const m = /d="([^"]*)"/.exec(this.getPathTag());
      resolve(m ? m[1] : '');
    });
  });
}

export { trace };
