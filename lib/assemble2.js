'use strict';
// Assemble a TTF that carries several variants per letter plus a GSUB `calt`
// feature that cycles through them, so repeated / adjacent letters render
// different shapes (browsers and design apps apply calt by default). Built with
// opentype.js, whose GSUB writer supports the two lookup types we need:
//   - type 1 format 2: single substitution set0[i] -> setK[i]
//   - type 6 format 3: chaining context, "input default preceded by setB -> apply toK"
// Cycling (for 3 variants): start default, then 0->1, 1->2, 2->1, ...

const opentype = require('opentype.js');
const svgpath = require('svgpath');

const UPM = 1000, ASCENT = 800, DESCENT = -200, WORDSPACE = 300;

// Build the path numerically from svgpath segments. opentype's own fromSVG()
// mis-tokenizes the compact path notation svgpath emits ("10-20", "1.5.5"),
// which silently corrupts some glyphs; walking segments avoids the string parser.
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
// single substitution (type 1 format 2): from[i] -> to[i]
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
// chaining (type 6 format 3): input default preceded by btIds -> apply lookup #idx
function chain(btIds, inIds, lookupIndex) {
  return {
    lookupType: 6, lookupFlag: 0,
    subtables: [{
      substFormat: 3,
      backtrackCoverage: [coverage(btIds)],
      inputCoverage: [coverage(inIds)],
      lookaheadCoverage: [],
      lookupRecords: [{ sequenceIndex: 0, lookupListIndex: lookupIndex }],
    }],
  };
}

/**
 * @param {string} name family name
 * @param {Array<{char:string, advance:number, variants:Array<{d:string,advance:number}>}>} glyphList
 *        every entry must have the same number of variants (>=2) for cycling.
 * @returns {Buffer} TTF
 */
function buildTTFWithAlternates(name, glyphList) {
  const count = Math.max(...glyphList.map((g) => g.variants.length));
  const glyphs = [];
  const notdef = new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: Math.round(UPM / 2), path: new opentype.Path() });
  glyphs.push(notdef);
  glyphs.push(new opentype.Glyph({ name: 'space', unicode: 0x20, advanceWidth: WORDSPACE, path: new opentype.Path() }));

  // sets[k] = glyph ids that are the k-th variant of each letter
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

  // ---- GSUB calt cycling ----
  // Single-sub lookups toK: set0 -> setK (k = 1..count-1).
  const set0 = sets[0];
  const lookups = [];
  for (let k = 1; k < count; k++) lookups.push(singleSub(set0, sets[k]));
  const toIdx = (k) => k - 1; // lookups[0] is to1, etc.

  // ONE chaining lookup, per-letter rules: a letter's default glyph swaps to an
  // alternate ONLY when the SAME letter (any of its forms) is immediately before
  // it — i.e. only on an actual repeat. So non-repeating text (ABCDEF…) shows the
  // true scanned glyph, and a run cascades default→alt1→alt2→alt3 then loops back
  // to the true default (wrap to form 0) — repeats stay lively but the real drawn
  // letter reappears every `count`-th, instead of drifting through ever-more
  // warped forms. (Non-adjacent repeats like the a's in "banana" stay identical —
  // matching those in pure GSUB needs an expensive lookback window.)
  const nLetters = set0.length;
  const chainSubtables = [];
  for (let i = 0; i < nLetters; i++) {
    for (let k = 0; k < count; k++) {
      const target = k + 1 < count ? k + 1 : 0; // after the last form, loop back to the default
      // target 0 = default: emit no rule so the glyph simply stays its default
      // form (there is no set0->set0 lookup, and "no substitution" IS the loop-back).
      if (target === 0) continue;
      chainSubtables.push({
        substFormat: 3,
        backtrackCoverage: [coverage([sets[k][i]])], // this letter's form k, right before
        inputCoverage: [coverage([sets[0][i]])],     // this letter's default glyph
        lookaheadCoverage: [],
        lookupRecords: [{ sequenceIndex: 0, lookupListIndex: toIdx(target) }],
      });
    }
  }
  lookups.push({ lookupType: 6, lookupFlag: 0, subtables: chainSubtables });
  const chainLookupIndex = lookups.length - 1;

  const features = [{ tag: 'calt', feature: { featureParams: 0, lookupListIndexes: [chainLookupIndex] } }];
  const featureIndexes = [0];

  // ---- GSUB salt: 2 manually-selectable alternates per letter ----
  // calt only fires on an actual adjacent repeat, so e.g. the two (non-
  // adjacent) d's in "dad" can't both get an automatic alternate. salt is
  // the standard OpenType escape hatch: design apps with a glyph-alternates
  // panel (Illustrator, InDesign) or macOS's own Character Viewer alternates
  // popup let a user pick a different form for one specific occurrence by
  // hand. Reuses the same alt1/alt2 glyphs already built for the calt
  // cascade — no extra glyphs, just a second, manual way to reach them.
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

  return Buffer.from(font.toArrayBuffer());
}

module.exports = { buildTTFWithAlternates };
