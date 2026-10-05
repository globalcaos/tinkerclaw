---
name: sharepoint-download
description: "Download an Office file (pptx, docx, xlsx, pdf) from SharePoint Online from the shell, riding the Chrome session you are already signed in with. When the file is view-only (download blocked), rebuild an editable pptx from the web viewer's own slide model: native text, shapes, fills and tables, with pictures cropped from the viewer's render. No browser tab, no clicks, no AI in the loop. Use when the user asks to download, fetch or get a file from SharePoint or OneDrive for Business, or to get an editable copy of a view-only PowerPoint they can open. Linux + Google Chrome."
metadata:
  openclaw:
    emoji: "📥"
    os: ["linux"]
    requires:
      bins: ["python3", "node", "curl", "file"]
    notes:
      security: "Reads the SharePoint auth cookies (FedAuth, rtFa, SPOIDCRL) from your local Chrome profile, decrypts them with the Chrome Safe Storage key from your unlocked GNOME keyring, and writes them to a mode-0600 cookie jar (default /tmp/cj.txt). Requests go only to the SharePoint site you name and the Office Online host that site hands back. Nothing else is contacted. The jar is a live session: delete it when you are done."
---

# SharePoint download, with a rebuild for view-only files

**What this command does.** Try the download first. `GetFileById/$value`
returns the original when the file allows it (a process-map deck did: 1.5 MB,
a real pptx). When it answers 403, the file is restricted, and the command
rebuilds a copy from the web model instead. The rebuild is the fallback, not
the job. It has to work for any Office file, so nothing in it is specific to
one tenant, site or deck. The rebuild covers PowerPoint only: the Word and
Excel viewers refuse the same call (see Stage C).

**Provenance.** Built 2026-09-22 against a view-only 53-slide KPI deck on a
company tenant (`RestrictedWebViewOnly: true`, `blocksDownload: true`).
**Owner requirements (2026-09-22):** programmatic, no AI, no images in the
output where the model has the real thing, no clicks, no shared tabs.
Output = reconstructed pptx (+ pdf if you convert it).
**What would change it:** Microsoft moving the getitems protocol or the
OutlineHtml field. Re-run the Stage B probe first.

Text, tables, notes and comments come from OutlineHtml. Positions, fills and
per-run text colours come from the slide JSON (`AcceptTypes: application/json`),
not from the HTML. Charts as native charts are in neither channel.

## Use it responsibly

A view-only flag is a decision the file's owner or your organisation made.
The rebuild only uses what the viewer already shows you, but it produces an
editable copy the flag was meant to prevent. Run it on files you are allowed
to copy: your own, or with the owner's or your organisation's permission.
When in doubt, ask the file's owner for a download instead.

## The command

```
bin/get.sh <site> <driveId> <itemId> <outfile>
```

| Parameter | Example                                        | Notes                               |
| --------- | ---------------------------------------------- | ----------------------------------- |
| `site`    | `https://<tenant>.sharepoint.com/sites/<site>` | the site that holds the library     |
| `driveId` | `b!AbC...`                                     | the document library's drive id     |
| `itemId`  | `01ABCDEF...`                                  | the file's id in that drive         |
| `outfile` | `./deck.pptx`                                  | where the original or the copy goes |

Prints `original <outfile>` when the bytes came from SharePoint, `copy
<outfile>` when they were rebuilt (plus `work <dir>` with the raw harvest).
The comparison loop (Stage D) is a separate tool and is not called by `get.sh`.

**Finding the two ids.** Open the file in the web viewer with the browser's
network panel open. The viewer calls
`/_api/v2.0/drives/<driveId>/items/<itemId>?...`; copy both ids from that URL.

**Environment.**

| Variable                | Default                   | What                                                                                                              |
| ----------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `SP_COOKIE_JAR`         | `/tmp/cj.txt`             | cookie jar path, read by every script                                                                             |
| `SP_CHROME_PROFILE`     | `auto`                    | Chrome profile for `cookie_jar.py`; `auto` = most recently used for SharePoint                                    |
| `SP_COOKIE_FILTER`      | `sharepoint`              | cookie host filter; keep `sharepoint` so the tenant cookies and the `.sharepoint.com` rtFa cookie are both caught |
| `CHROME_CONFIG_DIR`     | `~/.config/google-chrome` | Chromium: `~/.config/chromium`                                                                                    |
| `SP_KEYRING_ITEM`       | `Chrome Safe Storage`     | Chromium: `Chromium Safe Storage`                                                                                 |
| `SP_KEYRING_COLLECTION` | `Login`                   | searched first; other unlocked collections after                                                                  |
| `DECK_JSON`             | `/tmp/deck.json`          | slide count source for `fetch_slide_json.mjs`                                                                     |
| `REF_PNG_DIR`           | unset                     | alternative folder of `sldN.png` renders for `build_model.py`                                                     |
| `TRANSCRIBED_CHARTS`    | unset                     | opt-in chart numbers, see `charts.example.json`                                                                   |
| `CHART_LANG`            | `en-US`                   | chart language and number-format locale when a spec sets none                                                     |
| `SP_FONTS_DIR`          | `bin/fonts`               | where the bundled fonts live                                                                                      |

