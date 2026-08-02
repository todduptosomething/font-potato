# 🥔 Font Potato

Turn a photo of your handwriting into a real, installable font — with live
sliders for **weight, smoothness, slant, spacing, and detail**, always-on
**alternate glyphs** so repeated letters don't look like identical stamps, and
a marker-based template so every letter is read by position instead of guessed.
Everything currently runs on your own machine; your photo never leaves it.

It wraps the [`draw-your-font`](https://github.com/danilo-znamerovszkij/draw-your-font)
engine and layers a template scanner, live slider UI, and alternate-glyph
generation on top.

## Run it

```bash
npm install
npm start          # or: PORT=5000 npm start
```

Opens the studio at **http://localhost:4321**. Working files and logs live in
`workdirs/` next to the app (gitignored, safe to delete) unless `DYF_DATA_DIR`
points somewhere else.

To stop a background server: `lsof -ti tcp:4321 | xargs kill`.

## How to use

1. Click **Download template PDF**. One sheet covers all 94 keyboard characters,
   marked with four corner registration squares.
2. **Print** it, write one letter per box with a dark pen, and **photograph**
   the whole sheet — flat, evenly lit, all four black corner marks visible.
3. Drop the photo in and click **Read template**. The app finds the page by its
   marks and reads each box *by position*, so every letter is labeled
   automatically, multi-part letters (`i j = % ? !`) stay whole, sizes are
   consistent, and the background is ignored entirely.
4. **Shape the typeface** with the live-updating sliders and **download** —
   TTF, WOFF, WOFF2, and a ready-to-use CSS `@font-face` block.

**Photos:** JPG / PNG / **HEIC** all work — iPhone HEIC is converted
automatically. Double-click the `.ttf` to install on macOS.

## Alternates (always on)

Real handwriting never repeats a letter identically — a plain font stamps the
same `t` in "letter" twice, which reads as fake. Font Potato writes an OpenType
`calt` feature so this happens automatically, on by default in browsers, Word,
Figma, InDesign, etc:

- Each letter gets a true default plus **3 procedurally re-written alternates**
  (gentle tilt/size/baseline variation — not distortion).
- A run cascades `default → alt1 → alt2 → alt3 → default …`, so a *repeated*
  letter (`coffee`, `letter`, `mmm`) visibly varies, while a **non-repeating
  letter always renders as your true scanned shape** — the calt rule only fires
  on an actual adjacent repeat.
- Non-adjacent repeats (the separated `a`s in "banana") render identically —
  matching those too would need a lookback window plain OpenType GSUB doesn't
  support.

## What maps to what

| Control    | Under the hood                                              |
|------------|--------------------------------------------------------------|
| Weight     | dilate/erode the binarized ink (−2…+2)                        |
| Smoothness | potrace `alphaMax` (corner rounding, 0…2)                     |
| Detail     | potrace `turdSize` + `optTolerance`, plus gap-fill at low end |
| Slant      | italic shear on the placed glyph path (± degrees)             |
| Spacing    | extra room split on both sides of each letter (± em units)    |

All of these rebuild instantly from the scanned letters — no re-scan needed.

## Optional: auto-label with Claude

Manual labeling always works with zero setup. If you'd rather have Claude read
the letters for you, set `ANTHROPIC_API_KEY` before starting the server:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start
```

An **✨ Auto-label with Claude** button then appears after scanning. It sends
only the numbered contact sheet to the Anthropic API (this is the one step
that leaves your machine, and only if you enable it). Override the model with
`DYF_LABEL_MODEL` (default `claude-sonnet-5`).

## Opt-in gallery

Users can opt in to have a sample sentence in their font — never the font file
or the uploaded photo — saved to `specimens/` for the public gallery. Sentences
are picked at random from a funny potato-themed set in `lib/specimen.js`.

## Project layout

```
server.js              Express server + API
lib/templatescan.js     marker detection + per-cell photo rectification
lib/templategeo.js      shared template geometry (generator + scanner read this)
lib/fontbuild.js        builds the font from crops + labels
lib/variants.js          procedural alternate-glyph generation
lib/assemble2.js         opentype.js TTF assembly + GSUB calt
lib/specimen.js          HarfBuzz-shaped specimen rendering for the gallery
lib/autolabel.js         optional Claude vision labeling
public/                 index.html + app.js + style.css (vanilla, no build step)
```

## License

GPL-2.0-or-later — see [LICENSE](LICENSE). This project links
[potrace](https://www.npmjs.com/package/potrace) (GPL-2.0) via `draw-your-font`,
so the combined work is GPL. GPL permits commercial use; it does not require a
hosted version of this app to publish server-side changes (that's the stricter
AGPL), but any distributed copy or fork must remain GPL and include source.
