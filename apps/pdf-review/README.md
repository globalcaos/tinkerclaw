# pdf-review

Edit a document with your agent the way an editor edits paper. The agent builds a PDF from a markdown
draft; you read it, highlight words and write notes next to them; one press of **↻ Apply comments**
wakes the chat that built it, the agent applies every note to the markdown, and the same PDF reloads in
the open window. No more "the second paragraph under the heading, the sentence that starts with…".

Viewer: Mozilla pdf.js 6.3.289 (Apache-2.0), vendored in `viewer/`, served on loopback by `server.py`.
Inside TinkerClaw it is reached through the Tinker UI at `/pdf/` (`scripts/tinker-prod-ui.mjs`), on a
desktop and in the phone app's reader.

## Install

```bash
cd apps/pdf-review
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
mkdir -p ~/.config/systemd/user ~/.local/state
cp pdf-review.service ~/.config/systemd/user/ && systemctl --user enable --now pdf-review
```

The unit expects the repository at `~/src/tinkerclaw`; edit its two paths if yours is elsewhere.
`md2pdf.py` renders with headless Chrome or Chromium, so one of them must be installed. Read aloud
uses `piper-tts`; leave it out of the venv if you don't want the voice.

To hand out links that open from another device (phone, laptop on your tailnet), put the address of
Tinker's `/pdf` proxy as that device sees it in `~/.config/pdf-review/door`, e.g.
`http://100.x.y.z:18793/pdf`. Without it, links point at this machine's Tinker.

## Use

1. The agent writes `<name>.md` and builds it: `apps/pdf-review/md2pdf.py <name>.md <name>.pdf`.
   It prints the review link and registers the chat that built it (from `TC_SESSION_KEY`), which is
   what makes **↻ Apply comments** appear. `open-pdf --link <file.pdf>` does the same for any PDF.
2. Mark it up: select text, click **Highlight**, then the speech bubble to add a comment; the **T**
   tool drops a free-text note anywhere. Marks save themselves as you type.
3. Press **↻ Apply comments**. The agent reads them with `pdf-comments.py <file.pdf>` (page, quoted
   words, note), edits the `.md`, and rebuilds over the same PDF, which reloads in your window.
   New or changed text goes in `<span class="nw">` or `<div class="nw" markdown="1">` and prints
   light blue (`#1e90ff`). It stays blue until you approve it (step 5): an agent never takes an
   earlier round's marker off. Check it in the built PDF: `pdf-colours.py <file.pdf>` prints the share
   of text in that colour. A `pdftotext` hit proves the words are there, not their colour (2026-11-14:
   every paragraph had its own grey, so marked text printed grey; test `test/new-text-colour.py`).
   While the agent works (2026-11-15), the comments it took are locked: their icon turns into the
   Apply button's robot, their card opens to be read but has no Edit or Delete, and a tap on the
   marking only says it is being applied. No delete, colour change or undo reaches them, on the laptop
   or the phone. A comment you make meanwhile is not in this round and stays free. The lock ends when
   the rebuilt PDF opens, or at once if the chat could not be woken. The comment box also has
   **Apply**, between Cancel and Done: it saves that comment and starts the same Apply. Code:
   `tools.js` (`applyLock`), `autoreload.js` (`redo`, `applyDone`). Test: `node test/apply-lock.mjs`
   (and `MODE=phone`).
4. Wording you can fix yourself: **✏️ Write**, tap a paragraph and type in it, on the page. The PDF catches up
   by itself.
5. Read a blue paragraph, then press **✓ Approve** at its end: it prints black from then on.
   In **🕘 Recent** a file whose blue text still waits for approval shows its name in that blue.

Runtime data stays beside the code and out of git: `papers/` (links to the PDFs being served) and
`state/` (bookmarks, which chat owns which PDF, history).

## Read aloud

**▶ Read** in the toolbar speaks the paper with an offline voice, highlights the sentence it
is on and turns the pages. It starts from the text you selected (even while it is reading), else your
saved place if you are on that page, else the top of the page. Selecting text also puts a ▶ in the
little toolbar under it, next to Comment and Highlight. Turn the page while it reads and it carries
on from there. Speed (0.8× to 2×) and voice sit in the ⚙ reading-settings pop-up (no save button; a pick applies at once). Every toolbar button is an icon only (2026-11-10), with its words as the tooltip; the media keys pause and play.
**Space** does the same as ▶ Read anywhere in the document (not while typing in a field or comment).

**⏮ and ⏭ either side of ▶** (2026-11-14) move the reading by whole paragraphs, always to a paragraph's
first sentence (a title counts as a paragraph; a paragraph cut by a page break is one paragraph). ⏭ goes to the
next one. ⏮ goes to the start of the paragraph being read; pressed on its first sentence it goes to the one
before, like a player's back key. While it reads, the voice goes on from the new place; paused or not
started, only the place moves (the highlight and the page follow) and ▶ Read starts there. Inside the
phone app, while the app is the one reading, the two buttons send `readCtl("prev"/"next")` to it, the same
as the headset keys. The code is `skip()` in `viewer/web/reader.js`; a paragraph ends at the list entry that carries `pause`.

