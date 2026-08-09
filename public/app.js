'use strict';
// Everything below runs in the browser — scanning the photo, tracing the
// letters, building the font and packaging the download. Nothing about a
// person's handwriting leaves their machine unless they ask it to; the only
// things sent anywhere are the three things they type or tick (mailing list,
// contact message, opt-in specimen), and those go straight to Supabase.
// See public/engine/ for the pipeline itself.

import { scanPhoto, warmScanWorker } from './engine/scan-controller.js';
import { FontBuilder } from './engine/fontbuild.js';
import { buildFontPackage, warmPack } from './engine/pack.js';
import { subscribe, sendMessage, submitSpecimen } from './engine/collect.js';
import { renderSpecimen } from './engine/specimen.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_PREVIEW = "When did ex-members of the Royal Potato Guild masquerade at Jerky Hill School? After dazzling the friggin' vampires.";
const state = {
  scan: null,        // primary scan result from the engine
  altScans: [],      // extra filled-in sheets -> real alternates
  blobs: [],         // scan.blobs, kept for the thumbnail grid
  cropURLs: [],      // object URLs for those thumbnails (revoked on reset)
  labels: {},        // blob id -> character
  tplFile: null,
  builder: null,     // FontBuilder, holds the trace/variant caches
  currentFace: null,
  buildTimer: null,
  buildToken: 0,     // guards against an older build finishing last
  lastTTF: null,
  lastFamily: '',
  altSlots: [],      // manual-alternates sheets: {file}
};
const MAX_ALT_SHEETS = 2;

/* ---------- wizard: 3 steps that slide left/right ---------- */
const TOTAL_STEPS = 3;
const wizard = { current: 1, maxReached: 1 };
const stepsTrack = $('stepsTrack');

function goToStep(n) {
  n = Math.max(1, Math.min(TOTAL_STEPS, n));
  wizard.current = n;
  wizard.maxReached = Math.max(wizard.maxReached, n);
  stepsTrack.style.transform = `translateX(-${(n - 1) * (100 / TOTAL_STEPS)}%)`;
  updateWizardNav();
  // .app-viewport sits above a scrollable footer, so a focused control's
  // default scrollIntoView (e.g. right after this click) can drag the whole
  // page down and shove the wizard itself out of view. Force it back — the
  // wizard is meant to always be reachable without any page-level scroll.
  window.scrollTo(0, 0);
  const entering = document.getElementById(`step${n}`);
  if (entering) entering.scrollTop = 0;
}

function updateWizardNav() {
  $('navBack').disabled = wizard.current <= 1;
  $('navFwd').disabled = wizard.current >= wizard.maxReached;
  document.querySelectorAll('#stepDots .dot').forEach((dot) => {
    const s = Number(dot.dataset.step);
    dot.classList.toggle('active', s === wizard.current);
    dot.classList.toggle('reachable', s <= wizard.maxReached);
  });
}

$('navBack').addEventListener('click', () => goToStep(wizard.current - 1));
$('navFwd').addEventListener('click', () => goToStep(wizard.current + 1));
document.querySelectorAll('#stepDots .dot').forEach((dot) => {
  dot.addEventListener('click', () => {
    const s = Number(dot.dataset.step);
    if (s <= wizard.maxReached) goToStep(s);
  });
});
$('getStartedBtn').addEventListener('click', () => {
  goToStep(2);
  // Spin up the scan worker and compile the HEIC decoder now, while they're
  // reading the template step — so choosing a photo doesn't stall on it.
  warmScanWorker();
});
// Logo click = start over: a full reload is the simplest way to guarantee
// every uploaded file, scanned session, and built font actually clears —
// no risk of missing some piece of state a manual reset would forget.
$('brandReset').addEventListener('click', () => { window.location.href = '/'; });
updateWizardNav();

/* ---------- download template ---------- */
// A static file, not a generated one: the sheet is the same for everybody, so
// it's built once by `npm run build:template` and served off the CDN.
$('downloadTpl').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = '/handwriting-template.pdf';
  a.download = 'handwriting-template.pdf';
  document.body.appendChild(a); a.click(); a.remove();
});

/* ---------- upload filled template (primary sheet) ---------- */
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
  $('processBtn').disabled = false;
  tplDrop.innerHTML = `<p><strong>Ready:</strong> ${f.name}</p><p class="fine">Click to choose a different photo.</p>`;
}

/* ---------- manual alternates: up to 2 extra filled sheets (file only —
   scanned together with the primary sheet when Process is clicked) ---------- */
$('manualAlt').addEventListener('change', () => {
  const on = $('manualAlt').checked;
  $('altSheets').hidden = !on;
  if (on && !state.altSlots.length) {
    for (let i = 0; i < MAX_ALT_SHEETS; i++) addAltSlot(i);
  } else if (!on) {
    state.altSlots = [];
    $('altSheets').innerHTML = '';
  }
});

