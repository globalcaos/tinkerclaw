#!/bin/bash

# clawlog — OpenClaw log viewer for macOS unified logging system.
# Apple hides private data from non-root log readers by default; sudo bypasses this.

set -euo pipefail

# ── Constants ──────────────────────────────────────────────────────────────────

readonly SUBSYSTEM="ai.openclaw"
readonly DEFAULT_LEVEL="info"
readonly DEFAULT_TAIL_LINES=50
readonly DEFAULT_TIME_RANGE="5m"

# Terminal colors
readonly CLR_RED='\033[0;31m'
readonly CLR_GREEN='\033[0;32m'
readonly CLR_YELLOW='\033[1;33m'
readonly CLR_BLUE='\033[0;34m'
readonly CLR_NC='\033[0m'

# ── Functions ──────────────────────────────────────────────────────────────────

show_usage() {
    cat << EOF
clawlog - OpenClaw Logging Utility

USAGE:
    clawlog [OPTIONS]

DESCRIPTION:
    View OpenClaw logs with full details (bypasses Apple's privacy redaction).
    Requires sudo access configured for /usr/bin/log command.

LOG FLOW ARCHITECTURE:
    OpenClaw logs flow through the macOS unified log (subsystem: ai.openclaw).

LOG CATEGORIES (examples):
    • voicewake           - Voice wake detection/test harness
    • gateway             - Gateway process manager
    • xpc                 - XPC service calls
    • notifications       - Notification helper
    • screenshot          - Screenshotter
    • shell               - ShellExecutor

QUICK START:
    clawlog -n 100             Show last 100 lines from all components
    clawlog -f                 Follow logs in real-time
    clawlog -e                 Show only errors
    clawlog -c ServerManager   Show logs from ServerManager only

OPTIONS:
    -h, --help              Show this help message
    -f, --follow            Stream logs continuously (like tail -f)
    -n, --lines NUM         Number of lines to show (default: 50)
    -l, --last TIME         Time range to search (default: 5m)
                           Examples: 5m, 1h, 2d, 1w
    -c, --category CAT      Filter by category (e.g., ServerManager, SessionService)
    -e, --errors            Show only error messages
    -d, --debug             Show debug level logs (more verbose)
    -s, --search TEXT       Search for specific text in log messages
    -o, --output FILE       Export logs to file
    --server                Show only server output logs
    --all                   Show all logs without tail limit
    --list-categories       List all available log categories
    --json                  Output in JSON format

EXAMPLES:
    clawlog                   Show last 50 lines from past 5 minutes (default)
    clawlog -f                Stream logs continuously
    clawlog -n 100            Show last 100 lines
    clawlog -e                Show only recent errors
    clawlog -l 30m -n 200     Show last 200 lines from past 30 minutes
    clawlog -c ServerManager  Show recent ServerManager logs
    clawlog -s "fail"         Search for "fail" in recent logs
    clawlog --server -e       Show recent server errors
    clawlog -f -d             Stream debug logs continuously

CATEGORIES:
    Common categories include:
    - ServerManager         - Server lifecycle and configuration
    - SessionService        - Terminal session management
    - TerminalManager       - Terminal spawning and control
    - GitRepository         - Git integration features
    - ScreencapService      - Screen capture functionality
    - WebRTCManager         - WebRTC connections
    - UnixSocket           - Unix socket communication
    - WindowTracker        - Window tracking and focus
    - NgrokService         - Ngrok tunnel management
    - ServerOutput         - Node.js server output

TIME FORMATS:
    - 5m  = 5 minutes       - 1h  = 1 hour
    - 2d  = 2 days         - 1w  = 1 week

EOF
}

list_categories() {
    echo -e "${CLR_BLUE}Fetching VibeTunnel log categories from the last hour...${CLR_NC}\n"

    # Pull unique categories from recent logs to show what's actively logging
    log show --predicate "subsystem == \"$SUBSYSTEM\"" --last 1h 2>/dev/null | \
        grep -E "category: \"[^\"]+\"" | \
        sed -E 's/.*category: "([^"]+)".*/\1/' | \
        sort | uniq | \
        while read -r cat; do
            echo "  • $cat"
        done

    echo -e "\n${CLR_YELLOW}Note: Only categories with recent activity are shown${CLR_NC}"
}

# Escape user input for safe embedding in macOS log predicate string literals.
escape_predicate_literal() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    printf '%s' "$value"
}

# Prompt for passwordless sudo setup — Apple hides sensitive log data from regular users.
handle_sudo_error() {
    echo -e "\n${CLR_RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${CLR_NC}"
    echo -e "${CLR_YELLOW}⚠️  Password Required for Log Access${CLR_NC}"
    echo -e "${CLR_RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${CLR_NC}\n"
    echo -e "clawlog needs to use sudo to show complete log data (Apple hides sensitive info by default)."
    echo -e "\nTo avoid password prompts, configure passwordless sudo for the log command:"
    echo -e "See: ${CLR_BLUE}apple/docs/logging-private-fix.md${CLR_NC}\n"
    echo -e "Quick fix:"
    echo -e "  1. Run: ${CLR_GREEN}sudo visudo${CLR_NC}"
    echo -e "  2. Add: ${CLR_GREEN}$(whoami) ALL=(ALL) NOPASSWD: /usr/bin/log${CLR_NC}"
    echo -e "  3. Save and exit (:wq)\n"
    echo -e "${CLR_RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${CLR_NC}\n"
    exit 1
}

