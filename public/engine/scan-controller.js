'use strict';
// Main-thread wrapper around scan-worker.js: hands the photo off, forwards
// progress, and resolves with the finished scan.
//
// The worker is created once and kept alive rather than spun up per scan.
// Creating it costs a module load plus a wasm compile for the HEIC decoder,
// and paying that on every scan measurably dominated the work itself.
// warmScanWorker() lets the app pay it early — while the user is still
// reading the upload step — so picking a photo doesn't stall.

let worker = null;

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./scan-worker.js', import.meta.url), { type: 'module' });
  }
  return worker;
}

/** Start the worker and pre-compile the HEIC decoder. Safe to call repeatedly. */
function warmScanWorker() {
  try {
    getWorker().postMessage({ type: 'warm' });
  } catch { /* warming is best-effort; a real scan will retry the load */ }
}

/**
 * @param {File|Blob} photo
 * @param {{charset?:string, onProgress?:(p:{phase:string,done?:number,total?:number})=>void}} opts
 * @returns {Promise<{labels:Object, blobs:Array, cols:number, rows:number, found:number, total:number}>}
 */
function scanPhoto(photo, { charset = 'full', onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const w = getWorker();

    const cleanup = () => {
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
    };
    const onMessage = (ev) => {
      const msg = ev.data;
      if (msg.type === 'progress') { onProgress(msg); return; }
      if (msg.type === 'done') { cleanup(); resolve(msg.result); return; }
      if (msg.type === 'error') {
        cleanup();
        const err = new Error(msg.message);
        if (msg.code) err.code = msg.code;
        reject(err);
      }
    };
    const onError = (e) => {
      cleanup();
      // A hard worker failure leaves it in an unknown state — drop it so the
      // next attempt starts clean rather than reusing a broken instance.
      try { w.terminate(); } catch { /* already gone */ }
      worker = null;
      reject(new Error(e.message || 'The photo could not be read.'));
    };

    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    w.postMessage({ type: 'scan', photo, charset });
  });
}

export { scanPhoto, warmScanWorker };
