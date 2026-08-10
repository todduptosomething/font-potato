// Emails Todd when someone submits the Font Potato contact form.
//
// JWT verification is deliberately off, and that is safe here because this
// function trusts NOTHING from its caller — it ignores the request body
// entirely and reads unsent messages out of the database with its own
// service-role key. A stranger who finds this URL can make it run, but the
// only thing it will ever send is a message a real person actually submitted.
// There is no payload to forge and no secret to leak into a database trigger.
//
// Requires one secret to be set on the project: RESEND_API_KEY.

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Resend's shared testing sender. It can only deliver to the address on the
// Resend account, which is exactly the one recipient this function has — so
// it needs no verified domain, and fontpotato.com's DNS keeps saying the
// domain sends no mail at all.
const FROM = Deno.env.get('CONTACT_FROM') ?? 'Font Potato <onboarding@resend.dev>';
const TO = Deno.env.get('CONTACT_TO') ?? 'todd@getuptosomething.com';

// How many unsent messages one run will clear. Raised from 20 because a run
// now costs ONE email regardless of how many rows it carries (see below), so
// a bigger batch means fewer emails during a flood, not more work per email.
const BATCH = 100;

// Above this many messages in a single run, stop minting signed photo links.
// Each one is a separate round-trip to Storage, and a hundred of them would
// risk the function timing out — which would mean sending nothing at all.
// Real traffic is one or two messages a run; only an attacker produces
// dozens, and their "messages" do not have photos worth linking.
const SIGN_LINKS_UP_TO = 10;

