'use strict';
// Browser port of lib/kern.js — legacy TrueType 'kern' table (format 0)
// writer + sfnt table splicer. Same binary layout and same reasoning as the
// Node version (see lib/kern.js for the full commentary on why we hand-build
// this at all: opentype.js can parse kerning but has no writer for either
// 'kern' or GPOS, so the only way to ship kerning is to build the table
// ourselves and splice it into the already-compiled font).
//
// Only the byte-plumbing differs: Node Buffer's readUInt16BE/writeUInt16BE/
// copy/toString become DataView + Uint8Array.set here.

// Sum as big-endian uint32 words, wrapping at 2^32, treating bytes past the
// end as zero — the padding rule the OpenType checksum algorithm specifies.
function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const word = (((bytes[i] || 0) << 24) | ((bytes[i + 1] || 0) << 16) | ((bytes[i + 2] || 0) << 8) | (bytes[i + 3] || 0)) >>> 0;
    sum = (sum + word) >>> 0;
  }
  return sum >>> 0;
}

// pairs: Array<{left:number, right:number, value:number}> — glyph IDs and a
// kerning delta in font units (negative = pull together). Sorted here by
// (left, right); format 0's binary-search layout requires that order.
function buildKernTable(pairs) {
  const sorted = pairs.slice().sort((a, b) => (a.left - b.left) || (a.right - b.right));
  const nPairs = sorted.length;
  let entrySelector = 0;
  while ((1 << (entrySelector + 1)) <= nPairs) entrySelector++;
  const searchRange = (1 << entrySelector) * 6;
  const rangeShift = nPairs * 6 - searchRange;

  const subtableLen = 6 + 8 + nPairs * 6; // subtable header + format-0 header + pairs
  const out = new Uint8Array(4 + subtableLen);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint16(o, 0, false); o += 2;             // kern table version
  dv.setUint16(o, 1, false); o += 2;             // nTables
  dv.setUint16(o, 0, false); o += 2;             // subtable version
  dv.setUint16(o, subtableLen, false); o += 2;   // subtable length (incl. header)
  dv.setUint16(o, 0x0001, false); o += 2;        // coverage: horizontal, format 0
  dv.setUint16(o, nPairs, false); o += 2;
  dv.setUint16(o, searchRange, false); o += 2;
  dv.setUint16(o, entrySelector, false); o += 2;
  dv.setUint16(o, rangeShift, false); o += 2;
  for (const p of sorted) {
    dv.setUint16(o, p.left, false); o += 2;
    dv.setUint16(o, p.right, false); o += 2;
    dv.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(p.value))), false); o += 2;
  }
  return out;
}

// Insert a new table into an already-compiled sfnt (opentype.js's
// font.toArrayBuffer() output). Assumes `tag` isn't already present.
function spliceTable(sfnt, tag, tableData) {
  const src = sfnt instanceof Uint8Array ? sfnt : new Uint8Array(sfnt);
  const srcDv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const numTables = srcDv.getUint16(4, false);
  const oldDirSize = 12 + numTables * 16;
  const newNumTables = numTables + 1;
  const newDirSize = 12 + newNumTables * 16;
  const delta = newDirSize - oldDirSize;

  const readTag = (off) => String.fromCharCode(src[off], src[off + 1], src[off + 2], src[off + 3]);
  const entries = [];
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    entries.push({
      tag: readTag(off),
      checksum: srcDv.getUint32(off + 4, false),
      offset: srcDv.getUint32(off + 8, false) + delta,
      length: srcDv.getUint32(off + 12, false),
    });
  }
  const oldDataBlob = src.subarray(oldDirSize);
  const newTablePadded = Math.ceil(tableData.length / 4) * 4;
  const newTableOffset = newDirSize + oldDataBlob.length;
  entries.push({ tag, checksum: checksum(tableData), offset: newTableOffset, length: tableData.length });
  entries.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));

  let entrySelector = 0;
  while ((1 << (entrySelector + 1)) <= newNumTables) entrySelector++;
  const searchRange = (1 << entrySelector) * 16;
  const rangeShift = newNumTables * 16 - searchRange;

  const out = new Uint8Array(newDirSize + oldDataBlob.length + newTablePadded);
  const dv = new DataView(out.buffer);
  out.set(src.subarray(0, 4), 0);                 // sfnt version, unchanged
  dv.setUint16(4, newNumTables, false);
  dv.setUint16(6, searchRange, false);
  dv.setUint16(8, entrySelector, false);
  dv.setUint16(10, rangeShift, false);
  entries.forEach((e, i) => {
    const off = 12 + i * 16;
    for (let c = 0; c < 4; c++) out[off + c] = e.tag.charCodeAt(c);
    dv.setUint32(off + 4, e.checksum, false);
    dv.setUint32(off + 8, e.offset, false);
    dv.setUint32(off + 12, e.length, false);
  });
  out.set(oldDataBlob, newDirSize);
  out.set(tableData, newTableOffset);

  // 'head' carries a checksum of the WHOLE font (checkSumAdjustment, 3rd
  // field, byte 8 within the table) — zero it, total the font, write back.
  const head = entries.find((e) => e.tag === 'head');
  if (head) {
    dv.setUint32(head.offset + 8, 0, false);
    const total = checksum(out);
    dv.setUint32(head.offset + 8, (0xB1B0AFBA - total) >>> 0, false);
  }
  return out;
}


// Recompute every table checksum in an sfnt, plus head's whole-font
// checkSumAdjustment. opentype.js writes a 'CFF ' checksum that doesn't match
// the bytes it just emitted, which makes strict consumers reject the font —
// ttf2woff throws "Checksum error in CFF" and refuses to convert. Verified on
// a real 94-glyph build straight out of the assembler, before any splicing.
// Cheap to just recompute the lot and be certain they're right.
function fixChecksums(sfnt) {
  const out = sfnt.slice(); // never mutate the caller's buffer
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const numTables = dv.getUint16(4, false);
  let headOffset = -1;

  for (let i = 0; i < numTables; i++) {
    const e = 12 + i * 16;
    const tag = String.fromCharCode(out[e], out[e + 1], out[e + 2], out[e + 3]);
    const off = dv.getUint32(e + 8, false);
    const len = dv.getUint32(e + 12, false);

    // Checksums cover the table padded out to a 4-byte boundary, with any
    // bytes past the end of the file counted as zero.
    let sum = 0;
    const aligned = Math.ceil(len / 4) * 4;
    for (let p = 0; p < aligned; p += 4) {
      const w = (((out[off + p] || 0) << 24) | ((out[off + p + 1] || 0) << 16)
        | ((out[off + p + 2] || 0) << 8) | (out[off + p + 3] || 0)) >>> 0;
      sum = (sum + w) >>> 0;
    }
    // head is checksummed as if its own checkSumAdjustment field were zero.
    if (tag === 'head') {
      headOffset = off;
      sum = (sum - dv.getUint32(off + 8, false)) >>> 0;
    }
    dv.setUint32(e + 4, sum, false);
  }

  if (headOffset >= 0) {
    dv.setUint32(headOffset + 8, 0, false);
    dv.setUint32(headOffset + 8, (0xB1B0AFBA - checksum(out)) >>> 0, false);
  }
  return out;
}

export { buildKernTable, spliceTable, checksum, fixChecksums };
