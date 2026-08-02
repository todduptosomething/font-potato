'use strict';
// Browser port of lib/fontbuild.js, restructured for fast slider response:
//
// 1. The trace pass (weight/gap-fill/potrace — the actual bottleneck, since
//    potrace/Jimp are pure JS with no GPU/native speedup like sharp had) runs
//    across a Web Worker pool (build-controller.js) instead of one glyph at a
//    time on the main thread.
// 2. Slant and Spacing are cheap post-trace path transforms (shear/translate)
//    — they never need a re-trace. Weight/Smoothness/Detail DO need one. So
//    the traced+placed glyph set is cached per (weight,smooth,detail); moving
//    only Slant or Spacing hits the cache and skips straight to the fast
//    per-glyph transform + reassembly, which is the common case while
//    dragging a single slider.
// 3. Stroke-width measurement (pass 1) only depends on the scan crops, never
//    on slider values, so it runs once per scan and is cached forever.

import { svgpath, band } from './vendor.js';
import { measureStroke } from './weight.js';
import { traceAll } from './build-controller.js';
import { buildVariants } from './variants.js';
import { buildTTFWithAlternates } from './assemble.js';
import { PAD } from './templatescan.js';

const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ALT_STRENGTH = 2.3;

function clamp(n, lo, hi) {
  n = Number(n);
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

class FontBuilder {
  /** @param {{labels:Object, blobs:Array<{id,char,blob:Blob,cropSize}>}} scanResult */
  constructor(scanResult) {
    this.scanResult = scanResult;
    this._entriesPromise = null; // pass 1 result, cached forever for this scan
    this._traceCache = null;     // { key, base: Map<char,{d,advance}> }
  }

  async _entries() {
    if (this._entriesPromise) return this._entriesPromise;
    this._entriesPromise = (async () => {
      const { labels, blobs } = this.scanResult;
      const byId = new Map(blobs.map((b) => [String(b.id), b]));
      const seen = new Set();
      const entries = [];
      for (const [id, rawChar] of Object.entries(labels)) {
        if (!rawChar) continue;
        const char = String(rawChar).normalize('NFC');
        if ([...char].length !== 1) continue;
        if (seen.has(char)) continue;
        const b = byId.get(String(id));
        if (!b) continue;
        seen.add(char);

        const swPx = await measureStroke(b.blob);
        const [bot, top] = band(char);
        const inkH = b.cropSize.height - 2 * PAD;
        const scale = inkH > 0 ? (top - bot) / inkH : 1;
        entries.push({ char, blob: b, swPx, scale, emSw: swPx * scale });
      }
      if (!entries.length) {
        const err = new Error('No glyphs to build — nothing is labeled yet.');
        err.code = 'NO_GLYPHS';
        throw err;
      }
      const strokes = entries.map((e) => e.emSw).filter((v) => v > 0).sort((a, b) => a - b);
      const target = strokes.length ? strokes[Math.floor(strokes.length / 2)] : 0;
      return { entries, target, seen };
    })();
    return this._entriesPromise;
  }

  /**
   * @param {Object} opts name/weight/smooth/slant/spacing/detail
   * @param {(phase:string, done?:number, total?:number)=>void} [onProgress]
   * @returns {Promise<{ttf:Uint8Array, glyphs:string[], missing:string[], family:string, tracedFresh:boolean}>}
   */
  async build(opts, onProgress = () => {}) {
    const name = (opts.name && String(opts.name).trim()) || 'My Handwriting';
    const weight = Math.round(clamp(opts.weight, -2, 2));
    const smooth = clamp(opts.smooth, 0, 2);
    const slantDeg = clamp(opts.slant, -20, 20);
    const spacing = opts.spacing == null ? 0 : clamp(opts.spacing, -80, 260);
    const shear = Math.tan((slantDeg * Math.PI) / 180);
    const fineness = clamp(opts.detail == null ? 75 : opts.detail, 0, 100) / 100;
    const traceDetail = 1 - fineness;
    // 7 possible gap-fill amounts (6..0), bucketed into 7 equal-width slices of
    // the slider — see lib/fontbuild.js for why (naive rounding bunched unevenly).
    const fillIters = 6 - Math.min(6, Math.floor(fineness * 7));

    const { entries, target, seen } = await this._entries();
    const traceKey = JSON.stringify([weight, smooth, traceDetail, fillIters]);

    let base; // Map<char, {d, advance}> — traced + placed, pre slant/spacing
    let tracedFresh = false;
    if (this._traceCache && this._traceCache.key === traceKey) {
      base = this._traceCache.base;
      onProgress('cache-hit');
    } else {
      tracedFresh = true;
      onProgress('tracing', 0, entries.length);
      const withParams = entries.map((e) => {
        let w = weight;
        if (target > 0 && e.swPx > 0 && e.scale > 0) {
          const desiredCropSw = target / e.scale;
          const norm = Math.round((desiredCropSw - e.swPx) / 2);
          w = Math.max(-6, Math.min(7, weight + Math.max(-4, Math.min(4, norm))));
        }
        return { char: e.char, blob: e.blob, weight: w, fillIters, smooth, detail: traceDetail };
      });
      base = await traceAll(withParams, PAD, (done, total) => onProgress('tracing', done, total));
      this._traceCache = { key: traceKey, base };
    }

    onProgress('assembling');
    const glyphs = [];
    for (const [char, placed] of base) {
      let { d: placed_d, advance } = placed;
      if (shear !== 0 || spacing !== 0) {
        let sp = svgpath(placed_d);
        if (shear !== 0) sp = sp.matrix([1, 0, shear, 1, 0, 0]);
        if (spacing !== 0) sp = sp.translate(spacing / 2, 0);
        placed_d = sp.round(1).toString();
        advance = Math.round(advance + spacing);
      }
      glyphs.push({ char, d: placed_d, advance });
    }

    if (!glyphs.length) {
      const err = new Error('No glyphs to build — nothing is labeled yet.');
      err.code = 'NO_GLYPHS';
      throw err;
    }

    const glyphList = glyphs.map((g) => ({
      char: g.char,
      advance: g.advance,
      variants: buildVariants({ d: g.d, advance: g.advance }, g.char, 4, ALT_STRENGTH),
    }));
    const ttf = buildTTFWithAlternates(name, glyphList);

    const missing = [...ALPHA].filter((c) => !seen.has(c));
    onProgress('done');
    return { ttf, glyphs: glyphs.map((g) => g.char), missing, family: name, tracedFresh };
  }
}

export { FontBuilder };
