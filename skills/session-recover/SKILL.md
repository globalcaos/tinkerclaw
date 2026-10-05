---
name: session-recover
description: Recover a chat transcript that was archived by `/clear`, `/new`, or `sessions.delete` and present it to the operator — or rebind it to a fresh tab he can keep using. Use this when the operator asks any of "recover my previous chat", "I cleared by mistake", "what was I asking about earlier in main", "open a tab with the old session", "bring back the conversation I just wiped", or similar. The archived JSONLs live on disk forever (soft-delete invariant, [[feedback_no_orphan_files]]); we don't lose them — we just have to find them.
metadata:
  openclaw:
    emoji: 🕰️
    why: Bug task-mpjhzu3j-ma9ts ("Tabs behavior") 2026-05-25 fix-stack ended with the operator asking that this procedure be made discoverable so Jarvis knows what to do when a recovery request lands. Before this skill existed, /clear archived transcripts perfectly but Jarvis had no documented playbook to surface them again.
---

# session-recover

Sessions in OpenClaw are **soft-archived**, never destroyed. `/clear`, `/new`, and `sessions.delete` all leave the original message JSONL on disk under a `<sessionId>.jsonl.<reason>.<ISO-timestamp>` filename. This skill documents how to find one and either summarise it back to the operator or rebind it to a tab.

## 1. Triggering language

Match if the operator says anything like:

- "recover my previous chat / main session / conversation"
- "I cleared by mistake / didn't mean to /clear"
- "what was I asking about before in main"
- "what was the chat I just wiped"
- "open a tab with the old session"
- "bring back that conversation about X"
- "is the chat from yesterday gone?"

If the request is ambiguous (e.g. "find that thing we discussed") **ask one disambiguating question first**: which session/channel and roughly when. Don't fan out across dozens of archived JSONLs without scope.

## 2. Where the archives live

For tab-main and any other OpenClaw session driven by cc-bridge / claude-cli, two parallel transcript stores exist:

| Layer                     | Location                                                          | Files                                                                                      |
| ------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| OpenClaw session JSONL    | `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`         | active (`.jsonl`), archived (`.jsonl.reset.<ts>`, `.jsonl.new.<ts>`, `.jsonl.delete.<ts>`) |
| **cleaning-lady archive** | `~/.openclaw/agents/<agentId>/sessions-archive/<sessionId>.jsonl` | **second location, easy to miss** — see warning below                                      |
| claude-cli native JSONL   | `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`                 | one file per claude-cli sessionId; cc-bridge mints a new one each spawn                    |

> ⚠️ **There are TWO archive locations, and the filenames differ.** The `sessions/` archives above are renamed with a `.reset/.new/.delete.<ts>` suffix. The nightly `cleaning-lady` cron _moves_ stale subagent/cron transcripts into a **separate `sessions-archive/` directory keeping the plain `<sessionId>.jsonl` name** — no reason suffix, so every reason-suffix glob in this skill misses them entirely. Always search both directories before telling the operator a transcript is gone. (Noted 2026-08-07: 114 files were already sitting there unsearchable; the move had additionally been silently broken by a wrong field name since the cron was written, so this pile will now grow as designed rather than staying frozen.)

For the default single-agent setup `<agentId>` is `main`. For a typical Linux cwd of `~/src/tinkerclaw`, `<cwd-slug>` is `-home-globalcaos-src-tinkerclaw`.

The archive filename always carries the **reason** (`reset` = `/clear`, `new` = `/new`, `delete` = `sessions.delete`) and an **ISO-8601 timestamp** with colons rewritten to dashes (e.g. `1a498388-...jsonl.reset.2026-05-22T06-20-24.567Z`).

## 2.5. ⚡ DO THIS FIRST — diff what the gateway SERVES against what the store HOLDS

Before hunting for archives, spend one command establishing whether the session is missing at all.
The panel renders **`sessions.list`**, not `sessions.json`. A row can be present in the store and
still be invisible, and every check against the file will say "healthy" while the operator sees nothing.
On 2026-08-12 that mismatch cost three rounds of misdiagnosis.

```bash
openclaw gateway call sessions.list --json 2>&1 | sed -n '/^{/,$p' > /tmp/served.json
openclaw gateway call sessions.list --params '{"includeDeleted":true}' --json 2>&1 | sed -n '/^{/,$p' > /tmp/all.json
python3 -c "
import json
s={x['key'] for x in json.load(open('/tmp/served.json'))['sessions']}
a=json.load(open('/tmp/all.json'))['sessions']
hid=[x for x in a if x['key'] not in s]
print('hidden from the panel:',len(hid))
for x in hid: print(' ',x['key'],'|',(x.get('cookiePhrase') or '(no name)')[:40])"
```

