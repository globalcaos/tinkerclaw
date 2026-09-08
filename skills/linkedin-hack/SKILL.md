---
name: linkedin-hack
version: 1.2.0
description: "Your agent crawls LinkedIn through the browser session you already have — profiles, search, connections, inbox, feed. No official API, no app review. Session cookies + Voyager. By default the cookies never leave your browser tab: persisting them requires the OS keychain, and if there is no keychain the skill refuses to save rather than dropping a password-equivalent cookie in a file. Sending a message needs an explicit flag, the relay must be on loopback, and `session logout` erases every local trace and hands you LinkedIn's revoke page. Built for the TinkerClaw fork — github.com/globalcaos/tinkerclaw. See Permissions, Data Flow & Consent."
metadata:
  openclaw:
    emoji: "🔗"
    os: ["linux", "darwin"]
    requires:
      # Must match the permissions block below, one for one.
      capabilities:
        [
          "browser",
          "network",
          "credentials",
          "shell",
          "file_read",
          "file_write",
          "file_delete",
          "env_read",
        ]
      bins: ["node"]
    notes:
      security: "Handles a LinkedIn session cookie (li_at + JSESSIONID, optional bcookie/bscookie). That cookie is password-equivalent: whoever holds it is signed in as you, with no password prompt and no second factor. Default transport is in-browser, so on the default path the cookies are never extracted at all. If you do persist a session, the OS keychain is the only store this skill will use on its own (secret-tool on Linux, security on macOS, entry openclaw-linkedin-hack/linkedin-session); the secret is passed over stdin on BOTH platforms so it never appears in argv or shell history, and the write is read back to confirm it landed. With no usable keychain, saving FAILS CLOSED and nothing is written — a 0600 file store exists but requires an explicit per-run --allow-plaintext-store (or LINKEDIN_ALLOW_PLAINTEXT_STORE=1), keeps only the fields needed to make a request, and self-expires after 24h. There is no switch that disables the keychain. Off switch: `linkedin session logout` clears BOTH stores AND deletes the cached profiles and activity counters by default (--keep-data opts out), then prints LinkedIn's server-side revoke URL (https://www.linkedin.com/psettings/sessions) — logout is LOCAL ONLY and does not invalidate the cookie at LinkedIn. Every deletion is guarded: absolute path, inside $HOME, regular file, never a symlink, and carrying the marker this skill stamps into its own files. The browser relay must resolve to loopback (LINKEDIN_ALLOW_REMOTE_RELAY=1 to override, with a warning), and the shared tab is only ever navigated within linkedin.com. The only endpoint that writes to LinkedIn is message-send, refused without --i-mean-it. Caching other people's crawled profile data is OFF by default (LINKEDIN_CACHE=1 to enable, 12h TTL). Daily ceilings live in ~/.openclaw/workspace/memory/linkedin-activity.json (0600). See the Permissions, Data Flow & Consent section."
    env:
      - name: LINKEDIN_TRANSPORT
        description: "browser (default, cookies stay in the shared tab) or external (offline cookie replay; fragile and burns li_at)."
        required: false
        sensitive: false
      - name: LINKEDIN_CACHE
        description: "Set to 1 to allow caching other people's crawled profile data on disk. OFF by default."
        required: false
        sensitive: false
      - name: LINKEDIN_ALLOW_PLAINTEXT_STORE
        description: "Set to 1 to permit the 0600 file store when no OS keychain exists. Without it, saving a session fails closed and nothing is written. Equivalent to --allow-plaintext-store."
        required: false
        sensitive: false
      - name: LINKEDIN_ALLOW_REMOTE_RELAY
        description: "Set to 1 to allow a browser relay that is not on loopback. Off by default because that channel carries your session cookies and full tab control."
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
        description: "OpenClaw browser relay CDP websocket (default ws://127.0.0.1:18792/cdp)."
        required: false
        sensitive: false
      - name: LINKEDIN_RELAY_HTTP
        description: "OpenClaw browser relay HTTP endpoint (default http://127.0.0.1:18792)."
        required: false
        sensitive: false
    # Declared capabilities. Each is used for exactly the reason given; anything
    # not listed here, the skill does not do.
    permissions:
      browser:
        required: true
        scope: "Drives one linkedin.com tab that YOU explicitly shared with the OpenClaw relay. This is full browser automation on that one tab, and it is worth naming precisely: it runs fetch() inside the page, reads the tab's cookies via CDP, NAVIGATES the tab to linkedin.com search URLs, and SCRAPES the rendered DOM of the results page (LinkedIn's SDUI broke the classic Voyager search endpoint, so people-search is a DOM read). Navigation is restricted in code to https://*.linkedin.com — the tab cannot be sent anywhere else. It cannot see or open any tab you have not shared, and it opens no tab of its own. This is the default transport, and on it the cookies are never extracted from the browser at all."
      network:
        required: true
        scope: "Outbound HTTPS to www.linkedin.com only (the /voyager/api endpoints), plus the loopback OpenClaw relay at 127.0.0.1:18792. No third party, no telemetry, no analytics endpoint is ever contacted."
      credentials:
        required: true
        scope: "Your LinkedIn session cookies (li_at, JSESSIONID, optional bcookie/bscookie/li_a/lidc). Read from the tab you shared, sealed in the OS keychain, replayed only against www.linkedin.com. Never printed: `session extract-cdp` reports cookie NAMES and LENGTHS, never values."
      shell:
        required: true
        scope: "Runs exactly one binary per platform, with a fixed argument list and no shell interpreter: secret-tool (Linux) or security (macOS), to seal, read and erase the keychain entry. The secret is written to that process's stdin, never passed as an argument, so it does not appear in ps output or shell history. No other command is executed, ever."
      file_read:
        required: true
        scope: "The keychain entry or ~/.openclaw/credentials/linkedin-session.json, plus its own cache and activity counters under ~/.openclaw/workspace/memory/. It reads nothing else on your disk."
      file_write:
        required: true
        scope: "At most three files, all mode 0600, all under ~/.openclaw: the credentials file (ONLY when there is no keychain AND you passed --allow-plaintext-store; minimal fields, 24h expiry), linkedin-activity.json (the daily counters), and linkedin-cache.json (crawled third-party profiles, written only when you set LINKEDIN_CACHE=1). Nothing is written outside ~/.openclaw."
      file_delete:
        required: true
        scope: "`session logout` clears the keychain entry and deletes all three files (credentials, cache, counters) by default; --keep-data keeps the cache and counters. A successful keychain write deletes any older file copy, and an expired file store is deleted on the next run that reads it. Every deletion goes through one guard that requires the path to be absolute, inside $HOME, a regular file, NOT a symlink, and to carry the openclaw-linkedin-hack marker this skill stamps into the files it creates — so it cannot be pointed at anything it did not write. No other deletion path exists."
      env_read:
        required: true
        scope: "The LINKEDIN_* variables listed above. No secret is read from the environment; the session comes from the browser or the keychain."
