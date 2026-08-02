'use strict';
// Normalize any uploaded image to something sharp can read.
// iPhone HEIC/HEIF is HEVC-compressed; the libvips bundled with sharp often
// lacks the HEVC decode plugin. On macOS we use the system `sips` (fast, always
// present); everywhere else (e.g. a Linux server) we fall back to heic-convert,
// a pure JS/wasm decoder — so the same code runs locally and when deployed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HEIF_BRANDS = new Set([
  'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs',
  'mif1', 'msf1', 'avif', 'avis',
]);

function isHeif(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    if (buf.toString('latin1', 4, 8) !== 'ftyp') return false;
    return HEIF_BRANDS.has(buf.toString('latin1', 8, 12).toLowerCase());
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{ path: string, cleanup: string[] }>}
 */
async function ensureReadable(file) {
  if (!isHeif(file)) return { path: file, cleanup: [] };
  const out = path.join(os.tmpdir(), `dyf-heic-${crypto.randomBytes(5).toString('hex')}.png`);

  // macOS fast path
  if (process.platform === 'darwin') {
    try {
      execFileSync('/usr/bin/sips', ['-s', 'format', 'png', file, '--out', out], { stdio: 'ignore' });
      return { path: out, cleanup: [out] };
    } catch { /* fall through to the portable decoder */ }
  }

  // Cross-platform fallback (Linux servers, or if sips failed)
  try {
    const convert = require('heic-convert');
    const outputBuffer = await convert({ buffer: fs.readFileSync(file), format: 'PNG' });
    fs.writeFileSync(out, outputBuffer);
    return { path: out, cleanup: [out] };
  } catch (e) {
    const err = new Error('Could not read this HEIC photo. Try exporting it as JPEG and re-uploading.');
    err.cause = e;
    throw err;
  }
}

module.exports = { ensureReadable, isHeif };