function addAltSlot(idx) {
  const slot = { file: null, sid: null };
  state.altSlots[idx] = slot;

  const wrap = document.createElement('div');
  wrap.className = 'alt-slot';
  wrap.innerHTML =
    `<div class="drop alt-drop">` +
    `<p><strong>Drop alternate sheet ${idx + 1}</strong> — same template, filled in again<br />or <button type="button" class="link">browse</button></p>` +
    `</div>` +
    `<input type="file" accept="image/*" hidden />`;
  $('altSheets').appendChild(wrap);

  const drop = wrap.querySelector('.drop');
  const fileInput = wrap.querySelector('input[type=file]');
  const browseBtn = wrap.querySelector('.link');

  browseBtn.addEventListener('click', () => fileInput.click());
  drop.addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON') fileInput.click(); });
  fileInput.addEventListener('change', () => setAltFile(idx, fileInput.files[0], drop));
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => { const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/')); if (f) setAltFile(idx, f, drop); });
}

function setAltFile(idx, f, drop) {
  if (!f) return;
  state.altSlots[idx].file = f;
  drop.innerHTML = `<p><strong>Ready:</strong> ${f.name}</p><p class="fine">Click to choose a different photo.</p>`;
}

/* ---------- process: scan the primary sheet + any alternate sheets, then
   move to the studio step ---------- */
$('processBtn').addEventListener('click', processSheets);

// Turn the engine's progress phases into something worth reading. Decoding
// is the long one on an iPhone HEIC (the photo has to be decompressed in
// software), so it gets its own wording rather than a stuck-looking spinner.
function scanProgress(prefix) {
  return (p) => {
    if (p.phase === 'decoding') busy(true, `${prefix}: opening the photo…`);
    else if (p.phase === 'locating') busy(true, `${prefix}: finding the corner marks…`);
    else if (p.phase === 'reading') busy(true, `${prefix}: reading letters ${p.done} of ${p.total}…`);
  };
}

async function processSheets() {
  if (!state.tplFile) return;
  busy(true, 'Reading your template…');
  try {
    const primary = await scanPhoto(state.tplFile, { onProgress: scanProgress('Your sheet') });
    state.scan = primary;
    state.blobs = primary.blobs;
    state.labels = {};
    state.blobs.forEach((b) => { if (b.char) state.labels[b.id] = b.char; });

    state.altScans = [];
    const sheets = state.altSlots.filter((s) => s && s.file);
    for (let i = 0; i < sheets.length; i++) {
      const label = sheets.length > 1 ? `Alternate sheet ${i + 1}` : 'Alternate sheet';
      const alt = await scanPhoto(sheets[i].file, { onProgress: scanProgress(label) });
      state.altScans.push(alt);
    }

    // A new scan invalidates every cached trace, so start a fresh builder.
    state.builder = new FontBuilder(state.scan, state.altScans);

    renderCrops();
    $('labelArea').hidden = false;
    const altNote = state.altScans.length
      ? ` Plus ${state.altScans.length} alternate sheet${state.altScans.length > 1 ? 's' : ''}.`
      : '';
    status('processStatus', `Read ${primary.found} of ${primary.total} letters. Blank boxes were skipped.${altNote}`, 'ok');
    goToStep(3);
    scheduleBuild();
  } catch (err) {
    status('processStatus', err.message, 'err');
  } finally { busy(false); }
}

/* ---------- captured letters: small chips, click one for a bigger look ---------- */
function renderCrops() {
  const grid = $('cropGrid');
  grid.innerHTML = '';
  // The crops are Blobs held in memory now rather than files on a server, so
  // each needs an object URL — and the previous batch's need releasing or
  // they'd leak for the life of the page.
  state.cropURLs.forEach((u) => URL.revokeObjectURL(u));
  state.cropURLs = [];
  for (const b of state.blobs) {
    const cell = document.createElement('div');
    cell.className = 'crop';
    const src = URL.createObjectURL(b.blob);
    state.cropURLs.push(src);
    cell.dataset.char = b.char || '';
    cell.innerHTML =
      `<img src="${src}" alt="" />` +
      `<span class="cap">${escapeHtml(b.char || '')}</span>`;
    grid.appendChild(cell);
  }
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

$('cropGrid').addEventListener('click', (e) => {
  const cell = e.target.closest('.crop');
  if (!cell) return;
  const img = cell.querySelector('img');
  $('cropModalImg').src = img.src;
  $('cropModalCap').textContent = cell.dataset.char;
  $('cropModal').hidden = false;
});
$('cropModalClose').addEventListener('click', () => { $('cropModal').hidden = true; });
$('cropModal').addEventListener('click', (e) => { if (e.target === $('cropModal')) $('cropModal').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('cropModal').hidden) $('cropModal').hidden = true; });
function normChar(v) {
  if (!v) return '';
  const c = String(v).normalize('NFC');
  return [...c].length === 1 ? c : '';
}

/* ---------- controls ---------- */
// Sliders fire `input` continuously while dragging and `change` once on
// release. Dragging gets the fast preview font (no alternates, no kerning —
// invisible mid-drag but most of the build cost); letting go rebuilds it
// properly. Text fields have no equivalent of "release", so they just get
// the usual debounce.
const bind = (id, valId, fmt) => {
  const el = $(id);
  el.addEventListener('input', () => {
    if (valId) $(valId).textContent = fmt ? fmt(el.value) : el.value;
    scheduleBuild({ preview: true, delay: 30 });
  });
  el.addEventListener('change', () => scheduleBuild());
};
bind('weight', 'weightVal');
const WIDTH_LABELS = ['Condensed', 'Regular', 'Wide'];
bind('width', 'widthVal', (v) => WIDTH_LABELS[v]);
bind('slant', 'slantVal', (v) => `${v}°`);
bind('edgeSmooth', 'edgeSmoothVal', (v) => (Number(v) / 10).toFixed(1));
$('fontName').addEventListener('input', scheduleBuild);
$('authorName').addEventListener('input', scheduleBuild);
$('previewText').addEventListener('input', updateSample);
$('previewSize').addEventListener('input', (e) => {
  $('previewSample').style.fontSize = e.target.value + 'px';
  $('previewSizeVal').textContent = e.target.value + 'px';
});

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
function scheduleBuild({ preview = false, delay = 250 } = {}) {
  if (!state.builder) return;
  clearTimeout(state.buildTimer);
  state.buildTimer = setTimeout(() => build({ preview }), delay);
}

async function build({ preview = false } = {}) {
  if (!state.builder) return;
  if (!$('fontName').value.trim()) { status('nameStatus', 'Name your font before building.', 'err'); return; }
  $('nameStatus').hidden = true;

  // Builds are async and a fast preview can finish after a slower full build
  // that started earlier. Only the newest one is allowed to touch the page.
  const token = ++state.buildToken;
  if (!preview) status('buildStatus', 'Baking font…', '');

  try {
    const result = await state.builder.build({
      name: $('fontName').value,
      authorName: $('authorName').value,
      weight: Number($('weight').value),
      slant: Number($('slant').value),
      // The Edge Smoothness slider is 0..30 in the markup; the engine takes
      // potrace's own 0..2 smoothing scale.
      smooth: Number($('edgeSmooth').value) / 15,
      spacing: 0,
      preview,
    }, (phase, done, total) => {
      if (token !== state.buildToken || preview) return;
      if (phase === 'tracing' && total) status('buildStatus', `Tracing letters ${done} of ${total}…`, '');
    });

    if (token !== state.buildToken) return; // superseded while we were working

    state.lastTTF = result.ttf;
    state.lastFamily = result.family;
    await applyFont(result.ttf);
    updateSample();

    if (!preview) {
      showDownload(result);
      const miss = result.missing.length ? ` Not in your font yet: ${result.missing.join(' ')}` : '';
      $('missingNote').hidden = false;
      $('missingNote').textContent = `${result.glyphs.length} glyphs built.${miss}`;
      status('buildStatus', 'Font is ready. 🥔', 'ok');
      warmPack(); // fetch the WOFF converter now, not on the download click
    }
  } catch (err) {
    if (token === state.buildToken) status('buildStatus', err.message, 'err');
  }
}

async function applyFont(ttf) {
  try {
    // Copy out of the engine's buffer — FontFace takes ownership of what it
    // is given, and the same bytes are still needed for the download.
    const face = new FontFace('DYFPreview', ttf.buffer.slice(ttf.byteOffset, ttf.byteOffset + ttf.byteLength));
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
  $('previewSizeVal').textContent = $('previewSize').value + 'px';
}

function showDownload() {
  $('downloadZip').hidden = false;
  $('zipHint').hidden = false;
  $('specimenOptin').hidden = false;
}

const safeBase = (name) => (name || '').replace(/[^A-Za-z0-9_-]+/g, '') || 'MyHandwriting';

// The zip is assembled here, on demand — there's no server file to link to.
// Building it takes a moment (the TTF has to be converted to WOFF), so the
// button reports progress rather than appearing to do nothing.
$('downloadZip').addEventListener('click', async (e) => {
  e.preventDefault();
  if (!state.lastTTF) return;
  const btn = $('downloadZip');
  const label = btn.textContent;
  btn.textContent = 'Packaging…';
  btn.style.pointerEvents = 'none';
  try {
    const family = $('fontName').value.trim() || 'My Handwriting';
    const fileBase = safeBase(family);
    const zip = await buildFontPackage(state.lastTTF, {
      family, fileBase, authorName: $('authorName').value,
    });
    const url = URL.createObjectURL(zip);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileBase}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    sendSpecimen();
  } catch (err) {
    status('buildStatus', `Could not package the download: ${err.message}`, 'err');
  } finally {
    btn.textContent = label;
    btn.style.pointerEvents = '';
  }
});

// Opt-in specimen: fires every time they download, not just the first —
// a later tweak (bolder, wider, etc.) that they download again is still a
// version worth seeing, not just their first pass. What gets sent is a PNG of
// one phrase set in their font, drawn here on a canvas, not the font file and
// never the photo.
const SPECIMEN_CONSENT_VERSION = 'v1';
async function sendSpecimen() {
  if (!state.lastTTF || !$('specimenConsent').checked) return;
  try {
    const { png, text } = await renderSpecimen('DYFPreview');
    await submitSpecimen({
      fontName: $('fontName').value.trim(),
      phrase: text,
      png,
      consentVersion: SPECIMEN_CONSENT_VERSION,
      consentText: $('specimenOptin').textContent.trim(),
    });
  } catch (_) {
    // Nothing here is worth interrupting a download over.
  }
}

/* ---------- footer: stay-in-the-loop email + feedback ---------- */
$('subscribeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = ($('subscribeEmail').value || '').trim();
  if (!email) return;
  if (!isValidEmail(email)) { status('subscribeStatus', 'Enter a valid email.', 'err'); return; }
  status('subscribeStatus', 'Sending…');
  try {
    await subscribe(email);
    status('subscribeStatus', "You're on the list. 🥔", 'ok');
    $('subscribeEmail').value = '';
  } catch (e) { status('subscribeStatus', e.message, 'err'); }
});

