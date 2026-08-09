'use strict';
// Browser port of lib/assemble2.js — identical GSUB calt logic (adjacent-
// repeat-only, cascading through variants and looping back to the true
// default). opentype.js/svgpath now come from the vendor bundle; the final
// buffer is returned as a Uint8Array instead of a Node Buffer.

import { opentype, svgpath } from './vendor.js';

const UPM = 1000, ASCENT = 800, DESCENT = -200, WORDSPACE = 300;

function pathFromD(d) {
  const p = new opentype.Path();
  svgpath(d).abs().unshort().unarc().iterate((s) => {
    switch (s[0]) {
      case 'M': p.moveTo(s[1], s[2]); break;
      case 'L': p.lineTo(s[1], s[2]); break;
      case 'C': p.curveTo(s[1], s[2], s[3], s[4], s[5], s[6]); break;
      case 'Q': p.quadTo(s[1], s[2], s[3], s[4]); break;
      case 'Z': case 'z': p.close(); break;
      default: break;
    }
  });
  return p;
}
function uniName(char, alt) {
  const base = 'uni' + char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  return alt ? `${base}.alt${alt}` : base;
}
function coverage(ids) {
  return { format: 1, glyphs: ids.slice().sort((a, b) => a - b) };
}
function singleSub(from, to) {
  const pairs = from.map((f, i) => [f, to[i]]).sort((a, b) => a[0] - b[0]);
  return {
    lookupType: 1, lookupFlag: 0,
    subtables: [{ substFormat: 2, coverage: { format: 1, glyphs: pairs.map((p) => p[0]) }, substitute: pairs.map((p) => p[1]) }],
  };
}
// alternate substitution (type 3 format 1): each input glyph -> a fixed array
// of manually-pickable alternates (design apps show these in a glyph-
// alternates / OpenType panel, letting a user swap one specific occurrence).
function altSub(from, alternateSets) {
  const pairs = from.map((f, i) => [f, alternateSets[i]]).sort((a, b) => a[0] - b[0]);
  return {
    lookupType: 3, lookupFlag: 0,
    subtables: [{
      substFormat: 1,
      coverage: { format: 1, glyphs: pairs.map((p) => p[0]) },
      alternateSets: pairs.map((p) => p[1]),
    }],
  };
}

/**
 * @param {string} name family name
 * @param {Array<{char:string, advance:number, variants:Array<{d:string,advance:number}>}>} glyphList
 * @param {{authorName?:string}} [meta] who owns this specific font file — it's
 *        their handwriting, so by default (no explicit license attached) all
 *        rights already belong to them; this just makes that provenance
 *        visible in the font's own metadata (Font Info / Get Info panels).
 * @returns {Uint8Array} TTF bytes
 */
