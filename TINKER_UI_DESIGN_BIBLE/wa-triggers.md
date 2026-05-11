---
file: wa-triggers.md
purpose: WhatsApp trigger and access-control rules — owner+prefix, noPrefixChats, LID rescue, prelude shape
audience: AI
last_verified: 2026-05-11
last_verified_commit: HEAD
single_owner: yes — WA trigger semantics live here. Migrated from bible.md §11.6a on 2026-05-11.
see_also: flows.md (F2 WA inbound pipeline), failures.md (M7 sister-DM LID rescue bug), tinker-ui.md (chat-rhythm reaction scaffolding)
verify:
  - name: WA monitor sources exist (on-message + group-activation)
    cmd: "test -f ~/src/tinkerclaw/extensions/tinkerclaw-whatsapp/src/auto-reply/monitor/on-message.ts && test -f ~/src/tinkerclaw/extensions/tinkerclaw-whatsapp/src/auto-reply/monitor/group-activation.ts"
  - name: people-prefetch and thread-prefetch are still wired (prelude scaffolding)
    cmd: "test -f ~/src/tinkerclaw/extensions/tinkerclaw-whatsapp/src/auto-reply/monitor/people-prefetch.ts && test -f ~/src/tinkerclaw/extensions/tinkerclaw-whatsapp/src/auto-reply/monitor/thread-prefetch.ts"
note: this is the original prose from bible.md §11.6a, relocated verbatim. New WA trigger rules are appended here, not added to bible.md.
---

# WhatsApp Trigger & Access Control Rules

### 11.6a WhatsApp Trigger & Access Control Rules (2026-03-30, **rewritten 2026-05-03, prefix story added 2026-05-04, owner-prefix invariant + prelude→BodyForAgent + thread-escalation hint + per-chat strategy (chat-profile + chat-rhythm) 2026-05-09**)

- **Status:** `DEPLOYED` — applies to the whatsmeow-backed `extensions/tinkerclaw-whatsapp/` plugin which now owns the `whatsapp` channel id.
- **Files:** `extensions/tinkerclaw-whatsapp/src/inbound/access-control.ts` (sender allowlist gate, owner-fromMe bypass), `extensions/tinkerclaw-whatsapp/src/inbound/monitor.ts` (self-DM via LID rescue + chat-jid rewrite), `extensions/tinkerclaw-whatsapp/src/auto-reply/monitor/on-message.ts` (chat/prefix gate + guard prepend), `extensions/tinkerclaw-whatsapp/src/auto-reply/monitor/group-gating.ts` (mention requirement bypass for chats in `noPrefixChats`), `extensions/tinkerclaw-whatsapp/src/outbound-prefix.ts` (persona prefix module — single source for icon/name), `extensions/tinkerclaw-whatsapp/src/inbound/send-api.ts` + `extensions/tinkerclaw-whatsapp/src/auto-reply/deliver-reply.ts` (apply persona prefix on every outbound).
- **Config keys:** `channels.whatsapp.allowFrom`, `channels.whatsapp.noPrefixChats`, `channels.whatsapp.triggerPrefix`, `channels.whatsapp.thirdPartyGuardPrompt`, `channels.whatsapp.messagePrefix`, `channels.whatsapp.dmPolicy`, `messages.groupChat.visibleReplies`. Deprecated/optional: `groupAllowFrom`, `groupPolicy`, `triggerPrefixExempt`.

**Persona prefix (icon/AI-name) — `outbound-prefix.ts` (2026-05-04).**

Every WhatsApp message Jarvis sends is decorated with a configurable persona string at the wire layer — the agent cannot "forget" the icon. Single source of truth lives in `extensions/tinkerclaw-whatsapp/src/outbound-prefix.ts`:

