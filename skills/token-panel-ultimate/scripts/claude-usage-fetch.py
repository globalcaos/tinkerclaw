#!/usr/bin/env python3
"""
Claude Max Usage Fetcher
Fetches real-time Claude usage and writes claude-usage.json for the Budget Panel widget.

The only credential it will ever use is ITS OWN: a token you mint yourself with
`claude setup-token` and hand to this tool's keychain entry. It does not read Claude
Code's credential file, or any other application's — with no token of its own it fails
and tells you how to give it one.

Usage:
    ./claude-usage-fetch.py              # Print usage
    ./claude-usage-fetch.py --update     # Update claude-usage.json
    ./claude-usage-fetch.py --json       # Output raw JSON
    ./claude-usage-fetch.py --login      # Store your own token (read from stdin)
    ./claude-usage-fetch.py --logout     # Erase it from every local store
"""

import json
import os
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import secretstore

USAGE_JSON_PATH = Path.home() / '.openclaw/workspace/memory/claude-usage.json'
API_URL = 'https://api.anthropic.com/api/oauth/usage'

# This script reads NO other application's credential store. Earlier versions could
# borrow the OAuth token Claude Code keeps in its own config directory behind an
# environment-variable opt-in. That token was issued to Claude Code, not to this
# dashboard, and an opt-in does not turn a borrowed credential into a first-party one,
# so the path is gone rather than gated. Give this tool a token of its own.
NO_TOKEN_MESSAGE = (
    "No Claude credential is configured for this tool.\n\n"
    "Give it one of its own — nothing else on your machine is read:\n"
    "    claude setup-token | python3 {store} --login anthropic\n\n"
    "That token is stored in your OS keychain (or, if you have no keychain, in a 0600 file\n"
    "that this tool warns you about every run). Remove it at any time with:\n"
    "    python3 {store} --logout anthropic\n"
)


def get_oauth_token():
    """Return (token, info) for this tool's OWN credential, or fail closed."""
    token, source = secretstore.get_secret('anthropic')
    if token:
        return token, {'source': source}

    raise PermissionError(
        NO_TOKEN_MESSAGE.format(store=Path(secretstore.__file__).resolve())
    )

def fetch_usage(token):
    """Fetch usage from Anthropic OAuth API."""
    req = urllib.request.Request(
        API_URL,
        headers={
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'claude-code/2.0.32',
            'Authorization': f'Bearer {token}',
            'anthropic-beta': 'oauth-2025-04-20'
        }
    )
    
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())

def format_reset_time(iso_str):
    """Convert ISO timestamp to human-readable local time."""
    if not iso_str:
        return None
    dt = datetime.fromisoformat(iso_str.replace('+00:00', '+00:00'))
    # Convert to local time (simple approach)
    return dt.strftime('%Y-%m-%d %H:%M UTC')

def update_usage_json(usage_data, oauth_info):
    """Update claude-usage.json with fetched data."""
    five_hour = usage_data.get('five_hour', {}) or {}
    seven_day = usage_data.get('seven_day', {}) or {}
    seven_day_sonnet = usage_data.get('seven_day_sonnet', {}) or {}
    seven_day_opus = usage_data.get('seven_day_opus', {}) or {}
    extra = usage_data.get('extra_usage', {}) or {}
    
    output = {
        "mode": "subscription",
        "plan": oauth_info.get('subscriptionType', 'unknown'),
        "rateLimitTier": oauth_info.get('rateLimitTier', 'unknown'),
        "fetchedAt": datetime.utcnow().isoformat() + 'Z',
        "limits": {
            "five_hour": {
                "utilization": five_hour.get('utilization', 0),
                "resets_at": five_hour.get('resets_at'),
                "resets_at_human": format_reset_time(five_hour.get('resets_at'))
            },
            "seven_day": {
                "utilization": seven_day.get('utilization', 0),
                "resets_at": seven_day.get('resets_at'),
                "resets_at_human": format_reset_time(seven_day.get('resets_at'))
            },
            "seven_day_sonnet": {
                "utilization": seven_day_sonnet.get('utilization', 0),
                "resets_at": seven_day_sonnet.get('resets_at')
            },
            "seven_day_opus": {
                "utilization": (seven_day_opus.get('utilization', 0) if seven_day_opus else 0),
                "resets_at": (seven_day_opus.get('resets_at') if seven_day_opus else None)
            }
        },
        "extra_usage": {
            "enabled": extra.get('is_enabled', False),
            "monthly_limit": extra.get('monthly_limit'),
            "used_credits": extra.get('used_credits'),
            "utilization": extra.get('utilization')
        }
    }
    
    # Owner-only: this file reports your plan, quota and reset times. Do not let it
    # inherit a loose umask from whatever shell or daemon happened to run us.
    USAGE_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(USAGE_JSON_PATH), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(output, f, indent=2)
    os.chmod(USAGE_JSON_PATH, 0o600)

    return output