## Setup (once)

```bash
pip install pycryptodome secretstorage python-pptx lxml pillow numpy opencv-python-headless fonttools pymupdf
node --version   # 20 or newer (global fetch and crypto)
# optional, for pdf output and the appearance loop:
sudo apt install libreoffice-impress poppler-utils
```

Sign in to SharePoint once in Chrome. Keep the GNOME keyring unlocked (it is,
in a normal desktop session).

## Pipeline (all shell, all deterministic)

```
A. bin/cookie_jar.py        -> $SP_COOKIE_JAR  (Chrome store decrypt: FedAuth+rtFa+SPOIDCRL)
B. bin/gi-harvest.mjs       -> deck.json       (mint WOPI token; getitems text+tables+notes)
   bin/fetch_slide_json.mjs -> sldjson/ + renders/  (slide model JSON + viewer render per slide)
C. bin/build_model.py       -> out.pptx + out.fonts/  (soffice --convert-to pdf if you want a pdf)
D. (validation only) bin/appearance_loop.py original.png rebuilt.png
```

### Stage A — auth without the browser (no shared tab, no clicks)

1. `python3 bin/cookie_jar.py auto sharepoint /tmp/cj.txt`
   - Keyring secret via secretstorage ("Chrome Safe Storage").
   - Chromium >=130 layout: `v10 || sha256(host)[:16] || AES-CBC(value)`; PBKDF2
     key, salt `saltysalt`, 16 B, 1 iteration. Strip control chars, then the
     16-byte hash block (the value becomes clean base64).
   - FedAuth contains a literal TAB that MUST be stripped or IIS answers 400
     "invalid header name". SPOIDCRL must be in the jar or auth is 401/403.
   - The jar may hold several tenants. curl picks cookies by domain; the node
     scripts send only the cookies whose domain matches the site host.
2. Verify: `curl -b /tmp/cj.txt '<site>/_api/web?$select=Title'` → must be 200.
3. Pick the live profile. `auto` takes the profile whose SharePoint cookies were
   used last. By hand: the profile with a fresh `WacDataCenterSetTime` cookie is
   the live one (`Default` may be stale).

### Stage B — mint + harvest (bin/gi-harvest.mjs)

1. Mint: GET `<site>/_api/v2.0/drives/<driveId>/items/<itemId>?$select=name,size,eTag,currentUserRole,openWith&alias=xx&action=view`
   with cookies + headers `Application: WebPowerPoint`, `Scenario: RefreshWopiToken`,
   Chrome UA. Returns `openWith.wac` = {accessToken (~1.5 KB), accessTokenExpiry,
   wopiSrc, applicationUrl, fileGetUrl, fileUrlNoAuth, downloadCode} and
   `currentUserRole` ({allowEdit:false, blocksDownload:true, readOnly:true}).
2. getitems POST `<appUrl-origin>/pods/getitems.ashx?usid=<any-uuid>`.
   The exact request shape is encoded in gi-harvest.mjs. Item vocabulary
   (complete — other IDs return "not found"): `presinfo/metadata`,
   `presinfo/slimSlideOrder`, `pres/sldIdxN` (image or JSON, see below),
   `pres/NotesSldIdxN` (text), `pres/CommentsSldIdxN`,
   `pres/SlideMetadatasldIdxN` (**contains OutlineHtml — the raw text slice**).
3. `OutlineHtml` carries: title, paragraphs, bullets, **full tables** (all cell
   values + `<col width=N>` / `<tr height=N>` in pt), links, notes block.
4. Per-element requests (slide N only, or notes only) are one call, ~1–2 s.
   Full deck text harvest: ~12 s for 53 slides. Batch ≤5 slides per request
   (413 otherwise).
5. `fetch_slide_json.mjs` asks `pres/sldIdxN` twice: once as
   `application/json` (the shape model) and once as `image/png` (the render,
   saved to `renders/sldN.png`). The slide count comes from `DECK_JSON`; without
   it the script asks `presinfo/metadata`. A hard-coded count once stopped every
   deck at the first test deck's length.

