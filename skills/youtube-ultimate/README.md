# 📺 YouTube Research Pro

**The most comprehensive YouTube skill for AI agents.**

Extract transcripts for FREE, search videos, analyze channels, download content — all from one unified interface.

---

## Why This Skill?

We analyzed **15+ YouTube MCP servers** and found that each one does _one thing_ well, but none does _everything_. So we built the skill we wished existed.

| What Others Do                     | What We Do                                  |
| ---------------------------------- | ------------------------------------------- |
| Transcripts OR search OR downloads | **All three, unified**                      |
| Burn API quota on transcripts      | **FREE transcripts** (zero quota)           |
| Single video at a time             | **Batch operations** (50 videos)            |
| Basic search                       | **Filtered search** (date, duration, order) |
| Text output only                   | **JSON export** for pipelines               |

### The Killer Feature: FREE Transcripts

Most YouTube tools use the official YouTube Data API for transcripts, which costs **100 quota units per request**. With a daily limit of 10,000 units, you can only fetch ~100 transcripts per day.

**We use `youtube-transcript-api`** — a library that extracts transcripts directly from YouTube's frontend, costing **zero API quota**. Fetch unlimited transcripts, every day.

---

## Permissions, Privacy & Consent

**Two halves, two very different permission profiles.** Read this before `auth`.

| | Transcripts + downloads | Search, details, comments, your account data |
| --- | --- | --- |
| Google account | **not needed** | **required** |
| API quota | **zero** | 100 per search, 1–3 per lookup |
| Stored credentials | **none** | one OAuth token on disk |

**What the authenticated half can reach.** Your channel, your subscriptions, your playlists and
your liked videos — that is personal account data, and the commands that read it are listed
under *Channel & User Data* below. Nothing fetches them unless you run those commands.

**Scope: `youtube.readonly`, and nothing else.** Since 4.3.0 this skill requests a single
read-only scope. It cannot post a comment, rate a video, subscribe, or touch a playlist even if
it wanted to. (Versions ≤4.2.3 requested read-write `youtube` and `youtube.force-ssl` — if you
authenticated back then, run `logout` and `auth` again to downgrade the grant.)

**Where the token lives.** `~/.config/youtube-skill/token.json`, written mode `0600` inside a
`0700` directory, as JSON — not pickle, which executes code on load. An existing pre-4.3.0
`token.pickle` is migrated to JSON and deleted on first run.

**It asks before it stores anything.** The first command that needs your account prints the
exact path and scope and waits for `y/N`. No browser opens and no file is written until you
agree. Non-interactive runs **refuse** unless you set `YOUTUBE_SKILL_YES=1`.

**Off-switches.**

```bash
YOUTUBE_SKILL_NO_ACCOUNT=1    # disable every sign-in / account command (transcripts still work)
YOUTUBE_SKILL_NO_DOWNLOAD=1   # disable video and audio downloads
uv run youtube.py logout      # delete the stored token (--all for every account)
```

`logout` clears the local token; revoke the grant at Google itself via
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

**Network.** `youtube.com` and `googleapis.com`. Nothing else — no telemetry, no analytics, no
third-party service. Transcripts, search results and account listings print to stdout and are
never written to a file by this skill; only downloads put media on disk.

---

## What Can Your Agent Do With This?

### 🔍 Research & Analysis

- Search YouTube with filters (date, duration, view count)
- Get video details in batch (up to 50 at once)
- Extract full transcripts for content analysis
- Read comments to gauge audience sentiment

### 📝 Content Extraction

- Pull transcripts in any available language
- Get timestamped transcripts for precise references
- Export everything as JSON for further processing

### 📥 Downloads

- Download videos at 480p / 720p / 1080p, or `best` (4K when the video has it)
- Extract audio only (podcasts, music, interviews)
- Grab subtitles as separate files

### 📊 Channel Intelligence

- Analyze channel statistics
- Track subscriber counts and view totals
- List and explore playlists

---

## Quick Examples

