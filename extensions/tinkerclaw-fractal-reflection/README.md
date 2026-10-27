# Fractal Reflection

> Your agent finishes the turn. Then a second pass looks back at it, asks what it taught, and fixes the cause, off to the side.

This plugin holds the Fractal doctrine: `fractal-prompt.md`, the core every reflection reads, and `chapters/`, one per reason a reflection runs. It also carries an older triage lane, described further down, which is off by default.

## How the Fractal runs in TinkerClaw

In a full TinkerClaw install the reflection runs after each turn you send from the Tinker page:

1. **A gate decides first.** The page asks the gateway's `fractal.gate` whether the turn holds a lesson. Rules always look for a correction ("why did you…"), a fight with the tools, a long delivery, or "I don't see it". With a Jev token, Jev reads the turn and can say no. Without one, every turn gets its reflection.
2. **Its own session, so you never wait.** The reflection runs in `agent:<id>:fractal:<P>`, started as a copy of the chat's Claude Code conversation, so it sees every tool call of the turn and writes nothing into your chat.
3. **It fixes, and proposes the rest.** It may edit files, notes and code on a branch and merge into develop. A send, a delete, a publish, a spend or a restart is held by a guard in code and comes back as a `Proposed:` line on its card, for you to run. Config: `plugins.entries.tinkerclaw-tinker-bridge.config.fractalGuard` (`enforce` by default, `watch`, `off`).
4. **Every claim is checked.** Each path and commit it names is checked against the disk and git, and its folded 🌿 card under your reply shows a tick or a cross.

The pieces live in the gateway (`src/infra/fractal/`), the Tinker page (`tinker-ui/src/fractal-turn.ts`), the Tinker bridge (`fork-parent.ts`, `fractal-ledger.ts`, `fractal-guard.ts`) and the tinkerclaw-core Claude Code plugin (`scripts/fractal-guard.mjs`). This plugin alone, installed into a stock OpenClaw, gives you only the doctrine and the legacy lane below.

Two limits today: the trigger lives in the Tinker page, so a turn that arrives on WhatsApp or another channel gets no reflection, and the guard reads command text, so a script that sends or deletes inside itself is not seen.

## The legacy triage lane (off by default, costs money)

Read this and the next section before enabling it.

When a main agent turn ends, the plugin builds a compact digest of that turn and **spawns a separate subagent** — its own run, its own session key, out of band — to triage it. The triage lane is read-only by enforcement, not by request: `subagent.run` takes no tool list, so the plugin registers a `before_tool_call` hook that blocks every tool except `read`, `grep`, `find`, `ls`, `memory_search` and `memory_get` for any fractal lane session (sessionKey prefix `fractal-reflection:`) or run it spawned. Tools outside that allowlist, including ones added later, are refused. Other sessions are not touched.

It returns one of three verdicts — `clean`, `act`, or `gap` — plus findings. **Findings must carry falsifiable evidence**: a file path and a verbatim quote, which the plugin then re-checks against disk before trusting them. That re-check reads the path the finding names, only if it is a regular file of at most 2 MB, and uses the content only to test whether the quote is present. The same bounded read checks `🌿 FRACTAL ACTION:` claims in the finished turn. A quote that no longer matches kills the finding (counted as `abstainedFindings`), so a reviewer that hallucinates a problem gets caught by the plugin rather than by you.

Every finished turn produces **exactly one append-only ledger row** in `~/.openclaw/data/fractal/results.jsonl`, including the ones where nothing ran — `skipped` (with a reason), `suspended`, `error`. Skips are never silent.

### What the lane does NOT do

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

| method                               | what it does                                        |
| ------------------------------------ | --------------------------------------------------- |
| `fractal.status`                     | enabled / suspended / breaker state / governor mode |
| `fractal.stats`                      | ledger stats over a window, plus governor pressure  |
| `fractal.feed`                       | recent rows, optionally filtered by status          |
| `fractal.byRunId`                    | the row for one parent run                          |
| `fractal.suspend` / `fractal.resume` | kill switch (suspend persists across restarts)      |

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
