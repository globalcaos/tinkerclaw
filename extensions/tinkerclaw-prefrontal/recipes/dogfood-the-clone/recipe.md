---
schema: "kit/1.0"
slug: "dogfood-the-clone"
title: "Dogfood the clone — be your own cloner, and fix what you find"
summary: "You cannot know what a cloner receives by reading your repo; you only learn it by BEING one. Stand up a clean deployment from the public artifact, use it for real, and treat every gap as evidence about the distribution path rather than a missing feature. One iteration closes one gap at the layer that produced it."
version: "2.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "release"
tags:
  [
    "dogfooding",
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

# dogfood-the-clone

**The premise.** A maintainer reading their own repo sees what they _intended_ to ship. A cloner
receives only what the distribution path actually carries — the public branch, the installer, the
defaults. Those two diverge silently and constantly, because the maintainer's machine accumulates
years of hand-configuration that never entered the artifact. The only reliable way to see the
difference is to **stand up a clone and use it**, then treat each gap as testimony about the
distribution path.

This is a LOOP, not a checklist. It is also the cheapest quality process available: the clone
finds real defects in the order a real user would hit them.

## Step 0 — measure both sides; never recall them

Same commands on both: config sections, enabled plugins, skills present, scheduled jobs,
credentials configured, what the UI actually renders. Write the numbers down. Two of those
numbers are config, not code, and no pull carries them: `models.list` on both gateways (entries,
and how many carry `rank`; the picker folds to the smart models only when ranks exist, and the
model-rank cron runs on the laptop only), and the allowlist `agents.defaults.models` compared BY ID, never by count (models removed on the
laptop stay on the clone, models added on the laptop never arrive; on 2026-10-05 Goku had FEWER
models and still lacked Opus 5.5), plus the default `agents.defaults.model.primary` and
`claude --version` on both (a new model id needs a minimum Claude Code: Opus 5.5 2.1.280, Sonnet 5.5
2.1.284). Prove a new default with one short `claude -p --model <id>` call on the clone. Copy the laptop's ranks onto the clone's shared ids and drop what
the laptop dropped, both host config. Also compare the laptop checkout's UNCOMMITTED changes
(`git -C ~/src/tinkerclaw status --short`): the laptop's live page builds from that working tree,
so a change the architect asked for that was never committed shows on the laptop and can never reach the clone. Memory is what
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
`HEAD^ == <public branch>`, push. **Symlink `node_modules` into the worktree** (only when no step runs `pnpm install`; see master-worker-coding Step 1) or the pre-push
export check crashes with ERR_MODULE_NOT_FOUND and reads as a failure.

## Step 6 — pull, rebuild, restart, and LOOK

On the clone: pull, then RE-RUN THE INSTALLER (that is the real test of an installer fix), then
restart. Verify by a changed PID and a rendered page — never from a log line, because logs append
across runs and a stale line reads exactly like a fresh one.

**The pull is the ONLY way code reaches the clone (standard since 2026-09-15).** Never edit, copy
or hand-patch code on the clone host — not a dist bundle, not one source file. If a fix seems to
need a clone-side edit, fix it in the fork, publish, pull. Before the first pull on a tree someone
already hand-patched, save each stray edit as a patch file (and keep any stash) so nothing is lost,
then return the tree to the published branch. Host DATA is not code and stays local: credentials,
the clone's own config, runtime files, and any proxy that holds a secret.

**A private clone that runs `develop` (the second agent's host since 2026-09-21) skips Step 5.** Its history IS our
`develop`, so a squashed public push cannot fast-forward it. Push straight into the ref it tracks,
then pull there: `git push --no-verify <server>:src/tinkerclaw develop:refs/remotes/origin/develop`,
then on the host `git merge --ff-only origin/develop`. First merge any clone-only branch into
`develop` so the fast-forward cannot drop it. A bare `git pull` on the host fetches GitHub's
diverged `develop`, so never use it there.
To go live, build a full tree BESIDE the live one (`~/build-develop.sh` on the host), then swap in a
script that stops the gateway AND the old gateway's `tinkerclaw-worker-<oldpid>-*` units, moves the
trees, starts, and proves it with a real model prompt, rolling back on failure
(`~/swap-develop-20260923.sh` is the template; ≈51 s downtime on 2026-09-23). Keep the previous tree
as the rollback. The clone's Claude Code setup (settings, plugins, skills, hooks, MCP) is host
config: copy it with paths rewritten and name its MCP server after the clone's agent, never `jarvis`.

## Don't-regress

- Never close a gap by pushing private-repo content to a public one. Re-derive the boundary
  (Step 3) instead; that is the legitimate route.
- Shipping something that SPENDS on a cloner's behalf (scheduled jobs, paid API calls) must ship
  DISABLED or as an opt-in template. A useful default that quietly costs money is not a gift.
- An environment-sensitive or racy gate is a finding for a later iteration, not a reason to stop.
  Record it; bypass only that gate, with the leak gate independently verified.
- Process-name traps: `pkill -f '<the command you typed>'` misses a daemon that renames itself.
  Confirm a restart by PID (`pgrep -x`), before and after.

## Failures overcome

- **2026-10-05, "too many models" and THALAMUS out of place on Goku.** the architect: "Goku seems to have too
  many models in the model picker ... Additionally, Thalamus is not right under the model picker,
  which it should". Goku's 40 models carried no `rank` (the laptop's 50 did) and kept two Copilot
  models removed on 2026-09-10; the THALAMUS move he asked for on 2026-10-04 had sat uncommitted in
  the laptop checkout for a day. Step 0 now measures both.

- `setup.sh` ran `pnpm install` and built the UI but never built the CORE, so the gateway died on
  `missing dist/entry.(m)js` immediately after the installer printed "Setup complete". Found only
  by deploying for real. Fixed 2026-09-08 with a build step plus an entry-point guard.
- `topology.md` D3 fails ONLY inside the full invariant suite and passes standalone every way it
  is invoked — it derives a filesystem symlink count while sibling checks mutate the filesystem.
  It taxes every publish.
- 2026-09-23: merging the clone-only branch into `develop` went through the `.gitattributes`
  drivers built for UPSTREAM syncs. `package.json merge=tier1` copied the branch's file over ours
  (dropped the `tinkerclaw` bin) and `pnpm-lock.yaml merge=ours` dropped the branch's
  `better-sqlite3` entries. Both passed silently. After any internal merge that touches either
  file, diff them against a plain `git merge-file` result and confirm with
  `pnpm install --lockfile-only --frozen-lockfile`.
- A hand-written `plugins.allow` on the clone silently EXCLUDED two of the three left-rail panels;
  the deployment looked feature-poor because of the operator's own list, not the artifact.
