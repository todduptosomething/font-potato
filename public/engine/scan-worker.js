'use strict';
// Runs the whole photo-reading pass off the main thread. Decoding a 4.5MB
// iPhone HEIC through libheif-wasm plus rectifying 94 cells takes several
// seconds of solid CPU — on the main thread that freezes the page, so no
// spinner or progress bar could even paint. Everything it touches
// (OffscreenCanvas, createImageBitmap, the wasm decoder) works in a Worker.
//
// `layout` is a function and can't be posted across the worker boundary, so
// the worker imports it itself and the caller only sends the charset name.

import { scanTemplate } from './templatescan.js';
import { layout, CHARSETS } from './templategeo.js';
import { warmHeif } from './image.js';

self.onmessage = async (ev) => {
  const { type, photo, charset } = ev.data;

  // 'warm' is fire-and-forget: pull in the HEIC decoder and compile its wasm
  // now, so choosing a photo later doesn't stall on it. Measured worth
  // several seconds on the first scan of a session.
  if (type === 'warm') {
    warmHeif();
    return;
  }

  try {
    const chars = CHARSETS[charset] || CHARSETS.full;
    const result = await scanTemplate(photo, layout, chars, (p) => {
      self.postMessage({ type: 'progress', ...p });
    });
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: (err && err.message) || String(err),
      code: err && err.code,
    });
  }
};
