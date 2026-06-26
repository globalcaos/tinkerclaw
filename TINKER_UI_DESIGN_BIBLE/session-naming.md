---
file: session-naming.md
purpose: Single source of truth for how every visible name on a session is generated, persisted, and rendered. Captures the current state, the divergence bugs we hit, and the unified contract.
audience: AI
last_verified: 2026-06-25
last_verified_commit: HEAD
single_owner: yes — anything about session/tab naming, fortune cookies, label-resolution priority lives ONLY here. cookiePhrase, tab.title, label, displayName, cookiePhraseUserSet all funnel through one chain documented below.
see_also: tinker-ui.md §5.69 (sessions list — server-resolver hardening), bug-log.md FIXED [config-dead-code] 2026-05-24 (gateway-rebuild gotcha that hid Bug 1 of `task-mpjhzu3j-ma9ts` for two hours).
status: DEPLOYED. 2026-06-10 (u3-tab-naming) made user-set / auto tab names DURABLE SERVER-SIDE (see "Server-durable user-set names" below) — they now survive ANY restart, browser, or device, not just this browser's localStorage. The server DOES lazy-mint a key-derived fortune `cookiePhrase` (FORTUNE_COOKIES pool) for sessions that have no deliberate name; the mint now SKIPS any session flagged `cookiePhraseUserSet`. The auto-title was also retuned to lean on the user's prompts and stay distinct from sibling tabs. **u4 (2026-06-25)** moved the auto-title MODEL PATH off direct Ollama onto a webchat-callable gateway RPC — `sessions.suggestTitle`, a one-shot cc-bridge Sonnet completion — and added clone auto-naming (an explicit kick), a doubled-title guard, and a non-persisted in-flight shimmer (see "Auto-title mechanism — cc-bridge Sonnet RPC + clone kick" below). (History: 2026-05-24 second pass made the FORTUNE_COOKIES pool the only phrase source; the first-pass 2-word generator was deleted.)
verify:
  - name: lazy-mint skips a user-set cookiePhrase (never trample a deliberate name)
    cmd: python3 -c 'import os; t=open(os.path.expanduser("~/src/tinkerclaw/src/gateway/session-utils.ts")).read(); i=t.find("const canonicalPhrase = fortuneForKey(key)"); assert i!=-1, "lazy-mint canonicalPhrase line missing"; assert "cookiePhraseUserSet) continue" in t[max(0,i-800):i], "lazy-mint must skip cookiePhraseUserSet before re-minting the fortune"'
  - name: SessionEntry and sessions.patch schema carry cookiePhraseUserSet
    cmd: python3 -c 'import os; assert "cookiePhraseUserSet" in open(os.path.expanduser("~/src/tinkerclaw/src/config/sessions/types.ts")).read(); assert "cookiePhraseUserSet" in open(os.path.expanduser("~/src/tinkerclaw/src/gateway/protocol/schema/sessions.ts")).read()'
  - name: webchat guard exempts only display-name-only patches
    cmd: python3 -c 'import os; t=open(os.path.expanduser("~/src/tinkerclaw/src/gateway/server-methods/sessions.ts")).read(); assert "isDisplayNameOnlyPatch" in t and "DISPLAY_NAME_PATCH_KEYS" in t'
  - name: Tinker UI persists deliberate names server-side
    cmd: python3 -c 'import os; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); assert "persistTabNameToServer" in t and "cookiePhraseUserSet" in t'
  - name: u4 — auto-title runs via the sessions.suggestTitle cc-bridge Sonnet RPC (NOT ollama/gemini/metered-API), webchat-callable
    cmd: python3 -c 'import os; t=open(os.path.expanduser("~/src/tinkerclaw/src/gateway/server-methods/suggest-title.ts")).read(); assert "runEmbeddedPiAgent" in t and "claude-code" in t and "claude-sonnet-4-6" in t, "title one-shot must run cc-bridge Sonnet"; s=open(os.path.expanduser("~/src/tinkerclaw/src/gateway/server-methods/sessions.ts")).read(); assert "suggestTitleViaBridge" in s and "sessions.suggestTitle" in s, "sessions.suggestTitle handler missing"; ms=open(os.path.expanduser("~/src/tinkerclaw/src/gateway/method-scopes.ts")).read(); assert "sessions.suggestTitle" in ms, "sessions.suggestTitle scope missing (must be webchat-callable)"'
  - name: u4 — title one-shot timeout is 45s (a cold cc-bridge claude spawn legitimately exceeds 15s)
    cmd: python3 -c 'import os; t=open(os.path.expanduser("~/src/tinkerclaw/src/gateway/server-methods/suggest-title.ts")).read(); assert "timeoutMs: 45_000" in t, "title timeoutMs must be 45_000 (15_000 returned null -> tabs never renamed)"'
  - name: u4 — clone tabs get an explicit auto-title kick; client calls the RPC (not fork.subagents.spawn)
    cmd: python3 -c 'import os; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); assert "pendingTitleKickTabId" in t, "clone auto-title kick missing"; assert "spawnTitleViaBridge" in t and "sessions.suggestTitle" in t, "client must call sessions.suggestTitle"'
  - name: u4 — client collapses an exact doubled title + dedups generation via a runtime (non-persisted) set
    cmd: python3 -c 'import os; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); assert "collapseDoubled" in t, "collapseDoubled (doubled-title guard) missing"; assert "titleInFlight" in t, "titleInFlight (runtime generation dedup) missing"'