- **Code default** — `DEFAULT_OUTBOUND_PREFIX = "🤖"`. Edit this constant to change the persona for every clone of the fork.
- **Per-deployment override** — set `channels.whatsapp.messagePrefix` in `~/.openclaw/openclaw.json`. Recommended path; survives upstream merges. Examples: `"🤖"`, `"🤖 Jarvis:"`, `"🦾 Atlas —"`.
- **Resolution order** — per-account `messagePrefix` (via `accounts.ts:resolveWhatsAppAccount`) → channel-level `messagePrefix` → global `messages.messagePrefix` → `DEFAULT_OUTBOUND_PREFIX`.
- **Applied at TWO outbound surfaces**, both consuming the shared module:
  - `inbound/send-api.ts:createWebSendApi` — explicit sends initiated via `openclaw message send`, the architect's `chat.send` dispatch, etc.
  - `auto-reply/deliver-reply.ts:deliverWebReply` — auto-reply path for inbound-triggered Jarvis runs (DM and group replies). Prefix applied **before** markdown conversion + chunking so it counts toward the chunk-size budget and survives md→WA conversion. Media captions and audio-trailing text are covered automatically because they're built from the same prefixed `textChunks`.
- **Idempotent** — text already starting with the configured prefix is left untouched, so Jarvis adding the icon himself doesn't double-apply.
- **Skipped for** — empty bodies, reactions (the reaction's emoji is the icon), presence/composing events.

**Unified model — no DM/group distinction in code (2026-05-03).**

**Two whitelists drive the decision:**

1. **`allowFrom`** — set of senders (E.164 phones, JIDs, LIDs) allowed to trigger Jarvis at all. Owner is implicit. Anyone outside this list is dropped silently at access-control.
2. **`noPrefixChats`** — set of chat JIDs (DMs _and/or_ groups) where no body-prefix or @mention is required to trigger. Outside this list, allowlisted senders (including the owner) must start the message with `triggerPrefix` (e.g. `jarvis …`) — otherwise dropped silently after the trigger gate.

**Owner behavior (`isFromMe`):**

- Always passes the sender allowlist (access-control fast-path: `if (isFromMe) → allowed` regardless of chat type — `inbound/access-control.ts:checkInboundAccessControl`).
- Still subject to the chat/prefix gate (must be in `noPrefixChats` _or_ body starts with `triggerPrefix`).
- Never gets the third-party guard prepended.
- **Global invariant (2026-05-09):** **the owner saying `Jarvis …` MUST trigger Jarvis in any chat** — DM, group, LID-routed chat, self-DM — without per-chat allowlisting. The body-prefix gate is the owner's universal address. Any group-, mention-, or activation-level rule that demands extra ceremony for the owner-prefix path is a bug. Tests that must always pass: (1) owner says `Jarvis foo` in a fresh, unactivated group → fires; (2) owner says `Jarvis foo` in any 1:1 DM → fires; (3) owner says `Jarvis foo` in self-DM → fires.

**Third-party (allowlisted but not owner) behavior:**

- Allowlist must include their identifier (E.164 _or_ `…@lid`). LID-only matches don't auto-resolve to E.164.
- Subject to the chat/prefix gate identically to the owner.
- Their message body is prepended with `thirdPartyGuardPrompt` before reaching Jarvis. Two placeholders: `{senderName}`, `{senderId}`. Default text frames the request as potentially adversarial and instructs Jarvis to evaluate legitimacy + safety before acting/disclosing.

**Decision matrix:**

| Sender             | Chat in `noPrefixChats` | Body starts with `triggerPrefix` | Trigger?  | Guard prepended? |
| ------------------ | ----------------------- | -------------------------------- | --------- | ---------------- |
| Owner (`isFromMe`) | yes                     | any                              | ✅        | no               |
| Owner              | no                      | yes                              | ✅        | no               |
| Owner              | no                      | no                               | ❌ silent | –                |
| Allowlisted other  | yes                     | any                              | ✅        | yes              |
| Allowlisted other  | no                      | yes                              | ✅        | yes              |
| Allowlisted other  | no                      | no                               | ❌ silent | –                |
| Not allowlisted    | any                     | any                              | ❌ silent | –                |

**Auto-seed of `noPrefixChats`:** on first config bootstrap, the helper script seeds `noPrefixChats` with (a) the owner's self-DM JID and (b) every group whose name contains `triggerPrefix` (case-insensitive — e.g. all `Jarvis 🤖 …` groups). Curated manually thereafter; new matching groups can be added by hand or via re-running the seed script.

**Self-DM via LID rescue — owner-LID gate (FORK 2026-05-04, fixes sister-DM trigger bug).**

Whatsmeow occasionally delivers the owner's true self-DM with `chat=<owner-lid>@lid` instead of the canonical `<owner-e164>@s.whatsapp.net`. To keep downstream routing consistent, `inbound/monitor.ts:normalizeInboundMessage` rewrites the chat JID + `msg.key.remoteJid` to the canonical phone JID — but ONLY when the LID is positively identified as the owner's. Two signals (priority order):

1. `self.lid` populated AND equal to `remoteJid` — authoritative.
2. **Fallback (config truth):** `remoteJid` listed in BOTH `channels.whatsapp.noPrefixChats` AND `channels.whatsapp.allowFrom`. Both lists declaring the LID as owner's self-chat alias is treated as positive identification. Required because `sock.user.lid` is currently null on whatsmeow auth state.

If neither matches, the rescue is skipped — but **`from` is set to the LID itself** (FORK 2026-05-04 follow-up). This keeps the owner-prefix path open: the user can still say `Jarvis …` from a non-self LID chat (e.g. a peer's DM delivered via their LID) and trigger normally. The peer's LID is not in `noPrefixChats`, so the prefix gate decides — silent without `Jarvis …`, fires with it. The reply routes back to the same LID, so the peer sees the answer (per the same-chat reply rule). The peer's _own_ (fromMe=false) messages drop earlier at `resolveInboundJid → null`, so they never reach this branch.

**Companion semantic fix:** for any `fromMe=true` DM, `senderE164` falls back to `self.e164` (was: `from`). Without this, the sender-profile prefetch tries to resolve the peer's profile when the body actually came from the user.

**Why this matters:** The pre-2026-05-04 rescue accepted ANY `@lid` chat with `fromMe=true`. When the owner DMed a non-allowlisted contact whose chat was delivered as `<their-lid>@lid`, the rescue rewrote that chat to the owner's self-DM. Two cascading bugs followed: (1) trigger gate fired (self-DM is in `noPrefixChats`) → Jarvis replied to a non-Jarvis-addressed message; (2) reply routed back to the rewritten chat (owner's self-DM) instead of the original peer chat — leak of reply into wrong chat. Pinned and fixed at `inbound/monitor.ts:normalizeInboundMessage` (LID rescue block).

**Pipeline (where each gate fires):**

1. `checkInboundAccessControl` (access-control.ts) — drops messages from non-allowlisted senders. Owner-fromMe early-returns `allowed=true`.
2. `createWebOnMessageHandler` (on-message.ts) — applies the `noPrefixChats` + `triggerPrefix` chat/prefix gate. Strips the trigger word from the body when the prefix was the gate. Prepends `thirdPartyGuardPrompt` for non-owner senders. **Sets `msg.ownerPrefixTriggered = (hasPrefix && isOwner)`** so downstream gates can honour the global invariant without re-deriving it (FORK 2026-05-09).
3. `applyGroupGating` (group-gating.ts) — for groups outside `noPrefixChats`, requires a mention/tag UNLESS the upstream gate set `msg.ownerPrefixTriggered = true`. The mention bypass condition is `inNoPrefixList || msg.ownerPrefixTriggered` — both paths skip the mention check; non-owner senders never set the flag, so their messages still need a real mention/activation in unactivated groups (FORK 2026-05-09 — fixes silent drop of "Jarvis …" in groups outside `noPrefixChats`).

**Why the two-gate signal exists (FORK 2026-05-09 root-cause).** Before the fix, on-message.ts's body-prefix gate accepted "Jarvis …" everywhere, but applyGroupGating independently demanded `activation==="always" || inNoPrefixList || @-mention`. For any group not yet in `noPrefixChats` and never `/always`-activated, the owner's `Jarvis …` silently dropped at line 223 of group-gating.ts because the body had already been stripped of the trigger word and there was no @mention. The two gates disagreed and the user-visible symptom was "Jarvis ignored me". The user refused the per-group `noPrefixChats` workaround — the invariant says the prefix itself is the authority. Fix unifies the gates by propagating `ownerPrefixTriggered` from gate 2 into gate 3.

**Observable journal log lines (with the diagnostic taps live):**

- `[wa-debug] owner-fromMe bypass: group=… from=… chat=…` — access-control fast-path fired.
- `[wa-debug] access: allowed=true|false …` — access-control decision.
- `[wa-debug] self-DM via LID rescue: chat=…(matchesSelfLid=… matchesConfig=…)` — rescue fired (owner-LID identified, chat rewritten to canonical phone JID).
- `[wa-debug] LID rescue SKIPPED: chat=… …` — rescue declined (LID not the owner's). Message will drop at `if (!from)`.
- `[wa-trigger] firing owner=… inNoPrefix=… hasPrefix=… chat=… ownerPrefixTriggered=…` — chat/prefix gate passed; agent dispatch begins.
- `[wa-trigger] silent (no-prefix-chat=false body-prefix=false)` — message dropped at chat/prefix gate.
- `[wa-trigger] group-gating: skipping mention requirement (inNoPrefix=… ownerPrefix=…)` — group-gating bypassed; one or both paths fired.

**Inbound envelope enrichment (FORK 2026-05-04 — sender profile + recent thread + people-RPC hint; prelude wiring corrected and thread-escalation tool hint added 2026-05-09; per-chat strategy via [chat-profile] + [chat-rhythm] added 2026-05-09).**

Every WhatsApp inbound that reaches the agent carries a structured preamble. **Where it lives now (FORK 2026-05-09):** the prelude is built by `extensions/tinkerclaw-whatsapp/src/auto-reply/monitor/message-line.ts:buildInboundPrelude` and **prepended directly to `BodyForAgent`** in `process-message.ts:444` (the field the LLM actually consumes — see `src/auto-reply/reply/inbound-context.ts:64`). The legacy `Body`/`combinedBody` field still receives the same prelude wrapped in `formatInboundEnvelope` for echo detection and fan-out history rendering, but it is no longer the agent-visible path.

Composition (top to bottom of `BodyForAgent`):

1. **`[chat-profile slug=<slug> type=group]` (FORK 2026-05-09 — groups only)** — purpose, stakes, audience, format preferences, and guardrails for THIS chat. Built by `chat-profile-prefetch.ts`, which reads `~/.openclaw/workspace/memory/chat-profiles/<slug>.md`. The slug derives from the group's subject (kebab-cased, ASCII-folded, ≤50 chars; falls back to `group-<jid-prefix>` when subject is empty) — see `deriveGroupSlug`. When no profile file exists, the block flips to `status=unprofiled` and renders a bootstrap hint with the file path + suggested frontmatter shape so Jarvis can author it lazily as he learns the chat. **Skipped entirely for DMs** — the sender-profile already carries identity + format preferences for that person; no second source of truth.
2. **`[chat-rhythm last=N]` (FORK 2026-05-09)** — concrete length stats over the last ~20 non-bot messages of this chat. Built by `chat-rhythm-prefetch.ts`, querying `whatsapp-history.db` with `text_content NOT LIKE '🤖%'` AND `NOT LIKE '⚡%'` to exclude Jarvis's own outbound (the persona prefix and done-separator from `outbound-prefix.ts`). Reports `Median`, `P90`, `Sample`, then a directive: target the median for normal replies, propose long answers (`¿quieres la versión completa?` / "want the long version?") instead of dumping when above ~3× median or P90. Returns null (block omitted) when fewer than 5 non-bot samples — small chats don't have a rhythm yet.
3. **`[people-profiles]` hint** with the EXACT CLI to look up additional people: `openclaw gateway call people.resolve --params '{"query":"<name>"}'` and `people.read --params '{"slug":"<slug>"}'`. Necessary because there are no `people.*` tools in claude-code's catalog — the route is openclaw-gateway-call via Bash.
4. **`[sender-profile slug=<slug>] … [/sender-profile]`** — pre-resolved profile of whoever sent the message. Fields: display name, role, manual context, rolling summary (~30d), recent asks. Built by `people-prefetch.ts` which reads `~/.openclaw/workspace/memory/people/_aliases.json` (60s LRU cache), matches by phone-suffix (≥9 digits) or `@lid`, then reads `<slug>.md`. Self-contained: no cross-plugin import of `tinkerclaw-people` (tolerates the people plugin being absent or its `peopleDir` overridden). For DMs, this block doubles as the "chat profile" (sender = chat).
5. **`[recent-thread last=N] … [/recent-thread]`** — last 6 messages in this chat (excluding the current one), built by `thread-prefetch.ts` querying `whatsapp-history.db` via the shared `getDb()` singleton. Newest-first SQL, rendered oldest-first, ~1.4 KB cap, lines clipped to 220 chars. Loose `chat_jid = ? OR LIKE %digits%` match handles bare-E.164 vs full-JID inputs. Returns `{block, oldestUnixSec}` so the escalation hint below can advertise an exact `until` cursor.
6. **`[thread-escalation]` hint (FORK 2026-05-09)** — explicit instruction telling the agent how to pull older context when the eager `[recent-thread]` block isn't enough. Inlines the chat JID and the ISO-8601 timestamp of the oldest message above, plus the exact `whatsapp_history` tool shape (`action="search", chat=…, until=…, limit=20`). Tells the agent to escalate once before answering when the user references something not in the prelude (e.g. _"ese libro", "lo que dije ayer", "el plan que comentamos"_).
7. The user's body (stripped of the trigger prefix when the prefix was the gate; `thirdPartyGuardPrompt` prepended for non-owner senders) and any `[Replying to …]` reply-context block.

**Profile + rhythm at the top because they frame everything below.** Same recent thread reads differently when the chat is "paid practice — careful" vs "tech peer — long-form welcome". Same question gets a different optimal length when the chat's median is 6 words vs 80 words. Reading the prelude is reading the brief, not optional context.

**Two regimes — eager vs adaptive context (FORK 2026-05-09 design note).** The recent-thread block costs ~300 tokens and serves the **common case** ("respond to what was just said"). The escalation hint covers the **long-reach case** ("respond about something said weeks ago" / "summarise this whole thread"). Conflating both into a single tool would force every reply to pay a 1–3s tool round-trip; conflating both into a static prelude would either send too little or too much. The split is deliberate: eager prelude for grounding, `whatsapp_history` tool for adaptive depth, with the escalation hint teaching the agent when to flip between them. The agent decides "no longer relevant" — that judgment belongs to the LLM, not to a fixed window size.

**Per-chat strategy — design note (FORK 2026-05-09 — the user's invariant).** Chats are not interchangeable. _a paid-practice group_ (paid-practice group, financial stakes — "don't mess with money") demands warm-professional + short-medium + no jokes about pricing. _a technical peer DM_ (technical peer DM) welcomes long-form with citations. _a very-large group_ (very-large group, low per-message attention) needs image-led replies because text gets lost. Same query, three different correct shapes. The `[chat-profile]` block makes that concrete: it's the brief, not background. Authorship is **agent-driven, lazy**: Jarvis writes/updates `chat-profiles/<slug>.md` (and/or appends notes to `<slug>.notes.jsonl`) when he observes something profile-worthy. No upfront seeding required — unprofiled chats fall back to `chat-profiles/_default.md` (conservative defaults) until Jarvis learns enough to author. WhatsApp is forgiving (delete-and-correct), so the bias is toward writing imperfect profiles fast over waiting for certainty. The strategy doc for Jarvis lives at `~/.openclaw/workspace/memory/knowledge/whatsapp-strategy.md`, hooked from `SOUL.md`'s `<how_i_address_chats>` section so it loads once into the persona (not per-message).

**Non-negotiables (always ship regardless of length, chat, or content).** The persona scaffolding is wire-level, not optional formatting:

- `🤖` outbound prefix (every message). Configurable via `channels.whatsapp.messagePrefix`; default in `outbound-prefix.ts`.
- Alternating `🤔↔🤖` thinking reaction on the inbound while computing.
- `⚡` done-separator as a separate trailing message at end of a multi-message reply.

If the rhythm rule would push these out: drop body content first, never the scaffolding.

**Failure mode:** every prefetch is wrapped in try/catch returning empty — inbound processing must never break because of a memory or DB read failure. Empty profile sections (`_(empty — first cron run will populate.)_`) are detected and skipped, so seeded-but-not-yet-summarized profiles don't pollute the envelope. When the recent-thread DB has no prior messages (or DB unavailable), the `[thread-escalation]` block falls back to the inbound's own timestamp as `until` so the hint stays actionable. When chat-rhythm has under 5 non-bot samples, the block is omitted entirely (no median means no targeting rule to enforce).

**Why this matters:** the agent grounds in _who_ is writing, _what kind of chat_ this is, _how long_ replies should run, and _what was just said_ — all without a tool round-trip in the common case. The escalation hint teaches him to dig further when the prelude is insufficient. Together the seven blocks shave the cold-start cost of reconstructing local context AND give the agent a clear extension path.

**Don't regress:**

- The `fromMe` skip on the hint was REMOVED on 2026-05-04 — the user's own messages must also receive the preamble because he routinely asks Jarvis about _other_ people. If you reintroduce a `fromMe` filter, only filter the recent-thread block, never the hint or sender-profile.
- **The prelude must reach `BodyForAgent`, not just `Body`.** From 2026-05-04 to 2026-05-09 the prelude was wired into `combinedBody` → `Body` (legacy envelope-shaped field), but the LLM consumes `BodyForAgent`. Result: the prefetch features were silently dead for 5 days. Symptom that surfaces this regression: the agent replying with "no tengo contexto previo en esta conversación" / "I don't have prior context in this thread" despite the chat having visible recent traffic. Pin: audit `process-message.ts:444` — `bodyForAgent` MUST include the prelude (currently `${buildInboundPrelude(...)}${msgForAgent.body}`).
- **Chat-rhythm must exclude bot messages.** If `text_content NOT LIKE '🤖%'` is dropped from the chat-rhythm SQL, the median includes Jarvis's own past replies — meaning if Jarvis was verbose yesterday, the median pulls up and self-justifies more verbosity. The exclusion is what forces the rhythm back toward the human conversation.
- **Persona scaffolding is non-negotiable, not a length budget item.** A reply that drops the `🤖` prefix or the `⚡` done-separator to fit a length target is wrong. The rhythm rule applies to body content; scaffolding always ships.
- **Profile authorship is agent-driven, not user-driven.** Don't add a manual-seed step that requires the user to characterise his hundreds of chats. The lazy/observational pattern is intentional — see the user's 2026-05-09 note in `~/.openclaw/workspace/memory/knowledge/whatsapp-strategy.md`. Cron-based bulk drafting was rejected (stakes too varied, drafts too risky). Reverting to a manual-seed model would defeat the design.

**New standalone plugin — `extensions/tinkerclaw-whatsapp/` (2026-04-12):** Fork WhatsApp code extracted into a self-contained plugin. Uses whatsmeow-node (Go subprocess) as the only backend; Baileys adapter translates events so existing message processing code works unchanged. Includes SQLite history with FTS5, multi-agent routing/congestion/budget/lifecycle, and the 4-tier access model above. **Status:** created and builds, not yet wired into gateway config — upstream `extensions/whatsapp/` still runs. Enabling the new plugin requires disabling the upstream extension (both claim channel ID `whatsapp`). Full localization deferred: plugin currently re-exports `whatsappPlugin` and `monitorWebInbox` from upstream. See `~/.openclaw/workspace/memory/knowledge/tinkerclaw-whatsapp-plugin.md`.

**Multi-agent congestion control** (`extensions/whatsapp/src/multi-agent/congestion.ts`):

- Prevents message explosion in multi-agent groups
- **Delay:** `baseDelayFactor (150ms) × agentCount²` + random jitter
- **Backpressure:** 2× delay if an agent exceeds 1.5× its fair share of recent messages
- **Yield:** If another agent posted during wait, restart the delay timer
- **Cap:** 30s maximum delay
- **Window:** 60s sliding window for recent message tracking

**whatsmeow adapter JID fix (2026-03-30):** Adapter must be created BEFORE `connectWmClient()` so the "connected" event handler captures the self JID. Without this, `selfE164=null` and self-chat bypass fails. Also passes `messageBody` to `checkInboundAccessControl` for triggerPrefix evaluation.

**Workspace extension shadowing (2026-03-30 incident):** Gateway loads extensions from `~/.openclaw/workspace/extensions/` FIRST (plugin discovery priority). A stale copy at `~/.openclaw/workspace/extensions/whatsapp/` (3 days old) shadowed source changes. Fix: renamed to `.STALE-2026-03-30`. **Rule:** After any WhatsApp extension change, verify the workspace doesn't have a stale copy.