```bash
# Get a video transcript (FREE - no API quota!)
uv run youtube.py transcript dQw4w9WgXcQ

# With timestamps
uv run youtube.py transcript dQw4w9WgXcQ --timestamps

# Search with filters
uv run youtube.py search "machine learning" --duration long --order viewCount

# Batch video details
uv run youtube.py video id1 id2 id3 id4 id5 --json

# Download audio as MP3
uv run youtube.py download-audio VIDEO_ID -f mp3

# Get top comments with replies
uv run youtube.py comments VIDEO_ID --replies
```

---

## Complete Command Reference

### Transcripts (FREE - Zero API Quota)

| Command                         | Description                          |
| ------------------------------- | ------------------------------------ |
| `transcript VIDEO`              | Extract transcript as plain text     |
| `transcript VIDEO --timestamps` | Include [MM:SS] timestamps           |
| `transcript VIDEO -l es,en`     | Prefer Spanish, fall back to English |
| `transcript VIDEO --json`       | Output as JSON array                 |
| `transcript-list VIDEO`         | List all available languages         |

### Search & Discovery

| Command                                               | Description                     |
| ----------------------------------------------------- | ------------------------------- |
| `search QUERY`                                        | Search YouTube videos           |
| `search QUERY -l 20`                                  | Return 20 results (default: 10) |
| `search QUERY --order date`                           | Sort by upload date             |
| `search QUERY --order viewCount`                      | Sort by popularity              |
| `search QUERY --duration short`                       | Under 4 minutes                 |
| `search QUERY --duration long`                        | Over 20 minutes                 |
| `search QUERY --published-after 2026-01-01T00:00:00Z` | Filter by date                  |

### Video Information

| Command             | Description              |
| ------------------- | ------------------------ |
| `video ID`          | Get video details        |
| `video ID1 ID2 ID3` | Batch mode (up to 50)    |
| `video ID --json`   | JSON output              |
| `video ID -v`       | Include full description |

### Comments

| Command                       | Description           |
| ----------------------------- | --------------------- |
| `comments VIDEO`              | Get top comments      |
| `comments VIDEO -l 50`        | Get 50 comments       |
| `comments VIDEO --replies`    | Include reply threads |
| `comments VIDEO --order time` | Sort by newest        |

### Channel & User Data

⚠️ **These read your personal Google account** and are the only commands that do. They require
`auth` (read-only scope) and count against your API quota. Skip them entirely — or set
`YOUTUBE_SKILL_NO_ACCOUNT=1` to make them refuse — if you only came for transcripts.

| Command                      | Description          |
| ---------------------------- | -------------------- |
| `channel`                    | Your channel info    |
| `channel CHANNEL_ID`         | Specific channel     |
| `subscriptions`              | Your subscriptions   |
| `playlists`                  | Your playlists       |
| `playlist-items PLAYLIST_ID` | Videos in a playlist |
| `liked`                      | Your liked videos    |

### Authentication (optional)

| Command          | Description                                        |
| ---------------- | -------------------------------------------------- |
| `auth`           | Sign in — asks for consent, then stores one token   |
| `accounts`       | List locally stored tokens and their paths          |
| `logout`         | Delete the stored token (`--all` for every account) |

### Downloads (requires yt-dlp)

| Command                       | Description           |
| ----------------------------- | --------------------- |
| `download VIDEO`              | Download best quality |
| `download VIDEO -r 720p`      | Specific resolution   |
| `download VIDEO -s en`        | Include subtitles     |
| `download VIDEO -o ~/Videos`  | Custom output folder  |
| `download-audio VIDEO`        | Audio only (MP3)      |
| `download-audio VIDEO -f m4a` | Audio as M4A          |

---

## API Quota Costs

| Operation     | Quota Cost | Notes                       |
| ------------- | ---------- | --------------------------- |
| Transcripts   | **0**      | Uses youtube-transcript-api |
| Downloads     | **0**      | Uses yt-dlp                 |
| Search        | 100        | Per request                 |
| Video details | 1          | Per video                   |
| Comments      | 1          | Per request                 |
| Channel info  | 1-3        | Varies                      |

**Daily free quota:** 10,000 units

