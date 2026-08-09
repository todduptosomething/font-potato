'use strict';
// Font Potato's small remaining server. The whole font pipeline — reading
// the photo, tracing letters, building and packaging the font — now runs in
// the browser (see public/engine/), so photos genuinely never leave the
// user's device. Mailing-list signups, contact messages and opt-in samples
// go straight from the browser to Supabase (see public/engine/collect.js).
// All that's left here is serving the page and generating the template PDF.

const path = require('path');
const express = require('express');

const { generateTemplatePDF } = require('./lib/template');

const PORT = process.env.PORT || 4321;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// --- Template: download a printable PDF ---------------------------------------
app.get('/api/template', async (_req, res) => {
  try {
    const pdf = await generateTemplatePDF({ charset: 'full' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="handwriting-template.pdf"');
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`\n  🥔  Font Potato running`);
  console.log(`      →  http://localhost:${PORT}\n`);
});
