# 📺 YouTube Research Pro v2.0.0

**The most comprehensive YouTube skill for AI agents.**

Extract transcripts for FREE, search videos, analyze channels, download content with full format control — all from one unified interface.

---

## What's New in v2.0.0 🎉

- 🎬 **`formats` command** — List all available video/audio formats before downloading
- 🛡️ **Better error handling** — Clear messages for private, age-restricted, unavailable videos
- 🎵 **Enhanced audio downloads** — FLAC/WAV/OPUS support, quality control, thumbnail embedding
- 📺 **More resolution options** — Added 1440p and 4K
- 🍪 **Cookie support** — Download age-restricted content using browser cookies
- 📝 **Metadata embedding** — Embed video/audio metadata into downloaded files

---

## Why This Skill?

We analyzed **15+ YouTube MCP servers** and found that each one does *one thing* well, but none does *everything*. So we built the skill we wished existed.

| What Others Do | What We Do |
|----------------|------------|
| Transcripts OR search OR downloads | **All three, unified** |
| Burn API quota on transcripts | **FREE transcripts** (zero quota) |
| Single video at a time | **Batch operations** (50 videos) |
| Basic search | **Filtered search** (date, duration, order) |
| Text output only | **JSON export** for pipelines |

### The Killer Feature: FREE Transcripts

Most YouTube tools use the official YouTube Data API for transcripts, which costs **100 quota units per request**. With a daily limit of 10,000 units, you can only fetch ~100 transcripts per day.

**We use `youtube-transcript-api`** — a library that extracts transcripts directly from YouTube's frontend, costing **zero API quota**. Fetch unlimited transcripts, every day.

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

### 📥 Downloads (v2.0 Enhanced!)
- **List formats** before downloading
- Download videos at any resolution (up to 4K)
- Extract audio only (MP3, M4A, FLAC, OPUS, WAV)
- Grab subtitles as separate files
- Embed thumbnails and metadata
- Handle age-restricted content with cookies

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

# List available formats (NEW in v2.0)
uv run youtube.py formats VIDEO_ID

# Download at specific resolution
uv run youtube.py download VIDEO_ID -r 1080p

# Download specific format
uv run youtube.py download VIDEO_ID -f 137+140

# Download audio as FLAC with thumbnail (NEW in v2.0)
uv run youtube.py download-audio VIDEO_ID -f flac --embed-thumbnail

# Handle age-restricted videos (NEW in v2.0)
uv run youtube.py download VIDEO_ID --cookies-from-browser chrome

# Get top comments with replies
uv run youtube.py comments VIDEO_ID --replies
```

---

## Complete Command Reference

### Transcripts (FREE - Zero API Quota)

| Command | Description |
|---------|-------------|
| `transcript VIDEO` | Extract transcript as plain text |
| `transcript VIDEO --timestamps` | Include [MM:SS] timestamps |
| `transcript VIDEO -l es,en` | Prefer Spanish, fall back to English |
| `transcript VIDEO --json` | Output as JSON array |
| `transcript-list VIDEO` | List all available languages |

### Search & Discovery

| Command | Description |
|---------|-------------|
| `search QUERY` | Search YouTube videos |
| `search QUERY -l 20` | Return 20 results (default: 10) |
| `search QUERY --order date` | Sort by upload date |
| `search QUERY --order viewCount` | Sort by popularity |
| `search QUERY --duration short` | Under 4 minutes |
| `search QUERY --duration long` | Over 20 minutes |
| `search QUERY --published-after 2026-01-01T00:00:00Z` | Filter by date |

### Video Information

| Command | Description |
|---------|-------------|
| `video ID` | Get video details |
| `video ID1 ID2 ID3` | Batch mode (up to 50) |
| `video ID --json` | JSON output |
| `video ID -v` | Include full description |

### Comments

| Command | Description |
|---------|-------------|
| `comments VIDEO` | Get top comments |
| `comments VIDEO -l 50` | Get 50 comments |
| `comments VIDEO --replies` | Include reply threads |
| `comments VIDEO --order time` | Sort by newest |

### Channel & User Data

| Command | Description |
|---------|-------------|
| `channel` | Your channel info |
| `channel CHANNEL_ID` | Specific channel |
| `subscriptions` | Your subscriptions |
| `playlists` | Your playlists |
| `playlist-items PLAYLIST_ID` | Videos in a playlist |
| `liked` | Your liked videos |

### Downloads (v2.0 - Enhanced!)

#### Format Discovery

| Command | Description |
|---------|-------------|
| `formats VIDEO` | List all available formats |
| `formats VIDEO --json` | Format list as JSON |

#### Video Download

| Command | Description |
|---------|-------------|
| `download VIDEO` | Download best quality |
| `download VIDEO -r 720p` | Specific resolution (480p/720p/1080p/1440p/4k) |
| `download VIDEO -f 137+140` | Specific format ID(s) |
| `download VIDEO -s en` | Include subtitles |
| `download VIDEO -o ~/Videos` | Custom output folder |
| `download VIDEO --embed-metadata` | Embed metadata |
| `download VIDEO --cookies-from-browser chrome` | Use browser cookies |

#### Audio Download

| Command | Description |
|---------|-------------|
| `download-audio VIDEO` | Audio only (MP3 default) |
| `download-audio VIDEO -f m4a` | Audio as M4A |
| `download-audio VIDEO -f flac` | Audio as FLAC |
| `download-audio VIDEO -f opus` | Audio as OPUS |
| `download-audio VIDEO -q 0` | Best quality |
| `download-audio VIDEO --embed-thumbnail` | Embed album art |
| `download-audio VIDEO --embed-metadata` | Embed metadata |

---

## Error Handling (v2.0)

The skill now provides clear, actionable error messages:

| Error | What It Means | Solution |
|-------|---------------|----------|
| `This video is private` | Video set to private | Contact owner |
| `Video is age-restricted` | Need to login | Use `--cookies-from-browser` |
| `Video is unavailable` | Deleted or region-blocked | Try VPN or different video |
| `Blocked due to copyright` | DMCA takedown | No workaround |
| `Members-only video` | Requires channel membership | Join channel |
| `Cannot download live streams` | Live stream in progress | Wait until it ends |
| `Premiere hasn't started` | Scheduled premiere | Wait for premiere |