const db = (path: string, init: RequestInit = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// The attachment bucket is private, so a plain URL would 404. Mint a signed
// link instead, good for 30 days — long enough to still work if the mail is
// read late, short enough that forwarding it doesn't hand out permanent
// access to someone's photo.
async function signedImageUrl(path: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/contact-uploads/${path}`,
      {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 60 * 60 * 24 * 30 }),
      },
    );
    if (!res.ok) {
      console.error('could not sign image link', path, res.status, await res.text());
      return null;
    }
    const { signedURL } = await res.json();
    if (!signedURL) {
      console.error('sign call succeeded but returned no URL', path);
      return null;
    }
    return `${SUPABASE_URL}/storage/v1${signedURL}`;
  } catch (err) {
    console.error('signing threw', path, String(err));
    return null;
  }
}

interface Row {
  id: string;
  created_at: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  message: string;
  font_name: string | null;
  image_path: string | null;
}

const senderName = (row: Row) =>
  [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Someone';

// Never silently drop the fact that a photo exists. If the link couldn't be
// made — or wasn't attempted, because this run is clearing a flood — say so
// and give the filename, so the photo can still be found in Storage by hand
// rather than being invisible.
function photoLine(row: Row, img: string | null, signingAttempted: boolean): string {
  if (!row.image_path) return '';
  if (img) {
    return `<p style="margin:0 0 6px"><a href="${img}">They attached a photo</a> (link works for 30 days)</p>`;
  }
  const why = signingAttempted ? "the link couldn't be generated" : 'links are skipped on a large batch';
  return (
    `<p style="margin:0 0 6px;color:#b23a26">They attached a photo, but ${why}. ` +
    `Find it in Supabase Storage &rarr; contact-uploads &rarr; ${escapeHtml(row.image_path)}</p>`
  );
}

async function resend(payload: Record<string, unknown>): Promise<boolean> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [TO], ...payload }),
  });
  if (!res.ok) {
    console.error('resend rejected send', res.status, await res.text());
    return false;
  }
  return true;
}

// One message, one email — the ordinary case, unchanged. Replying goes
// straight to the person, not into a void.
async function sendOne(row: Row): Promise<boolean> {
  const name = senderName(row);
  const img = row.image_path ? await signedImageUrl(row.image_path) : null;

  const html = [
    `<div style="font-family:Georgia,serif;font-size:16px;line-height:1.6;color:#1b1a17">`,
    `<p style="margin:0 0 18px"><strong>${escapeHtml(name)}</strong> wrote in via Font Potato:</p>`,
    `<blockquote style="margin:0 0 18px;padding:12px 16px;border-left:3px solid #dcdcdc;white-space:pre-wrap">${escapeHtml(row.message)}</blockquote>`,
    `<p style="margin:0 0 6px">Reply to: <a href="mailto:${encodeURIComponent(row.email)}">${escapeHtml(row.email)}</a></p>`,
    row.font_name ? `<p style="margin:0 0 6px">Their font: ${escapeHtml(row.font_name)}</p>` : '',
    photoLine(row, img, true),
    `<p style="margin:18px 0 0;font-size:13px;color:#6b6b6b">${escapeHtml(row.created_at)}</p>`,
    `</div>`,
  ].join('');

  return resend({
    reply_to: row.email,
    subject: `Font Potato: ${name} sent you a message`,
    html,
  });
}

// Several messages, ONE email. This is the whole point of the change: the
// form is open to anyone with no rate limit, so a person with a script can
// insert rows as fast as they like. Emailing per row turned that into an
// inbox flood; a digest turns a thousand junk submissions into a handful of
// emails, while a real message still arrives within seconds and reads the
// same. No reply_to here — a digest has many senders, so each one's address
// is a mailto link inline instead.
async function sendDigest(rows: Row[]): Promise<boolean> {
  const sign = rows.length <= SIGN_LINKS_UP_TO;
  const blocks: string[] = [];

  for (const row of rows) {
    const name = senderName(row);
    const img = sign && row.image_path ? await signedImageUrl(row.image_path) : null;
    blocks.push([
      `<div style="margin:0 0 26px;padding:0 0 20px;border-bottom:1px solid #ececec">`,
      `<p style="margin:0 0 10px"><strong>${escapeHtml(name)}</strong> &lt;<a href="mailto:${encodeURIComponent(row.email)}">${escapeHtml(row.email)}</a>&gt;`,
      ` <span style="color:#6b6b6b;font-size:13px">${escapeHtml(row.created_at)}</span></p>`,
      `<blockquote style="margin:0 0 10px;padding:10px 14px;border-left:3px solid #dcdcdc;white-space:pre-wrap">${escapeHtml(row.message)}</blockquote>`,
      row.font_name ? `<p style="margin:0 0 6px">Their font: ${escapeHtml(row.font_name)}</p>` : '',
      photoLine(row, img, sign),
      `</div>`,
    ].join(''));
  }

  const html = [
    `<div style="font-family:Georgia,serif;font-size:16px;line-height:1.6;color:#1b1a17">`,
    `<p style="margin:0 0 18px"><strong>${rows.length} messages</strong> came in via Font Potato:</p>`,
    blocks.join(''),
    `</div>`,
  ].join('');

  return resend({ subject: `Font Potato: ${rows.length} new messages`, html });
}

async function markNotified(ids: string[]): Promise<void> {
  // in.(...) marks the whole batch in one request rather than one per row.
  const list = ids.map((id) => `"${id}"`).join(',');
  const mark = await db(`contact_messages?id=in.(${list})`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ notified_at: new Date().toISOString() }),
  });
  // If the send succeeded but the mark failed, a duplicate email is the
  // failure mode — annoying, but better than silently dropping a message.
  if (!mark.ok) console.error('sent but could not mark notified', ids.length, mark.status);
}

Deno.serve(async () => {
  if (!RESEND_API_KEY) {
    // Loud and specific: this is the one piece of setup a human has to do.
    console.error('RESEND_API_KEY is not set — cannot send. Add it under Edge Functions > Secrets.');
    return new Response(JSON.stringify({ error: 'RESEND_API_KEY not set' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const res = await db(
    `contact_messages?notified_at=is.null&order=created_at.asc&limit=${BATCH}` +
      `&select=id,created_at,first_name,last_name,email,message,font_name,image_path`,
  );
  if (!res.ok) {
    const body = await res.text();
    console.error('could not read contact_messages', res.status, body);
    return new Response(JSON.stringify({ error: 'db read failed' }), { status: 500 });
  }

  const rows: Row[] = await res.json();
  if (rows.length === 0) {
    return new Response(JSON.stringify({ found: 0, sent: 0, emails: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Mark only what actually went out. A failed send leaves notified_at null
  // so the next run retries it, which is the same contract as before — it
  // just now applies to the batch as a whole rather than row by row.
  const ok = rows.length === 1 ? await sendOne(rows[0]) : await sendDigest(rows);
  if (!ok) {
    return new Response(JSON.stringify({ found: rows.length, sent: 0, emails: 0 }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  await markNotified(rows.map((r) => r.id));
  console.log('emailed', rows.length, rows.length === 1 ? 'message' : 'messages as one digest');

  return new Response(JSON.stringify({ found: rows.length, sent: rows.length, emails: 1 }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
