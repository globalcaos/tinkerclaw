"""
Tier 2: Commit Analysis
Analyzes commit messages to score forks based on valuable changes
"""
import logging
import re
from typing import List, Dict, Tuple
from datetime import datetime

from config import (
    TIER2_CONFIG, SCORING_KEYWORDS, CATEGORY_KEYWORDS,
    GITHUB_API_BASE, INCREMENTAL_CONFIG
)
from database import Database
from rate_limiter import RateLimiter

logger = logging.getLogger(__name__)


class Tier2CommitAnalysis:
    """Tier 2: Analyze commits and score forks"""
    
    def __init__(self, db: Database, rate_limiter: RateLimiter):
        self.db = db
        self.rate_limiter = rate_limiter
    
    def run(self) -> int:
        """
        Execute Tier 2: Analyze commits for filtered forks
        
        Returns:
            Number of forks analyzed
        """
        logger.info("=" * 60)
        logger.info("TIER 2: COMMIT ANALYSIS")
        logger.info("=" * 60)
        
        # Get forks from Tier 1
        forks = self.db.get_forks_for_tier2()
        logger.info(f"Analyzing {len(forks)} forks from Tier 1")
        
        analyzed_count = 0
        batch_count = 0
        
        for i, fork in enumerate(forks):
            # Skip if recently analyzed
            if fork.get('tier', 0) >= 2:
                last_checked = fork.get('last_checked')
                if last_checked:
                    last_checked_dt = datetime.fromisoformat(last_checked)
                    hours_since = (datetime.utcnow() - last_checked_dt).total_seconds() / 3600
                    if hours_since < INCREMENTAL_CONFIG['recheck_interval_hours']:
                        logger.debug(f"Skipping {fork['full_name']} (analyzed {hours_since:.1f}h ago)")
                        analyzed_count += 1
                        continue
            
            logger.info(f"[{i+1}/{len(forks)}] Analyzing {fork['full_name']}...")
            
            # Fetch and analyze commits
            commits = self._fetch_commits(fork)
            if not commits:
                logger.debug(f"  No commits found for {fork['full_name']}")
                continue
            
            # Score commits
            total_score = 0
            for commit in commits:
                score, categories = self._score_commit(commit)
                commit['score'] = score
                commit['categories'] = categories
                commit['fork_id'] = fork['id']
                total_score += score
                
                # Store commit in database
                self.db.insert_commit(commit)
            
            # Apply multipliers based on fork metadata
            final_score = self._apply_multipliers(total_score, fork)
            
            # Update fork score
            self.db.update_fork_score(fork['id'], final_score, tier=2)
            self.db.update_fork_last_checked(fork['id'])
            
            logger.info(f"  ✓ Score: {final_score} ({len(commits)} commits analyzed)")
            analyzed_count += 1
            
            # Batch commit
            batch_count += 1
            if batch_count >= INCREMENTAL_CONFIG['batch_commit_size']:
                self.db.commit_transaction()
                batch_count = 0
                logger.debug(f"Batch committed ({i+1}/{len(forks)} processed)")
        
        # Final commit
        self.db.commit_transaction()
        
        logger.info(f"\nTier 2 Complete: {analyzed_count} forks analyzed")
        return analyzed_count
    
    def _fetch_commits(self, fork: Dict) -> List[Dict]:
        """Fetch commits for a fork"""
        url = f"{GITHUB_API_BASE}/repos/{fork['full_name']}/commits"
        params = {
            'per_page': min(TIER2_CONFIG['max_commits_to_analyze'], 100),
            'sha': fork.get('default_branch', 'main')
        }
        
        response = self.rate_limiter.make_request(url, params)
        
        if not response or response.status_code != 200:
            logger.warning(f"Failed to fetch commits for {fork['full_name']}: "
                         f"{response.status_code if response else 'No response'}")
            return []
        
        commits_data = response.json()
        commits = []
        
        for commit_data in commits_data:
            commit = {
                'sha': commit_data['sha'],
                'message': commit_data['commit']['message'],
                'author': commit_data['commit']['author']['name'],
                'date': commit_data['commit']['author']['date'],
            }
            commits.append(commit)
        
        return commits
    
    def _score_commit(self, commit: Dict) -> Tuple[int, List[str]]:
        """
        Score a commit based on its message
        
        Returns:
            Tuple of (score, categories)
        """
        message = commit['message'].lower()
        score = 0
        categories = set()
        
        # Check for keywords
        for keyword, points in SCORING_KEYWORDS.items():
            if keyword.lower() in message:
                score += points
                
                # Determine category
                for category, category_keywords in CATEGORY_KEYWORDS.items():
                    if keyword in category_keywords:
                        categories.add(category)
                        break
        
        return score, list(categories)
    
    def _apply_multipliers(self, base_score: int, fork: Dict) -> int:
        """Apply multipliers based on fork metadata"""
        score = float(base_score)
        
        # Stars multiplier
        if fork['stars'] > 10:
            score *= 1.5
            logger.debug(f"  Applied stars multiplier (1.5x): {fork['stars']} stars")
        
        # Recent activity multiplier
        if fork.get('pushed_at'):
            pushed_at = datetime.fromisoformat(fork['pushed_at'].replace('Z', '+00:00'))
            days_since_push = (datetime.utcnow().replace(tzinfo=pushed_at.tzinfo) - pushed_at).days
            if days_since_push < 30:
                score *= 1.2
                logger.debug(f"  Applied recent activity multiplier (1.2x): {days_since_push} days ago")
        
        # Commits ahead multiplier
        if fork.get('commits_ahead', 0) > 50:
            score *= 1.3
            logger.debug(f"  Applied commits ahead multiplier (1.3x): {fork['commits_ahead']} commits")
        
        return int(score)
    
    def get_top_forks(self, limit: int = None) -> List[Dict]:
        """Get top scored forks for Tier 3"""
        if limit is None:
            limit = TIER2_CONFIG['top_n_for_tier3']
        
        return self.db.get_top_forks_for_tier3(limit)
