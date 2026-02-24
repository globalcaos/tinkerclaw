#!/bin/bash
#
# Example usage scenarios for GitHub Fork Analysis System
#

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}GitHub Fork Analysis System - Example Usage${NC}"
echo "=============================================="
echo ""

# Set environment variables (replace with your values)
export GITHUB_TOKEN="your_github_token_here"
export UPSTREAM_REPO="openclaw/openclaw"

echo -e "${YELLOW}1. First-time setup and full analysis${NC}"
echo "   python3 fork_scanner.py"
echo ""

echo -e "${YELLOW}2. Quick metadata scan (Tier 1 only)${NC}"
echo "   python3 fork_scanner.py --tier1-only"
echo ""

echo -e "${YELLOW}3. Analyze commits without deep cloning (Tier 1 + 2)${NC}"
echo "   python3 fork_scanner.py --tier1-only"
echo "   python3 fork_scanner.py --tier2-only"
echo ""

echo -e "${YELLOW}4. Deep analysis of top candidates only (Tier 3)${NC}"
echo "   python3 fork_scanner.py --tier3-only"
echo ""

echo -e "${YELLOW}5. Full analysis with watchlist update${NC}"
echo "   python3 fork_scanner.py --update-watchlist"
echo ""

echo -e "${YELLOW}6. View current watchlist${NC}"
echo "   python3 fork_scanner.py --show-watchlist"
echo ""

echo -e "${YELLOW}7. Add a fork to watchlist${NC}"
echo "   python3 fork_scanner.py --add-to-watchlist 'username/openclaw' \\"
echo "       --watchlist-reason 'Important security fixes' \\"
echo "       --watchlist-priority 9"
echo ""

echo -e "${YELLOW}8. Remove a fork from watchlist${NC}"
echo "   python3 fork_scanner.py --remove-from-watchlist 'username/openclaw'"
echo ""

echo -e "${YELLOW}9. Run analysis without generating reports${NC}"
echo "   python3 fork_scanner.py --no-report"
echo ""

echo -e "${YELLOW}10. Daily incremental update (for cron)${NC}"
echo "   python3 fork_scanner.py --update-watchlist >> /var/log/fork_scanner.log 2>&1"
echo ""

echo -e "${GREEN}Workflow Examples:${NC}"
echo ""

echo -e "${YELLOW}A. Initial Discovery Workflow${NC}"
echo "   # Step 1: Scan all forks (fast)"
echo "   python3 fork_scanner.py --tier1-only"
echo ""
echo "   # Step 2: Analyze commits (medium)"
echo "   python3 fork_scanner.py --tier2-only"
echo ""
echo "   # Step 3: Deep dive into top 200 (slow)"
echo "   python3 fork_scanner.py --tier3-only --update-watchlist"
echo ""

echo -e "${YELLOW}B. Maintenance Workflow${NC}"
echo "   # Daily: Quick scan for new forks and commits"
echo "   python3 fork_scanner.py --tier1-only --tier2-only"
echo ""
echo "   # Weekly: Full deep analysis"
echo "   python3 fork_scanner.py --update-watchlist"
echo ""

echo -e "${YELLOW}C. Targeted Analysis Workflow${NC}"
echo "   # Add specific forks to watchlist"
echo "   python3 fork_scanner.py --add-to-watchlist 'user1/openclaw' --watchlist-priority 10"
echo "   python3 fork_scanner.py --add-to-watchlist 'user2/openclaw' --watchlist-priority 10"
echo ""
echo "   # Run focused analysis on watchlist"
echo "   python3 fork_scanner.py --tier3-only"
echo ""

echo -e "${GREEN}Configuration Tips:${NC}"
echo ""
echo "1. Edit config.py to adjust:"
echo "   - Scoring keywords and weights"
echo "   - Number of forks to analyze in each tier"
echo "   - Rate limit thresholds"
echo ""
echo "2. Check database directly:"
echo "   sqlite3 data/forks.db 'SELECT * FROM forks ORDER BY score DESC LIMIT 10;'"
echo ""
echo "3. Monitor rate limits:"
echo "   curl -H \"Authorization: token \$GITHUB_TOKEN\" https://api.github.com/rate_limit"
echo ""
