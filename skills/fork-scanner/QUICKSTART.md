# Quick Start Guide

Get started with the GitHub Fork Analysis System in 5 minutes.

## Prerequisites

- Python 3.11+
- Git
- GitHub Personal Access Token

## Installation (3 steps)

### 1. Install Dependencies

```bash
cd fork_analysis_system
pip3 install -r requirements.txt
```

### 2. Set Environment Variables

```bash
export GITHUB_TOKEN="ghp_your_token_here"
export UPSTREAM_REPO="openclaw/openclaw"
```

**To make permanent**, add to `~/.bashrc`:

```bash
echo 'export GITHUB_TOKEN="ghp_your_token_here"' >> ~/.bashrc
echo 'export UPSTREAM_REPO="openclaw/openclaw"' >> ~/.bashrc
source ~/.bashrc
```

### 3. Run Your First Analysis

```bash
# Quick test with Tier 1 only (fast, ~30 min)
python3 fork_scanner.py --tier1-only

# Full analysis (slow, ~4-5 hours)
python3 fork_scanner.py
```

## Understanding the Output

After running, you'll find:

- **Reports**: `reports/report_YYYYMMDD_HHMMSS.md` - Main analysis report
- **Database**: `data/forks.db` - SQLite database with all data
- **Logs**: `fork_scanner.log` - Execution logs

## Common Commands

```bash
# View help
python3 fork_scanner.py --help

# Run only Tier 2 (commit analysis)
python3 fork_scanner.py --tier2-only

# Show watchlist
python3 fork_scanner.py --show-watchlist

# Add fork to watchlist
python3 fork_scanner.py --add-to-watchlist "username/openclaw" \
    --watchlist-reason "Important fixes" --watchlist-priority 9
```

## Recommended Workflow

### First Time

1. **Tier 1** (30 min): `python3 fork_scanner.py --tier1-only`
2. **Tier 2** (1 hour): `python3 fork_scanner.py --tier2-only`
3. **Tier 3** (2-3 hours): `python3 fork_scanner.py --tier3-only --update-watchlist`

### Daily Maintenance

```bash
python3 fork_scanner.py --tier1-only --tier2-only
```

### Weekly Deep Dive

```bash
python3 fork_scanner.py --update-watchlist
```

## Scheduling (Optional)

Set up automatic daily runs:

```bash
./setup_cron.sh daily
```

## Troubleshooting

### "GITHUB_TOKEN not set"

Set the environment variable:
```bash
export GITHUB_TOKEN="your_token"
```

### "Rate limit exceeded"

The system will automatically wait. To check manually:
```bash
curl -H "Authorization: token $GITHUB_TOKEN" https://api.github.com/rate_limit
```

### "Database locked"

Only one instance can run at a time. Kill any running processes:
```bash
pkill -f fork_scanner.py
```

## Next Steps

- Read [README.md](README.md) for detailed documentation
- Review [ARCHITECTURE.md](ARCHITECTURE.md) for system design
- Edit `config.py` to customize scoring and filters
- Check `example_usage.sh` for more usage examples

## Getting Help

1. Check logs: `tail -f fork_scanner.log`
2. View database: `sqlite3 data/forks.db "SELECT * FROM forks LIMIT 5;"`
3. Test configuration: `python3 -c "import config; print(config.UPSTREAM_REPO)"`

## Key Files

| File | Purpose |
|------|---------|
| `fork_scanner.py` | Main executable script |
| `config.py` | Configuration settings |
| `data/forks.db` | SQLite database |
| `reports/` | Generated reports |
| `fork_scanner.log` | Execution logs |

## Performance Expectations

| Tier | Duration | API Calls | Storage |
|------|----------|-----------|---------|
| 1 | 30-45 min | ~2,300 | Minimal |
| 2 | ~1 hour | ~2,000 | Minimal |
| 3 | 2-3 hours | Minimal | ~10GB temp |
| **Total** | **4-5 hours** | **~4,300** | **~100MB** |

---

**Ready to start?** Run: `python3 fork_scanner.py --tier1-only`
