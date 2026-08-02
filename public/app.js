'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULT_PREVIEW = "When did ex-members of the Royal Potato Guild masquerade at Jerky Scoop Mill? After dazzling the friggin' vampires.";
const state = {
  sid: null,
  blobs: [],
  cropBase: '',
  labels: {},        // blob id -> character
  tplFile: null,
  currentFace: null,
  buildTimer: null,
  lastResult: null,
};

/* ---------- download template ---------- */
$('downloadTpl').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = '/api/template';
  a.download = 'handwriting-template.pdf';
  document.body.appendChild(a); a.click(); a.remove();
});

/* ---------- upload filled template ---------- */
const tplDrop = $('tplDrop'), tplFile = $('tplFile');
$('tplBrowse').addEventListener('click', () => tplFile.click());
tplDrop.addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON') tplFile.click(); });
tplFile.addEventListener('change', () => setTplFile(tplFile.files[0]));
['dragenter', 'dragover'].forEach((t) => tplDrop.addEventListener(t, (e) => { e.preventDefault(); tplDrop.classList.add('drag'); }));
['dragleave', 'drop'].forEach((t) => tplDrop.addEventListener(t, (e) => { e.preventDefault(); tplDrop.classList.remove('drag'); }));
tplDrop.addEventListener('drop', (e) => { const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/')); if (f) setTplFile(f); });

function setTplFile(f) {
  if (!f) return;
  state.tplFile = f;
  $('scanTplBtn').disabled = false;
  tplDrop.innerHTML = `<p><strong>Ready:</strong> ${f.name}</p><p class="fine">Click to choose a different photo.</p>`;
}

$('scanTplBtn').addEventListener('click', scanTemplate);
async function scanTemplate() {
  if (!state.tplFile) return;
  busy(true, 'Reading your template…');
  const fd = new FormData();
  fd.append('photo', state.tplFile);
  try {
    const res = await fetch('/api/template-scan', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not read the template');
    state.sid = data.sid;
    state.blobs = data.blobs;
    state.cropBase = data.cropBase;
    state.labels = {};
    state.blobs.forEach((b) => { if (b.char) state.labels[b.id] = b.char; });
    renderCrops();
    $('labelArea').hidden = false;
    $('studioPanel').hidden = false;
    status('tplStatus', `Read ${data.found} of ${data.total} letters. Blank boxes were skipped.`, 'ok');
    scheduleBuild();
  } catch (err) {
    status('tplStatus', err.message, 'err');
  } finally { busy(false); }
}

/* ---------- captured letters (read-only; mapping is by box position) ---------- */
function renderCrops() {
  const grid = $('cropGrid');
  grid.innerHTML = '';
  for (const b of state.blobs) {
    const cell = document.createElement('div');
    cell.className = 'crop';
    cell.innerHTML =
      `<img src="${state.cropBase}${b.crop}" alt="" />` +
      `<span class="cap">${escapeHtml(b.char || '')}</span>`;
    grid.appendChild(cell);
  }
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function normChar(v) {
  if (!v) return '';
  const c = String(v).normalize('NFC');
  return [...c].length === 1 ? c : '';
}

/* ---------- controls ---------- */
const bind = (id, valId, fmt) => {
  const el = $(id);
  el.addEventListener('input', () => { if (valId) $(valId).textContent = fmt ? fmt(el.value) : el.value; scheduleBuild(); });
};
bind('weight', 'weightVal');
const WIDTH_LABELS = ['Condensed', 'Regular', 'Wide'];
bind('width', 'widthVal', (v) => WIDTH_LABELS[v]);
bind('slant', 'slantVal', (v) => `${v}°`);
bind('edgeSmooth', 'edgeSmoothVal', (v) => (Number(v) / 10).toFixed(1));
$('fontName').addEventListener('input', scheduleBuild);
$('previewText').addEventListener('input', updateSample);
$('previewSize').addEventListener('input', (e) => ($('previewSample').style.fontSize = e.target.value + 'px'));

// one label per character (first box wins if a letter is entered twice)
function activeLabels() {
  const out = {};
  const seen = new Set();
  for (const b of state.blobs) {
    const c = normChar(state.labels[b.id]);
    if (c && !seen.has(c)) { seen.add(c); out[b.id] = c; }
  }
  return out;
}

/* ---------- build (debounced) ---------- */
function scheduleBuild() {
  if (!state.sid) return;
  clearTimeout(state.buildTimer);
  state.buildTimer = setTimeout(build, 350);
}

async function build() {
  const labels = activeLabels();
  if (!Object.keys(labels).length) { $('previewSample').textContent = 'Label at least one letter to see your font…'; return; }
  if (!$('fontName').value.trim()) { status('buildStatus', 'Name your font before building.', 'err'); return; }
  status('buildStatus', 'Baking font…', '');
  try {
    const res = await fetch('/api/build', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sid: state.sid, labels,
        name: $('fontName').value,
        weight: $('weight').value, width: $('width').value,
        slant: $('slant').value, edgeSmooth: $('edgeSmooth').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Build failed');
    state.lastResult = data;
    await applyFont(data.previewUrl);
    updateSample();
    renderDownloads(data);
    const miss = data.missing.length ? `Not in your font yet: ${data.missing.join(' ')}` : 'Full A–Z / a–z covered.';
    $('missingNote').hidden = false;
    $('missingNote').textContent = `${data.glyphs.length} glyphs built. ${miss}`;
    status('buildStatus', 'Font is ready. 🥔', 'ok');
  } catch (err) {
    status('buildStatus', err.message, 'err');
  }
}

async function applyFont(url) {
  const bust = url + '?v=' + Date.now();
  try {
    const face = new FontFace('DYFPreview', `url(${bust})`);
    await face.load();
    if (state.currentFace) document.fonts.delete(state.currentFace);
    document.fonts.add(face);
    state.currentFace = face;
    document.documentElement.style.setProperty('--previewFamily', 'DYFPreview');
  } catch (_) {}
}

function updateSample() {
  $('previewSample').textContent = $('previewText').value || DEFAULT_PREVIEW;
  $('previewSample').style.fontSize = $('previewSize').value + 'px';
}

function renderDownloads(data) {
  const box = $('downloads');
  box.innerHTML = '';
  const labels = { ttf: 'TTF', woff: 'WOFF', woff2: 'WOFF2', css: 'CSS' };
  for (const fmt of ['ttf', 'woff', 'woff2', 'css']) {
    if (!data.urls[fmt]) continue;
    const a = document.createElement('a');
    a.href = data.urls[fmt];
    a.download = `${data.base}.${fmt}`;
    a.className = 'dl';
    a.innerHTML = `<span class="dl-fmt">${labels[fmt]}</span>`;
    box.appendChild(a);
  }
}

/* ---------- share: opt-in specimen + "show us what you made" ---------- */
const CONSENT_VERSION = '2026-07-31';
const CONSENT_TEXT = 'Let Font Potato use samples of your font for our gallery and marketing. We make images of sample sentences in your font — never the font file, and never the uploaded photo.';

// Ticking the box auto-sends a specimen: the server renders a random pangram in
// the just-built font (real shaping, so the alternates cycle). No text box, no
// extra clicks. Unticking does nothing (nothing new is sent).
$('optIn').addEventListener('change', async () => {
  if (!$('optIn').checked) { $('optInStatus').textContent = ''; return; }
  if (!state.sid || !state.lastResult) { status('optInStatus', 'Make a font first, then tick this.', 'err'); $('optIn').checked = false; return; }
  status('optInStatus', 'Sending a sample…');
  try {
    const res = await fetch('/api/specimen', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sid: state.sid, font: $('fontName').value, consentVersion: CONSENT_VERSION, consentText: CONSENT_TEXT }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Could not send');
    status('optInStatus', 'Thank you! 🥔 We may feature your font.', 'ok');
  } catch (e) { status('optInStatus', e.message, 'err'); $('optIn').checked = false; }
});

$('madeFile').addEventListener('change', () => {
  const f = $('madeFile').files[0];
  document.querySelector('.attach').firstChild.textContent = f ? `Photo: ${f.name.slice(0, 22)}` : 'Attach a photo';
});

$('madeSendBtn').addEventListener('click', async () => {
  const msg = ($('madeMsg').value || '').trim();
  const email = ($('madeEmail').value || '').trim();
  const file = $('madeFile').files[0];
  if (!msg && !file) { status('madeStatus', 'Add a note or a photo first.', 'err'); return; }
  status('madeStatus', 'Sending…');
  try {
    const fd = new FormData();
    fd.append('message', msg);
    fd.append('email', email);
    fd.append('font', $('fontName').value);
    if (file) fd.append('image', file);
    const res = await fetch('/api/share', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).error || 'Could not send');
    status('madeStatus', 'Sent — thank you! 🥔', 'ok');
    $('madeMsg').value = ''; $('madeFile').value = '';
    document.querySelector('.attach').firstChild.textContent = 'Attach a photo';
  } catch (e) { status('madeStatus', e.message, 'err'); }
});

/* ---------- helpers ---------- */
function status(id, msg, kind) {
  const el = $(id);
  el.hidden = false;
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
}
function busy(on, msg) { $('busy').hidden = !on; if (msg) $('busyMsg').textContent = msg; }

/* ---------- theme switcher ---------- */
(function themes() {
  const btn = $('themeBtn'), menu = $('themeMenu');
  const THEMES = ['russet', 'sweet', 'yukon'];
  const apply = (t) => {
    document.documentElement.dataset.theme = t;
    menu.querySelectorAll('button[data-theme]').forEach((b) => b.setAttribute('aria-current', b.dataset.theme === t ? 'true' : 'false'));
    try { localStorage.setItem('fp-theme', t); } catch (_) {}
  };
  let saved = null;
  try { saved = localStorage.getItem('fp-theme'); } catch (_) {}
  apply(THEMES.includes(saved) ? saved : 'russet');
  btn.addEventListener('click', (e) => { e.stopPropagation(); const open = menu.hidden; menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); });
  menu.addEventListener('click', (e) => { const b = e.target.closest('button[data-theme]'); if (!b) return; apply(b.dataset.theme); menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); });
  document.addEventListener('click', () => { if (!menu.hidden) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
})();