**If rows appear here, they were DELETED, not evicted — and nothing is lost.** `sessions.delete`
soft-deletes: it stamps `deletedAt` on the entry (`server-methods/sessions.ts`) and
`listSessionsFromStore` (`session-utils.ts`) hides any stamped row unless `includeDeleted:true`.
Both UI delete buttons (panel bin icon, alt-view delete) go through it.

**Restoring** currently requires a store edit — there is no `sessions.restore` RPC and
`sessions.patch` cannot clear the field (`additionalProperties:false`, no `deletedAt`):
stop the gateway, delete the `deletedAt` key from each entry in `sessions.json`, restart.
Filed as a defect in `~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/bug-log.md` (2026-08-12) — if a
`Deleted` folder or restore action exists in the panel by the time you read this, use that instead.

## 3. Step-by-step recovery

### 3.1. Find the candidate file

```bash
# Most recent archive across all sessions on this agent (last 14 days).
# Searches BOTH archive locations. They need different name filters: sessions/ archives
# carry a reason suffix, while cleaning-lady's sessions-archive/ keeps the plain name —
# so matching bare '*.jsonl' in sessions/ too would drown the list in ~1300 LIVE sessions.
{ find ~/.openclaw/agents/main/sessions/ -maxdepth 1 \
    \( -name '*.jsonl.reset.*' -o -name '*.jsonl.new.*' -o -name '*.jsonl.delete.*' \) \
    -mtime -14 -printf '%T@ %p\n'
  find ~/.openclaw/agents/main/sessions-archive/ -maxdepth 1 \
    -name '*.jsonl' ! -name '*.trajectory.jsonl' \
    -mtime -14 -printf '%T@ %p\n' 2>/dev/null
} | sort -rn | head -20
```

If the operator said "from main", filter further by cross-referencing the **previous** `sessionId` for `agent:main:main` (just before the `/clear` happened). The current value is in `sessions.json`; the prior one is recoverable from the archive file's _base name_ — the part before `.reset.`. Often the most-recent `.reset.<ts>` in the directory IS the one he just cleared.

If the operator said "about <topic>", grep across recent archives:

```bash
grep -l --include='*.reset.*' -r 'topic-keyword' ~/.openclaw/agents/main/sessions/ \
  -- *.reset.* 2>/dev/null | head -5
```

**Conceptual tab names (added 2026-08-21).** the operator may name a context by its subject (for example, “Skylight”) even when that word appears in neither the session key nor its generated label. Do not assume he means a browser tab merely because he says “tab.” Search in this order: (1) served + deleted session metadata, (2) user/assistant message bodies across live and archived JSONLs, including `.deleted.*` and `.bak-*`, (3) Engram events and indexed memory/FTS for topic synonyms and translated terms. Once a transcript is found, map its `sessionId` back through `sessions.json`; a still-registered `tinker:` key means the original context is reopenable without rebinding. Report the latest known external-action state from the transcript (for example, drafts later confirmed sent), not merely the state at the first matching turn.

### 3.2. Inspect what you found

Each JSONL line is one envelope. Read in order:

```bash
# Number of messages and a sense of the conversation
wc -l <path>
jq -r 'select(.role) | "\(.role): \(.content | tostring | .[0:120])"' <path> | head -40
```

If `jq` is missing, fall back to `python3 -c "import json,sys; [print(json.loads(l).get('role',''),':',str(json.loads(l).get('content',''))[:120]) for l in open(sys.argv[1])]" <path>`.

### 3.3. Pick a path: SUMMARISE vs REBIND

Ask the operator which he wants — or infer from his phrasing:

**SUMMARISE** ("what were we talking about", "remind me what I asked"): read the archive inline and synthesise — list what was decided, what's still open, what files were touched. No file mutation.

**REBIND** ("open a tab with the old session", "let me continue from where I left off"): the active sessionFile for the chosen OpenClaw key needs to point at the archived JSONL again.

> ⚠️ **FIRST check it's actually an ARCHIVE and not a still-live session.** A _closed Tinker tab_ is NOT a `/clear` — closing a tab just drops it from the browser's localStorage tab list; the OpenClaw session stays registered in `sessions.json` and keeps appearing in `sessions.list`.
>
> ⚠️ **CORRECTION 2026-08-12 — "stays registered" does NOT imply "keeps appearing".** Closing a tab is harmless, but _deleting_ one (panel bin icon / alt-view delete) soft-deletes the session: the entry stays in `sessions.json` with a `deletedAt` stamp and `sessions.list` stops serving it. So a row can be registered and invisible at the same time, and the check below — "is it still listed?" — will answer NO for a session that was never archived. Run §2.5 before trusting either answer. Verify before any rebind: `openclaw gateway call sessions.list --json | python3 -c "import json,sys;[print(s['key'],repr(s.get('cookiePhrase'))) for s in json.load(sys.stdin)['sessions']]"`. If the session is still listed, **there is nothing to rebind** — it's already reopenable from the Tinker SESSION side panel (see "Closed-tab fast path" below). Only sessions with a `.jsonl.reset/.new/.delete.<ts>` archive filename need REBIND.

