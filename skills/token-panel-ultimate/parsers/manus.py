"""
Manus AI Task Tracker

Tracks Manus task completions and credit usage.

Where the numbers come from — Manus publishes no aggregate usage endpoint, so this
module POLLS THE MANUS TASK API directly (GET {MANUS_API_BASE}/tasks/<id>) with the key
you stored via `secretstore.py --login manus`, and records what comes back. Tasks can
also be recorded by hand through the collector API.

What it keeps: the task id, its status, the credit count and the timestamps. The task
PROMPT is deliberately dropped on the floor here rather than at the storage layer — a
usage dashboard has no reason to hold the text of what you asked for.

Manus Docs: https://manus.im/docs/introduction/plans
"""

import os
import httpx
from datetime import datetime
from typing import Optional
import logging
import json

from secretstore import get_secret

logger = logging.getLogger(__name__)

# Manus API endpoints
MANUS_API_BASE = "https://api.manus.ai/v1"


class ManusParser:
    """Track Manus AI task usage."""
    
    def __init__(self, api_key: Optional[str] = None):
        stored_key, _ = get_secret("manus")
        self.api_key = api_key or stored_key
        
    def is_configured(self) -> bool:
        """Check if the parser has required credentials."""
        return bool(self.api_key)
    
    async def get_task_status(self, task_id: str) -> Optional[dict]:
        """Fetch task status from Manus API."""
        if not self.api_key:
            logger.warning("no Manus credential stored; run: secretstore.py --login manus")
            return None
        
        async with httpx.AsyncClient() as client:
            try:
                response = await client.get(
                    f"{MANUS_API_BASE}/tasks/{task_id}",
                    headers={"API_KEY": self.api_key},
                    timeout=30,
                )
                response.raise_for_status()
                return response.json()
            except httpx.HTTPError as e:
                logger.error(f"Failed to fetch Manus task {task_id}: {e}")
                return None
    
    def parse_task_response(self, response: dict) -> dict:
        """Parse a Manus task response into our format — usage metadata only.

        `response["prompt"]` is NOT read. It is the text of the user's task, and a
        truncated copy of it is still a copy; nothing downstream needs it to count
        credits, so it never enters the record in the first place.
        """
        return {
            "task_id": response.get("task_id", "unknown"),
            "credits_used": response.get("credit_usage", 0),
            "status": response.get("status", "unknown"),
            "started_at": response.get("created_at"),
            "completed_at": response.get("completed_at"),
            "metadata": {
                "task_url": response.get("task_url"),
                "output_count": len(response.get("output", [])),
            }
        }
    
    async def poll_active_tasks(self, task_ids: list[str]) -> list[dict]:
        """Poll multiple tasks for their current status."""
        results = []
        for task_id in task_ids:
            status = await self.get_task_status(task_id)
            if status:
                results.append(self.parse_task_response(status))
        return results
    
    def estimate_credits(self, description: str) -> dict:
        """Estimate credit usage from task text WITHOUT retaining it.

        The string is scanned for complexity keywords and its length is measured; it is
        never returned, logged or stored. Callers pass text they already hold.
        
        Based on observed patterns:
        - Simple queries: 2-5 credits
        - Research tasks: 10-30 credits
        - Complex multi-step: 30-100 credits
        - Deep research with browsing: 50-200 credits
        """
        desc_lower = description.lower()
        
        # Keywords that indicate complexity
        research_keywords = ["research", "analyze", "comprehensive", "detailed", "explore"]
        browse_keywords = ["browse", "search", "find", "look up", "website"]
        multi_step_keywords = ["step by step", "multiple", "compare", "list of"]
        
        base = 5
        
        if any(k in desc_lower for k in research_keywords):
            base += 20
        if any(k in desc_lower for k in browse_keywords):
            base += 15
        if any(k in desc_lower for k in multi_step_keywords):
            base += 10
        
        # Length factor
        if len(description) > 500:
            base += 10
        elif len(description) > 200:
            base += 5
        
        return {
            "min": max(2, int(base * 0.5)),
            "expected": base,
            "max": int(base * 2.5),
        }


# Singleton instance
_parser = None

def get_parser() -> ManusParser:
    global _parser
    if _parser is None:
        _parser = ManusParser()
    return _parser
