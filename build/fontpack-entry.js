// Lazily-loaded bundle for the download step: TTF -> WOFF.
//
// ttf2woff is written against Node's Buffer and uses the newer camelCase
// accessors (readUint16BE, writeUint32BE, ...). A global Buffer polyfill is
// already installed by vendor.js, but that build predates those aliases and
// only has the older readUInt16BE spelling — so calls blow up with
// "readUint16BE is not a function". Rather than swapping the global out from
// under everything else that already uses it, just add the missing aliases.
//
// WOFF2 is deliberately NOT here: its Emscripten binding only exports itself
// under Node, so bundling it yields an empty object. It's generated as a
// standalone ES module instead — see build/make-woff2-esm.sh.
import { Buffer as BufferPolyfill } from 'buffer';

if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = BufferPolyfill;

const proto = globalThis.Buffer.prototype;
for (const [modern, legacy] of [
  ['readUint8', 'readUInt8'], ['readUint16BE', 'readUInt16BE'], ['readUint16LE', 'readUInt16LE'],
  ['readUint32BE', 'readUInt32BE'], ['readUint32LE', 'readUInt32LE'],
  ['writeUint8', 'writeUInt8'], ['writeUint16BE', 'writeUInt16BE'], ['writeUint16LE', 'writeUInt16LE'],
  ['writeUint32BE', 'writeUInt32BE'], ['writeUint32LE', 'writeUInt32LE'],
]) {
  if (typeof proto[modern] !== 'function' && typeof proto[legacy] === 'function') {
    proto[modern] = proto[legacy];
  }
}

export { default as ttf2woff } from 'ttf2woff';