def print_usage(usage_data):
    """Print formatted usage to terminal."""
    five_hour = usage_data.get('five_hour', {}) or {}
    seven_day = usage_data.get('seven_day', {}) or {}
    seven_day_sonnet = usage_data.get('seven_day_sonnet', {}) or {}
    
    def bar(pct):
        filled = int(pct / 5)
        return '█' * filled + '░' * (20 - filled)
    
    print("\n╔══════════════════════════════════════════╗")
    print("║       CLAUDE MAX USAGE (REAL-TIME)       ║")
    print("╠══════════════════════════════════════════╣")
    
    # 5-hour
    pct = five_hour.get('utilization', 0)
    reset = format_reset_time(five_hour.get('resets_at')) or 'N/A'
    print(f"║ 5-Hour:  {bar(pct)} {pct:5.1f}% ║")
    print(f"║          Resets: {reset:<22} ║")
    
    # 7-day
    pct = seven_day.get('utilization', 0)
    reset = format_reset_time(seven_day.get('resets_at')) or 'N/A'
    print(f"║ 7-Day:   {bar(pct)} {pct:5.1f}% ║")
    print(f"║          Resets: {reset:<22} ║")
    
    # 7-day Sonnet (if used)
    pct = seven_day_sonnet.get('utilization', 0)
    if pct > 0:
        print(f"║ Sonnet:  {bar(pct)} {pct:5.1f}% ║")
    
    print("╚══════════════════════════════════════════╝\n")

def manage_credentials(args):
    """Handle --login / --logout here rather than advertising them and doing nothing.

    Returns an exit code if the run was a credential-management command, else None.
    """
    if '--login' in args:
        if sys.stdin.isatty():
            print("Paste the Anthropic token, then press Ctrl-D:", file=sys.stderr)
            print("  (mint one with: claude setup-token)", file=sys.stderr)
        value = sys.stdin.read().strip()
        if not value:
            print("Nothing read from stdin; aborted.", file=sys.stderr)
            return 1
        where = secretstore.set_secret('anthropic', value)
        print(f"Stored the anthropic credential in: {where}")
        return 0

    if '--logout' in args:
        secretstore.clear_secret('anthropic')
        return 0

    return None


def main():
    args = sys.argv[1:]

    code = manage_credentials(args)
    if code is not None:
        sys.exit(code)

    try:
        token, oauth_info = get_oauth_token()
        usage_data = fetch_usage(token)
        
        if '--json' in args:
            print(json.dumps(usage_data, indent=2))
        elif '--update' in args:
            output = update_usage_json(usage_data, oauth_info)
            print(f"✓ Updated {USAGE_JSON_PATH}")
            print(f"  5h: {output['limits']['five_hour']['utilization']}%  |  7d: {output['limits']['seven_day']['utilization']}%")
        else:
            print_usage(usage_data)
            
    except PermissionError as e:
        print(f"❌ {e}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.HTTPError as e:
        print(f"❌ API Error {e.code}: {e.reason}", file=sys.stderr)
        if e.code == 401:
            print("   This tool's token was rejected. Mint a fresh one:", file=sys.stderr)
            print("   claude setup-token | ./claude-usage-fetch.py --login", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"❌ Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
