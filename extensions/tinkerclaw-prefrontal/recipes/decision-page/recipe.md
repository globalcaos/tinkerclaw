---
schema: "kit/1.0"
slug: "decision-page"
title: "Decision page — the human decides many items across several places"
summary: "When a human must decide, item by item, where dozens or hundreds of things should live (which skills on which agent, what to publish, what to cherry-pick), build one local page: live present state, your recommendation with its certainty, the human's decision on the same control, small readable groups, and saves that survive a reboot."
version: "1.1.0"
owner: "globalcaos"
license: "MIT"
category: "analysis"
tags:
  [
    "decision page",
    "decide per item",
    "what lives where",
    "which skills where",
    "which plugins where",
    "let me decide",
    "recommend and let me choose",
    "review page",
    "decision matrix",
    "toggle page",
    "keep or remove",
    "publish or keep private",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2, 3]
    - [4]
    - [5]
    - [6]
    - [7]
---

# Decision page — the human decides many items across several places

> One local page where each row is an item, each column is a place, and every cell is a two-circle switch showing what is there now, what you recommend, how sure you are, and what the human decided. Rows sit in small groups a person can read at a glance.

## Goal

The human makes every decision quickly and with confidence, and pressing SAVE without touching anything accepts all your recommendations. The page shows what exists today, measured live. It separates your advice from their call, and never loses a save.

## When to Use

- The human must decide the same yes/no question for many items across two or more places: agents, machines, a public repo, environments.
- A table of recommendations alone is not enough, because the human wants to override them one by one.
- The list is long enough that a chat answer would be a wall: more than about 20 items.
- The human asked to "decide", "choose", "review", or "see where everything lives".

## Steps

### 1. Name the places and what "on" means in each

**Done when:** each place has a colour, a one-letter token, and a pair of circle labels that say exactly what the data measures.

Decide the columns first. For each place, write down what its "on" state means, in the words the data supports. "Enabled" is not "installed", and "published" is not "present". The circle labels are those words: on / off for a running agent, public / private for a repository. A label that promises more than the data measured sends the human hunting for things that are already there.

### 2. Capture the present state live, and date it

**Tools:** exec
**Done when:** every cell has a present state read from a listing command in this session, and the page footer shows when and from where.

Read each place from its own source of truth: the plugin and skill listings on each machine, the repository tree, the config allowlist. Never fill the "now" column from memory or from an older table; stored inventories drift, and the page is only as honest as its first column. Keep a separate "there but cannot run / stale" state, because it is a different decision from absent. Date the capture in the footer, so the human knows how fresh "now" is.

### 3. Recommend each cell, with a certainty and a reason

**Done when:** every cell has a pick (keep / add / remove / fix), a certainty (sure / fairly sure / I hesitate) and, for anything not "keep, sure", a one-line reason.

Start every pick from the placement rules in recipe `create-recipe-skill-plugin` (step 9, "Place the enhancement") and the deployment's private placement policy that step reads; a pick that breaks one of those rules says which and why. They hold the owner's patterns from earlier pages, so the page opens closer to what the owner will choose. A reason must cite something checkable: an incident with its date, a measured count, a missing dependency, a platform that cannot run it. When several places share one decision chain (bring it into the repo, then switch it on per agent), make the picks consistent along that chain. Certainty is about the recommendation, not about effort; put the effort or port cost into the reason.

### 4. Group the rows into small blocks a human can read

**Done when:** every big block (plugins, skills, recipes…) is split into named groups, the build prints each group's size, and nothing sizeable lands in "Everything else".

Alphabetical order makes the reader re-sort the list in their head. Group by the question the reader actually has: what kind of thing is this, and who is it for.

- Put first-party items first ("our own …"), then the groups the reader acts on most, then the long tails.
- Derive groups from facts the items declare where they exist: manifest fields such as model providers, chat channels, speech or media providers. Hand-assign the rest in one explicit table.
- Split by what matters for the decision, e.g. "models this agent actually calls" versus "other vendors".
- Aim for groups of about 15 rows or fewer. A larger group is fine only when it is homogeneous, so the reader accepts or rejects it as one (31 unused model vendors, 21 maintainer tools).
- Order groups by meaning. Inside a group, put the rows that need attention first.
- Make the build print every group with its count, and list anything that fell into "Everything else" so it gets a real home.
- Each group header shows its size, how many rows change, how many you hesitate on, and a small per-place chip with the plan in that group (for example "G −12"). A click folds the group.

### 5. Build the switch page

**Done when:** one local HTML page with a sticky header (per-place totals that filter, tabs per block, search) and one switch per cell.

Use the two-circle switch from the visual-tables skill, section "When the reader DECIDES each row". The lit circle is the decision, the glow is your pick, the glow's size is your certainty, and a small light under a circle shows how it is now. Decisions start equal to your picks. Frame a switch green or red when the decision changes the present state, and mark an override with a gold dot. Fade rows where nothing moves and you are sure. Open the page with a "how to read a switch" panel of worked examples. Keep each row's reasons under its name, and put full detail and a note field behind an expander.

