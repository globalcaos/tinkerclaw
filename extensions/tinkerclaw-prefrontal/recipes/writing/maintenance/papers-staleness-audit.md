---
schema: recipe/1.0
id: papers-staleness-audit
title: Papers Staleness Audit
category: writing
summary: Read-only audit that finds NEW papers without a thetinkerzone.com post and LIVE posts gone stale because their source paper advanced past the version the post shows — emits a triage table with a recommended action per row
triggers:
  [
    check for new papers,
    detect staleness,
    stale posts,
    are our posts up to date,
    new papers locally,
    audit papers vs posts,
    which posts are stale,
  ]
effort: standard
tools: [read, glob, grep, exec]
children: [publish-paper-summary, revise-publish-batch, compile-paper]
---

## Goal

Answer two questions in one read-only pass, without changing anything:

1. **New papers** — which `~/Documents/AI_reports/Papers/J*_*` folders have NO post on thetinkerzone.com yet?
2. **Stale posts** — which LIVE posts reference an OLDER paper version than the folder's current latest (source moved on; the public page is behind)?

Output is a triage table: one row per paper, a verdict (`new` / `stale` / `not-ready` / `current`), and the concrete next step. It writes nothing and publishes nothing — it tells you what the publish/refresh sweep should do, then you decide.

## When to Use

- "Check for new papers and detect staleness in our posts."
- Before any publish or refresh sweep — so you act on a current diff, not a stale assumption about which posts exist.
- After revising a paper, to confirm whether its live post is now behind.

Not for: doing the publish/refresh itself. This is the **detector**; the actuators are `publish-paper-summary` (new papers) and `compile-paper` + a targeted post UPDATE (stale posts). A new or retired paper ALSO needs its marker on the interactive brain diagram (post 428) added/removed — that actuator is `brain-diagram-entry` (it generates the lit-region image + wires the data + republishes).

## Execution model

The executable is `recipes/writing/papers-staleness-audit.workflow.js` (the `Workflow` tool). One agent: scans every paper folder for its genuinely-latest version, queries the live Building Jarvis posts (category 29) for the PDF version each references, diffs the two, and returns structured rows + a summary. No args.

## Steps

### 1. Latest version per folder

**Tools:** glob, read, exec
**Done when:** Each `J*_*` folder mapped to its genuinely-latest `vX.Y` + date + whether a PDF exists at that version + whether `improvement_notes.md` is newer than the latest version (= pending notes)

The latest version is NOT always the highest-dated filename — an undated `<topic>.md` can carry a higher `vX.Y` header. Compare version headers across dated and undated candidates; ignore `*-review-*`, `*-critique*`, `sota-*`, `*-references*`, `diagram-*`, `improvement_notes*`.

### 2. Live posts + referenced version

**Tools:** exec
**Done when:** Every category-29 post mapped to a paper folder + the `vX.Y` its PDF link references

`GET /wp-json/wp/v2/posts?categories=29&status=publish,draft&context=edit` (auth from the wordpress-ultimate `.env`). Pull the PDF filename out of each post's content; the `vX.Y` token in it is the version the public page is pinned to.

### 3. Diff + verdict

**Tools:** read
**Done when:** Every folder has a verdict + a recommended action

- **new** — no matching post. Action: publish via `publish-paper-summary` if a PDF exists and no notes are pending; else revise+compile first.
- **stale** — post version < folder version. Action: rebuild the PDF at the new version (`compile-paper`), SFTP-replace it, then **UPDATE the existing post** (never create a duplicate).
- **not-ready** — sketch/seed (`< v1.0`, "sketch" in the name, no PDF). Action: hold.
- **current** — versions match. Action: none.

### 4. Report

**Tools:** read
**Done when:** One triage table + a summary line (counts + highest-priority action) shown to the user

Surface it plainly. Recommend, don't act — publishing/refreshing is a separate, user-gated step.

## Constraints