$('madeFile').addEventListener('change', () => {
  const f = $('madeFile').files[0];
  document.querySelector('.attach').firstChild.textContent = f ? `Photo: ${f.name.slice(0, 22)}` : 'Attach a photo';
});

const isValidEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

$('madeSendBtn').addEventListener('click', async () => {
  const firstName = ($('madeFirstName').value || '').trim();
  const lastName = ($('madeLastName').value || '').trim();
  const msg = ($('madeMsg').value || '').trim();
  const email = ($('madeEmail').value || '').trim();
  const file = $('madeFile').files[0];
  if (!msg) { status('madeStatus', 'Add a message first.', 'err'); return; }
  if (!isValidEmail(email)) { status('madeStatus', 'Enter a valid email.', 'err'); return; }
  status('madeStatus', 'Sending…');
  try {
    await sendMessage({
      firstName, lastName, email, message: msg,
      fontName: $('fontName').value.trim(), image: file,
    });
    status('madeStatus', 'Sent — thank you! 🥔', 'ok');
    $('madeFirstName').value = ''; $('madeLastName').value = '';
    $('madeMsg').value = ''; $('madeEmail').value = ''; $('madeFile').value = '';
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

/* ---------- theme switcher (lives inside the full-screen menu) ---------- */
const applyTheme = (() => {
  const THEMES = ['russet', 'sweet', 'yukon'];
  const options = $('themeOptions');
  const apply = (t) => {
    document.documentElement.dataset.theme = t;
    options.querySelectorAll('button[data-theme]').forEach((b) => b.setAttribute('aria-current', b.dataset.theme === t ? 'true' : 'false'));
    try { localStorage.setItem('fp-theme', t); } catch (_) {}
  };
  let saved = null;
  try { saved = localStorage.getItem('fp-theme'); } catch (_) {}
  apply(THEMES.includes(saved) ? saved : 'russet');
  options.addEventListener('click', (e) => { const b = e.target.closest('button[data-theme]'); if (b) apply(b.dataset.theme); });
  return apply;
})();

/* ---------- full-screen menu: theme, stay-in-the-loop, feedback, credits ----------
   The hamburger button itself morphs into the close X (rather than a separate
   close button elsewhere) so "close" is always exactly where "open" was. ---- */
(function menu() {
  const btn = $('menuBtn'), overlay = $('menuOverlay'), panel = document.querySelector('.menu-panel');
  const open = () => {
    // Anchor the reveal circle on the button's own center so it animates out
    // from there no matter where it sits at the current viewport size.
    const r = btn.getBoundingClientRect();
    overlay.style.setProperty('--menu-origin-x', `${r.left + r.width / 2}px`);
    overlay.style.setProperty('--menu-origin-y', `${r.top + r.height / 2}px`);
    overlay.classList.add('open');
    btn.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    btn.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-label', 'Close menu');
  };
  const close = () => {
    overlay.classList.remove('open');
    btn.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Menu');
  };
  btn.addEventListener('click', () => (overlay.classList.contains('open') ? close() : open()));
  overlay.addEventListener('click', (e) => { if (!panel.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('open')) close(); });
})();
