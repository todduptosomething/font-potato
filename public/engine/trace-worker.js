'use strict';
// Runs inside a Web Worker (see build-controller.js). potrace/Jimp and
// Canvas/OffscreenCanvas all work off the main thread with no DOM dependency,
// so the actual trace bottleneck can run in parallel across a pool of these.

import { traceGlyph } from './traceGlyph.js';

self.onmessage = async (ev) => {
  const { taskId, cropBlob, cropSize, pad, char, weight, fillIters, smooth, detail, capRefPx, baselineOffset } = ev.data;
  try {
    const result = await traceGlyph(cropBlob, cropSize, pad, char, { weight, fillIters, smooth, detail, capRefPx, baselineOffset });
    self.postMessage({ taskId, ok: true, result });
  } catch (err) {
    self.postMessage({ taskId, ok: false, error: (err && err.message) || String(err) });
  }
};
