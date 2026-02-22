"""
Configuration module for GitHub Fork Analysis System
"""
import os
from pathlib import Path

# GitHub Configuration
GITHUB_TOKEN = os.getenv('GITHUB_TOKEN', '')  # Set via environment variable
UPSTREAM_REPO = os.getenv('UPSTREAM_REPO', 'openclaw/openclaw')  # Format: owner/repo

# Database Configuration
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / 'data'
DATABASE_PATH = DATA_DIR / 'forks.db'

# Ensure data directory exists
DATA_DIR.mkdir(exist_ok=True)

# Tier 1 Configuration: Metadata Filter
TIER1_FILTERS = {
    'min_stars': 0,  # Include forks with 0+ stars
    'min_commits_ahead': 0,  # Include forks with any commits ahead
    'recent_activity_days': 180,  # Consider forks pushed within last 6 months
}

# Tier 2 Configuration: Commit Analysis
TIER2_CONFIG = {
    'max_commits_to_analyze': 100,  # Analyze last N commits per fork
    'min_score_for_tier3': 10,  # Minimum score to advance to Tier 3
    'top_n_for_tier3': 200,  # Take top N forks to Tier 3
}

# Tier 3 Configuration: Shallow Clone + Diff
TIER3_CONFIG = {
    'clone_dir': DATA_DIR / 'clones',
    'max_concurrent_clones': 3,  # Parallel processing limit
    'clone_timeout': 300,  # Timeout for git operations (seconds)
    'min_diff_size': 10,  # Minimum lines changed to consider as gem
}

# Ensure clone directory exists
TIER3_CONFIG['clone_dir'].mkdir(exist_ok=True)

# Scoring Keywords
SCORING_KEYWORDS = {
    # Security-related (highest priority)
    'security': 10,
    'vulnerability': 10,
    'CVE': 10,
    'exploit': 10,
    'XSS': 10,
    'injection': 10,
    'CSRF': 10,
    'authentication': 8,
    'authorization': 8,
    'sanitize': 8,
    
    # Features (high priority)
    'feature': 5,
    'implement': 5,
    'add': 5,
    'new': 5,
    'enhancement': 5,
    
    # Optimizations (medium-high priority)
    'optimize': 4,
    'performance': 4,
    'speed': 4,
    'cache': 4,
    'efficient': 4,
    'refactor': 3,
    
    # Fixes (medium priority)
    'fix': 3,
    'bug': 3,
    'crash': 3,
    'memory leak': 5,
    'deadlock': 4,
    'race condition': 4,
}

# Category mappings for commits
CATEGORY_KEYWORDS = {
    'security': ['security', 'vulnerability', 'CVE', 'exploit', 'XSS', 'injection', 'CSRF', 'sanitize', 'authentication', 'authorization'],
    'feature': ['feature', 'implement', 'add', 'new', 'enhancement'],
    'optimization': ['optimize', 'performance', 'speed', 'cache', 'efficient', 'refactor'],
    'fix': ['fix', 'bug', 'crash', 'memory leak', 'deadlock', 'race condition'],
}

# Rate Limiting Configuration
RATE_LIMIT_CONFIG = {
    'min_remaining': 100,  # Sleep when remaining requests drop below this
    'sleep_buffer': 60,  # Extra seconds to wait after rate limit reset
    'max_retries': 3,  # Maximum retry attempts for failed requests
    'backoff_base': 2,  # Base for exponential backoff (seconds)
}

# Watchlist Configuration
WATCHLIST_CONFIG = {
    'auto_add_score_threshold': 100,  # Auto-add forks with score > this
    'auto_add_gems_threshold': 3,  # Auto-add forks with gems > this
    'high_priority_threshold': 8,  # Priority >= this checked daily
    'medium_priority_threshold': 5,  # Priority >= this checked weekly
}

# Reporting Configuration
REPORT_CONFIG = {
    'output_dir': BASE_DIR / 'reports',
    'top_n_forks': 20,  # Show top N forks in report
    'generate_pdf': True,
    'generate_csv': True,
    'generate_json': True,
}

# Ensure report directory exists
REPORT_CONFIG['output_dir'].mkdir(exist_ok=True)

# Incremental Processing Configuration
INCREMENTAL_CONFIG = {
    'recheck_interval_hours': 24,  # Re-check forks after this many hours
    'batch_commit_size': 100,  # Commit database after processing N forks
}

# Logging Configuration
LOGGING_CONFIG = {
    'level': 'INFO',  # DEBUG, INFO, WARNING, ERROR, CRITICAL
    'format': '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    'log_file': BASE_DIR / 'fork_scanner.log',
}

# GitHub API Configuration
GITHUB_API_BASE = 'https://api.github.com'
GITHUB_API_HEADERS = {
    'Accept': 'application/vnd.github.v3+json',
    'Authorization': f'token {GITHUB_TOKEN}' if GITHUB_TOKEN else '',
}

# Validation
if not GITHUB_TOKEN:
    print("WARNING: GITHUB_TOKEN not set. API rate limits will be severely restricted (60/hour).")
    print("Set GITHUB_TOKEN environment variable for authenticated access (5000/hour).")

if not UPSTREAM_REPO or '/' not in UPSTREAM_REPO:
    print("ERROR: UPSTREAM_REPO must be set in format 'owner/repo'")
    print("Set UPSTREAM_REPO environment variable or edit config.py")
