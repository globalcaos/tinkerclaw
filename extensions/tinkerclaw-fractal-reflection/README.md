# Fractal Reflection

> Your agent finishes the turn — then a second, read-only agent grades what just happened, off to the side.

Most agents close a turn and move on. This one hands the finished turn to a separate reviewer that had no part in doing the work.

**This is off by default and it costs money.** Read the next two sections before enabling it.

## What actually happens

When a main agent turn ends, the plugin builds a compact digest of that turn and **spawns a separate subagent** — its own run, its own session key, out of band — to triage it. The triage lane is read-only by enforcement, not by request: `subagent.run` takes no tool list, so the plugin registers a `before_tool_call` hook that blocks every tool except `read`, `grep`, `find`, `ls`, `memory_search` and `memory_get` for any fractal lane session (sessionKey prefix `fractal-reflection:`) or run it spawned. Tools outside that allowlist, including ones added later, are refused. Other sessions are not touched.

It returns one of three verdicts — `clean`, `act`, or `gap` — plus findings. **Findings must carry falsifiable evidence**: a file path and a verbatim quote, which the plugin then re-checks against disk before trusting them. That re-check reads the path the finding names, only if it is a regular file of at most 2 MB, and uses the content only to test whether the quote is present. The same bounded read checks `🌿 FRACTAL ACTION:` claims in the finished turn. A quote that no longer matches kills the finding (counted as `abstainedFindings`), so a reviewer that hallucinates a problem gets caught by the plugin rather than by you.

Every finished turn produces **exactly one append-only ledger row** in `~/.openclaw/data/fractal/results.jsonl`, including the ones where nothing ran — `skipped` (with a reason), `suspended`, `error`. Skips are never silent.

### What it does NOT do (yet)

- **There is no fix lane.** Drop 1 ships the COLD triage arm only. Findings are recorded as `flagged` and stop there — nothing is edited, committed or actioned on your behalf. The `fixModel` / `fixThinkLevel` / `maxFixTurnsCeiling` / `maxFixSpawnsPerHour` / `artifactRoots` keys are reserved for that lane and have **no effect today**.
- **There is no in-band injection.** The v1 design injected a reflection prompt into your live session and debounced it; that machinery is retired. Nothing is added to your conversation.
- **There is no trigger filtering.** Every `agent_end` that is not itself a fractal lane is triaged — cron runs, heartbeats and subagent turns included. The only exclusions are the plugin's own lanes (a sessionKey-prefix predicate plus a runId ownership set), which is what stops it reflecting on its own reflections.

## Cost, and what bounds it

One triage subagent run per finished turn. That is the number to hold in your head before enabling it.

Three things bound it: a **single-flight, latest-wins slot per session** (while a triage is in flight at most one turn waits, and a newer turn supersedes it), a **spawn token bucket** (a plumbing alarm — if it fires, something upstream is firing far too often), and a **quota governor** with a circuit breaker. The governor's derived-pressure throttle is currently unarmed on the subscription path because no fresh quota signal reaches it; it fails to neutral, and the hourly spawn ceiling is what binds.

Kill switch: `fractal.suspend` (persisted — a restart does not re-arm it) and `fractal.resume`.

## Install

```bash
openclaw plugins install @globalcaos/tinker-fractal-reflection
```

Enable it in `openclaw.json` — **both** the entry and `config.enabled` are required:

```json
"plugins": {
  "allow": ["tinkerclaw-fractal-reflection"],
  "entries": {
    "tinkerclaw-fractal-reflection": {
      "enabled": true,
      "config": { "enabled": true }
    }
  }
}
```

With `config.enabled` anything other than `true`, **no `agent_end` or `before_tool_call` hook is registered** and no triage can spawn. The read-only RPCs stay registered either way, so `fractal.status` can honestly report `enabled: false` instead of going silent.

## Gateway RPCs

| method | what it does |
|---|---|
| `fractal.status` | enabled / suspended / breaker state / governor mode |
| `fractal.stats` | ledger stats over a window, plus governor pressure |
| `fractal.feed` | recent rows, optionally filtered by status |
| `fractal.byRunId` | the row for one parent run |
| `fractal.suspend` / `fractal.resume` | kill switch (suspend persists across restarts) |

## Related plugins

Independent plugins from the same repo; this plugin does not call them and they do not read its ledger.

- [@globalcaos/openclaw-total-recall](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-total-recall)
- [@globalcaos/openclaw-identity-persistence](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-identity-persistence)
- [@globalcaos/openclaw-memory-enhancements](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-memory-enhancements)

---

👉 **https://github.com/globalcaos/tinkerclaw**
👉 **https://thetinkerzone.com**

_Clone it. Fork it. Break it. Make it yours._

## Changelog

- 0.1.2 — ships `src/` and `triage-prompt.md` that `index.ts` and `dist/index.js` load; install name matches package.json; triage lane read-only is now enforced by a `before_tool_call` allowlist; quote/claim re-checks read only regular files up to 2 MB; unimplemented config keys marked not in effect.
