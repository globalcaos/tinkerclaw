"""
Watchlist management module
Tracks high-value forks for continuous monitoring
"""
import logging
from typing import List, Dict
from datetime import datetime

from config import WATCHLIST_CONFIG
from database import Database

logger = logging.getLogger(__name__)


class WatchlistManager:
    """Manages watchlist of high-value forks"""
    
    def __init__(self, db: Database):
        self.db = db
        self.score_threshold = WATCHLIST_CONFIG['auto_add_score_threshold']
        self.gems_threshold = WATCHLIST_CONFIG['auto_add_gems_threshold']
    
    def update_watchlist(self) -> int:
        """
        Update watchlist based on current fork scores and gems
        
        Returns:
            Number of forks added to watchlist
        """
        logger.info("=" * 60)
        logger.info("UPDATING WATCHLIST")
        logger.info("=" * 60)
        
        added_count = 0
        
        # Get all forks
        forks = self.db.get_all_forks()
        
        for fork in forks:
            # Skip if already in watchlist
            if self.db.is_in_watchlist(fork['id']):
                continue
            
            # Check if fork should be added
            should_add, reason, priority = self._should_add_to_watchlist(fork)
            
            if should_add:
                self.db.add_to_watchlist(fork['id'], reason, priority)
                logger.info(f"✓ Added to watchlist: {fork['full_name']} - {reason} (priority: {priority})")
                added_count += 1
        
        self.db.commit_transaction()
        
        logger.info(f"\nWatchlist updated: {added_count} new fork(s) added")
        return added_count
    
    def _should_add_to_watchlist(self, fork: Dict) -> tuple:
        """
        Determine if fork should be added to watchlist
        
        Returns:
            Tuple of (should_add, reason, priority)
        """
        # High score
        if fork['score'] >= self.score_threshold:
            priority = min(10, 5 + (fork['score'] // 100))
            return True, f"High score: {fork['score']}", priority
        
        # Many gems
        gems_count = self.db.get_gems_count_by_fork(fork['id'])
        if gems_count >= self.gems_threshold:
            priority = min(10, 5 + gems_count)
            return True, f"Multiple gems found: {gems_count}", priority
        
        # High stars + recent activity
        if fork['stars'] >= 50 and fork.get('tier', 0) >= 2:
            return True, f"Popular fork: {fork['stars']} stars", 7
        
        return False, "", 0
    
    def add_manual(self, fork_name: str, reason: str, priority: int = 5) -> bool:
        """
        Manually add a fork to watchlist
        
        Args:
            fork_name: Full name of fork (owner/repo)
            reason: Reason for watching
            priority: Priority level (1-10)
        
        Returns:
            True if added successfully
        """
        fork = self.db.get_fork_by_name(fork_name)
        
        if not fork:
            logger.error(f"Fork not found: {fork_name}")
            return False
        
        if self.db.is_in_watchlist(fork['id']):
            logger.warning(f"Fork already in watchlist: {fork_name}")
            return False
        
        self.db.add_to_watchlist(fork['id'], reason, priority)
        self.db.commit_transaction()
        logger.info(f"✓ Manually added to watchlist: {fork_name} - {reason} (priority: {priority})")
        return True
    
    def remove(self, fork_name: str) -> bool:
        """
        Remove a fork from watchlist
        
        Args:
            fork_name: Full name of fork (owner/repo)
        
        Returns:
            True if removed successfully
        """
        fork = self.db.get_fork_by_name(fork_name)
        
        if not fork:
            logger.error(f"Fork not found: {fork_name}")
            return False
        
        if not self.db.is_in_watchlist(fork['id']):
            logger.warning(f"Fork not in watchlist: {fork_name}")
            return False
        
        self.db.remove_from_watchlist(fork['id'])
        self.db.commit_transaction()
        logger.info(f"✓ Removed from watchlist: {fork_name}")
        return True
    
    def get_watchlist(self) -> List[Dict]:
        """Get current watchlist"""
        return self.db.get_watchlist()
    
    def print_watchlist(self):
        """Print current watchlist to console"""
        watchlist = self.get_watchlist()
        
        if not watchlist:
            logger.info("Watchlist is empty")
            return
        
        logger.info(f"\n{'='*80}")
        logger.info(f"WATCHLIST ({len(watchlist)} forks)")
        logger.info(f"{'='*80}")
        logger.info(f"{'Priority':<10} {'Fork':<40} {'Score':<8} {'Stars':<8} {'Reason'}")
        logger.info(f"{'-'*80}")
        
        for item in watchlist:
            logger.info(f"{item['priority']:<10} {item['full_name']:<40} "
                       f"{item['score']:<8} {item['stars']:<8} {item['reason']}")
        
        logger.info(f"{'='*80}\n")
    
    def check_for_updates(self) -> List[Dict]:
        """
        Check watched forks for new activity
        
        Returns:
            List of forks with new activity
        """
        logger.info("Checking watchlist for updates...")
        
        watchlist = self.get_watchlist()
        updates = []
        
        for item in watchlist:
            fork = self.db.get_fork_by_id(item['fork_id'])
            
            # Check if fork has been updated since last check
            if fork.get('last_checked'):
                last_checked = datetime.fromisoformat(fork['last_checked'])
                pushed_at = datetime.fromisoformat(fork['pushed_at'].replace('Z', '+00:00'))
                
                if pushed_at > last_checked.replace(tzinfo=pushed_at.tzinfo):
                    updates.append({
                        'fork': fork,
                        'watchlist_item': item,
                        'last_checked': last_checked,
                        'pushed_at': pushed_at,
                    })
                    logger.info(f"  ⚠ Update detected: {fork['full_name']}")
        
        if not updates:
            logger.info("  No updates detected")
        
        return updates