Inside the phone app (2026-11-12) the app does the reading, not the page: the page hands over the reading
list from the current sentence to the end of the document (`JarvisNative.readQueue` / `readAppend`) and the
app speaks it from its own service, so it goes on with the screen locked. Headset buttons: play/pause, and
next/previous jump a paragraph. The media notification and the cover-screen panel (Galaxy Z Flip: Settings >
Cover screen > Widgets > TinkerClaw reader) add slower and faster. The page follows the app's position events
(`{ev:"reader"}`): it highlights, turns the page and saves the place when it is awake, and asks for the place
when it wakes. `test/reader-native.mjs` checks the page's half with a stand-in bridge.

On a phone held sideways the toolbar is a rail on the right edge; with the dark look the pages are dark too, and a picture keeps its own colours (the dark veil has a hole over each picture; `node test/dark-pictures.mjs`).

Reading order runs down the main column. A margin note (a narrow column beside the text) is read
after the paragraph next to it; if that paragraph runs on overleaf, the note waits until it ends
there. A sentence cut by the page break is read whole, in the text and in the notes, and the page
turns about when the voice reaches the break.

Running headers, footers and page numbers are skipped, but only when they really are: a line near the
top or bottom edge is read unless it holds a page number or repeats, digits aside, on a nearby page.

Pauses follow the layout. Between sentences it leaves the voice's own silence (~0.85 s), at the end
of a paragraph 1.5× that, after a title 2 s; all three shrink with the speed. A title (a bigger line,
a whole line in bold, or a bold run-in head) is read and highlighted on its own. A paragraph ends at
a blank gap, before a first-line indent, or at a short last line ending a sentence.

**↻ p.N** is your saved place: the exact sentence, saved after every sentence it reads. It is kept
in `state/bookmarks.json` by document ID and by file name, so a rebuilt paper (new ID, text moved)
still finds the sentence by searching near the old page. Reopening a file with a saved place goes to
that page and marks the next sentence to read; ▶ Read starts there.

The default voice is Kokoro-82M (`kokoro:af_heart`; six Kokoro voices in `KOKORO_VOICES`), run by the
PyTorch `kokoro` package on the GPU, which reads with far better intonation than Piper. Piper voices are
still listed: the `.onnx` files in `~/.local/share/piper-voices`; drop another one there and it shows up.

## Auto-reload

When the open PDF changes on disk (a rebuild after Redo), the viewer reopens it by itself on the same
page and scroll position, **never asking** (2026-10-16). A save in progress is waited for, and a queued
save is cancelled so it cannot write the old document over the new file. Only files served from here
are watched, not a PDF opened with the Open button or dropped on the page.

Marks **save themselves** over the original file, two seconds after each edit and when the window
closes, with no prompt; a small "✓ Saved" note confirms each write. There are no Save buttons (removed
2026-10-16: saving is automatic); Ctrl+S still forces a save. The server follows the `papers/` link to
the real file and replaces it atomically; it refuses anything outside `papers/` and any body that is
not a PDF. Its own save does not trigger a reload. **📂 Folder** opens the file manager on the real
file, selected, to move, rename or copy it (`POST /api/reveal`). Test: `node test/autoreload.mjs A.pdf B.pdf`.

**✏️ Write** (2026-11-15; the paragraph picker and its popup of 2026-10-16 before it): shown when a PDF has a
sibling `.md` with the same name, and only inside his own document folders (2026-11-14, `BUILD_ROOTS`:
`~/Documents`; a test server uses its `PDF_REVIEW_OPEN_ROOTS`, or `PDF_REVIEW_BUILD_ROOTS`). A rebuild runs the
folder's `build*.sh`, so a PDF opened from Downloads, a mail attachment or `/tmp` gets no Write and no automatic
rebuild.

Press it, then tap a paragraph: the paragraph itself becomes the editor, in the PDF's own face (served whole from
`/viewer/web/fonts/`), size, colour and line breaks, with the caret where the finger was. Type; Enter starts a new
paragraph (a new item in a list); deleting every word deletes the paragraph. **✓ Done** above the paragraph saves
it and closes it; so do a tap elsewhere on the page, Esc, and Write off. Typing alone saves nothing (each save is
a rebuild on the Pi); the words are kept as a draft until then. A blur (the keyboard closing, another app) saves
but never closes. Text below a paragraph that grows or shrinks moves with it at once (a copy of the printed page,
shifted). A tap on a paragraph cut by a page break edits only the part on that page.

On a phone, while Write is on, the page keeps the zoom it had (2026-11-15). The viewer fits the page to the
screen; the keyboard changes the screen's size (to 922x151 CSS px on his phone held sideways), the fit changed,
pdf.js redrew the page and the editor closed a second after it opened. Write off gives the fit back.

What happens on a save:
1. `viewer/web/mdmap.js` turns the change in the words into a change of the Markdown block: only the characters
   that changed move. `**`, a link's address, a list item's `- ` stay. Typed `*`, `_`, `[` and `<` are escaped. A
   change it cannot place exactly is refused, never guessed. Its proof: the new block must show exactly the
   words typed.
2. `POST /api/paragraph` with `writer: true` checks that proof again with Python-Markdown (422 if it fails, 409
   if the block changed meanwhile), writes the `.md`, adds a line to `state/edit-journal.jsonl` (old and new
   block), and answers at once.
3. The server's Builder rebuilds the PDF in the background: 0.6 s after the file's last edit, one build at a
   time, never two of one file, his marks kept (`--keep-marks`; the previous PDF stays as
   `<name>-before-edit.pdf`). `md2pdf.py` skips PyMuPDF (1.4 s on the Pi) when the PDF holds no marks.
