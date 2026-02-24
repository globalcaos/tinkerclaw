---
name: outlook-hack
version: 3.0.0
description: "Your agent reads Outlook email all day. Drafts replies for you. Won't send a single one. Not even if you ask nicely."
metadata:
  {
    "openclaw":
      {
        "emoji": "📧",
        "os": ["linux", "darwin"],
        "requires": { "capabilities": ["browser"] },
        "notes":
          {
            "security": "This skill captures Outlook Web session tokens via browser tab sharing to make direct REST calls to Microsoft's Outlook REST API v2.0. No API keys or admin approval needed. SENDING IS CODE-DISABLED: the fetch script physically blocks /sendmail, /reply, /replyall, /forward. It reads, searches, and creates drafts only. Drafts land in the user's Drafts folder for manual review and sending. Tokens are stored at ~/.openclaw/credentials/outlook-msal.json with 0600 permissions.",
          },
      },
  }
---

# Outlook Hack

**Your AI agent won't email the CEO at 3am.**

Not because there's a setting. Not because there's a policy. Because the code physically cannot send emails. We removed that capability the way you'd remove a chainsaw from a toddler — completely and without negotiation.

## What It Does

- 📧 Read, search, and bulk-fetch emails across all folders
- 📎 Index all attachments (name, type, size) per message
- 📊 Generate digest summaries with top senders, unread counts, full body text
- ✏️ Create email drafts (lands in Drafts folder — never sends)
- 📅 Access calendar events, 👥 Browse contacts

## Quick Start

### 1. Token Extraction (one-time, ~30 seconds)

Open the **classic Outlook** tab (`outlook.office.com`) in Chrome with the OpenClaw browser relay attached. Then run this in-browser evaluation:

```javascript
// Extract the Outlook REST API bearer token from localStorage
const keys = Object.keys(localStorage);
const outlookKey = keys.find(k =>
  k.includes('accesstoken') &&
  k.includes('outlook.office.com') &&
  k.includes('mail.readwrite')
);
const parsed = JSON.parse(localStorage.getItem(outlookKey));
// parsed.secret is the bearer token (valid ~25 hours)
```

Save the token:

```bash
node {baseDir}/scripts/outlook-mail-fetch.mjs --store-token <token>
```

### 2. Verify Access

```bash
node {baseDir}/scripts/outlook-mail-fetch.mjs --test
```

### 3. Bulk Fetch

```bash
# Last 6 months (default)
node {baseDir}/scripts/outlook-mail-fetch.mjs --fetch-all

# Custom range
node {baseDir}/scripts/outlook-mail-fetch.mjs --fetch-all --months 12
```

**Output:** `~/.openclaw/workspace/data/outlook-emails/`
- `raw-emails.jsonl` — full email data (subject, from, to, body text, preview)
- `attachments-index.jsonl` — every attachment per message
- `email-summary.md` — readable digest with stats and per-email summaries

## Critical: Classic vs New Outlook

| Feature | Classic (`outlook.office.com`) | New (`outlook.cloud.microsoft`) |
|---------|------|-----|
| Token type | **Bearer** (plain `secret` in localStorage) | **PoP** (encrypted `data` + `nonce`) |
| Extractable | ✅ Yes | ❌ No |
| Service Worker | No | Yes (intercepts all API calls) |
| API | Outlook REST v2.0 | MessageService + OWA substrate |

**Always use the classic Outlook tab.** The new Outlook uses Proof-of-Possession tokens that are cryptographically bound to the browser — they cannot be extracted or replayed.

If Outlook redirects you to `outlook.cloud.microsoft`, navigate directly to `https://outlook.office.com/mail/`.

## How It Works (Technical)

1. Share your **classic Outlook Web** tab with OpenClaw via the Browser Relay
2. The agent reads `localStorage` to extract the MSAL bearer token (audience: `https://outlook.office.com`)
3. Token is saved to `~/.openclaw/credentials/outlook-msal.json` (0600 permissions)
4. The `outlook-mail-fetch.mjs` script makes REST calls to `https://outlook.office.com/api/v2.0/`
5. Token valid ~25 hours. Next day: share the tab again, re-extract. One touch.

The skill is NOT scraping the page. It speaks Outlook's own REST API, authenticated through your existing browser session.

## Token Lifetime & Refresh

- Tokens last ~25 hours from issuance
- The script checks expiry before each request
- When expired: re-extract from browser (one `evaluate` call)
- No refresh token flow available (Microsoft's first-party client ID requires confidential client auth)

## Architecture Notes

- **Zero external dependencies** — pure Node.js (v18+), no npm packages
- **Send-blocked** — the script has no send/reply/forward functions. They don't exist.
- **Rate-limited** — fetches 50 emails per page with automatic pagination
- **Body text cleaned** — HTML stripped, whitespace normalized, truncated to 3000 chars per email

## The Full Stack

Pair with [**whatsapp-ultimate**](https://clawhub.com/globalcaos/whatsapp-ultimate) for messaging and [**jarvis-voice**](https://clawhub.com/globalcaos/jarvis-voice) for voice.

👉 **[Clone it. Fork it. Break it. Make it yours.](https://github.com/globalcaos/clawdbot-moltbot-openclaw)**
