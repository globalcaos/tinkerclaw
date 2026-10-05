---
name: chatgpt-exporter-ultimate
version: 1.9.2
description: "Export your ChatGPT conversations to local files — titles, timestamps and, if you ask for it, full message text. Built for the TinkerClaw fork — github.com/globalcaos/tinkerclaw. Invoke it BY NAME — \"chatgpt-exporter-ultimate: export my conversations\" — so ordinary talk about ChatGPT cannot trigger it. Rides the ChatGPT session your browser already holds — browser relay or a bookmarklet you paste yourself. It reads NO access token, no cookie jar and no credential file. The relay enumerates your conversation list and writes JSON and Markdown copies to a private directory; it defaults to index-only (titles and timestamps, no message text) and refuses to run without an explicit confirmation of destination and scope. The bookmarklet can also find conversations inside Projects, by running searches against your history, and downloads one JSON file after three dialogs. Relay destinations are resolved through symlinks before anything is written, so a relay export cannot land in a synced folder, a git repo or outside your home, and a symlink or hard link left inside a reused export directory is refused instead of written through. A validated --purge deletes an export again. Off switch documented in the skill."
metadata:
  openclaw:
    permissions:
      network:
        required: true
        scope: "HTTPS to chat.openai.com / chatgpt.com only, to list and read YOUR OWN conversations. No third-party endpoint."
      shell:
        required: true
        scope: "grep/sed/awk for parsing; realpath/readlink to canonicalize a destination or a purge target; and coreutils (date, du, head, rm). scripts/export.sh makes NO network calls at all — it neither fetches nor authenticates. Fixed arguments, no eval, no shell interpolation of fetched data, no privilege escalation."
      env_read:
        required: false
        scope: "Only CHATGPT_EXPORT_DISABLE, the off switch. No credential is read from the environment: CHATGPT_ACCESS_TOKEN is not consulted anywhere in this package."
      file_write:
        required: true
        scope: "The export directory (default $HOME/.local/share/chatgpt-export/<date>). Directories are forced to 0700 and files to 0600 on EVERY run, including when an existing directory or file is reused, so a pre-existing permissive path cannot leave conversation text world-readable. The destination is RESOLVED THROUGH SYMLINKS before any write and re-verified after creation. Nothing inside it follows a symlink either: every file is opened O_NOFOLLOW, must be a single-link regular file you own, and gets its mode through the open descriptor; conversations/ must be a real directory at exactly <export dir>/conversations. A planted symlink or hard link is refused and its target left untouched; platforms without O_NOFOLLOW are refused. A destination that resolves to a synced folder (Dropbox/Drive/OneDrive/iCloud/Nextcloud), inside a git repo, or outside $HOME is REFUSED. There is no override. The directory is re-checked after each open; on Linux the open descriptor's real path must also match, which catches a directory swapped in and back out mid-write (and any empty file that open created is removed). Without /proc (e.g. macOS) that last swap-and-restore race by another process running as you is not detected. DEFAULT IS INDEX-ONLY: titles/ids/timestamps, no message text."
      file_delete:
        required: true
        scope: "ONLY via the explicit --purge / --purge-expired flags. The target is the EXACT export directory — no parent is ever derived from it. It must canonicalize (realpath), be a strict descendant of the canonical $HOME at least two levels deep, and contain a .chatgpt-export-manifest.json this tool wrote; everything is re-validated immediately before deletion. It refuses $HOME, /, symlink escapes, directories it did not create, and any non-interactive run. A normal export deletes nothing, with one narrow exception: if a relay write is aborted because its directory was swapped mid-write, the empty file that very open just created is removed again (Linux; same inode, size 0). Covered by scripts/purge-selftest.sh and scripts/relay-selftest.ts."
      credentials:
        required: false
        scope: "NONE. No script in this package reads, stores, forwards or replays a credential. Every request rides the session cookie the browser already holds, inside the page. Enforced by scripts/dest-safety-selftest.sh."
    owner: kn7623hrcwt6rg73a67xw3wyx580asdw
    category: utilities
    emoji: "💬"
    tags:
      - chatgpt
      - export
      - backup
      - conversations
    license: MIT
    requires:
      bins:
        - bash
        - sed
        - coreutils
        - node
    notes:
      security: >-
        Exports your ChatGPT history to plaintext files on your own machine. Network access is
        chatgpt.com ONLY (its backend-api list/fetch/search endpoints); nothing is uploaded
        anywhere else.
        NO CREDENTIAL IS HANDLED. Both export paths run inside the page on the session cookie
        the browser already holds. scripts/export.sh makes no network call at all.
        WRITES SENSITIVE DATA TO DISK: full message text, titles, ids and timestamps, into
        $HOME/.local/share/chatgpt-export/<date> by default. Directories are 0700 and files 0600,
        re-applied on every run so a reused path cannot stay permissive. The destination is
        resolved through symlinks before any write and re-verified after creation; one resolving
        to a synced folder, a git repo or outside $HOME is refused, with no override. A symlink
        or hard link planted inside a reused export is refused (O_NOFOLLOW, descriptor-based
        chmod, canonical-path check on conversations/, directory re-checked after each open, and
        on Linux the descriptor's real path checked too). The bookmarklet writes none of these
        files: it hands one JSON file to the browser's Downloads. Both export paths ask first:
        the relay throws unless called with confirmed: true, and that error states destination
        and scope; the bookmarklet opens a dialog. Index-only is the relay DEFAULT. Redaction, when enabled, covers every written
        file including summary.md (best-effort, not a guarantee).
        DELETES DATA ONLY VIA --purge / --purge-expired, on a canonicalized path under $HOME that
        carries a manifest this tool wrote, re-validated immediately before deletion, interactive
        only. Regression tests: scripts/purge-selftest.sh (14 cases), scripts/dest-safety-selftest.sh
        (19 cases, incl. symlink bypasses and the removed overrides) and scripts/relay-selftest.ts
        (53 cases, incl. file modes on reused paths, summary redaction, planted nested symlinks
        and a directory swapped between validation and write).
        OFF SWITCH at all times: CHATGPT_EXPORT_DISABLE=1 or
        ~/.openclaw/chatgpt-export.disabled — both checked before any network call or file write.
        NO privilege escalation, NO credential files read, NO third-party endpoints, NO telemetry.
        See the Permissions, Data Flow & Consent section.
---

# ChatGPT Exporter Ultimate

> One of dozens of skills and plugins in **[TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — a self-improving OpenClaw fork that's been running 24/7 for months.

Your entire ChatGPT history, exported in seconds — not tomorrow.


### Deleting your exports — `--purge`

An export is a plaintext copy of every conversation you have had. Leaving it on disk is usually a
bigger risk than the API call that created it, so cleanup is a first-class command rather than an
`rm -rf` you are trusted to type correctly:

```bash
./scripts/export.sh --purge -o ~/.local/share/chatgpt-export/2026-01-31
./scripts/export.sh --purge-expired    # everything past the expiry in its own manifest
```

**This is destructive, so the target is validated rather than trusted.** The directory that gets
deleted is the **exact** one you named — no parent is ever derived from it — and it is deleted only
if all of the following hold:

- it canonicalizes with `realpath` (so every symlinked component is resolved first);
- the canonical path is a **strict descendant of your canonical `$HOME`**, at least two levels
  deep — `$HOME` itself, `/`, and anything one level down are refused outright;
- it contains a `.chatgpt-export-manifest.json` that **this tool wrote**. An arbitrary folder that
  happens to hold an `index.json` is not accepted as proof of ownership;
- you typed `PURGE` at the prompt, in an interactive terminal. It refuses to run headless;
- and the whole check is **repeated immediately before the delete**, so a directory swapped in
  after validation is still rejected.

It removes **local copies only** — your ChatGPT account is untouched. These rules are not a
promise in a README; they are covered by `scripts/purge-selftest.sh`, which runs the refusals
against a throwaway `$HOME` and never touches your real one.

## What You Get

- **Your conversation list.** The relay walks the conversations ChatGPT lists for you; the bookmarklet
  also finds ones inside Projects. Timestamps, roles and metadata come along; message text only if you ask.
- **Instant.** No 24-hour wait. No email with a ZIP of cryptic JSON. Just your data, now.
- **Context preserved.** Conversations stay readable. Who said what, when, and why — all intact.

## How It Works

Install the skill, ask for it by name, confirm the destination and scope, and the export is written.

ChatGPT's built-in export makes you wait a day and hands you raw JSON. This skill respects your time.

**Won't:** email you a ZIP file 24 hours later like you requested declassified government documents.

👉 Explore the full project: [github.com/globalcaos/clawdbot-moltbot-openclaw](https://github.com/globalcaos/clawdbot-moltbot-openclaw)

*Clone it. Fork it. Break it. Make it yours.*

---

## ⚠️ Read This Before Your First Export

An export is a **plaintext copy of everything you have ever said to ChatGPT**, sitting on your
disk. Whatever you pasted into a chat is in there: API keys, passwords, medical questions, legal
problems, salary numbers, your employer's confidential material, other people's personal data.

Once written, those files are ordinary files. Anything running as your user can read them, your
backup tool will pick them up, and a sync client will happily push them to a cloud you did not
think about. So:

- Export to a **local, non-synced** directory. Not Dropbox, not Drive, not iCloud, not a repo.
  You do not have to remember this: the default is a dedicated private directory
  (`~/.local/share/chatgpt-export/<date>`), and a destination that looks synced, sits inside a
  git repo, or leaves your home directory is **refused** — with no override. The check resolves
  symlinks first, so a link named `exports` that points into Dropbox is judged on where it
  actually goes.
- The relay creates the directory **mode 0700** and files **0600**. Don't loosen that. (The
  bookmarklet's download lands wherever your browser saves files, with your browser's permissions.)
- **Delete the export when you are done with it** — `./scripts/export.sh --purge -o <dir>`.
  Every relay export records an expiry (30 days by default); `--purge-expired` clears the ones past it.
  A bookmarklet download has no manifest: delete that file yourself.
- If you only need to know *what* you talked about, use **index-only** mode: titles, ids and
  timestamps, with no message content fetched at all.
- Never hand a raw export to anyone, including another AI, without reading it first.

This skill will not export anything until you say yes, and it tells you what it is about to do
before it asks.

## Permissions, Data Flow & Consent

Short version: your conversations travel from chatgpt.com to your disk, and nowhere else. There
is no server of ours in this picture. Longer version, because you should not take that on trust:

**Where the data goes.** Each export path fetches from `chatgpt.com/backend-api` and writes files
locally. There is no upload, no telemetry, no analytics, no third-party endpoint of any kind.
The only network destination in the entire package is `chatgpt.com`.

**What gets written, and where.**

| Path | Default output | Files |
| --- | --- | --- |
| `scripts/export-conversations.ts` (relay) | `~/.local/share/chatgpt-export/<date>` | `.chatgpt-export-manifest.json`, `index.json`; unless index-only also `summary.md` and per-conversation `.json` + `.md` |
| `scripts/export.sh` | — | writes nothing (vets destinations and purges) |
| `scripts/bookmarklet.js` (browser) | your browser's Downloads folder | one `chatgpt-export-<date>.json` |

Directories are `0700` and files `0600` — enforced on **every** run, not only when they are first
created, so reusing an export directory that is already world-readable cannot leave your
conversations exposed. You can choose the destination, but one that looks synced (Dropbox, Drive,
OneDrive, iCloud, Nextcloud…), sits inside a git repository, or resolves outside your home
directory is **refused, with no override**.

The check runs on the **resolved** path, not the one you typed: `~/exports` that is a symlink to
`~/Dropbox/exports` is refused. The destination is canonicalized through every symlinked
component — including ancestors that exist while the export directory does not yet — before
anything is written, and re-verified after the directory is created. Inside it, nothing follows a
link: each file is opened with `O_NOFOLLOW` and chmod-ed through its descriptor, and
`conversations/` must be a real directory at exactly that path. A reused export directory holding a
symlinked `index.json`, `summary.md`, manifest, `conversations/` or conversation file is refused and
the link target is not touched. The directory is re-checked after each file is opened; on Linux the
open descriptor's real path (`/proc/self/fd`) must match as well, so a directory swapped for a link
in the instant before the open — even if it is swapped back — aborts the export and the empty file
is removed. Without `/proc` (macOS) the swap-and-swap-back case by another process running as you
is not detected; that is the limit of what Node's file API allows. `outputDir` must be absolute or start with `~/`. The default is a dedicated
private directory rather than the top of `$HOME`, because that is where sync clients look.

`./scripts/export.sh --check-dest <dir>` vets a destination and prints what it resolves to,
without writing anything.

Every relay export drops a `.chatgpt-export-manifest.json` marker recording when it was written and when
it expires. That marker is what makes the export deletable by `--purge`, and nothing without it
will be deleted. The bookmarklet writes no manifest, so `--purge` cannot touch its download.

**How it authenticates — and the honest part.** ChatGPT has no public API for reading your own
conversation history. The only way to do this is to talk to the same private endpoints the web
app uses, as you. That is the skill's core mechanism, and there is no version of it that avoids
touching your session. What we can do is minimise it, and we do:

- **Relay path** — runs inside the page with `credentials: 'include'`. Reads no token at all.
- **Bookmarklet** — cookie only. If the cookie is rejected it tells you to log in again and stops.
- **Shell path** — `scripts/export.sh` does not export at all. It makes no network call and
  handles no credential; it is the cleanup half (`--purge`, `--purge-expired`, `--check-dest`).

**No bearer token, anywhere.** Nothing in this package reads, stores, forwards or replays one;
`scripts/dest-safety-selftest.sh` fails if any script regains the ability. The cost is headless
export — there is no unattended path. If you need one, use ChatGPT's own 24-hour export.

**Capabilities, and why each one is needed.**

| Capability | Why | Scope |
| --- | --- | --- |
| Network | List and fetch your conversations | `chatgpt.com/backend-api` only. No other host, ever |
| Browser session (cookie) | Authenticate as you — there is no other way in | Same-origin, inside the page; not copied out |
| Session token | **None.** No path reads, stores or replays one (removed in 1.9.1) | — |
| File write | The export itself | The output directory. `0700` dir, `0600` files, re-applied on every run. Destinations that *resolve* to synced/git/outside-`$HOME` are refused, no override |
| File delete | `--purge` / `--purge-expired`, so an export is not left lying around forever | The exact validated directory only: canonical, under `$HOME`, two levels deep, carrying our manifest, typed confirmation, interactive only |
| Shell exec | `export.sh` runs `realpath`/`readlink`, `grep`, `sed` and coreutils for path validation and purging | Fixed binaries, fixed arguments. No network binaries |
| Search endpoint | Find conversations inside Projects, which the list endpoint omits | ~65 short queries against your own history. Opt-in, skippable |
| Credentials on disk | **None.** Reads no keyring, no `.env`, no config, no cookie jar | — |
| Third-party services | **None.** No telemetry, no upload, no analytics | — |
| Privilege escalation | **None.** No `sudo`. The relay writes only inside its output directory; the bookmarklet only hands one file to the browser's download | — |

**The consent step — each export path has one, in code.**

- `export.sh` no longer exports, so it has no export consent step. Its destructive path does:
  `--purge` validates the target, refuses to run non-interactively, and requires you to type
  `PURGE`.
- `bookmarklet.js` opens a dialog stating that the file may contain credentials and other
  sensitive material. Cancel and nothing happens. Two further dialogs let you skip the Projects
  search and drop message bodies.
- `exportChatGPTConversations()` **throws** unless the caller passes `confirmed: true`, and the
  thrown message is the structured confirmation itself — destination, scope, cap, redaction,
  network and sensitivity — so the agent shows you the terms rather than paraphrasing them. An
  agent has to ask you first; installing this skill cannot turn into an unattended dump of your
  chat history.

**The off switch.** The relay and `export.sh` check this before any network call or file write:

```bash
CHATGPT_EXPORT_DISABLE=1                       # disable for one command or one shell
touch ~/.openclaw/chatgpt-export.disabled      # disable permanently, machine-wide
rm ~/.openclaw/chatgpt-export.disabled         # allow again
```

With either in place, `export.sh` prints a notice and exits 0, and the TypeScript path throws.
Neither fetches anything. In the browser, the off switch is cancelling the first dialog.

**Scope controls.** Full export is a choice, not the default behaviour you get by accident:

| Control | relay (`.ts`) | bookmarklet |
| --- | --- | --- |
| Must be asked for by name | `confirmed: true` (else it throws) | the first dialog |
| Cap how many | `limit: N` | — |
| No message bodies (DEFAULT) | `indexOnly: true` | Cancel the third dialog |
| Scrub common secrets | `redact: true` — applies to **every** file, `summary.md` included | — |
| Skip Projects search | n/a (never searches) | Cancel the second dialog |
| Choose destination | `outputDir` | browser Downloads |
| Refuse a risky destination | always on, no override | n/a |
| Set the expiry | `expireDays: N` (default 30) | n/a |
| Delete it again | via `export.sh --purge` | delete the download |

`export.sh` is absent from this table because it no longer exports — it has no scope to control.
There is no unattended export path at all: the relay needs a caller that has confirmed with you,
and the bookmarklet needs you in the browser clicking through its dialogs. Deletion always asks,
every time.

## Usage

### 1. Browser relay (recommended — no token is ever read)

Prerequisites: Node 22.6+ (which runs the `.ts` file directly) or Node with `tsx`, an OpenClaw browser relay attached to a Chrome/Chromium where you
are logged into chatgpt.com.

Invoke it **by name**, so ordinary conversation about ChatGPT cannot start an export:
*"chatgpt-exporter-ultimate: export my conversations."* The agent must then echo the destination,
the scope (index-only or full) and the sensitivity warning back to you, and get a yes, before
calling:

```ts
await exportChatGPTConversations({
  browserEvaluate,           // supplied by the agent's browser tool
  confirmed: true,           // only after the user has actually agreed
  outputDir: "~/.local/share/chatgpt-export/2026-01-31",  // this is also the default
  format: "both",            // "json" | "md" | "both"
  limit: 50,                 // optional cap
  indexOnly: false,          // true = titles/timestamps only, no message text (DEFAULT is true)
  redact: true,              // best-effort scrub of common secret formats
});
```

Without `confirmed: true` it throws — and the error it throws is the confirmation script itself:
destination, scope, cap, redaction state and the sensitivity warning, so the agent has something
exact to show you rather than a summary of its own. It also refuses — unconditionally, with no
override — a destination that *resolves* to something synced, inside a git repo, or outside your
home directory, and re-checks after creating the directory. Exports written here carry the same
ownership marker, so `export.sh --purge` can clean them up.

### 2. Bookmarklet (browser only, includes Projects)

Prerequisites: Chrome DevTools, logged into chatgpt.com.

Open the console on chatgpt.com, paste `scripts/bookmarklet.js`, press Enter, and answer the three
dialogs: export or not, search Projects or not, include message text or not. The result lands in
your Downloads folder as a single JSON file. This is the only path that finds conversations inside
Projects, and it does so by running ~65 short searches against your own history — that is the
trade, and the dialog says so before it starts.

### 3. Shell script (cleanup and destination vetting — does NOT export)

Prerequisites: `bash` and coreutils. No network, no credential.

```bash
./scripts/export.sh --check-dest ~/private/chatgpt   # vet a destination, write nothing
./scripts/export.sh --purge -o ~/private/chatgpt     # validated delete, asks you to type PURGE
./scripts/export.sh --purge-expired                  # delete every export past its expiry
```

This script does not export and handles no credential. The relay drops an ownership manifest
into every export it writes; `--purge` validates that manifest and deletes the export later, and
`--check-dest` vets a destination before you point the relay somewhere new. The bookmarklet writes
no manifest — its single download is yours to delete.

## Included Files

| File | Purpose |
| --- | --- |
| `scripts/export-conversations.ts` | Browser-relay exporter. Consent-gated, off-switchable, no token read |
| `scripts/bookmarklet.js` | Console/bookmarklet exporter. Three consent dialogs, cookie-only auth, finds Projects |
| `scripts/export.sh` | Cleanup and destination vetting. No network, no credential. Off switch, validated `--purge`, `--check-dest` |
| `scripts/purge-selftest.sh` | Regression tests for `--purge` (14): runs its refusals against a throwaway `$HOME`, no network |
| `scripts/dest-safety-selftest.sh` | Regression tests for destination vetting (19): symlink bypasses, and that the removed overrides stay removed |
| `scripts/relay-selftest.ts` | Regression tests for the relay (53): file modes on reused paths, summary redaction, planted nested symlinks and hard links, a directory swapped between validation and write, no-token guarantee. Stubbed browser, no network |

That is the whole package — six scripts, no binaries, no installers, nothing that runs on its
own. Everything the documentation above describes is in these files, and everything in these files
is described above. If you find a claim here that the code does not do, that is a bug — open an
issue on [the repo](https://github.com/globalcaos/tinkerclaw/issues).

## Changelog

- 1.9.2 — Fixed: the relay exporter no longer writes or chmods through a symlink or hard link planted inside a reused export directory, and a directory swapped for a symlink between validation and write is refused (Linux also checks the descriptor's real path and removes the empty file); docs aligned: cookie-only bookmarklet, export.sh writes nothing, only relay exports carry a manifest, node listed as a requirement, stale skill card rewritten.
