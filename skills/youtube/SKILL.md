---
name: youtube
description: YouTube Research Pro - Search, transcripts (FREE!), video details, comments, downloads. Use for video research, content analysis, or extracting information from YouTube.
homepage: https://developers.google.com/youtube/v3
metadata:
  {
    "openclaw":
      {
        "emoji": "📺",
        "requires": { "bins": ["uv"] },
        "install":
          [
            {
              "id": "uv-brew",
              "kind": "brew",
              "formula": "uv",
              "bins": ["uv"],
              "label": "Install uv (brew)",
            },
            {
              "id": "ytdlp-brew",
              "kind": "brew",
              "formula": "yt-dlp",
              "bins": ["yt-dlp"],
              "label": "Install yt-dlp for downloads (optional)",
            },
          ],
      },
  }
---

# YouTube Research Pro

Comprehensive YouTube access: search, transcripts, video details, comments, and downloads.

**Key Feature:** Transcript extraction is **FREE** (no API quota used!)

## Quick Reference

| Command | API Quota | Description |
|---------|-----------|-------------|
| `transcript` | **FREE** | Get video transcript/captions |
| `transcript-list` | **FREE** | List available languages |
| `search` | 100 units | Search videos |
| `video` | 1 unit | Get video details (batch supported) |
| `comments` | 1 unit | Get video comments |
| `channel` | 1-3 units | Get channel info |
| `download` | **FREE** | Download video (yt-dlp) |
| `download-audio` | **FREE** | Extract audio only |

## First-time Setup

1. Get OAuth credentials from [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create OAuth 2.0 Client ID (Desktop app)
3. Download JSON and save to `~/.config/youtube-skill/credentials.json`
4. Run auth:

```bash
uv run {baseDir}/scripts/youtube.py auth
```

## Transcripts (FREE - No API Quota!)

The killer feature: extract transcripts without using any API quota.

```bash
# Get transcript as plain text
uv run {baseDir}/scripts/youtube.py transcript VIDEO_ID

# With timestamps
uv run {baseDir}/scripts/youtube.py transcript VIDEO_ID --timestamps

# Specific language
uv run {baseDir}/scripts/youtube.py transcript VIDEO_ID -l es

# List available languages
uv run {baseDir}/scripts/youtube.py transcript-list VIDEO_ID

# Output as JSON
uv run {baseDir}/scripts/youtube.py transcript VIDEO_ID --json
```

Works with video IDs or full URLs:
```bash
uv run {baseDir}/scripts/youtube.py transcript "https://youtube.com/watch?v=dQw4w9WgXcQ"
```

## Search

```bash
# Basic search
uv run {baseDir}/scripts/youtube.py search "AI news 2026"

# With filters
uv run {baseDir}/scripts/youtube.py search "python tutorial" -l 20 -o date
uv run {baseDir}/scripts/youtube.py search "machine learning" --duration long
uv run {baseDir}/scripts/youtube.py search "news" --published-after 2026-01-01T00:00:00Z
```

## Video Details

Supports batch mode for multiple videos:

```bash
# Single video
uv run {baseDir}/scripts/youtube.py video dQw4w9WgXcQ

# Multiple videos (batch)
uv run {baseDir}/scripts/youtube.py video dQw4w9WgXcQ abc123 xyz789

# Verbose with description
uv run {baseDir}/scripts/youtube.py video dQw4w9WgXcQ -v

# JSON output
uv run {baseDir}/scripts/youtube.py video dQw4w9WgXcQ --json
```

## Comments

```bash
# Top comments
uv run {baseDir}/scripts/youtube.py comments VIDEO_ID

# Recent comments with replies
uv run {baseDir}/scripts/youtube.py comments VIDEO_ID -o time -r

# More results
uv run {baseDir}/scripts/youtube.py comments VIDEO_ID -l 50
```

## Channel Info

```bash
# Your channel
uv run {baseDir}/scripts/youtube.py channel

# Specific channel
uv run {baseDir}/scripts/youtube.py channel UCxxxx
```

## User Data

```bash
# Subscriptions
uv run {baseDir}/scripts/youtube.py subscriptions

# Playlists
uv run {baseDir}/scripts/youtube.py playlists

# Playlist contents
uv run {baseDir}/scripts/youtube.py playlist-items PLxxxx

# Liked videos
uv run {baseDir}/scripts/youtube.py liked
```

## Downloads (requires yt-dlp)

Install yt-dlp: `brew install yt-dlp`

```bash
# Download video (best quality)
uv run {baseDir}/scripts/youtube.py download VIDEO_ID

# Specific resolution
uv run {baseDir}/scripts/youtube.py download VIDEO_ID -r 720p

# With subtitles
uv run {baseDir}/scripts/youtube.py download VIDEO_ID -s en

# Custom output directory
uv run {baseDir}/scripts/youtube.py download VIDEO_ID -o ~/Videos

# Audio only (MP3)
uv run {baseDir}/scripts/youtube.py download-audio VIDEO_ID

# Audio in different format
uv run {baseDir}/scripts/youtube.py download-audio VIDEO_ID -f m4a
```

## Multi-account Support

```bash
uv run {baseDir}/scripts/youtube.py -a work subscriptions
uv run {baseDir}/scripts/youtube.py -a personal liked
```

## Command Aliases

| Full Command | Alias |
|--------------|-------|
| `transcript` | `tr`, `trans` |
| `transcript-list` | `trl` |
| `search` | `s` |
| `video` | `v` |
| `comments` | `c` |
| `channel` | `ch` |
| `subscriptions` | `subs` |
| `playlists` | `pl` |
| `playlist-items` | `pli` |
| `download` | `dl` |
| `download-audio` | `dla` |

## Research Workflows

### Summarize a video's content
```bash
# Get transcript and video details together
uv run {baseDir}/scripts/youtube.py video VIDEO_ID --json > video_info.json
uv run {baseDir}/scripts/youtube.py transcript VIDEO_ID > transcript.txt
```

### Batch research on a topic
```bash
# Search and get details for top results
uv run {baseDir}/scripts/youtube.py search "topic" -l 10 --json | \
  jq -r '.[].id.videoId' | \
  xargs uv run {baseDir}/scripts/youtube.py video --json
```

### Extract audio for analysis
```bash
uv run {baseDir}/scripts/youtube.py download-audio VIDEO_ID -f mp3 -o ./audio
```

## API Quota Notes

- Daily quota: 10,000 units (free tier)
- **Transcripts use 0 quota** (uses youtube-transcript-api)
- Search: 100 units per request
- Video/Channel details: 1-3 units per request
- Downloads: 0 quota (uses yt-dlp)

Tip: For research tasks, prefer transcripts over repeated API calls.
