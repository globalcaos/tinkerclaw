---
file: auth-routing.md
purpose: Which model gets picked, in what order, when does fallback fire, when is billing gated
audience: AI
last_verified: 2026-06-10
last_verified_commit: HEAD
single_owner: yes — model routing + auth profile order + billing logic live here
see_also: config-shape.md (where these keys are read), failures.md (M1 idle watchdog, billing failures)
verify:
  - name: anthropic auth order is cli-gm only (subscription, not metered api)
    cmd: python3 -c 'import json,os; cfg = json.load(open(os.path.expanduser("~/.openclaw/openclaw.json"))); assert cfg["auth"]["order"]["anthropic"] == ["anthropic:cli-gm"]'
  - name: primary model is a flat-rate subscription model (cli-gm / claude-code), never a metered api model
    cmd: python3 -c 'import json,os; cfg=json.load(open(os.path.expanduser("~/.openclaw/openclaw.json"))); p=cfg["agents"]["defaults"]["model"]["primary"]; assert p.startswith("claude-code/"), f"primary {p} is metered, not the flat-rate subscription"'
  - name: primary model is the best-ranked subscription model (rank table is cron-updated daily — derive it per design-principles.md, never freeze a model name)
    cmd: python3 -c 'import json,os; cfg=json.load(open(os.path.expanduser("~/.openclaw/openclaw.json"))); d=cfg["agents"]["defaults"]; p=d["model"]["primary"]; subs={k:v["rank"] for k,v in d["models"].items() if k.startswith("claude-code/") and isinstance(v,dict) and "rank" in v}; best=min(subs,key=subs.get); assert p==best, f"primary {p} != best-ranked subscription model {best} @ rank {subs[best]}"'
---

# Auth + model routing

## Model rank table

Source of truth: `agents.defaults.models[<provider/model>].rank` in `openclaw.json`. Updated by the `model-rank-refresh` cron at 06:30 daily, fetching the Artificial Analysis Intelligence Index leaderboard.

