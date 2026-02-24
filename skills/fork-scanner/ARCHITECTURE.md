# GitHub Fork Analysis System - Architecture

## Overview

This system implements a **tiered funnel strategy** to efficiently analyze 28,000+ GitHub forks without exhausting resources (storage, API limits, tokens).

## System Components

### 1. Database Layer (SQLite)

**Tables:**

- **forks**: Stores metadata for all discovered forks
  - `id` (INTEGER PRIMARY KEY)
  - `full_name` (TEXT UNIQUE) - e.g., "user/openclaw"
  - `stars` (INTEGER)
  - `pushed_at` (TEXT) - ISO 8601 timestamp
  - `commits_ahead` (INTEGER) - commits ahead of upstream
  - `commits_behind` (INTEGER) - commits behind upstream
  - `score` (INTEGER) - calculated score based on commit analysis
  - `tier` (INTEGER) - highest tier reached (1, 2, or 3)
  - `last_checked` (TEXT) - ISO 8601 timestamp
  - `created_at` (TEXT) - fork creation date
  - `updated_at` (TEXT) - last update in our DB

- **commits**: Stores analyzed commits from Tier 2
  - `id` (INTEGER PRIMARY KEY)
  - `fork_id` (INTEGER FOREIGN KEY)
  - `sha` (TEXT)
  - `message` (TEXT)
  - `author` (TEXT)
  - `date` (TEXT)
  - `score` (INTEGER) - individual commit score
  - `categories` (TEXT) - JSON array of matched categories

- **gems**: Stores confirmed valuable changes from Tier 3
  - `id` (INTEGER PRIMARY KEY)
  - `fork_id` (INTEGER FOREIGN KEY)
  - `commit_sha` (TEXT)
  - `category` (TEXT) - security/feature/optimization/fix
  - `description` (TEXT)
  - `files_changed` (TEXT) - JSON array of file paths
  - `diff_summary` (TEXT)
  - `discovered_at` (TEXT)

- **watchlist**: Tracks high-value forks for continuous monitoring
  - `id` (INTEGER PRIMARY KEY)
  - `fork_id` (INTEGER FOREIGN KEY UNIQUE)
  - `reason` (TEXT) - why it's being watched
  - `added_at` (TEXT)
  - `priority` (INTEGER) - 1-10 scale

- **run_history**: Tracks execution history for incremental processing
  - `id` (INTEGER PRIMARY KEY)
  - `started_at` (TEXT)
  - `completed_at` (TEXT)
  - `tier` (INTEGER)
  - `forks_processed` (INTEGER)
  - `gems_found` (INTEGER)
  - `status` (TEXT) - success/failed/interrupted

### 2. Core Processing Pipeline

#### **Tier 1: Metadata Filter** (API-based)
- **Input**: Repository name (e.g., "openclaw/openclaw")
- **Process**:
  1. Paginate through all forks using GitHub API
  2. Apply filters: `stars > 0 OR pushed_at > (now - 6 months) OR commits_ahead > 0`
  3. Store metadata in `forks` table
  4. Mark tier=1
- **Rate Limit**: ~1 request per 100 forks (pagination) + 1 per fork for comparison
- **Output**: ~2000 candidates
- **Estimated Time**: ~30 minutes (with rate limiting)

#### **Tier 2: Commit Analysis** (API-based)
- **Input**: Forks from Tier 1 with score potential
- **Process**:
  1. Fetch commit list for each fork (last 100 commits)
  2. Score commit messages using keyword matching:
     - Security keywords (+10): "CVE", "security", "vulnerability", "exploit", "XSS", "injection"
     - Feature keywords (+5): "feature", "add", "implement", "new"
     - Optimization keywords (+4): "optimize", "performance", "speed", "cache"
     - Fix keywords (+3): "fix", "bug", "crash", "memory leak"
  3. Aggregate scores per fork
  4. Store commits in `commits` table
  5. Update fork score and mark tier=2
- **Rate Limit**: 1 request per fork
- **Output**: ~200 high-scoring forks
- **Estimated Time**: ~1 hour (with rate limiting)

#### **Tier 3: Shallow Clone + Diff** (Git-based)
- **Input**: Top 200 forks from Tier 2
- **Process**:
  1. Clone with `--depth 1 --single-branch`
  2. Add upstream remote
  3. Fetch upstream (shallow)
  4. Run `git diff upstream/main...HEAD`
  5. Analyze diff:
     - Extract changed files
     - Categorize by file type/path
     - Generate summary
  6. Store valuable changes in `gems` table
  7. Delete clone
  8. Mark tier=3
