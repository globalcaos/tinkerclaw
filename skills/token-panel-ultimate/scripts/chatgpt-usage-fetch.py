#!/usr/bin/env python3
"""
ChatGPT Usage Fetcher
Reports OpenAI rate-limit capacity per model.

HOW THE NUMBERS ARE OBTAINED — read this before using --probe. OpenAI publishes remaining
capacity only in the x-ratelimit-* response headers, so there is no passive way to read
it: the only way to see your headroom is to MAKE A REAL REQUEST. --probe sends a
1-token chat completion to each model in PROBE_MODELS. That is a genuine, billable API
call against your account, it appears in your usage history, and it consumes a sliver of
quota. Because a dashboard spending your quota unasked is a surprise, probing is OFF by
default: without --probe this script reports the documented subscription caps and no
network call is made.

Usage:
    ./chatgpt-usage-fetch.py              # Documented caps only — no network calls
    ./chatgpt-usage-fetch.py --probe      # Live rate-limit headroom (billable probe)
    ./chatgpt-usage-fetch.py --update     # Update chatgpt-usage.json
    ./chatgpt-usage-fetch.py --json       # Output raw JSON

Credential:
    python3 secretstore.py --login openai      # sealed in your OS keychain
    python3 secretstore.py --logout openai
"""

import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import secretstore

USAGE_JSON_PATH = Path.home() / '.openclaw/workspace/memory/chatgpt-usage.json'

# Models to probe for rate limits (1 token each, cheap)
PROBE_MODELS = [
    "gpt-4o",
]

# ChatGPT Plus known limits (Feb 2026)
PLUS_LIMITS = {
    "gpt-4o":       {"cap": 150, "window": "3hr rolling"},
    "o3":           {"cap": 100, "window": "weekly (Sun UTC)"},
    "o4-mini":      {"cap": 300, "window": "daily (midnight UTC)"},
    "o4-mini-high": {"cap": 100, "window": "daily (midnight UTC)"},
    "gpt-4.5":      {"cap": 50,  "window": "weekly"},
    "dall-e-3":     {"cap": 50,  "window": "3hr rolling"},
}


def get_api_key():
    """Return this tool's OpenAI key from the keychain-backed store.

    Earlier versions read OPENAI_API_KEY straight from the environment and could be
    pointed at an env-style file to scrape. Both are gone: the credential comes from
    secretstore, which means the keychain, its warned 0600 fallback, or the namespaced
    TOKEN_PANEL_OPENAI_KEY variable. A generic OPENAI_API_KEY set for some other tool is
    used only if you opt in with TOKEN_PANEL_ALLOW_PROVIDER_ENV=1.
    """
    key, _source = secretstore.get_secret('openai')
    return key


def probe_model(api_key, model):
    """Make a 1-token call and extract rate limit headers."""
    data = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": "x"}],
        "max_tokens": 1
    }).encode()

    req = urllib.request.Request(
        'https://api.openai.com/v1/chat/completions',
        data=data,
        headers={
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json'
        }
    )

    def extract_headers(resp_headers):
        h = {}
        for name in resp_headers:
            nl = name.lower()
            if 'ratelimit' in nl or 'limit' in nl:
                h[name] = resp_headers[name]
        return h

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read())
            headers = extract_headers(resp.headers)
            return {
                "status": "ok",
                "model_used": result.get("model"),
                "tokens_used": result.get("usage", {}).get("total_tokens", 0),
                "rate_limits": {
                    "limit_requests": headers.get("x-ratelimit-limit-requests"),
                    "remaining_requests": headers.get("x-ratelimit-remaining-requests"),
                    "limit_tokens": headers.get("x-ratelimit-limit-tokens"),
                    "remaining_tokens": headers.get("x-ratelimit-remaining-tokens"),
                    "reset_requests": headers.get("x-ratelimit-reset-requests"),
                    "reset_tokens": headers.get("x-ratelimit-reset-tokens"),
                },
            }
    except urllib.error.HTTPError as e:
        headers = extract_headers(e.headers)
        return {
            "status": "error",
            "code": e.code,
            "message": e.read().decode()[:200],
            "rate_limits": {
                "limit_requests": headers.get("x-ratelimit-limit-requests"),
                "remaining_requests": headers.get("x-ratelimit-remaining-requests"),
                "limit_tokens": headers.get("x-ratelimit-limit-tokens"),
                "remaining_tokens": headers.get("x-ratelimit-remaining-tokens"),
            },
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}


