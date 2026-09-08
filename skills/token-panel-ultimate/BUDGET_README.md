# Budget Collector

Standalone service for tracking AI provider usage and costs.

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
│ (GET only)      │     │ API (port 8765)  │     │ budget.db   │
└─────────────────┘     └──────────────────┘     └─────────────┘
                               │
                    ┌──────────┼──────────┐
                    ▼          ▼          ▼
              Transcripts   Anthropic    Manus
              (local)       Usage API    Tracker
```

## Quick Start

```bash
# Install dependencies (from the skill directory)
pip install -r requirements.txt

# Initialize database with default budgets
python collector.py --init-budgets

# Run collector once
python collector.py

# Start API server
uvicorn api:app --port 8765
```

## API Endpoints

This API is **not read-only.** It serves reads _and_ writes; the two are separated by
authentication, not by absence. Read the Auth column before you expose the port.

| Endpoint                    | Method | Auth      | Description                               |
| --------------------------- | ------ | --------- | ----------------------------------------- |
| `/status`                   | GET    | none      | Overall budget status (for agent)         |
| `/budgets`                  | GET    | none      | All budget configurations                 |
| `/summary/monthly`          | GET    | none      | Monthly usage summary                     |
| `/summary/daily/{provider}` | GET    | none      | Daily breakdown                           |
| `/budgets`                  | POST   | **token** | Set/update a budget                       |
| `/usage`                    | POST   | **token** | Record a usage event                      |
| `/manus/task`               | POST   | **token** | Record a Manus task (id, credits, status) |

**token** = the request must carry `X-Token-Panel-Token` matching the server's
`TOKEN_PANEL_API_TOKEN`. When that variable is unset, every mutating endpoint returns
403 — writes are closed, not open. The GET endpoints have no auth at all, so anything
that can reach port 8765 can read what you spend: bind to localhost and leave it there.

`POST /manus/task` accepts a task id, a credit count and a status. It has no field for
prompt or task text; a legacy client that still sends `description` gets a 200 and the
text is discarded, not stored.

## Configuration

### Credentials

Store provider keys in your OS keychain. Do not export them in a shell:

```bash
python3 secretstore.py --login anthropic     # reads the key from stdin
python3 secretstore.py --login openai
python3 secretstore.py --login gemini
python3 secretstore.py --login manus

python3 secretstore.py --status              # which providers are configured
python3 secretstore.py --logout anthropic    # clears every local store
```

`--login` reads from stdin, so the secret never lands in your shell history or in any
process's command line. With no keychain available (`secret-tool` on Linux, the login
Keychain on macOS) the value goes to a `0600` file inside a `0700` directory and the
tool warns you every single run.

**Handling the secrets themselves.** These keys read your billing and usage data, and an
Anthropic **admin** key is far broader than that — prefer the narrowest key the endpoint
will accept, and use an admin key only if you actually need admin-scoped usage figures.
Whichever you use:

- Do not paste keys into a shared terminal, a screenshot, an issue, or a chat log.
- Do not commit them. A `.env` you keep locally should be `chmod 600` and gitignored.
- `export`ed variables are inherited by every child process and show up in crash dumps
  and CI logs — that is why this tool's default source is the keychain, not the
  environment.
- Rotate on exposure: delete the key at the provider console (`--logout` prints the
  exact URL per provider) and mint a new one. Removing the local copy is not revocation.

**Environment variables** are a fallback for CI and one-shot runs:

| Variable                                                                                                   | Read by default?                                      |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `TOKEN_PANEL_ANTHROPIC_TOKEN`, `TOKEN_PANEL_OPENAI_KEY`, `TOKEN_PANEL_GEMINI_KEY`, `TOKEN_PANEL_MANUS_KEY` | yes — these are ours                                  |
| `ANTHROPIC_ADMIN_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `MANUS_API_KEY`                             | **no** — only with `TOKEN_PANEL_ALLOW_PROVIDER_ENV=1` |

The second row belongs to other tools. Consuming it silently would mean this dashboard
spending a credential nobody handed it, so it takes an explicit opt-in.

### Network calls you have to ask for

`chatgpt-usage-fetch.py` and `gemini-usage-fetch.py` can only read live rate-limit
headroom by making a real API request. Both are **off by default** and print what they
would do; pass `--probe` to allow the calls. They are billable and appear in your
provider account activity.

### Transcript scanning

The collector reads local session transcripts only when `TOKEN_PANEL_READ_TRANSCRIPTS=1`.
Off by default; only token counts are extracted, never message text.

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

`~/.openclaw/data/budget.db`, created `0600` in a `0700` directory.

It holds counts and identifiers only: provider, model, token totals, cost, credit totals,
opaque task ids, statuses and timestamps. Earlier versions stored a 200-character slice
of each Manus task prompt; on first connect this version blanks those values and never
writes them again.

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
token-panel-ultimate/
├── api.py              # FastAPI server
├── collector.py        # Collection daemon
├── db.py               # SQLite database
├── parsers/
│   ├── anthropic.py    # Anthropic Usage API
│   ├── gemini.py       # Gemini cost calculator
│   ├── manus.py        # Manus task tracker
│   └── transcript.py   # OpenClaw log parser
├── secretstore.py      # keychain-backed credential store
├── requirements.txt
├── budget-collector.service
└── BUDGET_README.md
```

## Independence from OpenClaw

This service is **completely standalone**:

- Own codebase
- Own SQLite database (owner-only, `0600` inside a `0700` directory)
- Own systemd service
- No modifications to OpenClaw core
- Survives OpenClaw updates/merges

OpenClaw integration is via a plugin that only issues GET requests against this API. The
API itself can write — see the Auth column in the endpoint table — so "read-only"
describes the plugin, not the service.
