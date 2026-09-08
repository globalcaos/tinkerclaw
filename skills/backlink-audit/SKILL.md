---
name: backlink-audit
description: Discover all inbound links (backlinks) to a domain, subdomain, or GitHub repo, then classify each as "ours" (we created/control the source) vs "organic" (someone else). Use when the user asks to find/audit backlinks or inbound links to a site, check who links to thetinkerzone.com / sprintpaper.com / a tinkerclaw repo, separate self-made links from organic ones, or refresh the Inbound-links pulse graph. Wraps three sources (GitHub repo referrers, the backlinks.sh Common-Crawl API, and a Google Search Console CSV export) behind one classify-and-report CLI.
---

# Backlink Audit

## Overview

Finding inbound links and telling "ours" from "organic" is two jobs: (1) get a link list from a real index, (2) match each source against surfaces we control. This skill does both via `scripts/backlink-audit.mjs` and an editable allowlist.

## Quick start

```bash
S=~/.openclaw/workspace/skills/backlink-audit/scripts/backlink-audit.mjs

# GitHub repo (works now — no extra auth; referrers, not raw backlinks)
node "$S" globalcaos/tinkerclaw --source github

# Discovered links (poor-man's backlink finder, works now): web-search the target
# term yourself, collect referring URLs, classify them — best source at small scale
node "$S" globalcaos/tinkerclaw --source urls --urls "https://a.com/x,https://b.com/y"

# Any owned domain via backlinks.sh (needs BACKLINKS_SH_API_KEY; 3 free calls)
BACKLINKS_SH_API_KEY=… node "$S" thetinkerzone.com --source backlinks --json

# Owned site, authoritative + free: export GSC Links→Top linking sites to CSV, then
node "$S" sprintpaper.com --source gsc-csv --csv ./gsc-export.csv

# Feed the Inbound-links pulse graph for one target:
node "$S" globalcaos/tinkerclaw --source github --write-state --target-key tinkerclaw
```

## Choosing a source

| Target | Source | Auth | Notes |
|---|---|---|---|
| GitHub repo | `github` | none (gh) | referrers/traffic proxy, repo-scoped |
| Anything | `urls` | none | classify a list of links you found (e.g. via web search); works now, best at small scale |
| Owned domain, one-shot | `backlinks` | `BACKLINKS_SH_API_KEY` (3 free) | Common-Crawl backlink list |
| Owned domain, authoritative | `gsc-csv` | a CSV export (no OAuth) | Google's own link report |

Read `references/sources.md` before picking — it has the auth setup, the backlinks.sh signup/limits, how to export the GSC CSV, and the per-source caveats.

## Classify: ours vs organic

Edit `assets/ours-allowlist.json`. A link is **ours** if its source host (+ optional `path_prefix`) matches a rule; hosts listed in `ambiguous_domains` with no resolving path-rule are reported **ambiguous** (e.g. a github.com link could be our authored comment or a stranger's — resolve from `engagement-state.json#github.known_comments`); everything else is **organic**. Keep the allowlist current as new owned surfaces appear.

## Feed the pulse graph

`--write-state --target-key <tinkerclaw|thetinkerzone|sprintpaper>` writes `inbound_targets.<key>.{external,ours}` into `inbound-campaign-state.json`; the control-panel pollers render it (solid=external, dashed=ours, one hue per target). Ambiguous links are excluded from the written counts.

## Count strategy (how many backlinks do we have?)

At our scale, crawl indexes (backlinks.sh/Common Crawl) return ~0 for new sites, so the **search strategy** is the workhorse. To count inbound links to a target:
1. Web-search the target term several ways: `"github.com/globalcaos/tinkerclaw"`, `tinkerclaw`, `"thetinkerzone.com"`, plus `site:` excluded variants to find third-party mentions.
2. Collect the distinct referring URLs (one page = one backlink; dedupe).
3. `node scripts/backlink-audit.mjs <target> --source urls --urls "u1,u2,…"` → ours/organic/ambiguous counts.
4. `--write-state --target-key <k>` to push the count to the graph.

## Historical dataset (when did each backlink go live?)

`scripts/build-history.mjs` writes **dated cumulative `ours` observations** so the graph shows real growth, not just today. Its dataset is *derived* (not invented) from:
- **Authored GitHub comments**: `gh api repos/<r>/issues/<n>/comments`, filter `user.login=globalcaos`, body contains our URL → dated by each thread's first backlink-bearing comment (one thread = one linking page).
- **`git log -S "<domain>"`** in the linking repo → when an outbound link to our site (e.g. README→thetinkerzone.com) first went live.

Re-derive by re-running those two mines, update `EVENTS` in the script, re-run. (Built 2026-06-05: tinkerclaw.ours 1@2026-02-11 → 6@2026-03-17; thetinkerzone.ours 1@2026-02-14.)

## Honest limits

- No SEO tool isolates a *path* on github.com → repos only get referrer data, not raw backlinks.
- Free backlink web UIs (OpenLinkProfiler, Semrush, Majestic) are JS-rendered with no free API; not scriptable here.
- New/small sites have thin coverage in any crawl index — expect sparse results until they accrue links.
