# Backlink sources — auth, limits, when to use

Pick the source by what the target is and what auth is available.

## 1. `github` — repo referrers (works now, no extra auth)
- Target: `owner/repo` (e.g. `globalcaos/tinkerclaw`).
- Uses `gh api repos/<owner>/<repo>/traffic/popular/referrers` (gh must be authed; it is).
- **Caveat**: returns traffic REFERRERS (top ~10 sites that sent visitors), NOT a raw backlink list. Counts are views, not links. No SEO tool can isolate a path on github.com, so this is the only repo-scoped signal.
- Best for: the tinkerclaw repo.

## 2. `backlinks` — backlinks.sh (Common Crawl web graph)
- Target: a bare domain (`thetinkerzone.com`).
- Endpoint: `GET https://api.backlinks.sh/v1/backlinks?domain=<d>`, header `x-api-key: <key>`.
- Auth: env `BACKLINKS_SH_API_KEY`. Sign up at https://backlinks.sh — **3 free calls**, then pay-as-you-go (~$0.01/call, no subscription). 3 free = exactly our 3 domains for a one-time snapshot.
- Returns up to ~10k referring domains. Response shape is parsed defensively (backlinks/referring_domains/results array; string or object items). If the live shape differs, adjust `fromBacklinks` in the script.
- Best for: a real crawl-based backlink list for any owned site; one-shot audits.

## 3. `gsc-csv` — Google Search Console export (authoritative, free, owned sites only)
- Target: a domain we own and have verified in GSC (`thetinkerzone.com`, `sprintpaper.com`).
- GSC's **Links → Top linking sites** report lists every external site Google knows links to us — the authoritative free source, but only for properties we own/verify.
- This skill ingests a CSV **export** (no OAuth needed): in GSC open the property → Links → Top linking sites → Export → CSV, then run with `--source gsc-csv --csv <path>`.
- The CSV's first column is the linking site/domain; a later numeric column is the linking-pages count. Parser is tolerant of header variations.
- The online-presence cron has flagged missing GSC OAuth for 45+ days; the CSV path sidesteps that. Wiring full OAuth (service account / refresh token) would let this run unattended — a future upgrade.

## Classification (all sources)
Edit `assets/ours-allowlist.json`. A link is **ours** if its source host (and optional `path_prefix`) matches a rule; hosts in `ambiguous_domains` that no path rule resolves are reported **ambiguous** (e.g. a link from github.com could be our authored comment or someone else's — resolve from `engagement-state.json#github.known_comments`); everything else is **organic** (external).

## Feeding the pulse graph
`--write-state --target-key <tinkerclaw|thetinkerzone|sprintpaper>` writes `inbound_targets.<key>.{external,ours}` into `inbound-campaign-state.json`. The control-panel pollers read those into the Inbound-links graph (solid=external, dashed=ours, one hue per target). Ambiguous links are excluded from the written counts (they'd otherwise inflate "ours").