- **Storage**: ~50MB per fork × 200 = ~10GB temporary
- **Output**: ~20 confirmed gems
- **Estimated Time**: ~2-3 hours

### 3. Scoring Algorithm

**Commit Message Scoring:**
```python
KEYWORDS = {
    'security': 10,
    'vulnerability': 10,
    'CVE': 10,
    'exploit': 10,
    'XSS': 10,
    'injection': 10,
    'feature': 5,
    'implement': 5,
    'add': 5,
    'new': 5,
    'optimize': 4,
    'performance': 4,
    'speed': 4,
    'cache': 4,
    'fix': 3,
    'bug': 3,
    'crash': 3,
    'memory leak': 3,
}
```

**Fork Scoring:**
- Base score = sum of commit scores
- Multipliers:
  - Stars > 10: ×1.5
  - Recent activity (< 30 days): ×1.2
  - Many commits ahead (> 50): ×1.3

### 4. Rate Limit Management

- **GitHub API Limit**: 5000 requests/hour (authenticated)
- **Strategy**:
  - Track remaining requests via response headers
  - Sleep when < 100 requests remaining
  - Implement exponential backoff on 403/429 errors
  - Cache API responses in database
  - Use conditional requests (If-None-Match) for unchanged data

### 5. Incremental Processing

- **State Tracking**: Use `last_checked` field in `forks` table
- **Resume Logic**: On restart, skip forks checked within last 24 hours
- **Checkpointing**: Commit database after every 100 forks processed
- **Crash Recovery**: Use `run_history` to detect interrupted runs

### 6. Watchlist System

- **Auto-add Criteria**:
  - Score > 100
  - Gems found > 3
  - Manual addition via CLI
- **Priority Levels**:
  - 10: Critical (always check daily)
  - 5-9: High (check weekly)
  - 1-4: Medium (check monthly)
- **Alerts**: Generate notifications when watched forks have new commits

### 7. Reporting

**Daily Report (Markdown/PDF):**
- Summary statistics
- Top 10 forks by score
- New gems discovered
- Watchlist updates
- Rate limit status

**Export Formats:**
- CSV: Fork rankings
- JSON: Complete data dump
- PDF: Executive summary

## Technology Stack

- **Language**: Python 3.11+
- **Database**: SQLite3
- **HTTP**: `requests` library
- **Git**: `subprocess` + git CLI
- **Scheduling**: cron (Linux) or Task Scheduler (Windows)
- **Reporting**: `markdown` + `weasyprint` for PDF generation

## File Structure

```
fork_analysis_system/
├── fork_scanner.py          # Main script
├── config.py                # Configuration
├── database.py              # Database operations
├── tier1_metadata.py        # Tier 1 implementation
├── tier2_commits.py         # Tier 2 implementation
├── tier3_diff.py            # Tier 3 implementation
├── watchlist.py             # Watchlist management
├── reporter.py              # Report generation
├── rate_limiter.py          # Rate limit handling
├── schema.sql               # Database schema
├── requirements.txt         # Python dependencies
├── README.md                # User documentation
├── ARCHITECTURE.md          # This file
└── data/
    └── forks.db             # SQLite database
```

## Execution Flow

```
1. Load configuration (GitHub token, repo name)
2. Initialize database (create tables if needed)
3. Check run_history for interrupted runs
4. Execute Tier 1: Fetch all forks metadata
5. Execute Tier 2: Analyze commits for filtered forks
6. Execute Tier 3: Deep analysis of top candidates
7. Update watchlist based on findings
8. Generate reports
9. Record run_history
10. Exit
```

## Error Handling

- **Network Errors**: Retry with exponential backoff (max 3 attempts)
- **Rate Limit**: Sleep until reset time
- **Git Errors**: Skip fork, log error, continue
- **Database Errors**: Rollback transaction, log, exit
- **Disk Space**: Check before Tier 3, skip if insufficient

## Security Considerations

- Store GitHub token in environment variable or config file (not in code)
- Use `.gitignore` to exclude `config.py` and `data/`
- Validate all API responses before processing
- Sanitize file paths in Tier 3 to prevent directory traversal

## Performance Optimizations

- Use connection pooling for database
- Batch database inserts (100 records at a time)
- Parallel processing for Tier 3 (optional, with semaphore)
- Index database columns used in queries
- Compress old run_history records

## Future Enhancements

- Web dashboard for visualization
- Machine learning for better scoring
- Integration with CI/CD for automated testing of gems
- Notification system (email, Slack)
- Multi-repository support
