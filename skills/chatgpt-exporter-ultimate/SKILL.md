---
name: chatgpt-exporter-ultimate
version: 1.7.1
description: "Export all your ChatGPT conversations instantly — full context, timestamps, and metadata in seconds. Built for the TinkerClaw fork — github.com/globalcaos/tinkerclaw. Reads your logged-in ChatGPT session (browser relay, bookmarklet, or a token you supply), enumerates conversations — including ones inside Projects, found by running searches against your history — and writes plaintext JSON and Markdown copies to a directory you choose. Asks for confirmation before writing anything; off switch documented in the skill."
metadata:
  openclaw:
    permissions:
      network:
        required: true
        scope: "HTTPS to chat.openai.com / chatgpt.com only, to list and read YOUR OWN conversations. No third-party endpoint."
      shell:
        required: true
        scope: "curl for the API calls; python3/jq for JSON. No other external command."
      env_read:
        required: true
        scope: "CHATGPT_ACCESS_TOKEN only, and only as a fallback — the hidden TTY prompt is preferred because an env var is readable by child processes."
      file_write:
        required: true
        scope: "The export directory you choose (created 0700, files 0600). DEFAULT IS INDEX-ONLY: titles/ids/timestamps, no message text. Full content requires --full plus an interactive typed confirmation."
      credentials:
        required: true
        scope: "Your ChatGPT session bearer token. Used in-memory for the run, never written to disk, never logged, never passed as a command-line argument."
  openclaw:
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
        - curl
        - jq
        - bash
    notes:
      security: >-
        Exports your ChatGPT history to plaintext files on your own machine. Network access is
        chatgpt.com ONLY (its backend-api list/fetch/search endpoints); nothing is uploaded
        anywhere else. Authentication uses the browser session you already have — the relay path
        and the bookmarklet send the session cookie and never read a token; the bookmarklet only
        falls back to /api/auth/session if the cookie is rejected, and that token is never logged
        or stored. The optional headless path (scripts/export.sh) takes a token from
        CHATGPT_ACCESS_TOKEN or a hidden prompt and refuses it as a command-line argument.
        WRITES SENSITIVE DATA TO DISK: full message text, titles, ids and timestamps, into a
        directory you pick, created mode 0700 with files 0600. Every path requires an explicit
        confirmation before writing, and every path offers an index-only mode that fetches no
        message bodies at all. OFF SWITCH at all times: CHATGPT_EXPORT_DISABLE=1 or
        ~/.openclaw/chatgpt-export.disabled — both checked before any network call or file write.
        NO privilege escalation, NO credential files read, NO third-party endpoints, NO telemetry.
        See the Permissions, Data Flow & Consent section.
---

# ChatGPT Exporter Ultimate

