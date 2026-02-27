# Tinker UI — Command Center

**Not a chat skin. A command center.**

Standalone Vite + Lit app on port 18790. Connects to the OpenClaw gateway WebSocket on 18789.
Zero file overlap with upstream `ui/`. Zero merge conflicts. Ever.

## Architecture

```
tinker-ui/           ← our project, upstream never touches
├── src/
│   ├── app.ts       ← main app shell (sidebar + panels)
│   ├── gateway.ts   ← WebSocket client (copy protocol from ui/src/ui/gateway.ts)
│   ├── panels/
│   │   ├── chat.ts          ← conversation view
│   │   ├── token-tracker.ts ← native token/cost dashboard
│   │   ├── context-graph.ts ← visual context window usage
│   │   ├── security.ts      ← execution security layer visualization
│   │   ├── mission.ts       ← mission control (sub-agents, cron, health)
│   │   └── metrics.ts       ← clawmetry integration
│   ├── components/
│   │   ├── tool-row.ts      ← compact tool execution row
│   │   ├── exec-detail.ts   ← USEFUL exec detail (diff, output, timing)
│   │   └── system-msg.ts    ← collapsible system messages
│   └── styles/
│       ├── base.css
│       ├── panels.css
│       └── security.css
├── index.html
├── vite.config.ts
└── package.json
```

## Panel Descriptions

### Chat Panel
- Conversation view with messages
- Tool calls render as compact rows (status icon + tool name + one-liner)
- Clicking a tool row expands INLINE with useful detail:
  - exec: show command, exit code, output diff (not raw dump), timing
  - read/write/edit: show file path, line range, before/after diff
  - web_search/fetch: show query, result count, snippet
  - browser: show action + screenshot thumbnail
- System messages: collapsible, one-line summary
- Jarvis voice lines: purple italic styling

### Token Tracker Panel
- Real-time token usage per provider (Anthropic, OpenAI, Ollama)
- 5-hour window progress bar (Claude rate limit)
- Daily/monthly cost tracking
- Budget alerts
- Session cost breakdown

### Context Graph Panel
- Visual representation of the context window
- System prompt size vs user messages vs tool results
- Compaction events marked on timeline
- Memory retrieval hits highlighted

### Security Panel (Code-Enforced Execution Layer)
- Every exec/tool call classified: SAFE / LOW / MEDIUM / HIGH / CRITICAL
- Visual execution log with security badges
- Configurable max security level (blocks above threshold)
- Audit trail: who requested what, when, what was the classification
- "Sleep good at night" mode: shows only HIGH/CRITICAL executions

### Mission Control Panel
- Sub-agent status (running, completed, failed)
- Cron job schedule + last run status
- Gateway health (WhatsApp connected, uptime, reconnects)
- Memory system status (engram, cortex, limbic health)

### Metrics Panel (Clawmetry)
- Token usage over time
- Response latency distribution
- Tool usage frequency
- Error rates
- Cost per conversation

## Gateway WebSocket Protocol

Copy the connection protocol from `ui/src/ui/gateway.ts`. The gateway speaks JSON-RPC over WebSocket.
Key methods:
- `chat.send` — send a message
- `chat.subscribe` — subscribe to chat events (messages, stream, tool calls)
- `sessions.list` — list sessions
- `sessions.history` — get message history
- `usage.status` — get provider usage data

## Design Principles

1. **Dark theme, information-dense** — this is for operators, not consumers
2. **Panels, not pages** — everything visible at once, resize/collapse
3. **Inline expansion** — clicking expands detail IN PLACE, never opens a useless sidebar with the same text
4. **Real-time** — WebSocket-driven, no polling
5. **Zero upstream overlap** — nothing in this directory exists in `ui/`
