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
  // alternate when the SAME letter (any of its forms) appears within the last
  // LOOKBACK positions — not just immediately adjacent. A run cascades
  // default→alt1→alt2→alt3 then loops back to the true default (wrap to form
  // 0), same as before; the difference is how far back we're willing to look
  // for "was this letter already used". Rules are emitted closest-distance
  // first so the nearest prior occurrence wins (GSUB tries subtables in
  // order and stops at the first match) — e.g. for "banana" (a's 2 apart),
  // the distance-2 rule fires since distance-1 never matches. Non-repeating
  // text (ABCDEF…) is unaffected: every backtrack position — including the
  // wildcard "any glyph" ones used for the gap — must match for a rule to
  // fire, and nothing precedes a letter that isn't itself a repeat.
  const LOOKBACK = 3;
  const nLetters = set0.length;
  const allGlyphIds = sets.flat();
  const minGlyphId = Math.min(...allGlyphIds), maxGlyphId = Math.max(...allGlyphIds);
  // Per-letter "any glyph EXCEPT this letter's own forms" coverage for the gap
  // positions, keyed by letter index. Plain "any glyph" broke long runs: when
  // the true nearest occurrence is the wrap-to-default case (k = count-1, no
  // rule emitted — silence IS the wrap), a farther-distance rule could still
  // match right past it, since a universal wildcard doesn't know a closer
  // occurrence of the SAME letter existed. Excluding this letter's own glyphs
  // from the wildcard forces "no closer occurrence, of any form" as part of
  // every farther rule's match, so the nearest occurrence always wins even
  // when it's the silent wrap case — confirmed by testing: "aaaaaaaa" was
  // getting stuck repeating the last form instead of cycling past it.
  // Each letter's k=0..count-1 forms are one contiguous block (see the glyph
  // creation loop above), so "everything else" is at most 2 ranges.
  const notThisLetterWildcard = (i) => {
    const lo = sets[0][i], hi = lo + count - 1;
    const ranges = [];
    // index values are irrelevant here — backtrack/lookahead coverage in a
    // chaining rule is a pure "is this glyph in the set" test, never used as
    // an array index the way it would be for class/ligature lookups.
    if (lo > minGlyphId) ranges.push({ start: minGlyphId, end: lo - 1, index: 0 });
    if (hi < maxGlyphId) ranges.push({ start: hi + 1, end: maxGlyphId, index: 0 });
    return { format: 2, ranges };
  };
  // ONE LOOKUP PER DISTANCE, not one lookup holding all distances — each
  // classic (non-Extension) lookup's subtables are addressed by 16-bit
  // offsets, capping total subtable size at 64KB (confirmed directly:
  // LOOKBACK=4 in a single lookup hit "Table lookupTable too big", and
  // opentype.js's GSUB writer has no support for Extension Substitution,
  // which would otherwise dodge the cap). Splitting each distance into its
  // own lookup gives each one a fresh 64KB budget instead of sharing one.
  // This still gets "nearest match wins" for free: a feature's lookups run
  // in sequence, and each rule's inputCoverage only matches a glyph that's
  // STILL its default form — so once the distance-1 lookup substitutes a
  // position, distance-2 no longer sees it as a candidate, and so on.
  const chainLookupIndexes = [];
  for (let distance = 1; distance <= LOOKBACK; distance++) {
    const chainSubtables = [];
    for (let i = 0; i < nLetters; i++) {
      const wildcard = notThisLetterWildcard(i);
      for (let k = 0; k < count; k++) {
        const target = k + 1 < count ? k + 1 : 0;
        if (target === 0) continue; // no set0->set0 lookup; "no substitution" IS the loop-back
        // backtrack index 0 = closest to input (position -1) ... index distance-1 = position -distance
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
