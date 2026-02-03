#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "google-api-python-client>=2.0.0",
#     "google-auth-oauthlib>=1.0.0",
#     "google-auth-httplib2>=0.1.0",
#     "youtube-transcript-api>=0.6.0",
#     "yt-dlp>=2024.0.0",
# ]
# ///
"""
YouTube Research Pro CLI v2.0.0 - Comprehensive YouTube access for OpenClaw.

Features:
  - Search, video details, channel info (YouTube Data API)
  - Transcript extraction (FREE - no API quota!)
  - Full download via yt-dlp integration (video, audio, formats)
  - Batch operations
  - Graceful error handling (private, age-restricted, unavailable)

Usage:
    uv run youtube.py <command> [options]

Commands:
    # Authentication
    auth                    Authenticate with YouTube (opens browser)
    accounts                List authenticated accounts
    
    # Video Info (API required)
    search QUERY            Search YouTube videos
    video ID [ID...]        Get video details (batch supported)
    channel [ID]            Get channel info (yours if no ID)
    comments ID             Get video comments
    
    # Transcripts (FREE - no API quota)
    transcript ID           Get video transcript/captions
    
    # User Data (API required)
    subscriptions           List your subscriptions
    playlists               List your playlists
    playlist-items ID       List videos in a playlist
    liked                   List your liked videos
    
    # Download (yt-dlp)
    formats ID              List available formats for a video
    download ID             Download video (best quality or specified)
    download-audio ID       Extract audio only (MP3/M4A/FLAC/etc)

Examples:
    uv run youtube.py search "AI news 2026" -l 5
    uv run youtube.py transcript dQw4w9WgXcQ
    uv run youtube.py transcript dQw4w9WgXcQ --timestamps
    uv run youtube.py video dQw4w9WgXcQ abc123 xyz789  # batch
    uv run youtube.py formats dQw4w9WgXcQ              # list formats
    uv run youtube.py download dQw4w9WgXcQ -r 720p
    uv run youtube.py download-audio dQw4w9WgXcQ -f mp3 --embed-thumbnail
"""

import argparse
import json
import os
import sys
import pickle
import subprocess
import shutil
from pathlib import Path
from typing import Optional, List

# YouTube Data API imports
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

# Transcript API (FREE - no quota!)
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import (
    TranscriptsDisabled,
    NoTranscriptFound,
    VideoUnavailable,
)

SCOPES = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube',
    'https://www.googleapis.com/auth/youtube.force-ssl'
]

CONFIG_DIR = Path.home() / '.config' / 'youtube-skill'
CREDENTIAL_PATHS = [
    Path.home() / '.config' / 'youtube-skill' / 'credentials.json',
    Path.home() / '.config' / 'gogcli' / 'credentials.json',
]
DEFAULT_ACCOUNT = 'default'

_current_account = DEFAULT_ACCOUNT


def get_credentials_file():
    """Find OAuth credentials file."""
    for path in CREDENTIAL_PATHS:
        if path.exists():
            return path
    return None


def get_token_file(account=None):
    """Get token file path for account."""
    acc = account or _current_account
    if acc == DEFAULT_ACCOUNT:
        return CONFIG_DIR / 'token.pickle'
    return CONFIG_DIR / f'token.{acc}.pickle'