4. The viewer swaps the rebuilt PDF in when it holds every edit typed here (`/api/built` says which version of the
   `.md` the file on disk was built from), never under an open editor, and under a still copy of the page, so
   nothing blinks. While Write is on it waits until no paragraph has been touched for 30 s: a swap reloads the
   whole document, seconds on a phone. Write off swaps at once.

A paragraph is found in the `.md` by its letters, exactly, never by a fuzzy match: in the book, the character
cards, picture prompts and "From here on" lists are printed in the chapter but live elsewhere, and a fuzzy match
sent them to unrelated story paragraphs. Such text gets a note instead of an editor. Words found in more than one
block are told apart by the paragraph printed next to them, or refused. A block mdmap.js declines (a table, a
code block, raw HTML) opens the Markdown box, as before. Bold, italics and links are not typed on the page yet: the
"Md" button that opened the Markdown box from the editor is gone (2026-11-15: on his phone it looked like the way
to save, and the old Markdown card came up on top of everything).

The `.md` is the one source: agents applying comments edit it too. Rebuilds are clean by default, so comments an
agent applied leave the PDF; only his own text edits (the writer, the box, or his editor saving the `.md`)
rebuild with `--keep-marks`. Apply comments drops a flag in `state/applying/` so the Builder leaves that PDF to
the agent's clean rebuild (flag cleared by it, ignored after 30 min). Tests: `node test/mdmap.test.mjs`,
`.venv/bin/python test/writer-server.py`, `node test/writer.mjs` (and `PHONE=1`), `python3 test/marks.py`.
Does it line up on a real document? `node test/writer-align.mjs <its .pdf> [--phone]` (copies it to /tmp).

**An open edit survives a restart** (2026-11-10; the writer too, 2026-11-15): what is in the Edit paragraph box, or typed in a paragraph and not saved yet, is copied to the device on every keystroke and to the server a moment later (`state/edit-drafts.json`, `/api/editdraft`). If the page dies with the box open, the next open of that PDF brings the box back with the same text and the cursor where it was. `pdf-comments.py` prints a waiting edit, so the chat can read what was being typed. Save and Cancel clear both copies. Test: `node test/edit-reopen.mjs`.

## ✓ Approve (2026-11-15)

A paragraph printed blue is new text you have not read yet, and it stays blue until you approve it. The owner,
2026-11-15: *"when a paragraph goes blue, it will never turn black again on its own. Instead, at the end of the
paragraph there will be an approve button, which does so. This way I don't miss a change I have not read."*
Before, each round turned the previous round's blue black, read or not.

Each blue paragraph (or blue list item) gets a small **✓ Approve** right after its last word, quiet and in the
text's own blue: a thin blue outline, no fill, no shadow (made less prominent at 16:03, in the same colour as
the text). It sits under the dark look's veil, so it changes colour with the text there too. Its top sits on the
top of that line, so it hangs into the space under the paragraph and covers no word. Where the last line runs to
the margin it shrinks to a tick in the margin, and where even that does not fit it goes under the line's end. A
paragraph cut by a page break has its button where it ends.

Press it and the button goes at once. As soon as the Pi has the approval (a fraction of a second), the paragraph
turns black on the page: `approve.js` `blacken` paints its blue pixels in the body's grey (#404040) on every canvas
pdf.js drew the page on, inside that paragraph's printed lines only, and does it again after every redraw (a
zoom, a page drawn again). Only the new-text blue changes: over the white page its pixels keep a full blue channel
while red and green fade in step, so grey and brown ink, pictures and highlights stay as they are. The rebuilt PDF,
which prints it black itself, swaps in once no approval has come for 8 s, so a run of approvals is one swap. If the
Pi refuses or does not answer, the button comes back and a note says why. It works in ✏️ Write too, and opens no
editor. A page with a paragraph typed in and not rebuilt yet hides its buttons, because the text under them has
moved.

**✓ Approve all (2026-11-17).** When any blue text waits for approval, an extra Approve all
button sits at the very beginning of the document. While any paragraph prints blue, page 1 shows **✓ Approve all (N)**
in its top margin, above the first printed line (the server sends where that line starts), in the same quiet blue.
N counts down as single paragraphs are approved, and the button goes with the last one. One press sends one
request with every blue paragraph: all buttons go, every paragraph turns black at once, and one rebuild follows. A
note then says *N approved* with a **↶ Undo** for 15 s, so a stray tap never marks a whole chapter as read for good:
Undo puts the `.md` and the approved text back as they were (only if nothing changed them since) and the blue and
the buttons come back. A paragraph that changed meanwhile stays blue with its button, and a note says how many.
(The first version asked for a second press within 4 s; on his phone the first press armed it, he looked for the
change, and nothing had happened.)

The two ways a paragraph prints blue, and what Approve does to each:
- **The `.md` marks it** (`<span class="nw">`, `<div class="nw" markdown="1">`): the marker comes off that
  paragraph only; a wrapping div is closed before it and opened again after it, and one left empty goes.
- **Its build paints what you have not approved**: the book chapters print blue every paragraph or list item
  not in `<folder>/.approved/<name>.md` (`book1/bible/assemble.py` `approved_text`). Approve adds the paragraph
  there and the `.md` stays as it is. Your own edits (✏️ Write, the Markdown box) are added as you save them, so
  your own words never print blue.

