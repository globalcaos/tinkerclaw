#!/bin/bash
#
# Setup script for scheduling fork analysis with cron
#
# Usage: ./setup_cron.sh [daily|weekly|custom]
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PYTHON_BIN=$(which python3)
LOG_DIR="/var/log/fork_scanner"

echo -e "${GREEN}GitHub Fork Analysis System - Cron Setup${NC}"
echo "=========================================="
echo ""

# Check if GITHUB_TOKEN is set
if [ -z "$GITHUB_TOKEN" ]; then
    echo -e "${RED}ERROR: GITHUB_TOKEN environment variable is not set${NC}"
    echo "Please set it in your shell profile (~/.bashrc or ~/.zshrc):"
    echo "  export GITHUB_TOKEN=\"your_token_here\""
    exit 1
fi

# Check if UPSTREAM_REPO is set
if [ -z "$UPSTREAM_REPO" ]; then
    echo -e "${YELLOW}WARNING: UPSTREAM_REPO not set, using default: openclaw/openclaw${NC}"
    export UPSTREAM_REPO="openclaw/openclaw"
fi

# Create log directory
echo "Creating log directory: $LOG_DIR"
sudo mkdir -p "$LOG_DIR"
sudo chown $USER:$USER "$LOG_DIR"

# Function to add cron job
add_cron_job() {
    local schedule="$1"
    local command="$2"
    local description="$3"
    
    # Check if job already exists
    if crontab -l 2>/dev/null | grep -q "$command"; then
        echo -e "${YELLOW}Cron job already exists: $description${NC}"
        return
    fi
    
    # Add to crontab
    (crontab -l 2>/dev/null; echo "# $description"; echo "$schedule cd $SCRIPT_DIR && GITHUB_TOKEN=$GITHUB_TOKEN UPSTREAM_REPO=$UPSTREAM_REPO $PYTHON_BIN fork_scanner.py $command >> $LOG_DIR/fork_scanner.log 2>&1") | crontab -
    
    echo -e "${GREEN}✓ Added cron job: $description${NC}"
}

# Parse command line argument
SCHEDULE_TYPE="${1:-daily}"

case "$SCHEDULE_TYPE" in
    daily)
        echo "Setting up DAILY schedule..."
        echo ""
        echo "This will run:"
        echo "  - Full analysis daily at 2:00 AM"
        echo "  - Watchlist update included"
        echo ""
        
        add_cron_job "0 2 * * *" "--update-watchlist" "Fork Scanner - Daily Analysis"
        ;;
    
    weekly)
        echo "Setting up WEEKLY schedule..."
        echo ""
        echo "This will run:"
        echo "  - Tier 1 & 2 daily at 2:00 AM (Mon-Sat)"
        echo "  - Full analysis (all tiers) Sunday at 3:00 AM"
        echo ""
        
        add_cron_job "0 2 * * 1-6" "--tier1-only" "Fork Scanner - Daily Tier 1"
        add_cron_job "30 2 * * 1-6" "--tier2-only" "Fork Scanner - Daily Tier 2"
        add_cron_job "0 3 * * 0" "--update-watchlist" "Fork Scanner - Weekly Full Analysis"
        ;;
    
    custom)
        echo "Custom schedule setup"
        echo ""
        echo "Please edit your crontab manually:"
        echo "  crontab -e"
        echo ""
        echo "Example entries:"
        echo ""
        echo "# Daily at 2 AM"
        echo "0 2 * * * cd $SCRIPT_DIR && GITHUB_TOKEN=$GITHUB_TOKEN UPSTREAM_REPO=$UPSTREAM_REPO $PYTHON_BIN fork_scanner.py --update-watchlist >> $LOG_DIR/fork_scanner.log 2>&1"
        echo ""
        echo "# Weekly on Sunday at 3 AM"
        echo "0 3 * * 0 cd $SCRIPT_DIR && GITHUB_TOKEN=$GITHUB_TOKEN UPSTREAM_REPO=$UPSTREAM_REPO $PYTHON_BIN fork_scanner.py >> $LOG_DIR/fork_scanner.log 2>&1"
        echo ""
        exit 0
        ;;
    
    *)
        echo -e "${RED}ERROR: Invalid schedule type: $SCHEDULE_TYPE${NC}"
        echo "Usage: $0 [daily|weekly|custom]"
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}Cron setup complete!${NC}"
echo ""
echo "Current crontab:"
crontab -l | grep -A1 "Fork Scanner" || echo "(No fork scanner jobs found)"
echo ""
echo "Logs will be written to: $LOG_DIR/fork_scanner.log"
echo ""
echo "To view logs:"
echo "  tail -f $LOG_DIR/fork_scanner.log"
echo ""
echo "To edit cron jobs:"
echo "  crontab -e"
echo ""
echo "To remove all fork scanner cron jobs:"
echo "  crontab -l | grep -v 'Fork Scanner' | crontab -"
echo ""