def get_youtube_service(account=None):
    """Get authenticated YouTube service."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    token_file = get_token_file(account)

    creds = None
    if token_file.exists():
        with open(token_file, 'rb') as token:
            creds = pickle.load(token)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            creds_file = get_credentials_file()
            if not creds_file:
                print("Error: OAuth credentials not found.", file=sys.stderr)
                print("Please place credentials.json in one of:", file=sys.stderr)
                for p in CREDENTIAL_PATHS:
                    print(f"  - {p}", file=sys.stderr)
                print("\nTo get credentials:", file=sys.stderr)
                print("1. Go to https://console.cloud.google.com/apis/credentials", file=sys.stderr)
                print("2. Create OAuth 2.0 Client ID (Desktop app)", file=sys.stderr)
                print("3. Download JSON and save as credentials.json", file=sys.stderr)
                sys.exit(1)

            flow = InstalledAppFlow.from_client_secrets_file(str(creds_file), SCOPES)
            creds = flow.run_local_server(port=0)

        with open(token_file, 'wb') as token:
            pickle.dump(creds, token)

    return build('youtube', 'v3', credentials=creds)


def extract_video_id(url_or_id: str) -> str:
    """Extract video ID from URL or return as-is if already an ID."""
    if 'youtube.com' in url_or_id or 'youtu.be' in url_or_id:
        import re
        patterns = [
            r'(?:v=|/v/|youtu\.be/)([a-zA-Z0-9_-]{11})',
            r'(?:embed/)([a-zA-Z0-9_-]{11})',
        ]
        for pattern in patterns:
            match = re.search(pattern, url_or_id)
            if match:
                return match.group(1)
    return url_or_id


# ============================================================================
# AUTHENTICATION COMMANDS
# ============================================================================

def cmd_auth(args):
    """Authenticate with YouTube."""
    token_file = get_token_file()
    if token_file.exists():
        token_file.unlink()
    get_youtube_service()
    acc_name = _current_account if _current_account != DEFAULT_ACCOUNT else 'default'
    print(f"✓ YouTube authentication successful! (account: {acc_name})")


def cmd_accounts(args):
    """List authenticated accounts."""
    print("Authenticated accounts:")
    if not CONFIG_DIR.exists():
        print("  (none)")
        return
    found = False
    for f in CONFIG_DIR.glob('token*.pickle'):
        name = f.stem.replace('token.', '').replace('token', 'default')
        print(f"  ✓ {name}")
        found = True
    if not found:
        print("  (none)")


# ============================================================================
# TRANSCRIPT COMMANDS (FREE - NO API QUOTA!)
# ============================================================================

def cmd_transcript(args):
    """Get video transcript - FREE, no API quota used!"""
    video_id = extract_video_id(args.video_id)
    
    try:
        # Try to get transcript in preferred language, fall back to any available
        ytt_api = YouTubeTranscriptApi()
        transcript_list = ytt_api.list(video_id)
        
        transcript = None
        lang_used = None
        
        # Try preferred language first
        for lang in args.language.split(','):
            try:
                transcript = transcript_list.find_transcript([lang.strip()])
                lang_used = lang.strip()
                break
            except NoTranscriptFound:
                continue
        
        # Fall back to any available transcript
        if not transcript:
            try:
                transcript = transcript_list.find_generated_transcript(['en'])
                lang_used = 'en (auto-generated)'
            except NoTranscriptFound:
                # Get first available
                for t in transcript_list:
                    transcript = t
                    lang_used = f"{t.language_code} ({'auto' if t.is_generated else 'manual'})"
                    break
        
        if not transcript:
            print("No transcript available for this video.", file=sys.stderr)
            sys.exit(1)
        
        fetched = transcript.fetch()
        
        if args.json:
            # Convert to serializable format
            entries = [{'text': s.text, 'start': s.start, 'duration': s.duration} 
                       for s in fetched.snippets]
            print(json.dumps(entries, indent=2, ensure_ascii=False))
            return
        
        print(f"# Transcript ({lang_used})")
        print(f"# Video: https://youtube.com/watch?v={video_id}")
        print()
        
        if args.timestamps:
            for snippet in fetched.snippets:
                start = snippet.start
                mins = int(start // 60)
                secs = int(start % 60)
                print(f"[{mins:02d}:{secs:02d}] {snippet.text}")
        else:
            # Join all text for clean reading
            full_text = ' '.join(snippet.text for snippet in fetched.snippets)
            # Clean up whitespace
            import re
            full_text = re.sub(r'\s+', ' ', full_text).strip()
            print(full_text)
            
    except TranscriptsDisabled:
        print("Transcripts are disabled for this video.", file=sys.stderr)
        sys.exit(1)
    except VideoUnavailable:
        print("Video is unavailable.", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error fetching transcript: {e}", file=sys.stderr)
        sys.exit(1)


def cmd_transcript_list(args):
    """List available transcripts for a video."""
    video_id = extract_video_id(args.video_id)
    
    try:
        ytt_api = YouTubeTranscriptApi()
        transcript_list = ytt_api.list(video_id)
        
        print(f"Available transcripts for {video_id}:")
        print()
        
        manual = []
        generated = []
        
        for transcript in transcript_list:
            entry = {
                'lang': transcript.language_code,
                'name': transcript.language,
                'translatable': transcript.is_translatable,
            }
            if transcript.is_generated:
                generated.append(entry)
            else:
                manual.append(entry)
        
        if manual:
            print("Manual captions:")
            for t in manual:
                trans = " (translatable)" if t['translatable'] else ""
                print(f"  ✓ {t['lang']} - {t['name']}{trans}")
        
        if generated:
            print("\nAuto-generated:")
            for t in generated:
                trans = " (translatable)" if t['translatable'] else ""
                print(f"  ◦ {t['lang']} - {t['name']}{trans}")
                
    except TranscriptsDisabled:
        print("Transcripts are disabled for this video.", file=sys.stderr)
        sys.exit(1)
    except VideoUnavailable:
        print("Video is unavailable.", file=sys.stderr)
        sys.exit(1)


# ============================================================================
# VIDEO INFO COMMANDS (API required)
# ============================================================================

def cmd_search(args):
    """Search YouTube."""
    youtube = get_youtube_service()
    
    params = {
        'part': 'snippet',
        'q': args.query,
        'type': 'video',
        'maxResults': args.limit,
    }
    
    if args.order:
        params['order'] = args.order
    if args.published_after:
        params['publishedAfter'] = args.published_after
    if args.duration:
        params['videoDuration'] = args.duration
    
    response = youtube.search().list(**params).execute()

    if args.json:
        print(json.dumps(response.get('items', []), indent=2, ensure_ascii=False))
        return

    for item in response.get('items', []):
        snippet = item['snippet']
        video_id = item['id']['videoId']
        print(f"📺 {snippet['title']}")
        print(f"   https://youtube.com/watch?v={video_id}")
        print(f"   Channel: {snippet['channelTitle']} | {snippet['publishedAt'][:10]}")
        if args.verbose:
            print(f"   {snippet.get('description', '')[:150]}...")
        print()


def cmd_video(args):
    """Get video details - supports batch mode."""
    youtube = get_youtube_service()
    
    video_ids = [extract_video_id(v) for v in args.video_ids]
    
    # Batch in groups of 50 (API limit)
    all_items = []
    for i in range(0, len(video_ids), 50):
        batch = video_ids[i:i+50]
        response = youtube.videos().list(
            part='snippet,contentDetails,statistics',
            id=','.join(batch)
        ).execute()
        all_items.extend(response.get('items', []))

    if args.json:
        print(json.dumps(all_items, indent=2, ensure_ascii=False))
        return

    for item in all_items:
        snippet = item['snippet']
        stats = item.get('statistics', {})
        content = item.get('contentDetails', {})
        
        print(f"📺 {snippet['title']}")
        print(f"   ID: {item['id']}")
        print(f"   Channel: {snippet['channelTitle']}")
        print(f"   Published: {snippet['publishedAt'][:10]}")
        print(f"   Duration: {content.get('duration', 'N/A')}")
        print(f"   Views: {int(stats.get('viewCount', 0)):,}")
        print(f"   Likes: {int(stats.get('likeCount', 0)):,}")
        if args.verbose:
            print(f"\n   Description:\n   {snippet['description'][:500]}...")
        print()


def cmd_comments(args):
    """Get video comments."""
    youtube = get_youtube_service()
    video_id = extract_video_id(args.video_id)
    
    params = {
        'part': 'snippet',
        'videoId': video_id,
        'maxResults': args.limit,
        'order': args.order,
        'textFormat': 'plainText',
    }
    
    response = youtube.commentThreads().list(**params).execute()

    if args.json:
        print(json.dumps(response.get('items', []), indent=2, ensure_ascii=False))
        return

    for item in response.get('items', []):
        comment = item['snippet']['topLevelComment']['snippet']
        print(f"💬 {comment['authorDisplayName']}")
        print(f"   {comment['textDisplay'][:200]}")
        print(f"   👍 {comment['likeCount']} | {comment['publishedAt'][:10]}")
        
        # Show replies if requested
        if args.replies and item['snippet']['totalReplyCount'] > 0:
            replies_response = youtube.comments().list(
                part='snippet',
                parentId=item['id'],
                maxResults=3
            ).execute()
            for reply in replies_response.get('items', []):
                r = reply['snippet']
                print(f"      ↳ {r['authorDisplayName']}: {r['textDisplay'][:100]}")
        print()


def cmd_channel(args):
    """Get channel info."""
    youtube = get_youtube_service()
    
    if args.channel_id:
        request = youtube.channels().list(
            part='snippet,statistics,contentDetails',
            id=args.channel_id
        )
    else:
        request = youtube.channels().list(
            part='snippet,statistics,contentDetails',
            mine=True
        )
    response = request.execute()

    if not response.get('items'):
        print("Channel not found")
        return

    if args.json:
        print(json.dumps(response['items'], indent=2, ensure_ascii=False))
        return

    for item in response['items']:
        snippet = item['snippet']
        stats = item.get('statistics', {})
        print(f"📢 {snippet['title']}")
        print(f"   ID: {item['id']}")
        print(f"   Subscribers: {int(stats.get('subscriberCount', 0)):,}")
        print(f"   Videos: {stats.get('videoCount', 'N/A')}")
        print(f"   Total Views: {int(stats.get('viewCount', 0)):,}")
        if args.verbose:
            print(f"\n   Description:\n   {snippet.get('description', '')[:300]}...")


# ============================================================================
# USER DATA COMMANDS
# ============================================================================

def cmd_subscriptions(args):
    """List subscriptions."""
    youtube = get_youtube_service()
    response = youtube.subscriptions().list(
        part='snippet',
        mine=True,
        maxResults=args.limit
    ).execute()

    if args.json:
        print(json.dumps(response.get('items', []), indent=2, ensure_ascii=False))
        return

    for item in response.get('items', []):
        snippet = item['snippet']
        print(f"📢 {snippet['title']}")
        print(f"   Channel: {snippet['resourceId']['channelId']}")


def cmd_playlists(args):
    """List playlists."""
    youtube = get_youtube_service()
    response = youtube.playlists().list(
        part='snippet,contentDetails',
        mine=True,
        maxResults=args.limit
    ).execute()

    if args.json:
        print(json.dumps(response.get('items', []), indent=2, ensure_ascii=False))
        return

    for item in response.get('items', []):
        snippet = item['snippet']
        count = item['contentDetails']['itemCount']
        print(f"📋 {snippet['title']} ({count} videos)")
        print(f"   ID: {item['id']}")


def cmd_playlist_items(args):
    """List items in a playlist."""
    youtube = get_youtube_service()
    response = youtube.playlistItems().list(
        part='snippet',
        playlistId=args.playlist_id,
        maxResults=args.limit
    ).execute()

    if args.json:
        print(json.dumps(response.get('items', []), indent=2, ensure_ascii=False))
        return

    for item in response.get('items', []):
        snippet = item['snippet']
        video_id = snippet['resourceId']['videoId']
        print(f"📺 {snippet['title']}")
        print(f"   https://youtube.com/watch?v={video_id}")


def cmd_liked(args):
    """List liked videos."""
    youtube = get_youtube_service()
    response = youtube.videos().list(
        part='snippet',
        myRating='like',
        maxResults=args.limit
    ).execute()

    if args.json:
        print(json.dumps(response.get('items', []), indent=2, ensure_ascii=False))
        return

    for item in response.get('items', []):
        snippet = item['snippet']
        print(f"❤️ {snippet['title']}")
        print(f"   https://youtube.com/watch?v={item['id']}")


# ============================================================================
# DOWNLOAD COMMANDS (yt-dlp required)
# ============================================================================

def find_ytdlp():
    """Find yt-dlp binary."""
    return shutil.which('yt-dlp')


def run_ytdlp(cmd: List[str], url: str) -> int:
    """Run yt-dlp with proper error handling."""
    try:
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        if result.returncode != 0:
            stderr = result.stderr.lower()
            
            # Parse common errors
            if 'private video' in stderr:
                print("❌ Error: This video is private.", file=sys.stderr)
            elif 'sign in to confirm your age' in stderr or 'age-restricted' in stderr:
                print("❌ Error: This video is age-restricted. Use --cookies or login.", file=sys.stderr)
                print("   Tip: Export cookies from browser with 'yt-dlp --cookies-from-browser chrome'", file=sys.stderr)
            elif 'video unavailable' in stderr or 'video is unavailable' in stderr:
                print("❌ Error: Video is unavailable (deleted or region-blocked).", file=sys.stderr)
            elif 'copyright' in stderr:
                print("❌ Error: Video blocked due to copyright.", file=sys.stderr)
            elif 'live event' in stderr:
                print("❌ Error: Cannot download live streams (wait until it ends).", file=sys.stderr)
            elif 'members-only' in stderr or 'member' in stderr:
                print("❌ Error: This is a members-only video.", file=sys.stderr)
            elif 'premiere' in stderr:
                print("❌ Error: Video is a premiere that hasn't started yet.", file=sys.stderr)
            elif 'format' in stderr and 'not available' in stderr:
                print("❌ Error: Requested format not available. Use 'formats' command to see options.", file=sys.stderr)
            else:
                print(f"❌ Error: {result.stderr.strip()}", file=sys.stderr)
            
            return result.returncode
        
        # Success - show stdout
        if result.stdout:
            print(result.stdout)
        
        return 0
        
    except FileNotFoundError:
        print("❌ Error: yt-dlp not found. Install with: brew install yt-dlp", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"❌ Error: {e}", file=sys.stderr)
        return 1


def cmd_formats(args):
    """List available formats for a video."""
    ytdlp = find_ytdlp()
    if not ytdlp:
        print("Error: yt-dlp not found. Install with: brew install yt-dlp", file=sys.stderr)
        sys.exit(1)
    
    video_id = extract_video_id(args.video_id)
    url = f"https://youtube.com/watch?v={video_id}"
    
    if args.json:
        # Get detailed format info as JSON
        cmd = [ytdlp, '-J', '--no-download', url]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode != 0:
                print(f"Error: {result.stderr}", file=sys.stderr)
                sys.exit(1)
            
            data = json.loads(result.stdout)
            formats = []
            for f in data.get('formats', []):
                fmt = {
                    'id': f.get('format_id'),
                    'ext': f.get('ext'),
                    'resolution': f.get('resolution', 'audio only'),
                    'fps': f.get('fps'),
                    'vcodec': f.get('vcodec'),
                    'acodec': f.get('acodec'),
                    'filesize': f.get('filesize') or f.get('filesize_approx'),
                    'tbr': f.get('tbr'),  # total bitrate
                    'note': f.get('format_note'),
                }
                formats.append(fmt)
            print(json.dumps(formats, indent=2))
            
        except json.JSONDecodeError:
            print("Error: Failed to parse format info", file=sys.stderr)
            sys.exit(1)
    else:
        # Human-readable format list
        cmd = [ytdlp, '-F', url]
        print(f"📋 Available formats for: {url}\n")
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        if result.returncode != 0:
            stderr = result.stderr.lower()
            if 'private' in stderr:
                print("❌ Error: This video is private.", file=sys.stderr)
            elif 'unavailable' in stderr:
                print("❌ Error: Video is unavailable.", file=sys.stderr)
            else:
                print(f"Error: {result.stderr}", file=sys.stderr)
            sys.exit(1)
        
        print(result.stdout)
        print("\n💡 Tips:")
        print("   - Use 'download -f FORMAT_ID' to download specific format")
        print("   - Use 'download -r 720p' for quick resolution selection")
        print("   - Combine: '-f 137+140' for video+audio merge")


def cmd_download(args):
    """Download video using yt-dlp."""
    ytdlp = find_ytdlp()
    if not ytdlp:
        print("Error: yt-dlp not found. Install with: brew install yt-dlp", file=sys.stderr)
        sys.exit(1)
    
    video_id = extract_video_id(args.video_id)
    url = f"https://youtube.com/watch?v={video_id}"
    
    cmd = [ytdlp, '--progress']
    
    # Output path
    if args.output:
        output_dir = Path(args.output).expanduser()
        output_dir.mkdir(parents=True, exist_ok=True)
        cmd.extend(['-o', f"{output_dir}/%(title)s.%(ext)s"])
    
    # Format selection
    if args.format_id:
        cmd.extend(['-f', args.format_id])
    elif args.resolution:
        res_map = {
            '480p': 'bestvideo[height<=480]+bestaudio/best[height<=480]',
            '720p': 'bestvideo[height<=720]+bestaudio/best[height<=720]',
            '1080p': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
            '1440p': 'bestvideo[height<=1440]+bestaudio/best[height<=1440]',
            '4k': 'bestvideo[height<=2160]+bestaudio/best[height<=2160]',
            'best': 'bestvideo+bestaudio/best',
        }
        cmd.extend(['-f', res_map.get(args.resolution, 'best')])
    
    # Subtitles
    if args.subtitles:
        cmd.extend(['--write-auto-subs', '--sub-lang', args.subtitles])
    
    # Cookies for age-restricted videos
    if args.cookies:
        cmd.extend(['--cookies', args.cookies])
    elif args.cookies_from_browser:
        cmd.extend(['--cookies-from-browser', args.cookies_from_browser])
    
    # Embed metadata
    if args.embed_metadata:
        cmd.append('--embed-metadata')
    
    # Restrict filename chars (for compatibility)
    if args.restrict_filenames:
        cmd.append('--restrict-filenames')
    
    cmd.append(url)
    
    print(f"⬇️  Downloading: {url}")
    if args.resolution:
        print(f"   Resolution: {args.resolution}")
    
    exit_code = run_ytdlp(cmd, url)
    if exit_code == 0:
        print("✅ Download complete!")
    sys.exit(exit_code)


def cmd_download_audio(args):
    """Download audio only using yt-dlp."""
    ytdlp = find_ytdlp()
    if not ytdlp:
        print("Error: yt-dlp not found. Install with: brew install yt-dlp", file=sys.stderr)
        sys.exit(1)
    
    video_id = extract_video_id(args.video_id)
    url = f"https://youtube.com/watch?v={video_id}"
    
    cmd = [ytdlp, '-x', '--progress']
    
    # Audio format
    audio_format = args.format or 'mp3'
    cmd.extend(['--audio-format', audio_format])
    
    # Audio quality
    if args.quality:
        cmd.extend(['--audio-quality', args.quality])
    
    # Output path
    if args.output:
        output_dir = Path(args.output).expanduser()
        output_dir.mkdir(parents=True, exist_ok=True)
        cmd.extend(['-o', f"{output_dir}/%(title)s.%(ext)s"])
    
    # Cookies for age-restricted videos
    if args.cookies:
        cmd.extend(['--cookies', args.cookies])
    elif args.cookies_from_browser:
        cmd.extend(['--cookies-from-browser', args.cookies_from_browser])
    
    # Embed thumbnail in audio file
    if args.embed_thumbnail:
        cmd.append('--embed-thumbnail')
    
    # Embed metadata
    if args.embed_metadata:
        cmd.append('--embed-metadata')
    
    cmd.append(url)
    
    print(f"🎵 Extracting audio: {url}")
    print(f"   Format: {audio_format}")
    
    exit_code = run_ytdlp(cmd, url)
    if exit_code == 0:
        print("✅ Audio extraction complete!")
    sys.exit(exit_code)


# ============================================================================
# MAIN
# ============================================================================

def main():
    global _current_account

    parser = argparse.ArgumentParser(
        description='YouTube Research Pro - Comprehensive YouTube access',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument('-v', '--verbose', action='store_true', help='Verbose output')
    parser.add_argument('-a', '--account', default=DEFAULT_ACCOUNT, help='Account name')
    parser.add_argument('--json', action='store_true', help='Output as JSON')
    subparsers = parser.add_subparsers(dest='command', help='Commands')

    # ---- Auth ----
    auth_p = subparsers.add_parser('auth', help='Authenticate with YouTube')
    auth_p.set_defaults(func=cmd_auth)
    
    acc_p = subparsers.add_parser('accounts', help='List authenticated accounts')
    acc_p.set_defaults(func=cmd_accounts)

    # ---- Transcripts (FREE!) ----
    trans_p = subparsers.add_parser('transcript', aliases=['tr', 'trans'], 
                                     help='Get video transcript (FREE - no API quota!)')
    trans_p.add_argument('video_id', help='Video ID or URL')
    trans_p.add_argument('-l', '--language', default='en', help='Language code(s), comma-separated')
    trans_p.add_argument('-t', '--timestamps', action='store_true', help='Include timestamps')
    trans_p.set_defaults(func=cmd_transcript)
    
    transl_p = subparsers.add_parser('transcript-list', aliases=['trl'], 
                                      help='List available transcripts')
    transl_p.add_argument('video_id', help='Video ID or URL')
    transl_p.set_defaults(func=cmd_transcript_list)

    # ---- Search ----
    search_p = subparsers.add_parser('search', aliases=['s'], help='Search YouTube')
    search_p.add_argument('query', help='Search query')
    search_p.add_argument('-l', '--limit', type=int, default=10, help='Max results')
    search_p.add_argument('-o', '--order', choices=['relevance', 'date', 'viewCount', 'rating'],
                          help='Sort order')
    search_p.add_argument('--published-after', help='Filter by publish date (ISO format)')
    search_p.add_argument('--duration', choices=['short', 'medium', 'long'],
                          help='Filter by duration')
    search_p.set_defaults(func=cmd_search)

    # ---- Video ----
    video_p = subparsers.add_parser('video', aliases=['v'], help='Get video details')
    video_p.add_argument('video_ids', nargs='+', help='Video ID(s) or URL(s)')
    video_p.set_defaults(func=cmd_video)

    # ---- Comments ----
    comm_p = subparsers.add_parser('comments', aliases=['c'], help='Get video comments')
    comm_p.add_argument('video_id', help='Video ID or URL')
    comm_p.add_argument('-l', '--limit', type=int, default=20, help='Max results')
    comm_p.add_argument('-o', '--order', choices=['relevance', 'time'], default='relevance')
    comm_p.add_argument('-r', '--replies', action='store_true', help='Include replies')
    comm_p.set_defaults(func=cmd_comments)

    # ---- Channel ----
    ch_p = subparsers.add_parser('channel', aliases=['ch'], help='Get channel info')
    ch_p.add_argument('channel_id', nargs='?', help='Channel ID (omit for yours)')
    ch_p.set_defaults(func=cmd_channel)

    # ---- User Data ----
    subs_p = subparsers.add_parser('subscriptions', aliases=['subs'], help='List subscriptions')
    subs_p.add_argument('-l', '--limit', type=int, default=25, help='Max results')
    subs_p.set_defaults(func=cmd_subscriptions)

    pl_p = subparsers.add_parser('playlists', aliases=['pl'], help='List playlists')
    pl_p.add_argument('-l', '--limit', type=int, default=25, help='Max results')
    pl_p.set_defaults(func=cmd_playlists)

    pli_p = subparsers.add_parser('playlist-items', aliases=['pli'], help='List playlist items')
    pli_p.add_argument('playlist_id', help='Playlist ID')
    pli_p.add_argument('-l', '--limit', type=int, default=25, help='Max results')
    pli_p.set_defaults(func=cmd_playlist_items)

    liked_p = subparsers.add_parser('liked', help='List liked videos')
    liked_p.add_argument('-l', '--limit', type=int, default=25, help='Max results')
    liked_p.set_defaults(func=cmd_liked)

    # ---- Downloads ----
    fmt_p = subparsers.add_parser('formats', aliases=['fmt', 'F'], help='List available formats')
    fmt_p.add_argument('video_id', help='Video ID or URL')
    fmt_p.set_defaults(func=cmd_formats)
    # Note: --json is inherited from global parser

    dl_p = subparsers.add_parser('download', aliases=['dl'], help='Download video (yt-dlp)')
    dl_p.add_argument('video_id', help='Video ID or URL')
    dl_p.add_argument('-o', '--output', help='Output directory')
    dl_p.add_argument('-r', '--resolution', choices=['480p', '720p', '1080p', '1440p', '4k', 'best'],
                      default='best', help='Video resolution')
    dl_p.add_argument('-f', '--format-id', help='Specific format ID (from formats command)')
    dl_p.add_argument('-s', '--subtitles', help='Download subtitles (language code)')
    dl_p.add_argument('--cookies', help='Path to cookies file (for age-restricted)')
    dl_p.add_argument('--cookies-from-browser', choices=['chrome', 'firefox', 'safari', 'edge', 'brave'],
                      help='Extract cookies from browser')
    dl_p.add_argument('--embed-metadata', action='store_true', help='Embed video metadata')
    dl_p.add_argument('--restrict-filenames', action='store_true', help='Restrict filename chars')
    dl_p.set_defaults(func=cmd_download)

    dla_p = subparsers.add_parser('download-audio', aliases=['dla'], help='Download audio only')
    dla_p.add_argument('video_id', help='Video ID or URL')
    dla_p.add_argument('-o', '--output', help='Output directory')
    dla_p.add_argument('-f', '--format', choices=['mp3', 'm4a', 'opus', 'wav', 'flac', 'best'],
                       default='mp3', help='Audio format')
    dla_p.add_argument('-q', '--quality', choices=['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
                       help='Audio quality (0=best, 9=worst)')
    dla_p.add_argument('--cookies', help='Path to cookies file (for age-restricted)')
    dla_p.add_argument('--cookies-from-browser', choices=['chrome', 'firefox', 'safari', 'edge', 'brave'],
                       help='Extract cookies from browser')
    dla_p.add_argument('--embed-thumbnail', action='store_true', help='Embed thumbnail in audio')
    dla_p.add_argument('--embed-metadata', action='store_true', help='Embed audio metadata')
    dla_p.set_defaults(func=cmd_download_audio)

    args = parser.parse_args()
    _current_account = args.account

    if not args.command:
        parser.print_help()
        sys.exit(1)

    args.func(args)


if __name__ == '__main__':
    main()
