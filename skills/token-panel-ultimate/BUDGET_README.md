# Budget Collector

Standalone service for tracking AI provider usage and costs.

**Location:** `~/src/budget-collector/`

## Features

- 📊 Track usage from multiple providers (Anthropic, Gemini, Manus, OpenAI)
- 💰 Set monthly budgets with alerts
- 📁 Parse OpenClaw transcripts for usage data
- 🔌 REST API for OpenClaw plugin integration
- 🗄️ SQLite database (no external dependencies)

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│ OpenClaw Plugin │────▶│ Budget Collector │────▶│ SQLite DB   │
│ (read-only)     │     │ API (port 8765)  │     │ budget.db   │
└─────────────────┘     └──────────────────┘     └─────────────┘
                               │
                    ┌──────────┼──────────┐
                    ▼          ▼          ▼
              Transcripts   Anthropic    Manus
              (local)       Usage API    Tracker
```

## Quick Start

```bash
# Install dependencies
cd ~/src/budget-collector
pip install -r requirements.txt

# Initialize database with default budgets
python collector.py --init-budgets

# Run collector once
python collector.py

# Start API server
uvicorn api:app --port 8765
```

## API Endpoints

| Endpoint                    | Method | Description                       |
| --------------------------- | ------ | --------------------------------- |
| `/status`                   | GET    | Overall budget status (for agent) |
| `/budgets`                  | GET    | All budget configurations         |
| `/budgets`                  | POST   | Set/update a budget               |
| `/usage`                    | POST   | Record a usage event              |
| `/manus/task`               | POST   | Record Manus task                 |
| `/summary/monthly`          | GET    | Monthly usage summary             |
| `/summary/daily/{provider}` | GET    | Daily breakdown                   |

## Configuration

### Environment Variables

```bash
# Optional - for direct API access
export ANTHROPIC_ADMIN_API_KEY="sk-admin-..."
export MANUS_API_KEY="..."
export GOOGLE_API_KEY="..."
```

### Default Budgets

```python
anthropic: $100/month
gemini: $50/month
manus: 500 credits/month
openai: $50/month
```

## Systemd Service

```bash
# Install service
sudo cp budget-collector.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable budget-collector
sudo systemctl start budget-collector

# Check status
sudo systemctl status budget-collector
```

## Database Location

`~/.openclaw/data/budget.db`

## Usage from OpenClaw

The API returns status in agent-friendly format:

```bash
curl http://localhost:8765/status
```

```json
{
  "overall": "ok",
  "summary": "anthropic=45% ($45.00/$100.00) | manus=60% (300/500 credits)",
  "alerts": [],
  "budgets": [...]
}
```

## Files

```
~/src/budget-collector/
├── api.py              # FastAPI server
├── collector.py        # Collection daemon
├── db.py               # SQLite database
├── parsers/
│   ├── anthropic.py    # Anthropic Usage API
│   ├── gemini.py       # Gemini cost calculator
│   ├── manus.py        # Manus task tracker
│   └── transcript.py   # OpenClaw log parser
├── requirements.txt
├── budget-collector.service
└── README.md
```

## Independence from OpenClaw

This service is **completely standalone**:

- Own codebase in `~/src/budget-collector/`
- Own SQLite database
- Own systemd service
- No modifications to OpenClaw core
- Survives OpenClaw updates/merges

OpenClaw integration is via a read-only plugin that queries this API.