**Pro tip:** For research tasks, always start with transcripts — they're free and contain the most information.

---

## Setup

### 1. Install dependencies

```bash
brew install uv yt-dlp  # macOS
# or
pip install uv && pip install yt-dlp  # other
```

### 2. Get YouTube API credentials

**Only needed for search, video details, comments and account data.** Transcripts and downloads
work with nothing configured — skip to using them if that is all you want.

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a project (or select existing)
3. Enable "YouTube Data API v3"
4. Create OAuth 2.0 Client ID (Desktop app)
5. Download JSON → save as `~/.config/youtube-skill/credentials.json`

**Treat both files as secrets.** `credentials.json` is your OAuth *client*; `token.json` is a
live grant on your account. Lock them down and keep them out of version control:

```bash
mkdir -p ~/.config/youtube-skill && chmod 700 ~/.config/youtube-skill
chmod 600 ~/.config/youtube-skill/credentials.json
```

The skill writes `token.json` at `0600` itself and never puts it anywhere but this directory.
If you already configured the sibling `gogcli` Google skill, its
`~/.config/gogcli/credentials.json` is used as a fallback client — so authenticating here may
reuse credentials you set up for that skill. Never commit either file, and prefer a dedicated
Google project so a leaked client is cheap to revoke.

### 3. Authenticate

```bash
uv run youtube.py auth
```

This prints the token path and the requested scope (`youtube.readonly`) and waits for your
confirmation before opening a browser or writing anything. `uv run youtube.py logout` removes
the token again; revoke the grant itself at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

---

## Command Aliases

For faster typing:

| Full              | Alias  |
| ----------------- | ------ |
| `transcript`      | `tr`   |
| `transcript-list` | `trl`  |
| `search`          | `s`    |
| `video`           | `v`    |
| `comments`        | `c`    |
| `channel`         | `ch`   |
| `subscriptions`   | `subs` |
| `playlists`       | `pl`   |
| `playlist-items`  | `pli`  |
| `download`        | `dl`   |
| `download-audio`  | `dla`  |

(`auth`, `accounts` and `logout` have no aliases — signing in and out should be typed in full.)

---

## Comparison with Other Tools

| Feature          | YouTube Research Pro | kimtaeyoon83 | kevinwatt/yt-dlp | dannySubsense | kirbah |
| ---------------- | -------------------- | ------------ | ---------------- | ------------- | ------ |
| Free transcripts | ✅                   | ✅           | ❌               | ❌            | ❌     |
| Search           | ✅                   | ❌           | ✅               | ✅            | ✅     |
| Filtered search  | ✅                   | ❌           | ✅               | ❌            | ❌     |
| Batch operations | ✅                   | ❌           | ❌               | ❌            | ✅     |
| Comments         | ✅                   | ❌           | ❌               | ✅            | ✅     |
| Downloads        | ✅                   | ❌           | ✅               | ❌            | ❌     |
| Audio extraction | ✅                   | ❌           | ✅               | ❌            | ❌     |
| JSON output      | ✅                   | ❌           | ❌               | ❌            | ✅     |
| Multi-language   | ✅                   | ✅           | ✅               | ❌            | ❌     |
| URL + ID support | ✅                   | ❌           | ✅               | ❌            | ❌     |

**Result:** No other skill covers all these capabilities in one package.

---

## Use Cases

### 📚 Research Assistant

"Summarize the key points from this conference talk"
→ Fetch transcript, analyze with LLM, extract insights

### 🎓 Learning Helper

"Create study notes from this lecture series"
→ Batch fetch transcripts from playlist, synthesize content

### 📰 News Monitoring

"What are people saying about [topic] this week?"
→ Search recent videos, extract transcripts, analyze trends

### 🎵 Music/Podcast

"Download this interview as audio for my commute"
→ Extract audio, convert to MP3

### 📊 Competitor Analysis

"How is [channel] performing?"
→ Get channel stats, analyze recent videos, track growth

---

## License

MIT — use it, fork it, improve it.

---

_Built for the [OpenClaw](https://github.com/openclaw/openclaw) community._
