'use strict';
// Everything Font Potato collects — mailing-list signups, contact messages,
// and opt-in font specimens — written straight from the browser to Supabase.
//
// The key below is Supabase's *publishable* key and is meant to be public.
// It is safe here because the database is write-only to it: every table has
// an INSERT policy and deliberately no SELECT policy, so this key can add a
// row but cannot read anybody's email, message, or anything else back out.
// (Verified directly: inserts return 201, selects return [], deletes affect
// zero rows.) Reading the data requires the service-role key, which lives
// only in the Supabase dashboard and never ships to a browser.

const SUPABASE_URL = 'https://lyhbhhuzdcgaqjvyzfbv.supabase.co';
const SUPABASE_KEY = 'sb_publishable_aeijwT0yYKfPckbQNMWfZw_EML578Zx';

const headers = (extra = {}) => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  ...extra,
});

async function insertRow(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || `Could not save that (${res.status}).`);
    err.code = body.code;
    err.status = res.status;
    throw err;
  }
}

async function uploadFile(bucket, path, blob, contentType) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': contentType || blob.type || 'application/octet-stream' }),
    body: blob,
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status}).`);
  return path;
}

// A filename that can't collide and doesn't leak anything about the person.
function randomName(ext) {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('') + '.' + ext;
}

/** Mailing list. Signing up twice is a no-op, not an error the user should see. */
async function subscribe(email) {
  try {
    await insertRow('subscribers', { email: String(email).trim() });
  } catch (err) {
    if (err.code === '23505') return; // already on the list — nothing to report
    throw err;
  }
}

/** Contact / "show us what you made", with an optional photo attachment. */
async function sendMessage({ firstName, lastName, email, message, fontName, image }) {
  let imagePath = null;
  if (image) {
    const ext = (image.name || '').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    // Best-effort: losing an attachment shouldn't lose the message itself.
    try {
      imagePath = await uploadFile('contact-uploads', randomName(ext), image);
    } catch { imagePath = null; }
  }
  await insertRow('contact_messages', {
    first_name: firstName || null,
    last_name: lastName || null,
    email: String(email).trim(),
    message,
    font_name: fontName || null,
    image_path: imagePath,
  });
}

/** Opt-in specimen: a PNG of their font plus the consent they agreed to. */
async function submitSpecimen({ fontName, phrase, png, consentVersion, consentText }) {
  let imagePath = null;
  if (png) {
    try {
      imagePath = await uploadFile('specimens', randomName('png'), png, 'image/png');
    } catch { imagePath = null; }
  }
  await insertRow('specimens', {
    font_name: fontName || null,
    phrase: phrase || null,
    image_path: imagePath,
    consent_version: consentVersion,
    consent_text: consentText,
  });
}

export { subscribe, sendMessage, submitSpecimen, SUPABASE_URL };
