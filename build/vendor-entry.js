// Bundled once via `npm run build:vendor` into public/engine/vendor.js —
// this is the ONE build step in the project, and only re-runs when a
// dependency here changes. The shipped app itself is plain unbundled ES
// modules with no build step. Re-exporting draw-your-font's metrics.js and
// winding.js directly (instead of hand-porting them) guarantees the browser
// gets byte-identical glyph-placement/winding logic to the Node version.
// potrace's Jimp dependency needs a Node Buffer; export the polyfill
// explicitly (it's already a transitive dependency, pulled in for this) so
// call sites can do Buffer.from(uint8Array) without relying on a side effect.
export { Buffer } from 'buffer';
export { Potrace } from 'potrace';
export { default as opentype } from 'opentype.js';
export { default as svgpath } from 'svgpath';
export { placeGlyph, band, UPM, ASCENT, DESCENT, XH, CAP } from 'draw-your-font/src/metrics.js';
export { fixWinding } from 'draw-your-font/src/winding.js';