### Stage C — reconstruct (bin/build_model.py, 2026-09-23)

The builder reads one directory: `deck.json`, `sldjson/sldN.json`, and
`renders/sldN.png`. Text is decoded from the model's glyph ids, aligned to
OutlineHtml. Each line uses the model's own break, x and baseline. `[Table]`
frames are native tables; their fills and rules are measured by
`table_style.py` and written as numbers. Pictures — logos, photos, and graphs
pasted as pictures — are cropped from `renders/` at that picture's own box,
with the slide's text inpainted out first. The raw has no image bytes.

A graph that is a picture in the source stays a picture. A chart object, if
one is ever in the model, is a native chart. `TRANSCRIBED_CHARTS=<json>` opts
into charts drawn from numbers typed off a render (format:
`charts.example.json`). That is off by default and is not a decode.

The viewer draws text in Segoe UI and Noto Sans. `build_model.py` writes
those faces to `<out>.fonts/`, so the copy looks right on a machine without
them: Noto Sans is the real font (bundled, OFL) with the viewer's glyphs laid
over it; Segoe UI is rebuilt from only the glyphs the viewer drew for this
document. Segoe UI is Microsoft's and not redistributable, so keep
`<out>.fonts/` with the document and do not publish it.

LibreOffice places a fixed-pitch line's baseline at pitch − 0.2 em from the
line top, font-independent (measured 2026-09-23). Baselines are placed with
that rule.

docx and xlsx that download (HTTP 200) are the original package. Repack them
with `decrypt.sh docx|xlsx` (`ooxml_repack.py`): every part reachable from the
root relationships is kept and re-parsed, the `[trash]/` folder Office leaves
behind is dropped. Do not aim the PowerPoint getitems call at them: Word
answers 403 HTML, Excel says the path is not supported (measured 2026-09-23).
`decrypt.sh pdf` copies a PDF's pages and drops attachments and scripts.

`build_pptx.py` is the first, text-only builder (deck.json only: titles,
bullets, real tables, notes; no positions or colours). It stays as a
low-fidelity fallback when no slide JSON could be fetched, and
`build_model.py` uses its outline-text helper.

### Stage D — appearance feedback loop (required, not optional)

The owner, 2026-09-22: compare the rebuilt deck with the original appearance
(the viewer renders) and use the markup between the text. Do this every
rebuild, not once.

Loop: render the rebuild (`soffice --convert-to pdf` + `pdftoppm -png -r 75`, 1000 px across a 16:9 slide),
then `python3 bin/appearance_loop.py renders/sldN.png rebuilt-N.png`.
A pixel score is not the reward (white space inflates it). The reward is a
look: same elements, same text, same colours, positions close enough.
2026-09-22 slide 2, after three failed stops:

- Doubled text was a picture crop of the original words plus a text box.
  Skip any `spLst` crop whose box covers a text shape.
- Black digits were the list painted from the wrong shape. Colour runs
  (`spr[].range.len` + `fillBrsh.Item.clr`) live on the shape whose
  paragraph count matches the line count. Zip every run, not only the last.
- The list then overlapped the banner. Cap the list box above the banner top.
  Banner corners were still square at that point. Say that; do not call a slide
  identical when it is not.

What the markup between the text actually contains (counted on the 53-slide
deck): `style` is only `direction`, `text-align`, `visibility:hidden`, and
**table** `width`/`height` in **pt**. Zero `color`, zero `background`, zero
`font-size`, zero x/y for text boxes. Coloured KPI text and chart colours live
only in the slide JSON and the pixels.

## How a slide is encoded (reference)

**The rest of the model was hiding behind AcceptTypes (2026-09-22).**
`pres/sldIdxN` with `AcceptTypes: ["application/json"]` (not `image/png`)
returns ~75 KB of slide JSON, not a picture: `appThm.clrSchm` (RGB accents),
`bg`, `viewSize`, and `sbLst` — shape paths in EMU plus per-glyph positions and
font. That is the geometry/colour channel.

**One record, three lists.** `sbLst` is the shapes: `xfrm` is centre plus
half-size in EMU, `pthLst` arcs (`;A;`) mean rounded, `style.fillBrsh` is the
fill, `outlnBrsh` + `lnWdth` the outline, `tl.p[].spr` is a text run (range
length plus RGB). `spLst` is pictures: `pos` and `reg.w/h` in the 1000 px view,
and the bytes are not in the JSON, only a crop of the render. `OutlineHtml` is
the characters and the tables (cells, column widths in pt, row heights in pt),
in reading order, not in shape order.

