---
file: session-naming.md
purpose: Single source of truth for how every visible name on a session is generated, persisted, and rendered. Captures the current state, the divergence bugs we hit, and the unified contract.
audience: AI
last_verified: 2026-05-24
last_verified_commit: HEAD
single_owner: yes — anything about session/tab naming, fortune cookies, label-resolution priority lives ONLY here. cookiePhrase, tab.title, label, displayName all funnel through one chain documented below.
see_also: tinker-ui.md §5.69 (sessions list — server-resolver hardening), bug-log.md FIXED [config-dead-code] 2026-05-24 (gateway-rebuild gotcha that hid Bug 1 of `task-mpjhzu3j-ma9ts` for two hours).
status: DEPLOYED 2026-05-24 second pass — the unified contract below is what ships. The first pass invented a server-side 2-word generator that was wrong; deleted. The user-curated FORTUNE_COOKIES pool (200+ long greetings with emoji) is the only phrase source.
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

4. **Auto-title** (Gemini-generated topic phrase from the chat content) — fires after the first turn.
   - Sets `tab.title` to a topic summary like `"🔧 Fix auth bug"`. The user-meaningful customisation path; should always win over the random fortune.

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

- Never re-introduce a server-side `cookiePhrase` generator. `cookiePhrase` is stored-only; the client owns the mint.
- Never re-introduce a 2-word format. `FORTUNE_COOKIES` is the only pool.
- Auto-title (Gemini topic phrase) STILL wins over cookiePhrase. Don't break that by clobbering `tab.title` unconditionally. The `looksLikeLegacy2WordPhrase` gate IS what protects auto-titles — any title that doesn't match the legacy regex is treated as user-meaningful.
- **(2026-06-06, in progress)** Prefer the EXPLICIT `titleLocked` flag over the `LEGACY_2WORD_PHRASE_RE` heuristic to decide whether `loadSessions()` may overwrite a `tab.title`. A locked title (manual rename or successful auto-name) is NEVER clobbered by the server `cookiePhrase`. See the amendment section below.

## In-progress amendment: explicit title-lock (2026-06-06)

**Status:** HMR-live, **uncommitted** (recovery patch jarvis-icu `9fe305a`; not yet on develop).

The `LEGACY_2WORD_PHRASE_RE` heuristic (above) infers "is this title user-meaningful?" from string shape — and can mis-fire: a custom/auto title could be clobbered by the server `cookiePhrase` on the next `loadSessions()`, which is exactly the bug "renamed/auto titles don't survive restart." Fix: a persisted per-tab boolean `titleLocked` (in `localStorage["tinker.tabs"]`), set TRUE on manual rename AND on a successful auto-name. `loadSessions()` reconciliation now **never overwrites a `titleLocked` tab's title**; it only syncs the server phrase into tabs whose title is still a default/fortune (unlocked). Custom/auto names then survive both hard refresh AND gateway restart (localStorage is browser-side, independent of the gateway). The `🏠 Main` force-reset is preserved. The legacy regex + its migration branch can be retired once `titleLocked` ships. See `bug-log.md` FIXED [ui-state-clear] (2026-06-06, tab titles).

## Verify (proposed for next ship)

```yaml
verify:
  - name: server-side cookie-phrase generator REMOVED (FORK 2026-05-24 second pass)
    cmd: |
      python3 -c '
      import os
      assert not os.path.exists(os.path.expanduser("~/src/tinkerclaw/src/gateway/session-cookie-phrase.ts")), "session-cookie-phrase.ts must not exist — server-side generation was the wrong approach (2-word output) and was removed. cookiePhrase is now stored-only; client mints from FORTUNE_COOKIES."
      '
  - name: addTab uses randomFortune (the FORTUNE_COOKIES pool)
    cmd: |
      python3 -c '
      import re, os
      t = open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read()
      m = re.search(r"function addTab\([^{]*\{(.*?)^\}", t, re.S | re.M)
      assert m, "addTab block not found"
      block = m.group(1)
      assert "randomFortune()" in block, "addTab must mint via randomFortune() from FORTUNE_COOKIES"
      assert "randomCookiePhrase" not in block, "randomCookiePhrase (legacy 2-word) must not appear"
      '
  - name: sessions.patch schema accepts cookiePhrase
    cmd: |
      python3 -c '
      import os
      t = open(os.path.expanduser("~/src/tinkerclaw/src/gateway/protocol/schema/sessions.ts")).read()
      assert "cookiePhrase: Type.Optional" in t, "SessionsPatchParamsSchema must accept cookiePhrase or the client cannot persist the burned-in name"
      '
```
