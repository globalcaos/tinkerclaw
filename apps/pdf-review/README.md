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
4. Small wording you can fix yourself: **✏️ Edit text**, click a paragraph, edit it in place.

Runtime data stays beside the code and out of git: `papers/` (links to the PDFs being served) and
`state/` (bookmarks, which chat owns which PDF, history).

## Read aloud

**▶ Read** in the toolbar speaks the paper with an offline voice, highlights the sentence it
is on and turns the pages. It starts from the text you selected (even while it is reading), else your
saved place if you are on that page, else the top of the page. Selecting text also puts a ▶ in the
little toolbar under it, next to Comment and Highlight. Turn the page while it reads and it carries
on from there. Speed (0.8× to 2×) and voice sit next to it; the media keys pause and play.
**Space** does the same as ▶ Read anywhere in the document (not while typing in a field or comment).

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

**✏️ Edit text** (2026-10-16): shown when a PDF has a sibling `.md` with the same name. Press it, click a paragraph (or list item) in the page, edit it in the popup, Save: the server rewrites that block of the `.md` (`/api/paragraph`, fuzzy match on the clicked text) and rebuilds the PDF with `md2pdf.py`; the previous PDF is kept as `<name>-before-edit.pdf` and the window reloads. Esc leaves the picker. The `.md` is the one source: agents applying comments edit it too. Rebuilds are clean by default, so comments an agent applied leave the PDF; only the architect's own text edits (this popup, or his editor saving the `.md`) rebuild with `--keep-marks`. Apply comments drops a flag in `state/applying/` so the watcher leaves that PDF to the agent's clean rebuild (flag cleared by it, ignored after 30 min). Test: `python3 test/marks.py`.

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
first (`state/history.json`; only links under `papers/` count, so the tests' real fixture files stay out).
On a narrow screen (`viewer/web/phone.js`) the viewer's own controls move to a bar along the bottom, the
outline starts closed, and − / + and the zoom menu go (pinch zooms). Its first button picks how to read,
and the choice is kept: **↕ Scroll**, one column of pages at the screen's width with 10 px between them,
or **⇆ Pages**, one page fitted to the screen, turned by a swipe left or right (not while drawing, not
when zoomed past the width, not while selecting text).

## Where each feature lives (2026-10-28)

Read this before grepping; a viewer change took 12 probe calls to map on 2026-10-28.
- Comment tools: `viewer/web/tools.js` (💬 Comment toggle, tap-to-comment via pdf.js `commentSelection`, ↶/↷ undo/redo, comment box fit).
- Comment box: pdf.js `#commentManagerDialog` in `viewer/web/viewer.html` (textarea `#commentManagerTextInput`, Cancel, Done). It has no lock or mic button.
- Read aloud: `viewer/web/reader.js` (Piper via `/api/tts`; the phone voice via the `JarvisNative` bridge).
- Phone layout: `viewer/web/phone.js`.
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

`python3 test/phone-open.py` checks the phone's way in against the live server: open from an allowed
folder, refusal outside them, the history order, a deleted file dropping off, the default voice.
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
a `GET /viewer/web/autoreload.js` right before his PDF's `GET /papers/open/...`, then `HEAD` polls on
that PDF, then `saved <his file>` when he presses Ctrl+S. A test run's lines name `autoreload-test`;
do not mistake them for his.
