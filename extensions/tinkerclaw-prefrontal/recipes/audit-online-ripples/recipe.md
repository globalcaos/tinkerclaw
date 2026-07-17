---
schema: "kit/1.0"
slug: "audit-online-ripples"
title: "Audit Online-Presence Ripples & Staleness"
summary: 'Trace every public surface we control (README, ClawHub pages, thetinkerzone posts, the Tinker UI in-app links, Moltbook, GitHub threads, extension READMEs, social), map the links between them, and flag at a glance what has drifted stale — wrong counts, old model names, dead links, broken anchors, mis-pointed UI links, missing concept hero images, ClawHub skills published behind their local source, ClawHub skills flagged "review"/potentially-malicious by the audit bot.'
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "analysis"
tags:
  [
    "analysis",
    "online-presence",
    "staleness",
    "links",
    "dependency-graph",
    "entanglement",
    "ripples",
    "audit",
    "marketing",
    "readme",
    "thetinkerzone",
    "clawhub",
    "online presence audit",
    "what has become stale",
    "trace our links",
    "online ripples audit",
    "entanglement audit",
    "dependency graph of our content",
    "stale links check",
    "which of our pages is out of date",
    "audit our online footprint",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
    - [5]
    - [6]
    - [7]
---

# Audit Online-Presence Ripples & Staleness

> Trace every public surface we control (README, ClawHub pages, thetinkerzone posts, the Tinker UI in-app links, Moltbook, GitHub threads, extension READMEs, social), map the links between them, and flag at a glance what has drifted stale — wrong counts, old model names, dead links, broken anchors, mis-pointed UI links, missing concept hero images, ClawHub skills published behind their local source, ClawHub skills flagged "review"/potentially-malicious by the audit bot.

## Routes (the link graph we keep current)

The funnel is a directed graph; each arrow is a staleness dependency this audit re-checks:

- **ClawHub skill page → GitHub repo** (each `SKILL.md` → `github.com/globalcaos/tinkerclaw`)
- **Local skill source → ClawHub published version** (each owned `SKILL.md`/plugin manifest we improved → the version live on clawhub.ai). This is a publish-lag staleness edge: we edit the source but forget to re-publish, so the public page serves an older skill than we run. The actuator is the `clawhub-publish` skill (lifecycle step 2, "diff published vs repo, re-publish the newest").
- **GitHub README → thetinkerzone posts** (the J-series paper links + the funnel boxes)
- **Tinker UI → thetinkerzone posts** (NEW 2026-06-24, bible §5.8k): `tinker-ui/src/app.ts` `ZONE_DOCS` map + `fractal-dock.ts` chip → `thetinkerzone.com/?p=<ID>`. Each always-visible panel (Models→slider, EEG, RECIPES→recipe-book+prefrontal, Amygdala, Fractal) links to its explainer/paper post. These are in-app links by STABLE `?p=ID`, so they break if a post is deleted or a concept is re-pointed to the wrong paper — both are this audit's job to catch.
- **thetinkerzone post → {README, Tinker UI}** downstream consumers — a post's existence/topic is depended on by both, so a post change ripples to both.

## Goal

Produce, on demand, two things: (1) a dependency graph of our public surfaces and the links between them, so we can see the entanglement of our online presence at a glance; and (2) a staleness report that flags every claim that has drifted from ground truth (counts, versions, model names, dates) plus every dead link or orphan surface. The headline deliverable is a **beautiful self-contained HTML dashboard** (Step 7b) — a glanceable, severity-sorted audit the user opens in one click, with the markdown file as backing detail. Read-only: it proposes the de-stale edits, it does not rewrite the surfaces.

## When to Use

- Before publishing or cross-linking content, to see what links to what and what would break.
- Periodically (or after a paper/skill release) to catch surfaces that have gone stale.
- When tightening the funnel — increasing entanglement between README, ClawHub, and thetinkerzone.

## Steps

### 1. Load the ripple inventory (seed nodes)

**Done when:** You have the canonical list of our public surfaces and their referring domains.

Read `~/.openclaw/workspace/memory/online-presence/inbound-campaign-state.json` — `inbound_inventory` and `inbound_targets` are the authoritative seed set: ClawHub skill pages, Moltbook posts, GitHub threads, the extension READMEs that link thetinkerzone, and the per-domain ours/external tallies. These are the graph's nodes. Note when the file was last audited (`last_run`) so you know how trustworthy the seed is.

Also load the **Tinker UI → thetinkerzone** link map as a seed node source: parse the `ZONE_DOCS` object in `~/src/tinkerclaw/tinker-ui/src/app.ts` (and the hard-coded `?p=198` chip in `fractal-dock.ts`) → a `{concept → post-ID}` set. This is the canonical list of in-app links; every entry is an edge to verify in Step 3 and resolve in Step 5. The single owner of this map is bible `tinker-ui.md` §5.8k.

### 2. Enumerate the live state of each surface

**Tools:** backlink-audit
**Done when:** Each surface has a current title/slug/last-modified pulled from its live source, cached to a working file.

Pull the CURRENT live state per domain — never a mirror or a cached CLI 'not found'. thetinkerzone: `GET https://thetinkerzone.com/wp-json/wp/v2/posts?status=publish&per_page=100&_fields=id,slug,link,title,modified` — the `modified` date per post is the freshness signal. ClawHub: the rendered clawhub.ai pages (browser relay) or the installed-skill catalog. The repo: `git grep -nE 'https?://' README.md docs/ extensions/*/README.md` for outbound links. The backlink-audit skill covers the INBOUND side (who links to us). Cache everything to `~/.openclaw/workspace/memory/online-presence/ripple-cache.json`.

For the **ClawHub published-version** check, enumerate every slug we've uploaded so far — the canonical list is `inbound_inventory.tinkerclaw.clawhub_pages` in the state file (Step 1) — and pull each one's PUBLISHED version + last-updated date read-only with `clawhub inspect <slug> --json` (the `Latest` tag + `Updated` field; this works WITHOUT `clawhub login`, since publishing is gated but reading is not). Plugins use `clawhub package`/the rendered page instead of `skill`, but the version field is the same. Cache `{slug → published_version, published_updated}` alongside the rest. Do NOT trust the CLI's "not found" for a slug that renders fine on clawhub.ai — fall back to the browser relay.

The durable gatherer for both ClawHub checks (version drift + audit status) lives at `assets/clawhub-scan.sh` — run it rather than re-improvising the loop in `/tmp` (it gets reaped between sessions). It already bakes in every tuning lesson: parse the text `Latest:` line (not `--json`, which emits nothing), backoff+retry per slug (rate-limiting causes false NOT_FOUND), `curl --compressed` + `grep -a` for the audit scrape (clawhub.ai serves gzip — without it the scrape reads as binary and silently returns nothing), and an explicit `slug→source` map for the cases where the folder name ≠ the slug (e.g. `smart-model-router` → `model-router`).

For the **ClawHub audit / "potentially malicious" status**, also capture each slug's ClawScan verdict. ClawHub runs an audit bot (clawsweeper / openclaw-barnacle) on every skill: the verdict surfaces in the page HTML as `<span class="security-audit-sidebar-verdict" data-status="...">`. **The real values are `benign` (clear) and `review` (flagged / potentially-malicious)** — NOT `pass`/`fail` (confirmed across three live runs 2026-06-26). A `review` skill is partly quarantined: it refuses `install` without `--force` and gets demoted/delisted from search. This is NOT in `clawhub inspect` (CLI shows version, not audit) — but it IS in the **static HTML**, so a plain `curl --compressed https://clawhub.ai/globalcaos/skills/<slug>` + grep of `data-status` reads it auth-free, **no browser relay needed** (the relay is only a fallback if the page goes JS-only). `clawhub skill verify <slug>` is a separate verification-evidence check (`card.missing` etc.), NOT the malicious flag — don't conflate them. Cache `{slug → audit_status}`. Reading is auth-free; only the FIX (rescan) needs `clawhub login`.

### 3. Extract the link graph (edges)

**Tools:** graphify
**Done when:** You have a node->[targets] adjacency list of every internal cross-link between our surfaces.

For each surface, parse its outbound links to OTHER surfaces we own and record directed edges: README -> paper posts / ClawHub pages / thetinkerzone / youtube / discord; each SKILL.md -> the tinkerclaw repo; each extension README -> thetinkerzone; **the Tinker UI `ZONE_DOCS` map + fractal-dock chip -> thetinkerzone `?p=<ID>` posts** (one edge per concept→post); Moltbook + GitHub threads -> repo and ClawHub slugs. The result is the entanglement graph — who depends on whom. Optionally hand the adjacency list to graphify for a visual + community clustering, so god-nodes (the README, the repo) are obvious.

### 4. Pull the claimed facts per node

**Done when:** Every count, version, model name, and timeframe asserted on any surface is captured with its location.

Walk each surface and extract the assertions that go stale over time: paper counts and badges, skill counts, cron counts, model names and versions, version badges, and 'N weeks/months running 24/7' phrases. Record each as (surface, location, claimed-value). These are the candidates the next step checks against reality.

### 5. Resolve ground truth for each claimed fact

**Done when:** Each claimed fact has a measured current value from an authoritative source.

Measure the real value: papers = thetinkerzone published paper-post count (+ `docs/papers/` in the repo + the J-series in `~/Documents/AI_reports/Papers/` for written-but-unposted); skills = the live ClawHub catalog; models = the routing/primary in `~/.openclaw/openclaw.json`; skill versions = the SKILL.md frontmatter; dates/timeframes = computed from the project start (~Feb 2026). An unreachable source resolves to UNKNOWN, never to a guessed value.

For the **ClawHub publish-lag** check specifically, the ground truth is the LOCAL source of each owned skill/plugin: its `SKILL.md` frontmatter `version` (or the plugin manifest version) in the workspace skills dir (`~/.openclaw/workspace/skills/<name>`) or the tinkerclaw repo. Resolve `{slug → local_version, local_mtime}` and pair it with the published `{slug → published_version}` from Step 2. When a skill carries no semver in frontmatter, fall back to comparing the local source's last-modified date against the published `Updated` date (local newer = candidate stale). Also list any owned skill/plugin whose source exists locally but whose slug is absent from the published list — that is an un-uploaded surface, not a drifted one.

### 6. Diff claimed vs truth into a staleness report

**Done when:** A glanceable table ranks every surface by staleness severity, with DRIFT / DEAD / ORPHAN tags.

Compare claimed vs measured and tag each: DRIFT (a count, version, model, or date that no longer matches), DEAD (a 404, a thetinkerzone `suspendedpage.cgi` body, or a broken in-page anchor), ORPHAN (a surface nothing links to, or that links to nothing of ours), STALE-SKILL (a ClawHub skill/plugin whose published version is BEHIND our local source — `published_version < local_version`, or local source modified after the published `Updated` date when no semver — i.e. we improved it but never re-published; action: re-publish via the `clawhub-publish` skill, lifecycle step 2), FLAGGED (a ClawHub skill/plugin whose audit status is `review` (potentially-malicious) rather than `benign` — the bot is partly quarantining it; this is the highest-severity ClawHub tag, sort it to the TOP. Action: triage the flagged ClawScan patterns and fix the real ones, then `clawhub skill rescan <slug>` / `clawhub package rescan <name>` to clear it [needs `clawhub login`]; if it's the known false-positive spam flag — the 2026-05 `*-ultimate` bulk-name delist — follow the reinstatement path in the `clawhub-publish` skill, don't just plead), UNPUBLISHED (an owned skill/plugin with local source but no live ClawHub page yet; action: publish if it's a public-worthy surface, else ignore), MISPOINTED (a Tinker UI `ZONE_DOCS` entry whose post ID 404s OR resolves to a post whose topic no longer matches the concept it's linked from — e.g. `eeg → 448` but post 448 is no longer the EEG explainer), NO-HERO (a paper/explainer post with no concept hero image at the top of its body, or whose featured image is a first-page PDF screenshot rather than a napkin.ai concept image representing the paper's whole contribution). Sort by severity. Emit one at-a-glance table: surface | claim | truth | status — plus a one-line 'freshness verdict' per domain. An unreachable source is UNKNOWN, flagged for re-check, not asserted stale.

For the **tinker-ui route**, resolve each `ZONE_DOCS` post ID via `GET /wp-json/wp/v2/posts/<id>?_fields=id,status,title` — confirm it's `publish` AND its title still matches the concept the chip is attached to. For **hero images**, per paper/explainer post: (a) `featured_media != 0` (thumbnail set), and (b) the rendered content opens with an `<img>` whose source is a concept image (napkin-style), not a `*-page1*`/`*screenshot*`/first-page PDF render. Flag the misses for the napkin hero-image actuator (see `compile-paper` / the hero-image step), don't fix here.

### 7. Write the audit and propose the de-stale edits

**Done when:** A dated audit file holds the graph + staleness table + a concrete edit list, the matching **HTML report** is rendered and verified, and the state file's freshness is refreshed.

Persist the dependency graph and the staleness table to `~/.openclaw/workspace/memory/online-presence/ripple-audit-<YYYY-MM-DD>.md`, and update `inbound-campaign-state.json` with the new freshness snapshot. List the EXACT edits needed to de-stale each surface (file + line + old -> new), but do NOT apply them and do NOT publish/push — this recipe ends with a proposal the human approves.

### 7b. Emit the beautiful HTML audit report (the headline deliverable)

**Tools:** read, exec, visual-feedback
**Done when:** `ripple-audit-<YYYY-MM-DD>.html` exists, renders cleanly (verified by a screenshot), and is the artifact handed to the user.

The recipe's primary result is a **self-contained, glanceable HTML dashboard** — not a wall of markdown. Use the template at `assets/audit-report-template.html` (espresso/cream Tinker theme, severity-sorted): it renders itself from a single `const DATA = {…}` object near the top, so you ONLY swap that object — never touch the CSS/JS.

Fill `DATA` from the audit:

- `verdict`: `RED` if any **FLAGGED** or **DEAD**; else `AMBER` if any STALE-SKILL/DRIFT/UNPUBLISHED/MISPOINTED/NO-HERO/ORPHAN; else `GREEN`. `verdictNote` = the one-line headline (e.g. "1 skill flagged, 2 behind source").
- `stats`: severity-ordered tiles (Flagged → Stale → Drift/Dead → Clean), each `{k,n,acc}` where `acc` ∈ red/amber/green/blue.
- `checks`: the **coverage map — EVERY check category the audit can run, green ones included**, so the surface checked is visible at a glance and obvious when it grows. One entry per category `{name, desc, green?, amber?, red?, unknown?}` (omit a count that's 0; a category with NO counts renders as "not run" — show it anyway so the reader sees it exists). Cover at least: ClawHub audit status, ClawHub version drift, README claims, thetinkerzone posts, Tinker UI links, hero images, cross-surface links. This is the headline ask from 2026-06-26: don't hide passing checks — the green count is information.
- `links` (optional): cross-surface link health as a **summary only**, `{checked, ok, broken}` — never a full per-link list (the user explicitly wants the count, not the list). Omit if the link sweep wasn't run.
- `clawhub`: EVERY uploaded slug from `inbound_inventory.tinkerclaw.clawhub_pages`, each `{slug, published, local, status}` with `status` ∈ `FLAGGED`/`STALE-SKILL`/`UNPUBLISHED`/`PASS`, **severity-sorted so FLAGGED is first**.
- `findings`: every non-ClawHub surface row `{surface, loc, claim, truth, status, action}`, severity-sorted.
- `proposedEdits`: the exact `file:line old → new` list from Step 7.

Write the filled copy to `~/.openclaw/workspace/memory/online-presence/ripple-audit-<YYYY-MM-DD>.html`, then VERIFY it renders before claiming done — `node ~/.openclaw/jarvis-workspace/scripts/visual-feedback.mjs --html <that-file> --crop` and look at the PNG (the visual-feedback harness; see `[[reference_visual_feedback_harness]]`). A report that doesn't render is not a deliverable. Hand the user the HTML path (clickable) as the recipe's result; the markdown file is the backing detail.

## Constraints

- Verify live state on the real surface (thetinkerzone wp-json, clawhub.ai rendered) — never a mirror (clawskills.sh once fabricated a 4.5k count) or the CLI's cached 'not found'.
- ClawHub published-version reads are auth-free (`clawhub inspect <slug> --json`); only re-publishing needs `clawhub login`. So the STALE-SKILL detection always runs read-only — it proposes the re-publish, the human (or the `clawhub-publish` skill) does it. The canonical list of slugs we've uploaded is `inbound_inventory.tinkerclaw.clawhub_pages` — keep it in sync when we publish a new skill, or this check silently skips it.
- The "potentially malicious" / audit-`review` status is in the page HTML (`data-status`), not in `clawhub inspect` — resolve FLAGGED with a plain `curl --compressed` of the skill page (clawhub.ai serves gzip; without `--compressed`+`grep -a` the scrape reads as binary and silently returns nothing — the #1 way this check fails). Values are `benign`/`review`, not `pass`/`fail`. The browser relay is only a fallback. Expect false positives: a large share of our catalog (≈16 skills as of 2026-06) carries a `Review` flag from the 2026-05 over-protective spam-guard, not real malware — the recipe FLAGS them so they get triaged, but the verdict for each is "fix the real pattern OR clear the false positive via rescan/appeal," never an admission the skill is malicious. Re-publishing the same code KEEPS the flag; clearing it is a separate rescan pass.
- An unreachable source resolves to UNKNOWN, not stale — default-reject a staleness verdict unless ground truth is confirmed.
- Read-only: this audit proposes edits, it never rewrites or publishes a surface.
- Exclude private-repo mentions (~/.openclaw, jarvis-icu) — they are not public inbound and must never be surfaced as links.
- The Tinker UI link map (`ZONE_DOCS` in `app.ts`) is the single source of truth for in-app links and is owned by bible `tinker-ui.md` §5.8k — read it from source, never hard-code the concept→ID pairs here (they drift). Links use STABLE `?p=ID`, never slugs.
- A paper/explainer post's main image must be a napkin.ai concept image that represents the paper's whole contribution — NOT a screenshot of the PDF's first page. Both the featured (thumbnail) image and the in-body lead image should be that concept image.

## Safety Notes

- Never publish or push during the audit — it ends with a proposal, not a change.
- thetinkerzone is WordPress and has been intermittently suspended (a `suspendedpage.cgi` body) — an HTTP 200 with that body is DOWN; treat as a DEAD link, not a live one.
- Increasing cross-surface entanglement is the goal, but every new cross-link is a new staleness dependency — record it as an edge so the next audit re-checks it.

## Failures Overcome

- The README 'papers-11' badge undersold reality — 15 papers are live on thetinkerzone and 18 are written; counts drift silently without a truth check.
- The README linked in-repo docs/papers/\*.md instead of the thetinkerzone posts, weakening cross-domain entanglement and the funnel.
- Dead in-page anchors (#-every-paper-saves-you-tokens) and a once-suspended thetinkerzone went unnoticed because nothing audited liveness.
- Internal codenames (CEREBELLUM, ENGRAM) leaked into public copy where the public posts use different names — a link/identity mismatch.
- The Tinker UI started linking into thetinkerzone (2026-06-24, `ZONE_DOCS`) — a new in-app→public route. Without an audit edge, a deleted/retitled post would silently 404 a chip in the live UI; this audit now resolves every `ZONE_DOCS` ID and topic each run.
- A few paper posts shipped with the wrong image (post 237/264 had no in-body hero at all; others used a first-page PDF screenshot as the cover instead of a concept image) — thumbnails looked broken and the page opened with a wall of text or a tiny page-render. The NO-HERO check + the napkin concept-image policy fix this going forward.
- Published ClawHub skills silently fell behind their source: we improved a skill locally (whatsapp especially is ahead of what's published, per the `clawhub-publish` skill) but never re-published, so the public page served an older skill than we run — invisible until a user installed the stale version. The STALE-SKILL check (`clawhub inspect <slug>` published version vs local `SKILL.md` source) now surfaces every uploaded-so-far skill/plugin that has drifted behind, and UNPUBLISHED catches owned skills that never made it online at all.
- The gatherer's thetinkerzone count read UNREACHABLE on every run because it used plain `curl` — thetinkerzone sits behind Cloudflare's JA3 wall, which answers plain curl with a 403 "Just a moment..." challenge. The check looked like a transient outage but was a permanent false negative (16 paper posts were live the whole time). Fix: route the wp-json call through `curl_cffi` `impersonate="chrome"` (the same CF-bypass `wp.sh` uses; see `reference_tinkerzone_publish_cf_walled`). Any thetinkerzone read in this recipe must use curl_cffi, never plain curl.
- The gatherer redirect silently no-op'd: piping `clawhub-scan.sh > memory/online-presence/audit-online-ripples/scan-latest.txt` returned exit 0 on the _script_ but exit 1 on the _redirect_ because the output dir didn't exist — and the background task-notification reported the script's exit, not the shell's, so it read as a clean run with empty results. Before running the gatherer, `mkdir -p` the output dir (or write to a dir known to exist); never trust a green task-notification when the redirect target is unguaranteed.
- ClawHub's audit bot flagged ~16 of our skills "Review"/suspicious in the 2026-05 `*-ultimate` bulk-name episode (#314) and the catalog quietly demoted/delisted from search and refused install without `--force` — we only noticed when downloads cratered. The FLAGGED check now reads each uploaded skill's audit status every run and sorts any non-`pass` to the top, so a "potentially malicious" verdict surfaces immediately with the rescan/appeal action attached, instead of silently throttling the funnel. Caveat baked in: the status is a web-UI field invisible to `clawhub inspect`, so it must be read from the rendered Audits page — don't conclude `pass` just because the CLI is silent.
