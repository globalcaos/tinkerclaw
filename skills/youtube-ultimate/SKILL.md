---
name: youtube-ultimate
version: 4.3.0
description: "Free transcripts, 4K downloads, and video exploration — zero API quotas burned. Built for the TinkerClaw fork — github.com/globalcaos/tinkerclaw. Search and your own account data run on YOUR Google OAuth client, read-only and opt-in, with a one-command logout — see Permissions, Data Flow & Consent."
metadata:
  openclaw:
    owner: kn7623hrcwt6rg73a67xw3wyx580asdw
    category: media
    tags:
      - youtube
      - transcripts
      - video-download
      - media
      - offline
    license: MIT
    notes:
      security: "Two halves, and they have different permission profiles. (1) TRANSCRIPTS AND DOWNLOADS: no account, no API key, no quota — youtube-transcript-api prints to stdout and writes nothing; downloads shell out to your installed yt-dlp (argv list, never shell=true) and write media to the folder you name, or the current directory if you name none. (2) SEARCH, VIDEO/CHANNEL/COMMENT DETAILS AND YOUR OWN SUBSCRIPTIONS, PLAYLISTS AND LIKED VIDEOS: these call YouTube Data API v3 and DO require Google OAuth, using an OAuth client YOU create. Since 4.3.0 the only scope requested is youtube.readonly — the skill cannot post, rate, subscribe or modify anything. The resulting token is stored as JSON at ~/.config/youtube-skill/token.json, mode 0600 (pre-4.3.0 pickle tokens are migrated and deleted), only after an explicit y/N consent prompt naming the path and the scope. It also reads an existing OAuth client from ~/.config/gogcli/credentials.json if present. Nothing is sent anywhere except youtube.com and googleapis.com. Off-switches: YOUTUBE_SKILL_NO_ACCOUNT=1 disables every sign-in path, YOUTUBE_SKILL_NO_DOWNLOAD=1 disables downloads, and `logout` deletes the stored token. See the Permissions, Data Flow & Consent section."
---

# YouTube Ultimate