**Geometry, confirmed against a downloadable file (2026-09-22).** The real pptx
and the web model of the same slide were compared shape by shape.
`xfrm.t` minus `abs(xfrm.pt)` is the OOXML top-left, and `abs(pt)*2` is the
size. 24 of 24 shapes matched with offset 0. A paragraph's run length is the
character count of that line in the real text (an 11-letter word has run
length 11).

**Text is glyph ids, not characters.** Lines are either a `c` array (glyph
ids, EMU offsets, a px box per character) or a compact `s.v` string
`gidL<left>R<right>;WL..R..` (W = space). ASCII glyph ids 3..97 follow the
standard Macintosh glyph order in every face seen so far; `wac_model.py` learns
the rest by aligning each paragraph's glyph run with the slide's OutlineHtml,
and matches glyph outlines (`glyps`, 4096 units/em) against Noto Sans for
glyphs the outline never shows. Size is `gspr.s.y` (EMU), colour is
`spr[].style.fillBrsh.Item.clr`, underline is `stkspr`, face is `fipr`.

**Pictures (2026-09-22):** `spLst[].reg.imgID` names every embedded image and
`spLst[].pos` plus `reg.w/h` are its box in the 1000×563 view. The bytes are
not in the JSON (only a 1×1 gif placeholder) and are not a getitems item id
(`<imgID>`, `pres/sldIdx0/<imgID>` → ErrorInvalidItem). A crop is upscaled 3×
with Lanczos before embedding: measured over the deck, 1× 0.9003, 2× 0.9095,
3× 0.9103, 4× 0.9103 — 3× is the knee.

**Font tuple.** A text run's font is the tuple `(Segoe UI,1,34,...)`: family
first. The third number (34) is the same on every shape and is not a point
size — do not use it as one.

## Lessons from the first builder (2026-09-22)

The first builder (outline text poured into the model's shapes, not shipped
here) taught these. `build_model.py` decodes the glyphs instead, but the rules
still hold when you debug a slide.

- **Which text goes in which box.** Walk `sbLst` in order and give each shape
  the next outline lines, one per paragraph whose run length is not 0 (a run
  length of 0 is a blank the outline does not carry). Do not re-sort shapes by
  x/y (that scrambled cards) and do not match lines to boxes by guessing which
  words are dates. When a line's length does not equal the run length, the
  outline order and the shape order have diverged, and no re-sorting fixes it
  without the characters.
- **Text stays inside the box.** The overflow was the builder widening every
  text box to 6000000 EMU and adding 12 pt after each line. The shape's own
  `xfrm` is the box. `tl.ltfxfrm.t` is an inset in EMU; on a small card it can
  consume the box. Do not grow the box to fit the text, and do not shrink it to
  hide overflow (the owner, 2026-09-22: that put the words outside their shapes).
- **One item, one shape.** Never concatenate two items into one shape, and
  never split one item across two shapes. A date-and-revision caption under a
  card is its own small grey text, not part of the card; its slot's right edge
  meets the card, so it is right-aligned.
- **Flat shapes.** python-pptx injects `p:style/effectRef idx=2` (a theme
  shadow). Delete it; the model's shapes are flat.
- **Typeface width.** WAC reports Segoe UI where the source used Calibri.
  Calibri is ~13 % narrower, so a heading sized from the model needs ×1.12 to
  hit the laid-out width `l.fb.r`. Check each line against `l.fb.r` rather
  than scaling blindly: some lines already match unscaled.
- **No fill plus an outline is a white card.** Ink follows the shape's own
  text-run colour, not a guess from the fill.
- **Hyperlinks.** A run in the link colour is a hyperlink: display text only,
  no `[url]` suffix. Pin its `a:srgbClr` AFTER setting the hyperlink, or the
  theme's hlink colour wins. A wide, short box at the bottom of a slide is a
  link, not a title.
- **Alignment order.** Set text first, then `PP_ALIGN.CENTER`; assigning
  `p.text` after alignment clears it.
- **One native object, never a screenshot of it.** A table is an `a:tbl` once:
  match outline tables first, drop the table's picture crop, and put the native
  table in that box. Logos, title bars, photographs and UI screenshots (a web
  page, a CRM view, a spreadsheet, a document library, an infographic) stay
  pictures. A picture crop that covers a text shape is the words already drawn,
  so skip it.
- **Table row height.** Outline widths and heights are points (1 pt = 12700
  EMU). PowerPoint adds cell padding, so the row height that matched the
  original was about 0.6 of the outline's value. `build_model.py` now takes the
  rows as drawn in the render when it can find them.
