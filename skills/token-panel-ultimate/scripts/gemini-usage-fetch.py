#!/usr/bin/env python3
"""
Gemini API Usage Fetcher
Reports Gemini rate limits, and optionally verifies live access.

Google exposes neither rate-limit headers nor usage counters, so the limits reported
here are the PUBLISHED ones from Google's docs. That part is a lookup table and costs
nothing.

WHAT --probe ADDS, and why it is off by default: it calls Google with your key to (1)
validate it, (2) enumerate the models your account can see, and (3) send a 1-token
generateContent request to each model in PROBE_MODELS. Those are real API calls; they
appear in your account activity and spend a sliver of quota. A dashboard should not
spend your quota without being asked, so no network call happens unless you pass
--probe.

Usage:
    ./gemini-usage-fetch.py              # Published limits only — no network calls
    ./gemini-usage-fetch.py --probe      # Validate key + list models + 1-token probes
    ./gemini-usage-fetch.py --update     # Update gemini-usage.json
    ./gemini-usage-fetch.py --json       # Output raw JSON

Credential:
    python3 secretstore.py --login gemini      # sealed in your OS keychain
    python3 secretstore.py --logout gemini
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

USAGE_JSON_PATH = Path.home() / '.openclaw/workspace/memory/gemini-usage.json'
BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

# Models to probe (the ones OpenClaw actually uses)
PROBE_MODELS = [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
]

# Free tier rate limits (from https://ai.google.dev/gemini-api/docs/rate-limits, Feb 2026)
FREE_TIER_LIMITS = {
    "gemini-2.5-pro": {
        "rpm": 5, "rpd": 25, "tpm": 250_000,
        "tier": "free", "note": "Thinking model, lower free limits"
    },
    "gemini-2.5-flash": {
        "rpm": 10, "rpd": 500, "tpm": 250_000,
        "tier": "free", "note": "Fast + thinking"
    },
    "gemini-2.0-flash": {
        "rpm": 15, "rpd": 1500, "tpm": 1_000_000,
        "tier": "free", "note": "Workhorse model"
    },
    "gemini-2.0-flash-lite": {
        "rpm": 30, "rpd": 1500, "tpm": 1_000_000,
        "tier": "free", "note": "Lightweight"
    },
}

# Paid tier limits
PAID_TIER_LIMITS = {
    "gemini-2.5-pro": {
        "rpm": 150, "rpd": 10_000, "tpm": 1_000_000,
        "tier": "paid"
    },
    "gemini-2.5-flash": {
        "rpm": 2000, "rpd": 10_000, "tpm": 4_000_000,
        "tier": "paid"
    },
    "gemini-2.0-flash": {
        "rpm": 2000, "rpd": 10_000, "tpm": 4_000_000,
        "tier": "paid"
    },
}


def get_api_key():
    """Return this tool's Gemini key from the keychain-backed store.

    Not a bare os.environ read: the skill advertises keychain-sealed credentials, so the
    lookup goes through secretstore (keychain, warned 0600 fallback, or the namespaced
    TOKEN_PANEL_GEMINI_KEY). A generic GEMINI_API_KEY belonging to another tool is used
    only with TOKEN_PANEL_ALLOW_PROVIDER_ENV=1.
    """
    key, _source = secretstore.get_secret('gemini')
    return key


def list_models(api_key):
    """List available models."""
    url = f'{BASE_URL}/models?key={api_key}'
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read())
            return [m['name'].split('/')[-1] for m in data.get('models', [])]
    except Exception as e:
        return {"error": str(e)}


def probe_model(api_key, model):
    """Make a 1-token call to verify access and get token counts."""
    url = f'{BASE_URL}/models/{model}:generateContent?key={api_key}'
    data = json.dumps({
        "contents": [{"parts": [{"text": "x"}]}],
        "generationConfig": {"maxOutputTokens": 1}
    }).encode()

    req = urllib.request.Request(url, data=data, headers={
        'Content-Type': 'application/json'
    })

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read())
            usage = result.get('usageMetadata', {})
            return {
                "status": "ok",
                "promptTokens": usage.get('promptTokenCount', 0),
                "completionTokens": usage.get('candidatesTokenCount', 0),
                "totalTokens": usage.get('totalTokenCount', 0),
            }
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:300]
        return {"status": "error", "code": e.code, "message": body}
    except Exception as e:
        return {"status": "error", "message": str(e)}


def detect_tier(api_key):
    """Try to detect if we're on free or paid tier.
    Free tier keys start with 'AIza' (AI Studio keys).
    Paid tier typically uses service accounts or billing-linked projects.
    Without a probe there is no key loaded, so the tier is simply unknown.
    """
    if api_key and api_key.startswith('AIza'):
        return "free"
    return "unknown"


def build_output(api_key, probes, available_models):
    tier = detect_tier(api_key)
    limits = FREE_TIER_LIMITS if tier == "free" else PAID_TIER_LIMITS

    models = {}
    total_probe_tokens = 0

    for model, result in probes.items():
        model_limits = limits.get(model, FREE_TIER_LIMITS.get(model, {}))
        models[model] = {
            "status": result.get("status"),
            "probe_tokens": result.get("totalTokens", 0),
            "rate_limits": {
                "rpm": model_limits.get("rpm"),
                "rpd": model_limits.get("rpd"),
                "tpm": model_limits.get("tpm"),
            },
            "note": model_limits.get("note", ""),
        }
        total_probe_tokens += result.get("totalTokens", 0)

    return {
        "provider": "google",
        "fetchedAt": datetime.utcnow().isoformat() + 'Z',
        # Only a live call can say a key is valid. Without --probe nothing was checked,
        # and claiming "valid" would be reporting a test that never ran.
        "api_key_status": "valid" if probes else "not checked (no --probe)",
        "detected_tier": tier,
        "probe_cost_tokens": total_probe_tokens,
        "available_models_count": len(available_models) if isinstance(available_models, list) else 0,
        "models": models,
        "all_rate_limits": {
            "free": FREE_TIER_LIMITS,
            "paid": PAID_TIER_LIMITS,
        },
    }


def print_usage(output):
    tier = output.get('detected_tier', '?')
    tier_icon = '🆓' if tier == 'free' else '💰' if tier == 'paid' else '❓'

    print(f"\n╔══════════════════════════════════════════════╗")
    print(f"║         GEMINI API USAGE                     ║")
    print(f"╠══════════════════════════════════════════════╣")
    key_status = output.get('api_key_status', 'unknown')
    print(f"║ API Key: {key_status:<36}║")
    print(f"║ Tier: {tier_icon} {tier:<10}                            ║")
    print(f"║ Probe cost: {output.get('probe_cost_tokens', 0)} tokens                      ║")
    print(f"║ Available models: {output.get('available_models_count', '?'):<4}                       ║")
    print(f"║──────────────────────────────────────────────║")
    print(f"║ Model Status & Rate Limits ({tier} tier):      ║")

    for model, info in output.get("models", {}).items():
        status = info.get("status", "?")
        rl = info.get("rate_limits", {})
        if status == "ok":
            rpm = rl.get("rpm", "?")
            rpd = rl.get("rpd", "?")
            tpm = rl.get("tpm", "?")
            tpm_k = f"{tpm//1000}K" if isinstance(tpm, int) else tpm
            note = info.get("note", "")
            print(f"║  ✅ {model:<22} {rpm:>4} rpm  {rpd:>5} rpd ║")
            print(f"║     {tpm_k:>6} tpm  {note:<28}║")
        else:
            code = info.get("code", "?")
            print(f"║  ❌ {model:<22} HTTP {code:<16}  ║")

    print(f"║──────────────────────────────────────────────║")
    print(f"║ ⚠ Google does not expose usage counters      ║")
    print(f"║   via API. Limits shown are from docs.       ║")
    print(f"╚══════════════════════════════════════════════╝\n")


PROBE_NOTICE = (
    "Validating the key, listing models and probing each model are all live calls to\n"
    "Google using your credential, and they spend a little quota. Re-run with --probe\n"
    "to allow that; without it, only Google's published rate limits are shown and\n"
    "nothing leaves this machine."
)


def main():
    args = sys.argv[1:]
    probe_enabled = '--probe' in args

    api_key = None
    available = []
    probes = {}

    if probe_enabled:
        api_key = get_api_key()
        if not api_key:
            print(
                "❌ No Gemini credential stored for this tool.\n"
                "   Store one:  python3 secretstore.py --login gemini",
                file=sys.stderr,
            )
            sys.exit(1)
        available = list_models(api_key)
        for model in PROBE_MODELS:
            probes[model] = probe_model(api_key, model)
    else:
        print(PROBE_NOTICE, file=sys.stderr)

    output = build_output(api_key, probes, available)
    output["probed"] = probe_enabled

    if '--json' in args:
        print(json.dumps(output, indent=2))
    elif '--update' in args:
        USAGE_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(USAGE_JSON_PATH, 'w') as f:
            json.dump(output, f, indent=2)
        print(f"✓ Updated {USAGE_JSON_PATH}")
        for model, info in output["models"].items():
            status = info.get("status", "?")
            rl = info.get("rate_limits", {})
            print(f"  {model}: {status} | {rl.get('rpm','?')} rpm, {rl.get('rpd','?')} rpd")
    else:
        print_usage(output)


if __name__ == '__main__':
    main()