> One of dozens of skills and plugins in **[TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — a self-improving OpenClaw fork that's been running 24/7 for months.

**Your agent reads YouTube so you don't have to.** Pull transcripts, summarize videos, and extract knowledge — all without touching YouTube's API quota.

## What It Does

- **Free Transcripts** — Grab any video's transcript instantly. No API key, no quota, no billing surprises at 3 AM. Won't burn through your free-tier quota fetching a single playlist, then suggest you upgrade to the $200/month plan like it's doing you a favor.
- **4K Video Downloads** — Save videos locally for offline access, training data, or that flight where Wi-Fi costs more than the ticket.
- **Video Exploration** — Search, browse, and drill into video details without rate-limit anxiety.

## Why It Matters

YouTube's API gives you 10,000 quota units per day. A single search costs 100. A transcript request? Not even supported. YouTube Ultimate sidesteps all of that. Your agent gets full access to video content while your quota counter stays at zero.

*Clone it. Fork it. Break it. Make it yours.*

👉 Explore the full project: [github.com/globalcaos/clawdbot-moltbot-openclaw](https://github.com/globalcaos/clawdbot-moltbot-openclaw)

## The precise version of the above

Marketing is a summary, and summaries round off corners. Here is the unrounded shape, because
the difference decides whether you need a Google account at all:

| Half | Needs an account? | Quota | What it uses |
| --- | --- | --- | --- |
| Transcripts (`transcript`, `transcript-list`) | **No** | **0** | `youtube-transcript-api` against YouTube's public frontend |
| Downloads (`download`, `download-audio`) | **No** | **0** | your installed `yt-dlp` binary |
| Search, video/channel details, comments | **Yes** | 100 per search, 1–3 per lookup | YouTube Data API v3 |
| Your subscriptions, playlists, liked videos | **Yes** | 1–5 per call | YouTube Data API v3 |

So "zero quota" is exactly true for the two headline features and exactly false for search. Both
halves ship in one CLI; you can use the free half forever and never authenticate — and if you
want to guarantee that, set `YOUTUBE_SKILL_NO_ACCOUNT=1` and the signed-in half refuses to run.

"4K" means the default `-r best` asks yt-dlp for `bestvideo+bestaudio/best`, which gives you 4K
when the video actually has it. The named shortcuts are `480p`, `720p`, `1080p` and `best` —
there is no literal `2160p` flag, and no resolution is invented that YouTube did not publish.

## Permissions, Data Flow & Consent

Short version: transcripts and downloads touch no account and store nothing. Everything else
needs a Google sign-in you perform yourself, with a read-only scope, and it asks first. Longer
version, because you should not have to take that on trust:

**What leaves your machine.** Requests to `youtube.com` (transcripts, yt-dlp) and to
`googleapis.com` (Data API). Nothing else. No telemetry, no analytics, no third-party endpoint,
no phoning home to us. Video IDs and search terms you pass go to YouTube, because that is what
asking YouTube a question means.

**What is written to disk.**

| Path | When | Contents | Mode |
| --- | --- | --- | --- |
| `~/.config/youtube-skill/token.json` | only after you consent at the OAuth prompt | your OAuth access + refresh token | `0600`, in a `0700` dir |
| the folder you pass to `-o` | only on `download` / `download-audio` | the media file, and subtitle files if you pass `-s` | yt-dlp default |
| the **current directory** | if you run a download **without** `-o` | same as above | yt-dlp default |

Transcripts, search results, comments and account listings are printed to **stdout and never
written to a file** by this skill. If your agent saves them, that is your agent's decision, not
ours.

**What it needs, and why.**

| Capability | Why | Scope |
| --- | --- | --- |
| Network | Fetch transcripts, call the Data API, download media | `youtube.com` and `googleapis.com` only |
| Google OAuth | Search, comments, video/channel details, and your own subscriptions/playlists/liked videos have no unauthenticated equivalent | **`youtube.readonly` only** — cannot post comments, rate, subscribe, or modify playlists |
| Credential read | Finds the OAuth **client** you created | `~/.config/youtube-skill/credentials.json`, falling back to `~/.config/gogcli/credentials.json` if you already set up the sibling Google skill |
| Credential write | Stores the resulting token so you sign in once | one JSON file, `0600`, path named in the prompt before it is written |
| Subprocess exec | Downloads are delegated to `yt-dlp` | one binary found via `PATH`, invoked as an **argv list — never `shell=True`**, arguments limited to a YouTube URL, a format string from a fixed table, and your `-o` directory |
| File write | Media and subtitles from downloads | the directory you choose, or the current directory |
| Account data read | `subscriptions`, `playlists`, `liked`, `channel` are the point of those commands | read-only, on demand, never fetched by the other commands |

**Consent, and where it fires.** The first command that needs your account prints the token
path and the requested scope, then stops and asks `Continue and store the token? [y/N]`. It
opens no browser and writes no file until you answer yes. Running non-interactively it
**refuses** rather than silently authenticating — set `YOUTUBE_SKILL_YES=1` if you genuinely
want an unattended sign-in and mean it.

**Turning it off — three switches, all of which stop it before it does anything:**

```bash
YOUTUBE_SKILL_NO_ACCOUNT=1   # every Google sign-in / account command refuses (exit 2).
                             # Transcripts and downloads keep working.
YOUTUBE_SKILL_NO_DOWNLOAD=1  # download and download-audio refuse (exit 2). Nothing hits disk.
uv run youtube.py logout     # deletes the stored token. --all does every account.
```

`logout` removes the local token only. To revoke the grant at Google's end as well, visit
[myaccount.google.com/permissions](https://myaccount.google.com/permissions) — the skill prints
that link when you log out.

**Upgrading from ≤4.2.3.** Older versions requested three scopes, two of which were
**read-write** (`youtube`, `youtube.force-ssl`), and stored the token as a **pickle** — a format
that executes code on load. 4.3.0 requests read-only only, and migrates any existing
`token.pickle` to `token.json` at mode `0600`, deleting the pickle. Your old grant keeps its
broad scopes at Google until you re-consent: run `logout` then `auth` to downgrade it to
read-only. Worth the thirty seconds.

**Read it before you run it.** `scripts/youtube.py` is a single self-contained file with no
build step and no hidden imports. That is the whole security model: one file, readable in a
sitting.

## Quick Start

```bash
# No account needed:
uv run scripts/youtube.py transcript dQw4w9WgXcQ            # free, zero quota
uv run scripts/youtube.py transcript dQw4w9WgXcQ -t         # with [MM:SS] timestamps
uv run scripts/youtube.py download dQw4w9WgXcQ -o ~/Videos  # needs yt-dlp on PATH
uv run scripts/youtube.py download-audio dQw4w9WgXcQ -f mp3

# Account needed (asks before storing a token):
uv run scripts/youtube.py auth
uv run scripts/youtube.py search "machine learning" --duration long
uv run scripts/youtube.py subscriptions
uv run scripts/youtube.py logout
```

Full command reference, aliases and setup: see `README.md` in this package.

**Requirements:** `uv` for the script's inline dependencies; `yt-dlp` on `PATH` for downloads
only. The Data API commands need an OAuth **client ID you create yourself** in Google Cloud —
there is no shared key, no account of ours in the loop, and no key to leak.