---

# Session-naming contract

There is exactly ONE visible name per session. The user sees it in three places: the right-panel sessions list row, the active tab strip tab, and any session-selector dropdown. These three surfaces must always agree.

## The four name signals

| Signal         | Where minted                                                              | Format                                                                                  | Persisted where                                                     | Lifetime                                                           |
| -------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `tab.title`    | client (`tinker-ui/src/app.ts`)                                           | one of FORTUNE_COOKIES on mint; auto-title may override                                 | `localStorage["tinker.tabs"]`                                       | until tab closed (and even then, if persisted)                     |
| `cookiePhrase` | client mints via `randomFortune()`; server stores via `sessions.patch`    | freeform string — whatever the client patches in (in practice: a FORTUNE_COOKIES entry) | `sessions.json` (SessionEntry.cookiePhrase)                         | burned-in forever once minted; survives every restart and rotation |
| `label`        | server (whatever set it — chat.send origin, group title, manual edit)     | freeform — usually empty for chat-originated sessions                                   | `sessions.json` (SessionEntry.label)                                | until cleared                                                      |
| `displayName`  | server, derived from `origin.label` or `channel`/`subject`/`groupChannel` | freeform                                                                                | `sessions.json` (SessionEntry.displayName) OR computed at list-time | mostly persistent                                                  |

## Tab.title sources (the client-side mint sites)

Four callsites currently set `tab.title`:

1. **`addTab()`** (`app.ts:5251`) — new tab from the "+" button.
   - `title: randomFortune()` → picks ONE of ~200+ LONG poetic greetings from `FORTUNE_COOKIES` (`app.ts:156`). Example: `"🔓 The thought you are most tempted to believe without questioning is the one most worth examining…"`

2. **`/clear` handler** (`app.ts:11928`) — rotates main session, gives the rotated tab a fresh title.
   - `tab.title = randomFortune()` (same pool).

