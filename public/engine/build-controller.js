'use strict';
// Distributes the trace pass (the actual bottleneck) across a pool of Web
// Workers instead of running all ~94 glyphs one at a time on the main
// thread. A simple task queue + free-worker-list keeps every worker busy
// regardless of per-glyph time variance (some letters trace slower than
// others).

const POOL_SIZE = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

class WorkerPool {
  constructor(size) {
    this.workers = Array.from({ length: size }, () => new Worker(new URL('./trace-worker.js', import.meta.url), { type: 'module' }));
    this.free = [...this.workers];
    this.queue = [];
    this.nextTaskId = 1;
    this.pending = new Map();
    for (const w of this.workers) {
      w.onmessage = (ev) => {
        const { taskId, ok, result, error } = ev.data;
        const entry = this.pending.get(taskId);
        if (!entry) return;
        this.pending.delete(taskId);
        this.free.push(w);
        if (ok) entry.resolve(result); else entry.reject(new Error(error));
        this._drain();
      };
    }
  }
  _drain() {
    while (this.free.length && this.queue.length) {
      const w = this.free.pop();
      const task = this.queue.shift();
      this.pending.set(task.taskId, task);
      w.postMessage(task.msg);
    }
  }
  run(msg) {
    const taskId = this.nextTaskId++;
    return new Promise((resolve, reject) => {
      this.queue.push({ taskId, msg: { taskId, ...msg }, resolve, reject });
      this._drain();
    });
  }
  terminate() {
    for (const w of this.workers) w.terminate();
    this.free = [];
    this.queue = [];
  }
}

let pool = null;
function getPool() {
  if (!pool) pool = new WorkerPool(POOL_SIZE);
  return pool;
}
function terminatePool() {
  if (pool) { pool.terminate(); pool = null; }
}

/**
 * Trace a batch of glyph entries in parallel across the worker pool.
 * @param {Array<{char:string, key?:string, blob:{blob:Blob, cropSize:Object}, weight:number, fillIters:number, smooth:number, detail:number}>} entries
 *   `key` identifies the result in the returned map, defaulting to `char`.
 *   Manual-alternate sheets contribute a second (third, …) entry for the same
 *   character, so those pass a distinct key to keep them apart.
 * @param {number} pad
 * @param {(done:number, total:number)=>void} [onProgress]
 * @returns {Promise<Map<string, {d:string, advance:number, profile:Array}>>}
 *   key -> placed glyph (pre slant/spacing)
 */
async function traceAll(entries, pad, onProgress) {
  const p = getPool();
  let done = 0;
  const settled = await Promise.all(entries.map((e) =>
    p.run({
      cropBlob: e.blob.blob, cropSize: e.blob.cropSize, pad, char: e.char,
      weight: e.weight, fillIters: e.fillIters, smooth: e.smooth, detail: e.detail,
      capRefPx: e.capRefPx, baselineOffset: e.blob.baselineOffset,
    }).then((result) => {
      done++;
      if (onProgress) onProgress(done, entries.length);
      return { key: e.key || e.char, result };
    })
  ));
  const map = new Map();
  for (const { key, result } of settled) if (result) map.set(key, result);
  return map;
}

export { traceAll, getPool, terminatePool, POOL_SIZE };
