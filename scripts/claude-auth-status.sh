#!/usr/bin/env bash
# claude-auth-status.sh — Check Claude Code and OpenClaw OAuth token health.
# Used by cron jobs and widgets to detect when re-authentication is needed.

set -euo pipefail

# ── Constants ──────────────────────────────────────────────────────────────────

readonly CLAUDE_CREDS="$HOME/.claude/.credentials.json"
readonly OPENCLAW_AUTH="$HOME/.openclaw/agents/main/agent/auth-profiles.json"

# Terminal colors (only used in full output mode)
readonly CLR_RED='\033[0;31m'
readonly CLR_YELLOW='\033[1;33m'
readonly CLR_GREEN='\033[0;32m'
readonly CLR_NC='\033[0m'

# Threshold under which we warn EXPIRING (1 hour in ms)
readonly EXPIRY_WARN_THRESHOLD_MS=3600000

# ── Functions ──────────────────────────────────────────────────────────────────

# Returns token status string and an exit code callers can branch on.
# Exit 0 = OK, 1 = expired/missing, 2 = expiring soon.
calc_status_from_expires() {
    local expires_at="$1"
    if ! [[ "$expires_at" =~ ^-?[0-9]+$ ]]; then
        expires_at=0
    fi
    local now_ms
    now_ms=$(( $(date +%s) * 1000 ))
    local diff_ms=$(( expires_at - now_ms ))
    local hours=$(( diff_ms / 3600000 ))
    local mins=$(( (diff_ms % 3600000) / 60000 ))

    if [[ "$expires_at" -le 0 ]]; then
        echo "MISSING"
        return 1
    elif [[ "$diff_ms" -lt 0 ]]; then
        echo "EXPIRED"
        return 1
    elif [[ "$diff_ms" -lt "$EXPIRY_WARN_THRESHOLD_MS" ]]; then
        echo "EXPIRING:${mins}m"
        return 2
    else
        echo "OK:${hours}h${mins}m"
        return 0
    fi
}

# Pulls live auth data from the openclaw CLI when available (preferred over file reads).
fetch_models_status_json() {
    openclaw models status --json 2>/dev/null || true
}

# jq helpers — all extract from the JSON blob returned by fetch_models_status_json.