**Closed-tab fast path (the common case — 2026-06-25):** Tinker tabs are client-side only. A cloned/dashboard tab is keyed `agent:main:dashboard:<uuid>`, NOT `agent:main:tinker:<id>`. In the UI's `classifySession` (`tinker-ui/src/app.ts`), only `:tinker:`/`:main`/`:heartbeat`/`:cron`/`:whatsapp`/`:subagent` keys get a named group; **a `dashboard:` key falls through to the "other" group** at the BOTTOM of the SESSION panel. The row IS there (labeled by its `cookiePhrase`, e.g. "🤝🤝 Html inline") — the operator just has to scroll to **"other"** and click it; that mints a fresh tab attached to the existing session with full transcript. So "my closed tab vanished from the panel" usually = "it's in the 'other' group, not where I expected." No mutation needed.

Two rebind implementations (only for genuine archives):

#### REBIND-A: clone the archive into a fresh session slot (safe, recommended)

> ❌ **`sessions.patch` does NOT accept `sessionFile`/`displayName`** (verified 2026-06-25: schema rejects them — it only patches `model` and similar metadata). There is no `sessions.rename`.
>
> ✅ **CORRECTION 2026-08-23 — `sessions.patch` DOES accept `cookiePhrase`.** Verified live:
> `openclaw gateway call sessions.patch --params '{"key":"agent:main:tinker:<id>","cookiePhrase":"🪟 New label"}'`
> returns the updated entry with `cookiePhraseUserSet:true`. This does not rebind anything, but it is
> the cheap **preventive** close to a topic-search miss: once you have found the session the operator
> described by subject, RENAME it so the subject appears in the label, or the same lookup fails again. The real binding lives in `sessions.json` as `<key> -> { sessionId, sessionFile, ... }`. Options that actually work:
>
> - **`sessions.fork`** (`{key, label?}`) — the gateway-safe clone primitive (powers Tinker "Clone tab"); it `forkFrom`s the transcript into a NEW session under a fresh `dashboard:` key. Caveat: that new key ALSO lands in the "other" group, so it doesn't fix discoverability — it just makes a safe copy.
> - **Direct `sessions.json` edit** (gateway stopped first, else the in-memory store clobbers your write): copy the archive to a fresh `<uuid>.jsonl`, add a `agent:main:tinker:recover-<short>` entry mirroring an existing tinker entry's shape (`sessionId`, `sessionFile`, `origin`, `chatType`...), restart gateway. The `tinker:` prefix makes it show in the pinned group.

#### REBIND-B: restore in place over tab-main (destructive — last resort)

Only if the operator explicitly says "put it back where it was":

1. Stop the gateway briefly so no in-flight write races: `openclaw gateway call admin.pause` (if available) OR `systemctl --user stop openclaw-gateway`.
2. Read current `agent:main:main.sessionFile` from `sessions.json`. That points at the EMPTY post-`/clear` jsonl.
3. Atomic swap: `mv <archive-path> <currentSessionFile>` (or `cp` + `truncate` of the new one to preserve invariant naming).
4. Restart the gateway. Hard-refresh Tinker UI.
5. The transcript reappears in tab-main.

Prefer REBIND-A. The destructive variant loses any messages sent into the new empty session between `/clear` and now (the operator might have started over).

## 4. Don'ts

- **Don't `rm` archives.** Soft-delete invariant — the operator's working assumption is they live forever. Even a 6-month-old `.reset.*` might be needed.
- **Don't recover silently.** Always tell the operator what you found (timestamp + first user line) before mutating anything. A miss-fire here is impossible to undo without another recovery.
- **Don't try to "re-send" the conversation through the model.** That re-bills tokens and produces a different transcript. Recovery is a file operation, not a replay.
- **Don't conflate cc-bridge's `~/.claude/projects/<cwd>/<sessionId>.jsonl`** with the OpenClaw archive. The cc-bridge file is keyed by claude-cli sessionId (one per spawn) and _isn't_ renamed on `/clear` — it just stops being referenced. Useful as a secondary source if the OpenClaw archive is gone or corrupted, but the primary path is the OpenClaw `.reset.<ts>` archive.

## 5. Verification before declaring "done"

After any rebind:

```bash
openclaw gateway call chat.history --params '{"sessionKey":"<newKey>","limit":10}' \
  | jq '.messages | length'
```

Should return a non-zero count matching the archived JSONL's line count. If it returns 0, the rebind didn't stick — most likely `sessionFile` field naming drift or the archive wasn't readable.