def build_output(probes):
    """Build standardized output."""
    models = {}
    total_tokens_used = 0

    for model, result in probes.items():
        rl = result.get("rate_limits", {})
        limit_req = rl.get("limit_requests")
        remain_req = rl.get("remaining_requests")

        utilization = None
        if limit_req and remain_req:
            try:
                used = int(limit_req) - int(remain_req)
                utilization = round((used / int(limit_req)) * 100, 1)
            except (ValueError, ZeroDivisionError):
                pass

        models[model] = {
            "status": result.get("status"),
            "model_used": result.get("model_used", model),
            "rate_limits": rl,
            "utilization_pct": utilization,
        }

        if result.get("tokens_used"):
            total_tokens_used += result["tokens_used"]

    return {
        "provider": "openai",
        "fetchedAt": datetime.utcnow().isoformat() + 'Z',
        "api_key_status": "valid",
        "probe_cost_tokens": total_tokens_used,
        "models": models,
        "plus_subscription_limits": PLUS_LIMITS,
    }


def print_usage(output):
    """Pretty print."""
    def bar(pct):
        if pct is None:
            return '?' * 20
        filled = int(pct / 5)
        return '█' * filled + '░' * (20 - filled)

    print("\n╔══════════════════════════════════════════════╗")
    print("║         CHATGPT / OPENAI API USAGE           ║")
    print("╠══════════════════════════════════════════════╣")

    print(f"║ API Key: ✅ valid                             ║")
    print(f"║ Probe cost: {output.get('probe_cost_tokens', 0)} tokens                      ║")
    print("║──────────────────────────────────────────────║")
    print("║ API Rate Limits (per model):                 ║")

    for model, info in output.get("models", {}).items():
        rl = info.get("rate_limits", {})
        pct = info.get("utilization_pct")
        status = info.get("status", "?")

        if status == "ok":
            remain = rl.get("remaining_requests", "?")
            limit = rl.get("limit_requests", "?")
            pct_str = f"{pct:.0f}%" if pct is not None else "?"
            print(f"║  {model:<16} {bar(pct)} {pct_str:>4}  ║")
            print(f"║    {remain}/{limit} req  |  {rl.get('remaining_tokens','?')}/{rl.get('limit_tokens','?')} tok ║")
        else:
            code = info.get("code", "?")
            print(f"║  {model:<16} ❌ {code}                      ║")

    print("║──────────────────────────────────────────────║")
    print("║ ChatGPT Plus Caps (subscription):            ║")
    for model, limits in PLUS_LIMITS.items():
        print(f"║  {model:<16} {limits['cap']:>4} msg / {limits['window']:<16}║")

    print("╚══════════════════════════════════════════════╝\n")


PROBE_NOTICE = (
    "Live rate-limit headroom needs a real request: --probe sends one 1-token chat\n"
    "completion per model in PROBE_MODELS. Those are billable calls against your\n"
    "account. Re-run with --probe to allow it; without it, only the documented\n"
    "subscription caps below are shown and nothing leaves this machine."
)


def main():
    args = sys.argv[1:]
    probe_enabled = '--probe' in args

    probes = {}
    if probe_enabled:
        api_key = get_api_key()
        if not api_key:
            print(
                "❌ No OpenAI credential stored for this tool.\n"
                "   Store one:  python3 secretstore.py --login openai",
                file=sys.stderr,
            )
            sys.exit(1)
        for model in PROBE_MODELS:
            probes[model] = probe_model(api_key, model)
    else:
        print(PROBE_NOTICE, file=sys.stderr)

    output = build_output(probes)
    output["probed"] = probe_enabled

    if '--json' in args:
        print(json.dumps(output, indent=2))
    elif '--update' in args:
        USAGE_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(USAGE_JSON_PATH, 'w') as f:
            json.dump(output, f, indent=2)
        print(f"✓ Updated {USAGE_JSON_PATH}")
        for model, info in output["models"].items():
            pct = info.get("utilization_pct")
            pct_str = f"{pct:.0f}%" if pct is not None else "N/A"
            remain = info.get("rate_limits", {}).get("remaining_requests", "?")
            limit = info.get("rate_limits", {}).get("limit_requests", "?")
            print(f"  {model}: {remain}/{limit} requests ({pct_str} used)")
    else:
        print_usage(output)


if __name__ == '__main__':
    main()
