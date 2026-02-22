"""
Rate limiter module for GitHub API requests
"""
import time
import logging
from datetime import datetime
from typing import Optional, Dict
import requests

from config import RATE_LIMIT_CONFIG, GITHUB_API_HEADERS, GITHUB_API_BASE

logger = logging.getLogger(__name__)


class RateLimiter:
    """Manages GitHub API rate limiting"""
    
    def __init__(self):
        self.remaining = None
        self.limit = None
        self.reset_time = None
        self.last_check = None
        self.min_remaining = RATE_LIMIT_CONFIG['min_remaining']
        self.sleep_buffer = RATE_LIMIT_CONFIG['sleep_buffer']
        self.max_retries = RATE_LIMIT_CONFIG['max_retries']
        self.backoff_base = RATE_LIMIT_CONFIG['backoff_base']
    
    def check_rate_limit(self):
        """Check current rate limit status from GitHub API"""
        try:
            response = requests.get(
                f"{GITHUB_API_BASE}/rate_limit",
                headers=GITHUB_API_HEADERS,
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                core = data['resources']['core']
                self.remaining = core['remaining']
                self.limit = core['limit']
                self.reset_time = core['reset']
                self.last_check = time.time()
                
                logger.info(f"Rate limit: {self.remaining}/{self.limit} remaining, "
                          f"resets at {datetime.fromtimestamp(self.reset_time)}")
                return True
            else:
                logger.warning(f"Failed to check rate limit: {response.status_code}")
                return False
        except Exception as e:
            logger.error(f"Error checking rate limit: {e}")
            return False
    
    def wait_if_needed(self):
        """Wait if rate limit is low"""
        # Check rate limit if not checked recently
        if self.remaining is None or (time.time() - (self.last_check or 0)) > 300:
            self.check_rate_limit()
        
        # If remaining requests are low, wait until reset
        if self.remaining is not None and self.remaining < self.min_remaining:
            if self.reset_time:
                wait_time = self.reset_time - time.time() + self.sleep_buffer
                if wait_time > 0:
                    logger.warning(f"Rate limit low ({self.remaining} remaining). "
                                 f"Sleeping for {wait_time:.0f} seconds until reset...")
                    time.sleep(wait_time)
                    self.check_rate_limit()
    
    def update_from_response(self, response: requests.Response):
        """Update rate limit info from response headers"""
        if 'X-RateLimit-Remaining' in response.headers:
            self.remaining = int(response.headers['X-RateLimit-Remaining'])
            self.limit = int(response.headers['X-RateLimit-Limit'])
            self.reset_time = int(response.headers['X-RateLimit-Reset'])
            self.last_check = time.time()
            
            logger.debug(f"Rate limit updated: {self.remaining}/{self.limit} remaining")
    
    def make_request(self, url: str, params: Optional[Dict] = None, method: str = 'GET') -> Optional[requests.Response]:
        """
        Make a rate-limited request to GitHub API with retry logic
        
        Args:
            url: API endpoint URL
            params: Query parameters
            method: HTTP method (GET, POST, etc.)
        
        Returns:
            Response object or None if all retries failed
        """
        self.wait_if_needed()
        
        for attempt in range(self.max_retries):
            try:
                if method == 'GET':
                    response = requests.get(url, headers=GITHUB_API_HEADERS, params=params, timeout=30)
                elif method == 'POST':
                    response = requests.post(url, headers=GITHUB_API_HEADERS, json=params, timeout=30)
                else:
                    logger.error(f"Unsupported HTTP method: {method}")
                    return None
                
                # Update rate limit from response
                self.update_from_response(response)
                
                # Handle rate limit errors
                if response.status_code == 403 and 'rate limit' in response.text.lower():
                    logger.warning("Rate limit exceeded (403). Waiting...")
                    self.check_rate_limit()
                    self.wait_if_needed()
                    continue
                
                if response.status_code == 429:
                    logger.warning("Too many requests (429). Waiting...")
                    retry_after = int(response.headers.get('Retry-After', 60))
                    time.sleep(retry_after)
                    continue
                
                # Handle other errors
                if response.status_code >= 500:
                    wait_time = self.backoff_base ** attempt
                    logger.warning(f"Server error {response.status_code}. Retrying in {wait_time}s...")
                    time.sleep(wait_time)
                    continue
                
                # Success or client error (don't retry)
                return response
                
            except requests.exceptions.Timeout:
                wait_time = self.backoff_base ** attempt
                logger.warning(f"Request timeout. Retrying in {wait_time}s... (attempt {attempt + 1}/{self.max_retries})")
                time.sleep(wait_time)
            except requests.exceptions.RequestException as e:
                wait_time = self.backoff_base ** attempt
                logger.error(f"Request error: {e}. Retrying in {wait_time}s... (attempt {attempt + 1}/{self.max_retries})")
                time.sleep(wait_time)
        
        logger.error(f"Failed to complete request after {self.max_retries} attempts: {url}")
        return None
    
    def get_status(self) -> Dict:
        """Get current rate limit status"""
        return {
            'remaining': self.remaining,
            'limit': self.limit,
            'reset_time': datetime.fromtimestamp(self.reset_time).isoformat() if self.reset_time else None,
            'last_check': datetime.fromtimestamp(self.last_check).isoformat() if self.last_check else None,
        }
