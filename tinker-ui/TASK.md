# Build Tinker UI Command Center — Full Working Implementation

## Context

You are in `tinker-ui/` inside the OpenClaw fork. This is a standalone Vite+Lit app on port 18790.
The gateway runs on ws://localhost:18789. Vite proxies /ws → ws://localhost:18789.

## CRITICAL: Gateway WebSocket Protocol

Study `../ui/src/ui/gateway.ts` — it's a JSON-RPC WebSocket client. Copy its connection protocol:

1. Connect to ws://localhost:18789/ws
2. Wait for `connect.challenge` event with nonce
3. Send `connect` request with auth params
4. Receive `hello-ok` response
5. Subscribe to events

For THIS prototype, use a SIMPLIFIED gateway client:

- No device auth (we're localhost)
- Use token from localStorage or prompt
- The gateway config has a token — check `~/.openclaw/openclaw.json` for `gateway.auth.token`

Key API methods (from `../ui/src/ui/controllers/`):

- `chat.history` { sessionKey, limit } → { messages, thinkingLevel }
- `chat.send` { sessionKey, message, attachments? } → void
- `chat.abort` { sessionKey } → void
- `sessions.list` {} → { sessions: [...] }
- `sessions.usage` { startDate, endDate } → { sessions, totals, aggregates }
- `usage.cost` { startDate, endDate } → { daily: [...] }
- `status` {} → gateway status
- `health` {} → health check
- `models.list` {} → available models

Events broadcast on the WebSocket:

- `chat` event: { runId, sessionKey, state: "delta"|"final"|"error", message }
- `agent` event: { runId, stream, data, sessionKey } — tool calls, lifecycle

## What to Build

### Layout: Grafana-style dashboard

- Left sidebar: 48px with icon buttons for panel navigation
- Main area: resizable panels in a grid
- Bottom-left: token monitor (always visible)
- Center: chat (always visible, takes most space)
- Right side: context/security/mission panels (collapsible)

### 1. Chat Panel (center, largest)

- Message list with auto-scroll
- Input box at bottom with send button
- Session selector dropdown at top
- Messages render markdown (use a simple marked.js or just innerHTML for now)
- Assistant messages: left-aligned, dark card
- User messages: right-aligned, accent color
- Tool calls: compact one-line rows, click to expand INLINE (not sidebar!)
  - exec: show command, exit code, first 10 lines of output
  - read/write/edit: show file path + snippet
  - web_search: show query + result count
- System messages: collapsed one-liner, click to expand
- Stream indicator when assistant is generating
- **Jarvis voice**: lines matching `**Jarvis:** *text*` render in purple italic

### 2. Token Monitor (bottom-left, always visible)

Port the full token tracking from `../ui/src/ui/controllers/provider-usage.ts` (we saved it in git history, commit before 5070018f0). This panel shows:

- Per-provider usage bars (Anthropic, OpenAI)
- 5-hour Claude rate limit window with progress bar and reset countdown
- Session token count (input/output)
- Estimated cost today
- Budget alerts if configured
- Claude shared usage (from browser relay if available)
- Auto-refresh every 5 minutes

### 3. Real-time Status Indicators (top bar or sidebar)

- Gateway connection status (green/red dot)
- WhatsApp connection status
- Active sessions count
- Current model
- Uptime

### Implementation Notes

- Use vanilla TypeScript + lit-html for rendering (already in deps)
- Keep it in ONE file (app.ts) for now — we'll split later
- CSS in base.css
- Gateway client: simple WebSocket class, no device auth complexity
- For the token monitor: call `sessions.usage` and `usage.cost` on connect and every 5 min
- For chat: call `chat.history` on load, `chat.send` on submit, listen for `chat` events

### Style

- Dark theme (already set up in base.css)
- Monospace for code/data
- Information-dense — this is a control panel, not a consumer app
- Subtle borders, no heavy shadows
- Green/yellow/red status dots
- Purple for Jarvis voice lines

### DO NOT

- Do not import from ../ui/ (zero overlap)
- Do not use React or heavy frameworks
- Do not create a sidebar panel for tool output (INLINE expansion only)
- Do not over-abstract — working prototype first
