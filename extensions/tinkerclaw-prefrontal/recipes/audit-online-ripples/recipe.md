---
schema: "kit/1.0"
slug: "audit-online-ripples"
title: "Audit Online-Presence Ripples & Staleness"
summary: "Trace every public surface we control (README, ClawHub pages, thetinkerzone posts, Moltbook, GitHub threads, extension READMEs, social), map the links between them, and flag at a glance what has drifted stale — wrong counts, old model names, dead links, broken anchors."
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
---

# Audit Online-Presence Ripples & Staleness

> Trace every public surface we control (README, ClawHub pages, thetinkerzone posts, Moltbook, GitHub threads, extension READMEs, social), map the links between them, and flag at a glance what has drifted stale — wrong counts, old model names, dead links, broken anchors.

## Goal

Produce, on demand, two things: (1) a dependency graph of our public surfaces and the links between them, so we can see the entanglement of our online presence at a glance; and (2) a staleness report that flags every claim that has drifted from ground truth (counts, versions, model names, dates) plus every dead link or orphan surface. Read-only: it proposes the de-stale edits, it does not rewrite the surfaces.

## When to Use

- Before publishing or cross-linking content, to see what links to what and what would break.
- Periodically (or after a paper/skill release) to catch surfaces that have gone stale.
- When tightening the funnel — increasing entanglement between README, ClawHub, and thetinkerzone.

## Steps

### 1. Load the ripple inventory (seed nodes)

**Done when:** You have the canonical list of our public surfaces and their referring domains.

Read `~/.openclaw/workspace/memory/online-presence/inbound-campaign-state.json` — `inbound_inventory` and `inbound_targets` are the authoritative seed set: ClawHub skill pages, Moltbook posts, GitHub threads, the extension READMEs that link thetinkerzone, and the per-domain ours/external tallies. These are the graph's nodes. Note when the file was last audited (`last_run`) so you know how trustworthy the seed is.

### 2. Enumerate the live state of each surface

**Tools:** backlink-audit
**Done when:** Each surface has a current title/slug/last-modified pulled from its live source, cached to a working file.

Pull the CURRENT live state per domain — never a mirror or a cached CLI 'not found'. thetinkerzone: `GET https://thetinkerzone.com/wp-json/wp/v2/posts?status=publish&per_page=100&_fields=id,slug,link,title,modified` — the `modified` date per post is the freshness signal. ClawHub: the rendered clawhub.ai pages (browser relay) or the installed-skill catalog. The repo: `git grep -nE 'https?://' README.md docs/ extensions/*/README.md` for outbound links. The backlink-audit skill covers the INBOUND side (who links to us). Cache everything to `~/.openclaw/workspace/memory/online-presence/ripple-cache.json`.

### 3. Extract the link graph (edges)

**Tools:** graphify
**Done when:** You have a node->[targets] adjacency list of every internal cross-link between our surfaces.

For each surface, parse its outbound links to OTHER surfaces we own and record directed edges: README -> paper posts / ClawHub pages / thetinkerzone / youtube / discord; each SKILL.md -> the tinkerclaw repo; each extension README -> thetinkerzone; Moltbook + GitHub threads -> repo and ClawHub slugs. The result is the entanglement graph — who depends on whom. Optionally hand the adjacency list to graphify for a visual + community clustering, so god-nodes (the README, the repo) are obvious.

### 4. Pull the claimed facts per node

**Done when:** Every count, version, model name, and timeframe asserted on any surface is captured with its location.

Walk each surface and extract the assertions that go stale over time: paper counts and badges, skill counts, cron counts, model names and versions, version badges, and 'N weeks/months running 24/7' phrases. Record each as (surface, location, claimed-value). These are the candidates the next step checks against reality.

### 5. Resolve ground truth for each claimed fact

**Done when:** Each claimed fact has a measured current value from an authoritative source.

Measure the real value: papers = thetinkerzone published paper-post count (+ `docs/papers/` in the repo + the J-series in `~/Documents/AI_reports/Papers/` for written-but-unposted); skills = the live ClawHub catalog; models = the routing/primary in `~/.openclaw/openclaw.json`; skill versions = the SKILL.md frontmatter; dates/timeframes = computed from the project start (~Feb 2026). An unreachable source resolves to UNKNOWN, never to a guessed value.

### 6. Diff claimed vs truth into a staleness report

**Done when:** A glanceable table ranks every surface by staleness severity, with DRIFT / DEAD / ORPHAN tags.

Compare claimed vs measured and tag each: DRIFT (a count, version, model, or date that no longer matches), DEAD (a 404, a thetinkerzone `suspendedpage.cgi` body, or a broken in-page anchor), ORPHAN (a surface nothing links to, or that links to nothing of ours). Sort by severity. Emit one at-a-glance table: surface | claim | truth | status — plus a one-line 'freshness verdict' per domain. An unreachable source is UNKNOWN, flagged for re-check, not asserted stale.

### 7. Write the audit and propose the de-stale edits

**Done when:** A dated audit file holds the graph + staleness table + a concrete edit list, and the state file's freshness is refreshed.

Persist the dependency graph and the staleness table to `~/.openclaw/workspace/memory/online-presence/ripple-audit-<YYYY-MM-DD>.md`, and update `inbound-campaign-state.json` with the new freshness snapshot. List the EXACT edits needed to de-stale each surface (file + line + old -> new), but do NOT apply them and do NOT publish/push — this recipe ends with a proposal the human approves.

## Constraints

- Verify live state on the real surface (thetinkerzone wp-json, clawhub.ai rendered) — never a mirror (clawskills.sh once fabricated a 4.5k count) or the CLI's cached 'not found'.
- An unreachable source resolves to UNKNOWN, not stale — default-reject a staleness verdict unless ground truth is confirmed.
- Read-only: this audit proposes edits, it never rewrites or publishes a surface.
- Exclude private-repo mentions (~/.openclaw, jarvis-icu) — they are not public inbound and must never be surfaced as links.

## Safety Notes

- Never publish or push during the audit — it ends with a proposal, not a change.
- thetinkerzone is WordPress and has been intermittently suspended (a `suspendedpage.cgi` body) — an HTTP 200 with that body is DOWN; treat as a DEAD link, not a live one.
- Increasing cross-surface entanglement is the goal, but every new cross-link is a new staleness dependency — record it as an edge so the next audit re-checks it.

## Failures Overcome

- The README 'papers-11' badge undersold reality — 15 papers are live on thetinkerzone and 18 are written; counts drift silently without a truth check.
- The README linked in-repo docs/papers/\*.md instead of the thetinkerzone posts, weakening cross-domain entanglement and the funnel.
- Dead in-page anchors (#-every-paper-saves-you-tokens) and a once-suspended thetinkerzone went unnoticed because nothing audited liveness.
- Internal codenames (CEREBELLUM, ENGRAM) leaked into public copy where the public posts use different names — a link/identity mismatch.
