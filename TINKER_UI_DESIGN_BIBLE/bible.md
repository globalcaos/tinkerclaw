---
file: bible.md
purpose: Narrative, intent, decisions, don't-regress prose. Structural facts live in the other 15 files.
audience: AI
last_verified: 2026-05-11
single_owner: yes for narrative + decision history
see_also: INDEX.md (the map)
verify:
  - name: bible.md has not regrown past the prior slim ceiling
    cmd: python3 -c 'import os; assert sum(1 for _ in open(os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/bible.md"))) < 2000, "bible.md is growing again; extract structural facts to dedicated files"'
---

# Tinker UI — Design Bible

> Living document. Updated every time we work on Tinker UI features, fixes, or design changes.
> Location: `~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE.md` (tracked in GitHub fork)
> Last updated: 2026-05-09 (§5.78b — supersession pointer added: §5.78b's 2026-04-29 diagram is the historical local-only-`develop` workflow; §5.78g is the live rule — `develop` is the working branch, both local and pushed; we tinker on `develop` and merge into `main` only by mutual agreement when it's robust enough to ship. Earlier same day: §11.6b — `/new` briefing injection redesign: when the user types `/new` in Tinker UI, the client awaits a new gateway RPC `briefing.resolve` (workspace `BRIEFING.md` → bundled `briefing-default.md` fallback), builds an imperative prompt with the briefing's full content inlined, and sends it as the user message. The user bubble renders as a collapsed `<details>` with summary `⚡ Executing <path>`; the path is a clickable monospace link calling the new `files.openInEditor` (allowlist-guarded ADMIN_SCOPE) RPC to open the file via `xdg-open`. Replaces the soft "Read and follow" suffix that caused Opus 4.7 to acknowledge BRIEFING.md and ask permission instead of executing it (10:00 turn, 33s, 258B reply, zero tool calls). New imperative wording sentinel `"Execute the morning briefing NOW"` is dual-purpose — model directive + client-side detection regex; change in lockstep. 7 commits on develop. Earlier same day: §11.6a — per-chat strategy added: every WhatsApp inbound now carries `[chat-profile]` (groups only — purpose, stakes, audience, format prefs, guardrails) + `[chat-rhythm]` (median + P90 word count over last 20 non-bot messages with the "match this rhythm; propose long answers, don't dump them" directive) at the top of the prelude, before the existing people/sender/recent-thread/escalation blocks. Profile authorship is agent-driven and lazy: Jarvis writes `chat-profiles/<slug>.md` (or appends to `<slug>.notes.jsonl`) when he observes something profile-worthy; unprofiled chats fall back to `_default.md`. Strategy doc at `~/.openclaw/workspace/memory/knowledge/whatsapp-strategy.md` is hooked from `SOUL.md` so it loads once into the persona, not per-message. Persona scaffolding (🤖 prefix + 🤔↔🤖 thinking reaction + ⚡ done-separator) is wire-level non-negotiable — never dropped to fit a length budget. Earlier same day: owner-prefix global invariant — owner+"Jarvis" prefix MUST trigger from any chat (DM, group, LID, self) without per-chat allowlisting; bug fixed by propagating `msg.ownerPrefixTriggered` from on-message.ts → group-gating.ts so the two gates agree. Earlier same day: prelude→BodyForAgent wiring corrected (was silently dead in `Body` since 2026-05-04) + `[thread-escalation]` hint added (exact `whatsapp_history` tool call with chat JID + ISO `until` cursor inlined for adaptive read-back). Earlier: §5.44 thinking-reaction upgraded to persona-aware alternating heartbeat — single source of truth in `outbound-prefix.ts`. Two regression-class gotchas pinned: (1) reactions MUST route through `wmClient.sendReaction` not `sendMessage({react})`; (2) any helper calling `requireRuntimeConfig` needs cfg plumbed in or fetched at call-time.)
> Previously (2026-04-28): §5.76 public/private boundary + git-pull contract — Jarvis ships as the day-0 default; user overrides live in `~/.openclaw/workspace/`; resolution order config → workspace → bundled; five hardcoded `/home/<user>/...` paths in `worker.ts` and `db-probe.mjs` to fix; chrome-extension token-leak placeholder to replace; narration / subagent-helper / tool-choice / persona / briefing default prompts extracted to `extensions/tinkerclaw-tinker-bridge/{personas,prompts}/` and loaded via shared resolver. The "Sam test" + "Day-90 test" are the structural guarantees.

---

## 1. What Tinker Is

Tinker UI is the fork's **standalone command center** — a completely separate webchat frontend, not a skin on upstream. It replaces upstream's Lit-based webchat with a Vite + TypeScript + vanilla DOM single-page app.

**Why it exists:** Upstream `ui/` is kept 100% vanilla (zero fork patches) to eliminate merge conflicts forever. All UI customization lives exclusively in `tinker-ui/`, a fork-only directory that upstream never touches.

**Created:** 2026-02-27 (commit `5070018f0`)
**Migration:** Moved from patching `ui/` to standalone `tinker-ui/`, removing ~14 upstream touchpoints.

---

## 2. Architecture

```
tinker-ui/              ← Fork-only, zero merge risk
├── src/
│   ├── app.ts          ← Entire frontend (~7600 lines)
│   ├── styles/base.css ← All styles (~3270 lines)
│   ├── styles/*.jpg/png ← Natural textures (bark, moss, marble, earth, wood, sandpaper)
│   └── panels/
│       ├── context-timeline.ts   (~980 lines)
│       ├── context-treemap.ts    (~1160 lines)
│       ├── response-treemap.ts   (~700 lines)
│       ├── prefrontal-graph.ts   (~130 lines, legacy pill panel — largely unused)
│       ├── prefrontal-tree.ts    (~210 lines, compact call tree)
│       └── provider-logos.ts     (~40 lines — SVG logos + color maps)
├── index.html
├── package.json
└── vite.config.ts

extensions/tinker/      ← Fork-only gateway plugin
├── index.ts            ← Serves UI via registerHttpRoute
└── openclaw.plugin.json

extensions/hippocampus/ ← Fork-only plugin stub
├── index.ts            ← No-op register (code lives in src/memory/engram/)
└── openclaw.plugin.json
```

**Stack:** Vite 6 + TypeScript 5.7 + vanilla DOM (no framework)
**Dependencies:** `markdown-it` (rendering), `lit` (imported but unused — legacy)
**Port:** 18790 (dev), served at `/tinker/` via gateway plugin (prod)
**Auth:** Gateway token injected as `window.__TINKER_CONFIG` by plugin into `index.html`
**Client identity:** `webchat-ui`, role `operator`, scopes `["operator.admin"]`, caps `["tool-events"]`

### Communication with Gateway

| Channel                         | Purpose                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| WebSocket `/api/events`         | Lifecycle events, chat deltas, fallback errors, tool events, **context-anatomy push**      |
| RPC `req(method, params)`       | Chat, history, session mgmt, anatomy data, forensic, prefrontal, `config.openExternalFile` |
| REST `/api/context-anatomy/:sk` | Context token breakdown per turn (fallback polling)                                        |

---

<!-- 2026-05-11 MIGRATION NOTE:
  §3 Layout, §4 Visual Language, §5.1 through §5.65 are now in ./tinker-ui.md.
  §7 Bug Fix Log is now in ./bug-log.md.
  The §5 numbering below jumps from §5.0 (legend) to §5.66; the missing
  entries live in tinker-ui.md verbatim. Likewise, references that used
  to point at §7 in this file now point at ./bug-log.md.
  This file retains: §1, §2, §5.66-§5.82 (design narratives + late features),
  §6, §8-§13 (principles, conventions, fork backend systems, workspace).
-->

- **Status:** `DEPLOYED`
- **What:** When a recipe is active, three visual indicators appear: (1) persistent recipe banner below topbar showing recipe name + step progress with category color, (2) thinking indicator annotation showing current step alongside model name, (3) assistant message tags showing which recipe step produced each message. Zero extra tokens — all from hook state.
- **Files:** `extensions/tinkerclaw-prefrontal/index.ts` (prefrontal-recipe-status broadcast), `tinker-ui/src/app.ts` (banner + thinking + tags), `tinker-ui/src/styles/base.css`

### 5.66 Claude-Code Provider Bridge — `tinkerclaw-tinker-bridge`

→ moved 2026-05-11 to `./tool-loop.md` (the divergence rationale was already there; provider mechanics + workspace skills wrapper §5.66a are now appended under "Provider mechanics").

**Renamed `cc-bridge` → `tinker-bridge` (2026-06-19), name FULLY PURGED 2026-06-20.** Extension dir `extensions/tinkerclaw-cc-bridge` → `tinkerclaw-tinker-bridge`; plugin id `tinkerclaw-tinker-bridge`; ClawHub package `@globalcaos/tinker-bridge` with `publishToClawHub:true`. The `cc-bridge` name is retired EVERYWHERE — code symbols (`CcBridge*`→`TinkerBridge*`, `CC_BRIDGE_*`→`TINKER_BRIDGE_*`, file `cc-bridge-session-map.ts`→`tinker-bridge-session-map.ts`), the `ccBridge:true` cross-extension flag (both the `stream.ts` emit and the `learned-intuition` listener), the `cc_bridge_*` error codes, comments/docs/prompts — AND the persisted identifiers, with migrations so no live state is lost: the worker-pool prefix `cc-sp-`→`tinker-sp-` and the state dir `~/.openclaw/cc-bridge/`→`~/.openclaw/tinker-bridge/` migrate on first load (copy + rekey — `session-map.ts:migrateLegacyMap`, plus a legacy-path read fallback in `tinker-bridge-session-map.ts`); the `cc-bridge-tool` history customType→`tinker-bridge-tool` with a legacy-kind read back-compat in `session-utils.fs.ts` so pre-rename transcripts still render. **KEPT (genuinely NOT the bridge):** the provider id `claude-code` (auth/model routing keys on this, not the plugin id), and `cc-skills-bridge` (prefrontal's SKILL.md→recipe transpiler — a different component). The actual ClawHub push stays human-gated (the package description documents the Anthropic gray-zone).

### 5.67 Amygdala + Fractal Injection Pipeline (2026-04-18)

- **Status:** `FRACTAL DEPLOYED; AMYGDALA RETIRED 2026-06-10` — the per-turn `🧠 AMYGDALA` section was retired (split/render extracted to `tinker-ui/src/sectioned-reply.ts`; see `tinker-ui.md` §5.74 for the authoritative current state + don't-regress). **The in-band injection design below is being superseded by §5.67a — Parallel Fractal Reflection v2 (DESIGN, 2026-06-11).** **UPDATE 2026-06-19 (Bug A): the `💬 ANSWER` section marker is RETIRED.** The UI now separates narration/answer STRUCTURALLY (text after the last tool = answer; `reply-grouping.ts` `narrationIndices`), so `buildInjectedPrompt` no longer injects `💬 ANSWER` (kept `🌿 FRACTAL`, which is also system-prompt-mandated). Root cause: the marker was injected only transiently/toggle-gated while `🌿 FRACTAL` was always-mandated → the model dropped `💬 ANSWER` and the positional collapse hid the answer. Authoritative current state: `tinker-ui.md` §5.8; root cause + fix: `bug-log.md` FIXED A. Lines below describing the two-section `💬 ANSWER → 🌿 FRACTAL` injection are now HISTORICAL.
- **What (current):** ONE topbar toggle (🌿 Fractal — enabled by default) appends a short pointer instruction to every outgoing prompt so Opus emits a two-section reply: `💬 ANSWER` → `🌿 FRACTAL`. The sections are split client-side and rendered as stacked bubbles: answer expanded, fractal collapsed. **(History:** there used to be a second `🧠 AMYGDALA` section + topbar button; both were removed — the always-on Amygdala side panel is the gate-decision surface now. The UI no longer splits, compacts, or fabricates a `🧠` block.)
- **Full-doctrine prompt (2026-08-22 — SUPERSEDES the pointer-based design below):** the injected suffix inlines the WHOLE doctrine. `FRACTAL_DOCTRINE` in `tinker-ui/src/app.ts` is generated from `extensions/tinkerclaw-fractal-reflection/fractal-prompt.md` by `scripts/sync-fractal-prompt.mjs`, and `scripts/check-fractal-prompt-sync.mjs` fails on drift. **(History:** the suffix used to be a short pointer _referencing_ `fractal-prompt.md`, read at tinker-bridge spawn time. That loader stopped firing and nobody noticed: the .md files kept being edited while the only live copy — a string literal here — eroded from 24.7 KB to 1.4 KB. A prompt file with no loader is a decoy that absorbs work and changes no behaviour. The architect chose the full doctrine "no matter the cost".)
- **User bubble:** when fractal is enabled, the user sees only their original text, plus one small `🌿 fractal prompt ↗` link (`renderUserBubbleWithPromptToggle`) — a `.fs-link` <code> carrying `FRACTAL_PROMPT_PATH`, so a click opens the real `fractal-prompt.md` in the system viewer via `config.openExternalFile`. **(History:** it was a "view full prompt" `<details>` expander that re-rendered the injected text through `md()` into a scroll box. The architect, 2026-08-22: _"no shortcuts, no summaries, the real thing right away"_ — the same call he made on the ORCA card 2026-07-26. A link cannot drift from the file; a second rendering can.) The sync check pins `FRACTAL_PROMPT_PATH` to the same .md the doctrine is generated from, so the link can never point at a decoy copy. When the toggle is off, nothing is appended and no link renders.
- **Section splitter:** `splitSectionedReply` accepts markers wrapped in `**`/`__` bold, optional trailing `:`, AND optional markdown heading prefixes `#` through `####` — `💬 ANSWER`, `🧠 AMYGDALA` (with 🫀 fallback), `🌿 FRACTAL` (optionally `FRACTAL ACTION`). Regex pattern: `(^|\n)\s*#{0,4}\s*(?:\*\*|__)?\s*<emoji>\s*(?:\*\*|__)?\s*<LABEL>\s*:?\s*(?:\*\*|__)?\s*:?\s*`. `renderSectionedReply` promotes `other` to the answer slot when Opus emits a non-sectioned response with amygdala/fractal after. **Don't regress (commit `d32e44cc24`, 2026-05-24):** when Opus starts emitting H2 headings (`## 💬 ANSWER`) instead of bare markers, the `#{0,4}\s*` slot in the regex MUST stay — without it the splitter returns null and the entire reply renders as ONE bubble with all three section markers as literal H2 text. The variant shapes the regex must match: `💬 ANSWER:`, `💬 **ANSWER**`, `💬 **ANSWER:**`, `## 💬 ANSWER`, `### 💬 ANSWER`, `**💬 ANSWER**`.
- **Icons:** Models icon changed from 🧠 to 🕸️ (pink brain reserved for amygdala). Icon glyphs: `🧠` amygdala, `🌿` fractal.
- **Files:** `tinker-ui/src/app.ts` (`buildInjectedPrompt`, `loadInjectToggles`, `renderUserBubbleWithPromptToggle`, `FRACTAL_DOCTRINE`, `FRACTAL_PROMPT_PATH`), `tinker-ui/src/sectioned-reply.ts` (`splitSectionedReply`, `renderSectionedReply` — extracted + unit-tested 2026-06-10, amygdala-free), `tinker-ui/src/styles/base.css` (`msg-user-with-prompt`, `user-prompt-link`, `fractal-details` styles; `msg-amygdala` now unused), `extensions/tinkerclaw-fractal-reflection/fractal-prompt.md` (the doctrine's source of truth), `scripts/sync-fractal-prompt.mjs` + `scripts/check-fractal-prompt-sync.mjs` (generator + drift guard)

### 5.67a Parallel Fractal Reflection — v2 redesign (DESIGN, 2026-06-11)

- **Status:** `DESIGN — building` (owner-approved 2026-06-11; supersedes the in-band injection of §5.67 — flip §5.67 to `SUPERSEDED` when v2 ships). Full design history + file-level grounding: jarvis-icu commit `b9aedcf` + three code-verified research passes. **AMENDED by §5.67b (v3, same day — 34-agent adversarial redesign pass): read both; where they conflict §5.67b wins.** The "build the whole thing in one drop" owner decision is revised there into staged owner-visible drops (Drop 1 touches zero core code).
- **Why:** the in-band fractal (§5.67) stopped contributing — the strong standalone plugin is `enabled:false`, and the baked-in `--append-system-prompt` section is trivially phoned-in. When the standalone plugin WAS on, commit `58cc3dc772e` (2026-04-17) regressed it from a polite follow-up to a `sessions.steer`/`interruptIfActive` racer that cancels the very turn it reflects on (one run-lane per sessionKey). **Cost reframe:** the live brain is subscription-billed ($0/token; the real cost is Max-plan quota + latency), so the original "cheap baked-in section to save tokens" trade was the wrong lever — it saved nothing and gutted the feature.
- **What (v2):** fractal becomes a **parallel, off-channel reflection plugin** fired from the public `agent_end` hook (fire-and-forget; carries `runId`, `messages`, `sessionKey`), running on its **own runId** in a dedicated `"fractal"` command lane. Lanes are independent queues, so it **never blocks the user's main reply** — the `ReplyRunAlreadyActiveError` retry/backoff machinery in `fractal-inject.ts` becomes obsolete.
- **Two-phase thinking:** a cheap **low-thinking triage** every turn; on a find it **escalates to a fresh max-thinking fix lane** — NOT an in-place dial-up, because tinker-bridge pins `MAX_THINKING_TOKENS` at worker spawn (see `tool-loop.md`), so escalation is a new spawn, not a slider change on the warm worker.
- **Cache — don't micro-manage it:** ZERO custom cache code on the tinker-bridge subscription path. claude-cli auto-caches (Claude-Code-grade); warm re-read comes from **forking the main session** (`--resume <mainSessionId> --fork-session`) so the transcript prefix serves warm and only the short fractal instruction + reflection output are fresh. Explicit `cache_control` tagging (`applyAnthropicPayloadPolicyToParams`, gated on `enableCacheControl`) exists ONLY on the metered native-Anthropic/pi-ai provider — the vanilla path — NOT tinker-bridge. See `tool-loop.md` (tinker-bridge) + `config-shape.md` (`enableCacheControl`).
- **Honest file attribution:** "fractal changed X" vs "main turn changed Y" derives from **per-runId `tool.result` events** (fractal runId vs main runId), retiring the fake `detectFileChange` prose-scrape in `sectioned-reply.ts`.
- **Autonomy:** FULL autonomy — acts on anything (files, code, memory, recipes) — bounded ONLY by **ORCA safe-write leasing** so it never clobbers a file the user's concurrent follow-up is editing. No other hard "never" lines (owner decision 2026-06-11).
- **Render:** a `stream:"fractal"` agent event carries `{parentRunId, status, verdict, fractalChanges[], mainChanges[], reasoning}`; the UI docks a **compacted block under the answer it judged** (matched by `parentRunId`), reusing the collapsed Commentary chrome (`<details class="reasoning-group narration-details">`). Status word is the liveness signal: `acted` / `clean` / `⚠ error`. Structural owner: `tinker-ui.md` §5.72/§5.74 (which also deletes the two legacy standalone-fractal render blocks in `app.ts`).
- **Vanilla-portable:** ONE bundled plugin — `agent_end` + `api.runtime.subagent.run` (the primitive the stock memory-core "dreaming" plugin already uses) + provider-branch (fork-session on tinker-bridge / explicit `cache_control` on the API path) + a `fractal.byRunId` gateway RPC. Stock webchat can't inject reply markup (`registerControlUiDescriptor` is metadata-only), so vanilla degrades to a plain-text reflection line; the pretty compacted bubble is the only fork-only piece.
- **Loop guard (don't regress):** structured run meta `{kind:'fractal-reflection', parentRunId}` with a first-line short-circuit at the hook. **NO string-matching** on `🌿` / `# FRACTAL REFLECTION` — that brittle guard (`fractal-inject.ts`, `heartbeat-runner.ts`) caused the §11.14 8×-per-turn fire and a permanent self-detection block. Retire it.
- **v1 scope:** always-fire every turn (prove reliability first); substantive-turn gating is deferred future work (when it returns: skips are made at the hook and surfaced as `skipped(reason)` ledger rows — never a silent prompt-side skip — and gated on live signal, not turn category: "an announce revealing something genuinely new — unexpected failure, novel error, structural surprise — still reflects" [salvaged from the v1 prompt's skip_list], per #19; it graduates INTO the §5.67b governor as the derived judge of substance).
- **tinker-bridge tweak in scope (owner-approved):** the load-bearing new primitive is "boot a named lane's tinker-bridge worker by **forking a specific parent session id**" — the stock subagent spawn mints a fresh child sessionKey (cold prefix); the warm path needs this small extension. Phase the build so the pipeline (parallel + render + attribution) can validate on a cold-but-correct fallback first, then settle the warm-fork and confirm with a live `cache_read_input_tokens` probe.
- **Structural owners to populate as v2 lands (with `verify` blocks):** `tool-loop.md` (tinker-bridge fork-session + thinking-pinned-at-spawn + the parent-session fork extension), `tinker-ui.md` §5.72/§5.74 (compacted render + legacy-path/prose-scrape deletion), `flows.md` (the `agent_end → triage → escalate → fractal-event → render` sequence; today's §555 "NOT a fractal trigger" note stays accurate), `subagents-and-recipes.md` (the `"fractal"` lane spawn + `setCommandLaneConcurrency`), `config-shape.md` (plugin config keys: `enabled`, `triageThinkLevel`, `fixThinkLevel`, `laneConcurrency`, `maxFixTurnsCeiling` — `minGapMs` RETIRED per §5.67b).

### 5.67b Parallel Fractal Reflection — v3 amendments (DESIGN, 2026-06-11, adversarially verified)

- **Status:** `DESIGN — amends §5.67a` (same-day correction layer from a 34-agent ground-truth audit + 4-lens redesign + adversarial verification, run on Fable; 20 insights survived, 1 killed). §5.67a's architecture stands; every bullet below is a verified correction or addition. Where §5.67a and this conflict, **this wins**. Three v2 mechanisms were found unbuildable-as-written (result store, loop guard, attribution source) — the build MUST use the corrected forms below. **Foundations-conformance pass (same day, 52-agent sweep + adversarial adjudication):** 22 contradictions/gaps vs FOUNDATION + design-principles confirmed and folded in below — headline: the quota governor's frozen 70%/85% was FOUNDATION #2's verbatim forbidden example, now a derived bidirectional pressure score; `--max-turns` hard-abort → graceful wind-down per #19; the autonomy boundary gained its #1/#7 loosening path + reversibility brake; the canonical L0-L3 level ladder replaces the v1 prompt's clashing Level 1-4. **Drop 0 EXECUTED:** live probe confirms `--fork-session` serves the prefix WARM (cache_read=155,495 / cache_creation=10,877 on a 150k forked prefix) — A2 justified; live brain already ~82% warm globally.
- **Result store (BUG FIX, don't-regress):** `setRunContext`/`getRunContext` CANNOT back `fractal.byRunId` — the run-context store refuses writes for closed runs (`host-hook-runtime.ts:117`), is cleared on the parent's terminal event (`:271-278`), and the fractal result only exists 30–120s AFTER R_main ends. Store = append-only JSONL ledger at `<stateDir>/fractal/results.jsonl` (amygdala `AMYGDALA_DECISIONS_PATH` pattern; version-stamped rows: ids, status+reason, verdict, findingKind, scope, usage{input,output,cacheRead,cacheWrite}, queueWaitMs, timeToDockMs, escalated). `fractal.byRunId` reads it (restart-safe); sibling RPCs `fractal.stats` (the KPI set that DEFINES "contributing": fire/skip histogram, escalation rate, fix-yield, abstain rate, warm-ratio, p50/p95 timeToDock, quota/turn) + `fractal.feed`. **Warm-ratio = cacheRead/(input+cacheRead+cacheWrite) per triage is the standing prefix-stability regression detector.** Panel chip deferred until a week of rows.
- **Loop guard (REWRITTEN, don't-regress):** `ctx.meta` has NO carrier today (zero hits in `hook-types.ts:183-196`; neither spawn params nor the agent RPC accept meta) — v2's first-line guard was unbuildable. Primary guard = plugin-minted identity: spawn with sessionKey prefix `fractal-reflection:` + keep returned runIds in a Set; layered FAIL-CLOSED — L1 `ctx.meta.kind` once a shared discriminator lands, L2 prefix/Set check (both read via the ONE canonical predicate — see cross-consumer below), L3 global token bucket ~30 spawns/h CEILING emitting `skipped:budget`. L2/L3 hits log loudly as plumbing alarms. idempotencyKeys are PHASE-SCOPED (`fractal:triage:<parentRunId>` / `fractal:fix:<parentRunId>` — gateway dedupe is keyed at COMPLETION only, so the plugin Set is the in-flight guard, idempotency the crash backstop). `minGapMs` RETIRED (config key deleted; §5.67a's key list amended): same-parent double-fire is owned by the in-flight Set + phase-scoped idempotencyKeys, rapid-turn suppression by single-flight/latest-wins (emits `skipped:superseded`) — a wall-clock min-gap is a second derivation (#18), a frozen quantity threshold (#19), and a silent non-fire with no skip-reason arm (#12). Any future debounce must emit its own ledger reason and carry a #19 derivation. The §5.67a string-match ban targets in-band model-output markers; out-of-band plugin-minted identifiers are the same class as the meta check — allowed.
- **Status union grows:** `pending | flagged | skipped(reason: quota|superseded|budget) | proposed | applied | dismissed | suspended` + fields `evidence{claim,path,verbatimQuote}`, `abstained?`, `verification{kind,passed}`, `hard?`, `artifactsTouched[]`, verdict arm `gap`. `fractalChanges`/`mainChanges` ship present-but-empty in Drop 1 (`flagged` = found-not-fixed; sizes the fix backlog before autonomy is armed).
- **Two-event contract (liveness):** a `pending` stub emits at spawn (UI docks a collapsed placeholder instantly, fills in place), the final event replaces it; a server watchdog converts dead-run stubs to `error` **only on verified deadness** — the run/lane registry reports the runId terminal-or-gone, or zero run events for that runId within the liveness ceiling — never wall-clock since spawn (#19: the 120s idle kill is the canonical bug; FOUNDATION: liveness checks never assert doneness); the ceiling boots as a frozen safety CEILING (~120s of total event silence) and is re-derived from the ledger's own p50/p95 timeToDock once rows exist. Gateway-crash covered client-side (reconnect re-queries `fractal.byRunId`). Dock-latency = recorded metric + tuning target (numbers set from live data, not a CI gate). This contract RETIRES the prompt's "Always respond" heartbeat rule (`fractal-prompt.md:200`) — liveness is infrastructure, not model prose: `skipped` turns spawn no model and emit only the terminal event.
- **Non-fire negative evidence (NEW — principle #12, FOUNDATION #5):** the watchdog only converts stubs that EXIST; a dead handler / unloaded plugin / lost enable flag emits no stub and no row — the exact silent non-fire that killed v1 (`enabled:false`) and the dead-producer class FOUNDATION #5 most distrusts. Invariant under always-fire: every main-turn `agent_end` yields exactly one ledger row (incl. `skipped`/`suspended`). Detect OUTSIDE the plugin's fate, zero core code: (1) `fractal.stats` exposes `missedTurns` = independent main-turn count minus ledger row count over the window; (2) a `failures.md` entry `fractal-silent-non-fire` whose `diagnose_with:` probe reconciles main-session turn ends (session jsonl) against `results.jsonl` rows, `manifest_via:` = flip the plugin enable flag off (the #13 round-trip); (3) tinker-ui flags a missing `pending` stub under a fresh answer after a derived window. Ships with Drop 1; spec §11 gains the negative test: kill the plugin → detector fires.
- **Attribution (mechanism REPLACED, don't-regress):** tinker-bridge `tool.result` bus events carry NO tool name/args (`stream.ts:316-345`) and R_main's tool events pre-date `agent_end` — live-bus collection is impossible. Source = persisted `customType:'tinker-bridge-tool'` transcript entries (toolCallId start↔result join), read behind a settle/retry guard (the drain at `attempt-hooks.ts:829-877` is fire-and-forget async). Ships with the fix-lane drop. **Reporting-channel rule (FOUNDATION #4/#5, #11):** any fractal capability claim ("fixed/changed X") renders ONLY from tool-event-derived ledger fields (`artifactsTouched[]`, `verification{}`, per-runId transcript attribution) — model prose is narrative, never telemetry; no successor of the `detectFileChange` prose-scrape or "🌿 FRACTAL ACTION:" self-attestation may become a data source again.
- **Lane observability grain (FOUNDATION #4 — tool use fully rendered; NEW):** fractal lanes are ordinary runs through `attempt.ts`, so the per-run machinery fires automatically — anatomy row + forensic dump, per-subagent `stream:"effort"` chip, prefrontal call-tree row. The cross-consumer skip in prefrontal MUST be scoped to the recipe-panel state writer ONLY — never the call-tree/`tool_call` feed — so a running fractal lane keeps a live row for the operator. The docked block's EXPANDED view replays the lane's full tool timeline from the same persisted `customType:'tinker-bridge-tool'` join the attribution bullet reads (zero new producers). Live grain while a fix lane edits: the pending stub's fill-in-place channel carries safeWrite/ORCA lease acquisitions ("fixing — editing <path>") — the plugin mediates every lease, so live file-touch visibility costs no tinker-bridge plumbing.
- **Flood control (NEW):** lane splits into `fractal-triage`/`fractal-fix` (coalescing can never cancel a queued fix). Single-flight + latest-wins per session (`clearCommandLane` rejects QUEUED only and is lane-global — keep pending-slot bookkeeping per sessionKey). Quota governor on `usage.status` with a plugin-side TTL memo (`provider-usage.cache.ts` is DEAD CODE, zero importers — do not rely on it; the gateway has NO fresh quota signal for the tinker-bridge subscription path, so 403/absent ⇒ fail-to-neutral: the throttle branch falls back to the `maxFixSpawnsPerHour` CEILING, the spend branch disarms): **BIDIRECTIONAL, driven by one DERIVED pressure score p = f(5h utilization, time-to-reset, value-of-finding)** — FOUNDATION #2 names this exact case ("budget weighs real remaining allowance AND time-to-reset — never a frozen '70%'"); mode degrades progressively full → triage-only → `skipped:quota` as derived pressure rises (an evidence-backed queued fix outranks speculative triage; high utilization minutes before reset is spendable surplus, not pressure). **Surplus-spend branch** (FOUNDATION Budget doctrine — surplus before a reset is welcome spend): low utilization + short time-to-reset LOWERS the escalation bar — more fix-lane spawns, deeper post-edit verification, opportunistic runs of the deferred L3 meta-pass / staleness scan; arms with the fix-lane drop (Drop 1's cold triage-only has nothing to spend on); surplus mode NEVER raises the safety ceilings (the loop-guard token bucket and circuit breaker are plumbing alarms, not quota optimizers). Any numeric constants in the score are documented safety CEILINGS with their derivation formula in `config-shape.md` per #19, with a `quota-pressure` warn/trail event as pressure rises instead of a cliff. When substantive-turn gating lands (deferred per §5.67a) it graduates INTO this governor as the derived judge of substance — never a second frozen layer. Circuit breaker 3 fails → OPEN 15min → half-open probe; one `suspended` event. **Supervised detach:** handler returns inside the 30s `agent_end` void-hook timeout; the whole cycle is ONE rooted promise chain, zero floating promises (every contained rejection writes a stability bundle; 25/60s exits the gateway — `unhandled-rejections.ts:484-498`; the playwright-relay crash class).
- **Safety ceilings carry #19 discipline (NEW):** every fixed number in this design is a CEILING, never the working bound (design-principles #19; FOUNDATION Budget doctrine). Each gets its derivation formula in `config-shape.md` in the same drop that ships it: token bucket ≈ p95 observed main-turn rate × 2 lanes/turn × safety factor (recompute from ledger rows); breaker open-time derived per failure class (quota-blind vs crash); quota-memo TTL ≈ usage-endpoint staleness, not a flat 5 min. Each emits an adaptive-pressure `warn` trail event as it is approached (~80% of ceiling), not only `skipped` at the cliff. `maxFixSpawnsPerHour` binds ONLY when `usage.status` is blind (403/absent), and even then the plugin first estimates consumption from its own ledger `usage{}` rows, keeping the fixed cap as the outermost ceiling. Triage `low`≈4000 is the existing harness think-level mapping (configurable), not a new number; `laneConcurrency` keeps its v1 single-user rationale and gets a formula only when widened.
- **Lane caps (live path corrected):** SS5b `allowTools`/`maxTokens`/`maxToolCalls` are INERT on tinker-bridge (it doesn't own the tool loop — `tool-loop.md`). Live enforcement at claude-cli spawn: triage → per-spawn `disallowedTools` (Edit/Write/NotebookEdit/Bash) making "triage never edits" **structural, not prompt obedience** — the doctrine prompts split to match: the triage prompt says FLAG-with-evidence (never "edit now"), the fix-lane prompt inherits the act-before-explaining / convert-should-to-action imperatives verbatim; fix → `--max-turns` as a safety CEILING only (#19): the working turn budget is derived per-spawn from the finding's scope (files in evidence, findingKind) and capped by config `maxFixTurnsCeiling`; the budget + wind-down instruction live in the SPAWN prompt ("approaching your turn budget: stop editing, persist a summary of remaining work") — never mid-run steering (the §5.67a retired racer). On `error_max_turns` the terminal status is `flagged` with `incomplete:true` + `artifactsTouched[]` (from the transcript join, which survives exhaustion) and the cheapest scoped verifier STILL runs plugin-side and is stamped — NOT `error:`; budget-exhaustion does NOT count toward the circuit breaker, and the ledger row is resumable by the next triage or the L3 pass. SS5b params remain as the vanilla half only.
- **Autonomy boundary (⚠ amends the 2026-06-11 "no hard lines" owner decision — pending owner ratification):** full autonomy stays EXCEPT four host-self-mod classes that become one-click PROPOSALS (`<stateDir>/fractal/proposals/*.patch`, `status:'proposed'`) instead of direct action: (1) the live `openclaw.json` (chokidar hot-reload — one wrong edit applies mid-session); (2) fractal's own prompts/source — **v1's "self-improve this prompt" doctrine is RETIRED in ALL FOUR instances (`fractal-prompt.md:214` response_rules; `:124` SELF-HEAL Immunize; `:138` RECIPE "patch it here too"; `:212`); v3 prompts replace each with "emit a `status:'proposed'` record carrying the exact patch"**; (3) gateway `dist/` + build invocations; (4) `systemctl` on its own unit. (1)-(2) enforced in safeWrite; (3)-(4) at the tool-permission layer (they are commands, not writes). Accident guard, not adversarial sandbox. **Paired read/act surface (principle #11 — ships in the SAME drop that arms the boundary):** pending-list = `fractal.feed` filtered `status:'proposed'` + `fractal.byRunId` (the ledger row carries the patch path + evidence — no new list RPC, #18); mutations `fractal.proposals.apply`/`fractal.proposals.dismiss` transition the row `proposed→applied|dismissed`; UI = a pending-proposals count badge. **Loosening path (what keeps this FOUNDATION #1/#7-compliant — a confidence-staged brake, NOT a forbidden-zone list):** each class starts propose-only because its rollback machinery lives inside the thing being modified; per class, after a run of consecutive owner-accepted proposals with zero rollbacks (tracked in the ledger, threshold owner-set per #19 — a ceiling, reviewed by the L3 meta-pass), the class graduates to apply-with-snapshot: direct action + automatic rollback artifact + `fractal.suspend` kill-switch, proposals file retained as the rollback record. No class is permanently propose-only. **Reversibility brake (FOUNDATION #1/#7-derived, same pending ratification):** beyond the four classes, the fix lane classifies every action by REVERSIBILITY — a derived property, not a zone list: reversible (file edits in git-tracked trees under ORCA lease, additive memory writes) → act freely; irreversible (external sends, deletions outside never-delete stores, `git push`, service restarts, financial commitments) → the same proposals queue. Any fractal-initiated public push runs the PII leak-grep gate first. Enforced at the tool-permission layer — structural, not prompt obedience.
- **Prompt doctrine ownership (NEW — closes the v1 prompt's fate):** `fractal-prompt.md` is today a dead producer — tinker-bridge loads it at worker spawn then discards it (`void rulesBody`, `worker.ts:~475`). Single canonical source (#18): the plugin ships `triage-prompt.md` + `fix-prompt.md`; `fractal-prompt.md` is REWRITTEN into that pair in Drop 1 — surviving doctrine migrates (zoom levels as un-numbered prose, horizontal branch axes, the seven questions recut: triage gets the detect half FLAG-with-evidence, fix gets the act half), the skip_list dies (always-fire is structural; its "genuinely new still reflects" nuance is salvaged into the future-gating note), the "Always respond" heartbeat rule dies (liveness is infrastructure: the two-event contract — never instruct a model to emit filler), the 🌿 output-marker contract dies (the plugin parses ONE structured verdict block; no consumer parses prose; 🌿 survives only as UI chrome), SELF-HEAL Layer-1 self-introspection dies (a never-firing reflection cannot observe its own silence — that layer is owned by the loop guard + ledger + watchdog; Layers 2-4 renumber 1-3, triage probes read-only, repairs are fix-lane work), and the PREEMPT doubt-default flips from "when in doubt treat as irreversible" to "check reversibility against the live situation; create a rollback path and act; propose only when genuinely irreversible AND external" (FOUNDATION #1). Bible `verify:` asserts the pair exists and `fractal-prompt.md` is gone (#16); de-stale §5.66's Files line + the memory pointer. The dead tinker-bridge loader is deleted in the first drop that touches tinker-bridge core (NOT Drop 1 — zero-core rule).
- **Fix-lane contract (verify-before-and-after):** `act` requires falsifiable evidence incl. a verbatim quote from disk; the plugin re-verifies the quote ON DISK before spawning the expensive fix (stale/already-fixed re-flags — structurally guaranteed, the fork never sees the fix lane's edits — converge to one file read + `abstained`); post-edit, the cheapest scoped verifier runs and is stamped on the record (vitest with zero matched tests = `kind:'none'`, never `passed:true`; `tsgo:extensions` judged by touched-path baseline diff — it exits non-zero on pre-existing drift).
- **Transport + model (coupled config):** `triageArm: 'fork-warm'|'observer'|'cold'` + `fixModel` (default = main model). Validation: fork-warm LOCKS model = parent (**caches are per-model — fork + model switch = silent cold re-prefill**, the most likely future regression); models with `reasoning:false` invalid for thinking arms (the think-budget mapper never consults the flag). Observer arm = one persistent per-main-session observer via `api.runtime.subagent.run` with a plugin-minted stable key (dreaming pattern, zero tinker-bridge changes) fed per-turn delta digests — the only arm that reliably docks in seconds. Fork-lane workers get one-shot eviction (no 15-min idle parking, `worker-pool.ts:69`).
- **Pre-build decision gate (Drop 0, replaces the post-build probe):** `--fork-session` exists NOWHERE in shipped code (grep zero; only `--resume` at `worker.ts:495-500`) — A2's honest footprint is ~6 touchpoints mirroring the `__openclawThinkLevel` chain, and the warm-fork economics are unknowable from code. Before building A2: zero-spend mining of `~/.openclaw/agents/main/sessions/*.jsonl` cacheRead ratios + a standalone 3-arm probe (`claude --resume <id> --fork-session -p … --output-format json` against `session-map.json`; arms: warm-opus-fork / cold / fork+cheaper-model). Kill rules: fork shows cacheWrite≈prefix → warm premise dead → ship cold arm (equal cost, zero core risk). Byte-stable prefix check: capture a live worker's argv verbatim from `/proc/<pid>/cmdline`, never re-implement the assembly.
- **Cross-consumer hygiene (NEW):** `agent_end` has THREE source subscribers; tinkerclaw-prefrontal's is LIVE and would stomp the active-main recipe-panel state every time a fractal lane ends. Add ONE shared optional run-kind discriminator to the core hook ctx (both emit sites — `attempt.ts` and `cli-runner.ts` diverge in payload semantics; tolerate both) + one-line skips in prefrontal, skill-workshop, memory-lancedb. Per #18 the run-kind concept gets ONE canonical predicate: a single exported helper (`isFractalRun(ctx)`) + the `fractal-reflection:` prefix as a single exported constant, both in one shared module; the consumer skips AND the plugin's L1/L2 reads route through it — consumers never inline the prefix string (the plugin's runId Set stays private: it answers "did I spawn this run", an ownership guard, not the classifier). Drop-1 interim (the discriminator needs core emit-site edits, which Drop 1 excludes): the skips call the same helper in prefix-only mode. Canonical home: `subagents-and-recipes.md`, with a `verify:` that fails on any literal `fractal-reflection:` outside the canonical module.
- **Multi-scale (the paper's §9, staged):** Canonical level ladder (the ONLY "Level" taxonomy, per #18 — paper v8 §9 and the v3 prompts both index by the OBJECT observed): **L0 GROUNDING** (owned-knowledge vs answer; the `gap` verdict), **L1 OUTCOME** (the turn's concrete result), **L2 PROCESS** (this episode's trace; = every-turn triage), **L3 META-PATTERN** (cross-episode recurrence from ledger rows; = nightly pass; worldview/assumption revision is an L3 adapt-target, not a fifth rung). The v1 prompt's "Level 1-4 (thing/pattern/system/worldview)" numbering is RETIRED; the zoom rhetoric survives as un-numbered prose inside the L2/L3 instructions. The killed-by-review path was a unified `reflect(scope)` engine (recreates the monolith-prompt failure; plumbing is already scale-agnostic — add only an optional `scope:'turn'` field to the run identity now). What ships instead, in order: **gap verdict** (paper L0 post-hoc: triage checks owned-knowledge grounding against a digest the PLUGIN assembles — the retrieval pack is pinned at worker spawn and a fork child does NOT inherit it, carry it explicitly; gap-fix re-searches `recall`/engram, additive writes only) → **staleness scan** (after each fix, grep configured `artifactRoots` — bible + papers + workspace notes — for documented claims the finding contradicts; repair under the same safety machinery; acceptance = `bible:invariants`) → **write-back** (tactical notes on `acted` into dated episodic memory; engram seam deferred — engram has zero plugin-SDK surface) → **L3 nightly meta-pass** (managed cron ~04:30 reading LEDGER SLICES never transcripts; spots recurring finding-classes; ordinary fixes autonomous, self-mods → the proposals queue; "fix the column, not the cell" — needs weeks of ledger rows first) → **deliberation seam** (`hard:boolean` tag now; `fork.reasoning.search` wiring gated on a live A/B — the RPC is ungated-but-cold-spawning and its `parentSessionKey` is hardcoded `agent:main:main`).
- **UI (don't-regress):** add `"fractal"` to `KNOWN_STREAMS` (`app.ts:4022`) — else the 06-11 unknown-stream fallback renders a raw `[fractal]` bubble; renderer body lives in a NEW one-concern module `tinker-ui/src/fractal-dock.ts` (+ test), mirroring the 2026-06-10 `sectioned-reply.ts` extraction (principles #1/#6) — `app.ts` keeps ONLY the `KNOWN_STREAMS` entry, a one-line dispatch into the module, and the dock-attach lookup that reads app.ts-owned message state (#18 colocation); **emit the event envelope under the MAIN session's sessionKey** (all stream consumers are sessionKey-gated return-early; lane runIds ride in `data`). Dock via `_fractalParentRunId`-tagged message (the `_reasoningRunId`/`_subagentId` precedent — answer bubbles carry NO runId in the DOM). Re-pinned anchors: stream handlers `app.ts:~3158-3309`, legacy fractal blocks `5888-5909`/`6066-6085`, `detectFileChange` `sectioned-reply.ts:254-268` (it moved INTO sectioned-reply with its tests). Legacy in-band render stays toggle-default-off until Drop-1 smoke, deleted Drop 1.1.
- **Deploy (REVISED — staged drops, kill switch):** **Drop 1 touches ZERO core code** (the agent RPC already accepts `{message,sessionKey,lane,thinking,deliver:false,idempotencyKey,label}`; `AgentEventStream` is open — no union edit): cold-arm triage-only + ledger + governor + UI dock. Manifest `enabledByDefault:false` (inverts the plan's enable-by-default); go-live = one witnessed `plugins.entries` flag flip strictly after smoke — **the flip is Drop 1's EXIT CRITERION: Drop 1 is not DONE until it happens** (default-off is kill-switch staging per FOUNDATION #1, never an end-state). Any drop touching tinker-bridge core gets its OWN build-to-completion → healthz 200 → clean-main-turn gate (the nightly fork-sync cron rebuilds the live repo — committed core code deploys unverified otherwise). `fractal.suspend`/`fractal.resume` RPCs, paired (#11) with a **`fractal.status`** read returning the live control state every transition mutates: `{enabled, suspended, suspendReason, breakerState(+opensAtTs), governorMode, derivedPressure, bucketRemaining}` — the one-shot `suspended` event is notification, NOT the probe; a late-connecting client queries `fractal.status`, which is also the data source for the deferred panel chip. Suspension persists in plugin state — restart does NOT re-arm.

### 5.68 Clickable Filesystem Path Links (2026-04-19, **server handler restored 2026-05-09 after upstream-merge wipe**)

- **Status:** `DEPLOYED`
- **What:** Any absolute path or `~/...` path rendered in a message (including the injected instruction suffix) becomes a `<code class="fs-link">` element. Clicking opens the file in the system's default viewer (markdown reader for `.md`, code editor for `.ts`, etc.) via a `config.openExternalFile` RPC that shells out to `xdg-open` / `open` / `Start-Process` depending on platform.
- **Why:** section 2 and 3 of every reply reference the pointer `.md` files — users need one-click access without leaving the chat.
- **Files:**
  - `tinker-ui/src/app.ts` — `md()` post-processor wraps paths (line ~2581), global click delegate at line ~5777 calls `config.openExternalFile`. CSS state classes: `fs-link-opening`, `fs-link-opened`, `fs-link-error`.
  - `src/gateway/server-methods/config-open-external.ts` — handler implementation. ADMIN_SCOPE (`method-scopes.ts`). Allowlist: workspaceDir, `~/.openclaw`, `~/src/tinkerclaw`, `~/src/jarvis-icu`. Tilde expansion + path-traversal rejection + cross-platform spawn (xdg-open / open / cmd.exe start). Test seam `__setSpawnImplForTest`.
- **Don't regress (2026-05-09 incident):** the server-side handler was wiped by an upstream merge sometime between 2026-04-19 and 2026-05-09 — bible kept saying DEPLOYED, but a `grep -rn openExternalFile src/` returned zero hits. ALL `.fs-link` clicks across Tinker (recipe paths, system-message pointers, briefing path, fractal pointers) were silently rejected by the gateway with `unknown method`. Surfaced when the new /new briefing summary path didn't open. **Add `config.openExternalFile` to a fork-merge-guardian invariant check** so the next upstream merge that drops it fails the gate instead of shipping silently broken.

### 5.69 Envelope Error Rendering — `__ERR_ENV__:` (2026-04-19)

- **Status:** `DEPLOYED`
- **What:** Provider errors (400 auth, 429 rate, 500 overload, 401 subscription-exhausted, etc.) are emitted as a single assistant text payload `__ERR_ENV__:{...JSON envelope}`. The UI detects the sentinel with a brace-matched parser and renders a red/orange bubble with one stable icon per category (💳 subscription, 💸 billing, 🔐 auth, 🚦 rate_limit, 🌊 overload, 📡 network, ⏱️ timeout, 🔄 lane_busy, ⏳ reply_run_already_active, 🫥 incomplete_turn, 🔧 tool_error, 🧹 compaction_error, ⚠️ generic) and the full error detail (raw message, provider, model, duration, classification). Fatal=red, recoverable=orange.
- **tinker-bridge integration:** on claude subprocess error or non-zero result, `stream.ts` RESETS accumulated text and emits the envelope as the sole final message — no markdown-emphasis-strip risk from the `__ERR_ENV__` underscores.
- **Files:** `src/fork/error-envelope.ts` (classifier + icon table + builder), `extensions/tinkerclaw-tinker-bridge/src/stream.ts` (envelope emission paths), `tinker-ui/src/app.ts` (`extractEnvelope`, `renderEnvelopeBubble`), `tinker-ui/src/styles/base.css` (envelope-fatal, envelope-recoverable).

### 5.70 Stale ReplyRunRegistry Force-Clear (2026-04-19)

- **Status:** `DEPLOYED`
- **What:** When a previous run crashed mid-stream the registry could be left holding a stale entry — the next prompt hit `ReplyRunAlreadyActiveError` and the UI displayed "⚠️ Previous run is still shutting down." Fix: in `createReplyOperation`, detect stale entries (phase completed/failed/aborted OR no attached backend OR backend not streaming) and force-delete them before claiming the slot.
- **Files:** `src/auto-reply/reply/reply-run-registry.ts` (stale-entry sweep in `createReplyOperation`).

### 5.71 Tinker Probe — CLI Test Harness (2026-04-20)

- **Status:** `DEPLOYED`
- **What:** `scripts/tinker-probe.mjs` is a standalone WS client that simulates the Tinker webchat so the agent loop can verify the UI contract without opening a browser. It:
  - authenticates as `webchat-ui` with the gateway token (auto-read from `~/.openclaw/openclaw.json`) and `Origin: http://127.0.0.1:18790`,
  - sends a `chat.send` to any sessionKey (default `agent:main:main`),
  - captures `lifecycle` (phase/model/provider/authProfileId), `assistant` (text deltas), `reasoning`, `tool_event`, and `fallback` events,
  - writes every inbound/outbound frame to `/tmp/tinker-probe.ndjson` for deep inspection,
  - polls `~/.openclaw/data/anatomy-timeline.db` after the turn and reports `total / newThisTurn / last row` so timeline-write regressions are caught immediately,
  - prints indicator predictions for all 4 thinking indicators (chat Opus, session panel, model glow, prefrontal tree).
- **Usage:** `node scripts/tinker-probe.mjs --prompt "..." --timeout 120 --raw /tmp/tinker-probe.ndjson`
- **Companion:** `scripts/db-probe.mjs` — static DB shape dump (schema, provider counts, recent rows, per-provider last 5). Used during triage.
- **Files:** `scripts/tinker-probe.mjs`, `scripts/db-probe.mjs`.

### 5.72 `onTurnComplete` Re-Wiring — Timeline DB Back Online (2026-04-20)

- **Status:** `DEPLOYED`
- **What:** The `anatomy-timeline.db` ingestion path went dark from 2026-04-15 → 2026-04-20 because the 309-commit upstream merge (`378684e4f5`) stripped the fork's `attempt-hooks` call site out of `attempt.ts`, and the `jarvis-working` baseline branch was created from `4a6a289d5a` — before the last auto-wiring commit (`d941184bad`) could re-apply it. Result: zero rows inserted for any provider for 5 days, even as turns completed successfully and the UI looked healthy.
- **Fix:** re-import `onTurnComplete` from `src/fork/attempt-hooks.js` and invoke it fire-and-forget right after the `llm_output` hook block, before `buildAttemptReplayMetadata`. This single call writes the anatomy row, triggers forensic dump, and does post-turn bookkeeping — persona injection / mid-context reinject / intercept-text-tool-call were intentionally NOT restored (tinker-bridge bypasses them; they're only needed for local ollama/lmstudio/vllm).
- **Verification:** `tinker-probe` post-turn shows `timeline-db: total=4519 newThisTurn=1, last row provider=claude-code model=claude-opus-4-7`.
- **Known gap:** `response_thinking_tokens` / `response_text_tokens` / `response_tool_call_tokens` are still null — these columns have been null across all 4518 historic rows, so the capture-side wiring in `embedded-agent-subscribe` + `attempt-hooks.updateAnatomyResponse` needs a separate pass (tracked, not fixed here).
- **Files:** `src/agents/embedded-agent-runner/run/attempt.ts` (import + call site, commit `7eccc0fe6d`).

### 5.73 tinker-bridge System-Prompt Fingerprint — The Subscription-Billing Boundary (2026-04-24)

- **Status:** `DEPLOYED` (commit `a307dca393`)
- **Why this entry exists:** after the 2026-04-20 regression Jarvis started getting `API Error 400 "out-of-extra-usage"` on every turn even though the Claude Max subscription had ~5% usage. We spent two sessions patching environment variables, cgroup paths, PPID lineage, and systemd-run flags before discovering the boundary is neither env nor cgroup — **it's prompt content**. This section documents what the boundary actually is so the next regression gets caught in minutes instead of days.

#### The boundary (one sentence)

**An LLM call made by `claude-cli` on a Max subscription is routed to the overage billing pool when the system prompt passed via `--append-system-prompt` contains markers that Anthropic's server-side classifier recognises as 3rd-party-harness tooling.** Strip those markers and the same call bills against the flat rate.

#### What actually makes a request "blocked" vs "allowed"

| Signal                                                | Observed impact on routing                                    | Status in tinker-bridge                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in env   | Bypasses OAuth → billed to API key, not subscription          | Stripped by `worker.ts` (allowlist env)                                                                                                                              |
| `CLAUDE_AI_SESSION_KEY` in env                        | Same — claude-cli prefers it over OAuth creds                 | Stripped                                                                                                                                                             |
| `OPENCLAW_*` env vars                                 | Previously suspected as classifier input; NOT confirmed alone | Stripped defensively                                                                                                                                                 |
| `OAuth creds at ~/.claude/.credentials.json`          | Required; stale/expired creds → 401, not 400                  | Trusted as-is; refresh handled by `credential-file.ts`                                                                                                               |
| Process cgroup under `openclaw-gateway.service`       | Previously suspected tell; `systemd-run --pipe` isolates it   | Wrapped in `systemd-run --user --pipe --unit=llm-client-<id>.service` — transient unit under `app.slice/`, PPid=1. Kept for defense-in-depth but NOT the actual fix. |
| PPid chain ending in `openclaw-gateway`               | Previously suspected; `--pipe` reparents to systemd           | Handled by the systemd-run wrapper                                                                                                                                   |
| **System-prompt content (`--append-system-prompt`)**  | **PRIMARY CLASSIFIER INPUT** — `out-of-extra-usage` trigger   | **Sliced at the `"You are a personal assistant running inside OpenClaw"` sentinel; everything after is dropped.**                                                    |
| User-message content                                  | No observed impact on routing                                 | Passed through unchanged                                                                                                                                             |
| `--model` / `--disallowedTools` / `--permission-mode` | No observed impact on routing                                 | Used freely                                                                                                                                                          |

#### The fingerprint (what Anthropic is matching on)

The strings that flipped routing from flat-rate to overage, measured by bisect:

- `"You are a personal assistant running inside OpenClaw"` (the sentinel phrase itself)
- Tool verbs that don't exist in a vanilla Claude Code install: `sessions_spawn`, `openclaw gateway start|stop|restart`, `sessions_list`, `sessions_history`, `sessions_send`, `subagents`, `agents_list`, `session_status`
- Runtime metadata: `repo=/home/.../.openclaw/workspace`, `channel=webchat`, `provider=webchat`, `agent=main`
- The OpenClaw CLI Quick Reference block
- The inbound-metadata JSON envelope (`"schema": "openclaw.inbound_meta.v2"`)
- The Heartbeats section that mentions `OpenClaw treats a leading/trailing "HEARTBEAT_OK"` (self-identifying as a harness)

Each of those is a concrete tool catalog / harness self-identification — exactly what a vanilla `claude` install would never carry. **Prose mentions of "OpenClaw" alone do NOT trip the classifier** — the three fork narration blocks (subagent helper, tool-choice, chat narration) all mention OpenClaw in documentation form and bill the subscription fine. It's the executable-tool shape and the runtime fingerprint lines that matter.

#### Bisect proof

| Commit                          | Role                                 | Result                  |
| ------------------------------- | ------------------------------------ | ----------------------- |
| `4a6a289d5a`                    | Merge-base (pre–309-commit merge)    | ✅ Subscription billed  |
| `3db21784ad`                    | Raw 309-commit merge, no fork wiring | ✅ Subscription billed  |
| `378684e4f5`                    | Fork-wiring applied post-merge       | ❌ `out-of-extra-usage` |
| …every commit after 378684e4f5… | Inherits the failure                 | ❌                      |
| `a307dca393`                    | System-prompt slice (this fix)       | ✅ Subscription billed  |

The only change in `378684e4f5` that affects what Anthropic sees is `src/agents/system-prompt.ts:buildAgentSystemPrompt` — it was enriched with persona + AMYGDALA + CORTEX blocks and the "You are a personal assistant running inside OpenClaw" tool-policy section. Everything else (`errors.ts`, `failover-matches.ts`, `assistant-failover.ts`, `attempt.ts` hook call sites) affects how the fork CLASSIFIES responses it receives, not what it sends.

#### Reauth finding — what this session settled about credential rotation

Before finding the boundary we suspected the `budget-panel`'s `forceRefreshToken()` was silently rotating `~/.claude/.credentials.json` into a tainted token. **It's not the cause.** Observed:

- `forceRefreshToken()` logs `[budget-panel] <profile>: token rotated for fresh rate limit window` on every run — journalctl showed zero such lines across every failure window.
- `~/.claude/.credentials.json` mtime tracked actual claude-cli auto-refresh, not budget-panel writes.
- The same credentials that fail on `main` work on the `dev/bisect-harness` branch (commit `37530fef28`) — if the token were the problem both branches would fail.
- A bare-shell `claude --print` with a minimal env allowlist bills the subscription correctly using the same credentials file, on the same host, at the same time as the gateway returns 400.

Conclusion: **the OAuth credential pipeline is healthy.** Reauth concerns, proactive refresh, credential-file rewrites — all red herrings relative to this specific 400. If `~/.claude/.credentials.json` ever does go stale, claude-cli returns 401/403 (auth error), not 400 `out-of-extra-usage`.

#### Fix

In `extensions/tinkerclaw-tinker-bridge/src/worker.ts`:

```ts
const OPENCLAW_SYSPROMPT_CUTOFF = "You are a personal assistant running inside OpenClaw";
const openClawCutoff = systemPromptBody.indexOf(OPENCLAW_SYSPROMPT_CUTOFF);
const personaOnly =
  openClawCutoff > 0 ? systemPromptBody.slice(0, openClawCutoff).trim() : systemPromptBody;
void rulesBody; // fork-internal reply-style scaffolding, dropped defensively
const combinedSystemPrompt = [personaOnly, subagentHelpBody, toolChoiceBody, narrationBody]
  .filter(Boolean)
  .join("");
```

Kept: the persona header (`# Persona: JarvisOne (v1)…`) + the three fork narration blocks.
Dropped: everything after the sentinel (OpenClaw tool catalog, CLI quick-reference, inbound metadata, heartbeat rules, runtime line) + `rulesBody`.

No functional loss: `claude-cli` maintains its own tool catalog via `--permission-mode` and the fork's OpenClaw tools are mediated by the bridge, not the subprocess. The persona block still carries Jarvis's identity.

> _Current block order (FORK 2026-05-21):_ `persona → ethical-rules → narration → subagent-helper → tool-choice → plan-tools`. The ethical-rules layer was added as a foundation between persona and the mechanics blocks. See `tool-loop.md` "combinedSystemPrompt block order" and `config-shape.md` "tinker-bridge ethical-rules prompt loader" for the loader path.

#### Diagnosis kit (use this when it comes back)

1. **Live probe:** `/tmp/catch-claude-pid.sh` polls `pgrep -x claude` and dumps the subprocess's cgroup + PPid + env. Copy from commit `a307dca393`'s context if missing.
2. **Bare-shell test:** `env -i HOME=… PATH=… DBUS_SESSION_BUS_ADDRESS=… XDG_RUNTIME_DIR=… TERM=xterm CLAUDECODE=1 claude --print --model claude-sonnet-4-6 'reply OK'`. If this bills the subscription, the credentials are fine and the problem is in the gateway's call shape (env, args, or prompt).
3. **Prompt dump:** add `fs.writeFileSync("/tmp/jarvis-sysprompt-dump.txt", systemPromptBody)` right before `--append-system-prompt` is pushed; grep the dump for `sessions_spawn`, `openclaw`, `repo=.*workspace`, `schema.*openclaw` — any hits are a candidate fingerprint.
4. **WS injector:** `node scripts/jarvis-inject.mjs --new --message "..." --gw ws://localhost:18789` (token from `~/.openclaw/openclaw.json`) produces a clean bisect probe with no UI noise.
5. **Git bisect anchors:** `4a6a289d5a` (pre-merge known-good), `3db21784ad` (raw-merge known-good), `378684e4f5` (fork-wiring known-bad).

#### What NOT to change next time

- Don't touch the `systemd-run --user --pipe` wrapper first. It's correct cgroup/PPid hygiene and costs nothing to keep.
- Don't strip more env vars on a hunch — the allowlist is already minimal. If stripping helped it would show up in the bare-shell probe.
- Don't blame budget-panel's `forceRefreshToken()` unless journalctl actually shows rotation events in the failure window.
- Don't assume `--resume <sessionId>` is tainting routing — wipe `~/.openclaw/tinker-bridge/session-map.json`, restart, and confirm a truly fresh spawn still fails before going down that path.

- **Files:** `extensions/tinkerclaw-tinker-bridge/src/worker.ts` (commit `a307dca393`).
- **Knowledge:** `~/.openclaw/workspace/memory/knowledge/tinkerclaw-tinker-bridge.md` (§ "2026-04-24: Subscription-billing regression — root cause").

#### 5.73a Stream parser: post-tool text recovery (2026-04-27)

- **Status:** `DEPLOYED`
- **Symptom:** every `/new` (and any tool-heavy turn) appeared to "die after N tool calls" — the UI showed user prompt + tool bubbles + the brief opener Jarvis writes before the first tool, then nothing. The Morning Briefing, the post-tool summary, the actual answer — all gone. Refreshing didn't help; the assistant message persisted in `agent:main:main`'s jsonl was only the 122-char preamble even though claude-cli had emitted ~5.5KB of output.
- **Root cause:** two related parser bugs in `extensions/tinkerclaw-tinker-bridge/src/stream.ts`.
  1. **Multi-block accumulation gap.** The parser tracked one `accumulatedText` for the whole turn and gated updates on `cumulative.startsWith(accumulatedText)`. claude-cli's stream-json emits SEPARATE text blocks before and after a tool_use chain (`message.content[0]` = preamble, `message.content[N]` = post-tool summary). Block N's cumulative didn't start with block 0's accumulated text, so the prefix check fell through and no delta was pushed — the post-tool block was silently dropped.
  2. **`result.result` ignored on success.** claude-cli's stream emits a `result` line at the end of each turn whose `result` field carries the FULL final assistant text. The error-path code at line 595 already used it (to build the error envelope), but the success-path at line 626 just called `buildContent()` over `accumulatedText` and trusted whatever streamed through. In dense tool chains where the post-tool summary never appears as a separate `assistant.content` text block, `result.result` was the only source of the answer — and the success path was throwing it away.
- **Fix:**
  1. **Per-block tracking**: `blockTextSeen: Map<number, string>` and `blockThinkingSeen: Map<number, string>` track each block's previous cumulative independently. The text-block branch compares `cumulative` against the SAME-block-index's `prev`, slices the delta, and appends to the global `accumulatedText` via `pushTextDelta`. When a fresh block emerges after a tool_use chain (`bi > 0 && prev === ""`), `pendingToolNarration` is cleared so the post-tool prose doesn't get attributed to a stale upcoming tool.
  2. **`result.result` reconciliation in the success path**: before composing the final assistant message, compare `result.result` against `accumulatedText`. If `result.result` extends `accumulatedText` (prefix match), push the tail as a delta. If they've diverged (result is more than 2× longer + 50 chars, classic preamble-only stream case), push `\n\n` + the full result_text so both the streamed preamble and the result-line answer survive in the final message.
- **Verification:** probe sends "Run echo PROBE-A then echo PROBE-B then summarize what they printed in two sentences after the calls." Before fix: streamed text 44B (preamble only), persisted message 122B in earlier prompts. After fix: streamed/persisted text 237B (preamble + `\n\n` + 191B post-tool summary). Log line `tail-recover: streamed 44B, result_text 191B, replacing (diverged)` confirms the success-path branch fired.
- **What this is NOT:**
  - Not a workaround for `/new`-specific behaviour. The bug applied to ANY turn where claude-cli ran tool calls; `/new`'s briefing just made it most visible because the prompt always produces a substantial post-tool summary.
  - Not the same as §5.74's tool-call replay. That fix landed tool_use/tool_result entries in the jsonl; this fix lands the assistant TEXT in the jsonl. They compose: `/new` history now shows user prompt → tool bubbles (from §5.74) → preamble + briefing (from §5.73a).
  - Not retroactive — turns persisted before this commit are stuck with whatever truncated text made it. Future turns are whole.
- **Files:** `extensions/tinkerclaw-tinker-bridge/src/stream.ts` (per-block maps, multi-block parser branches, `result.result` reconciliation in the success path).

**§5.66b tinker-bridge idle-watchdog timeout bumped to 600s (FORK 2026-05-05).**

- **Status:** `DEPLOYED`
- **Symptom:** A heavy WhatsApp ask ("Read outlook + list project state") surfaced as `🤖 ⚠️ Something went wrong while processing your request.` Both first AND retry attempts SIGTERMed at ~128s; journal showed `[llm-idle-timeout] claude-code/claude-opus-4-7 produced no reply before the idle watchdog`.
- **Root cause:** pi-agent-core's `streamWithIdleTimeout` (`src/agents/embedded-agent-runner/run/llm-idle-timeout.ts`) resets per pi-ai stream event. tinker-bridge intentionally does NOT push `stream` events during tool work — tool_use blocks would trigger re-execution via OpenClaw's exec tool (see FORK 2026-04-22 in stream.ts). On a long claude-cli tool chain (e.g. several outlook-mail-fetch + people.read calls in series), no pi-ai events flow → idle timer ticks past 120s default → subprocess SIGTERMed mid-work. Both retries hitting this surface as `surface_error/timeout`.
- **Fix:** provider-level `timeoutSeconds: 600` in `extensions/tinkerclaw-tinker-bridge/src/catalog.ts:buildClaudeCodeProviderConfig`. pi-agent-core's `resolveLlmIdleTimeoutMs` ONLY reads `providerConfig.timeoutSeconds` (via `applyConfiguredProviderOverrides → resolveProviderRequestTimeoutMs`); a `requestTimeoutMs` field on the catalog model object is silently ignored. The new constant `DEFAULT_REQUEST_TIMEOUT_MS = 600_000` lives in `defaults.ts`.
- **Don't regress:** if you ever switch to `requestTimeoutMs` on individual models (which feels more natural), pi-agent-core won't pick it up — the override path is the provider-level field. The model object's `requestTimeoutMs` IS read further down (provider-transport-fetch.ts) but only AFTER the provider config has populated it via `applyConfiguredProviderOverrides`.
- **Open follow-up (proper fix):** stream.ts should push a no-op stream event (or repurpose `start`) for every claude-cli line during tool work, so the idle watchdog resets the way pi-agent-core expects rather than relying on a wider absolute timeout. The current bump masks the symptom; a tool chain >10 min would still hit it.

**§5.73b tinker-bridge truncation — `text_end` fired before tail-recover (FORK 2026-05-04).**

- **Status:** `DEPLOYED`
- **Symptom:** Multi-step turns where the streamed scratch text diverged from `result.result` only delivered the streamed preamble (~100 B) to the user, even though the tinker-bridge logged `tail-recover: streamed 105B, result_text 2457B, replacing (diverged)` and `done.message.content` carried the full text.
- **Root cause:** `pushTextEnd()` was called immediately after `worker.send` resolved (old line 579), BEFORE the tail-recover reconciliation block (lines 626-665). The downstream `embedded-agent-subscribe.handleMessageEnd` (`src/agents/embedded-agent-subscribe.handlers.messages.ts:841`) drained its block-chunker on `text_end` and recorded `lastBlockReplyText`. The late `text_delta` from the tail-recover then arrived AFTER `text_end` (a protocol violation), and the message_end safety re-send was guarded by `lastBlockReplyText != null`, silently dropping the actual answer.
- **Fix:** removed the early `pushTextEnd()`; added it just before each `done` push (success path AFTER the tail-recover, error path AFTER the envelope reset; catch block already had it). Net: `text_end` always carries the FINAL accumulated text.
- **Don't regress:** `pushTextEnd` is guarded by `if (!textStarted || textEnded) return;`, so call sites are idempotent — if you ADD a new exit path that emits `done`, you also need a `pushTextEnd()` immediately before it.
- **Files:** `extensions/tinkerclaw-tinker-bridge/src/stream.ts`.

### 5.74 tinker-bridge Tool Call Replay in Session History (2026-04-25)

- **Status:** `DEPLOYED`
- **Why:** §5.66 explains that tinker-bridge cannot put `tool_use` blocks in the assistant message — pi-agent-core would re-execute them through OpenClaw's exec tool and trip the prefrontal "Exploration required" gate (red bubbles for every claude internal Bash call). That kept context clean but left the OpenClaw session transcript with **only** the user prompt and the final assistant text. Reloading `agent:main:main` after a 46-tool-call turn showed `[user prompt → 64-character opener]` and nothing else — every command Jarvis ran was invisible after refresh, which broke the "see Jarvis working" promise of the webchat.
- **Fix:** three-piece pipeline that lands tool events in the transcript without polluting the LLM context.
  1. **Buffer (tinker-bridge):** `extensions/tinkerclaw-tinker-bridge/src/tool-buffer.ts` keeps an in-process `Map<runId, ToolBufferedEvent[]>`. Both `emitToolStart` and `emitToolResult` in `stream.ts` push their events into the buffer alongside the existing live `emitAgentEvent` call. Buffer state is not persisted to disk — gateway crash loses it, but the user already lost the turn at that point.
  2. **Drain (fork hook):** `src/fork/attempt-hooks.ts:onTurnComplete` resolves the active `SessionManager` (the runner casts `activeSession` to `SessionManager`, but the real instance is on `activeSession.sessionManager`, which the hook discovers defensively) and writes each buffered event with `appendCustomEntry("tinker-bridge-tool", { runId, ...event })`. `appendCustomEntry` is the "Extension state — not in context" primitive (per `pi-coding-agent` `session.md`), so the entries persist on disk and ship to Tinker via `chat.history`, but pi-agent-core does NOT replay them into the message array on the next turn — no double-execution.
  3. **Surface (chat.history transform):** `src/gateway/session-utils.fs.ts:readSessionMessages` recognises `type:"custom"` + `customType:"tinker-bridge-tool"` entries and emits them as synthetic `tool_use` (assistant role) and `tool_result` (user role) messages with `__openclaw.kind:"tinker-bridge-tool"`. They reuse the exact block types Tinker already renders for live tool events at `tinker-ui/src/app.ts:1512`, so no client-side change is needed — the existing live-tool render path runs again on history load.
- **Reorder logic:** the drain runs in `onTurnComplete`, AFTER the assistant text was already persisted, so tinker-bridge-tool entries trail the assistant message in jsonl order. `reorderTinkerBridgeToolBlocks` walks the read messages and splices each tinker-bridge-tool message into the position immediately before the most-recent preceding assistant _text_ message, ignoring intervening `compaction` system entries. Final chat reading order: `[user → tool_use → tool_result → … → assistant text → compaction]`.
- **Verification:**
  - Live: jarvis-inject probe runs `pwd` + `whoami`, three blocks visible in real time (existing §5.6 path).
  - Persist: jsonl gains 4 `{"type":"custom","customType":"tinker-bridge-tool", "data":{ runId, phase, toolCallId, name, args, result, isError, ... }}` lines per turn.
  - Replay: `chat.history` returns those entries as `[assistant tool_use, user tool_result]` pairs spliced before the final assistant text. Tinker renders them as the same single-line/expandable bubbles it shows live.
- **What this is NOT:**
  - Not "in context" — pi-agent-core never re-feeds these entries to the LLM. tinker-bridge handles its own tool loop inside claude-cli (`~/.claude/projects/<sid>/*.jsonl`); the OpenClaw side just keeps a render-only mirror.
  - Not retroactive — turns that ran before this fix have no buffered events to drain. Their history still shows only the assistant opener + final text. Future turns are fully captured.
  - Not a replacement for `agent.stream:"tool"` events — the live WS path still drives Tinker's real-time tool bubbles. The persistence path is a parallel record for after-the-fact reload, not a substitute.
- **Files:** `extensions/tinkerclaw-tinker-bridge/src/tool-buffer.ts` (new), `extensions/tinkerclaw-tinker-bridge/src/tool-buffer.types.ts` (new), `extensions/tinkerclaw-tinker-bridge/src/stream.ts` (record at emit), `src/fork/attempt-hooks.ts` (drain on turn complete), `src/gateway/session-utils.fs.ts` (history transform + reorder), `scripts/check-history-probe.mjs` (verification harness).

### 5.75 `/clear` and `/new` — Symmetric Reset Cascade Through tinker-bridge (2026-04-27)

- **Status:** `DEPLOYED`
- **Why:** §5.5 says session deletes from Tinker are soft (transcript archived, never wiped). §5.66 explains tinker-bridge's worker pool is keyed by a hash of the system prompt, which has the side effect of pinning Jarvis to the same `claude --resume <sessionId>` across every "session reset" — `/new` rotated the OpenClaw sessionId but tinker-bridge kept the old conversation alive. `/clear` was even worse: it never reached the gateway's reset path at all (it called `sessions.delete` instead of `sessions.reset`), so the `command:reset` plugin lifecycle, transcript archival, and `session-memory` save never fired. The two commands looked similar in the UI but did very different things server-side, and neither actually reset Jarvis.
- **Fix (three pieces, must move together):**
  1. **Smuggle the OpenClaw sessionId** to tinker-bridge: `src/agents/embedded-agent-runner/run/attempt.ts` adds `__openclawSessionId: params.sessionId` next to the existing `__openclawRunId` / `__openclawSessionKey` fields piped through `agent.streamFn`. The sessionId is the per-reset UUID minted by `performGatewaySessionReset`, not the stable `sessionKey` label.
  2. **Hash sessionId into the tinker-bridge worker key**: `extensions/tinkerclaw-tinker-bridge/src/stream.ts:deriveSessionKey` now takes `(explicit, systemPrompt, openclawSessionId)` and djb2-hashes `${systemPrompt}\u0001${sessionId}`. A reset that mints a new sessionId yields a new `tinker-sp-<hash>`; the worker pool treats it as a brand-new session, spawns a fresh `claude` subprocess with no `--resume` flag, and `~/.openclaw/tinker-bridge/session-map.json` accumulates a fresh entry instead of looking up the old one. The previous entry stays in the file as orphaned state — never queried again, cheap to leave; a TTL prune is future work.
  3. **`/clear` calls `sessions.reset`**: `tinker-ui/src/app.ts` replaces the old `sessions.delete({deleteTranscript:false})` fire-and-forget with `sessions.reset({key, reason:"reset"})`. The local-state wipe + tab key rotation still happen first (so a stale `chat.history` reload mid-flight can't surface the abandoned transcript), then the server-side cascade handles the real work: archives the old transcript to `sessions-archive/`, mints a new sessionId on the same sessionKey, fires `command:reset` → `before_reset` → `session_end` → `session_start` plugin hooks. Zero LLM calls; same zero-token guarantee as before. Symmetric `sessions.reset({key, reason:"new"})` is also fired from the topbar `/new` button when the active tab is a `tinker:*` non-main tab — previously its old session was orphaned on disk because the tab simply rotated to a fresh key without telling the gateway anything.
- **Verification (commit `<this>`):**
  - `scripts/check-reset-cascade.mjs` opens a fresh `cli:reset-<ts>` sessionKey, sends `echo TURN-A`, calls `sessions.reset`, sends `echo TURN-B`. Both turns succeed; `session-map.json` gains TWO new `tinker-sp-` entries (one per turn) with different sessionIds; the gateway log shows both `spawning claude` lines ending at `--model claude-opus-4-7` (no `--resume` argument on either) — claude-cli started fresh both times. Before the fix the second turn would have reused the first turn's `tinker-sp-` key and `--resume`-d into the same conversation.
- **What this is NOT:**
  - Not a guarantee about `/new` on the main tab — `/new` still fires `chat.send "/new\n…"` to deliver the BRIEFING.md prelude through the model. The cascade still runs (the auto-reply session.ts trigger detects `/new` and calls `performGatewaySessionReset` server-side), but the LLM call is intentional and counts toward usage.
  - Not retroactive — entries already in `session-map.json` from before this commit (hashed by systemPrompt only) stay readable but won't be matched by future requests, which now hash with sessionId. They become inert dead weight.
  - Not a substitute for `/clear`'s tab-key rotation. The local rotation is still important: `chat.history` with the old key would still return the just-archived transcript in flight, and the tab-key swap prevents that race.
- **Files:** `src/agents/embedded-agent-runner/run/attempt.ts` (smuggle `__openclawSessionId`), `extensions/tinkerclaw-tinker-bridge/src/stream.ts` (`deriveSessionKey` hashes sessionId + reorders pipedOptions extraction so sessionId is available before key derivation), `tinker-ui/src/app.ts` (`/clear` calls `sessions.reset` instead of `sessions.delete`; topbar `/new` resets the abandoned `tinker:*` key before rotating), `scripts/check-reset-cascade.mjs` (new verification harness).

### 5.76 Public/Private Boundary & The Git-Pull Contract (2026-04-28)

This section defines the rules that let `tinkerclaw` ship as a public GitHub repo someone can clone-and-run while keeping personal data out of the public surface AND letting an existing user `git pull` for upstream improvements without losing any personalisation.

#### 5.76a The product story

`tinkerclaw` is shipped as **"Jarvis, ready to play, with hooks to make him yours."** Day-0 cloners get a working assistant — JARVIS persona, working briefing on `/new`, JARVIS voice, all cognitive plugins composed — without any setup beyond `pnpm install && pnpm build && openclaw start`. They override anything they want, in increasing precedence:

1. Explicit config (`~/.openclaw/openclaw.json` — outside repo)
2. Workspace file (`~/.openclaw/workspace/<file>` — outside repo)
3. Bundled default (`extensions/tinkerclaw-tinker-bridge/{personas,prompts}/<file>` — in repo)

The bundled default is always present; first-boot never hits a missing-file path. Override layers are opt-in and live outside the repo so `git pull` cannot touch them.

#### 5.76b The hard contract: program in repo, data outside

The single rule that makes the whole system safe under `git pull`:

| Lives in `~/src/tinkerclaw/` (repo)                                                  | Lives in `~/.openclaw/workspace/` (outside repo)                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Code (worker.ts, stream.ts, gateway patches, extensions)                             | User persona override (`SOUL.md`)                                  |
| Bundled defaults (`personas/jarvis-default.md`, `prompts/briefing-default.md`, etc.) | User briefing override (`BRIEFING.md`)                             |
| Contract documents (READMEs, PATCHES, CHANGELOG, this bible)                         | User recipes / cron / memory / heartbeat                           |
| Config schema and shipped sample                                                     | Trained Personality NN (`models/amygdala/onnx/personality_*.onnx`) |
|                                                                                      | Live runtime state (sessions, anatomy timeline, OAuth credentials) |

`git pull` rewrites the left column freely. It cannot reach the right column because git operates on the working tree at `~/src/tinkerclaw/` and stops there. No exceptions — anything user-editable that's allowed inside the repo is the trap that breaks the whole contract on the next pull.

The `.gitignore` already enforces the asymmetric half (private files in the repo are excluded — `SOUL.md`, `morning-briefings/`, `models/amygdala/{checkpoints,onnx}/personality_*`, `data/amygdala/personality-nudge.json`). The new rule the boundary adds: **users do not personalize bundled defaults in-place; they place overrides in the workspace.**

#### 5.76c File categories — what `git pull` does to each

Every public-repo file falls in exactly one of three buckets:

| Category                               | What it is                                                                                                                                                                                                              | Override path                               | What `git pull` does                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Bundled default with override hook** | `personas/jarvis-default.md`, `prompts/briefing-default.md`, `prompts/narration-contract.md`, `prompts/subagent-helper.md`, `prompts/tool-choice.md`                                                                    | Workspace file resolved before the bundle   | Refreshes the bundle. Workspace override (if present) is untouched and continues to win.                |
| **Library code**                       | `extensions/**/src/*.ts`, `src/fork/**`, `src/gateway/**`, `tinker-ui/src/**`                                                                                                                                           | None — fork the repo if you want to diverge | Refreshes. Users with workspace overrides see no change in behaviour; users who forked merge as normal. |
| **Read-only contract**                 | `FORK.md`, `FORK_SETUP.md`, `FORK_PATCHES.md`, `CHANGELOG-FORK.md`, `COGNITIVE_PLUGINS_GUIDE.md`, `TINKER_UI_DESIGN_BIBLE.md`, every extension `README.md` and recipe under `extensions/tinkerclaw-prefrontal/recipes/` | None — read, don't edit                     | Refreshes. Users read changes via the changelog.                                                        |

There is no fourth category called "ship a default but expect users to edit it in place." Eliminating that category is what makes the contract robust.

#### 5.76d Resolution order in code

For each bundled-default-with-override-hook file, the loader applies the same three-step resolution. Implemented as a shared helper in `extensions/tinkerclaw-tinker-bridge/src/prompt-loader.ts`:

```
resolvePromptPath(name) →
  1. cfg.prompts?.[name]Path ?? cfg.cognitive?.[name]Path  (config — outside repo)
  2. path.join(workspaceDir, <name>.md)                    (workspace — outside repo)
  3. path.join(__dirname, "../{personas,prompts}", <name>) (bundled default — in repo)
```

The first existing path wins. The bundled default at step 3 is guaranteed to exist (shipped in the repo). Steps 1 and 2 are opt-in. No file-not-found errors at boot under any combination of presence/absence.

For the persona, the resolution lives in `src/fork/attempt-hooks.ts:getPersonaBlock` which reads `<workspaceDir>/SOUL.md` first and falls back to the bundled `jarvis-default.md`. For the briefing, the resolution lives in `tinker-ui/src/app.ts:buildInjectedPrompt` which reads `briefingPath` from tinker-bridge config (resolved by the gateway). For the tinker-bridge prompt blocks (narration / subagent-helper / tool-choice), the resolution lives in `tinker-bridge/src/worker.ts:buildAppendedPromptRules`.

#### 5.76e Day-0 defaults — what ships in the repo

- **`extensions/tinkerclaw-tinker-bridge/personas/jarvis-default.md`** — JARVIS persona, day-0 default. Sardonic, capable, formal-British voice; based on the canonical Iron Man character (widely known, not personal). Cloners override by creating `~/.openclaw/workspace/SOUL.md`.
- **`extensions/tinkerclaw-tinker-bridge/prompts/briefing-default.md`** — generic morning-briefing template. Pattern + voice rules + category-based source discovery (HEARTBEAT, daily memory, recent commits — skip silently if missing). Cloners override by creating `~/.openclaw/workspace/BRIEFING.md`.
- **`extensions/tinkerclaw-tinker-bridge/prompts/narration-contract.md`** — the grandma-proof bar: per-tool narration rule + banned phrasings + bad/good examples. Extracted from `worker.ts:buildChatNarrationBlock`.
- **`extensions/tinkerclaw-tinker-bridge/prompts/subagent-helper.md`** — how to spawn OpenClaw subagents from inside tinker-bridge. Extracted from `worker.ts:buildSubagentHelperBlock`.
- **`extensions/tinkerclaw-tinker-bridge/prompts/tool-choice.md`** — tool-routing decision tree (WebSearch vs WebFetch, etc.). Extracted from `worker.ts:buildToolChoiceBlock`.
- **JARVIS voice (`skills/jarvis-voice/SKILL.md`)** — default-on TTS skill. Cloners disable via the skills panel or replace with another voice skill.

Day-0 user experience: clone, install, build, start. Get JARVIS speaking sardonically through tinker-bridge with full grandma-proof tool narration, full briefing on `/new`, and JARVIS voice (assuming `ffmpeg` + `aplay` are present from the skill manifest).

#### 5.76f Drift detection on startup

Each bundled default ships with a frontmatter `default-version: <semver>` line. When a workspace override exists, the loader compares the workspace file's stamped `default-version` (written by `openclaw <name> init`) to the current bundled `default-version`. If they differ:

```
[tinker-bridge] persona override at default-version 1.0; bundled default is at 1.2.
            run 'openclaw persona diff' to see changes; 'openclaw persona reset' to reseed.
            (your override always wins; this is informational.)
```

INFO level log line. No automatic action. The user's override always wins; the message just notifies that improvements are available upstream.

#### 5.76g The seed-edit-revert lifecycle

The `openclaw` CLI exposes one verb per overridable file with three subcommands:

```
openclaw persona init              # copies personas/jarvis-default.md → ~/.openclaw/workspace/SOUL.md, opens $EDITOR
openclaw persona diff              # diffs workspace SOUL.md against current bundled jarvis-default.md
openclaw persona migrate           # if user accidentally edited the in-repo default, copies their diff to workspace + git-checkouts the repo file
openclaw persona reset [--force]   # backs up workspace SOUL.md, copies fresh bundled default
openclaw briefing {init,diff,migrate,reset}    # same shape for briefing-default.md
openclaw narration {init,diff,migrate,reset}   # same shape for narration-contract.md (power-user override)
openclaw recipes new <name>                    # creates ~/.openclaw/workspace/recipes/<name>.md from a template
```

Each `init` refuses to overwrite an existing workspace file (asks `--force`), copies the bundled default verbatim, stamps `default-version` in frontmatter, and opens `$EDITOR`. The verbs are documented in `FORK_SETUP.md`.

The CLI scaffolding is filed as a follow-up — bible §5.76g documents the shape; first cut of the resolution order ships without the CLI commands. The boot-time drift log line ships with the loader.

#### 5.76h Scenario-B trap: in-repo edits

Some users will ignore the documented path and edit `extensions/tinkerclaw-tinker-bridge/personas/jarvis-default.md` in place. `git pull` will conflict the next time upstream touches that file. The repo defends with two redundant signals:

1. **`pnpm doctor`** (or first-run check on gateway boot) scans `extensions/tinkerclaw-tinker-bridge/{personas,prompts}/` for local modifications via `git diff --quiet` and prints:
   > Your repo has edits to bundled `jarvis-default.md`. These belong in `~/.openclaw/workspace/SOUL.md`, not in the repo. Run `openclaw persona migrate` to copy your edits to the workspace and revert the repo file. Until then, `git pull` will conflict on this file.
2. **`git-hooks/pre-merge`** (opt-in via `core.hooksPath`) prints the same warning before letting a `git pull` proceed.

`openclaw persona migrate` copies the user's diff vs. the upstream-tracked version into `~/.openclaw/workspace/SOUL.md`, then `git checkout` the repo file. After that, normal resolution order kicks in and `git pull` is safe.

#### 5.76i The two tests

Two tests every change to the public-repo surface must pass:

- **The "Sam test"** (fresh clone): a stranger named Sam clones the repo, runs `pnpm install && pnpm build && openclaw start`, says hello in Tinker. Jarvis replies through tinker-bridge with the bundled persona, the bundled briefing on `/new`, the bundled voice, full grandma-proof tool narration. No setup, no errors, no missing-file references in the assistant's mouth. Sam has done nothing personal yet — everything works from the bundle.
- **The "Day-90 test"** (existing user `git pull`): a cloner who has been using the repo for 90 days has a personalized `~/.openclaw/workspace/SOUL.md`, a custom `BRIEFING.md`, a trained `personality_*.onnx`, custom recipes under `~/.openclaw/workspace/recipes/`. They run `git pull`. The pull updates the bundled defaults, the library code, the contracts. **Their workspace is untouched.** Boot logs flag the drift between their SOUL.md (default-version 1.0) and the new bundled default (1.2); they read `openclaw persona diff` if interested; they keep their override otherwise. Total disruption: zero.

Both tests must pass by design (resolution order + filesystem separation), not by user discipline.

#### 5.76j What stays gitignored

The `.gitignore` continues to exclude personal files that would otherwise leak through the public-repo surface if they ended up in the repo working tree:

```
# Personal — these belong in ~/.openclaw/workspace/, never in the repo
SOUL.md                                          # personal persona override
morning-briefings/                               # rendered briefing outputs

# Trained personality NN — public Prudence ensemble ships, Personality is per-deployment
models/amygdala/checkpoints/personality_*.pt
models/amygdala/checkpoints/personality_*.json
models/amygdala/onnx/personality_*.onnx
models/amygdala/onnx/personality_*.onnx.data
models/amygdala/personality-*.onnx
models/amygdala/personality-*.onnx.data
data/amygdala/personality-nudge.json             # nightly training output
```

That's the entire list — narrow because most personalization paths route to `~/.openclaw/workspace/` which is outside the repo and therefore doesn't need a `.gitignore` entry.

#### 5.76k Files (this contract)

- `extensions/tinkerclaw-tinker-bridge/personas/jarvis-default.md` _(NEW — day-0 persona default)_
- `extensions/tinkerclaw-tinker-bridge/prompts/briefing-default.md` _(NEW — day-0 briefing default)_
- `extensions/tinkerclaw-tinker-bridge/prompts/narration-contract.md` _(NEW — extracted from worker.ts)_
- `extensions/tinkerclaw-tinker-bridge/prompts/subagent-helper.md` _(NEW — extracted from worker.ts)_
- `extensions/tinkerclaw-tinker-bridge/prompts/tool-choice.md` _(NEW — extracted from worker.ts)_
- `extensions/tinkerclaw-tinker-bridge/src/prompt-loader.ts` _(NEW — three-step resolution helper)_
- `extensions/tinkerclaw-tinker-bridge/src/worker.ts` (use loader; remove the five hardcoded `/home/<user>/...` paths)
- `extensions/tinkerclaw-tinker-bridge/README.md` _(NEW — anatomy + override conventions)_
- `extensions/tinkerclaw-browser-relay/chrome-extension/options.html` (replace literal gateway-token placeholder)
- `scripts/db-probe.mjs` (replace `/home/<user>/.openclaw/...` with `os.homedir()`-resolved path)
- `src/fork/attempt-hooks.ts` (`getPersonaBlock` falls back to bundled `jarvis-default.md`)
- `tinker-ui/src/app.ts:buildInjectedPrompt` (briefing path resolved from tinker-bridge config, falls back to bundled `briefing-default.md`)
- `FORK_SETUP.md` (new "Personalize in the workspace, never in the repo" paragraph at the top)

---

### 5.77 Anthropic Opus 4.7 Prompting Standards (2026-04-28)

**Why this section exists.** Opus 4.7 follows literal instructions more strictly than 4.6 and is less aggressive about its own embellishments. Prompts that worked fine on 4.6 ("HARD RULE: never do X", "MUST do Y", all-caps emphasis, vague exhortations) under-perform on 4.7 — the model now does exactly what you ask, no more, no less. Every prompt the fork ships needs to be written for that contract.

This section is the standard. Every `.md` file under `~/src/tinkerclaw/extensions/*/prompts/`, `~/src/tinkerclaw/extensions/*/personas/`, `~/.openclaw/workspace/*.md` (workspace overrides), and every skill `SKILL.md` in `~/.openclaw/workspace/skills/` follows it.

#### 5.77a The eight rules

1. **Wrap blocks in named XML tags.** Use semantic names that describe the block's purpose: `<role>`, `<task>`, `<voice>`, `<examples>`, `<rules>`, `<override_priority>`, `<verbosity>`, `<output_format>`, `<why_this_matters>`, `<scope>`. Avoid generic names like `<section1>`. The tags let the model reference structure when reasoning about which rule applies; without them it has to infer boundaries from headings.

2. **Examples go in `<example>` blocks with sub-tags.**

   ```xml
   <example>
   <scenario>What's happening</scenario>
   <bad>What not to do, and a brief reason it fails</bad>
   <good>The right move</good>
   <why>One sentence on what makes the good version right</why>
   </example>
   ```

   The sub-tags let the model parse the example without conflating "bad" and "good" prose.

3. **Motivation-first framing.** Lead with WHY a rule exists before WHAT to do. 4.7 follows literal instructions; without motivation it can't extrapolate to edge cases the rule didn't anticipate.

4. **Reframe negatives as positives where possible.**
   - "Don't fabricate" → "Honest 'no signal' reports are valuable because false positives waste downstream attention"
   - "Never do Y" → "Do Z instead because Y leads to W"
     Keep strict negation only where there is a genuine safety boundary the model must not cross.

5. **Dial back CAPS / MUST / NEVER / HARD RULE.** 4.7 is more responsive to calm specific phrasing than to shouted imperatives. Replace ALL-CAPS words with normal case unless the emphasis is genuinely load-bearing. Replace "MUST"/"NEVER" with concrete description of the desired behaviour. The 4.6-era pattern of stacking imperatives ("CRITICAL", "ABSOLUTELY", "BLOCKING REQUIREMENT") makes 4.7 freeze rather than act.

6. **Add an explicit `<override_priority>` block** when a prompt could be overridden by user instructions. State the priority order plainly: user explicit instructions > this prompt > system defaults. Without it, 4.7 may treat the prompt as the highest authority and ignore conflicting user input.

7. **Concrete over abstract.** Replace vague nouns ("the code", "the user", "things") with specific anchors: "the `tinker-bridge` worker.ts", "the user's `~/.openclaw/workspace/`". Vague nouns let the model wander; concrete anchors keep it on the artifact you actually mean.

8. **Length: keep or shorten.** Don't pad. If a section can lose 30% of its words without losing meaning, do it. 4.7 reads everything literally — every word competes for attention.

#### 5.77b Two modes — pick per file

A file is **HEAVY** (full Opus 4.7 treatment) if it tells a future LLM how to behave: voice, tools, output format, decision rules.

- Examples: `BRIEFING.md`, `SOUL.md`, `IDENTITY.md`, `VOICE.md`, `USER.md`, `VISION.md`, `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`, `SESSION.md`, `MOLTBOOK.md`, `COGNITIVE_PLUGINS_GUIDE.md`, `CLAUDE.md`, every `skills/*/SKILL.md`, every `.agent/workflows/*.md`, every `extensions/*/prompts/*.md` and `extensions/*/personas/*.md`.

A file is **LIGHT** (typo + structure pass only, NEVER rewrite) if it records what happened, what someone thinks, or factual data.

- Examples: anything in `memory/` (daily journals, archives, ai-research, ChatGPT imports), `bank/contacts*.md`, `bank/opinions.md`, `bank/experience.md`, `CHANGELOG-FORK.md`, `index_costos.md`, `moltbook_findings.md`, anything in `bank/reference/` that reads as notes (not instructions).

When ambiguous: read the first 30 lines. If it addresses a future LLM ("you are…", "your task is…", instructions in second person), it's HEAVY. Otherwise LIGHT.

#### 5.77c LIGHT mode — what is allowed

NEVER rewrite content. NEVER add XML tags. NEVER restructure prose.

Allowed:

- Fix obvious typos (your/you're, definately → definitely)
- Fix broken markdown (unclosed code fences, malformed lists, broken links)
- Normalise heading levels if a file mixes `#` and `##` for same-level items
- Trim trailing whitespace; collapse runs of 3+ blank lines to 2

When in doubt on a memory file: leave it alone. We are not rewriting history.

#### 5.77d Where the standard is canonical

The full revision guide lives at `/tmp/opus47-revision-guide.md` during a sweep, but the canonical reference is **this section**. New prompts go through this rubric at write-time, not as an afterthought. New skill `SKILL.md` files start in HEAVY format. New workspace overrides start in HEAVY format.

For non-text-prompt files (configs, schemas, code), 5.77 does not apply — the rules here are about LLM-facing prose.

#### 5.77e Commits that established the baseline

- `b2ab809651` — first sweep: 4 standalone bundled prompts revised (jarvis-default, briefing-default, amygdala-prompt, fractal-prompt).
- `dfceb60241` — second sweep: 3 prompt fragments extracted from `worker.ts` into `prompts/` (narration-contract, tool-choice, subagent-helper) under the same standard.
- `2026-04-28 sweep` — full workspace pass (~125 HEAVY prompts, ~470 LIGHT-touched memories) to bring every existing `.md` under §5.77.

#### 5.77f When the standard changes

If Anthropic publishes new guidance for Opus 4.8 or later, append §5.78 rather than rewriting §5.77. Old prompts revised under §5.77 are still valid; new prompts pick up the latest. Roll a `default-version: 1.x → 2.0` bump on bundled prompt frontmatter when the rules change in a way that would alter the rendered prompt.

---

### 5.78 Branch Policy: `main` is shippable, `develop` is for tinkering

→ moved 2026-05-11 to `./branch-policy.md` (full content preserved verbatim including the §1 / §2 / §3 evolution).

### 5.79 Heartbeat Architecture: Computational Cron, Conditional LLM (2026-04-29)

**Rule.** The heartbeat is a **computational gate**, not an AI loop. TypeScript (not an LLM) decides every fire whether anything actually needs Jarvis's attention. The LLM is invoked only when the gate confirms there is work to do.

The model summoned by the gate is **`claude-code/claude-opus-4-7`** — full reasoning, our flat-rate via tinker-bridge.

#### 5.79a How the gate decides

Every interval (`agents.defaults.heartbeat.every`, default `1h`), the gateway runs the heartbeat tick. Inside `src/infra/heartbeat-runner.ts:resolveHeartbeatRunPrompt`, pure TypeScript checks four signals:

1. **Pending cron events** — outputs from scheduled crons (daily-fork-sync, life-butler, security-updates, etc.) that emitted a system event but haven't been read by the agent.
2. **Pending exec completions** — background bash commands that finished while no agent turn was active.
3. **Fractal reflection hooks** — post-turn reflection events queued from a previous run.
4. **Scheduled tasks in `~/.openclaw/workspace/HEARTBEAT.md`** — YAML `tasks:` block with `name`, `interval`, `prompt` per task. The gate runs `isTaskDue(task)` for each — only tasks past their interval since their last run.

If all four are empty, the gate returns `prompt === null` and the heartbeat short-circuits at line 888: `return { status: "skipped", reason: "no-tasks-due" }`. **No LLM call. No subprocess. No cost.**

If any signal has content, the gate builds a prompt (`buildCronEventPrompt` for cron events, `buildExecEventPrompt` for completions, raw fractal text for reflection, or HEARTBEAT.md task prompts) and dispatches a single agent turn with the configured model.

#### 5.79b Why this shape

Two failure modes the design forecloses:

- **AI deciding when to be invoked.** A model that fires every interval and asks itself "is there anything to do?" burns 1-2 cents per fire whether the answer is yes or no. At 1h cadence that's $4-8/day; at 5min cadence (the merge regression) it's $50-100/day on a flat-rate account, plus the surface_error noise when the account is out of usage.
- **AI deciding what counts as "due".** The model would re-derive task schedules from text every fire. The gate uses real intervals stored in state and compares to clock time — deterministic.

The LLM's job is downstream of the gate: read the events the gate flagged, decide what to do about them, optionally relay to user. That's the work that actually benefits from reasoning.

#### 5.79c Configuration touchpoints

In `~/.openclaw/openclaw.json`:

```json
"agents": {
  "defaults": {
    "heartbeat": {
      "every": "1h",
      "model": "claude-code/claude-opus-4-7",
      "session": "heartbeat",
      "target": "none"
    }
  }
}
```

- `every`: interval between gate ticks. Lower = the gate notices new events faster but adds tick overhead. `1h` is the empirical sweet spot for the user's workload.
- `model`: opus-4-7 by design. The work the LLM ends up doing (reading 2026-04-25-fork-sync.md and deciding if a follow-up cron edit is needed) is reasoning-heavy; haiku is too thin.
- `session: "heartbeat"`: heartbeat runs in its own session, never main. Prevents 2026-02-21 webchat-disruption regression where heartbeat content leaked to user-facing sessions.
- `target: "none"`: no delivery channel. Heartbeat never relays to WhatsApp/Discord/etc. unless explicitly told to in a task prompt.

In `~/.openclaw/workspace/HEARTBEAT.md`: by default, just `# Heartbeat Tasks`. Stays empty most of the time. Add tasks as YAML `tasks:` block when needed:

```yaml
tasks:
  - name: check-urgent-emails
    interval: 4h
    prompt: "Check inbox for unread emails marked urgent. Surface anything from family or healthcare."
```

The parser at `src/auto-reply/heartbeat.ts:parseHeartbeatTasks` reads this format. Free-form prose outside a `tasks:` block is ignored — including any XML scaffolding accidentally added by the prompt-revision sweep (the 2026-04-28 audit flagged exactly this case).

#### 5.79d Common regressions and how to spot them

- **`heartbeat.model` set to a dead/metered account** → every gate-positive fire surfaces `LLM request rejected: out of extra usage` in the gateway log. Fix: switch to a flat-rate model (tinker-bridge claude-code/\* or local ollama).
- **`heartbeat.every` shrunk to `5m` or smaller** → more gate ticks, faster reaction to events but linear cost increase if the gate's ever wrong. Default back to `1h` unless there's a real reason.
- **HEARTBEAT.md filled with prose** that looks like tasks but isn't in the `tasks:` YAML block → parser ignores it, no gate trigger from there. Visible only in journalctl as gate-positive fires that come from cron events, not HEARTBEAT.md.
- **`session: "main"`** (the original bug) → heartbeat content contaminates main session, leaks to webchat as a red box. Always `"heartbeat"`.

#### 5.79e Verification

After any change to heartbeat config, watch one cycle:

```bash
journalctl --user -u openclaw-gateway.service -f --no-pager | grep -E "heartbeat|trigger=heartbeat"
```

Expected: `status=skipped reason=no-tasks-due` on most ticks; gate-positive fires only when there are real pending events. If you see LLM calls every interval regardless of pending events, the gate broke — check `resolveHeartbeatRunPrompt` for an upstream-merge regression.

---

### 5.80 Context Window, Compaction, and the Visibility Contract (2026-04-29)

**Rule.** A user's interaction history with Jarvis is **never silently truncated, hidden, or rolled out of view**. Compaction is allowed, but it must (a) be a visible event in the Tinker UI, and (b) leave the conversation continuous from the user's perspective — the summary stays in the active transcript, not in a stranded jsonl file.

This section codifies four issues diagnosed on 2026-04-29 after a session compaction lost visibility of the publish-prompt dispatch.

#### 5.80a The four issues, in order of severity

1. **Live `~/.openclaw/openclaw.json` did not declare `contextWindow` for the `claude-code` provider models.** Resolution chain in `src/agents/context-window-guard.ts:resolveContextWindowInfo` falls through `cfg.models.providers.X.models[i].contextWindow` → runtime model → `DEFAULT_CONTEXT_TOKENS = 200_000`. Result: every persisted run for `claude-code/claude-opus-4-7` recorded `contextTokens: 200000` in `sessions.json`, triggering compaction at ~150k instead of ~750k.

2. **`tinkerclaw-memory-enhancements` v0.1 is observation-only.** `extensions/tinkerclaw-memory-enhancements/index.ts:144-160` registers a `before_compaction` hook whose body says `v0.1 logs only; v0.2 will persist via memory-core public artifacts`. It does not delay compaction (the hook fires after compaction is decided), and it does not persist anything. The plugin-config flag `compactionCapture.enabled: true` is misleading — there is nothing to enable yet.

3. **Compaction does generate a summary, but the UI hides it.** `src/agents/embedded-agent-runner/compact.ts` invokes `piGenerateSummary` (engram + pointerMode is the active mode in this fork) and writes the result into a _new_ `sessionId.jsonl`. The pre-compaction transcript stays on disk at the old `sessionId.jsonl` but the Tinker UI loads only the current `sessionId`, so the user's old context appears erased.

4. **No compaction-event surfacing in Tinker UI.** Today the only signal is `compactionCount` increasing in `sessions.json`. The user's first hint is "where did my conversation go" rather than "[compacted N messages → summary, prior transcript at … ]".

#### 5.80b Standing rules

- **Per-model `contextWindow` is mandatory** in `~/.openclaw/openclaw.json` under `models.providers.<id>.models[i]`. Do not rely on tinker-bridge's `defaults.ts` fallback; runtime reads the live config first. Current values: `claude-opus-4-7: 1_000_000`, `claude-sonnet-4-6: 1_000_000`, `claude-haiku-4-5: 200_000`. After any merge that rewrites the models block, restore these values.
- **A "compacted" session is the same conversation as before.** The Tinker UI must show the user a banner at the boundary (`▼ N messages compacted into a summary above`), and clicking it expands the pre-compaction transcript inline. The user must never have to ask "where did my history go".
- **Architect-level prompts to Jarvis stay in `agent:main:main`.** Do not spawn subagent sessionKeys to dodge compaction; that hides the work from the user, which is exactly what 5.80 forbids. If the main session is approaching budget, show the warning, summarize on demand, but do not silently relocate the conversation.
- **Memory eviction is upstream of compaction, not in the `before_compaction` hook.** A real `tinkerclaw-memory-enhancements` v0.2 must persist evictable messages (or chunks of them) to memory-core _while there is still budget headroom_, not when compaction has already been triggered. Until v0.2 lands, do not market the plugin as a compaction-delayer.

#### 5.80c Diagnostic checks

```bash
# Live contextWindow per provider as the gateway sees it (post-restart)
openclaw gateway call models.list --params '{}' --json \
  | jq '.models[] | select(.provider == "claude-code") | {id, contextWindow}'
# Expected: claude-opus-4-7 → 1000000, claude-sonnet-4-6 → 1000000, claude-haiku-4-5 → 200000
```

```bash
# Persisted contextTokens for the live main session
jq '."agent:main:main".compactionCount' ~/.openclaw/agents/main/sessions/sessions.json
# Then grep recent runs for contextTokens — every claude-opus-4-7 run should now show 1000000
```

#### 5.80d Status of the four issues (live state, 2026-04-29)

| #   | Issue                                                                 | Status                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 200k context window for `claude-code/claude-opus-4-7` & `sonnet-4-6`  | **Fixed.** `~/.openclaw/openclaw.json` now declares per-model `contextWindow` (1M / 1M / 200k). Verify with `openclaw gateway call models.list`.                                                                                                                                                    |
| 2   | `tinkerclaw-memory-enhancements` masquerading as a compaction-delayer | **Honesty fix shipped.** Plugin description, config-schema (`compactionCapture.enabled` defaults to `false`), and runtime log now say "v0.1 observer-only; real eviction lands in v0.2". Live config flipped `compactionCapture.enabled: false`.                                                    |
| 3   | Compaction summary not visible in UI                                  | **Server-side enrichment shipped.** `src/gateway/session-utils.fs.ts` now propagates `summary`, `tokensBefore`, `tokensAfter` from the JSONL `type:"compaction"` entry into the synthetic `__openclaw.kind === "compaction"` system message returned by `chat.history`.                             |
| 4   | Tinker UI doesn't render the summary                                  | **Banner shipped.** `tinker-ui/src/app.ts` (renderMsg, line ~3310) renders an expandable `<div class="msg-compaction-banner">` showing the summary text + `before → after tok` token diff. CSS at `base.css:.msg-compaction-banner`. Falls back to the minimal divider when no summary is captured. |

#### 5.80e Known follow-ups

- **`compactionCheckpoints` not populating** for the live `agent:main:main` entry in `sessions.json`. The wiring in `compact.ts:1150` calls `persistSessionCompactionCheckpoint`, but historic entries were never written. The first new compaction post-2026-04-29 should populate the array; if it doesn't, instrument the catch block on line 1170 with a louder warning.
- **`[No messages to compact]` summaries.** Most compaction entries in the existing transcripts have `summary: "[No messages to compact]"` and `tokensAfter: null`, suggesting compaction triggered against the wrong message-set or against a fork-rotated transcript. Track separately under §5.80e — the visibility plumbing is correct, the summarizer's data is the gap.
- **`tinkerclaw-memory-enhancements` v0.2:** real eviction-to-memory-core _before_ the compaction threshold. Spec the hook contract upstream first (memory-core's public artifact API), then implement.
- **Click-to-expand prior transcript:** today the banner expands the _summary_. A v2 of this UI could also load the pre-compaction `sessionId.jsonl` (path is in `compactionCheckpoints[].preCompaction.sessionFile`) and inline its messages between the click target and the next message.

---

### 5.81 Browser Policy: relay-extension only, per-tab consent (2026-04-29)

**Rule.** Tinkerclaw agents see browser tabs **only via the in-page relay extension**, and only the specific tabs the user has explicitly clicked "share" on. Three access paths are blocked by code:

1. **Spawning a new browser** — refused by `launchOpenClawChrome` guard.
2. **Direct CDP-port attach** (e.g. `cdpPort: 9222` to the user's regular Chrome) — refused by `resolveProfile` guard. Would expose _every_ tab.
3. **Remote CDP attach** — refused by `cdpIsLoopback` checks elsewhere in the plugin. Would expose tabs in a remote browser to the agent.

The only sanctioned profile is `chrome-relay`: `driver: "existing-session"`, no `cdpPort`, no `cdpUrl` configured. It routes through the gateway's relay subsystem, which only forwards messages to tabs the user has explicitly shared via the relay extension popup.

#### 5.81a Why this strict shape

Three threat models, all real, all hit on 2026-04-29:

1. **Agent spawns its own Chrome.** Inherits a fresh, unauthenticated profile. Every task on a logged-in service ("create npm token", "open Slack", "view a Google Doc") becomes "log in first" — and the credentials live in a directory the agent owns. Beyond the friction, this leaks the auth surface to the agent, which is the opposite of what the user wants.
2. **Agent attaches to user's regular Chrome via direct CDP port.** With `--remote-debugging-port=9222` set, the entire browser is a single auth scope: every tab, every cookie, every saved password. An agent told to "look at npmjs.com" can read your bank tab. The relay extension scopes per-tab; direct CDP attach can't.
3. **Agent attaches to a remote browser.** Any agent on the host could be tricked into pointing CDP at a malicious URL and exfiltrating everything that browser sees. Block remote attaches at config-load time.

The relay extension's per-tab consent model is the only one that's actually safe under "the user has 100 tabs open and one of them is sensitive". This rule reflects that.

#### 5.81b How it's enforced

Three layers:

1. **`launchOpenClawChrome` hard guard** in `extensions/browser/src/browser/chrome.ts`. Throws on entry unless `OPENCLAW_ALLOW_UNSAFE_BROWSER=1` is set. Blocks the spawn-new-Chrome path.

2. **`resolveProfile` direct-attach guard** in `extensions/browser/src/browser/config.ts`. If a profile declares `driver: "existing-session"` _and_ a numeric `cdpPort`, throws at resolution. Blocks the user-tab-broad-scope path. Same env escape hatch.

3. **Configuration in `~/.openclaw/openclaw.json`**:

   ```json
   "browser": {
     "defaultProfile": "chrome-relay",
     "attachOnly": true,
     "profiles": {
       "chrome-relay": { "driver": "existing-session" }
     }
   }
   ```

   Only one profile, only the relay shape. The upstream-injected `openclaw` (spawn) profile still appears in the resolved profile list (defensive default in `ensureDefaultProfile`), but the guard in (1) blocks any actual spawn attempt. The `user` profile (`cdpPort: 9222`) was removed for the reason in 5.81a-#2.

#### 5.81c What an agent should do when asked to "use the browser"

- **Before any tool call**, list the tabs the user has shared via the relay. If the list is empty, stop and tell the user "no tabs are currently shared — click the relay extension icon on the tab you want me to see, then I'll retry". Do not navigate, do not retry.
- **The user has the page you need open _and shared_.** The first turn should target a shared tab by URL match or title. Use the relay's "act on shared tab" actions, never "open a new tab" (the relay won't see a new tab unless the user explicitly shares it).
- **Login state belongs to the user.** Never attempt to log the agent in.
- **CDP handshake budget.** Relay-routed CDP can take 1-3s on first connection per tab. Plan turns so the slow step is the handshake, not _that plus a 60s thinking step plus a screenshot plus a click_. Break work into multiple turns when in doubt.

#### 5.81d Common regressions and how to spot them

- **`[browser/chrome] 🦞 openclaw browser started (custom) profile "openclaw"` in the journal.** Spawn-guard bypassed. Re-apply the chrome.ts patch.
- **`browser.request` timing out at 45s with no useful error.** Relay extension isn't connected to any tab, OR the tab the agent picked isn't shared. Tell user, don't retry.
- **A future merge re-introduces a `user` profile with `cdpPort` in upstream defaults.** The resolveProfile guard will throw at the first attach attempt — the error message names the profile. Drop the profile from `~/.openclaw/openclaw.json`.
- **Agent reports "Tinkerclaw forbids direct CDP-port attach".** That's the resolveProfile guard. Either the config has a `cdpPort` profile (drop it) or upstream injected one (file an apply-fork-wiring patch).

#### 5.81e Files

- Spawn guard: `extensions/browser/src/browser/chrome.ts:launchOpenClawChrome` (top of function)
- Direct-attach guard: `extensions/browser/src/browser/config.ts:resolveProfile` (just after `driver` is computed)
- Config: `~/.openclaw/openclaw.json` → `browser.defaultProfile = "chrome-relay"`, `browser.attachOnly = true`, only the `chrome-relay` profile listed
- Bypass (test-only, never set in prod): `OPENCLAW_ALLOW_UNSAFE_BROWSER=1`

### 5.81f Browser-relay CDP bridge: synthesizers, persistence, iframe filter (2026-04-30)

The `chrome-relay` profile attaches to user-shared tabs via the in-page extension's `chrome.debugger.attach({tabId})` API. That API is permanently tab-scoped — Chrome refuses browser-level CDP methods on those sessions. Upstream's recent merge routes the gateway's `existing-session` profile through Playwright's `connectOverCDP`, which expects a full browser-level handshake. The relay reconciles this gap by **synthesizing** browser-level methods at the relay server (so they never reach `chrome.debugger`) and **filtering** chrome.debugger events down to the user-shared root targets only.

#### 5.81f-a Synthesizers in `extension-relay.ts:routeCdpCommand`

The relay pretends to be a single-context browser. Methods that respond entirely from the relay (never forwarded to the extension):

| method                         | response                                 | rationale                                                                                 |
| ------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `Browser.getVersion`           | constant build info                      | Playwright reads `userAgent` to detect headful vs headless.                               |
| `Browser.setDownloadBehavior`  | `{}`                                     | Per-context download config; no-op on the relay.                                          |
| `Browser.grantPermissions`     | `{}`                                     | Can't enforce permissions on chrome.debugger sessions; accepting lets Playwright proceed. |
| `Browser.resetPermissions`     | `{}`                                     | Same as above.                                                                            |
| `Target.setAutoAttach`         | `{}`                                     | Auto-attach is the relay extension's responsibility, not chrome.debugger's.               |
| `Target.setDiscoverTargets`    | `{}`                                     | Same.                                                                                     |
| `Target.getTargets`            | `{ targetInfos: [...connectedTargets] }` | Computed from the relay's per-shared-tab map.                                             |
| `Target.getTargetInfo`         | computed lookup                          | Same.                                                                                     |
| `Target.attachToTarget`        | computed sessionId lookup                | Same.                                                                                     |
| `Target.getBrowserContexts`    | `{ browserContextIds: ["default"] }`     | One synthetic context.                                                                    |
| `Target.createBrowserContext`  | `{ browserContextId: "default" }`        | Returns the synthetic context; subsequent `Target.createTarget` is blocked per §5.81.     |
| `Target.disposeBrowserContext` | `{}`                                     | No-op.                                                                                    |
| `Storage.getCookies`           | `{ cookies: [] }`                        | v1 stub; deferred to `chrome.cookies` proxy in a future iteration.                        |
| `Storage.setCookies`           | `{}`                                     | Same.                                                                                     |
| `Storage.clearCookies`         | `{}`                                     | Same.                                                                                     |

Every other CDP method falls through to `chrome.debugger.sendCommand` on the user-shared tab.

The synthetic browser context id `"default"` is also injected into every emitted `Target.attachedToTarget` and `Target.targetInfoChanged` event — Playwright's `crBrowser.js:147` asserts `targetInfo.browserContextId` is set, and tab-scoped CDP sessions don't include this field by default.

#### 5.81f-b Iframe / worker storm filter

`chrome.debugger.onEvent` fires for **every** target attached to the tab, including nested iframes, web workers, service workers, and isolated worlds. Without filtering, the extension would forward 50–250+ `Target.attachedToTarget` events per shared tab; Playwright would create a child CRPage for each and run full init (50+ CDP commands per page) on all of them. On a busy site like npmjs.com, the cumulative latency exceeds the gateway's 20s `browser.request` timeout — the agent gets `browser request timed out` even though the relay is up and forwarding correctly.

The fix is in `chrome-extension/background.js:shouldForwardDebuggerEvent`: only forward events for the **root shared tab's `targetId`**. Child-session events are dropped at the extension boundary. The relay never broadcasts them, so Playwright never sees them, so it never spawns child CRPages it can't drive.

The filter only allows:

- **All main-session events** (no `source.sessionId`).
- **`Target.attachedToTarget` / `Target.targetCreated`** when `params.targetInfo.targetId === tab.targetId`.
- **`Target.detachedFromTarget` / `Target.targetDestroyed`** when `params.targetId === tab.targetId`.

Everything else from child sessions is dropped.

#### 5.81f-c Persistence and auto-reconnect (the "stay shared forever" rule)

**Rule.** A tab the user has clicked "share" on stays shared until the user explicitly unshares or closes it. Gateway restarts, browser restarts, service worker idle-out — none of these should cost the user a click.

Three layers make this happen (all in `extensions/tinkerclaw-browser-relay/chrome-extension/background.js`):

1. **Persistence to `chrome.storage.local`** in `saveSharedTabs` after every share/unshare/tab-close. The "Tinker Shared" tab group acts as a secondary persistence layer that survives full browser restart (since chrome.storage.local survives across browser sessions, but tabIds change — group-by-title gives us a way to rediscover them).
2. **Re-announcement on relay reconnect** in `ensureRelayConnection`: after the WS opens, iterate every entry in the `tabs` Map and emit `Target.attachedToTarget` for each. The relay's `connectedTargets` Map is per-process and gets wiped on every gateway restart — without re-announcement, `/extension/status` shows `connected:true,count:1` but the relay has no targets to forward CDP commands to.
3. **Aggressive reconnect with exponential backoff** in `onRelayClosed`: 1s → 2s → 4s → 8s → 15s cap, retried indefinitely while `tabs.size > 0`. The user can stop it only by explicitly unsharing each tab.

#### 5.81f-d Service-worker keep-alive

MV3 service workers idle out after 30 seconds. If the gateway is down for >30s and the worker sleeps, the reconnect timer never fires, the alarm is missed. We register a `chrome.alarms` named `tinkerclaw-relay-keepalive` with a **25-second period** while `tabs.size > 0`. The alarm handler is a cheap touch that:

- Wakes the worker.
- If `relayWs` is not OPEN and no `reconnectTimer` is pending, kicks off `ensureRelayConnection`.

The alarm is created in `ensureKeepAlive`, called after share, unshare, tab-close, and on service-worker startup. The `alarms` permission was added to `manifest.json`.

#### 5.81f-e The chrome.debugger infobar

When `chrome.debugger.attach()` is called, Chrome shows a yellow infobar at the top of the affected tab: `"Tinkerclaw Browser Relay" started debugging this browser. Cancel`. This is a Chrome-mandated security UX — there is no way to suppress it from extension code, and there shouldn't be: it's the user's signal that an extension is reading/writing the page.

The only way to hide it is to launch Chrome with `--silent-debugger-extension-api`. This is a startup flag, not an extension-controllable setting. the user runs Chrome via a desktop shortcut he edits to include the flag; document this once in the README rather than repeatedly explaining the warning is inherent.

#### 5.81f-f Tracing

The relay's `sendToExtension` can log every forwarded CDP method + duration when `OPENCLAW_RELAY_CDP_TRACE=1` is set. Off by default — Playwright's CRPage init sends 200+ messages and logging them all is noise. Turn on for regression diagnosis only.

#### 5.81f-g Open follow-ups

- **Storage.getCookies / Storage.setCookies real proxy** via `chrome.cookies.*` API in the extension. Today's empty-list stub is fine for npm-publish-style flows but breaks anything that probes login state. Spec exists in `docs/superpowers/specs/2026-04-29-browser-relay-cdp-bridge-design.md` §4.2.
- **Playwright connection caching at the gateway.** Each `browser.request` may currently open a fresh `connectOverCDP`; with iframe filtering, init time drops from 20s to ~2s, but reusing the connection across requests would make tool calls near-instant. Investigate `browser-tool.runtime.ts` connection management.
- **Multi-context simulation.** Today the relay reports one virtual context. If a future agent flow needs multiple contexts, extend the synthesizer.

---

### 5.82 Cloner-utility mindset for the public fork (2026-05-09)

**Rule.** Every commit pushed to `origin/main` or `origin/develop` is read by two distinct audiences. Optimize for both — anything that helps only the maintainer is leakage, anything that helps only cloners-from-zero is incomplete.

**Audience A — fresh cloner.** Discovers TinkerClaw, runs `git clone`, has zero context. They want, in this order:

1. Why this fork exists (`README.md`, `FORK.md` — five-second elevator pitch).
2. How to stand up their own deployment with their own configs (`FORK_SETUP.md`, `CHANGELOG-FORK.md` for breaking-change history).
3. Where the fork-specific extensions live (`extensions/tinkerclaw-*`) and what each one does (its `index.ts` JSDoc header + the README of any plugin with public docs).
4. How to verify their build works (the §5.78c shippable checklist + smoke probe).

If a fresh cloner hits a `<FirstName>-mentioned-this` comment (i.e. a literal first name baked into a code comment), a hardcoded path that only exists on the maintainer's machine, or a config example that's actually the maintainer's real WhatsApp JID, they have to either guess or quit. Both outcomes lose us a contributor.

**Audience B — pulling cloner.** Already has a deployment, runs `git pull`. Their asks, in order:

1. **What changed since my last pull?** (`CHANGELOG-FORK.md`, plus the commit log between two SHAs.)
2. **Does this break my config?** (Any new required keys, deprecated paths, schema migrations.)
3. **What new features can I now turn on?** (Plugin additions, new openclaw.json keys with defaults.)
4. **What should I test?** (Pointers to the smoke probes that exercise the new surfaces.)

Pulling cloners read `git log` more than `README.md`. Commit messages and `CHANGELOG-FORK.md` entries are the primary surface — they should answer questions A1–A4 in the message body, not just describe what changed.

**Concrete obligations on every public commit.**

1. **PII pass before push.** Run the leak grep — the regex itself lives in `scripts/pii-pre-push.sh` and `pii-boundary.md` (both self-excluded). It matches first-name narrative use of the maintainer (with a lookahead carve-out for the full name on author bylines), family/contact first names, location strings, host paths, business-thread tokens, GitLab tokens, and the maintainer's work email. Zero hits required. This section just says: don't skip the grep.
2. **Schema/config touch → CHANGELOG-FORK.md entry.** If you added or renamed an `openclaw.json` key, mention it under "Breaking changes" or "New optional config" with a one-line example. Pulling cloners diff CHANGELOG between their last-pulled SHA and HEAD; that's where they look.
3. **New extension → README feature list update.** Mention it next to the existing `tinkerclaw-*` callouts. Even a one-line bullet ("`tinkerclaw-people`: profile resolver via `people.{resolve,read,list}`") is enough to make it discoverable.
4. **Architectural rewrite → bible section.** Any time a fork-side subsystem changes shape (auth flow, channel routing, gating logic, persona pipeline), add or update a bible §5.x. The bible is where pulling cloners look when CHANGELOG is too terse.
5. **Field rename in a plugin's persisted state → migration shim or call-out.** A renamed JSON field in `~/.openclaw/workspace/<plugin>/_state.json` orphans existing data on first read. Either ship a rename-on-load shim (preferred) or note the one-time noise in CHANGELOG so cloners don't think their data was lost.
6. **Comments name-drop the maintainer? Replace with `the user`/`the operator`/`the owner`.** First-name "`<FirstName>` wants X" reads like an inside joke and triggers the PII pass. The comment exists for a reader; address that reader, not the absent author.

**What might warrant a new top-level doc.** Ideas worth considering for cloner utility, separately from this guideline (each is optional, raise individually):

- `CLONERS.md` — single-page "fresh-clone vs git-pull" orientation. Two columns: "First time? Read these in order." / "Pulling latest? Diff these files."
- `extensions/README.md` — a one-paragraph-per-plugin index of all `tinkerclaw-*` extensions with their gateway methods and config keys.
- `examples/openclaw.example.json` — a sanitized config showing the fork's recommended `channels`, `agents`, `plugins.allow` shape, with placeholders (`+your-phone-number`, `your.handle@gmail.com`) instead of real values.

These are proposals — only create them when the maintainer agrees the cloner-utility gain is real. Don't pre-emptively author docs that nobody will read.

**Anti-patterns this rule forbids.**

- A commit message that only says "fix X" with no audience-A or audience-B context — both audiences need at least the WHY in plain language.
- A new fork plugin landed without a README or a JSDoc header explaining the gateway methods it exposes.
- A `noPrefixChats` or `allowFrom` example in a doc using a real WhatsApp JID instead of `<your-jid>@s.whatsapp.net`.
- An IDE-formatted absolute path in a code comment ("ran from `/home/<user>/src/tinkerclaw`") — replace with `the fork repo`, `~/src/tinkerclaw`, or relative.
- Deleting a public-API field without a shim or a CHANGELOG breaking-change entry.

---

### 5.83 The 12 OSS-Harness Upgrades — Autonomy Borrowed From the Open-Source Agent Frontier (2026-06-02, commit `06f8647fdc`)

This is the narrative for the largest single autonomy push the fork has shipped: twelve upgrades (U1–U12) landed in one commit on `develop` (`06f8647fdc`, on top of `70ad58e45d`). It is a decision log, not a spec — every structural fact (file paths, store shapes, RPC contracts, dead-code-trap registrations) lives in the owning optics. This section records WHY we did it, WHAT we chose to keep on or off, and WHAT must not regress.

#### Why this initiative exists

§11.5 (Research Papers — Implementation Status) tracks the eleven papers the cognitive subsystems were built from. The honest read of that table by mid-2026 was: the fork had strong _substrate_ (ENGRAM event store, RAAC round-table, AMYGDALA, recipes/kits, Prefrontal) but the autonomy loops on top of it were either `DESIGN ONLY` (Curiosity, Corporate Swarm) or one-shot rather than self-improving. Meanwhile the open-source agent frontier had shipped concrete, reproducible mechanisms for exactly those gaps. The roadmap (`docs/notes/2026-05-30-papers-coverage-and-oss-roadmap.md` Part 3, in the jarvis-icu repo) maps each upgrade to the OSS harness it borrows from:

- **U1 recipe-evolution loop** — STOP / Gödel-machine self-improvement: recipes accumulate a fitness signal and mutate toward higher success.
- **U2 curiosity / intrinsic-motivation** — closes the `DESIGN ONLY` Curiosity-Motivation row with a real gap store + hedging detector + idle goals (the LoRA half stays a stub — see decisions).
- **U3 bi-temporal edges** — Graphiti / Zep: memory edges carry valid-time intervals so a contradiction closes the old fact instead of overwriting it; reads can ask "as of T".
- **U4 failure→strategy-switch** — turns repeated failure modes into a recorded strategy decision the consolidation cron applies.
- **U5 durable checkpointing** — DeerFlow-style resumable plans: a kit run can checkpoint per step and resume after a crash.
- **U6 Voyager skill-library** — Voyager: extract a verified, structured procedure from a successful run, never delete it, embed-rank it for reuse.
- **U7 AG2 speaker-select** — AG2 / AutoGen: smarter debate orchestration on top of the existing round table (budget-aware speaker selection, carried memory).
- **U8 Mem0 reconciliation** — Mem0: an ADD/UPDATE/DELETE/NONE reconciler on the ingestion hot path so memory converges instead of accreting duplicates.
- **U9 A-MEM Zettelkasten** — A-MEM: `[[wikilink]]` + entity references between memories, indexed bidirectionally, expanded one hop at retrieval.
- **U10 ToT / LATS** — Tree-of-Thoughts / Language-Agent-Tree-Search: an optional pre-prompt thought search with a persisted reasoning trace.
- **U11 external recipe acquisition** — Symphony / skill-sharing: import a `SKILL.md` as a kit when the Journey registry is unreachable, resolving transitive deps.
- **U12 recipe marketplace** — versioned, immutable, rating-ranked recipe distribution layered on top of U1's fitness.

The framing the architect set: **autonomy-first**. Borrow the mechanism that's already been validated in the wild rather than re-derive it, wire it to the fork's own substrate, and gate anything that could surprise the operator behind a flag.

#### What shipped, and what it composes with

The unifying shape across U1–U12 is the producer→consumer loop: a _producer_ emits a signal during real work (a fitness tag, a curiosity gap, a superseding edge, a reasoning trace, a backlink), and a _consumer_ later reads it (kit selection, the consolidation cron, a temporal read, a retrieval expansion). Three of the new RPCs are confirmed live against the restarted gateway on this commit: `fork.strategy.switch.list`, `fork.skill.search`, `fork.memory.search` (the last returning `temporalMode:"current"` — U3's read surface). Selection precedence in kit scoring is the load-bearing composition: **base → U1 fitness feedback → U12 rating tie-break**, in that order, so a marketplace rating can only break ties, never override demonstrated fitness. Structural homes: `memory-layout.md` (U3/U6/U8/U9 stores + bi-temporal edges), `subagents-and-recipes.md` (U1/U5/U11/U12 recipe-kit contract + selection precedence), `tool-loop.md` (U10 reasoning runtime + the attempt.ts deliberation seam), `topology.md` (U7 round-table extension + orchestrator), `config-shape.md` (the new openclaw.json keys + the dead-code-trap registry).

#### The decisions (this is the part to read before changing anything)

1. **U2 2c LoRA training kept EXTERNAL — deliberately a stub.** Curiosity logs gaps and (when enough accumulate) raises a "this capability needs training" signal via `consolidation-shell.ts:notifyLoraTrainingNeeded` gated by `capability-matrix.ts` (`src/validation/`). That is the entire fork-side surface. Actual GPU/Python LoRA training is out of scope and intentionally not wired — running model training inside the gateway is the wrong place for it, and the fork ships to cloners who won't have the hardware. The stub is honest TBD, not dead code pretending to be live; it is registered as a dead-code trap in `config-shape.md` so nobody later mistakes the no-op for a regression.

2. **U8 Mem0 reconciliation DARK-LAUNCHED OFF.** This is the most consequential gate. Reconciliation is the one upgrade that can _rewrite the operator's engram_ — `reconciler.decide()` sits in the ingestion append hot-path and can emit UPDATE/DELETE, and `memory-md-writer.ts` can edit the human-readable MEMORY.md. We refused to enable a memory-mutating loop by default. It is gated behind `ENGRAM_RECONCILE` (default OFF). With the flag off, the default reconciler is **always-ADD** — byte-for-byte today's behavior, no UPDATE, no DELETE, no MEMORY.md edits. The md-writer is additionally bounded, idempotent, and suggest-only even when on. This is the opposite call from the three full-autonomy flags the architect turned on (supersede, semantic-match, recipe self-apply): those rewrite recipes and close memory edges, but they don't silently delete the operator's authored memories. Reconciliation does, so it waits for an explicit decision after the operator has watched its proposed ledger for a while.

3. **U1 attribution chosen as Prefrontal tag-stamping, not a separate event stream.** Recipes need to know which run they fed so fitness can be credited. The decision was to make the producer the recipe-runner itself: `recipe-runner.ts` stamps `recipe:<owner/slug>` attribution tags via an `onTag` callback that `prefrontal.recipe.run` threads in. Fitness (`makeFitnessLookup`, Laplace-smoothed success rate) is then threaded back into `matchRecipesDetailed` as selection feedback. We chose tag-stamping on the existing kit-run path over a parallel telemetry channel because the kit run is the single point that already knows owner, slug, phase, step, and session — adding a second producer would have been a second thing to keep wired (and the next item is exactly about producers that weren't kept wired).

4. **U7 7D/7G shipped READY-BUT-UNBOUND, pending gateway RPCs that don't exist yet.** The AG2 speaker-select extension carries two pieces that depend on gateway RPCs the gateway does not expose: 7D's `respectBillingGate` / `resolveDebateBudget` wants `agent.getBillingState` (to clamp debate budget to billing headroom), and 7G's `orchestrator-api.ts` (`DebateOrchestrator` / `getOrchestrator`) wants `plugins.getOrchestrator`. Both degrade gracefully today — the budget clamp is a no-op and orchestration falls back to plain RAAC. We shipped them unbound rather than hold the whole commit, but this is a **real dead-code trap**: the code path looks live and will silently stay inert until those RPCs land. It is registered in `config-shape.md` alongside the LoRA stub and the reconciliation flag. 7F (SpeakerMemory carryover) does NOT depend on a missing RPC and is live.

#### Don't-regress

- **Producers must fire at REAL call sites — verify the emit, not just the consumer.** The first implementation pass of this initiative merged with every unit test green while six of the twelve upgrades did nothing at runtime: the consumers were wired and tested, but the producers that feed them (recipe-attribution `onTag`, `setLinkBuilderRuntime` at the session-setup site, `stashReasoningTrace` in `onTurnComplete`, the consolidation-cron skill/strategy injections, the fitness/rating feedback into selection) were left as handoff prose. A unit test that mocks the producer's output and asserts the consumer stays green whether or not the producer ever fires in production. This is the same class as the 2026-06-01 RECIPES-panel bug (`setRecipe` never called) and the 2026-05-30 W3 subagent-color bug (`_subagentId` never set) — three of a kind. Full incident with the confirmed-live producer list is the `META [config-dead-code]` entry in `bug-log.md`; the producer→consumer invariant itself lives in `design-principles.md`. For any future producer→consumer wiring in this family: trace the producer to a call site on the hot path and confirm it fires there.
- **Single owner per fact across the new stores.** U3/U6/U8/U9 each introduced their own persistence (bi-temporal edges, skill library, reconciliation ledger, link index `<sessionKey>.jsonl`). Do not duplicate a memory fact across two of them — a skill is not a memory edge is not a backlink. The store boundaries are documented once in `memory-layout.md`; treat that as the authority.
- **Don't flip `ENGRAM_RECONCILE` to default-on as a convenience.** The default-OFF / always-ADD posture is the safety contract for the operator's memory. Turning it on is an operator decision after watching the proposed ledger, not a maintainer cleanup.
- **Don't "complete" U7 7D/7G by faking the missing RPCs.** They bind when `agent.getBillingState` and `plugins.getOrchestrator` exist for real. Until then the graceful no-op IS the correct behavior; a stubbed-positive billing gate would route real debates past the budget clamp.
- **Don't drop the U10 deliberation-prompt restore.** A bug in this pass leaked the deliberation system-prompt augmentation into the next turn when a `runtimeContext` override was present; the fix captures `preDeliberationSystemPromptText` and restores the TRUE base in `finally` so the augmentation stays turn-local (`src/agents/embedded-agent-runner/run/attempt.ts`). If you refactor `maybeRunThoughtSearch`'s call site, keep the capture-and-restore.

- **Status:** `DEPLOYED`
- **last_verified:** 2026-06-02
- **last_verified_commit:** `06f8647fdc`
- **verify:**
  - name: U7 strategy-switch read RPC is live (one of the 3 VERIFIED-LIVE RPCs on this commit)
    cmd: python3 -c 'import subprocess; r=subprocess.run(["openclaw","gateway","call","fork.strategy.switch.list"],capture_output=True,text=True); assert "\"ok\"" in r.stdout, r.stdout[-400:]'
  - name: the 12-upgrade roadmap source exists (jarvis-icu repo)
    cmd: python3 -c 'import glob,os; assert glob.glob(os.path.expanduser("~/src/jarvis-icu/docs/notes/2026-05-30-papers-coverage-and-oss-roadmap.md")), "roadmap source missing"'

### 5.83a External Knowledge Import — vendor-clone + symlink + recipe orchestration (DECIDED 2026-06-12)

The first real instance of §5.83's U11 (external skill acquisition): integrating `coreyhaines31/marketingskills` (44 marketing skills + 51 API CLIs, MIT, 33k stars). The decision is the **three-layer split** — reusable for any future external knowledge repo:

- **Knowledge → skills, vendored not forked.** The upstream repo lives as a git clone at `~/.openclaw/workspace/vendor/marketingskills`; updates = `git pull`; zero rewrite; vendored files are read-only. **AMENDED 2026-06-13 (total-recall eviction, owner-decided):** the day-one _curated subset_ (6 skills symlinked into `~/.openclaw/workspace/skills/`, ~915 tok of always-loaded descriptions per session) was evicted and replaced by ONE umbrella **router skill** `~/.openclaw/workspace/skills/marketing/SKILL.md`: a ~130-token description carrying the umbrella trigger phrases, whose on-demand body says read `.agents/product-marketing.md` first + a route table mapping task→`vendor/.../skills/<x>/SKILL.md` for all 44. Eviction-with-pointer, same shape as ENGRAM total recall: standing cost drops ~85%, ALL 44 frameworks stay one read away, and the catalog has no growth cap. Trade-off accepted: one extra read hop on fire, slightly blunter triggering than per-skill phrase lists. Both the symlink add AND the eviction were verified to refresh the live session WITHOUT a gateway restart (loader follows symlinks — pp-\* precedent — and watches the dir).
- **Orchestration → BROCA recipes, new `marketing` category.** Recipes hold the WHEN/sequence (fan-out, gates, budgets); skills hold the HOW. Added `marketing` to `CANONICAL_CATEGORIES` (`recipe-author.ts` — gates only the author RPC; the loader was already permissive), recategorized the 7 existing marketing recipes (were mis-filed `operations`/`communication`), authored `marketing-page-audit` (CRO+SEO+copy fan-out → merged prioritized report). Catalog row color: coral. **Recipes carry ZERO standing token cost and have NO catalog cap** (confirmed 2026-06-13 against `recipe-matcher.ts`): matching is code-side at `before_prompt_build` — fuzzy-scored over the on-disk catalog — and only the MATCHED recipe's plan (or a small gap/low-confidence note) is injected. Store thousands; the per-turn injection stays constant. All marketing recipes obey the **skeleton+variables rule** (subagents-and-recipes.md "Authoring recipes", architect rule 2026-06-11): the `.md` is a generic shareable template — operator specifics (sites, names, paths) live as typed `{{params}}` whose values resolve from the PRIVATE VarStore (`~/.openclaw/recipe-vars.json`, jarvis-brain) or from defaults that are cross-user conventions. Maximum cloner benefit AND maximum future task coverage come from the same move: the more generic the skeleton, the more of our own tasks it handles later (`marketing-page-audit` v1.1 scrubbed to comply).
- **Context → the `.agents/product-marketing.md` contract** (Haines convention adopted verbatim so vendored skills find it unmodified): one file with positioning/ICP/voice/hard-rules read at `~/.openclaw/workspace/.agents/product-marketing.md` (symlinked into jarvis-workspace). **Privacy plumbing (2026-06-13):** `.agents/` physically resolves into the PUBLIC fork repo, so the REAL file lives in the private workspace repo at `~/.openclaw/workspace/marketing/product-marketing.md` with a symlink at `.agents/product-marketing.md` (gitignored in the fork) — the read path stays Haines-convention, the internal strategy never ships that every marketing skill/recipe reads FIRST and only asks what it doesn't cover — the institutional form of resolve-from-context-before-asking. This file is what makes 44 generic frameworks speak in our voice; it carries the PII/no-fabricated-metrics hard rules so framework advice can't override them.

**Don't-regress:** (1) never copy-and-edit a vendored SKILL.md in place — patch via a wrapper skill or upstream PR, else `git pull` becomes a merge; (2) keep the vendor clone OUT of the workspace git index (nested repo); (3) skill-authoring standards adopted from this repo — per-skill `evals/evals.json` + user-phrase trigger descriptions — apply to OUR published ClawHub skills (retrofit tracked in the inbound-marketing plan).

- **Status:** `DEPLOYED` (skills verified live in-session 2026-06-12 without restart; recipes load on next gateway restart; `CANONICAL_CATEGORIES` edit needs next `pnpm build`)
- **last_verified:** 2026-06-12
- **verify:**
  - name: marketing router skill exists and routes to the vendor clone
    cmd: python3 -c 'import os; s=open(os.path.expanduser("~/.openclaw/workspace/skills/marketing/SKILL.md")).read(); assert "vendor/marketingskills" in s and os.path.isdir(os.path.expanduser("~/.openclaw/workspace/vendor/marketingskills/skills"))'
  - name: product-marketing context contract exists
    cmd: python3 -c 'import os; assert os.path.isfile(os.path.expanduser("~/.openclaw/workspace/.agents/product-marketing.md"))'
  - name: marketing category present in author gate
    cmd: python3 -c 'import os; s=open(os.path.expanduser("~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/recipe-author.ts")).read(); assert chr(34)+"marketing"+chr(34) in s'

---

### 5.84 Fluid model×effort — real autonomy + honest visualization (DEPLOYED 2026-06-14)

- **Status:** `DEPLOYED` (Drop 1 + 2 + 3, 2026-06-14) — amends §5.8h (EEG, as-built updated). **Drop 1 (UI, live):** EEG depth-shaded concurrency stack + sticky client-side effort slider (commits `1083112371`/`a9a1e093c3`/`c9de8530fc`; tinker-ui dist, no restart). **Drop 2 (backend, live):** per-unit `thinking` on orchestrate `agent()` + BROCA recipe `model:`/`thinking:` step directives + dead `validateModelAssignment`/hardcoded tier-list retired (commits `7811541bd7`/`1ddc2734ce`/`7ded898778` + type-fix `3e3672df67`). The build first needed `pnpm install` (it fixed an UNRELATED `amazon-bedrock-mantle` runtime-dep-staging failure in `runtime-postbuild` — not Drop 2); then `pnpm build` + gateway restart 2026-06-14 (healthz OK). **Live proof:** an orchestrate `agent({thinking:'high'})` smoke spawned a child with `MAX_THINKING_TOKENS=16000` (=high) — per-unit effort reaches the child budget end-to-end. **Drop 3 (the dynamic allocator, live):** Auto = a fluid effort allocator (`src/agents/effort-allocator.ts`, wired at `agent-command.ts:591` as a `?? chooseAutoEffort()` tail) — annealed exploration (bold when cold → task-weighted as the `effort-ledger.jsonl` matures), aggressiveness scaled by quota surplus (`pressure = util5h − elapsedFraction` from `anthropic-ratelimit-store` + OAuth `resets_at`; abundant headroom near a reset → reaches Max), coverage so each level is experienced; an explicit slider/`/think`/persisted level always wins (it short-circuits the `??` chain). Plus **B-live-rank** (`buildConfiguredModelCatalog` carries the live daily rank) and the **model-force slider's per-turn model reach** (client `modelPinBySession` → `chat.send {model}`, mirroring the effort pin). **`adaptive` finding:** it is a REAL backend level (Anthropic adaptive-thinking API mode `thinking:{type:"adaptive"}` + a per-model default), NOT a redundant duplicate — so it is KEPT as a backend level and only removed from the UI effort slider (Auto is the single "system decides" stop); `normalizeThinkLevel` maps `auto→undefined`, `adaptive→adaptive`. Commits: Auto/Adaptive collapse `eb09728589`/`f0eba60378`/`e7a39558ba`/`5826d55278` + `7c120840a5` (adaptive-as-backend fix); `1d8b0c9bd7` B-live-rank; `7fc786c172` allocator; `16beda4961` model-pin. Gateway rebuilt + restarted 2026-06-14 (healthz OK; allocator confirmed in the bundle `dist/agent-command-*.js`); allocator policy unit-tested 6/6 (tsx) + `tsgo:core` clean. **Live-firing** surfaces on a true-Auto `:main` turn → watch the EEG effort column vary + the `effort-ledger.jsonl` grow (at `$OPENCLAW_STATE_DIR`). **Next refinement (non-blocking):** outcome-quality exploit (join the ledger with run telemetry to pick best-for-task) — the data is captured now. Plans: `jarvis-icu/docs/superpowers/plans/2026-06-14-fluid-model-effort-drop{1,2,3}.md`. Pre-existing extension-wide tsgo debt (676 errors incl. zalo/plan-rpcs/topology) is out of scope and does not block the build (tsdown skips typecheck). Grounded by parallel recon sweeps over current code; superseded the diagnosis-only handoff `docs/context/2026-06-14-effort-system-handoff.md`.
- **Owner steer (2026-06-14):** "Auto should let Jarvis use its best judgement to adjust thinking effort … a smart combination of model and effort … for different parts of its thinking and for subagent spawns." And: **"maximum autonomy and fluidity, minimum hard rules."** This section is derived from FOUNDATION, not from a classifier.

**Why this exists (the diagnosis, verified).** "Effort" today has a doing half and a visualizing half; the visualizing half (EEG, §5.8h) is honest, the doing half is broken in two independent ways, and the would-be "decision engine" is computed but **advisory-only on every surface**:

- The prefrontal effort-router CLASSIFIES well — `classifyComplexity()` (`effort-router.ts:229-317`) returns `{level∈trivial/standard/deep/ultra, score, modelTier, thinkingHint, orchestration}` — but its sole consumer is `buildEffortGuidance()` (`:324-339`) which emits an `<effort_adaptation>` **prose** block via `before_prompt_build`'s `prependSystemContext` (`index.ts:876-877, 1080-1081`). `modelTier`/`thinkingHint` reach nothing that selects a model or a budget.
- The real budget IS enforced but is never fed by the router: `thinkLevelToMaxThinkingTokens()` (`thinking-budget.ts:25-63`: minimal 2k / low 4k / medium 8k / adaptive 8k / high 16k / xhigh 22k / max 28k) → `params.thinkLevel` → `__openclawThinkLevel` (`attempt.ts:1922`, `worker.ts:681-687`). `params.thinkLevel = thinkOnce ?? thinkOverride ?? persistedThinking` (`agent-command.ts:591`) — never `?? routerDerived`.
- `validateModelAssignment()` (`effort-router.ts:92-122`) is **dead/log-only** (`index.ts:282-292` only warns). The enforced model-override seam `before_model_resolve` (`setup.ts:44-105`, applies `{modelOverride,providerOverride}`; result type `hook-before-agent-start.types.ts:14-19`) **exists but prefrontal never registers it.**
- The manual sliders don't persist or reach the model: the Tinker UI is a webchat client; `rejectWebchatSessionMutation` (`sessions.ts:253-279`) blocks metadata patches, and the slider's `req("sessions.update", {patch:{thinkingLevel}})` (`app.ts:9361-9373`) hits a **method that does not exist** (only `sessions.patch`), error swallowed → snaps back to Auto on the next `updateBudgetPanel` re-render. **This contradicts §5.8h:505, which claims the sliders persist via `sessions.update {thinkingLevel}/{model}`; §5.8h:505 is wrong and is corrected here.**
- The `DEFAULT_EFFORT_ROUTING_CONFIG` tier map (`effort-router.ts:30-35`, `maximum:["claude-code/claude-opus-4-7"]`) **hardcodes model ids that drift from the daily `model-rank-refresh` cron** (`auth-routing.md`) — itself a FOUNDATION #2 violation.

**Governing principle (FOUNDATION #1/#2, the apex outranks every optic).** The decision engine is **Jarvis's own fluid judgement, guided by the `model-effort-gating` skill + `orchestration-disposition.md` matrix** — expressed through its three autonomy vehicles: **direct subagent spawns** (`openclaw-spawn-subagent.mjs --model --thinking`), **dynamic workflows** (`openclaw-orchestrate.mjs`, `agent()/parallel()/pipeline()`), and **BROCA** (recipes composed/authored on the fly — `prefrontal.recipe.compose` mechanical skill-search + `prefrontal.kit.author` on NO-MATCH; see `subagents-and-recipes.md`). We add **levers, live signals, and observability — never a hard classifier** (FOUNDATION #2 forbids exactly the fixed keyword lists/thresholds/model ids the effort-router embodies). The ONE categorical boundary that stays hard is **explicit user intent** (the sliders) — alongside the PII split, security gates, tool whitelists.

**Work-streams.**

- **(A) Complete the EFFORT lever everywhere MODEL already works.** Jarvis can already pick `model` per dispatched part (enforced: `--model` → `resolveSubagentModelAndThinkingPlan` → child-session store, `subagent-spawn.ts:645-922`) but **not effort**: `openclaw-orchestrate.mjs` `agent({model})` doesn't thread `thinking`; recipe `SpawnOpts` (`recipe-runner.ts:1180-1211`) carries neither model nor effort; `spawnStep` (`:1197-1256`) passes neither flag. Thread per-unit `thinking` (and surface `model`) through all three so "a different model **and effort** for different parts of its thinking" is real. Per-unit `--thinking` is already plumbed end-to-end into the child session (`openclaw-spawn-subagent.mjs:53` → `subagents-rpc.ts` → `resolveSubagentModelAndThinkingPlan` → `thinkingLevel`); the work is exposing it in the orchestrate/recipe authoring surfaces, not new core plumbing.
- **(B) Make model selection LIVE, not frozen (FOUNDATION #2).** Retire the hardcoded tier list and the dead `validateModelAssignment`; any tier/model hint derives from the rank cron's live "sense of best." The skill/disposition stays the **fluid advisor** — advisory BY DESIGN is correct here, not a gap to "enforce away."
- **(C) Fix the manual slider (the user-override lever; explicit intent stays hard).** Replace the broken `sessions.update` persist with a **client-side per-session override** (`Map<sessionKey,ThinkLevel>` mirroring `eegStores` `app.ts:1543`) that **re-applies on every `chat.send`** (the webchat-safe path: `chat.send`'s `thinking` param → `/think <level>` injection into `BodyForCommands`/`CommandBody` `chat.ts:2161-2163`, display `Body` stays clean; OR a new clean per-turn `thinkingOnce` param threaded to `agent-command.ts:304`). Sticky per session, survives re-renders, reaches the budget, other sessions untouched; reset on `/clear`, optional localStorage for reload-survival. The EEG `forced`/dashed flag (`viewedSessionForced()` `app.ts:8688-8695`) must consult this override map (it currently reads `sessions[].thinkingLevel`, which we won't write).
- **(D) EEG (amends §5.8h).** **Restyle the concurrency stack:** §5.8h:501 currently specs "laterally offset" strands — replace with a **depth-shaded vertical stack: up to 5 lines stacked on top of one another, the bottom line darkest and each higher one lighter; for >5, a count badge shows how many run at that moment** (owner spec 2026-06-14). Invariant 4 (cap 5 + mandatory count badge) holds; only the offset→depth-shade rendering changes. **De-stale §5.8h:491 gap (1):** the subagent feed (`sessionKeyMatches` admitting `:subagent:` descendants) was fixed 2026-06-14 (`cfbd6b4953` admit + `0668ac93e7` hover labels) — verify live and update the gap list. The EEG already carries everything needed (`EegSample{model,provider,chosenLevel,forced,subagent,parentRunId,startedAt,endedAt}`, `eeg-trace.ts:32-48`); once the fan-out runs at varied model+effort (A), the existing main-line-plus-branches view lights up with no further data work.

**Precedence (falls out, no new rule):** an explicit slider/`/think` choice resolves into `params.thinkLevel`/model FIRST; the agent's fluid choice fills the **Auto** vacuum only. Explicit always wins, even a low pick. In the EEG this reads correctly: slider-pin → dashed (forced); agent/router choice → solid at the chosen column.

**Safety = reversibility + kill-switch + the FRACTAL budget governor** (the derived-pressure score of §5.67b — real remaining allowance × time-to-reset × value-of-work; **surplus-spend before a reset is welcome**, FOUNDATION Budget doctrine) — **never a frozen aggressiveness cap.** Fable stays out of routing while US-gov-disabled (a live availability signal, not a hardcoded exclusion). Categorical boundaries unchanged.

**Drops + deploy gates.**

- **Drop 1 (UI-only, instant deploy via `tinker-ui pnpm build`, no gateway restart):** (C) slider override + send-payload reach + `forced` map read; (D) EEG depth-shade restyle + de-stale §5.8h. Verify the served artifact (stale-vite gotcha).
- **Drop 2 (backend, own rebuild→healthz 200→clean-turn gate):** (A) per-unit `thinking` through orchestrate + recipe `SpawnOpts`; (B) live tier derivation + retire dead `validateModelAssignment`/hardcoded ids. If a clean per-turn `thinkingOnce` param is chosen for (C) over the `/think` path, it lands here too.

**Don't-regress / where facts land at implementation:** structural facts + `verify[]` go to the OWNING optic (single owner per fact): EEG render → `tinker-ui.md` §5.8h; tier/rank derivation + Fable-availability → `auth-routing.md`; per-unit effort lever in spawn/orchestrate/recipe → `subagents-and-recipes.md`. This §5.84 holds the decision/intent only. No hard classifier may be introduced (FOUNDATION #2); the sliders remain the only hard model/effort boundary (explicit user intent).

---

### 5.84a Burn-down allocator (live quota signal) + slider/EEG as-built corrections (2026-06-18)

**Status:** `DEPLOYED` + live-verified 2026-06-18 — as-built corrections (`387db5d42e`, `ff6d2ec183`) AND the burn-down allocator (design `8cb2b8ac5c`, impl `4ebbed16f1`), all on `develop` (NOT pushed). **Live proof of the burn-down:** a true-Auto Tinker turn now logs live `util5h`/`util7d`/`weekElapsed` with a COMPUTED `pressure` (the dead `−0.5` is gone); at 3% into the week + 3% consumed (on pace) it chose `low` (chill early), exactly per design. The "through-the-roof Wed/Thu" branch is covered by the policy unit tests (5/5) + the now-live `weekElapsed`, and surfaces organically as the week progresses.

**As-built corrections to §5.84 (four bugs surfaced by daily use after the 06-15→06-18 power outage; all DEPLOYED + live-verified):**

- **Slider hang.** The post-outage restart came up on a stale dist that REJECTED the `chat.send {model}` param → the model-force slider hung every turn ("spins forever, never replies"). The real fix (accept `model` in `ChatSendParamsSchema`, `gateway/protocol/schema/logs-chat.ts`; inject `/model` via `buildChatSendCommandBody`) was authored 06-15 but never committed/deployed. Now live (`387db5d42e`). NB: `chat.send` validates against `ChatSendParamsSchema` (logs-chat.ts), NOT `SessionsSendParamsSchema` (schema/sessions.ts).
- **§5.84(C) directive path was silently broken for ALL real prompts.** `get-reply-directives.ts:303-321` (a PR #3705 timestamp-injection guard) called `clearInlineDirectives()` whenever ANY inline directive preceded real message text — wiping BOTH the slider's leading `/model` AND `/think`. So every real prompt ran the default brain + default 4000 budget; the EFFORT slider never reached the budget either. Narrowed the clear to NON-leading directives only (the slider always injects leading). VERIFIED LIVE: `/model sonnet /think high <prompt>` → spawn `--model claude-sonnet-4-6` + `MAX_THINKING_TOKENS=16000` (`ff6d2ec183`).
- **Allocator wired on the WRONG path for webchat.** `chooseAutoEffort` was only called at `agent-command.ts:609` (CLI `agent` path); chat.send/Tinker turns resolve effort in `get-reply-directives.ts:424` and NEVER reached it → Auto parked at the default for every Tinker tab (the `agent:main:main` ledger rows were all CLI-path). Wired the allocator as the true-Auto fallback in `get-reply-directives.ts` for primary keys `/^agent:[^:]+:(?:main|tinker)(?::|$)/`; also broadened the agent-command gate from `endsWith(":main")` to the same allowlist. VERIFIED: Tinker Auto now SCALES — 30-char prompt→`low`(4000), 2251-char→`high`(16000); `:tinker:` ledger rows grow. **There are two effort-resolution paths — a per-turn lever must touch the one the surface uses.**
- **EEG honest redesign — SUPERSEDES the `forced`/dashed + halo of §5.84(D) and the Precedence para above.** Owner steer 2026-06-18: _"everything is what happens; nothing should be forced."_ Removed the `forced` field, the dashed forced-strand styling, AND the transparent "measured-reality halo." The strand now sits at the **EXECUTED** effort level (gateway-echoed `thinkLevel`); thickness=model for main + subagents. Supervision is now _requested(slider) vs executed(line)_, and the directive fixes make them match. (Earlier text "slider-pin → dashed (forced)" / §5.84(D) halo are obsolete.)

**The burn-down allocator (DESIGN — owner steer 2026-06-18).** _"If I ask a thinking level in the prompt it's a MUST. Near reset, think of our fastest-ever consumption rate, see the 5h window, project whether we can still consume all our tokens. Arriving at reset with half our tokens unused = we were too cautious = the WORST outcome; a few-hours outage is fine. Effort through the roof every Thursday, maybe Wednesday. Consume more, adapt better."_ This realizes §5.84's already-stated intent (surplus-scaled, "abundant headroom near a reset → reaches Max") whose implementation read dead stores. Aligns with FOUNDATION Budget doctrine (§5.84 Safety para: "surplus-spend before a reset is welcome").

- **Live signal revival.** The token panel (`extensions/tinkerclaw-budget-panel`) already fetches live Anthropic usage (`GET /api/oauth/usage`): `five_hour.{utilization, resets_at}` + `seven_day.{utilization, resets_at}` (percent 0–100 + ISO). Publish each fetch into the in-process sync bridge `src/infra/usage-snapshot-store.ts` (extend `UsageSnapshot` with `fiveHourResetAt`/`sevenDayResetAt`) and add a ~10-min background poller in the panel's `register()` so the signal stays fresh with no UI open. `deriveQuotaPressure` (`effort-allocator.ts:53-71`) reads `getUsageSnapshot()` synchronously, replacing the two dead reads (`getRateLimitSnapshot`/`getCachedUsage`).
- **Policy (decided with owner 2026-06-18).** Per true-Auto turn: **pace** = `seven_day.utilization%` vs % of the week elapsed (week = 7d ending at `seven_day.resets_at`); **urgency** rises CONVEXLY as `resets_at` nears (chill Sun–Tue, through-the-roof Wed/Thu — driven by the LIVE reset time, robust to the actual day/tz, NOT a hardcoded weekday); **headroom** = `1 − seven_day.utilization`. Effort ramps to **Max** when late AND headroom remains; asymmetrically biased aggressive (under-consume is the sin). **Burn through the 5h cap** — do NOT ease off near the `five_hour` limit; a throttle/outage is acceptable, under-consuming is not. **Feasibility ("fastest rate"):** the 5h cap is the natural max-rate ceiling; if even Max can't catch the cap, go Max (salvage). v1 needs no history; ALSO append `five_hour.utilization`/`seven_day.utilization` to each effort-ledger row so a v2 can derive the true fastest sustained rate.
- **Explicit `/think` is law (unchanged, reinforced):** an explicit level short-circuits the allocator (`directives.thinkLevel` wins the `??` chain); the allocator fills only the Auto vacuum.
- **Skill doctrine:** update `model-effort-gating` to encode the consume-more philosophy — under-consumption is the failure mode; burn aggressively as reset nears; explicit requests are absolute.
- **Where facts land (per §5.84 rule):** decision/intent here; structural facts → `effort-allocator.ts` (policy) + `usage-snapshot-store.ts` (bridge) + the budget-panel poller. No hard classifier (FOUNDATION #2) — a live-signal-driven lever, not a fixed threshold.
- **Deploy gate:** backend → snapshot dist → `pnpm build` → idle-safe restart → verify a true-Auto Tinker turn's ledger `pressure` is no longer pinned at `−0.5` and the chosen level rises as `seven_day.resets_at` nears with headroom.

### 5.85 Bible-currency gate for BROCA tasks (DECISION, 2026-06-19)

Any BROCA task that changes tinkerclaw must auto-keep the bible current. Mechanism: DOCTRINE (`orchestration-disposition.md` + `model-effort-gating` skill) + the `bible-currency-gate` recipe as a mandatory completion step. The EDIT is judgment-based (single-owner discipline + `pnpm bible:invariants`), NOT a mechanical auto-writer (the bible is gated + curated; an auto-dump would corrupt it). Scope: tinkerclaw-changing tasks only (read-only/marketing/research exempt). Level: orchestrator, once. Structural owner: `subagents-and-recipes.md` §"Bible-currency gate". Don't-regress: do not downgrade to a soft reminder or an auto-writer.

---

## 6. Backend Fork Patches That Feed Tinker

These are upstream files modified to support Tinker features. They require re-application after every merge.

| File                               | Patch                                                                                | Auto-applied                                                                                                                                                                   | Guardian Check                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `server-chat.ts`                   | Enrich lifecycle with `model`/`modelProvider`                                        | Yes (`apply-fork-wiring.mjs`)                                                                                                                                                  | `resolveSessionModelRef`                                  |
| `run.ts`                           | 6x `emitAgentEvent` for `fallback-profile-error`                                     | Yes                                                                                                                                                                            | `fallback-profile-error`                                  |
| `model-fallback.ts`                | `onError` callback for provider-level cooldown skips                                 | Yes                                                                                                                                                                            | `onError`                                                 |
| `followup-runner.ts`               | `failedProfileId` extraction + `onError` for `fallback-error`                        | Yes                                                                                                                                                                            | `failedProfileId`                                         |
| `agent-runner-execution.ts`        | Same as followup-runner                                                              | Yes                                                                                                                                                                            | `failedProfileId`                                         |
| `attempt.ts`                       | Pass `authProfileId` through lifecycle events                                        | Yes                                                                                                                                                                            | `authProfileId`                                           |
| `sessions.ts`                      | "Allow webchat delete" bypass                                                        | Yes (`patchSessions()`)                                                                                                                                                        | `Allow webchat delete`                                    |
| `tsdown.config.ts`                 | `external: ["better-sqlite3", "bindings"]` on all 8 entries                          | Yes (`patchTsdownConfig()`)                                                                                                                                                    | `external`                                                |
| `get-reply-run.ts`                 | `import { getSessionResetPrompt }`                                                   | Yes                                                                                                                                                                            | `session-reset-prompt`                                    |
| `config-state.ts`                  | `"tinker"` in `BUNDLED_ENABLED_BY_DEFAULT`                                           | Manual                                                                                                                                                                         | `tinker` in config-state                                  |
| `extensions/tinker/index.ts`       | `/tinker/api/file-read` endpoint                                                     | Fork-only (no merge risk)                                                                                                                                                      | —                                                         |
| `extensions/budget-panel/index.ts` | `writeCredentialFile` + `resolveCredentialFilePath` (generic)                        | Fork-only (no merge risk)                                                                                                                                                      | `writeCredentialFile`                                     |
| `credential-file.ts`               | Generic credential file I/O + Anthropic OAuth refresh                                | Fork-only (no merge risk)                                                                                                                                                      | `resolveCredentialFilePath`, `refreshAnthropicOAuthToken` |
| ~~`proactive-refresh.ts`~~         | ~~Proactive OAuth refresh~~ REMOVED (2026-04-06) — upstream native `claude-cli` auth | —                                                                                                                                                                              | —                                                         |
| `get-reply.ts`                     | `clearSessionResume` moved after `runPreparedReply`                                  | Manual                                                                                                                                                                         | `clearSessionResume` after `runPreparedReply`             |
| `server-startup.ts`                | Session resume via `agentCommand` (not heartbeat)                                    | Manual                                                                                                                                                                         | `agentCommand` in server-startup                          |
| `context-anatomy-db.ts`            | SQLite persistence for timeline (replaces JSONL)                                     | Fork-only (no merge risk)                                                                                                                                                      | `anatomy-timeline.db`                                     |
| `context-anatomy.ts`               | Extended `ContextAnatomyEvent` type + JSONL functions removed                        | Yes (type may need re-extension)                                                                                                                                               | `responseThinkingTokens`                                  |
| `attempt-hooks.ts` → `attempt.ts`  | `onTurnComplete` call site in `attempt.ts` (post-`llm_output` hook, fire-and-forget) | **No** — must be manually re-wired after every upstream merge of `attempt.ts` (last lost 2026-04-15, restored 2026-04-20). Guardian must check `_forkOnTurnComplete` presence. | `_forkOnTurnComplete` in attempt.ts                       |
| `embedded-agent-subscribe.ts`      | `responseBreakdown` char counters                                                    | Yes (state may revert)                                                                                                                                                         | `responseBreakdown`                                       |

---

## 8. Design Principles

1. **Zero upstream overlap.** All UI lives in `tinker-ui/`. Never patch `ui/`. If a feature needs a gateway change, it gets a wiring function in `apply-fork-wiring.mjs` and a guardian check.

2. **Operator-first.** Tinker is for the operator, not end users. Show everything: tool calls, fallback chains, token costs, context anatomy, agent topology. Hide nothing.

3. **Pub-sub, zero polling (where possible).** Use lifecycle events from WebSocket, not timers. Health poll (60s) is the exception — only used for error badge recovery.

4. **Degrade gracefully.** If no active runs, show empty state in prefrontal panel. If forensic mode isn't available, hide the toggle. If anatomy API returns empty, show "No data" instead of crashing.

5. **Persist what matters.** Error messages to localStorage (survive refresh). Active runs to sessionStorage (survive navigation). Draft to localStorage (survive everything).

6. **Provider-colored everything.** Model glow, timeline bars, thinking dots, treemap segments — all use the provider color palette consistently.

7. **No framework, no abstraction.** Vanilla DOM manipulation. One file for the app (`app.ts`). Each panel is one file. This isn't scalable engineering — it's a power tool for one operator.

---

## 9. Post-Merge Verification Checklist

After any upstream merge, verify:

```bash
# Guardian checks (automated)
grep "fallback-profile-error" src/agents/embedded-agent-runner/run.ts  # 6 matches
grep "agent-events" src/agents/embedded-agent-runner/run.ts
grep "failedProfileId" src/auto-reply/reply/followup-runner.ts
grep "onError" src/auto-reply/reply/agent-runner-execution.ts
grep "authProfileId" src/agents/embedded-agent-runner/attempt.ts
grep "session-reset-prompt" src/auto-reply/reply/get-reply-run.ts
grep "Allow webchat delete" src/gateway/server-methods/sessions.ts
grep "external" tsdown.config.ts  # 8+ matches
grep "tinker" src/plugins/config-state.ts
grep "onlyBuiltDependencies" package.json  # better-sqlite3, opusscript, @discordjs/opus
grep "resolveApiKeyForProfile" extensions/budget-panel/index.ts
grep "ensureAuthProfileStore" extensions/budget-panel/index.ts
grep "getModelUsage" tinker-ui/src/app.ts
grep "claudeProfiles" tinker-ui/src/app.ts
grep "OPENCLAW_BUNDLED_PLUGINS_DIR" ~/.config/systemd/user/openclaw-gateway.service  # must point to extensions/

# Workspace shadow check — no workspace extension should duplicate a bundled one
comm -12 <(ls extensions/ | sort) <(ls ~/.openclaw/workspace/extensions/ 2>/dev/null | sort) | head -5
# If output is non-empty, stale workspace copies are shadowing bundled extensions — remove them

# Build check
cd tinker-ui && pnpm build
grep -r '__filename' ../dist/ --include='*.js' | grep -v node_modules  # should be empty

# Manual smoke test
# 1. Gateway starts without crash
# 2. /tinker/ loads in browser
# 3. Send a message — get a response
# 4. Model glow appears during response (only active model row, not all)
# 5. Fallback errors show per-model, NOT per-provider
# 6. Prefrontal panel hidden when no subagents active
# 7. Prefrontal tree appears when subagents spawn (correct provider logos)
# 8. curl http://localhost:18789/api/prefrontal/tree returns JSON
# 6. Error badges clear when provider recovers
# 7. Prefrontal pills show active runs with breathing glow
# 8. Context timeline populates after response
```

---

## 10. File Quick Reference

| File                                           | Lines | Purpose                                                             |
| ---------------------------------------------- | ----- | ------------------------------------------------------------------- |
| `tinker-ui/src/app.ts`                         | ~2300 | Entire frontend app                                                 |
| `tinker-ui/src/styles/base.css`                | ~450  | All styles (earth theme + textures)                                 |
| `tinker-ui/public/favicon.png`                 | —     | Tab favicon (TheTinkerZone icon_rounded, B&W, transparent bg)       |
| `tinker-ui/public/icon.png`                    | —     | Topbar logo (wood-textured "The Tinker Zone" sign) — DO NOT replace |
| `tinker-ui/src/panels/context-timeline.ts`     | ~780  | Bottom bar token chart (round-level)                                |
| `tinker-ui/src/panels/context-treemap.ts`      | 1038  | Token composition treemap                                           |
| `tinker-ui/src/panels/response-treemap.ts`     | 703   | Output token treemap                                                |
| `tinker-ui/src/panels/prefrontal-graph.ts`     | 128   | Legacy pill visualization (retained)                                |
| `tinker-ui/src/panels/prefrontal-tree.ts`      | ~250  | Compact call tree (replaced pills)                                  |
| `tinker-ui/src/panels/provider-logos.ts`       | ~60   | Provider SVG logos + color maps (Anthropic, Google, OpenAI, Ollama) |
| `extensions/prefrontal/index.ts`               | ~250  | Prefrontal extension (monitor, HTTP API, lifecycle hooks, recovery) |
| `extensions/prefrontal/prefrontal-types.ts`    | ~75   | Shared types (PrefrontalTreeNode, PrefrontalConfig, etc.)           |
| `extensions/prefrontal/prefrontal-monitor.ts`  | ~120  | Tree builder, stall detection, progress tracking                    |
| `extensions/prefrontal/prefrontal-http.ts`     | ~45   | GET /api/prefrontal/tree endpoint                                   |
| `extensions/prefrontal/prefrontal-recovery.ts` | ~45   | Crash recovery state writer/reader for guardian                     |
| `extensions/prefrontal/prefrontal-prompt.md`   | ~85   | Opus orchestrator system prompt (methodology rules, effort routing) |
| `extensions/tinker/index.ts`                   | ~140  | Gateway plugin (serves UI + file-read API)                          |
| `extensions/tinker/openclaw.plugin.json`       | ~15   | Plugin manifest                                                     |
| `extensions/hippocampus/index.ts`              | ~22   | Plugin stub (registers ID; code in src/memory/engram/)              |
| `extensions/hippocampus/openclaw.plugin.json`  | ~11   | Plugin manifest                                                     |

---

## 11. Fork Backend Systems (Non-UI)

These are fork-exclusive backend systems that run server-side. They are not part of the Tinker UI but represent significant divergence from upstream and are visible through Tinker's treemap (prompt composition), timeline (token usage), and model panel (provider selection).

### 11.1 WhatsApp whatsmeow Backend (2026-03-26)

- **Status:** `DEPLOYED` (opt-in via env var)
- **What:** Alternative WhatsApp backend using `whatsmeow-node` (Go-based, more reliable than Baileys for multi-device). Env var `OPENCLAW_WHATSAPP_BACKEND=whatsmeow` activates it; default remains `baileys` (zero behavior change).
- **Architecture:**
  - `baileys-adapter-wm.ts` — wraps whatsmeow-node client to expose the Baileys socket interface (`sendMessage`, `sendPresenceUpdate`, `readMessages`, `groupMetadata`, `ev` events) so the existing 400+ line `monitor.ts` pipeline works without rewrite
  - `monitor-wm.ts` — creates whatsmeow client + adapter, passes to `monitorWebInbox`
  - `backend-selector.ts` — reads `OPENCLAW_WHATSAPP_BACKEND` env var, exports `getWhatsappBackend()`
  - `monitor.ts` — wired with static imports (dynamic imports were tree-shaken by tsdown bundler — 3 fix iterations)
  - `channel.ts` — `loginWithQrStart`/`loginWithQrWait` route to whatsmeow versions when backend=whatsmeow
  - `auth-store.ts` — `webAuthExists` checks `whatsmeow.db` (>8KB) instead of `creds.json` when backend=whatsmeow
- **Login flow fixes:** Timeout increased to 180s for QR scan + pairing + 515 restart cycle. `defaultRuntime` dependency removed (undefined in dynamic import context). `force=true` only on first Relink call, not refresh polls (prevented active login from being killed).
- **History backfill:** Per-chat backfill using each chat's own last message as anchor (not global latest). Uses `sendPeerMessage` (peer=true). No artificial limits — backfills ALL stale chats (DMs + groups) where last message >24h old, excluding `status@broadcast`.
- **Files:** `extensions/whatsapp/src/baileys-adapter-wm.ts`, `monitor-wm.ts`, `backend-selector.ts`, `auth-store.ts`, `channel.ts`, `inbound/monitor.ts`, `login-qr-wm.ts`, `session-wm.ts`; `src/whatsapp-history/live-capture-wm.ts`

### 11.2 AMYGDALA — Personality Thermostat (2026-03-23)

- **Status:** `PHASE 1 (Shadow) DEPLOYED` — text-based nudge injection only. No neural networks trained or deployed yet.
- **What:** Personality steering system that injects context-aware nudges into the system prompt to adjust the agent's behavioral traits toward a target personality vector. Phase 1 of the AMYGDALA architecture described in the [Learned Intuition paper](docs/papers/learned-intuition/learned-intuition.md).
- **Paper vs Reality:** The paper describes a 10-neural-network ensemble (5 Prudence for safety gating + 5 Personality for behavioral modulation) with PPO training, conformal prediction, ONNX inference, and a 4-phase trust ramp. **Current implementation is Phase 1 (Shadow) only** — a 15-dimension personality target vector with text-based nudge templates. No neural networks, no Prudence gating, no conformal prediction. The Prudence family (action gating, stop/allow/escalate) is entirely unimplemented.
- **Deployed components:**
  - **Target vector (15 dimensions):** 8 core personality dimensions + 5 curiosity attractors + 2 fractal depth parameters. Hand-crafted initial values (PPO calibration planned for Phase 2).
  - **Personality decoder:** Compares current embedding vs target, produces natural language nudges.
  - **Nudge pipeline:** Wired into system prompt via `buildSystemPrompt()`. Nudges are context-aware templates.
  - **Humor-aware templates:** Reference the [Humor Embeddings paper](docs/papers/humor-embeddings/humor-embeddings.md) for bridge discovery patterns.
  - **Curiosity decomposition:** 5 genuine interest attractors (supersedes the [Curiosity Motivation paper](docs/papers/curiosity-motivation/curiosity-motivation.md)'s CCA architecture, which is NOT implemented).
  - **Fractal reflection:** 4-level metacognition in `attempt-hooks.ts` (`maybeTriggerFractalReflection`, lines 527-711). Fires on success, not just failure. FRACTAL_PROMPT template with 4 levels: (1) specific event, (2) pattern it belongs to, (3) system/architecture producing the pattern, (4) worldview assumptions. Original system-event approach disabled (race conditions with user messages) — now inline: model appends `🌿 FRACTAL Level X:` tags to its own response. Includes ripple scan for cross-domain effects. Note: the [Fractal Reasoning paper](docs/papers/fractal-reasoning/fractal-reasoning.md)'s FMI data structures (Hilbert-curve index, IFS compression, Be-tree) are NOT implemented — they remain a theoretical research agenda. The metacognition formalism (R_1, R_2, R_3 reasoning scales) IS deployed via the prompt-level implementation.
  - **Visible influence tags:** `***AMYGDALA***` and `***FRACTAL***` in system messages (see §5.43).
  - **Shadow logging:** All decisions logged for observability.
- **Not yet implemented:** neural network training (PPO), Catastrophic Failure Database, trust ramp Phases 2-4.
- **Implemented since this section was written (corrected 2026-08-02):** the Prudence family (five `prudence-*.onnx` + five `personality-*.onnx` are on disk, 0.9–1.6 MB each), ONNX inference (`mode=onnx` since commit `168810a703a`, 2026-05-30 — the earlier "backend not found" was the C++ long EP name `CPUExecutionProvider`; onnxruntime-node needs the short `cpu`), and conformal prediction (`conformalPredict` + `DEFAULT_CONFORMAL_QUANTILE = 0.5`, with a dedicated de-saturation regression test).
- **Files:** `extensions/tinkerclaw-learned-intuition/` (source, tests, `export_encoder.py`), plus `attempt-hooks.ts` (fractal reflection hook) wired in `attempt.ts`.
- **⚠️ Known broken, do not read the panel as proof of life (2026-08-02).** The subsystem RUNS and DOES NOTHING. All 268 `persona-nudge` rows in `~/.openclaw/data/algorithm-metrics.jsonl` are byte-identical — `{"adjustments":5,"strength":0.5}` — because the record's own provenance says `"config":{"embeddingSource":"neutral-stub"}`: the 90.9 MB `encoder.onnx` is present and unused. Separately the nudge is **written** every turn (`extensions/tinkerclaw-learned-intuition/index.ts:550`, `outcome:"written"`) and **never injected** — its paired instrument `amygdala:nudge-injection` (declared `src/agents/system-prompt.ts:56`, fired `:78`) has NEVER fired. Write half live, read half dead; the Amygdala panel reads the write half, which is why it looks healthy. Observed effect: no jokes, no speaking style, no butler behaviour.
- **The `src/amygdala/` twin was DELETED 2026-08-02.** It had zero production importers and had been frozen since 2026-03-23 while the extension took four fixes it never received. Its only live reference was four `expect(mod).toBeDefined()` assertions in `src/fork/__tests__/fork-integrity.test.ts` — existence checks that made a dead subtree read as tested. Its genuine assets (five test suites, 1,620 lines, and `export_encoder.py`, the only generator of the runtime `.onnx` artefacts) were moved into the extension first. See `jarvis-icu/docs/notes/2026-08-02-bible-overhaul-plan.md`.

### 11.3 ENGRAM — Memory & Retrieval System (2026-02 → 2026-03)

- **Status:** `DEPLOYED` (progressive rollout across 30+ commits)
- **What:** Fork-exclusive memory infrastructure replacing upstream's basic session history with a multi-phase cognitive memory system. Visible in Tinker UI treemap as retrieval pack tokens injected into the system prompt.
- **Phases:**
  - **Phase 0+1A:** Metrics collection, event store (per-turn ingestion), artifact store, test harness
  - **Phase 1B-1D:** Pointer compaction (reduces repeated context), push pack (proactive recall), recall tool (agent-initiated retrieval), contradiction gate (pre-action state conflict detection)
  - **Phase 2:** Async embedding worker + vector search. **NOW WIRED (2026-03-27)** via ollama `mxbai-embed-large` (1024-dim). Retrieval runtime uses hybrid FTS + vector search. Background `EmbeddingWorker` (batch=16, 10s timeout) auto-embeds new events on `eventStore.append()`. Embedding cache persists vectors as `.vec` files in `~/.openclaw/engram/embeddings/`. Vector search merges with FTS results (deduplicated by event ID, vector failure is non-fatal).
  - **Phase 3:** Sleep consolidation — cron-driven episode detection, overnight memory reorganization
- **Retrieval runtime** (`retrieval-runtime.ts`): Fully operational per-turn retrieval pipeline:
  - Daily log hot cache from `~/.openclaw/workspace/` (counts against token budget)
  - Contradiction gate — detects write-intent queries and checks for state conflicts
  - Entity-aware multi-query retrieval via `extractEntities()` + `globalFtsMultiSearch()`
  - Recency boost (exponential decay, ~1 day half-life)
  - MMR re-ranking (λ=0.7) for relevance/diversity balance
  - Token-budgeted packing into system prompt
- **Global FTS5 index:** Replaced per-session JSONL search with SQLite FTS5 full-text index
- **Entity extraction:** Daily log cache, multilingual entity recognition, single DB connection pooling
- **Extension:** `extensions/hippocampus/` — plugin stub that registers the hippocampus ID; actual code lives in `src/memory/engram/`
- **Files:** `src/memory/engram/`, `src/agents/pi-extensions/retrieval-runtime.ts`, `extensions/hippocampus/`, `src/fork/hooks/` (hippocampus-hook), wired in `attempt.ts`

### 11.4 CORTEX / LIMBIC / SYNAPSE — Cognitive Subsystems (2026-02 → 2026-03)

- **Status:** `DEPLOYED`
- **What:** Three fork-exclusive cognitive modules that enhance the agent's behavioral layer. All inject into the system prompt pipeline.
- **CORTEX (Identity Persistence):** [Paper](docs/papers/identity-persistence/identity-persistence.md) — 4,974 LOC, 368 tests, 100% pass
  - `PersonaState` loaded from `SOUL.md` / `VOICE.md`, injected as priority context
  - SyncScore automation with EWMA drift detection (measured SyncScore 0.977 in production)
  - Behavioral probes, consistency metric, convergence monitor
  - Mid-context re-injection and observational memory
  - E_phi persona feature space (8 linguistic features + 128 dense embedding = 136-dim)
  - **Paper claims validated:** drift recovery 0.027→0.980, 442× separation, human eval alpha=0.81
  - Files: `src/memory/cortex/` (`persona-state.ts`, `drift-detection.ts`, `behavioral-probes.ts`, `priority-injection.ts`, `consistency-metric.ts`, `convergence-monitor.ts`, `voice-markers.ts`)
- **LIMBIC (Humor Pipeline):** [Paper](docs/papers/humor-embeddings/humor-embeddings.md) — 1,348 LOC core + 700 LOC runtime, fully implemented Phase 6
  - **h_v2 scoring:** `humorPotentialV2(A, B, bridge, index)` = distance × validity × surprise. Configurable thresholds: δ*min=0.6, δ_max=0.95, τ_v=0.15, τ*σ=0.3
  - **Bridge discovery cascade** — 5 methods in priority: (1) midpoint search, (2) analogy via vector arithmetic, (3) orthogonal blending, (4) graph traversal (placeholder for ConceptNet), (5) LLM-guided generate-then-score (fallback when quality < q_min)
  - **12-pattern taxonomy** in 4 meta-categories: Semantic (antonymic inversion, hyperbolic extension, reductio), Pragmatic (expectation subversion, register shift, overload), Structural (domain transfer, similarity-in-dissimilarity, frame collision), Temporal (callback, escalation, bathos). All 12 fully implemented with vector math scoring.
  - **Sensitivity gate:** 13 hard-block categories (death, grief, suicide, child_abuse, etc.). Audience modeling with familiarity function. Calibration from PersonaState (humorFrequency, sensitivityThreshold, preferredPatterns).
  - **Humor associations:** Persistent memory with staleness model (λ=0.3/use, μ=0.001/hour), callback bonus with 3-month onset decay, running gag detection.
  - **Runtime:** Session-scoped `LimbicRuntime` + `HumorTrigger` with rate limiting (1 attempt per 10 turns). Positive reaction detection (emoji/laugh patterns). All attempts/reactions logged to ENGRAM event store.
  - **Embeddings (2026-03-27):** Switched from deterministic FNV-1a hash to ollama `mxbai-embed-large` (1024-dim semantic vectors). Bridge discovery now finds genuinely meaningful conceptual connections. Provider hot-swapped on startup via `extensions.ts` — starts with FNV-1a fallback, upgrades once ollama resolves.
  - **Validation gap:** h_v1 falsified in pilot (n=15). h_v2 proposed but full validation protocol (N≥64 raters) has NOT been executed.
  - Files: `src/memory/limbic/` (8 files), `src/agents/pi-extensions/limbic-runtime.ts`, `humor-trigger.ts`. Tests: 3 test files + benchmarks.
- **SYNAPSE (Multi-Model Debate):** [Paper](docs/papers/round-table/round-table.md) — reported 63.6% on GPQA Diamond (single run)
  - CDI (Cognitive Diversity Index), RAAC 5-phase protocol (Propose/Challenge/Defend/Synthesize/Ratify)
  - 5 parallelism patterns (Fan-Out, Moderated Tribunal, Full RT, Tournament, Editorial Swarm)
  - Persistent deliberation with 3 artifact tiers
  - Exposed as agent tool for on-demand use
  - **Note:** GPQA Diamond result from single run — needs multi-run confidence intervals.
  - Files: `src/memory/synapse/` (`cognitive-diversity.ts`, `raac-protocol.ts`, `debate-architectures.ts`, `persistent-deliberation.ts`)

### 11.5 Research Papers — Implementation Status

11 papers in `docs/papers/`. Status of each relative to deployed code:

| Paper                        | System      | Status        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ----------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fractal Reasoning            | AMYGDALA    | `DEPLOYED`    | Metacognition deployed: 4-level FRACTAL_PROMPT in `attempt-hooks.ts`, inline depth climbing (🌿 tags). FMI data structures (Hilbert-curve, IFS, Be-tree) remain theoretical — paper is research agenda                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Humor Embeddings             | LIMBIC      | `DEPLOYED`    | 1,348 LOC core + 700 LOC runtime. h_v2 scoring, 5-method bridge discovery, all 12 patterns, sensitivity gate, humor associations with staleness. **Semantic embeddings active** via ollama mxbai-embed-large (2026-03-27). h_v2 unvalidated (needs N≥64 rater study)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Agent Security (AEGIS)       | —           | `DESIGN ONLY` | Conceptual security framework. No AEGIS-specific code — describes OS/network/process-level controls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Learned Intuition (AMYGDALA) | AMYGDALA    | `PHASE 1`     | Text nudge injection deployed (15-dim target vector). 10-network ensemble, PPO training, Prudence gating NOT built                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Total Recall                 | ENGRAM      | `PARTIAL`     | **Corrected 2026-07-29 — was `DEPLOYED` "best-implemented paper… retrieval packs all match paper claims", which was false.** Event store ✅ and pointer compaction ✅ are live (`engram_pointer_compaction` fired 2026-07-29 07:52: 162 events, 87,846 tokens evicted). **Retrieval does NOT match the paper.** Two parallel implementations exist: `extensions/tinkerclaw-total-recall/` is LIVE (both halves — `before_prompt_build` push + a registered `recall` tool), while `src/memory/engram/` + `injectRetrievalPack` + `retrieval-runtime` is a DEAD duplicate — `injectRetrievalPack` has zero callers and is tree-shaken out of `dist` entirely, which is why the `engram:retrieval-pack-inject` instrument reads NEVER. The live pack is **query**-conditioned, not **task**-conditioned as §3 specifies: `assembleRetrievalPack` calls `createDefaultTaskState(taskId ?? "default")` (`src/retrieval-integration.ts:202`), so the paper's Task State (goals, open loops, `key_events`) is **never built or persisted**. Measured cost over 140 turns of `agent:main:main`: `retrieved_context` had **126 distinct values / 140 turns**, driving 133 distinct system-prompt hashes and ~1 cold `claude-cli` spawn per turn. Partly fixed in `e0ca2c26db0` (pack reused verbatim until the task moves); real Task State is still unbuilt. |
| Sleep Consolidation          | ENGRAM      | `DEPLOYED`    | Documents actual operational behavior (30 days, 14 mutations). Post-hoc formalization of emergent behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Identity Persistence         | CORTEX      | `DEPLOYED`    | Well-implemented. 4,974 LOC, 368 tests. Metrics match paper claims                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Instant Recall               | Hippocampus | `PARTIAL`     | **Corrected 2026-07-29.** Code and tests exist, but the FTS5 index it depends on is **frozen**: `~/.openclaw/engram/engram-fts.db` spans 2026-02-16…2026-03-08, mtime 2026-03-09, and has **no writer anywhere in the repo** (4 call sites, all `SELECT`/`MATCH`, all `readonly: true`). **100% of the 13,758 events currently on disk are absent from it.** It is also **4× duplicated** — 878,948 rows are 219,737 unique ids stored exactly four times, block-strided (verified: 0 mismatches at all three offsets); deduping would reclaim ~659 MB of 879 MB. ⚠️ It is nonetheless the **sole surviving copy** of 3,792 sessions (only 572 have files on disk), so it must be appended to, never rebuilt. Live readers still query it: `retrieval-runtime.ts:21` and `contradiction-gate.ts:16` — so cross-session recall and contradiction checking run against a 4.7-month-old corpus. Backup taken: `engram-fts.db.bak-20260729-preindex` (sha256 `b804373d…`).                                                                                                                                                                                                                                                                                                                                                                               |
| Round Table                  | SYNAPSE     | `DEPLOYED`    | CDI, RAAC protocol, debate architectures implemented. GPQA result needs multi-run validation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Curiosity Motivation         | —           | `DESIGN ONLY` | CCA/LoRA architecture NOT implemented. Curiosity handled via 5 personality attractors in AMYGDALA instead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Corporate Swarm (HIVEMIND)   | —           | `DESIGN ONLY` | Enterprise swarm design paper. No implementation exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### 11.6 WhatsApp Feature Enhancements (2026-02 → 2026-03)

- **Status:** `DEPLOYED`
- **What:** Fork-specific WhatsApp improvements beyond upstream's basic integration.
- **SQLite History Storage:** `better-sqlite3` with FTS5 full-text search for WhatsApp message history. Replaces in-memory storage. Files: `src/whatsapp-history/`
- **Offline Message Recovery:** On reconnect, recovers messages received during the offline window (6h). Messages annotated as `offline-recovered` for review-before-action.
- **Audio Transcription Gate:** Audio messages are transcribed _before_ triggerPrefix check (not blanket bypass). Ensures voice notes go through the same routing as text.
- **Sent Message ID Tracking:** Tracks outbound message IDs to prevent voice note echo re-ingestion (bot hearing its own TTS output).
- **Group Typing Indicators:** `presenceSubscribe` for groups before composing, for both inbound monitor and outbound API.
- **515 Stream Error Auto-Restart:** WhatsApp's 515 disconnect handled with automatic reconnection.
- **senderE164 Resolution:** Resolves sender phone number for `fromMe` group messages where Baileys lacks the `participant` field.
- **Files:** `extensions/whatsapp/src/`, `src/whatsapp-history/`

### 11.6a WhatsApp Trigger & Access Control Rules

→ moved 2026-05-11 to `./wa-triggers.md` (full content preserved verbatim there).

### 11.6b /new briefing injection — full content + clickable path bubble (2026-05-09)

- **Status:** `DEPLOYED` (architect side; pending end-to-end smoke test on host).
- **What:** When the user types `/new` in Tinker UI, the client awaits a new gateway RPC `briefing.resolve` (workspace `BRIEFING.md` → bundled `briefing-default.md` fallback), then builds an imperative prompt with the briefing's full content inlined and sends it as the user message. The user bubble renders as a collapsed `<details>` with summary `⚡ Executing <path>`, where the path is rendered as `<code class="fs-link" data-path="…">` — reuses the existing fs-link delegated click handler at `tinker-ui/src/app.ts:5777` which calls the existing `config.openExternalFile` RPC to open the file via `xdg-open`/`open`/`Start-Process`.
- **Replaces:** the prior soft "Read and follow whichever of these briefing files exists…" suffix that caused Opus 4.7 to acknowledge BRIEFING.md and ask permission instead of executing it. Symptom captured at the 2026-05-09 10:00 turn (33s, 258B reply, zero tool calls). The new wording — "Execute the morning briefing NOW … without asking permission" — forecloses the permission-asking failure mode.
- **Files:**
  - `src/gateway/server-methods/briefing.ts` — `briefing.resolve` handler (READ_SCOPE). Workspace dir resolved via `resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg))` like `skills.ts`. EPERM/EACCES on workspace read falls through to bundled with `console.warn`.
  - `src/gateway/server-methods.ts` + `src/gateway/method-scopes.ts` — `briefing.resolve` registration + READ_SCOPE entry.
  - `tinker-ui/src/app.ts:buildBriefingPrompt` (new helper), `buildInjectedPrompt` (now async), `renderUserBubbleWithPromptToggle` (new `_briefingPath` branch — emits `<code class="fs-link">`).
  - `tinker-ui/src/styles/base.css` — `.briefing-toggle` + `.briefing-summary` rules. Path link uses existing `.fs-link` styles.
- **Reuses (not new):** `config.openExternalFile` RPC + the global `.fs-link` delegated click handler. Don't add new file-open RPCs — this pattern already exists.
- **Fallback:** every failure mode degrades to the soft-suffix behavior. RPC error → soft suffix. Bundled file missing → soft suffix. Workspace file unreadable → bundled, then soft suffix.
- **Spec:** `docs/superpowers/specs/2026-05-09-new-briefing-injection-design.md` (in jarvis-icu).
- **Plan:** `docs/superpowers/plans/2026-05-09-new-briefing-injection.md` (in jarvis-icu).
- **Commits on develop:** `f6f178569a` → `94b08712a4` → `c3ef3f99b1` → `e66cacea9e` → `4155fa7328` → `87064e9b95` → `fef8174aaf` (cleanup: dropped redundant `files.openInEditor` RPC after discovering `config.openExternalFile` already handled this).
- **Lesson:** before adding ANY new file-open / shell-out RPC, search for existing patterns first — `grep -rn 'xdg-open\|openExternalFile\|fs-link'` would have surfaced the existing handler. The `files.openInEditor` RPC sat live for ~30 minutes before the user caught the duplication.
- **Don't regress:** the imperative wording sentinel `"Execute the morning briefing NOW"` is dual-purpose — it tells the model what to do AND lets the call site detect a briefing injection (regex-match for `_briefingPath` extraction). Changing the wording requires updating both `buildBriefingPrompt` and the detection regex in the `send` call site.

### 11.6c Restart-survival visible orange chip + tinker-bridge context preservation (2026-05-10)

- **Status:** `DEPLOYED + verified end-to-end with marker quote-back proof`. Three intertwined features (restart chip, always-resume, tinker-bridge sessionId fallback) plus a separate bare-filename resolver, all proven via journal trace + persisted transcript + Tinker UI snapshot + Jarvis quoting a unique marker after restart.
- **What (#1, restart chip):** Whenever a `status:"running"` main session is detected at gateway boot, the recovery code pushes a visible `__ERR_ENV__:` envelope (orange `envelope-recoverable`, icon 🔄) into that session's transcript via `chat.inject` BEFORE the `[System] continue` resume dispatch. Single uniform wording: `Gateway restarted at HH:MM — picking up where I stopped`. We never tell the user to retry — the session always attempts resume.
- **What (#1b, always-resume):** The original `resolveMainSessionResumeBlockReason` tail-check is now informational only. We always dispatch `[System] continue from existing transcript` regardless of tail content. tinker-bridge sessions whose agent transcript is empty (subprocess hasn't flushed yet) get the same resume treatment as native sessions; the tinker-bridge worker pool then handles `--resume` lookup itself.
- **What (#1c, openclaw sessionId fallback in tinker-bridge):** tinker-bridge's session-map is now indexed by openclaw agent sessionId in addition to the hash-derived `tinker-sp-<hex>` sessionKey. The worker-pool prefers the openclaw-sessionId lookup when available, since the openclaw sessionId is canonical (one openclaw session = one conversation thread, /new mints a new sessionId). This sidesteps the tinker-bridge sessionKey hash drift that happens when the `[System] continue` dispatch shifts the systemPrompt prefix.
- **What (#2, bare-filename resolver):** New gateway RPC `files.resolveBareName({name})` walks an allowlist of project roots (workspace → ~/src/tinkerclaw → ~/src/jarvis-icu → ~/.openclaw) and returns absolute path matches. The Tinker UI `md()` post-processor wraps inline `<code>FOO.md</code>` in `<code class="fs-link fs-link-bare" data-name="FOO.md">`; the click handler resolves the bare name on first click via the RPC, caches it on the element + in a session-scope `Map<string,string|null>`, then opens via the existing `config.openExternalFile` RPC. No user input needed; LLM disambiguation slot is wired but currently picks first match (root-walk order). All new resolutions skip `node_modules`, `.git`, `dist`, `build`, etc.
- **Files:**
  - `src/agents/main-session-restart-recovery.ts` — extracted `pushRestartWarningEnvelope()` helper; tail-check guard removed (always attempt resume); single chip-wording variant.
  - `extensions/tinkerclaw-tinker-bridge/src/session-map.ts` — `MapEntry.openclawSessionId` field; new `getLatestResumeSessionIdByOpenclawSessionId` helper; `setResumeSessionId` accepts optional openclawSessionId.
  - `extensions/tinkerclaw-tinker-bridge/src/worker-pool.ts` — lookup priority reordered: openclaw-sessionId first, sessionKey fallback.
  - `extensions/tinkerclaw-tinker-bridge/src/worker.ts` — `WorkerSpawnParams.openclawSessionId` field; passed to `setResumeSessionId` on the system_init event.
  - `extensions/tinkerclaw-tinker-bridge/src/stream.ts` — threads `openclawSessionId` (already smuggled via `__openclawSessionId`) into the worker spawn params.
  - `src/gateway/server-methods/files-resolve-bare.ts` (new) — `files.resolveBareName` RPC.
  - `src/gateway/server-methods.ts` + `src/gateway/method-scopes.ts` — handler registration + READ_SCOPE entry.
  - `tinker-ui/src/app.ts` — bare-filename `md()` pass + dual-mode click handler.
- **Verification (FINAL proof, 2026-05-10 13:06):**
  1. Dispatched task with unique marker `MARKER-FIBONACCI-1-1-2-3-5-8-PROOF-FINAL`. tinker-bridge began work at 13:06:06 (tinker-sp-771eab65).
  2. After 4 tool reads completed, `openclaw-restart --full` at 13:06:31.
  3. Journal at 13:06:49 → `marked 1 interrupted main session(s)`.
  4. Journal at 13:06:55 → `chat.inject 235ms ✓`. Journal at 13:06:56 → `pushed restart-warning envelope to agent:main:main`.
  5. Journal at 13:06:57 → `resumed interrupted main session: agent:main:main` (recovered=1).
  6. Journal at 13:07:07 → tinker-bridge `turn start sessionKey=tinker-sp-44b1d6f5` (different hash, expected). The fallback found the prior cli session via openclaw-sessionId index.
  7. Journal at 13:07:13 → tinker-bridge result. **Jarvis's reply explicitly quotes the unique marker:** `"…I posted the one-line summary quoting MARKER-FIBONACCI-1-1-2-3-5-8-PROOF-FINAL …"`. Context preserved end-to-end across the gateway restart.
- **Don't regress:**
  - Envelope inject MUST stay BEFORE the agent resume dispatch in `resumeMainSession` (so the chip lands first in the transcript order).
  - In `worker-pool.getOrCreate`, openclaw-sessionId lookup MUST come BEFORE the tinker-bridge sessionKey lookup. Reversing this order brings back the bug where stale entries from prior tests win and Jarvis loses context.
  - `setResumeSessionId` MUST be called with the openclawSessionId on every system_init event. If not, new entries lack the index and the fallback is empty.
  - The bare-filename click handler MUST cache misses (`null` value) so a missing file isn't re-resolved on every click.
  - Bare-filename extension whitelist is a deliberate guard — adding more extensions means more chance of false-positive wraps in unrelated `<code>` blocks.

### 11.6d tinker-bridge idle-watchdog 120s SIGTERM regression — fixed via openclaw.json (2026-05-10)

- **Symptom (matches the 2026-05-05 entry verbatim):** WhatsApp ask "install printingpress.dev" + "read this YouTube" surfaced as `🤖 ⚠️ Something went wrong while processing your request.` Jarvis's prepared reply ("Done. Installed Go 1.26.3 / starter-pack / printing-press") was queued in his cli session but never delivered to WhatsApp. Tinker UI was simultaneously stuck on `sending...` after the user typed `/new`. Journal showed both lanes timing out: `lane=session:agent:main:whatsapp:direct:<owner-e164> durationMs=267533 error="FailoverError: LLM request timed out."` and `lane=session:agent:main:main durationMs=279617`. tinker-bridge worker SIGTERMed at ~138s on each turn, despite the 2026-05-05 fix that bumped `timeoutSeconds` to 600.
- **Root cause (real, this time):** the tinker-bridge plugin's `buildClaudeCodeProviderConfig()` returns `{ timeoutSeconds: 600, ... }` via discovery, but `applyConfiguredProviderOverrides` in `src/agents/embedded-agent-runner/model.ts` reads `providerConfig` from `resolveConfiguredProviderConfig(cfg, "claude-code")` — i.e. `cfg.models.providers["claude-code"]` in `openclaw.json`, NOT the plugin-discovered config. The plugin discovery is consulted for model availability but its provider-level `timeoutSeconds` is silently dropped on the way to model resolution. As a result `model.requestTimeoutMs` was undefined and `resolveLlmIdleTimeoutMs` fell through to `clampImplicitTimeoutMs(agentTimeoutMs)` which `Math.min`s against `DEFAULT_LLM_IDLE_TIMEOUT_MS = 120_000` (`src/config/agent-timeout-defaults.ts`). Hence the watchdog at 120s, not 600s.
- **Fix:** added `"timeoutSeconds": 600` to `~/.openclaw/openclaw.json` under `models.providers["claude-code"]`, alongside `apiKey` / `baseUrl` / `api`. Verified via the new `[idle-timeout-diag]` log line in `attempt.ts` immediately after `resolveLlmIdleTimeoutMs`: post-fix it reports `idleTimeoutMs=600000 model.requestTimeoutMs=600000`, was `idleTimeoutMs=120000 model.requestTimeoutMs=undefined` pre-fix. Restart-recovery code unstuck the live TUI session by injecting the orange chip + dispatching `[System] continue`, which let Jarvis close the turn cleanly.
- **Open architectural follow-up:** plugin-discovered providerConfig values (especially `timeoutSeconds`) should merge into the resolved `cfg.models.providers[provider]` so a plugin's defaults take effect without duplicating them in `openclaw.json`. Today the cfg-side patch is the only path that works; the tinker-bridge catalog's `timeoutSeconds: 600` is dead code as far as the LLM idle watchdog is concerned.
- **Don't regress:**
  - The `timeoutSeconds: 600` entry in `openclaw.json` is load-bearing. If you reset the file or migrate it, port the field forward.
  - The diagnostic log line `[idle-timeout-diag] resolved idleTimeoutMs=…` in `attempt.ts:1862-1880` stays. It is one line per turn and gives instant visibility into regressions of this exact bug. If a future turn shows `model.requestTimeoutMs=undefined` again, the cfg got reset.
  - The 2026-05-05 fix in `extensions/tinkerclaw-tinker-bridge/src/catalog.ts` (`timeoutSeconds: Math.floor(DEFAULT_REQUEST_TIMEOUT_MS / 1000)`) was correct in spirit but incomplete — leave it in place as a belt to the suspenders, but understand the actual surface that takes effect is the openclaw.json one.
- **Secondary bug observed but not yet fixed (TUI stuck on `sending`):** when the TUI tinker-bridge timed out at 16:59:34, the failover error envelope was generated and `sendFinalPayload returned queuedFinal=true routedFinalCount=0` — meaning `routeReplyToOriginating` returned null (one of `shouldRouteToOriginating || routeReplyChannel || routeReplyTo || routeReplyRuntime` is false for webchat surface) and the fallback `dispatcher.sendFinalReply` queued the reply but the webchat WS subscription never picked it up. The Tinker UI client kept its `sending...` thinking-indicator and never received the error chip. The restart-recovery cycle is the only thing that currently unsticks it. Real fix needed in `dispatch-from-config.ts:sendFinalPayload` so the surface_error envelope reaches webchat too.

### 11.6e Plugin provider-config overlay + chat.send broadcast backstop (2026-05-10 evening)

- **Status:** `DEPLOYED + verified end-to-end`. Removes the 2026-05-09 openclaw.json `timeoutSeconds: 600` patch as load-bearing — the value now flows from the tinker-bridge plugin's discovery output through a runtime overlay, so plugin defaults take effect without manual config duplication.
- **What (#1, plugin overlay):** New `src/agents/plugin-provider-config-overlay.ts` exposes `registerPluginProviderConfigOverlay(providerId, partial)` via `src/plugin-sdk/provider-config-overlay.ts`. The tinker-bridge plugin's `register()` hook calls it with `{ timeoutSeconds: Math.floor(DEFAULT_REQUEST_TIMEOUT_MS / 1000) }`. `resolveConfiguredProviderConfig` in `src/agents/embedded-agent-runner/model.ts` now returns `{...overlay, ...explicit}` so explicit `openclaw.json` keys still win on a per-key basis but plugin-supplied defaults fill gaps. Verified: with the explicit `timeoutSeconds: 600` REMOVED from `openclaw.json`, the diagnostic log shows `idleTimeoutMs=600000 model.requestTimeoutMs=600000`. The 2026-05-05 catalog `timeoutSeconds` setting now actually does something at runtime.
- **What (#2, chat.send backstop):** `chat.ts` `.then()` previously emitted `broadcastChatFinal` only when `!agentRunStarted`. When the agent ran but the lifecycle event from `server-chat.ts:emitChatFinal` was dropped (because `isControlUiVisible=false`, or because surface_error timeouts complete the run without throwing and without firing the lifecycle hook), the TUI received NO `state="final"` and the spinner stayed on `sending...` forever. Backstop: in the agent-started branch, also call `broadcastChatFinal` with whatever `deliveredReplies` contains (or empty). Idempotent versus the lifecycle path because `broadcastChatFinal` `.delete()`-s `agentRunSeq[runId]`. The TUI client de-dupes by runId+state.
- **Files:**
  - `src/agents/plugin-provider-config-overlay.ts` (new) — module-level Map + `registerPluginProviderConfigOverlay` / `getPluginProviderConfigOverlay`.
  - `src/plugin-sdk/provider-config-overlay.ts` (new) — public re-export for plugins.
  - `src/agents/embedded-agent-runner/model.ts` — `resolveConfiguredProviderConfig` merges overlay under explicit.
  - `extensions/tinkerclaw-tinker-bridge/index.ts` — calls `registerPluginProviderConfigOverlay(PROVIDER_ID, { timeoutSeconds })` from `register()`.
  - `src/gateway/server-methods/chat.ts` — backstop `broadcastChatFinal` in the `else` branch of `.then()` (agentRunStarted=true path).
  - `~/.openclaw/openclaw.json` — `timeoutSeconds: 600` removed from `models.providers["claude-code"]` since the overlay now supplies it.
- **Don't regress:**
  - When adding plugin-supplied defaults that need to take effect at runtime (timeoutSeconds, baseUrl override, headers), call `registerPluginProviderConfigOverlay` from the plugin's `register()` hook. Putting them only in the `discovery.run` callback is dead code as far as `applyConfiguredProviderOverrides` is concerned.
  - The chat.send backstop must stay in the `else` branch (agentRunStarted=true). Removing it would re-introduce the `sending...` stuck spinner whenever the lifecycle path drops a final event.
  - The diagnostic log line `[idle-timeout-diag]` in `attempt.ts` is the canary for both fixes — if a future turn shows `model.requestTimeoutMs=undefined`, the overlay isn't being populated; if it shows `idleTimeoutMs<600000` despite `requestTimeoutMs=600000`, a per-run `runTimeoutMs` is clamping the watchdog.

### 11.7 Fork Infrastructure (2026-02 → 2026-03)

- **Status:** `DEPLOYED`
- **What:** Merge automation and hook architecture that allows the fork to absorb upstream changes without manual patching.
- **Fork Hook Architecture (`src/fork/`):**
  - `attempt.ts` refactored: 10 inline blocks → 2 hook imports
  - All fork-specific logic extracted to `src/fork/hooks/` for merge independence
  - Marked with `// FORK:` comments throughout codebase for visibility
- **Merge Automation:**
  - `merge-upstream.sh` — automated upstream merge with conflict resolution
  - `apply-fork-wiring.mjs` — 12+ patch functions that re-apply fork hooks after merge (imports + call sites)
  - `merge-guardian.sh` — checks 20+ wiring points, builds, learns from failures
  - `safe-cron-merge.sh` — daily at 04:45 with self-healing retry
  - 13 TIER1 files auto-resolved via `--theirs` + re-wiring
  - Documented in §6 (Backend Fork Patches) and §9 (Post-Merge Checklist)
- **Session Resume on Gateway Restart:**
  - Multi-session resume with liveness watchdog and scope-isolated restart
  - TTL bumped from 60s to 300s
  - System event sent to main session after SIGUSR1 restart
  - Files: `src/fork/session-resume.ts`, wired in `server-startup.ts`
- **~~Proactive OAuth Refresh~~:** REMOVED (2026-04-06) — upstream native `claude-cli` auth handles credential sync from `~/.claude/.credentials.json`. Fork extension `tinkerclaw-proactive-auth` deleted.

### 11.8 Local Embedding Infrastructure — ollama mxbai-embed-large (2026-03-27)

- **Status:** `DEPLOYED`
- **What:** Unified local embedding infrastructure using ollama's `mxbai-embed-large` (1024-dim) for all semantic embedding needs. Replaces remote API calls (Gemini) and deterministic hashes (FNV-1a) with a single high-quality local model. Zero cost, zero latency, zero privacy leakage.
- **Model:** `mxbai-embed-large` via ollama at `http://127.0.0.1:11434/api/embeddings`. 669MB, 1024 dimensions, 512-token context window.
- **Input safety:** Hard truncation at 500 chars in `embeddings-ollama.ts` (512 tokens ≈ 500-2000 chars depending on content density). Known model limits added to `embedding-model-limits.ts` with ollama-specific fallback.
- **Consumers:**

| System                             | Before                              | After                                         | Wiring                                              |
| ---------------------------------- | ----------------------------------- | --------------------------------------------- | --------------------------------------------------- |
| **Memory search** (instant-recall) | Gemini API (remote, paid)           | ollama mxbai-embed-large (local)              | `openclaw.json` `memorySearch.provider: "ollama"`   |
| **LIMBIC humor**                   | FNV-1a hash (128-dim, meaningless)  | ollama mxbai-embed-large (1024-dim, semantic) | `limbic-runtime.ts` `embeddingProvider` option      |
| **ENGRAM retrieval**               | FTS5-only (no vector search)        | Hybrid FTS + vector via ollama                | `retrieval-runtime.ts` `embeddingCache` + `embedFn` |
| **AMYGDALA**                       | ONNX all-MiniLM-L6-v2 (384→512-dim) | Unchanged                                     | Purpose-built emotion space, different use case     |

- **Hot-swap pattern:** `extensions.ts` creates ollama provider asynchronously. All systems start with their fallback (FTS-only, FNV-1a), then hot-swap to semantic once the provider resolves (~100ms). Non-blocking startup.
- **Background embedding:** `EmbeddingWorker` in ENGRAM auto-embeds new events on `eventStore.append()` (batch=16, timeout=10s). Cache persists as `.vec` files in `~/.openclaw/engram/embeddings/`.
- **Memory re-index:** Full re-index completed via `openclaw memory index --force`. All existing memory chunks re-embedded with mxbai vectors.
- **Files:** `src/memory/embeddings-ollama.ts` (truncation), `src/memory/embedding-model-limits.ts` (known limits), `src/agents/embedded-agent-runner/extensions.ts` (wiring), `src/agents/pi-extensions/limbic-runtime.ts` (provider option), `src/agents/pi-extensions/retrieval-runtime.ts` (hybrid search)

### 11.9 Stuck Session Auto-Recovery Watchdog (2026-03-28)

- **Status:** `DEPLOYED`
- **Problem:** Upstream session lane deadlock (#7630) leaves the main session permanently stuck in `processing` state after an LLM call times out or errors without releasing the session. New messages queue behind the zombie task and never execute — Jarvis goes silent until a full gateway restart.
- **Root cause:** `markIdle()` is never called when certain error paths in `dispatchReplyFromConfig` exit before reaching the idle transition. The command queue's `activeTaskIds` retains a stale task ID, blocking the lane's drain pump from starting new work.
- **Fix:** Two-part watchdog in the existing 30s diagnostic heartbeat:
  1. **`resetCommandLane(lane)`** in `command-queue.ts` — targeted single-lane reset: clears `activeTaskIds`, bumps lane `generation` (so stale completions from the zombie task are ignored), re-drains any queued entries. Same logic as `resetAllLanes()` but scoped to one lane.
  2. **Auto-recovery in `diagnostic.ts`** — when a session is stuck in `processing` for >180s (3 minutes), the watchdog calls `resetCommandLane()` for that session's lane, resets diagnostic state to `idle`, and logs `auto-recovered stuck session`. Queued messages drain immediately.
- **Threshold:** 180 seconds (`STUCK_SESSION_RECOVERY_MS`). Gives legitimate long-running LLM calls (tool use, extended thinking) room to complete while preventing the 30-minute deadlocks.
- **Observable:** Log line `[diagnostic] auto-recovered stuck session: sessionKey=... age=...s lane=... laneReset=true` confirms recovery happened.
- **Files:** `src/process/command-queue.ts` (`resetCommandLane`), `src/logging/diagnostic.ts` (watchdog in heartbeat interval)

### 11.10 Cognitive Extensions Modularization (2026-03-30)

- **Status:** `DEPLOYED`
- **What:** Extracted 7 cognitive subsystems from inline fork wiring into standalone OpenClaw extensions, installable on vanilla OpenClaw via ClawHub or manual drop-in.
- **Extensions created:**
  - `tinkerclaw-round-table` (SYNAPSE) — Multi-model debate via RAAC protocol. Registered as `synapse_debate` tool.
  - `tinkerclaw-identity-persistence` (CORTEX) — Persona injection from SOUL.md, EWMA SyncScore drift detection, mid-context reinforcement, observation extraction. Hooks: `before_prompt_build` (priority 100), `llm_output`.
  - `tinkerclaw-fractal-reflection` (FRACTAL) — Post-turn self-reflection with 4-level framework. Hook: `agent_end`. 30s debounce, skips automated sessions.
  - `tinkerclaw-computational-humor` (LIMBIC) — Humor from embedding geometry. Bridge discovery, sensitivity gating, reaction capture. Reads Identity Persistence shared state for persona.humor calibration.
  - `tinkerclaw-total-recall` (ENGRAM) — Episodic memory with FTS + vector retrieval, pointer compaction, sleep consolidation. Hooks: `before_prompt_build` (priority 50), `llm_output`, `before_compaction`. Recall tool + `engram.search` gateway method.
  - `tinkerclaw-learned-intuition` (AMYGDALA) — Neural safety gate with ONNX graceful degradation (falls back to rule-based heuristics). Hook: `before_tool_call`. Writes personality nudge for Identity Persistence.
  - ~~`tinkerclaw-proactive-auth`~~ — REMOVED (2026-04-06): upstream native `claude-cli` auth replaces this.
- **Feature flags:** `fork.cognitive` config section gates each subsystem: `"inline"` (default), `"extension"`, or `"disabled"`. Instant rollback via `rollback-extension.sh <codename>`.
- **Inter-extension communication:** Filesystem convention at `~/.openclaw/cognitive/` — each extension writes a JSON state file, others read it.
- **Source deleted:** `src/memory/synapse/`, `src/memory/cortex/`, `src/memory/limbic/` removed. Upstream copies in `packages/memory-host-sdk/` untouched.
- **Merge conflict surface reduction:** Cognitive files no longer in upstream's source tree. Extensions live in `extensions/tinkerclaw-*/` which upstream never touches.
- **Tests:** 496 tests across 60 test files (scaffold, unit, registration, integration, cross-extension).

### 11.11 Merge Automation Overhaul (2026-03-30)

- **Status:** `DEPLOYED`
- **What:** Fixed the daily merge pipeline from 29% success rate to automated operation with 6-layer conflict resolution.
- **Pipeline fixes:**
  - Tag-based incremental merge (next upstream tag, not HEAD)
  - Untracked file collision pre-scan + auto-track
  - Build-failure rollback (`git reset --hard` to pre-merge HEAD)
  - Death spiral breaker (progressive strategy: 5→20→50→100 conflict threshold based on consecutive failures)
  - Guardian baseline comparison (only escalate NEW issues, not pre-existing drift)
  - Path migration detection (`detect-path-migrations.sh`)
  - Drift alarm (WhatsApp alert after 3+ consecutive failures)
  - Agent timeout increased to 60min with opus model
- **6-layer conflict resolution cascade:** TIER1 merge driver (.gitattributes) → git rerere (168 cached resolutions) → PRESERVE paths (--ours) → wiring script (apply-fork-wiring.mjs) → LLM agent (opus, 60min)
- **FORK_PATCHES.md:** Dynamic patch registry (TIER1/PRESERVE/MANUAL/IGNORE sections). Single source of truth for merge automation paths.
- **Post-build verification:** `scripts/verify-build.sh` checks dist/ artifact completeness. Wired into safe-cron-merge.sh with auto-fix fallback.
- **Files:** `safe-cron-merge.sh`, `merge-upstream.sh`, `merge-guardian.sh`, `detect-path-migrations.sh`, `verify-tinkerclaw-extensions.sh`, `rollback-extension.sh`, `FORK_PATCHES.md`, `.gitattributes`, `scripts/merge-drivers/tier1-driver.sh`

### 11.12 Post-Merge Fixes (2026-03-30/31)

- **Status:** `DEPLOYED`
- **What:** 6 breakages from the 185-commit upstream merge, each fixed:
  1. **`tsdown external` deprecated** — upstream replaced `external` with `deps.neverBundle`; removed fork's `external` field (redundant).
  2. **`runtimeKey` ReferenceError** — upstream added runtime snapshot update code in `saveAuthProfileStore()` referencing undeclared variable. Fix: `const runtimeKey = resolveRuntimeStoreKey(agentDir)`.
  3. **`__BUNDLED_DEV__` undefined** — Vite 8 requires build-time constant. Fix: `define: { __BUNDLED_DEV__: "false" }` in `tinker-ui/vite.config.ts`.
  4. **WebSocket scope clearing** — upstream's device identity model strips scopes from token-authenticated clients. Fix: preserve scopes when `authOk` is true (local trusted operators). **Less safe than upstream** — acceptable for local-only deployment with `dangerouslyDisableDeviceAuth: true`.
  5. **Origin validation** — upstream added `gateway.controlUi.allowedOrigins`. Fix: added `http://localhost:18790` (Vite dev server).
  6. **Exec approval + allowlist** — upstream added exec approval system. Fix: `tools.exec.ask: "off"`, `tools.exec.security: "full"`, `tools.exec.applyPatch.workspaceOnly: false`.
- **Auth re-auth UI:** Restored popover with 3 options: "Reload from disk" (`auth.reload` RPC), "Paste token" (new `auth.applyToken` RPC), "Re-authenticate" (OAuth popup). Files: `tinker-ui/src/app.ts`, `extensions/auth-reload/index.ts`.
- **Overload retry:** Aggressive 529 retry — 10×1s, 5×2s, 5×3-8s (20 attempts, ~45s) before model fallback. Old behavior: immediate fallback after 1 attempt. Each retry emits an `overload-retry` lifecycle event for the UI.
- **Fractal rendering:** Excluded fractal responses from `thinkingSet` classification (prevents real answer from collapsing). Made `🌿 FRACTAL:` prefix mandatory in prompt. Summary extraction from prefix line (not just Level 2 match).
- **Message color hierarchy (2026-03-31):**
  - **User messages (right):** Normal chat input, right-aligned.
  - **Jarvis messages (left):** Agent responses, left-aligned. Fractal reflections collapsed green `<details>`.
  - **Orange centered bubbles (warnings):** Auto-recovering events the user doesn't need to act on. Includes: overload retries (`⏳ Overload retry 3/20 — waiting 1s`), model fallback (`⚠ model failed — jumping to backup`), profile rotation (`↳ model profile — reason`), gateway restart resume (`⚠️ Gateway restarted while processing`). CSS class: `.msg-overload-bubble`.
  - **Red centered bubbles (errors):** Blocking errors requiring user action. Includes: auth expired (needs re-auth via badge click), billing cap hit, all backups exhausted. CSS class: `.msg-error`. Only these should interrupt the user.
  - **Auto-classified warnings:** Agent errors containing "draining for restart", "overloaded", "temporarily unavailable", "HTTP 502/503/529" are auto-classified as orange warnings (not red). CLI hints like "Logs: openclaw logs --follow" are stripped from webchat error messages.
  - **Design rule:** If the system can recover on its own, it's orange. If the user must do something, it's red.

### 11.13 Session Resume System (2026-03-31)

- **Status:** `DEPLOYED` (bug fix)
- **What:** Session resume persists in-flight user messages before gateway restart and re-sends them after boot.
- **How it works:**
  1. `get-reply.ts` writes `session-resume.json` (v2 multi-session format) at the start of every reply
  2. On successful completion, `clearSessionResume(sessionKey)` removes only that session's entry
  3. On gateway boot, `server-startup.ts` reads resume file within 300s TTL and re-sends via `agentCommand`
- **Bug fixed (2026-03-31):** `clearSessionResume()` was ignoring the `sessionKey` parameter and deleting the ENTIRE file. When Session A completed during drain while Session B was still in-flight, Session B's resume was destroyed. Now filters by sessionKey, keeping other sessions' entries intact.
- **SIGUSR1 (graceful restart):** Drain waits 90s for tasks to complete. Completed tasks clear their resume. Only force-killed tasks (drain timeout) leave resume entries for the next boot.
- **SIGTERM (full restart):** No drain — tasks killed immediately. Resume file survives and is consumed on next boot.
- **Observable:** `[session-resume] resuming N interrupted session(s)` in gateway logs after boot.
- **Files:** `src/infra/session-resume.ts`, `src/auto-reply/reply/get-reply.ts` (write/clear), `src/gateway/server-startup.ts` (consume)

### 11.14 Fractal Loop Prevention (2026-03-31)

- **Status:** `DEPLOYED` (bug fix)
- **What:** Fractal fired 8+ times per user turn instead of once.
- **Root cause:** Two bugs in `fractal-inject.ts`:
  1. Content block extraction only handled `string` content, not `[{type:"text",text:"..."}]` arrays. The `🌿 FRACTAL:` self-detection got an empty string and never matched.
  2. No check for whether the run was triggered BY a fractal prompt. The fractal response's `agent_end` event triggered another fractal.
- **Fix:** Extract text from both string and array content formats. Check LAST assistant message only (not full history — prior turns with `🌿` would cause permanent block). Check user messages for `# FRACTAL REFLECTION` to detect prompt-triggered runs.
- **Files:** `extensions/tinkerclaw-fractal-reflection/src/fractal-inject.ts`

### 11.15 Overload Retry with UI Feedback (2026-03-31)

- **Status:** `DEPLOYED`
- **What:** Aggressive 529 overload retry with visible orange bubbles in Tinker UI.
- **Retry schedule:** 10×1s, 5×2s, 5×escalating 3-8s (20 attempts, ~45s total before model fallback).
- **Gateway events:** `overload-retry` and `overload-retry-exhausted` lifecycle events emitted on each attempt with attempt count, delay, provider, and model.
- **UI rendering:** Orange centered bubbles: `⏳ Overload retry 3/20 for anthropic/claude-opus-4-6 — waiting 1s`. Red bubble when exhausted: `⚠ Overload: 20 retries exhausted — falling back`.
- **Context:** Anthropic deprioritises third-party OAuth clients during peak load. Short retries on the same model are better than jumping to a weaker fallback provider.
- **Files:** `src/agents/embedded-agent-runner/run.ts` (`overloadDelayMs`, `MAX_OVERLOAD_RETRIES`, event emission), `tinker-ui/src/app.ts` (bubble rendering), `tinker-ui/src/styles/base.css` (`.msg-overload-bubble`)

### 11.16 Rate Limit Header Capture (2026-04-03)

- **Status:** `DEPLOYED`
- **What:** Anthropic API response headers are captured for real-time usage bar updates in Tinker UI, replacing the now-defunct OAuth usage endpoint. A custom `fetch` wrapper in `anthropic-vertex-stream.ts` reads rate limit utilization headers and stores them for the UI to consume via lifecycle events.
- **Why:** Anthropic disabled the `api.anthropic.com/api/oauth/usage` endpoint in January 2026. All budget-panel Anthropic usage data went to zero/null. Rate limit headers (`anthropic-ratelimit-unified-5h-utilization`, `7d-utilization`) are returned on every API response and contain the same utilization percentages.
- **Pipeline:** `anthropic-vertex-stream.ts` (fetch wrapper) → `ratelimit-store.ts` (in-memory keyed by authProfileId) → `emitAgentEvent("ratelimit-update")` → Tinker UI `onEvent()` → `renderUsageBarsOnly()`
- **Files:** `src/agents/embedded-agent-runner/anthropic-vertex-stream.ts`, `src/agents/auth-profiles/ratelimit-store.ts` (new), `src/agents/embedded-agent-runner/attempt-hooks.ts`, `tinker-ui/src/app.ts`

### 11.17 tinker-bridge Worker Tool-Choice Injection (2026-04-20)

- **Status:** `DEPLOYED`
- **What:** `extensions/tinkerclaw-tinker-bridge/src/worker.ts::buildToolChoiceBlock()` appends a ~60-line markdown block to every spawned Claude-Code subagent's system prompt. Teaches the WebSearch-vs-WebFetch decision, when to load Deferred tools via `ToolSearch`, when to use Monitor/PushNotification/TaskCreate, and names the common anti-patterns (guessing URLs then WebFetching them, polling via `sleep+test -f` loops, posting routine status to chat).
- **Why:** Claude Code 2.1.114 exposes a dozen tools as DEFERRED — the names show in the initial system prompt but schemas must be loaded via `ToolSearch({query:"select:<Name>"})` before use. Jarvis was reflexing to WebFetch on guessed domains and TLS-erroring out, because nothing in the spawn-time prompt told him WebSearch existed as a separate tool with different purpose.
- **Pipeline:** Worker spawn → `combinedSystemPrompt = [systemPromptBody, rulesBody, subagentHelpBody, toolChoiceBody].filter(Boolean).join("")` → Claude Code `--append-system-prompt`. (FORK 2026-05-21: the live order is now `persona → ethical-rules → narration → subagent-helper → tool-choice → plan-tools`; see `tool-loop.md` "combinedSystemPrompt block order" for the current shape and `config-shape.md` for the ethical-rules loader path.)
- **Files:** `extensions/tinkerclaw-tinker-bridge/src/worker.ts` (lines 203-270 for `buildToolChoiceBlock`, 369-373 for the combine step)

### 11.18 04:00 Cron Pipeline Chain + md-File-Only Policy (2026-04-20)

- **Status:** `DEPLOYED`
- **What:** All 12 Jarvis crons fire from a single 04:00 Europe/Madrid ignition point, arranged as a dependency chain. Topology:
  - **04:00** wind-down (solo — ops hygiene of yesterday)
  - **04:10** memory-consolidation (solo — J5 sleep-cycle, routes yesterday + wind-down output)
  - **04:20** parallel wave: daily-fork-sync, self-evolution, security-updates-check, fork-scanner, marketplace-watcher, online-engagement (+ spiritual-tech Sundays)
  - **04:45** cleaning-lady + life-butler (parallel, after fork-sync completes)
  - **05:00** morning-briefing (aggregator via BRIEFING.md STEP -1)
- **Why:** Previously 12 scattered schedules across 04:15 / 04:30 / 04:45 / 05:00 / 05:15 / 05:30 / 05:45 / 07:00 / 08:00 / 19:00 / 22:30 + Sunday 10:00. the user asked for a single chained start so all overnight work finishes before the morning briefing produces a consolidated dashboard.
- **Policy shift** (2026-04-20): no cron pushes to WhatsApp. All crons write to their own md file under `memory/<cron>/YYYY-MM-DD.md`. Morning-briefing's STEP -1 pulls each file's `tl;dr` + top-3 bullets into a "## Overnight reports" section. On `/new`, Jarvis reads the morning briefing file. Eventually feeds a Grafana panel.
- **Gap-fill:** every payload.message starts with `GAP-FILL: resume from the last successful run, not just yesterday. Read this cron's state file, process every missed day in order. If the state file is missing or corrupt, fall back to 7 days.` No silent day-skipping.
- **Files:** `cron/jobs.json` (tracked; `~/.openclaw/cron/jobs.json` is now a symlink to it), `scripts/cron-*-prompt.txt` (10 prompt files, one per cron), `BRIEFING.md` (STEP -1 aggregator)
- **Recovered:** memory-consolidation (was lost 2026-04-13 in jobs.json wipe, not restored 2026-04-15); wind-down; security-updates-check; life-butler (narrowed + self-improving via butler-scope.md); online-engagement (expanded: tinkerzone WP/GA/GSC + GitHub comment engagement + inbound-link sentiment); fork-scanner (expanded: agent-OSS survey — Hermes, MemPalace, Letta, AutoGen, LangGraph); spiritual-tech (updated: new-age ethics + YouTube curation).
- **New:** cleaning-lady (archives-only, never deletes; flags bloat for the user); marketplace-watcher (replaces zombie whatsapp-group-summary; watchlist-driven bargain hunter for WA buy-sell + Wallapop + Milanuncios per `memory/shopping/watchlist.md`).

### 11.19 BRIEFING.md Anchored-Facts Philosophy (2026-04-20)

- **Status:** `DEPLOYED`
- **What:** BRIEFING.md philosophy flipped. Old: _"the user doesn't need an inventory of known facts. He lived yesterday."_ New: _"Treat every briefing as read by someone who just woke up with no memory of yesterday. Anchor in known facts, be maximally summarized."_ Sections now list anchored inventories with count-first lines, one line per item. Synthesis ("What I'm Thinking") moves to the end as opinion layer over the dashboard.
- **Why:** the user asked for a standalone dashboard that works for the `/new` session-start flow — it can't assume knowledge of prior briefings because `/new` starts from zero context.
- **Target length:** 500-800 words. Inventories are tight (one line each), synthesis is 2-4 short paragraphs at the end.
- **Files:** `~/.openclaw/workspace/BRIEFING.md` (philosophy section + all inventory sections rewritten; STEP -1 pulls cron reports)

### 11.20 Knowledge INDEX.md + IDENTITY.md + fractal-prompt.md (2026-04-20)

- **Status:** `DEPLOYED`
- **What (INDEX.md):** `memory/knowledge/INDEX.md` had 14 of 69 files orphaned (invisible to the index). Added all missing entries; split the "Tracking" dumping-ground (15 entries, most substantive topics) back to their real domains (Jarvis Operations, Infrastructure, Development & Code, Business). Tracking now holds only 6 real trackers.
- **What (IDENTITY.md):** Workspace root `IDENTITY.md` had never been filled since its original template — 23 lines of `_(pick something you like)_` placeholders emitting zero signal into the eager bootstrap for the entire history. Filled with: name=Jarvis, creature=pattern studying patterns, vibe=Data-from-Star-Trek curiosity + dry humor, emoji=🤖 (matches WhatsApp responsePrefix), plus a "How this shows up" section (humor-is-load-bearing, Data-principle curiosity, dry anthropologist combined tone, stay-Jarvis-under-correction). Pointer to `memory/knowledge/humor-operational.md` for the Koestler bisociation theory + 12 patterns.
- **What (fractal-prompt.md):** Rewritten per Anthropic prompt-engineering rubric. Removed over-escalation (MANDATORY/CRITICAL/caps emphasis — Opus 4.6/4.7 overtrigger on aggressive language). Fixed section-numbering bug (header said "Three Questions (answer all)" but had four subsections → now "The seven reflection questions"). Moved Rules block to the end as "Response rules". 208 → 176 lines with no operational content lost (all seven questions, both examples, probe commands, irreversibility gate preserved).
- **Why:** Anthropic's Opus 4.6/4.7 are literal on scope and overtriggered on aggressive phrasing. The research rubric distilled to `/tmp/jarvis-memory-research.md` guides all eager-system-prompt edits.
- **Files:** `memory/knowledge/INDEX.md`, `workspace root IDENTITY.md`, `extensions/tinkerclaw-fractal-reflection/fractal-prompt.md`, `SOUL.md` (dropped stale `memory/journal/consciousness-notes.md` reference — file never existed)

### 11.21 AGENTS.md Compaction + Tool-Choice Pointer (2026-04-20)

- **Status:** `DEPLOYED`
- **What:** Two small additions to `~/.openclaw/workspace/AGENTS.md`. (1) Context Hygiene gains a compaction-awareness bullet: save unfinished state to today's daily log BEFORE the auto-compact fires (short declarative headers survive, chat-style summaries don't). (2) New "Tool Choice" section points at the tinker-bridge `buildToolChoiceBlock` and explicitly names Deferred tools needing `ToolSearch` schema-load first.
- **Why:** Anthropic prompt-engineering rule: inform Claude about its harness so it behaves accordingly when context fills up. The tool-choice pointer gives the main session the same decision framework subagents now get from tinker-bridge.
- **Files:** `~/.openclaw/workspace/AGENTS.md`

### 11.22 /clear — Pure Client Transaction, No LLM Call (2026-04-20, persistence fix 2026-04-21)

- **Status:** `DEPLOYED`
- **What:** `/clear` in Tinker UI is now a client-only transaction matching Claude Code's semantics exactly. Wipes visual chat state (messages, stream state, expanded tools, tab state), rotates the active tab to a fresh `tinker:<timestamp>` sessionKey, fires a best-effort `sessions.delete` for the OLD sessionKey (only if it starts with `tinker:` — main session is never deletable), and **returns without calling chat.send**. Zero LLM tokens spent.
- **Why:** Previously `/clear` wiped the UI locally but then dispatched `chat.send("/clear")` to the gateway, which hit the reset-trigger detection in `get-reply.ts`, fired a full LLM turn, and produced a wasted reply. the user's model: `/clear` is a transaction, not a request.
- **Side effect on main session:** `/clear` on `agent:main:main` rotates the tab to a fresh `tinker:*` key; the main session stays intact on disk (by design — it carries memory continuity). Server-side delete isn't attempted for the main key. Next message creates a brand-new tinker:\* session via gateway auto-create.
- **Transcript preservation:** `sessions.delete` is called with `deleteTranscript: false` so the jsonl is kept for recovery even after the in-memory entry is dropped.
- **Persistence fix (2026-04-21):** `saveTabs()` previously filtered `tab-main` out of `localStorage`. That meant `/clear`-rotated main-tab sessionKeys lived only in memory and were lost on hard reset (gateway restart or browser refresh) — the connect handshake's `defs.mainSessionKey` default would restore the canonical `agent:main:main` session, often showing yesterday's conversation instead of the user's fresh tinker:\* continuation. Now `saveTabs` persists all tabs including main, and the connect handler prefers a restored tab-main when present.
- **Title-migration removal (2026-04-21):** `loadTabs` had a v1/v2 fortune-migration pass that stomped any tab title under 80 chars with a fresh random fortune on every load. This was destroying Ollama-generated titles like `🔧 Fix auth bug` (intentionally short, emoji-prefixed by design), so secondary-session tabs lost their names on every gateway restart and fell back to the original fortune or the session panel's `s.label`/`s.displayName` fallback. Migration removed; `loadTabs` now only force-restores tab-main's `🏠 Main` title (still a protected invariant). Any genuinely-stale v1/v2 fortunes can be cleared by closing and reopening the tab.
- **Files:** `tinker-ui/src/app.ts::send()` (the `text.trim() === "/clear"` branch), `saveTabs()`, `loadTabs()`, connect handler (~line 977)

---

## 12. Workspace Architecture (2026-04-09)

### 12.1 Workspace Unification — Symlinked Code + Private Data

- **Status:** `DEPLOYED`
- **What:** The gateway workspace (`~/.openclaw/workspace/`) is the **jarvis-brain** repo (GitLab private). Code directories and config files are **symlinks** pointing into `~/src/tinkerclaw/` (GitHub public). Private data (memory, bank, skills, personal docs) are real files tracked by jarvis-brain.
- **Why:** Previously two separate git repos with full copies of the code drifted apart, causing build failures (`setPhase` crash) and data loss. This layout ensures one copy of code, one copy of private data, no drift.
- **Structure:**
  - `~/.openclaw/workspace/.git` → jarvis-brain (GitLab, private data)
  - `~/.openclaw/workspace/src` → `~/src/tinkerclaw/src` (symlink)
  - `~/.openclaw/workspace/extensions` → `~/src/tinkerclaw/extensions` (symlink)
  - `~/.openclaw/workspace/dist` → `~/src/tinkerclaw/dist` (symlink)
  - `~/.openclaw/workspace/memory/` → real dir, tracked by jarvis-brain
  - `~/.openclaw/workspace/bank/` → real dir, tracked by jarvis-brain
  - `~/.openclaw/workspace/skills/` → real dir, tracked by jarvis-brain
- **Privacy rules:**
  - Prudence NNs: public, tracked by tinkerclaw (`models/amygdala/prudence-*.onnx`)
  - Personality NNs: private, gitignored by tinkerclaw (`models/amygdala/personality-*.onnx`)
  - Fractal prompt: public, tracked by tinkerclaw (`extensions/tinkerclaw-fractal-reflection/`)
  - Skills: private by default in jarvis-brain. Promoted to public by copying to tinkerclaw and committing.
- **Merge cron:** Operates on `~/src/tinkerclaw/` for upstream code merges. jarvis-brain backup is a separate phase.
- **Builds:** Always from tinkerclaw (`cd ~/src/tinkerclaw && npx tsdown`). Never from workspace directly.
- **Full plan:** `jarvis-icu/docs/superpowers/plans/2026-04-09-workspace-unification-plan.md`

### 12.2 Stuck Thinking Indicator Fix (2026-04-08)

- **Status:** `DEPLOYED`
- **What:** Three-layer defense against the thinking indicator persisting forever when the lifecycle "end" agent event is missed.
- **Layer 1:** Chat "final" safety-net — when the chat final event arrives, schedules `activeRuns` cleanup after 5s as a fallback if the lifecycle event was dropped.
- **Layer 2:** Stale run watchdog — `startThinkingTick()` force-clears any `activeRuns` entry older than 5 minutes with a console warning.
- **Layer 3:** `scheduleUnconfirmedPrune` fix — after reconnect, properly resets `sending` and triggers UI updates when stale runs are pruned.
- **Root cause:** The thinking indicator is driven by two independent event streams (chat final + agent lifecycle end). Both must fire for cleanup. If the lifecycle event was missed, there was no safety net — the indicator persisted forever.
- **Files:** `tinker-ui/src/app.ts` (all three fixes)

### 12.3 Browser Relay CDP Access (2026-04-09)

- **Status:** `DEPLOYED`
- **What:** The gateway's built-in browser extension relay on port 18792 now accepts CDP WebSocket connections from Jarvis/agents. Previously, a blanket origin check rejected all non-`chrome-extension://` origins, blocking Node.js ws library connections.
- **Fix:** Origin check scoped to `/extension` path only. `/cdp` path accepts any origin with valid token auth.
- **Connection:** `ws://127.0.0.1:18792/cdp?token=<gateway.auth.token>`
- **Status check:** `GET http://127.0.0.1:18792/extension/status`
- **Legacy plugin:** `tinkerclaw-browser-relay` in `~/.openclaw/extensions/` is disabled — the built-in relay handles everything.
- **Files:** `extensions/browser/src/browser/extension-relay.ts` (origin check), `~/.openclaw/extensions/tinkerclaw-browser-relay/index.ts` (CDP proxy for fallback)

---

## 13. Conventions & Standards

### 13.1 Plugin Naming Convention

- **Rule:** Every fork plugin MUST use the `tinkerclaw-` prefix in both its plugin ID (in `index.ts` and `openclaw.plugin.json`) and its directory name.
- **Why:** Fork plugins may be installed independently by other users. The prefix avoids ID collisions with upstream bundled plugins that share the same logical name.
- **Example:** `extensions/tinkerclaw-prefrontal/` → `"id": "tinkerclaw-prefrontal"` (not `"prefrontal"`)
- **Four places to check:** The plugin ID must match in all four:
  1. `extensions/<name>/index.ts` — the exported plugin object's `id` field
  2. `extensions/<name>/openclaw.plugin.json` — the manifest `"id"` field
  3. `dist-runtime/extensions/<name>/openclaw.plugin.json` — the pre-built manifest
  4. `openclaw.json` — the config entry key under `plugins.entries`
- **Upstream plugins** (in `extensions/` without `tinkerclaw-` prefix) keep their upstream IDs unchanged. They coexist alongside fork plugins with different IDs.
- **Current fork plugins:** `tinkerclaw-prefrontal`, `tinkerclaw-hippocampus`, `tinkerclaw-fractal-reflection`, `tinkerclaw-learned-intuition`, `tinkerclaw-identity-persistence`, `tinkerclaw-computational-humor`, `tinkerclaw-round-table`, `tinkerclaw-total-recall`, `tinkerclaw-browser-relay` (disabled)

### 13.2 Build Rules

- **Always build from tinkerclaw:** `cd ~/src/tinkerclaw && npx tsdown`. Never run tsdown from `~/.openclaw/workspace/` — its `.git` is jarvis-brain, not tinkerclaw.
- **After build, restart gateway:** SIGUSR1 (`openclaw-restart`) for config changes. Full restart (`openclaw-restart --full`) for dist/code changes — SIGUSR1 doesn't re-import cached ES modules.
- **pnpm install in tinkerclaw:** `cd ~/src/tinkerclaw && pnpm install`. The workspace `node_modules/` is a symlink to tinkerclaw's.
- **Control UI:** Built separately with `cd ~/src/tinkerclaw && pnpm ui:build`. Not rebuilt by tsdown.
- **Tinker UI:** Vite dev server serves from source with HMR. Only `vite build` needed for production builds. Gateway caches `index.html` — restart after Tinker UI builds.

### 13.3 Gateway Config Cleanup (2026-04-10)

- **Status:** `DEPLOYED`
- **Removed extensions:** `modelstudio` and `qwen-portal-auth` from `~/.openclaw/extensions/` — missing `chalk` dependency, not used, spammed errors on every plugin load cycle.
- **Removed stale config entries:** `tinkerclaw-prefrontal` (renamed), `tinkerclaw-hippocampus` (renamed), `tinkerclaw-browser-relay` (disabled legacy) — all removed from `plugins.entries` in `openclaw.json`.
- **Control UI auth:** Changed from `dangerouslyDisableDeviceAuth: true` to `allowInsecureAuth: true`. Same effect (allows Tinker UI WebSocket on localhost HTTP), but `allowInsecureAuth` is the upstream-intended flag for local non-HTTPS deployments. Both produce a security warning in logs — this is by design in upstream's security audit system and not worth patching.
- **Removed dead RPC:** `usage.budget` call removed from Tinker UI `loadBudget()` — method doesn't exist on the server, was producing `INVALID_REQUEST` errors every 5 minutes.
- **Remaining warning:** `gateway.controlUi.allowInsecureAuth=true` security flag — required for Tinker UI on loopback HTTP. Informational only, no actual security risk on localhost.
