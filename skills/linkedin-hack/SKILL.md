---
name: linkedin-hack
version: 1.2.2
description: "Your agent crawls LinkedIn through the browser session you already have — profiles, search, connections, inbox, feed. No official API, no app review. Your cookies never leave the browser: API calls are a fetch() run inside the linkedin.com tab you shared (people-search navigates that tab to a LinkedIn search page and reads the results), and 1.2.1 DELETED the cookie-extraction, session-store and external-replay code from the package rather than leaving it switched off — there is no longer anything to store or steal. Every request, navigation and tab pick is pinned to exactly https://www.linkedin.com, including the LINKEDIN_TARGET_ID override, so a look-alike host cannot borrow your session. Reads and drafts freely; the one write, message-send, needs per-action consent that repeats the exact conversation URN, and without it you get the draft and nothing is sent. The browser relay must be a literal loopback IP, with no override. Daily ceilings count every record requested and are reserved before the request goes out. Built for the TinkerClaw fork — github.com/globalcaos/tinkerclaw. See Permissions, Data Flow & Consent."
metadata:
  openclaw:
    emoji: "🔗"
    os: ["linux", "darwin"]
    requires:
      # Must match the permissions block below, one for one.
      capabilities:
        ["browser", "network", "credentials", "shell", "file_read", "file_write", "file_delete", "env_read"]
      bins: ["node"]
    notes:
      security: "Rides a LinkedIn session cookie (li_at + JSESSIONID) that is password-equivalent — whoever holds it is signed in as you, with no password prompt and no second factor. So this version never holds it: every Voyager call is a fetch() executed INSIDE the linkedin.com tab you shared, the cookies stay in the browser, and there is no code left that extracts, stores or replays them. Removed outright in 1.2.1 (deleted, not disabled): the cookie extractor (session extract-cdp / extract-browser), the session store (session store, the OS-keychain write and the 0600 plaintext file, along with --allow-plaintext-store), the external cookie-replay transport and its automatic fallback (LINKEDIN_TRANSPORT), and the LINKEDIN_ALLOW_REMOTE_RELAY escape hatch. Origin pinning: every request target, every tab navigation and every tab pick must be exactly https://www.linkedin.com, compared by parsed origin, so www.linkedin.com.evil.example, a bare linkedin.com, plain http and a non-default port are all refused — and LINKEDIN_TARGET_ID goes through the same check instead of being trusted blind, which previously allowed script execution in any shared tab. Requests are additionally confined to /voyager/api/, and the in-page fetch re-checks same-origin before sending, so the csrf-token can never be carried to another host. The browser relay must be a literal loopback IP (127.0.0.0/8 or [::1]) — hostnames, localhost included, are refused rather than resolved, so DNS rebinding cannot move it — with no override, because that channel is full control of a signed-in tab. The only write to LinkedIn is message-send, which requires per-action consent: --i-mean-it must repeat the exact conversation URN, so a blanket yes cannot be reused on another recipient; without it the message is printed as a draft and nothing is sent. Daily ceilings count RECORDS REQUESTED (each command's --top, or 1 per lookup), the full amount is reserved before the first request and not refunded, --top has a hard per-command maximum and an out-of-range value is rejected, limits in the activity file can only lower a ceiling, and the guard cannot be wound backwards (activity bump refuses a non-positive step). Off switch: `linkedin session logout` deletes the cached profiles and activity counters AND purges any session left behind by version <= 1.2.0, then prints LinkedIn's server-side revoke URL (https://www.linkedin.com/psettings/sessions) — logout is LOCAL ONLY and does not invalidate a cookie at LinkedIn. No keychain lookup exists in the code: logout runs only the fixed delete command, and session status does not query the keychain at all. Every deletion is guarded: absolute path, inside $HOME, regular file, never a symlink, and carrying the marker this skill stamps into its own files — except the legacy session file at its one fixed path, which is deleted on those structural checks alone because its contents are never opened. Caching other people's crawled profile data is OFF by default (LINKEDIN_CACHE=1, 12h TTL). See the Permissions, Data Flow & Consent section."
    env:
      - name: LINKEDIN_CACHE
        description: "Set to 1 to allow caching other people's crawled profile data on disk. OFF by default."
        required: false
        sensitive: false
      - name: LINKEDIN_PACE_MS
        description: "Fixed minimum interval between Voyager calls in ms (default 1500, floor 500). Deterministic: no jitter, no random pauses. Raising it only slows the skill down."
        required: false
        sensitive: false
      - name: LINKEDIN_CACHE_TTL_H
        description: "Profile/company cache lifetime in hours when the cache is enabled (default 12, capped at 168)."
        required: false
        sensitive: false
      - name: LINKEDIN_CDP_URL
        description: "OpenClaw browser relay CDP websocket (default ws://127.0.0.1:18792/cdp). Must use a literal loopback IP; hostnames are refused."
        required: false
        sensitive: false
      - name: LINKEDIN_RELAY_HTTP
        description: "OpenClaw browser relay HTTP endpoint (default http://127.0.0.1:18792). Must use a literal loopback IP (127.0.0.1 or [::1]); hostnames, localhost included, are refused. There is no override."
        required: false
        sensitive: false
      - name: LINKEDIN_TARGET_ID
        description: "Pin the crawl to one specific shared tab by relay target id. The id must be a tab the relay is actually sharing AND that tab must be on exactly https://www.linkedin.com — it is not trusted blind."
        required: false
        sensitive: false
    # Declared capabilities. Each is used for exactly the reason given; anything
    # not listed here, the skill does not do.
    permissions:
      browser:
        required: true
        scope: "Drives one linkedin.com tab that YOU explicitly shared with the OpenClaw relay. This is full browser automation on that one tab, and it is worth naming precisely: it runs fetch() inside the page, NAVIGATES the tab to LinkedIn search URLs, and SCRAPES the rendered DOM of the results page (LinkedIn's SDUI broke the classic Voyager search endpoint, so people-search is a DOM read). It no longer reads the tab's cookies at all — that code was deleted in 1.2.1. The tab must be on exactly https://www.linkedin.com, re-checked from inside the page immediately before any script runs there, and navigation is pinned to the same origin, so the tab cannot be sent or spoofed anywhere else. Choosing the tab by LINKEDIN_TARGET_ID goes through the identical check. It cannot see or open any tab you have not shared, and it opens no tab of its own."
      network:
        required: true
        scope: "Outbound HTTPS to https://www.linkedin.com only, confined to /voyager/api/ and enforced by an exact-origin check on every target, plus the loopback OpenClaw relay at 127.0.0.1:18792. The relay address is overridable but must be a literal loopback IP — no hostname is resolved and relay redirects are refused — with no escape hatch. No third party, no telemetry, no analytics endpoint is ever contacted."
      credentials:
        required: true
        scope: "DELETE ONLY. This version reads, stores and replays no credential: your cookies stay inside the browser tab. The capability remains declared for one reason — `session logout` still deletes the OS-keychain entry and the 0600 file that versions <= 1.2.0 could create, so upgrading does not strand a password-equivalent cookie on your disk. The keychain is never queried for a value: logout runs only the delete command with its output discarded, and `session status` reports the keychain entry as not checked (it only tests whether the legacy FILE path exists, without opening it). logout deletes that legacy file without opening it either. No credential value is ever read into this process or printed."
      shell:
        required: true
        scope: "Runs exactly one binary per platform, with a fixed argument list and no shell interpreter: secret-tool (Linux) or security (macOS). It is used ONLY by `session logout` to delete a keychain entry left by version <= 1.2.0 (`secret-tool clear` / `security delete-generic-password`), output discarded. No lookup form of either command is ever run, and this version never writes a keychain entry. No other command is executed, ever."
      file_read:
        required: true
        scope: "Its own cache and activity counters under ~/.openclaw/workspace/memory/, plus an existence check (existsSync, not a read) on the legacy ~/.openclaw/credentials/linkedin-session.json path; logout deletes that file without opening it. It reads nothing else on your disk."
      file_write:
        required: true
        scope: "At most two files, both mode 0600, both under ~/.openclaw/workspace/memory: linkedin-activity.json (the daily counters) and linkedin-cache.json (crawled third-party profiles, written only when you set LINKEDIN_CACHE=1). Each is written to a 0600 sibling <name>.<pid>.tmp and renamed into place, and counter updates hold a short-lived 0600 linkedin-activity.json.lock that is removed when the update finishes. No credential file is written under any flag — that code path is gone. Nothing is written outside ~/.openclaw."
      file_delete:
        required: true
        scope: "`session logout` deletes the cache and counters by default (--keep-data keeps them) and purges any credential a version <= 1.2.0 left in the keychain or in ~/.openclaw/credentials/linkedin-session.json. Every deletion goes through one guard that requires the path to be absolute, inside $HOME, a regular file, NOT a symlink, and to carry the openclaw-linkedin-hack marker this skill stamps into the files it creates — so it cannot be pointed at anything it did not write. The one exception is the legacy session file at the fixed path ~/.openclaw/credentials/linkedin-session.json: it holds a cookie, so it is never opened to look for the marker and is deleted on the structural checks alone. The same guard also removes the counters' short-lived lock file. No other deletion path exists."
      env_read:
        required: true
        scope: "The LINKEDIN_* variables listed above. No secret is read from the environment, and none of them can widen a boundary: the relay must still be loopback and the target must still be the LinkedIn origin whatever they are set to."
