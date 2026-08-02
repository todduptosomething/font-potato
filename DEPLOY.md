# Deploying Font Potato as a web app

> **Current direction:** we're porting the pipeline to run entirely client-side
> (in the browser, via Canvas/WASM) and shipping as a static site on GitHub
> Pages — no server at all. See the repo issues/notes for that work. Everything
> below describes deploying the *current* server-based version as-is (Docker on
> Render/Railway/Fly) — still valid as a fast fallback, but not the target.

The same `server.js` that powers the app is a normal Node/Express server, so
you can host it and let anyone use it. No login, free beta.

## What the code already handles
- **Cross-platform image reading** — HEIC works on Linux via `heic-convert`
  (macOS uses `sips`); JPG/PNG work everywhere.
- **Config via env** — `PORT` (hosts inject this) and `DYF_DATA_DIR` (where
  uploads, built fonts, and submissions are written).
- **Opt-in marketing samples** land in `$DYF_DATA_DIR/specimens/` (a PNG + a
  JSON consent record). "Show us what you made" lands in `$DYF_DATA_DIR/shares/`.

## Fastest path (Docker → any host)
A `Dockerfile` is included.

```bash
docker build -t font-potato .
docker run -p 8080:8080 -v fontpotato-data:/data font-potato
# open http://localhost:8080
```

On **Render / Railway / Fly.io**: point them at this folder, use the Dockerfile,
add a **persistent volume mounted at `/data`** (so submissions survive restarts),
and you're live on a URL. (Env: they set `PORT`; leave `DYF_DATA_DIR=/data`.)

## Before opening it to the public — a short checklist
These aren't done yet; they matter once strangers can hit it:

1. **A serif for the template PDF.** On macOS the PDF header uses Georgia; on
   Linux it falls back to the built-in Times. To match the app's look *and* be
   redistributable, drop an **Open Font License** serif into the repo and point
   `lib/template.js` at it (see `registerSerif`). Don't ship a copy of Georgia —
   it's proprietary.
2. **Abuse limits.** No login means bots can hammer it. Add basic rate-limiting
   (e.g. `express-rate-limit`) and keep the existing 25 MB upload cap.
3. **Moderation for "Show us."** People can upload anything. Review submissions
   before featuring them; add a takedown path.
4. **A one-page privacy note.** You now receive photos (during processing) and
   opt-in samples. State that photos are processed and not kept, and that samples
   are only stored when someone ticks the box. Offer an email to request deletion.
5. **Optional: Claude auto-labeling** stays off unless you set `ANTHROPIC_API_KEY`.

## Print-on-demand later (the seam is in place)
`lib/specimen.js` `renderSpecimenPNG(ttfBuffer, { text, emPx, color })` already
turns any built font + text into a high-res, transparent PNG using a real text
shaper (HarfBuzz), so the alternates cycle correctly — this is exactly a print
file. Adding Printify later is: a product picker → `renderSpecimenPNG` at print
DPI with the buyer's text → Printify API create-product + order → Stripe
checkout. All new server code + secrets; none of it blocks the free beta.
