---
name: teams-hack
version: 1.0.3
description: "Your agent reads Teams chats, posts to channels, searches everything — riding the browser session you've already got. No app registration, no admin consent. One tap, ~90 days."
metadata:
  openclaw:
    emoji: "💬"
    os: ["linux", "darwin"]
    requires:
      capabilities: ["browser"]
    notes:
      security: "Shares the Outlook MSAL refresh token. Token stored at ~/.openclaw/credentials/outlook-msal.json (0600). Do not assume 90 days: Teams SPA tokens can have a fixed 24-hour lifetime and fail with AADSTS700084; re-extract from a shared signed-in Teams tab."
---

> One of dozens of skills and plugins in **[TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — a self-improving OpenClaw fork that's been running 24/7 for months.

No app registration. No admin consent. One tap on a browser tab.

Microsoft Teams normally takes an IT ticket and a fortnight of approvals before software can read a single message. Your agent skips all of it — it reads the session your own browser is already holding.

From there it reads your Teams chats, posts to channels, and searches every message you can see. One token read from a browser tab you're already signed into covers Outlook too, since both run on the same Microsoft sign-in. Lifetime varies: this tenant produced a fixed 24-hour SPA refresh token (`AADSTS700084`) on 2026-09-03, so re-extract from a shared signed-in Teams tab instead of assuming 90 days. No app registration or admin consent is required.

**Part of [TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — real-time token tracking, self-improving crons, persistent cognitive memory. This is one piece of that stack; the repo has dozens more.

👉 **https://github.com/globalcaos/tinkerclaw**

_Clone it. Fork it. Break it. Make it yours._

# Teams Hack

<why_this_matters>
One MSAL refresh token from Teams localStorage covers both Outlook and Teams. It may auto-rotate, but SPA refresh tokens can also have a fixed 24-hour lifetime; `AADSTS700084` means re-extract from the live shared Teams tab. This skill shares the same token file as `outlook-hack`, so a valid refresh by either skill keeps both alive.
</why_this_matters>

<capabilities>
- Read and send chat messages (1:1 and group)
- Read and post to team channels
- Search messages across all of Teams
- Browse org directory, check presence status
- View calendar with Teams meeting join links
- List joined teams and channels
</capabilities>

## Quick Start

### 0. Relay Preflight — DO THIS FIRST (avoids the "no access" rabbit hole)

Extraction runs **through the OpenClaw browser relay**, which only exposes tabs the user actively clicked **Share** on; each browser's extension is a separate live connection (MV3 service workers drop their socket and must re-dial, e.g. after a gateway restart). An empty tab list or a 404 means _no shared tab / dropped extension_, not broken code. **Before concluding you can't extract — verify, don't read relay source:**

1. `GET http://127.0.0.1:<relayPort>/extension/status` → expect `{"connected":true,"count":>=1}` (`<relayPort>` = the `browser.profiles.chrome-relay.cdpUrl` port in `~/.openclaw/openclaw.json`, usually `18792`).
2. `GET /tabs` → confirm a `teams.cloud.microsoft` tab is listed, and grab its `targetId`.

If count is 0 or Teams isn't listed: have the user reload the OpenClaw extension (`chrome://extensions`) in the Teams browser and click **Share** on the Teams tab (a gateway restart also reconnects extensions), then re-check. Evaluate the snippet below against that tab's `targetId` via the relay CDP channel (Teams tab foreground), and never echo the returned `secret`.

### 1. Token Extraction (one-time, ~30 seconds)

Open Microsoft Teams (`teams.cloud.microsoft`) in Chrome. Attach the tab via OpenClaw browser relay. The agent runs this in the page:

```javascript
(() => {
  const keys = Object.keys(localStorage).filter(
    (k) => k.includes("refreshtoken") || k.includes("RefreshToken"),
  );
  const results = keys.map((k) => {
    const parsed = JSON.parse(localStorage.getItem(k));
    return { key: k, secret: parsed.secret, client_id: parsed.client_id };
  });
  // Also get tenant ID
  const accountKeys = Object.keys(localStorage).filter((k) => {
    try {
      return JSON.parse(localStorage.getItem(k)).tenantId;
    } catch {
      return false;
    }
  });
  let tenantId = null;
  for (const k of accountKeys) {
    try {
      tenantId = JSON.parse(localStorage.getItem(k)).tenantId;
      break;
    } catch {}
  }
  return { tokens: results, tenantId };
})();
```

Then store the token:

```bash
teams token store --refresh-token <secret> --tenant-id <tenantId>
```

### 2. Verify

```bash
teams token test
```

### 3. Use

```bash
teams chats                          # Recent conversations
teams chat <id> --top 10             # Read messages
teams chat-send <id> --message "hi"  # Send message
teams teams                          # List teams
teams channels <teamId>              # List channels
teams search "project update"        # Search everything
teams users --search "Jane"         # Find people
teams presence                       # Your status
teams calendar --days 3              # Upcoming meetings
```

## How It Works

Same mechanism as the Outlook hack:

1. Teams stores an MSAL refresh token in `localStorage`.
2. This token is exchanged for a Graph API access token using Teams' first-party client ID.
3. The client ID (`5e3ce6c0-2b1f-4285-8d4b-75ee78787346`) has pre-authorized Graph scopes.
4. Token auto-rotates on each use — perpetual access as long as it's used within 90 days.

## Shared Token Architecture

Both skills read from the same file:

```
~/.openclaw/credentials/outlook-msal.json
```

Extract the token once → both `outlook` and `teams` CLIs work. If either skill refreshes the token, the other benefits.

## CLI Reference

| Command                                                    | Description                                 |
| ---------------------------------------------------------- | ------------------------------------------- |
| `teams chats`                                              | List recent chats with last message preview |
| `teams chat <id>`                                          | Read messages (newest first)                |
| `teams chat-send <id> --message <text>`                    | Send to a chat                              |
| `teams teams`                                              | List all joined teams                       |
| `teams channels <teamId>`                                  | List channels in a team                     |
| `teams channel <teamId> <channelId>`                       | Read channel messages                       |
| `teams channel-send <teamId> <channelId> --message <text>` | Post to channel                             |
| `teams search "<query>"`                                   | Full-text search across messages            |
| `teams users --search <name>`                              | Search org directory                        |
| `teams presence`                                           | Your availability status                    |
| `teams calendar --days 7`                                  | Calendar with meeting links                 |
| `teams me`                                                 | Your profile                                |

## Sibling Skill: Outlook Hack

This skill shares the same MSAL refresh token with [outlook-hack](https://clawhub.ai/globalcaos/outlook-hack). One extraction covers both — get full chat access (this skill) and email access (Outlook Hack).

Both skills read and write to the same credentials file:

```
~/.openclaw/credentials/outlook-msal.json
```

If either skill refreshes the token, the other benefits automatically.

| Skill                                                      | What it does                                                         | Send-blocked?             |
| ---------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------- |
| [outlook-hack](https://clawhub.ai/globalcaos/outlook-hack) | Email: read, search, draft, folders, attachments, calendar, contacts | Yes — cannot send         |
| **teams-hack** (this)                                      | Chat: read, send, channels, search, presence, org directory          | No — chat sending enabled |

<architecture>
- Zero external deps — pure Node.js (v22+)
- Shared credentials — same token file as Outlook
- Graph API v1.0 — standard Microsoft endpoints
- Beta fallback — some features use `/beta` when v1.0 lacks support
</architecture>

## The Full Stack

Pair with [outlook-hack](https://clawhub.ai/globalcaos/outlook-hack) for email, [whatsapp-ultimate](https://clawhub.ai/globalcaos/whatsapp-ultimate) for messaging, and [jarvis-voice](https://clawhub.ai/globalcaos/jarvis-voice) for voice.

[Clone it. Fork it. Break it. Make it yours.](https://github.com/globalcaos/tinkerclaw)
