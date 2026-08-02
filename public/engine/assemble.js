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

/**
 * @param {string} name family name
 * @param {Array<{char:string, advance:number, variants:Array<{d:string,advance:number}>}>} glyphList
 * @returns {Uint8Array} TTF bytes
 */
function buildTTFWithAlternates(name, glyphList) {
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

  const font = new opentype.Font({
    familyName: name || 'My Handwriting',
    styleName: 'Regular',
    unitsPerEm: UPM, ascender: ASCENT, descender: DESCENT,
    glyphs,
  });

  const set0 = sets[0];
  const lookups = [];
  for (let k = 1; k < count; k++) lookups.push(singleSub(set0, sets[k]));
  const toIdx = (k) => k - 1;

  const nLetters = set0.length;
  const chainSubtables = [];
  for (let i = 0; i < nLetters; i++) {
    for (let k = 0; k < count; k++) {
      const target = k + 1 < count ? k + 1 : 0;
      if (target === 0) continue;
      chainSubtables.push({
        substFormat: 3,
        backtrackCoverage: [coverage([sets[k][i]])],
        inputCoverage: [coverage([sets[0][i]])],
        lookaheadCoverage: [],
        lookupRecords: [{ sequenceIndex: 0, lookupListIndex: toIdx(target) }],
      });
    }
  }
  lookups.push({ lookupType: 6, lookupFlag: 0, subtables: chainSubtables });
  const chainLookupIndex = lookups.length - 1;

  const langSys = { reqFeatureIndex: 0xffff, featureIndexes: [0] };
  font.tables.gsub = {
    version: 1,
    scripts: [
      { tag: 'DFLT', script: { defaultLangSys: langSys, langSysRecords: [] } },
      { tag: 'latn', script: { defaultLangSys: langSys, langSysRecords: [] } },
    ],
    features: [{ tag: 'calt', feature: { featureParams: 0, lookupListIndexes: [chainLookupIndex] } }],
    lookups,
  };

  return new Uint8Array(font.toArrayBuffer());
}

export { buildTTFWithAlternates };
