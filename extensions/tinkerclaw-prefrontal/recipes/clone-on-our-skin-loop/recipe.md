---
schema: "kit/1.0"
slug: "clone-on-our-skin-loop"
title: "Clone-on-our-skin loop — wear the clone, or you will miss what cloners get"
summary: "You cannot know what a cloner receives by reading your repo; you only learn it by BEING one. Stand up a clean deployment from the public artifact, use it for real, and treat every gap as evidence about the distribution path rather than a missing feature. One iteration closes one gap at the layer that produced it."
version: "2.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "release"
tags:
  [
    "loop",
    "clone",
    "cloner",
    "distribution",
    "installer",
    "publish",
    "parity",
    "loop",
    "onboarding",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
params:
  reference: "{{reference|the mature local install}}"
  clone: "{{clone|a clean deployment from the PUBLIC artifact}}"
---

# clone-on-our-skin-loop

**The premise.** A maintainer reading their own repo sees what they _intended_ to ship. A cloner
receives only what the distribution path actually carries — the public branch, the installer, the
defaults. Those two diverge silently and constantly, because the maintainer's machine accumulates
years of hand-configuration that never entered the artifact. The only reliable way to see the
difference is to **stand up a clone and use it**, then treat each gap as testimony about the
distribution path.

This is a LOOP, not a checklist. Reading the repo shows what we _meant_ to ship. Wearing the
clone — installing it, starting it, using it on our own skin — is the only way to see what a
stranger actually receives. Skip that step and we miss the product.

## Step 0 — measure both sides; never recall them

Same commands on both: config sections, enabled plugins, skills present, scheduled jobs,
credentials configured, what the UI actually renders. Write the numbers down. Memory is what
produced the last wrong guess — on 2026-09-08 a stored note said `skills/` was gitignored, while
`git ls-files` showed 132 tracked files, which would have sent the whole iteration at a
non-existent problem.

## Step 1 — rank gaps by usefulness, and set aside the BLOCKED ones

A gap waiting on a human decision (an API key, a spend approval, a security posture) is not the
one to work. Pick the most useful gap you can close without asking permission.

## Step 2 — for the chosen gap, ask WHY the distribution path did not carry it

This is the step that produces the value. Four outcomes, and only the last two are yours to fix:

1. **Private by design** — it lives in a private repo behind a PII/secrets boundary. Do not
   "fix" it by publishing. But DO ask the sharper question in Step 3.
2. **Deployment-local** — a credential or host-specific setting. Transmit locally, never via git.
3. **A defect in the artifact** — the installer, the defaults, the build. Fix and publish.
4. **A default that was never chosen** — nobody decided it should ship, so it silently didn't.
   The most invisible category, and usually the most valuable.

## Step 3 — for anything "private", re-derive the boundary instead of inheriting it

A private/public split made once, under old assumptions, hardens into a rule nobody re-examines.
Split the private set into **what is private because of its CONTENT** and **what merely lives on
the private side of a directory line**. Measure it — run the leak pattern per item rather than
judging the folder. Worked instance (2026-09-08): of 107 workspace skills, 64 were ALREADY in the
public fork, 16 carried real PII, and **10 were already published to the world on ClawHub yet
absent from the project's own public repo** — public everywhere except where a cloner looks.
Publishing those creates zero new exposure.

## Step 4 — fix at the layer that produced it, with a guard that fails loudly

Any hand-patch you applied on the clone to get moving is a SILENT FORK of the distribution path:
it makes the symptom vanish exactly where nobody will look again, and guarantees the next cloner
repeats it. Keep a running census of your own hand-patches and promote them one per iteration.
Prove each guard can go red — a check that cannot fail is the `gate-blindspot` class.

## Step 5 — publish SURGICALLY

Do not republish the whole divergence per iteration (here: ~2100 commits, ~159 files). Worktree at
the public branch, copy only the changed paths, run the leak grep on THAT diff, commit, assert
`HEAD^ == <public branch>`, push. **Symlink `node_modules` into the worktree** or the pre-push
export check crashes with ERR_MODULE_NOT_FOUND and reads as a failure.

## Step 6 — pull, rebuild, restart, and LOOK

On the clone: pull, then RE-RUN THE INSTALLER (that is the real test of an installer fix), then
restart. Verify by a changed PID and a rendered page — never from a log line, because logs append
across runs and a stale line reads exactly like a fresh one.

## Don't-regress

- Never close a gap by pushing private-repo content to a public one. Re-derive the boundary
  (Step 3) instead; that is the legitimate route.
- Shipping something that SPENDS on a cloner's behalf is allowed **only** when (a) the architect
  has explicitly chosen the default, (b) the spend is ordinary configured inference (no pinned
  third-party provider, no paid add-on), (c) the jobs never send, publish, or take irreversible
  actions, and (d) opt-out is one command printed at install time. Structural self-maintenance
  crons meet that bar and ship ENABLED. Anything else still ships disabled or as an opt-in.
- An environment-sensitive or racy gate is a finding for a later iteration, not a reason to stop.
  Record it; bypass only that gate, with the leak gate independently verified.
- Process-name traps: `pkill -f '<the command you typed>'` misses a daemon that renames itself.
  Confirm a restart by PID (`pgrep -x`), before and after.

## Failures overcome

- `setup.sh` ran `pnpm install` and built the UI but never built the CORE, so the gateway died on
  `missing dist/entry.(m)js` immediately after the installer printed "Setup complete". Found only
  by deploying for real. Fixed 2026-09-08 with a build step plus an entry-point guard.
- `topology.md` D3 fails ONLY inside the full invariant suite and passes standalone every way it
  is invoked — it derives a filesystem symlink count while sibling checks mutate the filesystem.
  It taxes every publish.
- A hand-written `plugins.allow` on the clone silently EXCLUDED two of the three left-rail panels;
  the deployment looked feature-poor because of the operator's own list, not the artifact.
- Plugin _files_ travelled with `git clone`; loading them did not. A fresh gateway left
  `tinkerclaw-*` disabled until someone knew `plugins enable`. Fixed 2026-09-08 with
  `scripts/seed-fork-plugins.mjs`, which writes `plugins.entries.<id>.enabled = true` and
  **never** writes `plugins.allow`.