- **Chart look (opt-in path).** Axis labels 8 pt, `#,##0` on the value axis,
  legend at the top, scale from 0; a dated series uses `c:dateAx` with
  `dd/mm/yyyy` labels rotated −45°.

## Pre-cookie probe history (kept for depth, superseded by A–D)

- REST `$value`, download.aspx (+DownloadCode / X-SPOPacToken / as-query),
  v2.0 content, versions/1.0, OpenBinaryStream, getpreview.ashx, mediap
  transform, `wopi.ashx/contents` → all blocked/500 on restricted files
  (the binary wall is by design).
- Search API `HitHighlightedSummary` leaks ~1.8 KB of indexed text per query —
  a keyword verification channel only.
- The viewer's IndexedDB cache (`PowerPointDocument` DB, AES-GCM, PBKDF2 1k
  iterations, salt `PowerPointEuplCacheSalt`, key = DriveItemId) holds the
  first-slide JPEG + slideCount.
- Browser-relay quirks (if a browser IS in the loop): `act` needs the raw
  DevTools GUID in BOTH the top level and `request.targetId`; a page→localhost
  POST kills the exec context; a synthetic `a.click()` is blocked, relay
  clickCoords is trusted; Chrome `prompt_for_download: true` needs a human Save
  click (the reason the shell route exists). `bin/gi-probe.mjs` is the debug
  probe from that era; it reads its auth material from a `GI_CFG` file.

## Failures overcome

- getitems 500 = wrong request shape (Source must be an object; Client PPTSXS;
  X-UserSessionId = the usid you chose; no ESS/cluster headers; Options as a
  JSON string).
- getitems 413 = batch too big (≤5 slides of text, 1 image).
- Slide images come back as WebP despite `AcceptTypes: image/png` (RIFF header).
- curl 400 "invalid header name" = a control char inside a cookie value.
- curl 401/403 with clean FedAuth+rtFa = SPOIDCRL missing from the jar, or a
  stale profile.
- python-pptx rejects EMU > 51206400 — set the slide size to the standard
  12192000×6858000, not px×9525.
- A space cell often falls outside every size/colour range; left alone it
  became its own run at the default size (a wide gap mid-sentence). It now
  takes the size and colour of the nearest sized run.
- A table style id left empty lets the renderer draw its own default grid.
  `build_model.py` pins "No Style, No Grid" and draws only measured rules.

## Files

| File                                                                      | Role                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `bin/get.sh`                                                              | the command: original download, else rebuild                           |
| `bin/cookie_jar.py`                                                       | Stage A: Chrome cookie store → Netscape jar (0600)                     |
| `bin/gi-harvest.mjs`                                                      | Stage B: mint WOPI token, harvest OutlineHtml + notes → deck.json      |
| `bin/fetch_slide_json.mjs`                                                | Stage B: slide model JSON + viewer render per slide                    |
| `bin/build_model.py`                                                      | Stage C: the builder                                                   |
| `bin/wac_model.py`                                                        | reads the slide model: glyphs → text, faces → fonts                    |
| `bin/table_style.py`                                                      | a table's fills, rules, weight and alignment, measured from the render |
| `bin/chart_look.py`                                                       | native charts for `TRANSCRIBED_CHARTS`                                 |
| `bin/ncc.py`                                                              | template matching that ignores blank windows                           |
| `bin/build_pptx.py`                                                       | first text-only builder; outline parser                                |
| `bin/appearance_loop.py`                                                  | Stage D: pixel diff + missing colours                                  |
| `bin/decrypt.sh`, `bin/decrypt_{docx,xlsx,pdf}.py`, `bin/ooxml_repack.py` | clean repack of files already on disk, no network                      |
| `bin/gi-probe.mjs`                                                        | getitems debug probe                                                   |
| `bin/fonts/`                                                              | Noto Sans + Carlito, with their licences                               |
| `charts.example.json`                                                     | format of a `TRANSCRIBED_CHARTS` file (invented numbers)               |

## Third-party

`bin/fonts/` holds unmodified Noto Sans 2.015 (© The Noto Project Authors) and
Carlito 1.103 (© tyPoland Lukasz Dziedzic, Reserved Font Name "Carlito"), both
under the SIL Open Font License 1.1. The licence texts are
`bin/fonts/OFL-NotoSans.txt` and `bin/fonts/OFL-Carlito.txt` and must travel
with the fonts. See `bin/fonts/README.md` to use system copies instead.
