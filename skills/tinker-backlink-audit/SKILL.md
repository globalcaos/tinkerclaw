---
name: tinker-backlink-audit
version: 1.2.0
description: 'Discover all inbound links (backlinks) to a domain, subdomain, or GitHub repo, then classify each as "ours" (we created/control the source) vs "organic" (someone else). Use when the user asks to find/audit backlinks or inbound links to a site, check who links to a domain or a GitHub repo, separate self-made links from organic ones, or refresh an inbound-links graph. Wraps four sources (GitHub repo referrers, a list of URLs you found, the backlinks.sh Common-Crawl API, and a Google Search Console CSV export) behind one classify-and-report CLI. Two of the four need no account at all; the one optional API key is stored in your OS keychain and cleared by --logout. Your list of own surfaces lives in your config, not in the package. Built for the TinkerClaw fork — github.com/globalcaos/tinkerclaw. See Permissions, Data Flow & Consent.'
metadata:
  openclaw:
    emoji: "🔗"
    os: ["linux", "darwin"]
    requires:
      bins: ["node"]
    notes:
      security: "A read-mostly link classifier. Two of its four sources (urls, gsc-csv) make no network call at all; `github` shells out to the `gh` CLI you already authenticated, and `backlinks` is the only one that uses a credential — a backlinks.sh API key, resolved from BACKLINKS_SH_API_KEY (transient) or the OS keychain (secret-tool/security) — and from nowhere else. There is NO plaintext fallback: if no keychain is available `--login` refuses and writes nothing, rather than silently downgrading a long-lived API key to a file on disk. A credentials.json left by an older version is detected and explained but never read as a credential, and `--logout` still deletes it. The key reaches the keychain on stdin on both platforms (macOS uses `security -i` so it is never an argv element visible in `ps`); `--logout` prints where to revoke it server-side. Nothing is written outside the skill folder unless you pass a flag: `--write-state` updates one JSON file (by default under ~/.openclaw/workspace/memory/online-presence/), and scripts/build-history.mjs writes to your control-panel store only with --yes (bare, it is a dry run). Neither write runs from the shipped placeholder data. No telemetry, no third-party endpoint beyond api.backlinks.sh, no source-tree patching, no privilege escalation. See the Permissions, Data Flow & Consent section."
    # Declared capabilities. Each is used for exactly the reason given; anything not
    # listed here, the skill does not do.
    permissions:
      network:
        required: false
        scope: "Only two sources reach the network, and only when you select them: `--source backlinks` calls the hardcoded constant https://api.backlinks.sh/v1/backlinks (your key in an x-api-key header), and `--source github` runs the `gh` CLI, which talks to api.github.com. `--source urls` and `--source gsc-csv` are fully offline. No telemetry, no analytics, no other endpoint."
      shell:
        required: true
        scope: "Three external binaries, each for one job: `gh` (GitHub referrer API), `secret-tool` or `security` (keychain get/set/clear), and the gateway CLI (`openclaw` by default, or the one named by --cli; only in scripts/build-history.mjs, only with --yes). No shell interpreter is invoked; arguments are passed as an argv array, never interpolated into a command string."
      env_read:
        required: false
        scope: "BACKLINKS_SH_API_KEY (the optional credential), plus three path overrides that carry no secret: BACKLINK_AUDIT_ALLOWLIST, BACKLINK_AUDIT_STATE, BACKLINK_AUDIT_SERIES. No env file is read or sourced."
      credentials:
        required: false
        scope: "One optional secret: your backlinks.sh API key, needed only by `--source backlinks`. It lives in the OS keychain (service backlinks-sh, account api-key) or in the BACKLINKS_SH_API_KEY environment variable, and nowhere else — there is no plaintext file fallback and none is ever written. The key is sent only to api.backlinks.sh, is never logged, never placed on a command line on either platform, and `--logout` removes it locally."
      file_read:
        required: true
        scope: "Your allowlist (--allowlist, BACKLINK_AUDIT_ALLOWLIST, ~/.config/backlink-audit/ours-allowlist.json, assets/ours-allowlist.json, or the shipped assets/ours-allowlist.example.json — first one found), the CSV given to --csv, the file given to --urls-file, the state file it is about to update, the history-series file build-history.mjs sends (same lookup order, *series* names), and — only to tell you it is stale — the presence of a legacy ~/.config/backlinks-sh/credentials.json."
      file_write:
        required: false
        scope: "Off unless you ask, and it never writes a credential anywhere. `--write-state` writes inbound_targets.<key> into the state file (--state, else BACKLINK_AUDIT_STATE, else ~/.openclaw/workspace/memory/online-presence/inbound-campaign-state.json; created if absent), and refuses while the allowlist is the placeholder example. `--login` writes only to the OS keychain, and refuses outright if there is not one. scripts/build-history.mjs writes dated points to your control-panel store, only with --yes, and never from the placeholder example series."
      file_delete:
        required: false
        scope: "Exactly one path, only on explicit command: `--logout` deletes a legacy ~/.config/backlinks-sh/credentials.json if an older version left one. No other file is ever removed, and the scripts contain no recursive or glob delete. The only recursive deletes in the package are the two test suites removing the mktemp directories they created."