json_expires_for_claude_cli() {
    echo "$status_json" | jq -r '
        [.auth.oauth.profiles[]
          | select(.provider == "anthropic" and (.type == "oauth" or .type == "token"))
          | .expiresAt // 0]
        | max // 0
    ' 2>/dev/null || echo "0"
}

json_expires_for_anthropic_any() {
    echo "$status_json" | jq -r '
        [.auth.oauth.profiles[]
          | select(.provider == "anthropic" and .type == "oauth")
          | .expiresAt // 0]
        | max // 0
    ' 2>/dev/null || echo "0"
}

json_best_anthropic_profile() {
    echo "$status_json" | jq -r '
        [.auth.oauth.profiles[]
          | select(.provider == "anthropic" and .type == "oauth")
          | {id: .profileId, exp: (.expiresAt // 0)}]
        | sort_by(.exp) | reverse | .[0].id // "none"
    ' 2>/dev/null || echo "none"
}

json_anthropic_api_key_count() {
    echo "$status_json" | jq -r '
        [.auth.providers[] | select(.provider == "anthropic") | .profiles.apiKey]
        | max // 0
    ' 2>/dev/null || echo "0"
}

check_claude_code_auth() {
    if [[ "$use_json" -eq 1 ]]; then
        local expires_at
        expires_at=$(json_expires_for_claude_cli)
        calc_status_from_expires "$expires_at"
        return $?
    fi

    if [[ ! -f "$CLAUDE_CREDS" ]]; then
        echo "MISSING"
        return 1
    fi

    local expires_at
    expires_at=$(jq -r '.claudeAiOauth.expiresAt // 0' "$CLAUDE_CREDS" 2>/dev/null || echo "0")
    calc_status_from_expires "$expires_at"
}

check_openclaw_auth() {
    if [[ "$use_json" -eq 1 ]]; then
        local api_keys
        api_keys=$(json_anthropic_api_key_count)
        if ! [[ "$api_keys" =~ ^[0-9]+$ ]]; then
            api_keys=0
        fi
        local expires_at
        expires_at=$(json_expires_for_anthropic_any)

        # Static API key — no expiry applies
        if [[ "$expires_at" -le 0 ]] && [[ "$api_keys" -gt 0 ]]; then
            echo "OK:static"
            return 0
        fi

        calc_status_from_expires "$expires_at"
        return $?
    fi

    if [[ ! -f "$OPENCLAW_AUTH" ]]; then
        echo "MISSING"
        return 1
    fi

    local expires
    expires=$(jq -r '
        [.profiles | to_entries[] | select(.value.provider == "anthropic") | .value.expires]
        | max // 0
    ' "$OPENCLAW_AUTH" 2>/dev/null || echo "0")

    calc_status_from_expires "$expires"
}

output_json() {
    local claude_status openclaw_status claude_expires openclaw_expires
    claude_status=$(check_claude_code_auth 2>/dev/null || true)
    openclaw_status=$(check_openclaw_auth 2>/dev/null || true)

    if [[ "$use_json" -eq 1 ]]; then
        claude_expires=$(json_expires_for_claude_cli)
        openclaw_expires=$(json_expires_for_anthropic_any)
    else
        claude_expires=$(jq -r '.claudeAiOauth.expiresAt // 0' "$CLAUDE_CREDS" 2>/dev/null || echo "0")
        openclaw_expires=$(jq -r '.profiles["anthropic:default"].expires // 0' "$OPENCLAW_AUTH" 2>/dev/null || echo "0")
    fi

    jq -n \
        --arg cs "$claude_status" \
        --arg ce "$claude_expires" \
        --arg bs "$openclaw_status" \
        --arg be "$openclaw_expires" \
        '{
            claude_code: {status: $cs, expires_at_ms: ($ce | tonumber)},
            openclaw: {status: $bs, expires_at_ms: ($be | tonumber)},
            needs_reauth: (($cs | startswith("EXPIRED") or startswith("EXPIRING") or startswith("MISSING")) or ($bs | startswith("EXPIRED") or startswith("EXPIRING") or startswith("MISSING")))
        }'
}

output_simple() {
    local claude_status openclaw_status
    claude_status=$(check_claude_code_auth 2>/dev/null || true)
    openclaw_status=$(check_openclaw_auth 2>/dev/null || true)

    if [[ "$claude_status" == EXPIRED* ]] || [[ "$claude_status" == MISSING* ]]; then
        echo "CLAUDE_EXPIRED"
        exit 1
    elif [[ "$openclaw_status" == EXPIRED* ]] || [[ "$openclaw_status" == MISSING* ]]; then
        echo "OPENCLAW_EXPIRED"
        exit 1
    elif [[ "$claude_status" == EXPIRING* ]]; then
        echo "CLAUDE_EXPIRING"
        exit 2
    elif [[ "$openclaw_status" == EXPIRING* ]]; then
        echo "OPENCLAW_EXPIRING"
        exit 2
    else
        echo "OK"
        exit 0
    fi
}

output_full() {
    echo "=== Claude Code Auth Status ==="
    echo ""

    echo "Claude Code (~/.claude/.credentials.json):"
    local expires_at
    if [[ "$use_json" -eq 1 ]]; then
        expires_at=$(json_expires_for_claude_cli)
    else
        expires_at=$(jq -r '.claudeAiOauth.expiresAt // 0' "$CLAUDE_CREDS" 2>/dev/null || echo "0")
    fi

    if [[ -f "$CLAUDE_CREDS" ]]; then
        local sub_type rate_tier
        sub_type=$(jq -r '.claudeAiOauth.subscriptionType // "unknown"' "$CLAUDE_CREDS" 2>/dev/null || echo "unknown")
        rate_tier=$(jq -r '.claudeAiOauth.rateLimitTier // "unknown"' "$CLAUDE_CREDS" 2>/dev/null || echo "unknown")
        echo "  Subscription: $sub_type"
        echo "  Rate tier: $rate_tier"
    fi

    if [[ "$expires_at" -le 0 ]]; then
        echo -e "  Status: ${CLR_RED}NOT FOUND${CLR_NC}"
        echo "  Action needed: Run 'claude setup-token'"
    else
        local now_ms diff_ms hours mins
        now_ms=$(( $(date +%s) * 1000 ))
        diff_ms=$(( expires_at - now_ms ))
        hours=$(( diff_ms / 3600000 ))
        mins=$(( (diff_ms % 3600000) / 60000 ))

        if [[ "$diff_ms" -lt 0 ]]; then
            echo -e "  Status: ${CLR_RED}EXPIRED${CLR_NC}"
            echo "  Action needed: Run 'claude setup-token' or re-authenticate"
        elif [[ "$diff_ms" -lt "$EXPIRY_WARN_THRESHOLD_MS" ]]; then
            echo -e "  Status: ${CLR_YELLOW}EXPIRING SOON (${mins}m remaining)${CLR_NC}"
            echo "  Consider running: claude setup-token"
        else
            echo -e "  Status: ${CLR_GREEN}OK${CLR_NC}"
            echo "  Expires: $(date -d @$(( expires_at / 1000 ))) (${hours}h ${mins}m)"
        fi
    fi

    echo ""
    echo "OpenClaw Auth (~/.openclaw/agents/main/agent/auth-profiles.json):"

    local best_profile expires api_keys
    if [[ "$use_json" -eq 1 ]]; then
        best_profile=$(json_best_anthropic_profile)
        expires=$(json_expires_for_anthropic_any)
        api_keys=$(json_anthropic_api_key_count)
    else
        best_profile=$(jq -r '
            .profiles | to_entries
            | map(select(.value.provider == "anthropic"))
            | sort_by(.value.expires) | reverse
            | .[0].key // "none"
        ' "$OPENCLAW_AUTH" 2>/dev/null || echo "none")
        expires=$(jq -r '
            [.profiles | to_entries[] | select(.value.provider == "anthropic") | .value.expires]
            | max // 0
        ' "$OPENCLAW_AUTH" 2>/dev/null || echo "0")
        api_keys=0
    fi

    echo "  Profile: $best_profile"

    if [[ "$expires" -le 0 ]] && [[ "$api_keys" -gt 0 ]]; then
        echo -e "  Status: ${CLR_GREEN}OK${CLR_NC} (API key)"
    elif [[ "$expires" -le 0 ]]; then
        echo -e "  Status: ${CLR_RED}NOT FOUND${CLR_NC}"
        echo "  Note: Run 'openclaw doctor --yes' to sync from Claude Code"
    else
        local now_ms diff_ms hours mins
        now_ms=$(( $(date +%s) * 1000 ))
        diff_ms=$(( expires - now_ms ))
        hours=$(( diff_ms / 3600000 ))
        mins=$(( (diff_ms % 3600000) / 60000 ))

        if [[ "$diff_ms" -lt 0 ]]; then
            echo -e "  Status: ${CLR_RED}EXPIRED${CLR_NC}"
            echo "  Note: Run 'openclaw doctor --yes' to sync from Claude Code"
        elif [[ "$diff_ms" -lt "$EXPIRY_WARN_THRESHOLD_MS" ]]; then
            echo -e "  Status: ${CLR_YELLOW}EXPIRING SOON (${mins}m remaining)${CLR_NC}"
        else
            echo -e "  Status: ${CLR_GREEN}OK${CLR_NC}"
            echo "  Expires: $(date -d @$(( expires / 1000 ))) (${hours}h ${mins}m)"
        fi
    fi

    echo ""
    echo "=== Service Status ==="
    if systemctl --user is-active openclaw >/dev/null 2>&1; then
        echo -e "OpenClaw service: ${CLR_GREEN}running${CLR_NC}"
    else
        echo -e "OpenClaw service: ${CLR_RED}NOT running${CLR_NC}"
    fi
}

# ── Main ───────────────────────────────────────────────────────────────────────

# Output mode: "full" (default), "json", or "simple"
output_mode="${1:-full}"

status_json="$(fetch_models_status_json)"
use_json=0
[[ -n "$status_json" ]] && use_json=1

case "$output_mode" in
    json)   output_json; exit 0 ;;
    simple) output_simple ;;
    full)   output_full ;;
    *)
        echo "Unknown output mode: $output_mode (use: full, json, simple)" >&2
        exit 1
        ;;
esac
