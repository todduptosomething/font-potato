'use strict';
// Use ONE sharp/libvips in the process. draw-your-font's internals require their
// own nested sharp; if our code also loaded the top-level sharp, two different
// libvips builds would load at once ("Class ... implemented in both ...", which
// risks mysterious crashes). Resolve draw-your-font's sharp so there is exactly
// one instance shared by everything.
let sharp;
try {
  sharp = require('draw-your-font/node_modules/sharp');
} catch {
  sharp = require('sharp');
}
module.exports = sharp;