### 6. Make the decisions survive: save, auto-restore, and a load button

**Tools:** exec
**Done when:** SAVE writes a timestamped file plus a "latest" copy on disk, opening the page restores the latest save, and a "Load last save · <time>" button brings it back on demand.

Serve the page from a small loopback-only server that accepts the save and writes it to a folder the human owns. Run it as a permanent user service that starts at login, never as a process tied to your turn. Restore the latest save automatically on open, and also offer an explicit load button showing the save time, because the human cannot see that the auto-restore happened. Ask before a load replaces unsaved changes. Key every saved decision by block and item name, never by position or group, so regrouping or adding rows never loses a save. Keep an unsaved draft in the browser as a safety net.

### 7. Drive it, look at it, and keep the human's folder clean

**Tools:** exec, read
**Done when:** a scripted browser has clicked a circle, folded a group, saved, reloaded and loaded against a scratch save folder, and you have looked at screenshots of the real page.

Start a second server on another port with a scratch save folder (seed it with a copy of the human's latest save when you need realistic state). Test every interaction there. Never test against the human's real save folder. Then screenshot the live page and look at it; a green build says nothing about whether a group header wraps or a glow is visible.

### 8. Apply a save: one change set per place, then ask only about the outliers

**Tools:** exec
**Done when:** every decided cell is applied, staged for the next restart, or listed as blocked with its reason; the human has a short list of patterns you read from their choices and a short list of the choices those patterns do not explain.

Applying is a separate step the human asks for. Before touching anything:

- **Re-measure "now" against the destination the change will actually land in.** A "public" column measured on one branch is wrong for a repo whose public branch and development branch have separate histories: an item can be public on one and absent from the other, and a squash-publish from development would then delete it from public. List both trees and reconcile them.
- **Match rows to real paths, not names.** A skill's declared name and its folder name can differ; a row that says "not public" may be public under its folder name. Resolve every row to a path first.
- **Find the delivery channel for each place.** If a place only receives code by pulling one branch, then "add to that place" also means "make it exist on that branch". Check this against the human's picks: when every item sent to a place is also marked public, the public repo is their delivery channel, and anything private needs a different answer.
- **Sanitize anything going public with a gate in code, not by eye.** One word-aware leak pattern (employer names, colleagues, hosts, private subnets, home paths), run on every published file and on every added line; an independent reviewer hunts for indirect tells the pattern cannot see. Put the same pattern in the push hook so the rule outlives the session. An item whose whole content is the private subject stays private; an item whose method survives removing the private facts is published under a generic name, with a thin private overlay keeping the private defaults.
- **Never restart a live service to apply config.** Stage config for the next start where the platform supports it; on a machine that serves other people, check when it was last used and name the restart as a separate step.
- **Leave other sessions' uncommitted work alone.** Work in a separate worktree per branch; files that already carry someone else's edits are changed last, hunk by hunk, never by stash or checkout.

Then read the save for patterns: group the overrides by place and direction, name the rule each group implies, and apply the same rules to items created after the page was built. Report the patterns, then ask about the handful of choices none of them explains, one question each. When the owner answers, write the result back: owner-specific rulings into the private placement policy, generic rules into `create-recipe-skill-plugin` step 9. Keep no second copy of the rules here.

## Constraints

- Saving decides; it does not apply. Applying (editing an allowlist, installing, publishing) is a separate, deliberate step, and it may restart a service.
- The "now" column is measured this session, never recalled.
- Circle labels say exactly what was measured.
- Save keys are block + item name; grouping and ordering are presentation only.
- Keep private facts (machine names, paths, people) in the builder's data, never in this recipe.

## Safety Notes

- Bind the server to loopback only. The page shows your whole inventory and accepts writes.
- The page must not execute any decision itself; it only records them.

## Failures Overcome

- Three separate token columns (now → recommendation → decision) were rejected twice: the eye had to join three cells to read one choice. One two-circle switch per place replaced them.
- A column labelled "has it" showed 114 installed-but-disabled items as missing, and the human asked why public items were "not installed". The data measured "enabled"; the labels became on / off.
- The human believed a reboot would lose their decisions, because nothing on screen said the page had restored them. An explicit "Load last save · <time>" button fixed the trust gap, not the mechanism.
- Hundreds of rows in alphabetical order made the reader re-sort in their head. Small named groups inside each block fixed it; the model providers alone split into "the ones this agent calls" and "other vendors".
- A recommendation said an upstream item "arrives with our next merge" when merging had stopped months earlier. Reasons that cite a process must be checked against that process's current state.
- The first apply found the "public" column measured on a public branch whose history had split from the development branch: 14 public skills were missing from development, so the next squash-publish would have deleted them, and 5 rows marked "not public" were public under their folder names. Step 8 now re-measures against both trees before applying.
- An owner kept two plugins he read as shopping platforms; they were AI-model vendors. Read each item's manifest before recommending by its name.
- The employer's name was already on the public branch in dozens of files, because the push hook matched it case-sensitively and only as a two-word phrase. The hook now matches it case-insensitively and word-aware.