repository: https://github.com/globalcaos/tinkerclaw
homepage: https://github.com/globalcaos/tinkerclaw
---

# Backlink Audit

> One of dozens of skills and plugins in **[TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — a self-improving OpenClaw fork that's been running 24/7 for months.

**Who actually links to you — and how much of that did you build yourself?**

Every backlink report you can buy gives you one number. That number is two very different things added together: links strangers made because your work was worth linking, and links you made because you were doing your own marketing. The first is traction. The second is homework. A tool that adds them up is telling you a flattering lie.

This one separates them. You get `ours`, `organic`, and an honest `ambiguous` bucket for the cases a hostname genuinely cannot settle — because a link from `github.com` might be your comment or a stranger's, and pretending otherwise is how a growth chart starts lying to you.

Two of the four sources need no account and no key. The one that does keeps it in your OS keychain — or refuses to store it at all, rather than dropping an API key into a file in the clear — and hands you a `--logout` that actually removes it.

## Overview

Finding inbound links and telling "ours" from "organic" is two jobs: (1) get a link list from a real index, (2) match each source against surfaces you control. This skill does both via `scripts/backlink-audit.mjs` and an allowlist you own.

## Set up your allowlist first

The list of surfaces you control is **your data**, so the package ships only a placeholder: `assets/ours-allowlist.example.json`. Make your own once:

```bash
mkdir -p ~/.config/backlink-audit
cp {baseDir}/assets/ours-allowlist.example.json ~/.config/backlink-audit/ours-allowlist.json
# edit it: your domains, your GitHub/GitLab/registry handles as path_prefix rules,
# your authored third-party threads in ours_urls — then delete the "_example" key
```

The tool looks for it in this order, first match wins:

| #   | Where                                           | Notes                                                          |
| --- | ----------------------------------------------- | -------------------------------------------------------------- |
| 1   | `--allowlist <path>`                            | explicit; a missing file is an error, never a fallback         |
| 2   | `BACKLINK_AUDIT_ALLOWLIST=<path>`               | explicit; same rule                                            |
| 3   | `~/.config/backlink-audit/ours-allowlist.json`  | the recommended home                                           |
| 4   | `assets/ours-allowlist.json` beside the scripts | for a private install; git-ignored by the skill's `.gitignore` |
| 5   | `assets/ours-allowlist.example.json`            | placeholders — warns on every run, and `--write-state` refuses |

A file that still carries `"_example": true` counts as the example wherever it sits, so a copy you forgot to edit cannot feed your graph.

## Quick start

```bash
S={baseDir}/scripts/backlink-audit.mjs

# GitHub repo (works now — no extra auth; referrers, not raw backlinks)
node "$S" your-user/your-repo --source github

# Discovered links (poor-man's backlink finder, works now): web-search the target
# term yourself, collect referring URLs, classify them — best source at small scale
node "$S" your-user/your-repo --source urls --urls "https://a.example/x,https://b.example/y"

# Any owned domain via backlinks.sh (needs a key; 3 free calls, then ~$0.01/call)
BACKLINKS_SH_API_KEY=… node "$S" example.com --source backlinks --json

# Owned site, authoritative + free: export GSC Links→Top linking sites to CSV, then
node "$S" example.com --source gsc-csv --csv ./gsc-export.csv

# Feed the Inbound-links pulse graph for one target (the key is any short name you pick):
node "$S" your-user/your-repo --source github --write-state --target-key my-repo
```

Storing the one optional credential, and taking it back:

```bash
printf %s "$BACKLINKS_SH_API_KEY" | node "$S" --login   # → OS keychain (stdin, never argv)
node "$S" --logout                                      # → clears the keychain (and any legacy file)
```

## Choosing a source

| Target                      | Source      | Auth                    | Cost                           | Notes                                                                                    |
| --------------------------- | ----------- | ----------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| GitHub repo                 | `github`    | none (`gh`)             | free                           | referrers/traffic proxy, repo-scoped                                                     |
| Anything                    | `urls`      | none                    | free                           | classify a list of links you found (e.g. via web search); works now, best at small scale |
| Owned domain, one-shot      | `backlinks` | backlinks.sh API key    | 3 free calls, then ~$0.01/call | Common-Crawl backlink list                                                               |
| Owned domain, authoritative | `gsc-csv`   | a CSV export (no OAuth) | free                           | Google's own link report                                                                 |

Read `references/sources.md` before picking — it has the auth setup, the backlinks.sh signup/limits, how to export the GSC CSV, and the per-source caveats.

## Classify: ours vs organic

A link is **ours** if its source host (+ optional `path_prefix`) matches a rule in your allowlist; hosts listed in `ambiguous_domains` with no resolving path-rule are reported **ambiguous** (e.g. a github.com link could be a comment you wrote or a stranger's — resolve it by hand, then pin the resolved URL in `ours_urls`); everything else is **organic**. Keep the allowlist current as new owned surfaces appear.

Build `ours_urls` from a search, not from memory: `gh search issues --include-prs --author <your-login>` and `gh search issues --include-prs --commenter <your-login>`, then open each thread and confirm the link is there and live.

## Feed the pulse graph

`--write-state --target-key <key>` writes `inbound_targets.<key>.{external,ours}` into `inbound-campaign-state.json`; the TinkerClaw pulse panel (the `tinkerclaw-pulse-panel` plugin) renders it (solid=external, dashed=ours, one hue per target). Without that plugin the file is still written and the printed report is the whole result. Ambiguous links are excluded from the written counts. Without `--write-state` the tool writes nothing at all — it just prints.

The default file is `~/.openclaw/workspace/memory/online-presence/inbound-campaign-state.json`, the directory the pulse panel's `localstate:` poller reads; point a panel metric at `localstate:inbound-campaign-state.json#inbound_targets.<key>.external`. `--state <path>` or `BACKLINK_AUDIT_STATE` write somewhere else instead, for your own tooling (the panel will not see it there). The key, the allowlist and the placeholder check are all validated before any source runs, so a typo never costs a paid call.

## Count strategy (how many backlinks do we have?)

At small scale, crawl indexes (backlinks.sh/Common Crawl) return ~0 for new sites, so the **search strategy** is the workhorse. To count inbound links to a target:

1. Web-search the target several ways: your repo URL in quotes (`"github.com/<you>/<repo>"`), the bare project name, your domain in quotes (`"<your-domain>"`), plus `site:`-excluded variants to find third-party mentions.
2. Collect the distinct referring URLs (one page = one backlink; dedupe).
3. `node scripts/backlink-audit.mjs <target> --source urls --urls "u1,u2,…"` → ours/organic/ambiguous counts.
4. `--write-state --target-key <k>` to push the count to the graph.

## Historical dataset (when did each backlink go live?)

`scripts/build-history.mjs` writes **dated cumulative `ours` observations** so the graph shows real growth, not just today. The dataset is yours and lives in a JSON file, looked up like the allowlist: `--series <path>`, `BACKLINK_AUDIT_SERIES`, `~/.config/backlink-audit/history-series.json`, `assets/history-series.json` (git-ignored), then the placeholder `assets/history-series.example.json`. Each metric id is `graph.inbound.<target-key>.ours`, holding `{date, cumulative, note}` points.

Derive the points (never invent them) from:

- **Authored third-party threads**: `gh search issues --include-prs --author <your-login>` (and `--commenter`), keep threads whose comment holds a live link to you, date each by its first link-bearing comment (`gh api repos/<r>/issues/<n>/comments`). One thread = one linking page.
- **`git log -S "<domain>"`** in the linking repo → when an outbound link to your site (e.g. README→yourdomain) first went live.
- **Registry listings** (skill or package registries): dated by listing creation, noting the assumption that the README link was there from publish.

Re-derive by re-running those mines, updating your series file, and re-running the script.

It is **opt-in**: bare (or with `--dry-run`) it prints exactly what it would write and writes nothing; `--yes` is what actually sends the points, via `openclaw gateway call control-panel.record` (`--cli tinkerclaw`, or any path, to use another CLI name). `--yes` refuses to send the placeholder example. It exits non-zero if any point fails to write.

## Failures overcome

- **2026-06-10 — the first growth curve under-counted by two thirds.** It knew 6 authored third-party threads. A full `gh search issues` by author and by commenter found 19 with a live link. Hence: build `ours_urls` and the series from a search, never from what you happen to know.
- **2026-06-10 — "external = 3" was fiction.** The graph showed 3 organic links. Re-verified page by page, the real count was 0: two skill-directory sites among them did not link the repo at all. Hence: open every claimed organic link before it goes on a graph.
- **2026-06-10 — a look-alike domain was not ours.** A .com carrying the project's exact name turned out to be a third party's commercial white-label service. It is easy to add such a domain to the allowlist on the strength of its name, and that inflates "ours" with a stranger's pages. Hence the `_lookalike_note` in the example: confirm ownership before adding a domain.
- **2026-06-10 — a cumulative count went down.** A doc page was cut to a stub and lost its link, so the linking-page count dropped by one. The series records the drop instead of holding the old peak.

## Permissions, Data Flow & Consent

Short version: this reads public link data, classifies it against a list you keep, and prints the result. Two of its four sources never touch the network. The one credential it can use is optional, keychain-first, and revocable. Longer version, because you should not have to take that on trust:

**What data it touches.** Referring URLs — from the GitHub traffic API, from a list you paste, from a CSV you exported, or from backlinks.sh. Plus your allowlist and, for the history script, your series file. That is the whole input surface. It does not read your repos, your mail, your browser, your shell history or your source tree.

**What leaves your machine.** Only what the source you picked requires:

- `--source urls` and `--source gsc-csv`: **nothing**. Fully offline; the CSV is parsed locally.
- `--source github`: the `gh` CLI you already authenticated calls `api.github.com` for your repo's referrer list.
- `--source backlinks`: one HTTPS GET to `https://api.backlinks.sh/v1/backlinks?target=<domain>` with your API key in an `x-api-key` header. The URL is a constant in the script, not something the target string can redirect.

There is no telemetry, no analytics, no "phone home", and no other endpoint anywhere in the code.

**What it costs.** Nothing, except `--source backlinks`: backlinks.sh gives 3 free calls, then charges roughly $0.01 per call. Every other source is free. Nothing subscribes you to anything.

**What credentials it reads.** One, optional: your backlinks.sh API key, and only for `--source backlinks`. There are exactly two places it can come from — `BACKLINKS_SH_API_KEY` (transient, nothing on disk) or your **OS keychain** (`secret-tool` on Linux, `security` on macOS; service `backlinks-sh`, account `api-key`).

**There is no plaintext fallback, by design.** An earlier version wrote the key to `~/.config/backlinks-sh/credentials.json` when no keychain was present, warning on every use. A warning is not a control: the thing it warned about was still a long-lived API key sitting in the clear, readable by anything running as you. Now `--login` **refuses** when there is no keychain and writes nothing, telling you to install libsecret or pass the key per-run through the environment. If an older version left a file behind, it is detected and explained — so you learn why your key stopped working — but it is never read as a credential, and `--logout` still deletes it.

`--login` reads the key from **stdin**, never from argv, because argv is visible in `ps`. That now holds on **both** platforms: macOS `security add-generic-password -w <key>` would have put the key in an argv element, so the key is piped to `security -i` instead and the entry is verified by reading it back (`-i` exits 0 even when a command inside it fails).

**The off switch.** `node scripts/backlink-audit.mjs --logout` clears the keychain entry **and** deletes any legacy plaintext file, tells you which of the two actually existed, and reminds you if `BACKLINKS_SH_API_KEY` is still set in your environment (it cannot reach into your shell to unset it). Local removal does not revoke the key server-side — rotate or delete it in your backlinks.sh account at https://backlinks.sh.

**What it needs, and why.**

| Capability       | Why                                                                                                       | Scope                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Network          | Fetch the link list                                                                                       | `api.backlinks.sh` (constant URL) and `api.github.com` via `gh` — only for those two sources                                    |
| Local shell exec | `gh`, `secret-tool`/`security`, the gateway CLI                                                           | argv arrays, no shell interpreter, no string interpolation                                                                      |
| Env read         | `BACKLINKS_SH_API_KEY`; path overrides `BACKLINK_AUDIT_ALLOWLIST` / `_STATE` / `_SERIES`                  | those four variables; no env file is sourced                                                                                    |
| Credential read  | backlinks.sh API key                                                                                      | env var or OS keychain only — no file fallback; sent only to `api.backlinks.sh`                                                 |
| File read        | Your allowlist and series file, your `--csv` / `--urls-file`, the legacy credentials file, the state file | the paths you name or configure, plus those fixed ones                                                                          |
| File write       | `--write-state` state file; `build-history.mjs --yes`                                                     | **both are opt-in**, both refuse placeholder data; nothing is written on a plain run, and no credential is ever written to disk |
| File delete      | `--logout` removes the legacy credentials file                                                            | that single path — the scripts have no recursive or glob delete (the test suites remove only their own mktemp dirs)             |

**The consent steps, and what each is protecting you from:**

```bash
node "$S" <target> --source urls --urls "…"              # reads nothing, writes nothing, sends nothing
node "$S" <target> --source backlinks                    # spends a paid API call, sends your key
node "$S" <target> --source github --write-state --target-key k   # writes one JSON file (default under ~/.openclaw)
node scripts/build-history.mjs                           # DRY RUN — prints what it would write
node scripts/build-history.mjs --yes                     # actually writes to your control-panel store
node "$S" --logout                                       # removes the stored key
```

**Read it before you run it.** `scripts/backlink-audit.mjs` is ~370 lines of plain Node and `scripts/build-history.mjs` about 130. `tests/test-credentials.sh` runs the tool against stub `secret-tool`/`security` executables in a temp dir and aborts if a real keychain binary is reachable, so running it never changes your stored key. It also preloads a fake `fetch()`, so the suite makes no network request. `tests/test-config.sh` copies the scripts and the two example files into a temp dir, points `HOME` there, and checks the allowlist/series/state lookup order and the placeholder refusals; its gateway CLI is a stub, and it aborts if a real `openclaw` could be reached. Both suites delete only their own temp dirs. Every claim above is visible in them. That is the whole security model: short enough to audit over a coffee.

## Changelog

- 1.2.0 — Owner data moved out of the package. The allowlist and the history series are now read from your config (`--allowlist` / `BACKLINK_AUDIT_ALLOWLIST` / `~/.config/backlink-audit/`, and the `--series` equivalents); only `*.example.json` placeholders ship, marked `"_example": true`. `--write-state` and `build-history.mjs --yes` refuse placeholder data. `--write-state` takes any validated `--target-key` and an optional `--state` path (`BACKLINK_AUDIT_STATE`), and checks its inputs before any source runs. `build-history.mjs` gains `--cli` and exits non-zero on a partial write. New `tests/test-config.sh`.
- 1.1.3 — `tests/test-credentials.sh` no longer calls api.backlinks.sh (fake `fetch()` preloaded, request shape asserted offline); SKILL.md now states the test's temp-dir cleanup is the package's only recursive delete.
- 1.1.2 — `tests/test-credentials.sh` no longer reaches the real OS keychain (stub keychain binaries on PATH, hard abort otherwise); `references/sources.md` no longer describes the removed plaintext-file fallback.

## Honest limits

- No SEO tool isolates a _path_ on github.com → repos only get referrer data, not raw backlinks.
- Free backlink web UIs (OpenLinkProfiler, Semrush, Majestic) are JS-rendered with no free API; not scriptable here.
- New/small sites have thin coverage in any crawl index — expect sparse results until they accrue links.
- The `ambiguous` bucket is a real answer, not a failure. A hostname alone cannot tell your comment from a stranger's; resolving it takes a human, and the tool refuses to guess in your favour.
- The classification is only as good as your allowlist. With the placeholder example, almost everything comes out "organic"; the tool says so on every run.

---

**Part of [TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — real-time token tracking, self-improving crons, persistent cognitive memory. This is one piece of that stack; the repo has dozens more.

👉 **https://github.com/globalcaos/tinkerclaw**

_Clone it. Fork it. Break it. Make it yours._