function buildTTFWithAlternates(name, glyphList, meta = {}) {
  const count = Math.max(...glyphList.map((g) => g.variants.length));
  const glyphs = [];
  const notdef = new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: Math.round(UPM / 2), path: new opentype.Path() });
  glyphs.push(notdef);
  glyphs.push(new opentype.Glyph({ name: 'space', unicode: 0x20, advanceWidth: WORDSPACE, path: new opentype.Path() }));

  const sets = Array.from({ length: count }, () => []);
  for (const g of glyphList) {
    for (let k = 0; k < count; k++) {
      const v = g.variants[k] || g.variants[g.variants.length - 1];
      const glyph = new opentype.Glyph({
        name: uniName(g.char, k),
        unicode: k === 0 ? g.char.codePointAt(0) : undefined,
        advanceWidth: Math.round(v.advance),
        path: pathFromD(v.d),
      });
      sets[k].push(glyphs.length);
      glyphs.push(glyph);
    }
  }

  const authorName = (meta.authorName || '').trim();
  const year = new Date().getFullYear();
  // The name table is the layer that actually travels. Font managers,
  // marketplaces and print shops read it automatically, and it survives when
  // the zip's README and LICENSE get separated from the font file — which is
  // the normal end state of any download.
  //
  // Attribution to Font Potato lives in the Description, deliberately NOT in
  // Manufacturer or Vendor. Those fields are read as an ownership claim, and
  // Font Potato has no stake in the font someone made from their own
  // handwriting. Nothing here restricts the owner; it only records who they
  // are and where the file came from.
  const font = new opentype.Font({
    familyName: name || 'My Handwriting',
    styleName: 'Regular',
    unitsPerEm: UPM, ascender: ASCENT, descender: DESCENT,
    glyphs,
    designer: authorName || undefined,                                    // nameID 9
    copyright: `Copyright © ${year} ${authorName || 'the font’s creator'}`, // nameID 0
    description: 'Originally generated with Font Potato (fontpotato.com)',  // nameID 10
    // nameID 13. Compressed to the same meaning as LICENSE.txt rather than a
    // restatement of it. No License URL (nameID 14) — there is no external
    // license document to point at, and adding one would imply terms exist.
    license: 'No restrictions from Font Potato. This font belongs to the copyright holder named above.',
    version: 'Version 1.0',
  });

  // A single-variant font has nothing to cycle through, so it needs no GSUB
  // at all — and building one would emit empty lookup tables. This is the
  // fast path used for the live preview while a slider is being dragged
  // (see fontbuild.js): same glyph shapes, none of the alternates machinery.
  if (count < 2) return new Uint8Array(font.toArrayBuffer());

  const set0 = sets[0];
  const lookups = [];
  for (let k = 1; k < count; k++) lookups.push(singleSub(set0, sets[k]));
  const toIdx = (k) => k - 1;

  // A letter's default glyph swaps to an alternate when the SAME letter (any
  // of its forms) appeared within the last LOOKBACK positions — not just
  // immediately adjacent, so the two non-adjacent d's in "dad" still differ.
  // Rules are emitted closest-distance first so the nearest prior occurrence
  // wins. See lib/assemble2.js for the full reasoning on the per-letter
  // wildcard and the one-lookup-per-distance split (64KB subtable cap).
  const LOOKBACK = 3;
  const nLetters = set0.length;
  const allGlyphIds = sets.flat();
  const minGlyphId = Math.min(...allGlyphIds), maxGlyphId = Math.max(...allGlyphIds);
  const notThisLetterWildcard = (i) => {
    const lo = sets[0][i], hi = lo + count - 1;
    const ranges = [];
    if (lo > minGlyphId) ranges.push({ start: minGlyphId, end: lo - 1, index: 0 });
    if (hi < maxGlyphId) ranges.push({ start: hi + 1, end: maxGlyphId, index: 0 });
    return { format: 2, ranges };
  };
  const chainLookupIndexes = [];
  for (let distance = 1; distance <= LOOKBACK; distance++) {
    const chainSubtables = [];
    for (let i = 0; i < nLetters; i++) {
      const wildcard = notThisLetterWildcard(i);
      for (let k = 0; k < count; k++) {
        const target = k + 1 < count ? k + 1 : 0;
        if (target === 0) continue; // "no substitution" IS the loop-back
        const backtrackCoverage = Array.from({ length: distance }, (_, pos) =>
          pos === distance - 1 ? coverage([sets[k][i]]) : wildcard);
        chainSubtables.push({
          substFormat: 3,
          backtrackCoverage,
          inputCoverage: [coverage([sets[0][i]])],
          lookaheadCoverage: [],
          lookupRecords: [{ sequenceIndex: 0, lookupListIndex: toIdx(target) }],
        });
      }
    }
    lookups.push({ lookupType: 6, lookupFlag: 0, subtables: chainSubtables });
    chainLookupIndexes.push(lookups.length - 1);
  }

  const features = [{ tag: 'calt', feature: { featureParams: 0, lookupListIndexes: chainLookupIndexes } }];
  const featureIndexes = [0];

  // salt: 2 manually-selectable alternates per letter, for design apps with a
  // glyph-alternates panel. Reuses the alt1/alt2 glyphs already built for the
  // calt cascade — no extra glyphs, just a second, manual way to reach them.
  if (count >= 3) {
    const saltLookup = altSub(set0, set0.map((_, i) => [sets[1][i], sets[2][i]]));
    lookups.push(saltLookup);
    features.push({ tag: 'salt', feature: { featureParams: 0, lookupListIndexes: [lookups.length - 1] } });
    featureIndexes.push(features.length - 1);
  }

  const langSys = { reqFeatureIndex: 0xffff, featureIndexes };
  font.tables.gsub = {
    version: 1,
    scripts: [
      { tag: 'DFLT', script: { defaultLangSys: langSys, langSysRecords: [] } },
      { tag: 'latn', script: { defaultLangSys: langSys, langSysRecords: [] } },
    ],
    features,
    lookups,
  };

  return new Uint8Array(font.toArrayBuffer());
}

export { buildTTFWithAlternates };
