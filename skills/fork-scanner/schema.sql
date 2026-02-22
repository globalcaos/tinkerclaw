-- GitHub Fork Analysis System - Database Schema

-- Table: forks
-- Stores metadata for all discovered forks
CREATE TABLE IF NOT EXISTS forks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT UNIQUE NOT NULL,
    stars INTEGER DEFAULT 0,
    pushed_at TEXT,
    commits_ahead INTEGER DEFAULT 0,
    commits_behind INTEGER DEFAULT 0,
    score INTEGER DEFAULT 0,
    tier INTEGER DEFAULT 0,
    last_checked TEXT,
    created_at TEXT,
    updated_at TEXT,
    default_branch TEXT DEFAULT 'main'
);

CREATE INDEX IF NOT EXISTS idx_forks_score ON forks(score DESC);
CREATE INDEX IF NOT EXISTS idx_forks_tier ON forks(tier);
CREATE INDEX IF NOT EXISTS idx_forks_last_checked ON forks(last_checked);
CREATE INDEX IF NOT EXISTS idx_forks_pushed_at ON forks(pushed_at DESC);

-- Table: commits
-- Stores analyzed commits from Tier 2
CREATE TABLE IF NOT EXISTS commits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fork_id INTEGER NOT NULL,
    sha TEXT NOT NULL,
    message TEXT,
    author TEXT,
    date TEXT,
    score INTEGER DEFAULT 0,
    categories TEXT, -- JSON array
    FOREIGN KEY (fork_id) REFERENCES forks(id) ON DELETE CASCADE,
    UNIQUE(fork_id, sha)
);

CREATE INDEX IF NOT EXISTS idx_commits_fork_id ON commits(fork_id);
CREATE INDEX IF NOT EXISTS idx_commits_score ON commits(score DESC);

-- Table: gems
-- Stores confirmed valuable changes from Tier 3
CREATE TABLE IF NOT EXISTS gems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fork_id INTEGER NOT NULL,
    commit_sha TEXT,
    category TEXT, -- security/feature/optimization/fix
    description TEXT,
    files_changed TEXT, -- JSON array
    diff_summary TEXT,
    discovered_at TEXT,
    FOREIGN KEY (fork_id) REFERENCES forks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_gems_fork_id ON gems(fork_id);
CREATE INDEX IF NOT EXISTS idx_gems_category ON gems(category);
CREATE INDEX IF NOT EXISTS idx_gems_discovered_at ON gems(discovered_at DESC);

-- Table: watchlist
-- Tracks high-value forks for continuous monitoring
CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fork_id INTEGER UNIQUE NOT NULL,
    reason TEXT,
    added_at TEXT,
    priority INTEGER DEFAULT 5,
    FOREIGN KEY (fork_id) REFERENCES forks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_watchlist_priority ON watchlist(priority DESC);

-- Table: run_history
-- Tracks execution history for incremental processing
CREATE TABLE IF NOT EXISTS run_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    tier INTEGER,
    forks_processed INTEGER DEFAULT 0,
    gems_found INTEGER DEFAULT 0,
    status TEXT DEFAULT 'running', -- running/success/failed/interrupted
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_history_started_at ON run_history(started_at DESC);
