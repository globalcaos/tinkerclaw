"""
Tier 3: Shallow Clone + Diff Analysis
Deep analysis of top forks by cloning and analyzing diffs
"""
import logging
import subprocess
import shutil
from pathlib import Path
from typing import List, Dict, Optional
from datetime import datetime
import re

from config import TIER3_CONFIG, UPSTREAM_REPO, CATEGORY_KEYWORDS
from database import Database

logger = logging.getLogger(__name__)


class Tier3DiffAnalysis:
    """Tier 3: Clone and analyze diffs for top forks"""
    
    def __init__(self, db: Database):
        self.db = db
        self.clone_dir = TIER3_CONFIG['clone_dir']
        self.timeout = TIER3_CONFIG['clone_timeout']
        self.min_diff_size = TIER3_CONFIG['min_diff_size']
    
    def run(self, top_forks: List[Dict]) -> int:
        """
        Execute Tier 3: Deep analysis of top forks
        
        Args:
            top_forks: List of top-scored forks from Tier 2
        
        Returns:
            Number of gems found
        """
        logger.info("=" * 60)
        logger.info("TIER 3: SHALLOW CLONE + DIFF ANALYSIS")
        logger.info("=" * 60)
        
        logger.info(f"Analyzing top {len(top_forks)} forks")
        
        gems_found = 0
        
        for i, fork in enumerate(top_forks):
            logger.info(f"[{i+1}/{len(top_forks)}] Analyzing {fork['full_name']} (score: {fork['score']})...")
            
            # Clone and analyze
            fork_gems = self._analyze_fork(fork)
            
            if fork_gems:
                logger.info(f"  ✓ Found {len(fork_gems)} gem(s)")
                gems_found += len(fork_gems)
                
                # Store gems
                for gem in fork_gems:
                    gem['fork_id'] = fork['id']
                    self.db.insert_gem(gem)
            else:
                logger.info(f"  No significant gems found")
            
            # Update fork tier
            self.db.update_fork_score(fork['id'], fork['score'], tier=3)
            self.db.commit_transaction()
        
        logger.info(f"\nTier 3 Complete: {gems_found} gems found from {len(top_forks)} forks")
        return gems_found
    
    def _analyze_fork(self, fork: Dict) -> List[Dict]:
        """Analyze a single fork by cloning and diffing"""
        repo_name = fork['full_name'].split('/')[1]
        clone_path = self.clone_dir / repo_name
        
        try:
            # Clone fork
            if not self._clone_fork(fork, clone_path):
                return []
            
            # Add upstream remote
            if not self._add_upstream_remote(clone_path):
                return []
            
            # Get diff
            diff_output = self._get_diff(clone_path, fork.get('default_branch', 'main'))
            if not diff_output:
                return []
            
            # Analyze diff
            gems = self._analyze_diff(diff_output, fork)
            
            return gems
            
        finally:
            # Cleanup
            self._cleanup(clone_path)
    
    def _clone_fork(self, fork: Dict, clone_path: Path) -> bool:
        """Clone fork with shallow depth"""
        # Remove existing clone if present
        if clone_path.exists():
            shutil.rmtree(clone_path)
        
        clone_url = f"https://github.com/{fork['full_name']}.git"
        
        try:
            logger.debug(f"  Cloning {clone_url}...")
            result = subprocess.run(
                ['git', 'clone', '--depth', '1', '--single-branch', clone_url, str(clone_path)],
                capture_output=True,
                text=True,
                timeout=self.timeout
            )
            
            if result.returncode != 0:
                logger.warning(f"  Failed to clone: {result.stderr}")
                return False
            
            logger.debug(f"  Clone successful")
            return True
            
        except subprocess.TimeoutExpired:
            logger.warning(f"  Clone timeout after {self.timeout}s")
            return False
        except Exception as e:
            logger.error(f"  Clone error: {e}")
            return False
    
    def _add_upstream_remote(self, clone_path: Path) -> bool:
        """Add upstream remote"""
        upstream_url = f"https://github.com/{UPSTREAM_REPO}.git"
        
        try:
            # Add remote
            result = subprocess.run(
                ['git', 'remote', 'add', 'upstream', upstream_url],
                cwd=clone_path,
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode != 0:
                logger.debug(f"  Failed to add upstream remote: {result.stderr}")
                return False
            
            # Fetch upstream (shallow)
            logger.debug(f"  Fetching upstream...")
            result = subprocess.run(
                ['git', 'fetch', '--depth', '1', 'upstream'],
                cwd=clone_path,
                capture_output=True,
                text=True,
                timeout=self.timeout
            )
            
            if result.returncode != 0:
                logger.warning(f"  Failed to fetch upstream: {result.stderr}")
                return False
            
            return True
            
        except Exception as e:
            logger.error(f"  Error adding upstream: {e}")
            return False
    
    def _get_diff(self, clone_path: Path, fork_branch: str) -> Optional[str]:
        """Get diff between fork and upstream"""
        try:
            # Get upstream default branch
            result = subprocess.run(
                ['git', 'remote', 'show', 'upstream'],
                cwd=clone_path,
                capture_output=True,
                text=True,
                timeout=30
            )
            
            upstream_branch = 'main'
            if result.returncode == 0:
                match = re.search(r'HEAD branch: (\S+)', result.stdout)
                if match:
                    upstream_branch = match.group(1)
            
            # Get diff
            logger.debug(f"  Getting diff: upstream/{upstream_branch}...HEAD")
            result = subprocess.run(
                ['git', 'diff', f'upstream/{upstream_branch}...HEAD', '--stat'],
                cwd=clone_path,
                capture_output=True,
                text=True,
                timeout=60
            )
            
            if result.returncode != 0:
                logger.warning(f"  Failed to get diff: {result.stderr}")
                return None
            
            # Also get detailed diff
            result_detail = subprocess.run(
                ['git', 'diff', f'upstream/{upstream_branch}...HEAD'],
                cwd=clone_path,
                capture_output=True,
                text=True,
                timeout=60
            )
            
            return result_detail.stdout if result_detail.returncode == 0 else result.stdout
            
        except Exception as e:
            logger.error(f"  Error getting diff: {e}")
            return None
    
    def _analyze_diff(self, diff_output: str, fork: Dict) -> List[Dict]:
        """Analyze diff output to extract gems"""
        gems = []
        
        if not diff_output or len(diff_output) < self.min_diff_size:
            return gems
        
        # Extract changed files
        files_changed = self._extract_changed_files(diff_output)
        
        if not files_changed:
            return gems
        
        # Categorize changes
        categories = self._categorize_changes(diff_output, files_changed)
        
        # Create gem entries
        for category, description in categories.items():
            gem = {
                'category': category,
                'description': description,
                'files_changed': files_changed,
                'diff_summary': self._create_diff_summary(diff_output, files_changed),
            }
            gems.append(gem)
        
        return gems
    
    def _extract_changed_files(self, diff_output: str) -> List[str]:
        """Extract list of changed files from diff"""
        files = []
        
        # Look for diff headers
        for line in diff_output.split('\n'):
            if line.startswith('diff --git'):
                # Extract file path
                match = re.search(r'b/(.+)$', line)
                if match:
                    files.append(match.group(1))
        
        return files
    
    def _categorize_changes(self, diff_output: str, files_changed: List[str]) -> Dict[str, str]:
        """Categorize changes based on diff content and files"""
        categories = {}
        diff_lower = diff_output.lower()
        
        # Check for security-related changes
        security_keywords = CATEGORY_KEYWORDS['security']
        for keyword in security_keywords:
            if keyword.lower() in diff_lower:
                categories['security'] = f"Security-related changes detected (keyword: {keyword})"
                break
        
        # Check for feature additions
        feature_indicators = ['+class ', '+def ', '+function ', '+ *@']
        if any(indicator in diff_output for indicator in feature_indicators):
            categories['feature'] = "New code structures added (classes, functions, decorators)"
        
        # Check for optimization
        optimization_keywords = CATEGORY_KEYWORDS['optimization']
        for keyword in optimization_keywords:
            if keyword.lower() in diff_lower:
                categories['optimization'] = f"Optimization detected (keyword: {keyword})"
                break
        
        # Check for fixes
        fix_keywords = CATEGORY_KEYWORDS['fix']
        for keyword in fix_keywords:
            if keyword.lower() in diff_lower:
                categories['fix'] = f"Bug fix detected (keyword: {keyword})"
                break
        
        # Check file types for additional categorization
        if any('.c' in f or '.cpp' in f or '.h' in f for f in files_changed):
            if 'optimization' not in categories and 'performance' in diff_lower:
                categories['optimization'] = "Performance improvements in C/C++ code"
        
        return categories
    
    def _create_diff_summary(self, diff_output: str, files_changed: List[str]) -> str:
        """Create a summary of the diff"""
        lines = diff_output.split('\n')
        additions = sum(1 for line in lines if line.startswith('+') and not line.startswith('+++'))
        deletions = sum(1 for line in lines if line.startswith('-') and not line.startswith('---'))
        
        summary = f"{len(files_changed)} file(s) changed, {additions} insertions(+), {deletions} deletions(-)\n"
        summary += f"Files: {', '.join(files_changed[:10])}"
        if len(files_changed) > 10:
            summary += f" ... and {len(files_changed) - 10} more"
        
        return summary
    
    def _cleanup(self, clone_path: Path):
        """Remove cloned repository"""
        try:
            if clone_path.exists():
                shutil.rmtree(clone_path)
                logger.debug(f"  Cleaned up {clone_path}")
        except Exception as e:
            logger.warning(f"  Failed to cleanup {clone_path}: {e}")
