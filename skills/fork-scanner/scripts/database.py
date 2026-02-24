"""
Database operations module for GitHub Fork Analysis System
"""
import sqlite3
import json
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Optional, Tuple
import logging

from config import DATABASE_PATH

logger = logging.getLogger(__name__)


class Database:
    """Database manager for fork analysis system"""
    
    def __init__(self, db_path: Path = DATABASE_PATH):
        self.db_path = db_path
        self.conn = None
        self._connect()
        self._initialize_schema()
    
    def _connect(self):
        """Establish database connection"""
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row  # Enable column access by name
        logger.info(f"Connected to database: {self.db_path}")
    
    def _initialize_schema(self):
        """Initialize database schema from schema.sql"""
        schema_path = Path(__file__).parent / 'schema.sql'
        if schema_path.exists():
            with open(schema_path, 'r') as f:
                schema_sql = f.read()
            self.conn.executescript(schema_sql)
            self.conn.commit()
            logger.info("Database schema initialized")
    
    def close(self):
        """Close database connection"""
        if self.conn:
            self.conn.close()
            logger.info("Database connection closed")
    
    # ==================== FORKS TABLE OPERATIONS ====================
    
    def insert_fork(self, fork_data: Dict) -> int:
        """Insert or update fork metadata"""
        cursor = self.conn.cursor()
        cursor.execute("""
            INSERT INTO forks (full_name, stars, pushed_at, commits_ahead, commits_behind, 
                              created_at, updated_at, default_branch, last_checked, tier)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(full_name) DO UPDATE SET
                stars = excluded.stars,
                pushed_at = excluded.pushed_at,
                commits_ahead = excluded.commits_ahead,
                commits_behind = excluded.commits_behind,
                updated_at = excluded.updated_at,
                default_branch = excluded.default_branch
        """, (
            fork_data['full_name'],
            fork_data.get('stars', 0),
            fork_data.get('pushed_at'),
            fork_data.get('commits_ahead', 0),
            fork_data.get('commits_behind', 0),
            fork_data.get('created_at'),
            datetime.utcnow().isoformat(),
            fork_data.get('default_branch', 'main'),
            fork_data.get('last_checked'),
            fork_data.get('tier', 1)
        ))
        self.conn.commit()
        return cursor.lastrowid
    
    def get_fork_by_name(self, full_name: str) -> Optional[Dict]:
        """Get fork by full name"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT * FROM forks WHERE full_name = ?", (full_name,))
        row = cursor.fetchone()
        return dict(row) if row else None
    
    def get_fork_by_id(self, fork_id: int) -> Optional[Dict]:
        """Get fork by ID"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT * FROM forks WHERE id = ?", (fork_id,))
        row = cursor.fetchone()
        return dict(row) if row else None
    
    def update_fork_score(self, fork_id: int, score: int, tier: int = 2):
        """Update fork score and tier"""
        cursor = self.conn.cursor()
        cursor.execute("""
            UPDATE forks SET score = ?, tier = ?, updated_at = ?
            WHERE id = ?
        """, (score, tier, datetime.utcnow().isoformat(), fork_id))
        self.conn.commit()
    
    def update_fork_last_checked(self, fork_id: int):
        """Update last_checked timestamp"""
        cursor = self.conn.cursor()
        cursor.execute("""
            UPDATE forks SET last_checked = ? WHERE id = ?
        """, (datetime.utcnow().isoformat(), fork_id))
        self.conn.commit()
    
    def get_forks_for_tier2(self, limit: Optional[int] = None) -> List[Dict]:
        """Get forks that passed Tier 1 filters for Tier 2 analysis"""
        cursor = self.conn.cursor()
        query = """
            SELECT * FROM forks 
            WHERE tier >= 1 
            ORDER BY stars DESC, pushed_at DESC
        """
        if limit:
            query += f" LIMIT {limit}"
        cursor.execute(query)
        return [dict(row) for row in cursor.fetchall()]
    
    def get_top_forks_for_tier3(self, limit: int = 200) -> List[Dict]:
        """Get top N forks by score for Tier 3 analysis"""
        cursor = self.conn.cursor()
        cursor.execute("""
            SELECT * FROM forks 
            WHERE tier >= 2 AND score > 0
            ORDER BY score DESC, stars DESC
            LIMIT ?
        """, (limit,))
        return [dict(row) for row in cursor.fetchall()]
    
    def get_all_forks(self) -> List[Dict]:
        """Get all forks"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT * FROM forks ORDER BY score DESC")
        return [dict(row) for row in cursor.fetchall()]
    
    # ==================== COMMITS TABLE OPERATIONS ====================
    
    def insert_commit(self, commit_data: Dict) -> int:
        """Insert commit analysis data"""
        cursor = self.conn.cursor()
        cursor.execute("""
            INSERT OR IGNORE INTO commits (fork_id, sha, message, author, date, score, categories)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            commit_data['fork_id'],
            commit_data['sha'],
            commit_data.get('message', ''),
            commit_data.get('author', ''),
            commit_data.get('date'),
            commit_data.get('score', 0),
            json.dumps(commit_data.get('categories', []))
        ))
        self.conn.commit()
        return cursor.lastrowid
    
    def get_commits_by_fork(self, fork_id: int) -> List[Dict]:
        """Get all commits for a fork"""
        cursor = self.conn.cursor()
        cursor.execute("""
            SELECT * FROM commits WHERE fork_id = ? ORDER BY score DESC
        """, (fork_id,))
        rows = cursor.fetchall()
        commits = []
        for row in rows:
            commit = dict(row)
            commit['categories'] = json.loads(commit['categories'])
            commits.append(commit)
        return commits
    
    def get_fork_total_score(self, fork_id: int) -> int:
        """Calculate total score for a fork based on commits"""
        cursor = self.conn.cursor()
        cursor.execute("""
            SELECT SUM(score) as total FROM commits WHERE fork_id = ?
        """, (fork_id,))
        result = cursor.fetchone()
        return result['total'] if result['total'] else 0
    
    # ==================== GEMS TABLE OPERATIONS ====================
    
    def insert_gem(self, gem_data: Dict) -> int:
        """Insert discovered gem"""
        cursor = self.conn.cursor()
        cursor.execute("""
            INSERT INTO gems (fork_id, commit_sha, category, description, 
                             files_changed, diff_summary, discovered_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            gem_data['fork_id'],
            gem_data.get('commit_sha', ''),
            gem_data['category'],
            gem_data['description'],
            json.dumps(gem_data.get('files_changed', [])),
            gem_data.get('diff_summary', ''),
            datetime.utcnow().isoformat()
        ))
        self.conn.commit()
        return cursor.lastrowid
    
    def get_gems_by_fork(self, fork_id: int) -> List[Dict]:
        """Get all gems for a fork"""
        cursor = self.conn.cursor()
        cursor.execute("""
            SELECT * FROM gems WHERE fork_id = ? ORDER BY discovered_at DESC
        """, (fork_id,))
        rows = cursor.fetchall()
        gems = []
        for row in rows:
            gem = dict(row)
            gem['files_changed'] = json.loads(gem['files_changed'])
            gems.append(gem)
        return gems
    
    def get_all_gems(self) -> List[Dict]:
        """Get all gems"""
        cursor = self.conn.cursor()
        cursor.execute("""
            SELECT g.*, f.full_name 
            FROM gems g
            JOIN forks f ON g.fork_id = f.id
            ORDER BY g.discovered_at DESC
        """)
        rows = cursor.fetchall()
        gems = []
        for row in rows:
            gem = dict(row)
            gem['files_changed'] = json.loads(gem['files_changed'])
            gems.append(gem)
        return gems
    
    def get_gems_count_by_fork(self, fork_id: int) -> int:
        """Get count of gems for a fork"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT COUNT(*) as count FROM gems WHERE fork_id = ?", (fork_id,))
        return cursor.fetchone()['count']
    
    # ==================== WATCHLIST TABLE OPERATIONS ====================
    
    def add_to_watchlist(self, fork_id: int, reason: str, priority: int = 5) -> int:
        """Add fork to watchlist"""
        cursor = self.conn.cursor()
        cursor.execute("""
            INSERT OR IGNORE INTO watchlist (fork_id, reason, added_at, priority)
            VALUES (?, ?, ?, ?)
        """, (fork_id, reason, datetime.utcnow().isoformat(), priority))
        self.conn.commit()
        return cursor.lastrowid
    
    def remove_from_watchlist(self, fork_id: int):
        """Remove fork from watchlist"""
        cursor = self.conn.cursor()
        cursor.execute("DELETE FROM watchlist WHERE fork_id = ?", (fork_id,))
        self.conn.commit()
    
    def get_watchlist(self) -> List[Dict]:
        """Get all watched forks"""
        cursor = self.conn.cursor()
        cursor.execute("""
            SELECT w.*, f.full_name, f.score, f.stars
            FROM watchlist w
            JOIN forks f ON w.fork_id = f.id
            ORDER BY w.priority DESC, f.score DESC
        """)
        return [dict(row) for row in cursor.fetchall()]
    
    def is_in_watchlist(self, fork_id: int) -> bool:
        """Check if fork is in watchlist"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT COUNT(*) as count FROM watchlist WHERE fork_id = ?", (fork_id,))
        return cursor.fetchone()['count'] > 0
    
    # ==================== RUN HISTORY TABLE OPERATIONS ====================
    
    def start_run(self, tier: int) -> int:
        """Record start of a new run"""
        cursor = self.conn.cursor()
        cursor.execute("""
            INSERT INTO run_history (started_at, tier, status)
            VALUES (?, ?, 'running')
        """, (datetime.utcnow().isoformat(), tier))
        self.conn.commit()
        return cursor.lastrowid
    
    def complete_run(self, run_id: int, forks_processed: int, gems_found: int, status: str = 'success', error: str = None):
        """Mark run as completed"""
        cursor = self.conn.cursor()
        cursor.execute("""
            UPDATE run_history 
            SET completed_at = ?, forks_processed = ?, gems_found = ?, status = ?, error_message = ?
            WHERE id = ?
        """, (datetime.utcnow().isoformat(), forks_processed, gems_found, status, error, run_id))
        self.conn.commit()
    
    def get_last_run(self) -> Optional[Dict]:
        """Get most recent run"""
        cursor = self.conn.cursor()
        cursor.execute("""
            SELECT * FROM run_history ORDER BY started_at DESC LIMIT 1
        """)
        row = cursor.fetchone()
        return dict(row) if row else None
    
    def get_interrupted_runs(self) -> List[Dict]:
        """Get runs that didn't complete"""
        cursor = self.conn.cursor()
        cursor.execute("""
            SELECT * FROM run_history 
            WHERE status = 'running' 
            ORDER BY started_at DESC
        """)
        return [dict(row) for row in cursor.fetchall()]
    
    # ==================== STATISTICS ====================
    
    def get_statistics(self) -> Dict:
        """Get overall statistics"""
        cursor = self.conn.cursor()
        
        stats = {}
        
        # Total forks
        cursor.execute("SELECT COUNT(*) as count FROM forks")
        stats['total_forks'] = cursor.fetchone()['count']
        
        # Forks by tier
        cursor.execute("SELECT tier, COUNT(*) as count FROM forks GROUP BY tier")
        stats['forks_by_tier'] = {row['tier']: row['count'] for row in cursor.fetchall()}
        
        # Total commits analyzed
        cursor.execute("SELECT COUNT(*) as count FROM commits")
        stats['total_commits'] = cursor.fetchone()['count']
        
        # Total gems
        cursor.execute("SELECT COUNT(*) as count FROM gems")
        stats['total_gems'] = cursor.fetchone()['count']
        
        # Gems by category
        cursor.execute("SELECT category, COUNT(*) as count FROM gems GROUP BY category")
        stats['gems_by_category'] = {row['category']: row['count'] for row in cursor.fetchall()}
        
        # Watchlist size
        cursor.execute("SELECT COUNT(*) as count FROM watchlist")
        stats['watchlist_size'] = cursor.fetchone()['count']
        
        # Top scored fork
        cursor.execute("SELECT full_name, score FROM forks ORDER BY score DESC LIMIT 1")
        top_fork = cursor.fetchone()
        stats['top_fork'] = dict(top_fork) if top_fork else None
        
        return stats
    
    def commit_transaction(self):
        """Commit current transaction"""
        self.conn.commit()
    
    def rollback_transaction(self):
        """Rollback current transaction"""
        self.conn.rollback()
