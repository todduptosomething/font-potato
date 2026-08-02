'use strict';
// Local studio server: wraps draw-your-font's segmentation + build with a
// slider UI. Everything runs on localhost; photos never leave the machine.

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const { buildFont } = require('./lib/fontbuild');
const { autoLabel, hasApiKey } = require('./lib/autolabel');
const { generateTemplatePDF } = require('./lib/template');
const { scanTemplate } = require('./lib/templatescan');
const { CHARSETS } = require('./lib/templategeo');

const PORT = process.env.PORT || 4321;
// Keep mutable session files out of the app bundle: use DYF_DATA_DIR when set
// (the .app launcher points it at ~/Library/Application Support), else local.
const DATA_DIR = process.env.DYF_DATA_DIR || __dirname;
const WORK_ROOT = path.join(DATA_DIR, 'workdirs');
const SPECIMEN_DIR = path.join(DATA_DIR, 'specimens'); // opt-in marketing samples
const SHARE_DIR = path.join(DATA_DIR, 'shares');        // "show us what you made"
[WORK_ROOT, SPECIMEN_DIR, SHARE_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

// Move an uploaded temp file to dest across filesystems (rename can EXDEV).
function keepFile(from, dest) {
  fs.copyFileSync(from, dest);
  fs.unlink(from, () => {});
}
const safeExt = (name) => {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name || '');
  return m ? '.' + m[1].toLowerCase() : '.png';
};

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Serve crops, contact sheets and built fonts from each session workdir.
app.use('/work', express.static(WORK_ROOT));

const upload = multer({
  dest: path.join(os.tmpdir(), 'dyf-uploads'),
  limits: { fileSize: 25 * 1024 * 1024, files: 6 },
});

const newId = () => crypto.randomBytes(6).toString('hex');
const sessionDir = (sid) => path.join(WORK_ROOT, sid.replace(/[^a-f0-9]/g, ''));

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

// --- Template: scan a photo of a filled-in template ---------------------------
app.post('/api/template-scan', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded.' });
  const charset = CHARSETS[req.body.charset] ? req.body.charset : 'full';
  const sid = newId();
  const dir = sessionDir(sid);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const result = await scanTemplate(req.file.path, dir, { charset });
    fs.unlink(req.file.path, () => {});
    res.json({
      sid,
      mode: 'template',
      charset,
      found: result.found,
      total: result.total,
      cropBase: `/work/${sid}/`,
      labels: result.labels,
      blobs: result.blobs.map((b) => ({ id: b.id, char: b.char, crop: b.crop, cropSize: b.cropSize, suggest: b.char })),
      apiKey: hasApiKey(),
    });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    const status = err.code === 'NO_MARKERS' ? 422 : 500;
    res.status(status).json({ error: err.message || String(err) });
  }
});

// --- Auto-label with Claude (optional; needs ANTHROPIC_API_KEY) ---------------
app.post('/api/autolabel', async (req, res) => {
  const { sid } = req.body || {};
  if (!sid) return res.status(400).json({ error: 'Missing session.' });
  if (!hasApiKey()) return res.status(400).json({ error: 'No ANTHROPIC_API_KEY set on the server.' });
  const dir = sessionDir(sid);
  if (!fs.existsSync(path.join(dir, 'blobs.json'))) return res.status(404).json({ error: 'Segment first.' });
  try {
    const labels = await autoLabel(dir);
    res.json({ labels });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// --- Build the font from labels + controls ------------------------------------
app.post('/api/build', async (req, res) => {
  const { sid, labels, name, weight, width, slant, spacing, formats, edgeSmooth } = req.body || {};
  if (!sid) return res.status(400).json({ error: 'Missing session.' });
  const dir = sessionDir(sid);
  if (!fs.existsSync(path.join(dir, 'blobs.json'))) return res.status(404).json({ error: 'Segment first.' });
  const outDir = path.join(dir, 'out');
  try {
    const result = await buildFont(dir, labels || {}, { name, weight, width, slant, spacing, formats, edgeSmooth }, outDir);
    const urlBase = `/work/${sid}/out/`;
    res.json({
      ...result,
      urls: Object.fromEntries(result.written.map((f) => [f.split('.').pop(), urlBase + f])),
      previewUrl: `${urlBase}${result.base}.woff`,
      urlBase,
    });
  } catch (err) {
    const status = (err.code === 'NO_GLYPHS' || err.code === 'NO_NAME') ? 400 : 500;
    res.status(status).json({ error: err.message || String(err) });
  }
});

// --- Opt-in marketing specimen: server renders a random funny potato phrase in
//     the user's built font (real shaping, so the alternates cycle) + a consent
//     record — this is what fills the public gallery. ---
app.post('/api/specimen', async (req, res) => {
  const { sid } = req.body || {};
  if (!sid) return res.status(400).json({ error: 'Missing session.' });
  const outDir = path.join(sessionDir(sid), 'out');
  let ttf;
  try {
    const ttfs = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.ttf')) : [];
    if (!ttfs.length) return res.status(400).json({ error: 'Build a font first.' });
    ttf = fs.readFileSync(path.join(outDir, ttfs[0]));
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
  try {
    const { renderSpecimenPNG } = require('./lib/specimen'); // lazy: only loads harfbuzz when used
    const { png, text } = await renderSpecimenPNG(ttf, {});
    const id = newId();
    fs.writeFileSync(path.join(SPECIMEN_DIR, id + '.png'), png);
    fs.writeFileSync(path.join(SPECIMEN_DIR, id + '.json'), JSON.stringify({
      id,
      text,
      font: String(req.body.font || '').slice(0, 80),
      consentVersion: String(req.body.consentVersion || '').slice(0, 40),
      consentText: String(req.body.consentText || '').slice(0, 400),
      ts: new Date().toISOString(),
    }, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// --- "Show us what you made": a message + optional photo (private feedback) ----
app.post('/api/share', upload.single('image'), (req, res) => {
  const message = String(req.body.message || '').slice(0, 4000);
  const email = String(req.body.email || '').slice(0, 200);
  if (!message && !req.file) return res.status(400).json({ error: 'Nothing to send.' });
  try {
    const id = newId();
    if (req.file) keepFile(req.file.path, path.join(SHARE_DIR, id + safeExt(req.file.originalname)));
    const record = {
      id, message, email,
      font: String(req.body.font || '').slice(0, 80),
      hasImage: !!req.file,
      ts: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(SHARE_DIR, id + '.json'), JSON.stringify(record, null, 2));
    res.json({ ok: true });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, apiKey: hasApiKey() }));

app.listen(PORT, () => {
  console.log(`\n  🥔  Font Potato running`);
  console.log(`      →  http://localhost:${PORT}\n`);
  if (!hasApiKey()) {
    console.log('  (Auto-label with Claude is off — set ANTHROPIC_API_KEY to enable it.)\n');
  }
});
