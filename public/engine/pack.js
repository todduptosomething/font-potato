'use strict';
// Builds the downloadable .zip entirely in the browser: TTF + WOFF + WOFF2 +
// CSS + README, the same package server.js used to assemble with `archiver`.
//
// The WOFF/WOFF2 converters live in a separate lazily-loaded bundle
// (vendor-fontpack.js, ~940KB, mostly the wasm WOFF2 compressor) so they're
// only fetched when someone actually downloads — not on page load.

// Set once the WOFF2 compressor has proven it won't start, so later
// downloads skip it instantly instead of waiting out the timeout again.
let woff2Unavailable = false;

let packPromise = null;
function loadPack() {
  if (!packPromise) packPromise = import('./vendor-fontpack.js');
  return packPromise;
}

// WOFF2's compressor is a separate ~930KB module (see
// build/make-woff2-esm.sh for why it can't go through the bundler).
let woff2Promise = null;
function loadWoff2() {
  if (!woff2Promise) woff2Promise = import('./vendor-woff2.mjs').then((m) => m.default);
  return woff2Promise;
}

/**
 * Pre-fetch the converters (e.g. once a font has finished building) AND find
 * out up front whether the WOFF2 compressor is going to start. Settling that
 * here means the download click never pays the readiness timeout — it either
 * has a working compressor or already knows to skip it.
 */
function warmPack() {
  loadPack().catch(() => { /* surfaced later if the download is attempted */ });
  loadWoff2()
    .then((mod) => woff2Ready(mod))
    .catch(() => { woff2Unavailable = true; });
}

// --- minimal ZIP writer ----------------------------------------------------
// Store-only (no deflate): a TTF barely compresses and WOFF/WOFF2 are already
// compressed, so deflating would cost CPU for almost nothing. Store-only also
// keeps this to a few dozen lines with no dependency.

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// MS-DOS date/time, the only format the ZIP header understands.
function dosDateTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/**
 * @param {Array<{name:string, data:Uint8Array}>} files
 * @returns {Blob} a .zip
 */
function makeZip(files) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);   // local file header signature
    lv.setUint16(4, 20, true);           // version needed
    lv.setUint16(6, 0, true);            // flags
    lv.setUint16(8, 0, true);            // method: stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true); // compressed size
    lv.setUint32(22, f.data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);           // extra length
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);   // central directory signature
    cv.setUint16(4, 20, true);           // version made by
    cv.setUint16(6, 20, true);           // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);           // extra
    cv.setUint16(32, 0, true);           // comment
    cv.setUint16(34, 0, true);           // disk number
    cv.setUint16(36, 0, true);           // internal attrs
    cv.setUint32(38, 0, true);           // external attrs
    cv.setUint32(42, offset, true);      // offset of local header
    central.set(nameBytes, 46);

    locals.push(local, f.data);
    centrals.push(central);
    offset += local.length + f.data.length;
  }

  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);     // end of central directory
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...locals, ...centrals, end], { type: 'application/zip' });
}

function fontFaceCSS(family, base, hasWoff2 = true) {
  const safe = family.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  // Only advertise files the package actually contains — a src pointing at a
  // missing .woff2 makes the browser fetch a 404 before falling back.
  const src = [
    hasWoff2 ? `    url('${base}.woff2') format('woff2')` : null,
    `    url('${base}.woff') format('woff')`,
    `    url('${base}.ttf') format('truetype')`,
  ].filter(Boolean).join(',\n');
  return [
    `@font-face {`,
    `  font-family: '${safe}';`,
    `  src:`,
    src + `;`,
    `  font-weight: normal;`,
    `  font-style: normal;`,
    `}`,
    ``,
  ].join('\n');
}

// Plain-text files need their own wrapping — a paragraph on one enormous line
// is unreadable in Notepad, which has no soft wrap by default.
function wrap(text, width) {
  const out = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && (line + ' ' + word).length > width) { out.push(line); line = word; }
    else line = line ? line + ' ' + word : word;
  }
  if (line) out.push(line);
  return out;
}

const today = () =>
  new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