repository: https://github.com/globalcaos/tinkerclaw
homepage: https://github.com/globalcaos/tinkerclaw
---

> One of dozens of skills and plugins in **[TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — a self-improving OpenClaw fork that's been running 24/7 for months.

No official LinkedIn API. No app review. No OAuth dance that dies in 60 days.

LinkedIn's product surface is a private REST API called **Voyager**. The website already talks to it with cookies from your signed-in browser. This skill does the same thing: share a `linkedin.com` tab, extract the session once, then crawl profiles / people search / companies / connections / inbox / feed from a zero-dep Node CLI.

**Part of [TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — real-time token tracking, self-improving crons, persistent cognitive memory.

👉 **https://github.com/globalcaos/tinkerclaw**

_Clone it. Fork it. Break it. Make it yours._

# LinkedIn Hack

<why_this_matters>
LinkedIn has no public API for any of this, so the honest options are "don't", or "use the session you already have, in the open". This skill takes the second one and tries to be boring about it: published daily ceilings, a fixed rate limit, sending gated behind an explicit flag, and the same "borrow the browser session" pattern as teams-hack / factorial-hack. It is built for research and inbox triage on your OWN account, with you present.

It is explicitly **not** built to evade anything. There is no jitter, no randomised "human" timing, no anti-detection logic — the pacing is deterministic and the limits are there to stop an agent quietly running up activity on your account, not to hide it from LinkedIn. Using it to bypass rate limits or automation controls is against LinkedIn's terms and is not a supported use case. Not for spray-and-pray outreach.
</why_this_matters>

<capabilities>
- Crawl through a **shared LinkedIn tab** (browser transport — default). Cookies stay in-browser.
- Identity: `me`, `profile <vanity>` via Voyager in-tab fetch
- People search via search-results page DOM scrape (LinkedIn SDUI broke classic Voyager search)
- Company/profile/connections/inbox/feed: Voyager in-tab (best-effort where endpoints still live)
- Optional external cookie-jar transport (`LINKEDIN_TRANSPORT=external`) — fragile; often burns `li_at`
- Optional message send (hard-gated: requires `--i-mean-it`)
- Daily activity counters with published ceilings + a fixed, deterministic request interval
- Session sealed in the OS keychain (`secret-tool` / `security`) — secret over stdin, write verified by read-back
- No keychain? Saving **fails closed**. The 0600 file store needs an explicit `--allow-plaintext-store` and expires in 24h
- Browser relay pinned to loopback; the shared tab can only be navigated within `linkedin.com`
- One-command off switch: `session logout` — clears both stores **and** local data, then points at LinkedIn's revoke page
</capabilities>

## Quick Start

### 0. Relay Preflight — DO THIS FIRST

Extraction runs **through the OpenClaw browser relay**, which only exposes tabs the user actively clicked **Share** on. Empty tab list ≠ broken code.

1. Confirm relay is up: `GET http://127.0.0.1:<relayPort>/extension/status` → `connected:true`, `count>=1`
   (`<relayPort>` = `browser.profiles.chrome-relay.cdpUrl` in `~/.openclaw/openclaw.json`, usually `18792`)
2. List tabs (`GET /tabs` or `browser action=tabs`) and confirm a `linkedin.com` tab is shared. Grab its `targetId`.

If count is 0 or LinkedIn isn't listed: reload the OpenClaw extension (`chrome://extensions`) in the browser holding LinkedIn, click **Share** on the tab, re-check.

### 1. Session Extraction (one-time, ~30 seconds)

Open `https://www.linkedin.com/feed/` while signed in. Share the tab via the OpenClaw extension.

**Default transport is in-tab** (`LINKEDIN_TRANSPORT=browser`). No cookie extract required for crawl — share a feed tab and call commands, and the cookies never leave the browser.

Persisting the session is **opt-in**: without `--store`, `extract-cdp` only reports which cookies it can see (names and lengths, never values). Pass `--store` and the session is sealed in your OS keychain. If you have no keychain, the save **fails and nothing is written** — `--store` on its own is not consent to put a password-equivalent cookie in a file. Either install a keychain, or stay on the default browser transport, which needs no stored session at all:

```bash
node {baseDir}/scripts/linkedin.mjs session extract-cdp --store
node {baseDir}/scripts/linkedin.mjs session status    # says where it landed
node {baseDir}/scripts/linkedin.mjs session logout    # erases it from both stores
```

**Do not use external cookie replay as the main path.** Live 2026-07-29: external `/me` after extract worked once, then every further external call 302'd and the browser lost `li_at` (login wall). In-tab fetch does not burn the session the same way.

**Do not burst.** A fixed minimum interval between calls is built in (`LINKEDIN_PACE_MS`, default 1500ms). One command at a time after login.

**B. Fallback — evaluate in page** (usually misses httpOnly `li_at`):

```javascript
(() => {
  const want = ["li_at", "JSESSIONID", "bcookie", "bscookie", "li_a", "lidc", "liap"];
  const cookies = {};
  for (const part of document.cookie
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq);
    if (want.includes(k)) cookies[k] = part.slice(eq + 1);
  }
  return {
    cookies,
    csrf: cookies.JSESSIONID?.replace(/^"|"$/g, "") || null,
    has_li_at: Boolean(cookies.li_at),
    note: cookies.li_at ? "ok" : "li_at httpOnly — use browser cookies action",
  };
})();
```

Store it. Cookies are read from **stdin as JSON** — never as command-line flags, because argv is
readable by every process on the machine and lands in your shell history, and `li_at` is a password:

```bash
printf '%s' '{"li_at":"<value>","jsessionid":"<ajax:…>"}' \
  | node {baseDir}/scripts/linkedin.mjs session store
```

Optional keys: `csrf_token`, `bcookie`, `bscookie`, `li_a`, `lidc`. `csrf_token` defaults to the
unquoted JSESSIONID (Voyager's usual rule). Better still, skip the copy-paste entirely and use
`session extract-cdp --store`, where the value is never typed anywhere.

### 2. Verify

```bash
node {baseDir}/scripts/linkedin.mjs session test
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
2. **Only if you asked it to persist**, the skill seals those cookies in your **OS keychain** (`secret-tool` on Linux, `security` on macOS, entry `openclaw-linkedin-hack/linkedin-session`). The value goes over the helper's **stdin on both platforms**, so it never appears in `ps` or shell history, and the write is **read back** before the skill reports success. With no usable keychain it **refuses to save**; the `0600` file at `~/.openclaw/credentials/linkedin-session.json` happens only with an explicit `--allow-plaintext-store`, keeps only the fields needed to make a request, expires after 24h, and warns loudly. Only one copy is ever kept: a successful keychain write deletes the file.
3. CLI replays them against `https://www.linkedin.com/voyager/api/*` with:
   - `csrf-token: <unquoted JSESSIONID>`
   - `Cookie: li_at=…; JSESSIONID="…"; …`
   - `x-restli-protocol-version: 2.0.0`
   - desktop Chrome UA + linkedin.com Origin/Referer
4. Responses are Rest.li "normalized" JSON (`data` + `included`). The CLI flattens the useful bits.

Same family as:

| Skill                     | Auth model                                               | Stores secrets?                                                           |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| teams-hack / outlook-hack | MSAL refresh token from Teams localStorage               | yes (`outlook-msal.json`)                                                 |
| factorial-hack            | live page `fetch` (httpOnly cookies never leave browser) | no                                                                        |
| **linkedin-hack**         | in-tab fetch by default; cookie jar optional             | only if you ask — OS keychain, or an opt-in 0600 file that expires in 24h |

LinkedIn needs the offline jar because Voyager is same-site cookie auth and we want CLI use without a live tab on every call. Re-extract when you get 401/403.

## Rate Guard (do not skip)

LinkedIn will challenge or ban aggressive automation. Soft daily ceilings live in:

```
~/.openclaw/workspace/memory/linkedin-activity.json
```

Pacing (rewritten 2026-09-08): a **fixed, deterministic minimum interval** between Voyager calls — `LINKEDIN_PACE_MS`, default 1500ms, floor 500ms. Same input, same timing. The previous release randomised this interval and injected occasional long pauses to look more human; that was anti-detection behaviour, it has been **removed**, and what is left is plain rate limiting you can read off the source. Raising `LINKEDIN_PACE_MS` only ever slows the skill down. Throughput comes from **fat payloads**, never from parallelism — there is none in the code.

- Optional local cache at `~/.openclaw/workspace/memory/linkedin-cache.json`, **off unless you set `LINKEDIN_CACHE=1`** — `profile` and `company` results cached 12h (`LINKEDIN_CACHE_TTL_H`, capped at 168h; entries past the TTL are pruned on write). Cache hits cost zero requests and zero rate-guard counters. `--no-cache` forces live.
- `connections` defaults to `--top 100` in one request (Voyager happily serves fat pages).

Defaults (override by editing `limits` in that file):

| counter          | default / day |
| ---------------- | ------------- |
| profile_views    | 40            |
| messages_read    | 200           |
| messages_sent    | 25            |
| connections_sent | 15            |
| likes            | 40            |
| sessions         | 15            |
| total_minutes    | 90            |

Commands that would exceed a counter throw instead of calling Voyager.

`message-send` additionally requires `--i-mean-it`. No flag → exit 2, no request.

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

- **One browser tab that you shared.** The default transport runs `fetch` inside a `linkedin.com` tab you explicitly clicked **Share** on in the OpenClaw extension. The skill cannot reach a tab you did not share, and it opens nothing on its own.
- **Your LinkedIn session cookies** — `li_at`, `JSESSIONID`, and optionally `bcookie` / `bscookie` / `li_a` / `lidc`. Treat `li_at` as a password: it is a full sign-in as you, with no second factor. The skill never prints cookie values; `session extract-cdp` reports names and lengths only.
- **It navigates and scrapes that tab.** Naming this plainly, because it is more than passive API use: people-search works by sending the shared tab to a `linkedin.com` search URL and reading the rendered DOM (LinkedIn's SDUI broke the classic Voyager search endpoint). Navigation is restricted **in code** to `https://*.linkedin.com`, so the tab cannot be steered anywhere else — but it is browser automation on a live, signed-in session, and you should treat it as such.
- **At most three files, all mode 0600, all under `~/.openclaw`** — the opt-in credentials file, the rate-guard counters (`linkedin-activity.json`), and the opt-in crawl cache (`linkedin-cache.json`). It reads nothing else on your disk.
- **One binary per platform, run with a fixed argument list and no shell** — `secret-tool` (Linux) or `security` (macOS), for the keychain only, with the secret on stdin.
- **The local browser relay, and only on loopback.** `LINKEDIN_CDP_URL` / `LINKEDIN_RELAY_HTTP` are overridable, so both are parsed and their hostnames **resolved** before use; anything that does not resolve to loopback is refused unless you set `LINKEDIN_ALLOW_REMOTE_RELAY=1`. That channel carries your session cookies and full control of the tab, which is why it is not left open by default.

### Where the secret lives

1. **OS keychain, and by default nowhere else** — `secret-tool` on Linux, `security` on macOS, entry `openclaw-linkedin-hack` / `linkedin-session`. On **both** platforms the value is passed over the helper's stdin, so it never appears in `ps`, in an audit log, or in your shell history. (Earlier releases passed it as an argument to `security` on macOS; that is fixed.) The write is then **read back and compared** — the skill will not tell you a session is sealed unless it can prove it landed.
2. **Nowhere, if there is no keychain.** This is the important one: with no usable keychain the save **fails closed** and nothing is written. You are told to install a keychain, or to stay on the default browser transport where no session is stored at all.
3. **A 0600 file, only if you explicitly ask for one** — `~/.openclaw/credentials/linkedin-session.json`, and only with `--allow-plaintext-store` (or `LINKEDIN_ALLOW_PLAINTEXT_STORE=1`) passed on that run. It stores the **minimum** fields needed to make a request, stamps a **24h expiry** and deletes itself once past it, and prints a warning every single time it writes. There is no way to disable the keychain and go straight here — the earlier `LINKEDIN_NO_KEYCHAIN` switch has been removed.

A successful keychain write **deletes** the file, so the secret never exists in two places.

### What leaves your machine

- **To `www.linkedin.com` only:** the Voyager API calls you asked for, carrying your own cookies — exactly what your browser sends when you use the site normally.
- **To `127.0.0.1:18792`:** the local OpenClaw browser relay. That is loopback, not the network.
- **To anyone else: nothing.** No telemetry, no analytics, no third-party host, no phone-home. The skill has zero dependencies, so there is no transitive package doing it either.
- **Outbound writes to LinkedIn:** exactly one endpoint, `message-send`, and it is refused without `--i-mean-it`. Everything else is a read.

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
node {baseDir}/scripts/linkedin.mjs session logout               # keychain + file + cache + counters
node {baseDir}/scripts/linkedin.mjs session logout --keep-data   # same, but keep cache + counters
```

`logout` clears **both** credential stores and, by default, **also deletes** the cached profiles and the
activity counters. Every one of those deletions is checked first: absolute path, inside `$HOME`, a regular
file, never a symlink, and carrying the marker this skill stamps into files it created — so the off switch
cannot be talked into removing anything else.

It is **local only**, and the command says so before and after it runs. It prints LinkedIn's own revoke page:

**https://www.linkedin.com/psettings/sessions**

**Use it — that is the step that actually revokes access.** Deleting the local copy does not invalidate the cookie: until you sign that session out at LinkedIn, anyone who already copied it stays signed in as you. Uninstalling the skill does not revoke anything either. This skill has no way to revoke a LinkedIn session server-side, so it does not claim one.

### What it will not do

There is no endpoint in this skill for connecting, following, liking, posting, endorsing, or deleting. `message-send` is the only write, and it is flag-gated. The `likes` and `connections_sent` counters exist so those actions stay accounted for if they are ever added — today nothing increments them.

## CLI Reference

| Command                                           | Description                                                                                                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session extract-cdp [--store]`                   | Pull httpOnly `li_at` via OpenClaw CDP relay (preferred)                                                                                                                           |
| `session extract-browser`                         | Print in-page extract snippet (often misses `li_at`)                                                                                                                               |
| `session store`                                   | Read `{"li_at":…,"jsessionid":…}` as JSON on **stdin**, save + auto-test. Cookies are never accepted as flags                                                                      |
| `session test`                                    | `GET /voyager/api/me`                                                                                                                                                              |
| `session status`                                  | Where the session is stored + today's counters                                                                                                                                     |
| `session logout [--keep-data]`                    | Erase the session from keychain **and** file, **and** delete the cached profiles and counters; print LinkedIn's revoke URL. Local only. `--keep-data` keeps the cache and counters |
| `me`                                              | Mini-profile                                                                                                                                                                       |
| `profile <vanity>`                                | Profile + positions (+ education)                                                                                                                                                  |
| `search people "q" [--top N] [--network F\|S\|O]` | People search                                                                                                                                                                      |
| `search companies "q" [--top N]`                  | Company search                                                                                                                                                                     |
| `connections [--top N] [--start N]`               | 1st-degree connections                                                                                                                                                             |
| `company <vanity>`                                | Company page summary                                                                                                                                                               |
| `posts <vanity> [--top N]`                        | Member share feed (best-effort)                                                                                                                                                    |
| `conversations [--top N]`                         | Inbox list                                                                                                                                                                         |
| `messages <urn> [--top N]`                        | Thread events                                                                                                                                                                      |
| `message-send <urn> --message "…" --i-mean-it`    | Send (gated)                                                                                                                                                                       |
| `feed [--top N]`                                  | Home feed (best-effort)                                                                                                                                                            |
| `notifications [--top N]`                         | Notifications (best-effort)                                                                                                                                                        |
| `activity show`                                   | Counters + limits                                                                                                                                                                  |
| `activity bump <counter> [--by N]`                | Manual counter bump                                                                                                                                                                |

## Extraction: httpOnly `li_at`

`li_at` is frequently **httpOnly**, so `document.cookie` will not see it. Prefer:

1. `browser(action=cookies, domain="linkedin.com")` when the tool path is available
2. Or CDP `Network.getCookies` on the shared LinkedIn target through the relay

`JSESSIONID` is usually readable and doubles as the CSRF token (strip surrounding quotes).

Never paste full `li_at` values into chat transcripts, git commits, or clawhub packages. Store → test → discard from the message.

## Failure Modes

| Symptom                        | Likely cause                                      | Fix                                                                                  |
| ------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `401` / `403`                  | Session expired, challenge, or missing csrf       | Re-login in browser, `session extract-cdp --store`                                   |
| `302 redirect` / redirect loop | Dead/rotated `li_at` (CLI uses `redirect:manual`) | Same: re-login + extract-cdp                                                         |
| `429`                          | LinkedIn rate limit                               | Stop for minutes; do not retry in a loop                                             |
| `Rate guard: daily …`          | Soft ceiling hit                                  | Wait for next day or edit limits deliberately                                        |
| Empty search results           | Voyager decorationId drift                        | CLI already falls back to `/search/hits`; re-check with `--raw` on profile if needed |
| `li_at` missing from evaluate  | httpOnly cookie                                   | Use `session extract-cdp`, not document.cookie                                       |
| Tab on `/login`                | Session burned (often after a request burst)      | Human re-login, open feed, re-share, extract once                                    |
| Send refused                   | Missing `--i-mean-it`                             | Intentional; only pass when a human has explicitly approved that exact message       |

## Architecture

```
linkedin-hack/
├── SKILL.md
└── scripts/
    └── linkedin.mjs    # zero-dep CLI (session + voyager + rate guard)
```

- **Zero external deps** — pure Node 22+ (`fetch` built-in)
- **Credentials** — OS keychain `openclaw-linkedin-hack/linkedin-session` (secret over stdin, write verified by read-back). No keychain ⇒ saving fails closed; `--allow-plaintext-store` opts into `~/.openclaw/credentials/linkedin-session.json` (0600, minimal fields, 24h expiry)
- **Activity** — `~/.openclaw/workspace/memory/linkedin-activity.json` (0600)
- **Cache** — off unless `LINKEDIN_CACHE=1`; then `~/.openclaw/workspace/memory/linkedin-cache.json` (0600, 12h TTL)
- **Relay** — must resolve to loopback; `LINKEDIN_ALLOW_REMOTE_RELAY=1` to override, with a warning
- **Deletes** — one guarded helper: absolute, inside `$HOME`, regular file, not a symlink, marker-stamped
- **API** — LinkedIn Voyager (`/voyager/api`), Rest.li normalized JSON
- **Off switch** — `node scripts/linkedin.mjs session logout`

## Sibling Skills

| Skill                                                          | What it does                            |
| -------------------------------------------------------------- | --------------------------------------- |
| [teams-hack](https://clawhub.ai/globalcaos/teams-hack)         | Teams chat via Graph + MSAL refresh     |
| [outlook-hack](https://clawhub.ai/globalcaos/outlook-hack)     | Outlook read/draft (send code-disabled) |
| [factorial-hack](https://clawhub.ai/globalcaos/factorial-hack) | Factorial HR GraphQL in-page            |

## The Full Stack

Pair with [outlook-hack](https://clawhub.ai/globalcaos/outlook-hack) for email, [whatsapp-ultimate](https://clawhub.ai/globalcaos/whatsapp-ultimate) for messaging, and [teams-hack](https://clawhub.ai/globalcaos/teams-hack) for org chat.

[Clone it. Fork it. Break it. Make it yours.](https://github.com/globalcaos/tinkerclaw)
