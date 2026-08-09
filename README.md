# 🥔 Font Potato

Turn a photo of your handwriting into a real, installable font — with live
sliders for **weight, width, slant, and edge smoothness**, always-on
**alternate glyphs** so repeated letters don't look like identical stamps, and
a marker-based template so every letter is read by position instead of guessed.

**Everything runs in your browser.** The photo is decoded, the page is found by
its corner marks, the letters are traced, the font is assembled and the zip is
packaged — all on the user's own machine. Nothing about their handwriting is
uploaded, ever. The site is static files; there is no server to send it to.

It wraps the [`draw-your-font`](https://github.com/danilo-znamerovszkij/draw-your-font)
engine and layers a template scanner, live slider UI, kerning, and
alternate-glyph generation on top.

## Run it locally

```bash
npm install
npm run dev
```

Opens at **http://localhost:4321**. `server.js` is a dev server and nothing
else — it exists only so `public/` is served over `http://` instead of
`file://`, which ES modules and web workers require. It is not deployed.

To stop a background server: `lsof -ti tcp:4321 | xargs kill`.

## How to use

1. Click **Download template PDF**. One sheet covers all 94 keyboard characters,
   marked with four corner registration squares.
2. **Print** it, write one letter per box with a dark pen, and **photograph**
   the whole sheet — flat, evenly lit, all four black corner marks visible.
3. Drop the photo in and click **Process**. The app finds the page by its marks
   and reads each box *by position*, so every letter is labeled automatically,
   multi-part letters (`i j = % ? !`) stay whole, sizes are consistent, and the
   background is ignored entirely. Because it never tries to *recognize* what
   you drew, a sheet of arrows or pictograms works exactly as well as letters.
4. **Shape the typeface** with the live-updating sliders and **download** —
   TTF, WOFF, WOFF2, and a ready-to-use CSS `@font-face` block, in one zip.

**Photos:** JPG / PNG / **HEIC** all work — iPhone HEIC is decoded in the
browser via libheif-wasm. Double-click the `.ttf` to install on macOS.

## Alternates (always on)

Real handwriting never repeats a letter identically — a plain font stamps the
same `t` in "letter" twice, which reads as fake. Font Potato writes an OpenType
`calt` feature so this happens automatically, on by default in browsers, Word,
Figma, InDesign, etc:

- Each letter gets a true default plus **3 alternates**. By default these are
  generated (a gentle domain warp — tilt/size/baseline variation, not
  distortion). Tick **Manual** and upload the same template filled in 1–2 more
  times, and your *actual* second and third versions of each letter are used
  instead.
- A repeated letter (`coffee`, `letter`, `mmm`) visibly varies, while a
  non-repeating letter always renders as your true scanned shape.
- The lookback is 3 characters, so `banana` varies too — not just adjacent
  repeats.

## What maps to what

| Control         | Under the hood                                          |
|-----------------|---------------------------------------------------------|
| Weight          | dilate/erode the binarized ink (−2…+2)                   |
| Width           | horizontal scale of the placed glyph                     |
| Slant           | italic shear on the placed glyph path (± degrees)        |
| Edge Smoothness | potrace `alphaMax` (corner rounding)                     |

All of these rebuild from the already-traced letters — no re-scan needed. Glyphs
are placed against the template's **baseline**, so a small letter stays small
and a descending swash capital keeps its descender. Kerning pairs are measured
from the actual ink and written as a legacy `kern` table, which browsers apply,
so the preview shows the spacing the real font will have.

## Project layout

```
public/                   ← this directory IS the deployed site
public/index.html         the whole UI
public/app.js             UI wiring; imports the engine below
public/engine/            the pipeline, as plain ES modules
  scan-controller.js       talks to the scan worker
  templatescan.js          marker detection + per-cell rectification
  templategeo.js           shared template geometry (mirrors lib/templategeo.js)
  fontbuild.js             trace + variant caches, orchestrates a build
  place.js                 baseline-anchored glyph placement
  variants.js              alternate-glyph generation
  assemble.js              opentype.js assembly + GSUB calt
  kern.js                  kern table + sfnt checksum repair
  pack.js                  TTF→WOFF/WOFF2, zip writer
  collect.js               the only outbound calls: Supabase
  vendor*.js|mjs           prebuilt bundles (npm run build:all), committed

lib/templategeo.js        template geometry, shared with the PDF generator
lib/template.js           printable template PDF
build/                    the build scripts that produce public/engine/vendor*
server.js                 local dev server only
```

**After changing `lib/templategeo.js`, run `npm run build:template`** and mirror
the change into `public/engine/templategeo.js`. The printed sheet and the
scanner read the same geometry; if they disagree, nothing scans.

## Deploying

Static hosting, no build step, no server, no environment variables. On Vercel
the settings in `vercel.json` are all it needs: output directory `public`, no
build and no install command. The prebuilt bundles and the template PDF are
committed, so a deploy is a file copy.

Mailing-list signups, contact messages and opt-in samples go straight from the
browser to Supabase (`public/engine/collect.js`). The key in that file is the
*publishable* key and is meant to be public: every table has an INSERT policy
and deliberately no SELECT policy, so it can add a row but cannot read anything
back out.

## License

GPL-2.0-or-later — see [LICENSE](LICENSE). This project links
[potrace](https://www.npmjs.com/package/potrace) (GPL-2.0) via `draw-your-font`,
so the combined work is GPL. GPL permits commercial use; it does not require a
hosted version of this app to publish server-side changes (that's the stricter
AGPL), but any distributed copy or fork must remain GPL and include source.