---

## API Quota Costs

| Operation | Quota Cost | Notes |
|-----------|------------|-------|
| Transcripts | **0** | Uses youtube-transcript-api |
| Formats | **0** | Uses yt-dlp |
| Downloads | **0** | Uses yt-dlp |
| Search | 100 | Per request |
| Video details | 1 | Per video |
| Comments | 1 | Per request |
| Channel info | 1-3 | Varies |

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
1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a project (or select existing)
3. Enable "YouTube Data API v3"
4. Create OAuth 2.0 Client ID (Desktop app)
5. Download JSON → save as `~/.config/youtube-skill/credentials.json`

### 3. Authenticate
```bash
uv run youtube.py auth
```

---

## Command Aliases

For faster typing:

| Full | Alias |
|------|-------|
| `transcript` | `tr` |
| `transcript-list` | `trl` |
| `formats` | `fmt`, `F` |
| `search` | `s` |
| `video` | `v` |
| `comments` | `c` |
| `channel` | `ch` |
| `subscriptions` | `subs` |
| `playlists` | `pl` |
| `playlist-items` | `pli` |
| `download` | `dl` |
| `download-audio` | `dla` |

---

## Comparison with Other Tools

| Feature | YouTube Research Pro v2.0 | kimtaeyoon83 | kevinwatt/yt-dlp | dannySubsense | kirbah |
|---------|---------------------------|--------------|------------------|---------------|--------|
| Free transcripts | ✅ | ✅ | ❌ | ❌ | ❌ |
| Search | ✅ | ❌ | ✅ | ✅ | ✅ |
| Filtered search | ✅ | ❌ | ✅ | ❌ | ❌ |
| Batch operations | ✅ | ❌ | ❌ | ❌ | ✅ |
| Comments | ✅ | ❌ | ❌ | ✅ | ✅ |
| Format listing | ✅ | ❌ | ✅ | ❌ | ❌ |
| Video downloads | ✅ | ❌ | ✅ | ❌ | ❌ |
| Audio extraction | ✅ | ❌ | ✅ | ❌ | ❌ |
| FLAC/lossless | ✅ | ❌ | ✅ | ❌ | ❌ |
| Thumbnail embed | ✅ | ❌ | ✅ | ❌ | ❌ |
| Cookie auth | ✅ | ❌ | ✅ | ❌ | ❌ |
| JSON output | ✅ | ❌ | ❌ | ❌ | ✅ |
| Multi-language | ✅ | ✅ | ✅ | ❌ | ❌ |
| URL + ID support | ✅ | ❌ | ✅ | ❌ | ❌ |
| Error handling | ✅ | ❌ | ✅ | ❌ | ❌ |

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
→ Extract audio with embedded thumbnail and metadata

### 📊 Competitor Analysis
"How is [channel] performing?"
→ Get channel stats, analyze recent videos, track growth

### 📁 Archiving
"Archive important videos before they disappear"
→ Download with metadata, subtitles, and best quality

---

## Changelog

### v2.0.0 (2026-02-03)
- Added `formats` command to list available video/audio formats
- Enhanced error handling with clear messages for:
  - Private videos
  - Age-restricted content
  - Unavailable/deleted videos
  - Copyright-blocked content
  - Members-only videos
  - Live streams and premieres
- Added cookie support (`--cookies`, `--cookies-from-browser`)
- Added more audio formats: FLAC, WAV, OPUS
- Added audio quality control (`-q 0` for best)
- Added `--embed-thumbnail` for audio files
- Added `--embed-metadata` for video/audio
- Added 1440p and 4K resolution options
- Added `--restrict-filenames` for compatibility
- Added format ID selection (`-f FORMAT_ID`)

### v1.0.0
- Initial release with transcripts, search, downloads, comments

---

## License

MIT — use it, fork it, improve it.

---

*Built by [Oscar Serra](https://github.com/globalcaos) for the OpenClaw community.*