repository: https://github.com/globalcaos/tinkerclaw
homepage: https://github.com/globalcaos/tinkerclaw
---

> One of dozens of skills and plugins in **[TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — a self-improving OpenClaw fork that's been running 24/7 for months.

No official LinkedIn API. No app review. No OAuth dance that dies in 60 days.

LinkedIn's product surface is a private REST API called **Voyager**. The website already talks to it with cookies from your signed-in browser. This skill does the same thing: share a `linkedin.com` tab, then crawl profiles / people search / companies / connections / inbox / feed from a zero-dep Node CLI.

**Part of [TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — real-time token tracking, self-improving crons, persistent cognitive memory.

👉 **https://github.com/globalcaos/tinkerclaw**

_Clone it. Fork it. Break it. Make it yours._

# LinkedIn Hack

<why_this_matters>
LinkedIn has no public API for any of this, so the honest options are "don't", or "use the session you already have, in the open". This skill takes the second one and tries to be boring about it: published daily ceilings, a fixed rate limit, sending gated behind an explicit flag, and the same "borrow the browser session" pattern as teams-hack / factorial-hack. It is built for research and inbox triage on your OWN account, with you present.

It is explicitly **not** built to evade anything. There is no jitter, no randomised "human" timing, no anti-detection logic — the pacing is deterministic and the limits are there to stop an agent quietly running up activity on your account, not to hide it from LinkedIn. Using it to bypass rate limits or automation controls is against LinkedIn's terms and is not a supported use case. Not for spray-and-pray outreach.
</why_this_matters>

<capabilities>
- Crawl through a **shared LinkedIn tab**. API calls are a `fetch()` inside that tab; `search people` navigates the tab to a LinkedIn search page and reads the results. Either way your cookies stay in the browser.
- Identity: `me`, `profile <vanity>` via Voyager in-tab fetch
- People search via search-results page DOM scrape (LinkedIn SDUI broke classic Voyager search)
- Company/profile/connections/inbox/feed: Voyager in-tab (best-effort where endpoints still live)
- **No credential store at all** — no cookie extraction, no keychain write, no plaintext file, no external replay. That code was **deleted** in 1.2.1, not switched off
- **Exact-origin pin**: every request, navigation and tab pick must be `https://www.linkedin.com` — including the `LINKEDIN_TARGET_ID` override, which used to be trusted blind
- Requests confined to `/voyager/api/`, and the in-page fetch re-checks same-origin before it sends
- Message send is the only write, and consent is **per action**: `--i-mean-it` must repeat the exact conversation URN. Without it you get the draft and nothing is sent
- Daily activity counters with published ceilings + a fixed, deterministic request interval that cannot be wound backwards
- Browser relay pinned to loopback, with **no override**
- One-command off switch: `session logout` — deletes local data **and** purges anything a version ≤ 1.2.0 stored, then points at LinkedIn's revoke page
</capabilities>

## Quick Start

### 0. Relay Preflight — DO THIS FIRST

Every call runs **through the OpenClaw browser relay**, which only exposes tabs the user actively clicked **Share** on. Empty tab list ≠ broken code.

1. Confirm relay is up: `GET http://127.0.0.1:<relayPort>/extension/status` → `connected:true`, `count>=1`
   (`<relayPort>` = `browser.profiles.chrome-relay.cdpUrl` in `~/.openclaw/openclaw.json`, usually `18792`)
2. List tabs (`GET /tabs` or `browser action=tabs`) and confirm a `linkedin.com` tab is shared. Grab its `targetId`.

If count is 0 or LinkedIn isn't listed: reload the OpenClaw extension (`chrome://extensions`) in the browser holding LinkedIn, click **Share** on the tab, re-check.

### 1. Share a tab (one-time, ~10 seconds)

Open `https://www.linkedin.com/feed/` while signed in, and share the tab via the OpenClaw extension. That is the whole setup.

**There is no session extraction step any more.** Every command works inside the tab you shared (`fetch()`, or for `search people` a navigation plus a page read), so `li_at` never leaves the browser. Version 1.2.1 removed the cookie extractor, the session store (keychain and plaintext alike) and the external cookie-replay transport **from the package** — they are not disabled behind a flag, they are gone. Nothing to store means nothing to leak, and nothing to re-extract when it expires.

Consequences worth knowing before you upgrade:

- `session extract-cdp`, `session extract-browser` and `session store` no longer exist. They exit `2` with an explanation rather than silently doing nothing.
- A tab must be shared for every run. There is no offline mode, because offline mode meant replaying a password-equivalent cookie from disk — and LinkedIn 302'd it anyway (observed 2026-07-29).
- If you used a previous version, run `session logout` once: it deletes the keychain entry and the `0600` file that version could create. `session status` cannot tell you whether the keychain entry exists — checking would mean reading the secret — so just run logout; it is a no-op when nothing is there.

**Do not burst.** A fixed minimum interval between calls is built in (`LINKEDIN_PACE_MS`, default 1500ms). One command at a time.

### 2. Verify

```bash
node {baseDir}/scripts/linkedin.mjs session check
node {baseDir}/scripts/linkedin.mjs me
```

### 3. Crawl

```bash
node {baseDir}/scripts/linkedin.mjs search people "warehouse director spain" --top 10
node {baseDir}/scripts/linkedin.mjs profile some-vanity-slug
node {baseDir}/scripts/linkedin.mjs company microsoft
node {baseDir}/scripts/linkedin.mjs connections --top 40
node {baseDir}/scripts/linkedin.mjs conversations --top 15
node {baseDir}/scripts/linkedin.mjs messages 'urn:li:msg_conversation:(…)' --top 30
node {baseDir}/scripts/linkedin.mjs feed --top 10
node {baseDir}/scripts/linkedin.mjs activity show
```

## How It Works

1. LinkedIn web uses cookies (`li_at` session + `JSESSIONID` / CSRF) for Voyager.
2. **The skill never handles them.** It attaches to the tab you shared over the local relay, checks from inside the page that `location.origin` is exactly `https://www.linkedin.com`, and evaluates a `fetch()` there. The browser attaches the cookies itself, same-origin, exactly as it does when you click around the site.
3. The in-page request carries `csrf-token` (the unquoted `JSESSIONID`) and `x-restli-protocol-version: 2.0.0`, and resolves its target against `location.origin` first — a cross-origin target is refused inside the page, so the CSRF token cannot be carried to another host.
4. Every target is checked twice before that: `buildUrl` refuses anything that is not exactly `https://www.linkedin.com` and inside `/voyager/api/`, and the tab it runs in is re-verified by origin equality rather than a substring match on "linkedin.com".
5. Responses are Rest.li "normalized" JSON (`data` + `included`). The CLI flattens the useful bits.

Same family as:

| Skill | Auth model | Stores secrets? |
| ----- | ---------- | --------------- |
| teams-hack / outlook-hack | MSAL refresh token from Teams localStorage | yes (`outlook-msal.json`) |
| factorial-hack | live page `fetch` (httpOnly cookies never leave browser) | no |
| **linkedin-hack** | in-tab fetch only (httpOnly cookies never leave browser) | no — the store was deleted in 1.2.1 |

linkedin-hack now sits in the same column as factorial-hack: the session stays in the browser, and the price is that a shared tab has to be open. That is the trade we took deliberately — the offline jar bought convenience with a password-equivalent secret at rest, and LinkedIn rejected it in practice anyway.

## Rate Guard (do not skip)

LinkedIn will challenge or ban aggressive automation. Daily ceilings and today's counts live in:

```
~/.openclaw/workspace/memory/linkedin-activity.json
```

Pacing (rewritten 2026-09-08): a **fixed, deterministic minimum interval** between Voyager calls — `LINKEDIN_PACE_MS`, default 1500ms, floor 500ms. Same input, same timing. The previous release randomised this interval and injected occasional long pauses to look more human; that was anti-detection behaviour, it has been **removed**, and what is left is plain rate limiting you can read off the source. Raising `LINKEDIN_PACE_MS` only ever slows the skill down. Throughput comes from **fat payloads**, never from parallelism — there is none in the code.

- Optional local cache at `~/.openclaw/workspace/memory/linkedin-cache.json`, **off unless you set `LINKEDIN_CACHE=1`** — `profile` and `company` results cached 12h (`LINKEDIN_CACHE_TTL_H`, capped at 168h; entries past the TTL are pruned on write). Cache hits cost zero requests and zero rate-guard counters. `--no-cache` forces live.
- `connections` defaults to `--top 100` in one request (Voyager happily serves fat pages), which reserves 100 of the 500 `connections_listed` for the day.

**What a counter counts: records requested.** Each command is charged the `count` it asks LinkedIn for — its `--top` (default shown below), or 1 for a single-entity lookup. The full amount is **reserved before the first request goes out**; a fallback request reuses that reservation and a failed request is not refunded. A value outside the per-call range is **rejected**, not clamped. Reservations are made under a lock file and written by atomic rename, so two runs at once cannot both pass the check and overshoot a ceiling. You can **lower** any ceiling by editing `limits` in that file; a higher number there is ignored.

| counter | ceiling / day | charged by | `--top` default / max |
| ------- | ------------- | ---------- | --------------------- |
| sessions | 15 | `session check` (1) | — |
| profile_views | 40 | `me`, `profile`, `company` (1 each, cache hit free), `posts` profile lookup (1) | — |
| search_results | 100 | `search people`, `search companies` | 10 / 25 (`--page` ≤ 40) |
| connections_listed | 500 | `connections` | 100 / 100 (`--start` ≤ 10000) |
| conversations_listed | 100 | `conversations` | 20 / 50 |
| messages_read | 200 | `messages` | 30 / 50 |
| feed_items | 100 | `feed` | 10 / 25 |
| notifications_read | 100 | `notifications` | 15 / 50 |
| posts_read | 100 | `posts` | 10 / 25 |
| messages_sent | 25 | `message-send` (1) | — |

Commands that would exceed a counter throw instead of calling Voyager, and book nothing.

`message-send` additionally requires **per-action** consent: `--i-mean-it` must repeat the exact conversation URN you are writing to, so an approval for one recipient cannot be reused on another. No consent, or consent naming a different conversation → the draft is printed, exit 2, no request.

Usage guidance for the agent, under the ceilings — this is about not wasting requests and keeping
a human in the loop, not about staying invisible:

- Ask for what you need. Prefer search → shortlist → deep profile over walking the whole graph.
- Keep it interactive. Never auto-connect or auto-message from a cron without an explicit,
  per-run human brief.
- If LinkedIn answers `429` or challenges you, **stop and tell the user**. Do not retry in a loop
  and do not try to work around it — that is the point at which the service is telling you no.

## Permissions, Data Flow & Consent

Read this before you install. It is the honest version.

### What it touches

- **One browser tab that you shared.** Every command runs `fetch` inside a `linkedin.com` tab you explicitly clicked **Share** on in the OpenClaw extension. The skill cannot reach a tab you did not share, and it opens nothing on its own.
- **Your LinkedIn session cookies — indirectly, and it never sees them.** Treat `li_at` as a password: it is a full sign-in as you, with no second factor. This version has no code that reads it. The browser attaches it to a same-origin request; the skill neither receives nor stores the value.
- **It navigates and scrapes that tab.** Naming this plainly, because it is more than passive API use: people-search works by sending the shared tab to a LinkedIn search URL and reading the rendered DOM (LinkedIn's SDUI broke the classic Voyager search endpoint). It is browser automation on a live, signed-in session, and you should treat it as such.
- **Two files, both mode 0600, both under `~/.openclaw/workspace/memory`** — the rate-guard counters (`linkedin-activity.json`) and the opt-in crawl cache (`linkedin-cache.json`), each written via a temp file and atomic rename; counter updates also hold a short-lived `linkedin-activity.json.lock`. No credential file is written under any flag. It reads nothing else on your disk.
- **One binary per platform, run with a fixed argument list and no shell** — `secret-tool clear` (Linux) or `security delete-generic-password` (macOS), run **only** by `session logout` to delete a keychain entry an older version could have created, with its output discarded. The code contains no keychain lookup.
- **The local browser relay, and only on loopback.** `LINKEDIN_CDP_URL` / `LINKEDIN_RELAY_HTTP` are overridable, so both are parsed and the host must be a **literal loopback IP** (`127.0.0.1`, anything in `127.0.0.0/8`, or `[::1]`). A hostname — `localhost` included — is refused rather than resolved, so a name that answers loopback at check time and something else at connect time (DNS rebinding) cannot get through, and the relay's HTTP redirects are refused. Anything else is refused outright — the `LINKEDIN_ALLOW_REMOTE_RELAY` escape hatch has been removed, because that channel is full control of a tab that is signed in as you.

### Where the secret lives

**In your browser, and nowhere else.** That is the whole answer, and it is the main change in 1.2.1.

Previous versions could persist the session: sealed in the OS keychain by default, or — with an explicit `--allow-plaintext-store` — in a `0600` file that expired after 24h. All of that is **deleted from the package**, along with the cookie extractor that fed it and the external replay path that consumed it. There is no flag, no environment variable and no fallback that writes a credential now.

What remains of that machinery is a **purge**: `session logout` still deletes the old keychain entry and the old file, so upgrading does not strand a password-equivalent cookie on your disk. It deletes blind — the keychain is never asked for the value, not even to check it exists. `session status` reports whether the old **file** is still there and marks the keychain entry as not checked. Run logout once after upgrading.

### What leaves your machine

- **To `https://www.linkedin.com` only:** the Voyager API calls you asked for, issued by your own browser from a tab that is already on that origin — exactly what the site sends when you use it normally. The origin is checked by parsed-origin equality on every target, so `www.linkedin.com.evil.example`, `https://linkedin.com`, plain `http`, and a non-default port are all refused.
- **To `127.0.0.1:18792`:** the local OpenClaw browser relay. That is loopback, not the network, and it is enforced rather than assumed.
- **To anyone else: nothing.** No telemetry, no analytics, no third-party host, no phone-home. The skill has zero dependencies, so there is no transitive package doing it either.
- **Outbound writes to LinkedIn:** exactly one endpoint, `message-send`, and it is refused unless `--i-mean-it` names the exact conversation URN.

### Third-party data, and the cost of it

Crawling LinkedIn means handling **other people's** personal data. So the disk cache is **off by default**: on the default path, nothing about the people you look up is ever written to your disk. Turn it on only if you want it:

```bash
LINKEDIN_CACHE=1 node {baseDir}/scripts/linkedin.mjs profile some-vanity-slug
```

When enabled it writes `~/.openclaw/workspace/memory/linkedin-cache.json` (0600, 12h TTL by default, capped at 168h, entries past the TTL pruned on every write). The only thing you lose by leaving it off is that a repeated lookup spends a request instead of being free. `session logout` deletes it.

You are responsible for what you do with that data. In the EU, scraped profile data is personal data under GDPR, and a lawful basis is your problem, not the tool's.

### What it costs

- **No API key, no subscription, no per-call fee.** LinkedIn has no official API here; this rides your own session.
- **The real cost is account risk.** LinkedIn restricts and bans accounts for automation, and this skill does not pretend otherwise or try to hide from it. That is why the ceilings are low, the rate limit is fixed, and there is no parallelism anywhere in the code. Automating a platform against its terms is a decision you are making; a ban is not reversible by this skill.
- **Session lifetime.** Bursts burn `li_at` — observed 2026-07-29: an external-transport burst dropped the session to a login wall. Slow is the feature.

### How to turn it off

```bash
node {baseDir}/scripts/linkedin.mjs session logout               # cache + counters + any legacy session
node {baseDir}/scripts/linkedin.mjs session logout --keep-data   # legacy session only; keep cache + counters
```

`logout` deletes the cached profiles and the activity counters, and purges any credential a version ≤ 1.2.0 left
in the keychain or at `~/.openclaw/credentials/linkedin-session.json`. Every one of those deletions is checked
first: absolute path, inside `$HOME`, a regular file, never a symlink, and carrying the marker this skill stamps
into files it created — so the off switch cannot be talked into removing anything else. The legacy session file
is the exception to the marker check: it is never opened, so it is removed on the other checks at its fixed path.

Stopping the crawl itself needs no command at all: **unshare the tab**, and there is no path left into your account.

It is **local only**, and the command says so before and after it runs. It prints LinkedIn's own revoke page:

**https://www.linkedin.com/psettings/sessions**

**Use it if you ever ran an older version** — that is the step that actually revokes a cookie someone may have copied. Deleting a local copy does not invalidate it at LinkedIn, and uninstalling the skill does not either. This skill has no way to revoke a LinkedIn session server-side, so it does not claim one.

### What it will not do

There is no endpoint in this skill for connecting, following, liking, posting, endorsing, or deleting. `message-send` is the only write, and it needs per-action consent naming the target conversation. It will not read your cookies, write a credential anywhere, talk to any host but `https://www.linkedin.com`, or accept a relay that is not on loopback — and there is no flag that changes any of those.

## CLI Reference

| Command | Description |
| ------- | ----------- |
| `session check` | `GET /voyager/api/me` inside the shared tab — confirms you are signed in. `session test` is kept as an alias |
| `session status` | Posture (transport, pinned origin, relay), today's counters and ceilings, and whether the legacy session **file** is still on disk. Does not query the keychain. Prints no secret |
| `session logout [--keep-data]` | Delete the cached profiles and counters **and** purge any session a version ≤ 1.2.0 stored; print LinkedIn's revoke URL. Local only. `--keep-data` keeps the cache and counters |
| `me` | Mini-profile |
| `profile <vanity>` | Profile + positions (+ education) |
| `search people "q" [--top N≤25] [--page N≤40] [--network F\|S\|O]` | People search |
| `search companies "q" [--top N≤25]` | Company search |
| `connections [--top N≤100] [--start N≤10000]` | 1st-degree connections |
| `company <vanity>` | Company page summary |
| `posts <vanity> [--top N≤25]` | Member share feed (best-effort) |
| `conversations [--top N≤50]` | Inbox list |
| `messages <urn> [--top N≤50]` | Thread events |
| `message-send <urn> --message "…" --i-mean-it <urn>` | Send. Consent is per action: `--i-mean-it` must repeat the exact URN. Without it, the draft is printed and nothing is sent |
| `feed [--top N≤25]` | Home feed (best-effort) |
| `notifications [--top N≤50]` | Notifications (best-effort) |
| `activity show` | Counters + limits |
| `activity bump <counter> [--by N]` | Manual counter bump. `N` must be positive — the guard cannot be wound backwards |

## Why there is no extraction step

`li_at` is `httpOnly`, so `document.cookie` never sees it, and reaching it at all meant asking CDP for the tab's
cookie jar and then keeping the result somewhere. Earlier versions did exactly that. The trouble is what you are
left holding: a password-equivalent, second-factor-free sign-in as you, sitting on disk, useful to anything that
can read a file — while the offline replay it enabled was rejected by LinkedIn in practice anyway (observed
2026-07-29: one external call worked, the rest 302'd, and the browser lost the session).

So 1.2.1 removed the reason to hold it. The request is issued by the page, the browser attaches the cookie
same-origin, and the skill never has a copy. Nothing to extract, nothing to store, nothing to rotate, nothing to
leak. The cost is honest and worth stating: **a shared tab has to be open for every call.**

Never paste `li_at` values into chat transcripts, git commits, or ClawHub packages — that advice outlives any one
skill.

## Failure Modes

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| `401` / `403` | Session expired or challenged | Re-login in the browser, open the feed, re-share the tab |
| `Shared tab is on …, not https://www.linkedin.com` | The tab navigated away, or the relay metadata was stale | Send that tab back to the feed and retry. Working as intended — it will not run in another origin |
| `429` | LinkedIn rate limit | Stop for minutes; do not retry in a loop |
| `Rate guard: daily …` | Daily ceiling hit | Wait for the next day (UTC). Limits in the activity file can only lower a ceiling |
| `--top must be an integer between …` | Value outside the per-command range | Ask for less; page with `--start` / `--page` |
| Empty search results | Voyager decorationId drift | CLI already falls back to `/search/hits`; re-check with `--raw` on profile if needed |
| `… points off loopback` | Relay URL uses a hostname (even `localhost`) or a non-loopback IP | Use `127.0.0.1` |
| `No https://www.linkedin.com tab in the relay` | No LinkedIn tab is shared | Share a feed tab via the OpenClaw extension |
| Tab on `/login` | Session burned (often after a request burst) | Human re-login, open feed, re-share the tab |
| `draft-only`, exit 2 | `--i-mean-it` missing, bare, or naming a different conversation | Intentional. Pass `--i-mean-it <the exact URN>` only when a human has approved that exact message to that exact thread |

## Architecture

```
linkedin-hack/
├── SKILL.md
├── scripts/
│   └── linkedin.mjs    # zero-dep CLI (in-tab voyager + origin pin + rate guard)
└── tests/
    ├── origin.test.mjs # the origin pin, as unit tests
    └── cli.test.mjs    # consent, relay and origin gates, end to end
```

Run them with `node --test tests/origin.test.mjs tests/cli.test.mjs` (Node 22+, no dev dependencies).

- **Zero external deps** — pure Node 22+ (`fetch` built-in)
- **Credentials** — none stored, none read. In-tab `fetch` only; the extractor, the keychain write and the plaintext file were deleted in 1.2.1. The one keychain helper is delete-only, for cleaning up after an older install; there is no keychain lookup
- **Origin pin** — one check (`assertLinkedInUrl`, exact `origin` equality) covers every request, navigation and tab pick, `LINKEDIN_TARGET_ID` included; requests are confined to `/voyager/api/` and re-verified same-origin inside the page
- **Activity** — `~/.openclaw/workspace/memory/linkedin-activity.json` (0600)
- **Cache** — off unless `LINKEDIN_CACHE=1`; then `~/.openclaw/workspace/memory/linkedin-cache.json` (0600, 12h TTL)
- **Relay** — literal loopback IP only, no hostname resolution, no redirects; there is no override
- **Rate guard** — records requested, reserved in full before the request under a cross-process lock; strict `--top` ranges; file limits can only lower a ceiling
- **Deletes** — one guarded helper: absolute, inside `$HOME`, regular file, not a symlink, marker-stamped (the legacy session file at its fixed path is deleted unopened, on the structural checks only)
- **API** — LinkedIn Voyager (`/voyager/api`), Rest.li normalized JSON
- **Off switch** — `node scripts/linkedin.mjs session logout`

## Sibling Skills

| Skill | What it does |
| ----- | ------------ |
| [teams-hack](https://clawhub.ai/globalcaos/teams-hack) | Teams chat via Graph + MSAL refresh |
| [outlook-hack](https://clawhub.ai/globalcaos/outlook-hack) | Outlook read/draft (send code-disabled) |
| [factorial-hack](https://clawhub.ai/globalcaos/factorial-hack) | Factorial HR GraphQL in-page |

## The Full Stack

Pair with [outlook-hack](https://clawhub.ai/globalcaos/outlook-hack) for email, [whatsapp-ultimate](https://clawhub.ai/globalcaos/whatsapp-ultimate) for messaging, and [teams-hack](https://clawhub.ai/globalcaos/teams-hack) for org chat.

[Clone it. Fork it. Break it. Make it yours.](https://github.com/globalcaos/tinkerclaw)

## Changelog

- **1.2.2** — `session status` no longer runs a keychain lookup (the value-returning `keychainGet` is deleted; logout deletes blind); daily ceilings now charge the full requested `--top` before the request, with strict per-command maximums and file limits that can only lower a ceiling; the relay must be a literal loopback IP (no DNS resolution, no redirects); logout deletes the legacy session file without opening it (no marker read); counter reservations are locked and written atomically so concurrent runs cannot overshoot a ceiling.