3. **`attachSessionToTab(key)`** (`app.ts:5302`) — when the user clicks a row in the sessions panel to open it in the active tab.
   - Prefers `sess.cookiePhrase` (the server's burned-in value, which is itself a `FORTUNE_COOKIES` entry); falls through to `sess.label.slice(0, 30)` if no phrase yet.

4. **Auto-title** (LLM-generated topic phrase from the chat content) — fires on assistant-turn `end` at user-turn 1 then every `TAB_TITLE_INTERVAL` (=5) turns, via `generateTabTitle()` (`app.ts`). The user-meaningful customisation path; wins over the random fortune, sets `titleLocked`, AND persists server-side via `sessions.patch {cookiePhrase, cookiePhraseUserSet:true}`.
   - **u3-tab-naming (2026-06-10):** the prompt is built PRIMARILY from the user's own recent prompts (recency-weighted; assistant replies are secondary context only) and is fed the OTHER open tabs' deliberate (locked) names with an instruction to make THIS title distinct + specific. Output = one relevant emoji + 2-4 words (≤48 chars); a unique leading emoji is enforced via `pickUniqueTabIcon`.
   - **u4-tab-naming (2026-06-25):** the MODEL PATH moved off the old direct Ollama (`localhost:11434`) call to the gateway RPC `sessions.suggestTitle`, a one-shot cc-bridge Sonnet completion. The prompt-shaping rules above are unchanged. See "Auto-title mechanism — cc-bridge Sonnet RPC + clone kick" below for the RPC, the 45s cold-spawn timeout, clone auto-naming, the doubled-title guard, and the in-flight shimmer. (Any earlier bible text saying "Gemini" or "local Ollama" for the model path is obsolete.)

5. **`loadTabs()`** restore at module load — reads `localStorage["tinker.tabs"]` and restores `tab.title` for previously-persisted tabs. No new minting.

## Side-panel name resolution (the read site)

`renderSessionRow(s, shortLabel)` at `app.ts:6180` uses this priority chain:

```
1. tab?.title                                    (the open tab matching this session)
2. s.cookiePhrase                                (the server's burned-in phrase)
3. meaningfulSessionLabel(s.label)               (generic-filtered server label)
4. meaningfulSessionLabel(s.displayName)         (generic-filtered server displayName)
5. shortLabel                                    (key-derived fallback like "mpgj631q")
```

Tab strip rendering: `renderTabs()` just reads `tab.title` directly.

## The unified contract (DEPLOYED 2026-05-24, second pass)

1. **Single phrase pool — `FORTUNE_COOKIES`.** The 200+ long poetic greetings (with emoji) at `tinker-ui/src/app.ts:156`. There is no other generator. The first pass invented a separate 2-word adjective×noun pool server-side; that was wrong — the user had already curated `FORTUNE_COOKIES` for this exact purpose. Second pass deleted it.

2. **Client mints, server stores.** No server-side generation. `cookiePhrase` in `sessions.json` is a stored-only field (set via `sessions.patch {cookiePhrase}`); the server never picks a value. Client mints at `addTab()` / `/clear` via `randomFortune()`. `loadSessions()` patches the chosen phrase up to the server after the session entry exists.

3. **Tab.title sourcing rule:**
   - `addTab()` mints `randomFortune()` and uses it as `tab.title`.
   - `/clear` (main-session rotation) mints `randomFortune()` and uses it as `tab.title` for the rotated tab.
   - `attachSessionToTab(key)` uses `sess.cookiePhrase` if present (and non-legacy); else falls through to `sess.label`.
   - Auto-title (Gemini topic phrase) STILL OVERRIDES — it's the meaningful user-facing customisation. Detected by NOT matching `LEGACY_2WORD_PHRASE_RE`.

4. **`loadSessions()` reconciliation** (after every `sessions.list` response, for each tab matching a returned session):
   - **Server has non-legacy phrase**: copy it into `tab.title` if `tab.title` was itself a legacy 2-word value (or matches the server's).
   - **Server missing phrase OR has legacy 2-word phrase**: mint `randomFortune()` (or keep `tab.title` if already a meaningful non-legacy value), then `sessions.patch {key, cookiePhrase: <chosen>}` — fire-and-forget; result surfaces on next poll. This is the migration path for sessions that got 2-word names from the first-pass server-side lazy-mint.

5. **Side-panel resolution chain unchanged.** `tab.title` wins because step (4) keeps it in sync with the stored phrase OR carries a meaningful auto-title; the fallback to `sess.cookiePhrase` catches tabs the user has closed.

## Migration: legacy 2-word phrases

The first pass minted 2-word phrases server-side and persisted them to `sessions.json`. ~49 sessions on the live gateway had legacy values like `"ivory anvil"`, `"slate stream"`, `"silver hearth"` as of 2026-05-24 ~12:00 UTC.

The `loadSessions()` reconciliation detects these via `LEGACY_2WORD_PHRASE_RE` (`/^[a-z]+ [a-z]+( \d{2})?$/`) and re-mints a long fortune, then patches the server. As the user opens tabs for these sessions, they get re-burned organically. No one-shot migration script needed.

After ~a week or two of normal use, `LEGACY_2WORD_PHRASE_RE` + the migration branch in `loadSessions()` will have no remaining work. Both are safe to delete in a cleanup commit at that point.

## Don't regress

- The server lazy-mint (`listSessionsFromStore` → `fortuneForKey(key)`) generates a fortune `cookiePhrase` ONLY for sessions with no deliberate name. It MUST keep skipping any entry flagged `cookiePhraseUserSet` — never re-stamp a fortune over a user-set / auto name. (The old rule "no server-side generator at all" is obsolete: the key-derived mint is intentional; what matters is that it never tramples a deliberate name.)
- Never re-introduce a 2-word format. `FORTUNE_COOKIES` is the only fortune pool.
- A deliberate name (manual rename OR successful auto-name) is protected by TWO layers that must stay in lockstep: client `titleLocked` (localStorage cache) AND server `cookiePhraseUserSet` (durable). `loadSessions()` must never clobber a locked tab, and must ADOPT + lock a server `cookiePhraseUserSet` name on an unlocked tab (restore-after-wipe). Don't reduce this back to the `LEGACY_2WORD_PHRASE_RE` shape heuristic.
- Keep the webchat write path NARROW: only a display-name-only patch (`isDisplayNameOnlyPatch`) is exempt from `rejectWebchatSessionMutation`. Never broaden the exemption to other session-metadata fields, and never touch the `sessions.pluginPatch` guard.
- The auto-title (`generateTabTitle`) must stay PROMPT-focused (the user's own messages are the primary signal) and sibling-DISTINCT (fed the other open tabs' names). Don't revert it to summarising the whole transcript or ignoring sibling tabs. See the amendment section below.
- (u4, 2026-06-25) The auto-title model path is the **`sessions.suggestTitle` cc-bridge RPC** (subscription Sonnet). Never revert to a webchat `fork.subagents.spawn` (scope-rejected → no title) or to a direct Ollama/Gemini/metered-API call. Keep `sessions.suggestTitle` in the READ_SCOPE group so the webchat can call it.
- (u4) Keep the title one-shot `timeoutMs` generous (**45s**) — the cc-bridge cold-spawn legitimately takes 14–19s; a tight timeout makes the RPC return `null` and the tab silently never renames.
- (u4) A freshly cloned tab needs the explicit `pendingTitleKickTabId` kick — it emits no turn-end event, so removing the kick silently breaks clone auto-naming. Don't "fix" clone naming by seeding the clone's message buffer (dead end: the active clone reads the global buffer that `loadChat` overwrites).
- (u4) `titleGenerating` is a TRANSIENT in-flight/shimmer flag — never persist it (strip in `saveTabs`, reset in `loadTabs`); dedup generation via the runtime `titleInFlight` set, or a tab saved mid-generate strands "generating forever" and the dedup guard blocks every future rename.

## Title-lock + server-durable user-set names (DEPLOYED — u2 2026-06-06, u3 2026-06-10)

**u2 (committed, `49524980a67`): explicit `titleLocked`.** The old `LEGACY_2WORD_PHRASE_RE` heuristic inferred "is this title user-meaningful?" from string shape and could mis-fire (a custom/auto title clobbered by the server `cookiePhrase` on the next `loadSessions()` — the bug "renamed/auto titles don't survive restart"). Fix: a persisted per-tab boolean `titleLocked` (in `localStorage["tinker.tabs"]`), set TRUE on manual rename AND on a successful auto-name. `loadSessions()` reconciliation never overwrites a `titleLocked` tab's title. The `🏠 Main` force-reset is preserved.

**u3 (committed 2026-06-10): the name is now DURABLE SERVER-SIDE.** `titleLocked` alone only protected a name while THIS browser's localStorage survived — so a manual/auto name was still LOST when a computer restart cleared/replaced the browser store (different profile, ephemeral/relay browser, origin change), at which point the tab fell back to the server's re-minted fortune `cookiePhrase`. The proper fix persists the deliberate name in `sessions.json` so it is independent of any browser:

- **`SessionEntry.cookiePhraseUserSet?: boolean`** (`src/config/sessions/types.ts`), mirrored on the list-row type (`src/gateway/session-utils.types.ts`) and surfaced by `buildGatewaySessionRow`. TRUE means `cookiePhrase` holds a user-chosen / auto DISPLAY NAME, not a random fortune.
- **Lazy-mint skip** (`session-utils.ts` `listSessionsFromStore`): `if (entry.cookiePhraseUserSet) continue;` BEFORE the `fortuneForKey(key)` re-mint, so the fortune never overwrites a deliberate name. (Retires the old, now-false comment "customised phrases can't reach this path".)
- **Write path** (`sessions-patch.ts` + schema `sessions.ts`): `sessions.patch` accepts `cookiePhraseUserSet`; it is auto-cleared when `cookiePhrase` is cleared.
- **Webchat guard** (`server-methods/sessions.ts`): a display-name-ONLY patch (`isDisplayNameOnlyPatch` = keys ⊆ {key, cookiePhrase, cookiePhraseUserSet}) is exempt from `rejectWebchatSessionMutation`, so the Tinker UI (a webchat client, NOT CONTROL_UI) can persist a name. Every other session-metadata mutation stays blocked; the `sessions.pluginPatch` guard is untouched.
- **Client** (`app.ts`): `openTabRename` and `generateTabTitle` call `persistTabNameToServer(tab)` → `sessions.patch {key, cookiePhrase: tab.title, cookiePhraseUserSet:true}` (fire-and-forget). On load, when a session has `cookiePhraseUserSet`, `loadSessions()` reconciliation ADOPTS the server name AND re-locks the tab (`titleLocked=true`) regardless of phrase shape — this is what brings a renamed/auto name back after a localStorage wipe. The two attach paths (`attachSessionToTab`, side-panel open) also lock the tab when the server name is user-set.

Net: `localStorage["tinker.tabs"]` is now a fast CACHE; `sessions.json`'s `cookiePhrase` (+ `cookiePhraseUserSet`) is the durable source of truth for a deliberate name. Custom/auto names survive hard refresh, gateway restart, **computer restart, a different browser, AND a different device**. See `bug-log.md` FIXED [ui-state-clear] (2026-06-06) + the u3 entry (2026-06-10).

## Auto-title mechanism — cc-bridge Sonnet RPC + clone kick (DEPLOYED — u4, 2026-06-25)

The auto-titler's MODEL PATH and TRIGGERING were reworked. The u3 prompt-shaping rules (user-prompt-primary, sibling-distinct, one emoji + 2-4 words) are unchanged.

**Model path: a dedicated gateway RPC, not a privileged subagent and not Ollama.** `generateTabTitle()` builds the prompt client-side, then the client helper `spawnTitleViaBridge` calls **`sessions.suggestTitle {sessionKey, prompt}`** (`app.ts`). The handler (`server-methods/sessions.ts`) runs **`suggestTitleViaBridge()`** (`server-methods/suggest-title.ts`): a one-shot `runEmbeddedPiAgent({provider:"claude-code", model:"claude-sonnet-4-6", disableTools:true, …})` in a throwaway `temp:title-suggest` session, returning the first non-empty payload text. This is **subscription-billed via the cc-bridge — NOT the metered Anthropic API, NOT Ollama, NOT Gemini.**

- **Why a new RPC (not the old path):** the title used to be generated by a webchat-issued `fork.subagents.spawn`, but that method is `operator.admin`-scoped and the Tinker UI is a webchat client (`operator.read`) → the spawn was scope-rejected and **no title was ever generated**. `sessions.suggestTitle` is added to the READ_SCOPE group (`method-scopes.ts`) so the webchat can call it; the privileged bridge run happens server-side. (commit `ef337eb1dd`)
- **45s timeout (was 15s).** The cc-bridge **cold-spawns a full `claude` CLI worker per title** (persona + plugins), so most of the wall-clock is worker startup, not generation (observed ~3.4s gen but ~11–16s spawn → 14–19s total). At `timeoutMs: 15_000` the run hit `FailoverError: LLM request timed out`, `suggestTitleViaBridge` returned `null`, and the tab silently failed to rename. Raised to **`timeoutMs: 45_000`** (commit `00c8e5b79b`). The client `req()` has no timeout (it waits for the gateway), so 45s is the only cap. A leak of ~500 transient `llm-client-*` systemd units (one per spawn, never reaped) had progressively slowed spawns; a gateway restart clears them. See `bug-log.md` FIXED [scope-mismatch+timeout-tuning] (2026-06-25).

**Clone auto-naming: an explicit kick.** The ONLY automatic trigger is the assistant-turn `end` handler; a **freshly cloned tab emits no turn-end event**, so it was never titled. (Seeding the clone's message buffer was a dead end — an active clone reads the global `messages` buffer that `loadChat()` overwrites, and a forked clone already carries the parent's user prompts server-side; the missing piece was the TRIGGER, not the buffer.) Fix: `cloneTab()` sets a module-level `pendingTitleKickTabId = clone.id`; `loadChat()`, once it has refilled the buffer for the active clone, kicks `generateTabTitle(clone)` exactly once — gated on the buffer actually having a user message, so an empty/lineage fork keeps its doubled-icon placeholder. See `tinker-ui.md` §5.8i for the clone fork/transcript itself.

**Doubled-title guard.** The cc-bridge **intermittently** doubles a one-shot's text payload (`"Fix auth bugFix auth bug"` — same family as the duplicate-served-text coalescing work). `generateTabTitle()`'s cleaning runs `collapseDoubled()` on both the full title and the word part: it collapses an EXACT first-half==second-half match (optionally with one separating space) when each half is ≥4 chars, leaving legitimate titles and short reduplications ("Go Go") untouched. This is a display-layer band-aid; the bridge double itself is a separate, deeper bug.

**In-flight shimmer.** While a title generates, the tab pulses (`tab.titleGenerating` → `.tab-renaming`). Generation is de-duped via a **runtime-only `Set` `titleInFlight`** keyed by tab id — NOT the persisted flag. `titleGenerating` is now stripped in `saveTabs()` and reset in `loadTabs()`; a persisted `titleGenerating=true` used to strand a tab "generating forever" and block every future rename.

The clone kick, doubled-title guard, and shimmer-dedup live in `tinker-ui/src/app.ts` (HMR-live; commit pending — `app.ts` is a contended hot file). The RPC, scope, and 45s timeout are committed (`ef337eb1dd`, `00c8e5b79b`).

## Verify

The executable invariants for this optic live in this file's YAML **frontmatter** `verify:` block (run by `pnpm bible:invariants`): the lazy-mint skips `cookiePhraseUserSet`; `SessionEntry` + the `sessions.patch` schema carry the flag; the webchat guard exempts only display-name-only patches; and the Tinker UI persists deliberate names server-side.
