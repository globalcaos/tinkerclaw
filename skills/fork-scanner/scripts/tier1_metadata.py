"""
Tier 1: Metadata Filter
Fetches all forks and filters based on metadata (stars, recent activity, commits ahead)
"""
import logging
from datetime import datetime, timedelta
from typing import List, Dict
import time

from config import (
    UPSTREAM_REPO, TIER1_FILTERS, GITHUB_API_BASE,
    INCREMENTAL_CONFIG
)
from database import Database
from rate_limiter import RateLimiter

logger = logging.getLogger(__name__)


class Tier1MetadataFilter:
    """Tier 1: Fetch and filter fork metadata"""
    
    def __init__(self, db: Database, rate_limiter: RateLimiter):
        self.db = db
        self.rate_limiter = rate_limiter
        self.upstream_owner, self.upstream_name = UPSTREAM_REPO.split('/')
    
    def run(self) -> int:
        """
        Execute Tier 1: Fetch all forks and filter by metadata
        
        Returns:
            Number of forks that passed filters
        """
        logger.info("=" * 60)
        logger.info("TIER 1: METADATA FILTER")
        logger.info("=" * 60)
        
        # Fetch all forks
        all_forks = self._fetch_all_forks()
        logger.info(f"Fetched {len(all_forks)} total forks")
        
        # Get upstream default branch
        upstream_branch = self._get_upstream_default_branch()
        logger.info(f"Upstream default branch: {upstream_branch}")
        
        # Filter and store forks
        passed_count = 0
        batch_count = 0
        
        for i, fork in enumerate(all_forks):
            # Check if fork needs re-checking (incremental processing)
            existing_fork = self.db.get_fork_by_name(fork['full_name'])
            if existing_fork and existing_fork.get('last_checked'):
                last_checked = datetime.fromisoformat(existing_fork['last_checked'])
                hours_since_check = (datetime.utcnow() - last_checked).total_seconds() / 3600
                if hours_since_check < INCREMENTAL_CONFIG['recheck_interval_hours']:
                    logger.debug(f"Skipping {fork['full_name']} (checked {hours_since_check:.1f}h ago)")
                    passed_count += 1  # Count as passed since it was previously processed
                    continue
            
            # Get comparison with upstream
            comparison = self._get_fork_comparison(fork, upstream_branch)
            
            if comparison:
                fork['commits_ahead'] = comparison.get('ahead_by', 0)
                fork['commits_behind'] = comparison.get('behind_by', 0)
            else:
                fork['commits_ahead'] = 0
                fork['commits_behind'] = 0
            
            # Apply filters
            if self._passes_filters(fork):
                fork['tier'] = 1
                fork['last_checked'] = datetime.utcnow().isoformat()
                self.db.insert_fork(fork)
                passed_count += 1
                logger.info(f"✓ [{i+1}/{len(all_forks)}] {fork['full_name']} - "
                          f"Stars: {fork['stars']}, Ahead: {fork['commits_ahead']}")
            else:
                logger.debug(f"✗ [{i+1}/{len(all_forks)}] {fork['full_name']} - Filtered out")
            
            # Batch commit
            batch_count += 1
            if batch_count >= INCREMENTAL_CONFIG['batch_commit_size']:
                self.db.commit_transaction()
                batch_count = 0
                logger.debug(f"Batch committed ({i+1}/{len(all_forks)} processed)")
        
        # Final commit
        self.db.commit_transaction()
        
        logger.info(f"\nTier 1 Complete: {passed_count}/{len(all_forks)} forks passed filters")
        return passed_count
    
    def _fetch_all_forks(self) -> List[Dict]:
        """Fetch all forks using pagination"""
        forks = []
        page = 1
        per_page = 100  # Max allowed by GitHub API
        
        while True:
            url = f"{GITHUB_API_BASE}/repos/{UPSTREAM_REPO}/forks"
            params = {
                'page': page,
                'per_page': per_page,
                'sort': 'newest'  # Get newest first
            }
            
            logger.info(f"Fetching forks page {page}...")
            response = self.rate_limiter.make_request(url, params)
            
            if not response or response.status_code != 200:
                logger.error(f"Failed to fetch forks page {page}: {response.status_code if response else 'No response'}")
                break
            
            page_forks = response.json()
            if not page_forks:
                break
            
            # Extract relevant metadata
            for fork in page_forks:
                forks.append({
                    'full_name': fork['full_name'],
                    'stars': fork['stargazers_count'],
                    'pushed_at': fork['pushed_at'],
                    'created_at': fork['created_at'],
                    'default_branch': fork['default_branch'],
                })
            
            logger.info(f"  Retrieved {len(page_forks)} forks (total: {len(forks)})")
            
            # Check if there are more pages
            if len(page_forks) < per_page:
                break
            
            page += 1
            time.sleep(0.5)  # Be nice to the API
        
        return forks
    
    def _get_upstream_default_branch(self) -> str:
        """Get the default branch of upstream repository"""
        url = f"{GITHUB_API_BASE}/repos/{UPSTREAM_REPO}"
        response = self.rate_limiter.make_request(url)
        
        if response and response.status_code == 200:
            return response.json().get('default_branch', 'main')
        else:
            logger.warning("Failed to get upstream default branch, using 'main'")
            return 'main'
    
    def _get_fork_comparison(self, fork: Dict, upstream_branch: str) -> Dict:
        """Get comparison between fork and upstream"""
        # Format: basehead = base...head
        # We want to compare upstream (base) with fork (head)
        basehead = f"{UPSTREAM_REPO.split('/')[0]}:{upstream_branch}...{fork['full_name'].split('/')[0]}:{fork['default_branch']}"
        
        url = f"{GITHUB_API_BASE}/repos/{UPSTREAM_REPO}/compare/{basehead}"
        response = self.rate_limiter.make_request(url)
        
        if response and response.status_code == 200:
            data = response.json()
            return {
                'ahead_by': data.get('ahead_by', 0),
                'behind_by': data.get('behind_by', 0),
            }
        else:
            logger.debug(f"Failed to compare {fork['full_name']}: {response.status_code if response else 'No response'}")
            return None
    
    def _passes_filters(self, fork: Dict) -> bool:
        """Check if fork passes Tier 1 filters"""
        # Filter 1: Minimum stars
        if fork['stars'] < TIER1_FILTERS['min_stars']:
            return False
        
        # Filter 2: Minimum commits ahead
        if fork['commits_ahead'] < TIER1_FILTERS['min_commits_ahead']:
            # Exception: If it has stars or recent activity, still include it
            if fork['stars'] == 0 and not self._is_recently_active(fork):
                return False
        
        # Filter 3: Recent activity OR has commits ahead OR has stars
        if fork['commits_ahead'] == 0 and fork['stars'] == 0 and not self._is_recently_active(fork):
            return False
        
        return True
    
    def _is_recently_active(self, fork: Dict) -> bool:
        """Check if fork has recent activity"""
        if not fork.get('pushed_at'):
            return False
        
        pushed_at = datetime.fromisoformat(fork['pushed_at'].replace('Z', '+00:00'))
        cutoff = datetime.utcnow().replace(tzinfo=pushed_at.tzinfo) - timedelta(days=TIER1_FILTERS['recent_activity_days'])
        
        return pushed_at > cutoff
