"""
Budget Collector HTTP API

Exposes endpoints for the OpenClaw plugin to query budget data.
Run with: uvicorn api:app --port 8765

READ vs WRITE. The GET endpoints are open to a caller that can reach the port; every
mutating endpoint (POST /usage, POST /budgets, POST /manus/task) additionally requires
the X-Token-Panel-Token header to match TOKEN_PANEL_API_TOKEN, and is CLOSED outright
when that variable is unset. Bind to localhost: the GETs report your spend and quota.
"""

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime
from typing import Optional
import os
import db

MUTATE_TOKEN = os.environ.get("TOKEN_PANEL_API_TOKEN", "")

def require_mutate_token(x_token: Optional[str] = Header(default=None, alias="X-Token-Panel-Token")):
    if not MUTATE_TOKEN:
        raise HTTPException(status_code=403, detail="TOKEN_PANEL_API_TOKEN is not set; mutating endpoints are closed")
    if not x_token or x_token != MUTATE_TOKEN:
        raise HTTPException(status_code=403, detail="mutating endpoints require X-Token-Panel-Token")

app = FastAPI(
    title="Budget Collector API",
    description="Track AI provider usage and budgets",
    version="1.0.0",
)

# Local dashboards only. Wildcard CORS would let any website the user has
# open call this API from the browser and read or mutate usage records.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:18789",
        "http://localhost:18789",
        "http://127.0.0.1:8765",
        "http://localhost:8765",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


# ============================================================================
# Models
# ============================================================================

class UsageRecord(BaseModel):
    provider: str
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float = 0
    session_key: Optional[str] = None
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0

class ManusTask(BaseModel):
    # No description/prompt field: a usage record is an id, a credit count and a status.
    # Pydantic drops unknown keys, so an older client still POSTing "description" gets a
    # 200 and its prompt text goes nowhere.
    task_id: str
    credits_used: int
    status: str = "completed"

class BudgetConfig(BaseModel):
    provider: str
    monthly_limit: float
    alert_threshold: float = 0.8


# ============================================================================
# Endpoints
# ============================================================================

@app.get("/")
def root():
    return {"status": "ok", "service": "budget-collector"}


@app.get("/health")
def health():
    return {"status": "healthy", "timestamp": datetime.utcnow().isoformat()}


# --- Usage Recording ---

@app.post("/usage")
def record_usage(record: UsageRecord, x_token: Optional[str] = Header(default=None, alias="X-Token-Panel-Token")):
    """Record a usage event from any provider."""
    require_mutate_token(x_token)
    conn = db.get_connection()
    db.record_usage(
        conn,
        provider=record.provider,
        model=record.model,
        input_tokens=record.input_tokens,
        output_tokens=record.output_tokens,
        cost_usd=record.cost_usd,
        session_key=record.session_key,
        cache_read=record.cache_read_tokens,
        cache_write=record.cache_write_tokens,
    )
    return {"status": "recorded"}


@app.post("/manus/task")
def record_manus_task(task: ManusTask, x_token: Optional[str] = Header(default=None, alias="X-Token-Panel-Token")):
    """Record a Manus task completion."""
    require_mutate_token(x_token)
    conn = db.get_connection()
    db.record_manus_task(
        conn,
        task_id=task.task_id,
        credits_used=task.credits_used,
        status=task.status,
    )
    return {"status": "recorded"}


# --- Budget Management ---

@app.post("/budgets")
def set_budget(config: BudgetConfig, x_token: Optional[str] = Header(default=None, alias="X-Token-Panel-Token")):
    """Set or update a monthly budget."""
    require_mutate_token(x_token)
    conn = db.get_connection()
    db.set_budget(conn, config.provider, config.monthly_limit, config.alert_threshold)
    return {"status": "updated"}


@app.get("/budgets")
def get_budgets():
    """Get current budget status for all providers."""
    conn = db.get_connection()
    return {"budgets": db.get_budget_status(conn)}


@app.get("/budgets/{provider}")
def get_budget(provider: str):
    """Get budget for a specific provider."""
    conn = db.get_connection()
    budget = db.get_budget(conn, provider)
    if not budget:
        raise HTTPException(status_code=404, detail=f"No budget set for {provider}")
    return budget


# --- Queries ---

@app.get("/summary/monthly")
def get_monthly_summary(year: int = None, month: int = None):
    """Get monthly usage summary."""
    now = datetime.utcnow()
    year = year or now.year
    month = month or now.month
    
    conn = db.get_connection()
    return {
        "year": year,
        "month": month,
        "providers": db.get_monthly_summary(conn, year, month),
    }


@app.get("/summary/daily/{provider}")
def get_daily_breakdown(provider: str, days: int = 30):
    """Get daily breakdown for a provider."""
    conn = db.get_connection()
    return {
        "provider": provider,
        "days": db.get_daily_breakdown(conn, provider, days),
    }


@app.get("/status")
def get_status():
    """Get overall budget status (for agent system prompt)."""
    conn = db.get_connection()
    budgets = db.get_budget_status(conn)
    
    # Build status string for agent
    alerts = []
    status_parts = []
    
    for b in budgets:
        provider = b["provider"]
        pct = b["percent"]
        status = b["status"]
        
        if provider == "manus":
            status_parts.append(f"{provider}={pct:.0f}% ({b['used']}/{b['limit']} credits)")
        else:
            status_parts.append(f"{provider}={pct:.0f}% (${b['used']:.2f}/${b['limit']:.2f})")
        
        if status == "critical":
            alerts.append(f"🔴 CRITICAL: {provider} at {pct:.0f}%")
        elif status == "warning":
            alerts.append(f"🟠 WARNING: {provider} at {pct:.0f}%")
    
    overall = "critical" if any(b["status"] == "critical" for b in budgets) else \
              "warning" if any(b["status"] == "warning" for b in budgets) else "ok"
    
    return {
        "overall": overall,
        "summary": " | ".join(status_parts),
        "alerts": alerts,
        "budgets": budgets,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765)
