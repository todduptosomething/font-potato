'use strict';
// Optional: label glyph blobs with Claude vision via the Anthropic API.
// Only used when ANTHROPIC_API_KEY is set. The server degrades to manual
// labeling when it isn't. Sends the numbered contact sheet(s) — exactly the
// artifact draw-your-font designs for agent labeling — and asks for id->char.

const fs = require('fs');
const path = require('path');

const MODEL = process.env.DYF_LABEL_MODEL || 'claude-sonnet-5';

function hasApiKey() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function contactSheets(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => /^contact-\d+\.png$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

async function autoLabel(dir) {
  const blobs = JSON.parse(fs.readFileSync(path.join(dir, 'blobs.json'), 'utf8'));
  const ids = blobs.blobs.map((b) => b.id);
  const sheets = contactSheets(dir);
  if (!sheets.length) throw new Error('No contact sheet to label.');

  const images = sheets.map((f) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: fs.readFileSync(f).toString('base64') },
  }));

  const prompt =
    `These contact sheet(s) show a photo of handwriting with each detected glyph ` +
    `boxed and numbered in red. The blob ids present are: ${ids.join(', ')}.\n\n` +
    `Identify the single character drawn inside each numbered box. Preserve case ` +
    `(distinguish C/c, O/o, S/s by size and context of the row). If a box clearly ` +
    `contains no real letter/number/punctuation, map it to an empty string.\n\n` +
    `Respond with ONLY a JSON object mapping id (as string) to the character, e.g. ` +
    `{"0":"A","1":"b","2":"."}. No prose, no code fence.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: [...images, { type: 'text', text: prompt }] }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Anthropic API ${resp.status}: ${body.slice(0, 300)}`);
  }
  const data = await resp.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Model did not return a JSON label map.');
  const raw = JSON.parse(match[0]);
  // Keep only ids we actually have.
  const out = {};
  for (const id of ids) if (raw[String(id)]) out[String(id)] = String(raw[String(id)]);
  return out;
}

module.exports = { autoLabel, hasApiKey };