`GET /api/approve` finds the blue paragraphs in the PDF itself: span colours by PyMuPDF, each printed line's letters
matched in order to the `.md` blocks, each blue block's printed lines and where the last one ends (about 0.3 s for a chapter, then
kept until the PDF, the `.md` or the approved text changes; on all 22 book chapters every paragraph was found).
Text the `.md` does not hold (character cards, picture prompts) is passed over. `POST /api/approve` answers at once,
journals the approval (`state/approve-journal.jsonl`), and the Builder rebuilds in the background. A paragraph
that changed meanwhile is refused (409) and stays blue. Approve all posts `{items: [...]}`: the paragraphs are
taken from the last to the first in one write and one rebuild, each journaled with `"all": true`, and the answer
names the ones that changed meanwhile (`missed`) and an undo token; `{undo: token}` restores the two texts while
their versions are still the ones the Approve all wrote (else 409). Offline there are no buttons: an approval is made on the Pi.
The viewer code is `viewer/web/approve.js`, loaded so that its absence leaves the page as it was.

**Blue names in 🕘 Recent (2026-11-18).** The Recent list (laptop and phone, and the phone's offline start, which
opens the same list) shows a file's name in the new-text blue `#1e90ff` while its PDF has paragraphs waiting for
✓ Approve, with the count in the row's tooltip ("3 blue paragraphs to approve"); other names stay as they are. The
count is the length of the list the page's own buttons come from (`server.py` `approve_scan`, shared with `GET
/api/approve`), cached per PDF on its mtime and size, the `.md`'s mtime and the approved text's mtime, so the list
and the open page agree. `GET /api/history` adds `blue: n` only where that cache already knows it and never scans;
the list draws first, then asks `GET /api/blue?path=…&path=…` for the rest (about 0.1 s per chapter not scanned yet)
and paints them (`autoreload.js` `blueNames`). An approval or a rebuild changes what the cache is keyed on, so the
last approval turns the name back and a rebuild that adds blue turns it blue at the next list open. With no answer
(offline, a failed scan) the names keep the last counts this device saw (`localStorage` `pdfreview.blue`), or stay as
they are; the list never waits for the scan. `/api/folder` shows no names (it feeds the offline keep), so it carries
no count.

Tests: `.venv/bin/python test/approve-server.py` (both ways, the rebuilt PDF's colours, a list item alone, his own
edit, the 409, the journal, Approve all on both kinds), `node test/approve-all.mjs` and `PHONE=1 node
test/approve-all.mjs` (its place above page 1's first line, the count, one request, all black at once, the Undo note,
Undo bringing the blue and the buttons back, then all black after the rebuild), `MODE=desktop node test/blue-names.mjs` and `MODE=phone node test/blue-names.mjs`
(the blue name in Recent, its count, Approve all turning it back, a rebuild turning one blue, a failed scan, offline),
`node test/approve.mjs` and `PHONE=1 node test/approve.mjs` (placement, the quiet look,
a press turning the paragraph black at once and through a zoom, one swap for two presses, Write), and on a real
document `node test/approve-align.mjs <its .pdf> [--phone]` (copies it to /tmp; checks every button's place and that
it covers no word, Approve all included, then previews every paragraph approved: no blue may be left in their lines, and the darkest
repainted pixel must be the body grey).

## Default PDF app

Since 2026-10-03 this is the desktop's default for `application/pdf`: double-click any PDF and it
opens here, in a Chrome app window (profile Default). `open-pdf` links the file into
`papers/open/<hash of its folder>/` so the server can reach it, and starts the server if it is down.
Your marks save over the original file by themselves; **📂 Folder** shows it in the file manager.
Desktop entry: `pdf-review.desktop`, installed as a copy in `~/.local/share/applications/`.

Evince is still under "Open With". To make it the default again:

    xdg-mime default org.gnome.Evince.desktop application/pdf application/x-pdf

## What changed from stock pdf.js

`viewer/web/viewer.mjs`, three defaults (see `git log`), plus `reader.js`/`reader.css` loaded from `viewer.html`:
- `scrollModeOnLoad` 3: one page at a time;
- `enableComment` true: comments on highlights, and the Comments panel;
- `enableHighlightFloatingButton` true: a Highlight button appears on any text selection.

## Phone (2026-10-21)

Tinker serves this viewer under `/pdf/` (`scripts/tinker-prod-ui.mjs` in tinkerclaw proxies `/pdf/*` to
:18820), so the phone reaches it through the phone door with its device token. `viewer/web/base.js`
works out that prefix from the page URL; every call to the server goes through it, so the same files
serve the desktop (no prefix) and the phone. In Tinker's phone mode a tapped `.pdf` link and the 📄
button in the chat dropdown open the viewer in a full-screen layer over the chat (✕ or Back closes it):
the link through `POST /api/open` (it links the file under `papers/open/`, as `open-pdf` does, and only
from `~/Documents`, `~/Downloads`, `~/Desktop`, `~/Pictures`, `~/src`, `~/.openclaw`), 📄 on the file at
the top of the history. **🕘 Recent** lists every PDF opened with the viewer that still exists, newest
first (`state/history.json`; only links under `papers/` to a PDF inside the folders the viewer may open
count, so the tests' fixtures and a test's file in `/tmp` stay out; `test/history-roots.py`).

**Book tabs (2026-11-19).** Beside Recent the dialog has a tab per kind of book file, **Chapters**, **Notes**,
**Marked**, **Earlier** and **Backups**, each sorted by name with numbers by value (ch2 before ch10, a file before
its own copies), and it opens on the tab used last. `GET /api/books` lists every PDF under the book folders, opened
or not: one folder per line in `~/.config/pdf-review/books` (`~` allowed, a line starting with `#` is a comment; read
at each request, so a new folder needs no restart). A file under a `backup*` folder is a backup, `-marques-oscar-N`
a marked copy, `-before-edit` the build kept before an edit, a file in a `chapters` folder a chapter, the rest
notes. Listing links nothing, so Recent does not change; a file never opened is linked through `POST /api/open` when
tapped. Chapters and notes paint blue like Recent. No book folder: no tabs, the dialog is Recent alone. The phone
keeps the last list offline (`sw.js`). A test server (its own `PDF_REVIEW_OPEN_ROOTS`) sees no books unless it sets
`PDF_REVIEW_BOOKS`. Tested with `test/book-tabs.mjs` (MODE=desktop and MODE=phone).
On a narrow screen (`viewer/web/phone.js`) the viewer's own controls move to a bar along the bottom, the
outline starts closed, and − / + and the zoom menu go (pinch zooms). The ↕ / ⇆ button picks how to read,
and the choice is kept: **↕ Scroll**, one column of pages at the screen's width with 10 px between them,
or **⇆ Pages**, one page fitted to the screen, turned by a swipe left or right (not while drawing, not
when zoomed past the width, not while selecting text).

## Toolbar (2026-11-12)

One order on every screen, colour icons, and on a phone a bar that wraps into rows. All of it is in
`viewer/web/reader.css` under "Toolbar, 2026-11-12"; the icons are `viewer/web/images/tb-*.svg`.

- **Order.** pdf.js keeps its buttons in three boxes and five of our scripts each pushed theirs in front.
  The boxes are flattened (`display: contents`) and each button gets its place with `order`: 10s mark up
  (select, comment, highlight, text note, draw, picture, undo, redo, comments list), 20s read (recent,
  outline, find, page, view), 30s listen (play, resume, voice), 40s send and state (online note, edit the
  text, apply comments, folder, save state), 50s the rest. A new button needs one `order` line and one icon line.
- **Icons.** A colour picture per tool, not a one-colour mask, each with its own shape: orange bubble =
  comment, yellow band = highlight, teal scribble = draw, purple T = text note, paragraph sign = edit the
  text, robot = send the comments to the agent. Three tools used to wear a pencil.
- **Phone.** Upright or sideways (`phone.js` sets `body.tbRows`, plus `tbWide` sideways) the whole toolbar
  sits at the bottom and wraps, so every tool shows at once: three rows upright (the groups), one row
  sideways. `phone.js` writes the bar's height into `--tbh` and the page ends above it. Pop-ups open upward.
  Before: upright one row that scrolled sideways and hid ten buttons, sideways a column that ran below the screen.
- Test: `node test/toolbar-rows.mjs` (no button off screen in either orientation, group order, page ends at the bar).

## Turning the phone (2026-11-15)

Turning the phone between landscape and portrait keeps the text at the middle of the screen in place, and
the pages do not jump. The code is in `viewer/web/phone.js` (section "turning the
phone keeps the place"), plus one rule in `reader.css`.

- **The zoom fits the new screen.** pdf.js slides the page area to a new size over 200 ms. A turn moves the
  area's right edge (the rail) and its bottom edge (the rows), and the zoom was fitted at the start of the
  slide. Nothing fitted it again, so for minutes the page ran under the rail sideways and filled three
  quarters of the width upright (his log, 12:50 and 15:41 that day: zoom 1.112 on an 815 px wide area, 0.333
  on a 411 px one). On a phone the area now takes its new size at once. The outline still slides open.
- **The middle stays in the middle.** On a zoom change pdf.js keeps the top line in place. While the view is
  still, `phone.js` remembers the point in the middle of the page area: its page, and where on that page. A
  resize that changes the width starts a turn. After each of the turn's resizes, and on every frame until
  600 ms after the last one, that point goes back to the middle; then the zoom is fitted once more.
  ⇆ Pages shows the same page after the turn.
- **A pinch zoom stays** while the page is still wider than the screen (⇆ Pages: or taller). Where it would
  be narrower, the page fits the screen again. ✏️ Write's held zoom is fitted to the new screen and held again.
- **A page turn ends the turn's restore.** The voice reading on, the page buttons, the page box or an
  outline link in the 600 ms after a turn take the view with them. At the very top of a document a turn
  keeps the top. The middle point is read only once no resize has come for 300 ms, so a turn sent as two
  resizes keeps the place from before both.
- Each turn writes a `turn-kept` line to the client log: the page, the place on it, the zoom and the screen.
- Test: `node test/rotate-keep.mjs` (its own server; a phone turned 411x922 to 922x381 and back, alone and
  inside a stand-in of Tinker's layer). Run on the code before this fix, it failed 35 of its 88 checks.

## Selecting and highlights on a phone (2026-11-12)

All in `viewer/web/tools.js` (`#selBar`), styled in `reader.css`.

- **Any selection gets the reader's bar**, however it was made: press and hold, or the Select tool. It holds
  comment, highlight, colour, ▶ read from here, close. pdf.js's own selection bar steps aside. A selection the
  phone made keeps the phone's handles, and the bar sits under it, clear of the phone's copy menu.
- **A highlight without a comment shows no icon** beside it. pdf.js draws its own comment icon once a comment exists.
- **Tap a highlight** (made now or saved in the file) for its tools: comment, colour (the next colour on each
  press), delete, close. The tap turns on pdf.js's Highlight tool with that highlight selected, the way pdf.js's
  double click does; close turns it off again.
- **Colour and delete are saved.** pdf.js marks the file changed only when a mark is added, so a colour change
  or a delete never started the autosave. `autoreload.js` now also counts every pdf.js edit, undo and redo. A
  change made while a save runs gets a save of its own after that one.
- Test: `node test/select-tools.mjs` (as a phone; colour and delete checked in the saved file and after a reload).

## Offline (2026-11-10)

On a secure origin the viewer works with no connection. On the Pi that origin is the tailnet-only HTTPS door,
`tailscale serve --bg --https=8443 http://<tailnet ip>:18794` (never a Funnel port). The phone app puts it first
in its door list. Plain http cannot run a service worker, so the http door works exactly as before.

- `sw.js` (scope = the mount, `/pdf/` on the phone) keeps the viewer itself. It also answers a PDF from the copy
  on the phone, and keeps the last answer of a few `/api` reads (source, origin, history, bookmark, voices).
- Every PDF opened is kept on the phone (`viewer/web/offline.js`). It opens from that copy at once. The viewer
  then compares the server's signature (`Last-Modified|Content-Length`) with the copy's and downloads only a
  changed file.
- Marks are kept on the device by the journal (next section), on the phone as on the laptop. An older viewer's
  pending copy (`pdfreview.pending`) is still sent once, as before: `/api/save` with `base=<signature of the copy>`
  and the copy itself; the server carries only the marks added since it (`pdf-carry-marks.py OLD NEW --since BASE`)
  and never writes the old file over the new one.
- ✏️ Write with no connection works on the kept `.md`, with the edits still waiting applied to it. The edit
  waits on the phone and goes to `/api/paragraph` in order when the connection returns. A refused edit stays in
  the list with its reason. It is never dropped. Changing a waiting writer edit in the Markdown box makes it a
  box edit (the server then skips the word check).
- Apply comments pressed offline waits and is sent once the marks are on the server.
- The note in the toolbar says Online or ✈ Offline and how many changes wait. Tap it for the list: change or
  discard a waiting edit, and **📥 Keep this whole folder on this phone** (all PDFs of the folder and their
  sources, `/api/folder`), with a count such as "21 of 21 kept on this phone".
- `viewer/web/offline.html` is the page the app opens when no door answers. It shows the last PDF in a frame.
  The frame matters: the viewer loaded as the whole WebView page gets `vh` = 0.

On localhost the offline engine is off, unless `localStorage["pdfreview.offline"] = "1"` (the tests set it).
Test: start a second server from the checkout, `PDF_REVIEW_PORT=18831 PDF_REVIEW_OPEN_ROOTS=/tmp/jarvis/pdf-offline-test
.venv/bin/python server.py`, then `PW_CHROMIUM=/usr/bin/chromium PDF_REVIEW_PORT=18831 node test/offline.mjs`. It
uses a throwaway three-chapter book and goes offline with `context.setOffline(true)`.

## No mark or edit is lost (2026-11-15)

Every mark (highlight, note, ink, a note changed or deleted) and every paragraph edit is, at every moment, either on
the Pi or kept on the device and shown there. Laptop and phone alike.

- **The journal** (`viewer/web/journal.js`, IndexedDB, which plain http has too). A mark is written there within a
  quarter of a second, before it travels, and when the page is hidden or about to go. pdf.js saves by appending
  its marks to the file it loaded, so a record is that file (once per version) plus what was appended. It is
  dropped only when the Pi answers with a version that holds it. Until then it is sent again every 10 s, when the
  Pi answers again, and on the next open of the file. A record whose page died (reload, app killed, code update)
  is sent by the next page; if the Pi cannot take it, the page reopens on the marked copy so the marks show.
- **A file that moved on is carried onto, not refused.** The save names the version its marks were made on
  (`base=`), where that version ends in the body (`X-Made-Length`) and what the Pi last confirmed from that page
  (`X-Since-Length`, appended to the body). `server.py` carries only what changed since: new marks, deleted ones and
  rewritten notes (`pdf-carry-marks.py --since`). A carry never doubles a mark, so a resent save changes nothing.
  `GET /api/caps` tells a newer viewer what a not yet restarted server understands.
- **The page never swaps in a newer file over marks still travelling.** `autoreload.js` sends them first, and
  checks again right before the swap (a mark or an open comment box started meanwhile defers it). The laptop no
  longer reloads the newer file on a 409: the marks are carried instead.
- **The Pi never throws an upload away.** Every refused save (409, 422, 400, a failed carry) is kept under
  `state/refused/<file>.<UTC>.bin` with a `.json` beside it; a refused paragraph edit too, and it comes back as the
  open edit on the next open (`state/edit-drafts.json`). One call lists them with their notes:
  `python3 pdf-refused.py [name]` (`--out DIR` writes each back as a PDF).
- **An Apply rebuild removes only what it applied.** A clean `md2pdf.py` build carries onto the rebuild every mark
  the live file has that this round's marked copy `<name>-marques-oscar-N.pdf` (made after the Apply flag) has not.
  With no copy of this round the marked file is kept under `state/refused/` first. md2pdf and the server hold one
  lock per PDF (`pdflock.py`) over "read the marks, write the file", so no save lands in between. The book's
  chapters (`book1/bible/chapter_pdf.py`, run by hand) do the same through `pdf-carry-marks.py --rebuild`.
- **A refused paragraph edit is offered back with one tap.** A paragraph that only moved is saved where it went. One
  that changed answers 409 with the paragraph that took its place: ✏️ Write shows his words with **Put my words in**,
  the Markdown box keeps them and its Save becomes **Put my words in**.
- **What he sees:** the save note says "⏳ Marks waiting on this device, not on the Pi yet" once marks have waited
  (tap it to send now), and "✓ All marks on the Pi" when the last one arrives.

**Run test suites from a /tmp worktree of develop, never from this live folder (2026-11-15):** `bookmarks.json`, `history.json`, `origins.json`, `hidden.json` and `applying/` ignore `PDF_REVIEW_STATE`, so a test server here writes the live Recent list, chat links and Apply flags, and stale entries make tests fail falsely.

Test: `bash test/contract.sh` (13 runs: rebuilds, Apply, reload and kill, network and server restart, refusals,
two devices, the writer; laptop and phone each), and `.venv/bin/python test/carry-since.py` (the carry rules). Each
contract test starts its own server on its own port and state folder.

## Less data on the wire (2026-11-11)

The phone reads on mobile data and on in-flight Wi-Fi, so what travels was cut. Measured on real chapters:

- **A save sends only the new marks.** `saveDocument()` answers the file as loaded plus what pdf.js appended
  (1 to 5 kB on a 2 MB file). `offline.js putSave` sends that part with `keep`, `len` and `crc` on
  `PUT /api/save`; the server rebuilds the file and checks length and crc32. 422 means "send the whole file",
  and the viewer does so at once (an older server answers 400, same effect). Before, every autosave sent
  the whole PDF: 1 MB per chapter, 20 MB for the book.
- **A changed PDF is rebuilt on the device.** `viewer/web/delta.js` describes the copy kept there as a table
  of chunks; `POST /api/delta` answers which ranges to reuse and carries the rest (`server.py build_delta`).
  A rebuilt chapter is 94 to 98 % the old bytes: 16 kB travelled for a 1,159 kB chapter. The result's crc32
  is checked; anything that fails falls back to the whole file. Files under 20 kB are fetched whole. The
  cut rule lives in `delta.js` and in `server.py pdf_chunks`: change both or neither.
- **One waiting request instead of polling.** The viewer asked twice every 2 s ("changed?", "does someone
  want my marks?"). Now `GET /api/watch` waits at the server up to 20 s and answers when either happens.
  While a change is being taken in, `tick()` runs every 2 s again (`chase`). An older server has no
  `/api/watch`: the old polling runs. `localStorage["pdfreview.poll"] = "old"` forces it.
- **The folder list carries each file's version**, so keeping a folder asks once per folder, not three
  times per file. Calls have time limits (20 s, 5 min for a file).
- **The viewer's own files travel compressed** (6.8 MB becomes 2.1 MB for the copy the phone installs), and
  so does any answer over 1.4 kB. Never a PDF: its `Content-Length` is part of the version signature.
- **Client log events travel in batches** (one request per 8 s, or at once for errors, saves and the
  offline engine), as a JSON list.

Test: `PDF_REVIEW_PORT=18832 PDF_REVIEW_OPEN_ROOTS=/tmp/jarvis/pdf-delta-test .venv/bin/python server.py`, then
`PDF_REVIEW_PORT=18832 node test/delta.mjs` (no browser). `test/offline.mjs` parts P6 and P7 check the delta
and the waiting request in a browser.

## Where each feature lives (2026-10-28)

Read this before grepping; a viewer change took 12 probe calls to map on 2026-10-28.
- Comment tools: `viewer/web/tools.js` (💬 Comment toggle, tap-to-comment via pdf.js `commentSelection`, ↶/↷ undo/redo, comment box fit).
- Comment box: pdf.js `#commentManagerDialog` in `viewer/web/viewer.html` (textarea `#commentManagerTextInput`, Cancel, Done); its Apply button (`#commentManagerApplyButton`) is added by `viewer/web/autoreload.js`. It has no mic button.
- Apply locks the comments it takes: `viewer/web/tools.js` § "An Apply round locks" (`applyLock`, `applyUnlock`), the robot and the hidden Edit/Delete in `reader.css`.
- Read aloud: `viewer/web/reader.js` (Piper via `/api/tts`; the phone voice via the `JarvisNative` bridge).
- Phone layout, and the place kept when the phone turns: `viewer/web/phone.js`.
- ✏️ Write: `viewer/web/writer.js` (reading a page into paragraphs, the editor, the moving page, the still copy
  for the swap), `viewer/web/mdmap.js` (words to Markdown and back, finding a paragraph in the source; pure, tested
  in node), `server.py` `Builder`, `md_visible` and `_paragraph_post`. The ✏️ button and the swap itself:
  `viewer/web/autoreload.js`.
- ✓ Approve: `viewer/web/approve.js` (the buttons, where they go, the press), `server.py` `blue_paragraphs`,
  `nw_approve`, `store_add`, `approve_scan`, `_approve_get` and `_approve_post`; the swap waits for `approver.ready()` in
  `autoreload.js`. Blue names in 🕘 Recent: `server.py` `blue_count`, `_blue`; `autoreload.js` `blueNames`. The book chapters' approved text: `book1/bible/assemble.py` `approved_text`.
- Book tabs in 🕘 Recent: `server.py` `book_roots`, `book_kind`, `by_name`, `book_list`; `autoreload.js` `TABS`, `drawBook`, `openBookFile`; `reader.css` `.recentTab`.
- Offline: `sw.js` (service worker), `viewer/web/offline.js` (copies, sync queue), `viewer/web/offline-ui.js` (the Online/Offline note and its list), `viewer/web/offline.html` (the app's offline page).
- Marks on the device until the Pi has them: `viewer/web/journal.js` (storage), `autoreload.js` § "the journal" (snapshot, send, show); refused uploads: `server.py` `keep_refused`, `pdf-refused.py`.
- Phone app bridge verbs: `apps/android/app/src/main/java/ai/openclaw/app/jarvis/JarvisBridge.kt` (speak, synth, voices, share, vibrate, notify, verb…). No speech-to-text verb yet. The WebView grants the mic (`RESOURCE_AUDIO_CAPTURE` in `apps/android/.../ui/TinkerScreen.kt`), so `getUserMedia` works inside the app.
- Tinker UI has no dictation code to reuse.

## Server

User unit `pdf-review.service` (`~/.config/systemd/user/`) runs `server.py` on 127.0.0.1:18820: the
static viewer plus `/api/voices`, `/api/tts` (Piper) and `/api/bookmark`.

On the Pi (no GPU, no torch) the unit runs `.venv/bin/python` (made with `python3 -m venv .venv`, then
`.venv/bin/pip install piper-tts numpy pymupdf`) and the reader speaks with Piper only: Kokoro is listed
only where `torch` and `kokoro` import. Voices: `en_US-lessac-medium` and `en_GB-alan-medium` from
[rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) in `~/.local/share/piper-voices`
(about 2 s per 5 s of speech on the Pi 5). `pdf-comments.py` and `pdf-carry-marks.py` re-run themselves
under `.venv` when the system Python has no PyMuPDF.

## Test

✏️ Write: `node test/mdmap.test.mjs` (`SWEEP=<folder>` also edits every block of every `.md` under it at
random: 2026-11-15, 15,108 edits on the book chapters, none refused, none wrong), `.venv/bin/python
test/writer-server.py`, `node test/writer.mjs` and `PHONE=1 node test/writer.mjs` (each starts its own server),
`node test/writer-align.mjs <pdf>` on a real document.
✓ Approve: `.venv/bin/python test/approve-server.py`, `node test/approve.mjs` and `PHONE=1 node test/approve.mjs`,
`node test/approve-align.mjs <pdf> [--phone]` on a real document (2026-11-15: the book's ch00, 192 buttons on 45
pages, ch01 and ch03, desktop and phone: all placed, none over a word; repainted, no blue left and the darkest
pixel the body grey).
`python3 test/phone-open.py` checks the phone's way in against the live server: open from an allowed
folder, refusal outside them, the history order, a deleted file dropping off, the default voice.
`node test/rotate-keep.mjs` turns a phone several times (starts its own server): the zoom fits the settled page area,
the middle line stays in the middle, ⇆ Pages keeps its page, a pinch zoom and ✏️ Write's held zoom come through.
Run it after any change to `phone.js` or to the page area's CSS.
On the Pi the browser tests need `PW_CHROMIUM=/usr/bin/chromium` and `.venv/bin` first on `PATH`.
`node test/tap-comment.mjs` is the phone comment flow end to end: 💬 Comment, tap a word, type, wait out the
autosave, Add, and the note must be in the SAVED file (2026-10-23: a check that stopped at "the box opens" shipped
an Add that did nothing). Run it after any change to `autoreload.js`, `tools.js` or `phone.js`. Its fixture is the
README built into a PDF. (On the Pi `roundtrip.mjs` and `comment-flow.py` are broken: dead fixture links and no Python
Playwright in `.venv`.)
`node test/roundtrip.mjs` drives the real viewer in headless Chromium: highlight plus comment,
a free-text note, Save, then checks that `pdf-comments.py` reads both back word for word.
`node test/reading-list.mjs <file under papers/> <page>…` prints what the reader will say for those pages, in order
(titles, pauses, joins across a page break, margin notes): the first look when the order sounds wrong.
`node test/reader-skip.mjs` checks ⏮ and ⏭ (paragraph starts, across a page break, the ends of the document, paused
and not started, two quick presses) with a silent canned voice, so it needs no speech engine; `reader-native.mjs` N6
checks the hand-over to the app. On the Pi run it with `PW_CHROMIUM=/usr/bin/chromium PATH=<repo>/.venv/bin:$PATH`.
`node test/reader.mjs` checks read-aloud: header skipped, place saved per sentence, page turns,
pause, reopening on the marked sentence, resume, start from a selection (toolbar and ▶ under it),
titles read alone, the paragraph and title pauses (timed), Space to play and pause, text at the page
edge read while a running footer is not, reading order with margin notes and a sentence cut by the
page break, and a rebuilt copy finding the same sentence.

## Checking a viewer change reached his window (2026-10-12)

The Playwright tests run in a fresh browser with an empty cache, so they pass while the architect's Chrome
app window keeps running the old `viewer.html` / `autoreload.js` from its cache. On 2026-10-12 two
fixes "passed" this way and he still got the save-as dialog twice ("Potser no has fet el build?").
Since then the server sends `Cache-Control: no-cache` and `open-pdf` puts `?v=<viewer mtime>` in the URL.

Done means his window, not the test: `journalctl --user -u pdf-review --since -10min -o cat` must show
a `GET /viewer/web/autoreload.js` right before his PDF's `GET /papers/open/...`, then `GET /api/watch`
waits on that PDF (2026-11-11; `HEAD` polls from a viewer older than that), then `saved <his file>` when he
presses Ctrl+S. A test run's lines name `autoreload-test`;
do not mistake them for his.
