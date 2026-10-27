# Forget

Some things you want gone for good, like a phone number you shared by mistake. This plugin finds every copy this
machine keeps of one fact, redacts the ones it can reach, and hands back a receipt that lists every place, including
the ones it cannot reach.

It loads by default in `preview` mode: it searches and reports, and changes nothing. Redaction needs `mode: "apply"`.

Config lives under `plugins.entries.tinkerclaw-forget.config` in `openclaw.json`. Every key and its default is in
`openclaw.plugin.json`.

## How to ask

The agent tool `forget` and the gateway method `memory.forget` take the same input:

| Key        | What it is                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `fact`     | The text to forget. At least 4 characters, at most 300.                                        |
| `variants` | Other spellings of the same fact, up to 5 (the number without its country code, a short name). |
| `label`    | A few words for the receipt ("my old phone number"). It must not contain the fact.             |
| `confirm`  | Empty for a preview. The code a preview returned, to forget for real.                          |

A number (digits with spaces, dots, dashes, brackets or a leading `+`, at least 6 digits) matches with any of those
separators between its digits, and never inside a longer run of digits. Text matches case-insensitively, any run of
whitespace for a space, as whole words.

Forgetting always takes two calls. The first is a preview: it finds every copy and changes nothing. In `apply` mode
it also returns a one-time `confirm` code, valid 15 minutes, kept in memory only, and bound to the same fact. The
second call passes that code back, and only then is anything rewritten. A broad match can hit more than you meant;
the preview is where you see that.

The tool is optional and owner-only. An agent sees it only when `tools.alsoAllow` (or `tools.allow`) names `forget`
or `tinkerclaw-forget`, and only for the owner's own, unsandboxed turns. The gateway method needs `operator.admin`.

```bash
# preview from a terminal
openclaw gateway call memory.forget --params '{"fact":"+34 600 11 12 22","label":"my old number"}' --timeout 600000
```

## The places

The receipt has one row per place. Each row is `done`, `found` (preview), `not present`, `out of reach` or `failed`,
and lists the files or stores behind it.

| Place            | What is swept                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The notes        | Each agent workspace's `*.md` files, `memory/`, `memorySearch.extraPaths`, Claude Code's `autoMemoryDirectory` and `~/.claude/projects/*/memory`, `<stateDir>/memory`, and `extraRoots`.                                                                                                   |
| Old versions     | `archive/` folders, `*ARCHIVE*`, `.bak` and `.orig` copies, transcript checkpoint, reset and deleted copies: redacted like the rest. The git history of every swept folder that is a repository is searched and reported: a redacted note is clean at HEAD, and old commits still hold it. |
| The search index | The engram transcript index behind `recall` drops each redacted transcript with SQLite `secure_delete`, reads it again, merges its full-text index and truncates its WAL. The memory search index behind `memory_search` re-syncs, and is rebuilt from scratch if a search still finds it. |
| Summaries        | Dreaming state (`memory/.dreams/`, `DREAMS.md`), consolidation logs, the memory wiki (`<stateDir>/wiki`), and the engram packs, reflections and artifacts.                                                                                                                                 |
| The chat record  | Gateway transcripts (`<stateDir>/agents/*/sessions/`), the engram event logs, and, with `claudeCode` on, Claude Code's transcripts and prompt history. Swept again 1 and 10 minutes after an apply, for the copies the request itself made.                                                |
| Backups          | Text files in `backupDirs` are redacted. Archives and encrypted bundles cannot be opened, so they are out of reach. Each git remote of a repository that held it is out of reach, and so is every entry in `remoteCopies`.                                                                 |
| The AI provider  | Always out of reach. The provider received every chat turn that held the fact, the request included, and keeps it under its own retention.                                                                                                                                                 |

A binary store (SQLite, vectors) is only read, never edited. After the owners rebuild their indexes, each store that
still holds the fact is out of reach, with a note to rebuild or delete it. Stores over `maxBinaryScanMB` are listed as
not searched. Anything outside the swept folders is not searched, and the receipt says which folders those were.

## What a redaction does

Each copy becomes `[forgotten YYYY-MM-DD]`. Every other byte of the file stays as it was. A JSONL record stays valid
JSON; a line that cannot be cleaned without breaking it is left alone and the place is marked `failed`. The new file
replaces the old one with a single rename, and if the file changed while it was being read (a live transcript), the
pass starts again. There is no backup copy, because a backup of a forgotten fact is one more copy of it.

## The receipt

An apply writes `<stateDir>/data/forget/receipts/<id>.json` and one line in `<stateDir>/data/forget/receipts.md`.
The follow-up passes are added to both. A receipt names files and counts copies. It never holds the fact, or a hash of
it, since a phone number's hash is brute-forced in seconds.

## Modes

| `mode`              | What happens                                                                        |
| ------------------- | ----------------------------------------------------------------------------------- |
| `preview` (default) | The tool and the method find every copy and return the receipt. Nothing is written. |
| `apply`             | The preview returns a confirm code; passing it back redacts.                        |
| `off`               | Nothing loads.                                                                      |

To turn redaction on:

```bash
openclaw config set plugins.entries.tinkerclaw-forget.config.mode apply
openclaw config set tools.alsoAllow '["forget"]' --strict-json   # merge with your existing list
openclaw gateway restart
```

## What it does not do

- It does not rewrite git history or delete remote backups. It tells you where they are.
- It finds the fact as written, in the spellings you give. A summary that paraphrases it ("his number ends in 22")
  is not found.
- It does not reach the model provider's copy. Nobody here can.