> One of dozens of skills and plugins in **[TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — a self-improving OpenClaw fork that's been running 24/7 for months.

Your entire ChatGPT history, exported in seconds — not tomorrow.


### Deleting your exports — `--purge`

An export is a plaintext copy of every conversation you have had. Leaving it on disk is
usually a bigger risk than the API call that created it, so there is a cleanup command:

```bash
./scripts/export.sh --purge
```

**This is destructive.** It permanently deletes the export directory tree. It prints the
target path and its size first, requires you to type `PURGE` to confirm, and refuses to run
non-interactively. It removes **local copies only** — your ChatGPT account is untouched.


## What You Get

- **Every conversation.** Projects, chats, timestamps, roles, metadata. Nothing left behind.
- **Instant.** No 24-hour wait. No email with a ZIP of cryptic JSON. Just your data, now.
- **Context preserved.** Conversations stay readable. Who said what, when, and why — all intact.

## How It Works

Install the skill. Run it. Get your full export. That's it.

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
- The scripts create the directory **mode 0700** and files **0600**. Don't loosen that.
- **Delete the export when you are done with it** — `rm -rf <output_dir>`.
- If you only need to know *what* you talked about, use **index-only** mode: titles, ids and
  timestamps, with no message content fetched at all.
- Never hand a raw export to anyone, including another AI, without reading it first.

This skill will not export anything until you say yes, and it tells you what it is about to do
before it asks.

## Permissions, Data Flow & Consent

Short version: your conversations travel from chatgpt.com to your disk, and nowhere else. There
is no server of ours in this picture. Longer version, because you should not take that on trust:

**Where the data goes.** Each path fetches from `chatgpt.com/backend-api` and writes files
locally. There is no upload, no telemetry, no analytics, no third-party endpoint of any kind.
The only network destination in the entire package is `chatgpt.com`.

**What gets written, and where.**

| Path | Default output | Files |
| --- | --- | --- |
| `scripts/export-conversations.ts` (relay) | `~/chatgpt-export/<date>` | `index.json`, `summary.md`, per-conversation `.json` + `.md` |
| `scripts/export.sh` (token) | `~/chatgpt-export/<date>` | `index.json`, per-conversation `.json` + `.md` |
| `scripts/bookmarklet.js` (browser) | your browser's Downloads folder | one `chatgpt-export-<date>.json` |

Directories are created `0700`, files `0600`. You can override the destination on both scripts.

**How it authenticates — and the honest part.** ChatGPT has no public API for reading your own
conversation history. The only way to do this is to talk to the same private endpoints the web
app uses, as you. That is the skill's core mechanism, and there is no version of it that avoids
touching your session. What we can do is minimise it, and we do:

- **Relay path** — runs inside the page with `credentials: 'include'`. Reads no token at all.
- **Bookmarklet** — cookie-first. It only reads `/api/auth/session` if the cookie call comes back
  401/403, and that token stays in the function scope: never printed, never stored, never sent
  anywhere except back to chatgpt.com in an `Authorization` header.
- **Shell path** — takes a token from `CHATGPT_ACCESS_TOKEN` or a hidden prompt. Passing it as a
  command-line argument is **rejected**, because argv is visible to every process via `ps` and
  gets saved to your shell history.

If handling a session token is not acceptable to you — a reasonable position — use the relay path
or the bookmarklet, which never read one, or use ChatGPT's own 24-hour export instead.

**Capabilities, and why each one is needed.**

| Capability | Why | Scope |
| --- | --- | --- |
| Network | List and fetch your conversations | `chatgpt.com/backend-api` only. No other host, ever |
| Browser session (cookie) | Authenticate as you — there is no other way in | Same-origin, inside the page; not copied out |
| Session token | Fallback when cookie auth is rejected; the only option headless | In memory / env var for the run. Never logged, never written to disk |
| File write | The export itself | The output directory you choose. `0700` dir, `0600` files |
| Shell exec | `export.sh` runs `curl` and `jq` | Two fixed binaries, fixed arguments |
| Search endpoint | Find conversations inside Projects, which the list endpoint omits | ~65 short queries against your own history. Opt-in, skippable |
| Credentials on disk | **None.** Reads no keyring, no `.env`, no config, no cookie jar | — |
| Third-party services | **None.** No telemetry, no upload, no analytics | — |
| Privilege escalation | **None.** No `sudo`, no writes outside the output directory | — |

**The consent step — every path has one, in code.**

- `export.sh` prints the destination, what will be written and the sensitivity warning, then
  requires you to type `export`. Anything else aborts before a single byte is fetched.
- `bookmarklet.js` opens a dialog stating that the file may contain credentials and other
  sensitive material. Cancel and nothing happens. Two further dialogs let you skip the Projects
  search and drop message bodies.
- `exportChatGPTConversations()` **throws** unless the caller passes `confirmed: true`. An agent
  has to ask you first — installing this skill cannot turn into an unattended dump of your chat
  history.

**The off switch.** Both scripted paths check this before any network call or file write:

```bash
CHATGPT_EXPORT_DISABLE=1                       # disable for one command or one shell
touch ~/.openclaw/chatgpt-export.disabled      # disable permanently, machine-wide
rm ~/.openclaw/chatgpt-export.disabled         # allow again
```

With either in place, `export.sh` prints a notice and exits 0, and the TypeScript path throws.
Neither fetches anything. In the browser, the off switch is cancelling the first dialog.

**Scope controls.** Full export is a choice, not the default behaviour you get by accident:

| Control | `export.sh` | relay (`.ts`) | bookmarklet |
| --- | --- | --- | --- |
| Preview without writing | `--dry-run` | — | — |
| Cap how many | `--limit N` | `limit: N` | — |
| No message bodies | `--index-only` | `indexOnly: true` | Cancel the third dialog |
| Skip Projects search | n/a (never searches) | n/a (never searches) | Cancel the second dialog |
| Choose destination | `-o DIR` | `outputDir` | browser Downloads |

## Usage

### 1. Browser relay (recommended — no token is ever read)

Prerequisites: Node with `tsx`, an OpenClaw browser relay attached to a Chrome/Chromium where you
are logged into chatgpt.com.

Ask your agent: *"Export my ChatGPT conversations."* The agent must confirm the destination and
the sensitivity warning with you, then call:

```ts
await exportChatGPTConversations({
  browserEvaluate,           // supplied by the agent's browser tool
  confirmed: true,           // only after the user has actually agreed
  outputDir: "~/chatgpt-export/2026-01-31",
  format: "both",            // "json" | "md" | "both"
  limit: 50,                 // optional cap
  indexOnly: false,          // true = titles/timestamps only, no message text
});
```

Without `confirmed: true` it throws and exports nothing.

### 2. Bookmarklet (browser only, includes Projects)

Prerequisites: Chrome DevTools, logged into chatgpt.com.

Open the console on chatgpt.com, paste `scripts/bookmarklet.js`, press Enter, and answer the three
dialogs: export or not, search Projects or not, include message text or not. The result lands in
your Downloads folder as a single JSON file. This is the only path that finds conversations inside
Projects, and it does so by running ~65 short searches against your own history — that is the
trade, and the dialog says so before it starts.

### 3. Shell script (headless / advanced — you supply the token)

Prerequisites: `bash`, `curl`, `jq`, and an access token you already have.

```bash
export CHATGPT_ACCESS_TOKEN='...'        # or let the script prompt you (input hidden)
./scripts/export.sh --dry-run            # count what would be exported, write nothing
./scripts/export.sh --index-only         # titles and timestamps only
./scripts/export.sh -o ~/private/chatgpt --limit 100
```

The token is never accepted as an argument. Use this path only if the two above do not fit your
setup; they need no token at all.

## Included Files

| File | Purpose |
| --- | --- |
| `scripts/export-conversations.ts` | Browser-relay exporter. Consent-gated, off-switchable, no token read |
| `scripts/bookmarklet.js` | Console/bookmarklet exporter. Three consent dialogs, cookie-first auth, finds Projects |
| `scripts/export.sh` | Headless exporter using a token you supply. Consent prompt, off switch, `0700` output |

That is the whole package — three scripts, no binaries, no installers, nothing that runs on its
own. Everything the documentation above describes is in these files, and everything in these files
is described above. If you find a claim here that the code does not do, that is a bug — open an
issue on [the repo](https://github.com/globalcaos/tinkerclaw/issues).
