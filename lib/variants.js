'use strict';
// Procedurally generate subtly-different versions of one glyph so a font can
// rotate through them (via GSUB calt) and repeated letters stop looking like
// identical stamps. Variant 0 is always the untouched original; extra variants
// get seeded, gentle rotation / non-uniform scale / skew / vertical shift plus
// a light per-node wobble that changes the roundness and length of strokes.
//
// Paths are in em units, y-up, baseline 0 (draw-your-font's placeGlyph output),
// and contain only M/L/C/Z commands, so jittering coordinate pairs is safe.

const svgpath = require('svgpath');

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// STRENGTH presets scale every amount below.
const PRESETS = { subtle: 1.4, lively: 2.4 };

/**
 * @param {string} d      glyph path (em units, y-up)
 * @param {number} advance glyph advance width
 * @param {string} char   the character (for a stable seed)
 * @param {number} index  variant index (>=1; 0 is the original)
 * @param {number} strength 1 = subtle, 2 = lively
 * @returns {string} varied path `d`
 */
function varyPath(d, advance, char, index, strength) {
  const r = rng(hash(char + '#' + index));
  const rand = (a) => (r() * 2 - 1) * a; // uniform in [-a, a]
  // Bias each variant in a distinct direction so alt1/alt2 aren't near-copies.
  const dir = index % 2 === 1 ? 1 : -1;

  // Whole-glyph moves — natural re-writing (tilt, size, baseline bounce). These
  // keep the letter recognizable; the aggressive stroke-bending was the warp.
  const rotDeg = dir * (1.6 + Math.abs(rand(2.2))) * strength;
  const skewDeg = rand(2.4 * strength);
  const sx = 1 + rand(0.085 * strength);  // bowl width
  const sy = 1 + rand(0.095 * strength);  // stroke length
  const dy = dir * (4 + Math.abs(rand(10))) * strength;
  const dx = rand(5 * strength);
  const cx = advance / 2;
  const cy = 250; // roughly mid x-height

  let p = svgpath(d).abs().unshort()
    .translate(-cx, -cy)
    .rotate(rotDeg)
    .skewX(skewDeg)
    .scale(sx, sy)
    .translate(cx + dx, cy + dy);

  // Domain warp: a smooth low-frequency displacement field. Because it varies
  // slowly across the glyph, different regions stretch/compress and curves fatten
  // or thin *coherently* — extending some strokes, shortening others, making
  // bowls rounder or flatter — without the shaky edges a per-node jitter causes.
  const TAU = Math.PI * 2;
  const Aw = 2.6 * strength; // keep warp low (it distorts); let the affine moves carry the variety
  const fx = 0.6 + r() * 0.9, fy = 0.6 + r() * 0.9;   // <1.5 cycles across a glyph
  const gx = 0.6 + r() * 0.9, gy = 0.6 + r() * 0.9;
  const px = rand(Math.PI), py = rand(Math.PI), qx = rand(Math.PI), qy = rand(Math.PI);
  const warpX = (x, y) => Aw * (Math.sin(fy * (y / 700) * TAU + px) + 0.4 * Math.sin(gx * (x / 500) * TAU + qx));
  const warpY = (x, y) => Aw * 0.85 * (Math.sin(fx * (x / 500) * TAU + py) + 0.4 * Math.sin(gy * (y / 700) * TAU + qy));

  p = p.iterate((seg) => {
    if (seg[0] === 'Z' || seg[0] === 'z') return;
    for (let k = 1; k + 1 < seg.length; k += 2) {
      const x = seg[k], y = seg[k + 1];
      seg[k] = x + warpX(x, y);
      seg[k + 1] = y + warpY(x, y);
    }
  });

  return p.round(1).toString();
}

/**
 * Build the full variant list for a glyph: [original, ...procedural].
 * If real alternate paths are supplied (e.g. duplicate-labelled crops) they are
 * used before falling back to procedural ones.
 * @returns {Array<{d:string, advance:number}>} length = count
 */
function buildVariants(base, char, count, strength, realAlts = []) {
  const out = [{ d: base.d, advance: base.advance }];
  for (const a of realAlts) {
    if (out.length >= count) break;
    out.push({ d: a.d, advance: a.advance });
  }
  let idx = 1;
  while (out.length < count) {
    out.push({ d: varyPath(base.d, base.advance, char, idx, strength), advance: base.advance });
    idx++;
  }
  return out;
}

module.exports = { buildVariants, varyPath, PRESETS };