**The primary is DERIVED, not frozen (design-principles.md #19).** `agents.defaults.model.primary` is the **best-ranked _subscription_ (cli-gm / `claude-code/*`) model** — never a metered model, however highly the leaderboard ranks it. The rank numbers churn daily; the routing rule does not. The frontmatter `verify:` enforces the derived rule (primary is a `claude-code/*` model AND equals the lowest-rank `claude-code/*` entry), so it survives a new model landing at the top instead of re-breaking on every cron run. The table below is a dated snapshot, illustrative only.

Current snapshot (2026-06-10):

| Rank | Model                           | Alias        | Tier                  | Notes                                           |
| ---- | ------------------------------- | ------------ | --------------------- | ----------------------------------------------- |
| 1    | claude-code/claude-opus-4-8     | —            | subscription (cli-gm) | **PRIMARY** for agents.defaults.model           |
| 2    | openai/gpt-5.5                  | —            | metered               | top leaderboard rank, but metered → not primary |
| 3    | claude-code/claude-opus-4-7     | —            | subscription (cli-gm) | prior primary                                   |
| 4    | google/gemini-3.1-pro-preview   | gemini       | metered               |                                                 |
| 5    | google/gemini-3.5-flash-preview | —            | metered               |                                                 |
| 6    | openai/gpt-5.3-codex            | —            | metered               |                                                 |
| 7    | claude-code/claude-sonnet-4-6   | sonnet       | subscription (cli-gm) |                                                 |
| 8    | openai/gpt-5.4-mini             | —            | metered               |                                                 |
| 9    | openai/gpt-5.4-nano             | —            | metered               |                                                 |
| 10   | claude-code/claude-haiku-4-5    | haiku        | subscription (cli-gm) |                                                 |
| 11   | openai/o3                       | —            | metered               |                                                 |
| 12   | openai/gpt-5.4                  | gpt54        | metered               |                                                 |
| 13   | google/gemini-3-flash-preview   | gemini-flash | metered               |                                                 |
| 14   | google/gemini-3-pro-preview     | —            | metered               |                                                 |
| 15   | openai/gpt-5.4-pro              | —            | metered               |                                                 |
| 16   | openai/gpt-5.2-pro              | gpt          | metered               |                                                 |
| 17   | google/gemini-2.5-pro           | —            | metered               |                                                 |
| 18   | openai/gpt-5.2                  | —            | metered               |                                                 |
| 19   | openai/gpt-5.1                  | —            | metered               |                                                 |
| 20   | openai/gpt-4.1                  | —            | metered               |                                                 |
| 21   | openai/gpt-4o                   | —            | metered               |                                                 |
| 22   | google/gemini-2.5-flash         | —            | metered               |                                                 |
| 23   | google/gemini-2.0-flash         | —            | metered               |                                                 |

## Provider routing

### claude-code (Anthropic subscription via claude-cli)

- **Driver:** `tinkerclaw-cc-bridge` plugin → claude-cli subprocess.
- **Auth profile:** `anthropic:cli-gm` (OAuth, `~/.claude/.credentials-gm.json`).
- **Order:** `[cli-gm]` only. The metered `anthropic:api` profile is DISABLED in `auth.order.anthropic`.
- **Tier:** subscription (max_20x at $200/month per `env.ANTHROPIC_SUBSCRIPTION_TIER`).
- **Timeout:** 600s (via plugin overlay, see config-shape.md).
- **Tool execution:** internal to claude-cli (see tool-loop.md).

### openai

- **Driver:** upstream openai provider.
- **Auth profile:** `openai:default` (API key from `env.OPENAI_API_KEY`).
- **Order:** `[default]`.
- **Tier:** metered.

### google

- **Driver:** upstream google provider.
- **Auth profile:** `google:default` (API key from `env.GOOGLE_API_KEY` if set, else gateway resolves).
- **Order:** `[default]`.
- **Tier:** metered.

### ollama (local)

- **Driver:** upstream ollama provider.
- **Auth profile:** `ollama:default` (`apiKey: "ollama-local"`).
- **Base URL:** `http://127.0.0.1:11434`.
- **Tier:** free / local. Currently used only for `mxbai-embed-large` (memorySearch embeddings), not for chat.

## Failover and cost-aware routing

The fork patched the upstream failover bug 2026-02-19 (bible §11.x):

- **Removed early `throw` for unclassified errors** in `model-fallback.ts` (was line 355-357). This unblocks the failover chain when the error doesn't match a known category.
- **Order:** OAuth (subscription) FIRST, then API (pay-per-use). Exhaust flat-rate before metering.
- **Primary switched opus-4-6 → sonnet-4-6 → opus-4-7 → opus-4-8** (today's primary, 2026-06-10 — opus-4-8 entered the leaderboard at rank 1 and is a subscription model, so the derived rule promoted it automatically).

### Billing gate (2026-03-20, DEPLOYED)

Cost-aware routing in `model-fallback.ts` blocks metered models (GPT, o3, gemini-metered) when:

1. **Flat-rate primary has headroom** (`<70%` of seven-day quota burned), OR
2. **Provider spend exceeds per-model `monthlyCapUsd`** (configured per model).

Rationale: keep AI work on the flat-rate subscription as long as it can handle the load. Only spill to metered when the subscription is exhausted, and only up to a hard $/month cap per metered model.

Configured in `agents.defaults.models[<id>].billing` + `.monthlyCapUsd`. Knowledge: `~/.openclaw/workspace/memory/knowledge/cost-aware-model-routing.md`.

### Failover-bug history

- 2026-02-19 — patched the `throw` removing the failover ceiling.
- 2026-02-19 — primary switched to sonnet-4-6 (same quality, 1/5 cost) and later to opus-4-7.
- 2026-03-20 — billing gate deployed.
- **CRITICAL after patching:** clear `usageStats` in `~/.openclaw/agents/main/agent/auth-profiles.json` + gateway restart, OR the old billing state will keep the gate closed even after a fix.

### Rate-limit header capture (2026-04-03)

Anthropic returns rate-limit headers; the fork captures these and uses them to project the seven-day-spent percentage for the billing gate. See bible §11.x.

## Auth profile environment

`env.vars` in openclaw.json contains:

- `ANTHROPIC_API_KEY` (metered fallback, currently unused due to `auth.order.anthropic = [cli-gm]`)
- `CLAUDE_AI_SESSION_KEY` (claude.ai session)
- `ANTHROPIC_ADMIN_API_KEY` (admin operations)
- `ANTHROPIC_SUBSCRIPTION_TIER = "max_20x"`
- `ANTHROPIC_MONTHLY_BUDGET_USD = "200"`
- `OPENAI_API_KEY`, `OPENAI_ADMIN_API_KEY`
- `MANUS_API_KEY`, `BRAVE_API_KEY`
- `OLLAMA_API_KEY = "ollama-local"`

**PII boundary note:** these env vars contain real credentials. They live in the PRIVATE jarvis-brain repo (`~/.openclaw/openclaw.json`), never in the public tinkerclaw fork. See `pii-boundary.md`.

## Don't regress

- `cli-gm` profile is the only Anthropic auth in use. The `api` profile must stay out of `auth.order.anthropic` until the OAuth subscription is genuinely exhausted (not just for testing).
- The downscoped-token cascade incident (2026-02-23 per bible §11.x) — downscoped tokens written back to BOTH `auth-profiles.json` AND credential files corrupted the credentials. cli-sv refresh token was invalidated by Anthropic strict rotation after 2 days. **Never write downscoped tokens back to source-of-truth credential files.**
- OAuth was NOT disabled by Anthropic. Whenever you see auth-related errors, do NOT assume OAuth is gone (memory note `feedback_oauth_assumption.md`).

## Verify (proposed)

```yaml
verify:
  - cmd: openclaw gateway call models.list
    expect: '.providers["claude-code"] != null'
  - cmd: jq -r '.auth.order.anthropic' ~/.openclaw/openclaw.json
    expect: '["cli-gm"]'
```
