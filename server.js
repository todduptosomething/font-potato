'use strict';
// A local dev server, and nothing more. Font Potato ships as static files —
// the entire pipeline (reading the photo, tracing letters, building and
// packaging the font) runs in the browser, the printable template is a file
// built ahead of time by `npm run build:template`, and the three things
// people submit go straight to Supabase. There is no production server; this
// exists so `npm run dev` serves public/ over http:// rather than file://,
// which ES modules and web workers require.

const path = require('path');
const express = require('express');

const PORT = process.env.PORT || 4321;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`\n  🥔  Font Potato (dev)`);
  console.log(`      →  http://localhost:${PORT}\n`);
});