- Read-only: no file writes, no WordPress writes, no SFTP. The audit only reports.
- A stale post is REFRESHED by updating the existing post id — never publish a second post for the same paper.
- Version compare is by `vX.Y` header, not filename date (an undated file can be newest).
- Distinguish `improvement_notes.md` (pending) from `improvement_notes.incorporated-*.md` (already folded in) — only the former blocks a clean publish.
- **Notes-pending is a real `## Pending` SECTION, not file size.** A notes file is stale-marking only if it contains a `^##.*Pending` heading with un-incorporated work. A header-only stub ("Incorporated into vX.Y …", ~150 B) or a file whose pending sections were already folded into the latest `paper.md` is CLEAR — flagging it on `size>30` alone is a false positive (mis-flagged J3/J5/J10/J12/J13). The sibling visual `~/.openclaw/workspace/pulse-graphs/staleness-scan.py` uses this same `^##.*pending` rule; keep the two in sync.
- **Archive notes the moment they're incorporated.** When a revision folds the pending sections into `paper.md`, immediately `cp improvement_notes.md improvement_notes.incorporated-<date>.md` and replace it with a header-only stub (no `## Pending` heading). Skipping this leaves a false stale signal on the whole cascade (J9 v2.9 left its notes un-archived and read STALE until cleaned).
- **The hero/featured image must be a Napkin CONCEPT diagram, not a first-page PDF screenshot (2026-06-24).** Every paper post needs (a) a featured image (the thumbnail) AND (b) an in-content hero `<figure>` at the very top — and both must be a `napkin-diagrams`-generated conceptual image that represents the paper's WHOLE contribution. The tell of a wrong one is a **481×680 portrait `*-cover.png`** (A4 aspect ≈ 0.71) — that is a screenshot of the PDF's first page, which the owner has ruled out as the presenting image. Detect it: `GET /wp-json/wp/v2/media/<featured_media>?_fields=media_details` → if `width/height < 0.85` (portrait) on a `-cover.png`, FIX. Fix = generate the concept image (`napkin-diagrams` skill, ~1 credit/word, 500/wk free — budget it), `scp` to the host, `wp media import <png> --post_id=<id> --featured_image` over SSH (the REST `/media` endpoint is WAF-blocked), then prepend the concept `<figure>` at the top of the content. Landscape/square architecture diagrams are already correct — leave them. As of 2026-06-24 the broken set was posts 198(fixed), 200, 221, 230, 233, 264, 274, 279.

## Safety Notes

- Pure read pass — safe to run any time, costs little.
- It deliberately stops at "here's what to do." Acting on `new`/`stale` rows publishes to a public site (Rule 3: reversibility gates action) — that needs an explicit go.

## Failures Overcome

- **Publishing blind:** running a publish sweep without first diffing against live posts re-publishes papers that already have posts, or misses ones that quietly advanced. This gate produces the current work-list.
- **Silent staleness:** a paper revised after its post shipped (e.g. amygdala v2.8 → v3.0) leaves a public page citing claims/numbers that no longer match the PDF. Nobody notices until a reader does. Step 2's version-pin extraction catches it.
- **Duplicate posts:** the naive fix for a stale post is "publish it again" → two posts for one paper. The `stale` action is explicitly UPDATE-existing, not create.
- **Publishing a sketch:** a seed `v0.x` sketch folder (e.g. a striatum stub) looks like a new paper to a folder-only scan. The `not-ready` verdict holds it back until it has a real version + PDF.
- **Crying wolf on notes:** the first scanner flagged every paper with a non-empty notes file (13/18) as stale, drowning the real signal. The cure is the `^##.*Pending`-section test plus archive-on-incorporation discipline (see Constraints) — a detector that flags everything is no detector.

## Automation

This audit is no longer prompt-only. Two layers run it unattended:

- **Daily visual (pure logic):** `~/.openclaw/workspace/pulse-graphs/staleness-refresh.sh` (system cron `10 7 * * *`) refreshes the thetinkerzone post cache, regenerates the clickable staleness chain (`staleness-chain.html`, served at `http://127.0.0.1:18901/`), derived live from disk + wp-json + README. No LLM, no judgment — it shows _where_ to look.
- **Weekly LLM audit (judgment):** the `online-staleness-audit` OpenClaw cron runs this recipe + `audit-online-ripples`, auto-applies the reversible housekeeping (archive incorporated notes, regen the visual), and posts a RED/AMBER/GREEN verdict + the genuine backlog (un-incorporated notes, unposted papers, drifted counts) to the main tab. It proposes — it does not auto-publish to public surfaces.

The Fractal reflection (`tinkerclaw-fractal-reflection/fractal-prompt.md` §3 RIPPLE) owns keeping this recipe and the scanner current and in-sync.