function readme({ family, fileBase, authorName, hasWoff2 = true }) {
  const owner = authorName ? authorName.trim() : '';
  return [
    `${family}`,
    `${'='.repeat(family.length)}`,
    ``,
    `Made with Font Potato from ${owner ? owner + "'s" : 'your'} handwriting.`,
    ``,
    `WHAT'S IN HERE`,
    `  ${fileBase}.ttf    Install this one on your computer.`,
    `  ${fileBase}.woff   For websites.`,
    hasWoff2 ? `  ${fileBase}.woff2  For websites (smaller, preferred).` : null,
    `  ${fileBase}.css    Ready-made @font-face rule for the web files.`,
    ``,
    `INSTALLING`,
    `  Mac      Double-click the .ttf, then click "Install Font".`,
    `  Windows  Right-click the .ttf, then choose "Install".`,
    ``,
    `ALTERNATE LETTERS`,
    `  Repeated letters automatically cycle through slightly different`,
    `  shapes so your writing doesn't look rubber-stamped. This is an`,
    `  OpenType feature called Contextual Alternates.`,
    ``,
    `  Most apps (browsers, Word, Pages) turn it on by themselves.`,
    `  Adobe apps do not — switch it on by hand:`,
    `    Illustrator / InDesign / Photoshop`,
    `      Open the OpenType panel and tick "Contextual Alternates".`,
    ``,
    `  You can also pick a different form for one specific letter using`,
    `  the Glyphs / Alternates panel in those same apps.`,
    ``,
    `COPYRIGHT`,
    // Spelled out in full here, rather than compressed the way LICENSE.txt and
    // the font's own metadata are. This is the version someone reads when they
    // want the whole picture, so it names the font, the person, and the date.
    ...wrap(
      `This font, ${family}, was created by ${owner || "the font's creator"} on ` +
      `${today()} using Font Potato (fontpotato.com). ${owner || "The font's creator"} ` +
      `holds full copyright and all rights to this font file and may use, sell, ` +
      `modify, sublicense, or distribute it however they choose, with no ` +
      `restrictions from Font Potato.`,
      74,
    ).map((l) => `  ${l}`),
    ``,
    `  See LICENSE.txt, included with this download.`,
    ``,
  ].filter((l) => l !== null).join('\n');
}

// Deliberately short, and deliberately not a restatement of the README's
// ownership paragraph. People who come looking for a file literally named
// LICENSE — marketplaces, print shops, clients — only need the basic fact
// confirmed, and a wall of text invites them to go hunting for the catch.
//
// Note this is NOT the SIL Open Font License or any other named font licence.
// Those carry their own redistribution and renaming rules, which would work
// directly against "do whatever you want" — the OFL in particular forbids
// selling the font on its own, which is exactly a thing the owner may want
// to do.
function licence({ family, authorName }) {
  const owner = (authorName || '').trim();
  return [
    `${family} — Licence`,
    ``,
    ...wrap(
      `Whatever you create with Font Potato belongs to you. This font comes ` +
      `with no license restrictions from Font Potato — use it, sell it, ` +
      `modify it, however you like.`,
      74,
    ),
    ``,
    `Copyright (c) ${new Date().getFullYear()} ${owner || "the font's creator"}`,
    ``,
  ].join('\n');
}

/**
 * @param {Uint8Array} ttf
 * @param {{family:string, fileBase:string, authorName?:string}} meta
 * @returns {Promise<Blob>} the .zip
 */
// Wait for the Emscripten runtime, but never indefinitely. Two separate
// hazards, both observed: wawoff2's own wrapper deadlocks if the runtime
// initialises before it attaches its callback, and under esbuild's CommonJS
// interop the module object can come through without ever initialising at
// all. WOFF2 is the least important file in the package, so a bounded wait
// that gives up is far better than a download that hangs forever.
const WOFF2_INIT_TIMEOUT_MS = 4000;
function woff2Ready(mod) {
  if (mod && mod.calledRun && typeof mod.compress === 'function') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('WOFF2 compressor did not start in time')),
      WOFF2_INIT_TIMEOUT_MS,
    );
    const finish = () => { clearTimeout(timer); resolve(); };
    if (!mod) { clearTimeout(timer); reject(new Error('WOFF2 compressor unavailable')); return; }
    const prev = mod.onRuntimeInitialized;
    mod.onRuntimeInitialized = () => { if (typeof prev === 'function') prev(); finish(); };
    // It may already be usable even without calledRun being set.
    if (typeof mod.compress === 'function') finish();
  });
}

async function buildFontPackage(ttf, { family, fileBase, authorName = '' }) {
  const { ttf2woff } = await loadPack();

  const woff = ttf2woff(ttf); // already a Uint8Array
  let woff2 = null;
  try {
    if (woff2Unavailable) throw new Error('WOFF2 compressor unavailable (already tried)');
    const mod = await loadWoff2();
    await woff2Ready(mod);
    const res = mod.compress(ttf);
    if (res === false) throw new Error('ConvertTTFToWOFF2 failed');
    woff2 = res;
  } catch (err) {
    woff2Unavailable = true;
    // Ship the package without it. The compressor is also known to
    // intermittently reject a font it just accepted, so this path has to
    // exist regardless — every other format still works, and WOFF2 only
    // matters for embedding the font on a website.
    console.warn('[pack] skipping .woff2:', err && err.message);
    woff2 = null;
  }

  const enc = new TextEncoder();
  const files = [
    { name: `${fileBase}.ttf`, data: ttf },
    { name: `${fileBase}.woff`, data: woff },
  ];
  if (woff2) files.push({ name: `${fileBase}.woff2`, data: new Uint8Array(woff2) });
  files.push(
    { name: `${fileBase}.css`, data: enc.encode(fontFaceCSS(family, fileBase, !!woff2)) },
    { name: 'README.txt', data: enc.encode(readme({ family, fileBase, authorName, hasWoff2: !!woff2 })) },
    // Its own file, and named exactly LICENSE.txt, because that filename is
    // what people and platforms look for when they need proof they're allowed
    // to use something.
    { name: 'LICENSE.txt', data: enc.encode(licence({ family, authorName })) },
  );
  return makeZip(files);
}

export { buildFontPackage, makeZip, warmPack, fontFaceCSS };