build_predicate() {
    local predicate="subsystem == \"$SUBSYSTEM\""

    if [[ -n "$category" ]]; then
        local escaped_category
        escaped_category=$(escape_predicate_literal "$category")
        predicate="$predicate AND category == \"$escaped_category\""
    fi

    if [[ "$errors_only" == true ]]; then
        predicate="$predicate AND (eventType == \"error\" OR messageType == \"error\" OR eventMessage CONTAINS \"ERROR\" OR eventMessage CONTAINS \"[31m\")"
    fi

    if [[ -n "$search_text" ]]; then
        local escaped_search
        escaped_search=$(escape_predicate_literal "$search_text")
        predicate="$predicate AND eventMessage CONTAINS[c] \"$escaped_search\""
    fi

    printf '%s' "$predicate"
}

check_sudo_works() {
    # Apple restricts private log fields; sudo bypasses the restriction
    if sudo -n /usr/bin/log show --last 1s 2>&1 | grep -q "password"; then
        handle_sudo_error
    fi
}

run_log_command() {
    local log_cmd=("$@")

    if [[ -n "$output_file" ]]; then
        check_sudo_works
        echo -e "${CLR_BLUE}Exporting logs to: $output_file${CLR_NC}\n"
        if [[ "$show_tail" == true ]] && [[ "$stream_mode" == false ]]; then
            "${log_cmd[@]}" 2>&1 | tail -n "$tail_lines" > "$output_file"
        else
            "${log_cmd[@]}" > "$output_file" 2>&1
        fi

        if [[ -s "$output_file" ]]; then
            local line_count
            line_count=$(wc -l < "$output_file" | tr -d ' ')
            echo -e "${CLR_GREEN}✓ Exported $line_count lines to $output_file${CLR_NC}"
        else
            echo -e "${CLR_YELLOW}⚠ No logs found matching the criteria${CLR_NC}"
        fi
    else
        check_sudo_works
        if [[ "$show_tail" == true ]] && [[ "$stream_mode" == false ]]; then
            "${log_cmd[@]}" 2>&1 | tail -n "$tail_lines"
            echo -e "\n${CLR_YELLOW}Showing last $tail_lines lines. Use --all or -n to see more.${CLR_NC}"
        else
            "${log_cmd[@]}"
        fi
    fi
}

# ── Argument defaults ──────────────────────────────────────────────────────────

stream_mode=false
time_range="$DEFAULT_TIME_RANGE"
category=""
log_level="$DEFAULT_LEVEL"
search_text=""
output_file=""
errors_only=false
tail_lines="$DEFAULT_TAIL_LINES"
show_tail=true
style_json=false

# ── Main ───────────────────────────────────────────────────────────────────────

if [[ $# -eq 0 ]]; then
    show_usage
    exit 0
fi

while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_usage
            exit 0
            ;;
        -f|--follow)
            stream_mode=true
            show_tail=false
            shift
            ;;
        -n|--lines)
            tail_lines="$2"
            shift 2
            ;;
        -l|--last)
            time_range="$2"
            shift 2
            ;;
        -c|--category)
            category="$2"
            shift 2
            ;;
        -e|--errors)
            errors_only=true
            shift
            ;;
        -d|--debug)
            log_level="debug"
            shift
            ;;
        -s|--search)
            search_text="$2"
            shift 2
            ;;
        -o|--output)
            output_file="$2"
            shift 2
            ;;
        --server)
            category="ServerOutput"
            shift
            ;;
        --list-categories)
            list_categories
            exit 0
            ;;
        --json)
            style_json=true
            shift
            ;;
        --all)
            show_tail=false
            shift
            ;;
        *)
            echo -e "${CLR_RED}Unknown option: $1${CLR_NC}"
            echo "Use -h or --help for usage information"
            exit 1
            ;;
    esac
done

predicate=$(build_predicate)

log_cmd=(sudo log)

if [[ "$stream_mode" == true ]]; then
    log_cmd+=(stream --predicate "$predicate" --level "$log_level" --info)
    echo -e "${CLR_GREEN}Streaming VibeTunnel logs continuously...${CLR_NC}"
    echo -e "${CLR_YELLOW}Press Ctrl+C to stop${CLR_NC}\n"
else
    log_cmd+=(show --predicate "$predicate")
    if [[ "$log_level" == "debug" ]]; then
        log_cmd+=(--debug)
    else
        log_cmd+=(--info)
    fi
    log_cmd+=(--last "$time_range")

    if [[ "$show_tail" == true ]]; then
        echo -e "${CLR_GREEN}Showing last $tail_lines log lines from the past $time_range${CLR_NC}"
    else
        echo -e "${CLR_GREEN}Showing all logs from the past $time_range${CLR_NC}"
    fi

    [[ "$errors_only" == true ]] && echo -e "${CLR_RED}Filter: Errors only${CLR_NC}"
    [[ -n "$category" ]]        && echo -e "${CLR_BLUE}Category: $category${CLR_NC}"
    [[ -n "$search_text" ]]     && echo -e "${CLR_YELLOW}Search: \"$search_text\"${CLR_NC}"
    echo ""
fi

[[ "$style_json" == true ]] && log_cmd+=(--style json)

run_log_command "${log_cmd[@]}"
