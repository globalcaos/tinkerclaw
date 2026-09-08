---
name: tinker-orca
version: 1.1.0
description: "Stop editing files one at a time. ORCA drafts every change in parallel, then applies them per-file-serialized so disjoint files fly and shared files never collide. It SPAWNS SUBAGENTS on your own provider (one per unit, which costs money) and WRITES only to files you list. Committing rewrites git history and is double-opt-in, OFF by default. See Permissions, Data Flow and Consent."
metadata:
  openclaw:
    emoji: "🐋"
    permissions:
      shell:
        required: true
        scope: "Runs git (status/diff/apply/stage/commit) inside the repo you name, plus your OpenClaw subagent-spawn CLI. No other external command."
      file_write:
        required: true
        scope: "Only the files you list in each unit's `writes`. Nothing outside repoRoot is touched."
      subagents:
        required: true
        scope: "Spawns one worker per edit-unit through YOUR configured OpenClaw provider. Model choice is yours."
      network:
        required: false
        scope: "None directly. Your spawned agents use whatever provider you already configured."
      credentials:
        required: false
        scope: "None. Reads no tokens, keys or auth files."
repository: https://github.com/globalcaos/tinkerclaw
homepage: https://github.com/globalcaos/tinkerclaw
---

# ORCA — parallel multi-agent coding

> One of dozens of skills and plugins in **[TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — a self-improving OpenClaw fork that's been running 24/7 for months.

Your agent edits twelve files. One. At. A. Time.

You watch it read, think, patch, verify — then start again on the next file as if the other eleven didn't exist. The work is embarrassingly parallel and it is running in single file.

The reason nobody parallelises it is the fear of two workers touching the same file. ORCA removes the fear instead of working around it: the only contended thing in a repo is a **shared file**, so it puts a short-lived lease on files and on nothing else. Disjoint files run at full concurrency. Shared files queue for a moment. A patch that goes stale while waiting is re-derived rather than clobbering someone.

"Did it merge cleanly?" stops being a question you ask.

**Part of [TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — real-time token tracking, self-improving crons, persistent cognitive memory. This is one piece of that stack; the repo has dozens more.

👉 **https://github.com/globalcaos/tinkerclaw**

_Clone it. Fork it. Break it. Make it yours._

## How it works — two phases

**Phase A — no lease, fully parallel.** Every unit reads, diagnoses and drafts its exact patch simultaneously. That is ~95% of the wall-clock, and none of it contends.

**Phase B — brief per-file lease.** Acquire the lease, apply the prepared patch, verify that file, release. Disjoint units run concurrently; units sharing a file serialise; a staleness guard makes a worker re-derive a patch that no longer applies.

**Phase C — one commit per unit** (OFF by default; needs `commit` AND `confirmedCommit`). Each unit stages only its own files — never `git add -A` — so a parallel session's unrelated work is never swept in.

## Requirements

- OpenClaw with a configured model provider.
- A subagent-spawn CLI. Point at it with `spawnCliPath` in args, or the `ORCA_SPAWN_CLI` env var.
- A git repo. ORCA works on the repo you name and nowhere else.

## Usage

```js
Workflow({
  scriptPath: "<this skill>/scripts/parallel-implement.workflow.js",
  args: {
    repoRoot: "/path/to/your/repo",
    units: [
      { id: "u1", task: "what to change", writes: ["src/a.ts"], reads: ["src/x.ts"] },
      { id: "u2", task: "what to change", writes: ["src/b.ts"] }
    ],
    commit: true,          // opt in...
    confirmedCommit: true  // ...and confirm. Both required, or nothing is committed.
  }
})
```

`units[].writes` are the lease keys. Keep them disjoint for maximum parallelism; overlapping writes are safe — they simply serialise.

## Permissions, Data Flow & Consent

**What it does.** Runs git commands and applies patches inside the `repoRoot` you pass, and spawns one subagent per unit through your own provider.

**What it does not do.** It touches nothing outside `repoRoot`, reads no credentials, makes no network calls of its own, and never force-pushes or amends. It does not use `--no-verify` — your hooks run.

**Committing is OFF unless you ask twice.** Phase C rewrites git history, so it needs BOTH `commit: true` and `confirmedCommit: true`. With anything less, ORCA applies and verifies the patches and leaves them uncommitted for you to inspect. There is no flag that makes committing the default. Leave `ORCA_CONDUCTOR` unset and every unit runs on your default model. A file you do not list in `writes` is a file ORCA will not write.

**It costs money.** One subagent per unit, on your provider, at your rates. A 12-unit run is 12 agents. Start with two.

**Optional extras, off unless you set them.** `ORCA_CONDUCTOR` (per-domain model routing) and `ORCA_OWNERSHIP_SCRIPT` (a session-ownership pre-flight). Without them ORCA falls back to a plain dirty-worktree check and a single model.

## When NOT to use it

- A single-file change — just edit it.
- Edits where unit B must read unit A's committed result — split into separate runs.

## Included Files

| File | Purpose |
| --- | --- |
| `scripts/parallel-implement.workflow.js` | The orchestrator. No host paths, no hardcoded machine assumptions |
