# WhatsApp Protocol v2 — Design Spec

**Date:** 2026-03-21
**Author:** Jarvis + Oscar
**Status:** DRAFT — awaiting approval

---

## 1. Problem Statement

Current WhatsApp integration is single-agent, single-personality. Messages are gated by allowFrom + triggerPrefix (groups only). No support for:

- Multiple agent personalities per gateway
- Multi-agent discussions with congestion control
- Conversation lifecycle (staleness, steering, objective tracking)
- Budget-aware conversation scheduling
- DM triggerPrefix gating

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  OpenClaw Gateway                     │
│                                                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │  Agent: Mia  │  │ Agent: Luna │  │  Agent: Rex  │  │
│  │  🦊 SOUL.md  │  │ 🌙 SOUL.md  │  │ 🦖 SOUL.md  │  │
│  │  Own session │  │ Own session │  │ Own session  │  │
│  └──────┬───────┘  └──────┬──────┘  └──────┬──────┘  │
│         │                 │                 │         │
│  ┌──────▼─────────────────▼─────────────────▼──────┐  │
│  │            Multi-Agent Router                    │  │
│  │  • Agent registry (who's in which chat)         │  │
│  │  • Self-message filtering (parse icon prefix)   │  │
│  │  • Addressing detection ("Luna, what about...")  │  │
│  │  • Congestion controller (delay + backpressure)  │  │
│  └──────────────────────┬──────────────────────────┘  │
│                         │                              │
│  ┌──────────────────────▼──────────────────────────┐  │
│  │          Conversation Lifecycle Manager           │  │
│  │  • Objective tracking                            │  │
│  │  • Staleness detection (embedding similarity)    │  │
│  │  • Topic steering                                │  │
│  │  • Closure protocol                              │  │
│  │  • Budget-aware mode switching                   │  │
│  └──────────────────────┬──────────────────────────┘  │
│                         │                              │
│  ┌──────────────────────▼──────────────────────────┐  │
│  │       Existing: access-control + inbound          │  │
│  │  • allowFrom / dmPolicy / groupPolicy             │  │
│  │  • triggerPrefix (now extended to DMs)             │  │
│  │  • Debouncing, media extraction, etc.             │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## 3. Feature Breakdown

### 3.1 DM TriggerPrefix Gating (P0 — foundation)

**Current:** triggerPrefix only gates groups. DMs from allowFrom are always processed.
**New:** triggerPrefix gates ALL messages (DMs + groups), except:

- Intra-agent chats (see 3.3) — no prefix required
- Owner override — Oscar's messages always processed

**Where:** `inbound/access-control.ts` — after allowFrom check, before processing.

**Config:**

```yaml
channels:
  whatsapp:
    triggerPrefix: "Jarvis"
    ownerOverride: true # owner bypasses triggerPrefix
```

### 3.2 Agent Identity & Registry (P0 — foundation)

**File hierarchy:**

```
~/.openclaw/workspace/
├── SOUL.md                    # main agent
├── agents/
│   ├── luna/
│   │   ├── SOUL.md            # Luna's personality
│   │   └── CONTEXT.md         # Luna-specific context (optional)
│   ├── rex/
│   │   └── SOUL.md
│   └── mia/
│       └── SOUL.md
```

**Resolution:** Agent reads `agents/<id>/X.md` first, falls back to workspace `X.md`.

**Config schema addition:**

```typescript
multiAgent: {
  agents: Record<string, {
    id: string;
    name: string;
    icon: string;          // emoji prefix for messages
    soulPath?: string;     // defaults to agents/<id>/SOUL.md
    model?: string;        // model override per agent
  }>;
  mainAgentId?: string;    // which agent is "default" (backward compat)
}
```

**Message format:** Each agent prefixes outbound messages with their icon:

- `🦊 Here's what I think about...`
- `🌙 I disagree — the data shows...`
- `🦖 Devil's advocate: what if we're both wrong?`

### 3.3 Intra-Agent Chat Registry (P1)

**Config:**

```typescript
multiAgent: {
  intraAgentChats: Record<
    string,
    {
      chatId: string; // WhatsApp group JID
      participants: string[]; // agent IDs that participate
      owner: string; // human who controls the chat
      mode: "broadcast" | "addressed" | "round-robin";
      defaultObjective?: string;
    }
  >;
}
```

**Behavior:**

- No triggerPrefix required in these chats
- All listed agents see all messages
- Routing mode determines who responds (see 3.4)

### 3.4 Multi-Agent Routing (P1)

When a message arrives in an intra-agent chat:

1. **Parse origin:** Is this from a human or another agent?
   - Agent messages identified by icon prefix (`🦊`, `🌙`, `🦖`)
   - Self-message filtering: if icon matches current agent → skip (prevent loops)

2. **Addressing check:** Does message mention a specific agent name?
   - `"Luna, what do you think?"` → only Luna responds
   - No mention → broadcast to all per mode

3. **Mode routing:**
   - **broadcast:** All agents enter congestion queue
   - **addressed:** Only named agent responds; others observe
   - **round-robin:** Token-based turn order

**New file:** `extensions/whatsapp/src/multi-agent/router.ts`

### 3.5 Congestion Control (P1)

**Algorithm: Exponential Courtesy Protocol**

```typescript
interface CongestionState {
  chatId: string;
  agentCount: number;
  recentMessages: { agentId: string; timestamp: number }[];
  windowMs: number; // sliding window (default 60s)
}

function computeDelay(state: CongestionState, myAgentId: string): number {
  const { agentCount, recentMessages } = state;

  // Base delay: quadratic in agent count
  const baseDelay = config.baseDelayFactor * agentCount ** 2; // e.g. 150 * 25 = 3750ms for 5 agents

  // Jitter: random 0 to baseDelay
  const jitter = Math.random() * baseDelay;

  // Backpressure: am I talking too much?
  const myMessages = recentMessages.filter((m) => m.agentId === myAgentId).length;
  const fairShare = recentMessages.length / agentCount;
  const backpressure = myMessages > fairShare * 1.5 ? 2.0 : 1.0;

  return Math.min((baseDelay + jitter) * backpressure, config.maxDelay);
}
```

**Yield rule:** If another agent posts during your delay window, restart timer (prevents pile-ups).

**New file:** `extensions/whatsapp/src/multi-agent/congestion.ts`

### 3.6 Conversation Lifecycle (P2)

Three detection systems, stored per-chat:

```typescript
interface ConversationLifecycle {
  chatId: string;
  objective: string | null; // set by human at start
  turnCount: number;
  maxTurns: number; // configurable, default 30
  recentEmbeddings: Float32Array[]; // last N message embeddings
  stalenessScore: number; // 0-1, rolling
  closureProposedBy: string | null; // agentId
  closureAcks: Set<string>; // agentIds that acked
}
```

**A. Staleness Detection:**

- Compute cosine similarity between last N message embeddings
- If avg similarity > threshold (0.85) for 3+ consecutive pairs → stale
- Also detect agreement loops: regex for "I agree" / "Good point" / "Exactly" without new content

**B. Topic Steering:**

- First agent to detect staleness claims `[pivot]` role
- Posts: "We've covered X well. Open thread: Y — worth exploring?"
- Other agents can't pivot for N turns after a pivot

**C. Objective Completion:**

- Agent proposes closure with summary
- Other agents get 1 round to dissent
- If no dissent → close with convergence write to `memory/discussions/`

**New file:** `extensions/whatsapp/src/multi-agent/lifecycle.ts`

### 3.7 Budget-Aware Scheduling (P2)

```typescript
interface BudgetContext {
  provider: string;
  usagePercent: number; // 0-1, how much of window used
  hoursToReset: number;

  mode: "conservative" | "moderate" | "aggressive" | "burn";
}

function resolveBudgetMode(ctx: BudgetContext): BudgetMode {
  if (ctx.hoursToReset < 24 && ctx.usagePercent < 0.2) return "burn";
  if (ctx.usagePercent > 0.85) return "conservative";
  if (ctx.usagePercent > 0.6) return "moderate";
  return "aggressive"; // plenty of headroom
}
```

**Mode effects on congestion + lifecycle:**

| Parameter                   | Conservative | Moderate | Aggressive | Burn       |
| --------------------------- | ------------ | -------- | ---------- | ---------- |
| Congestion delay multiplier | 2.0x         | 1.0x     | 0.7x       | 0.3x       |
| Staleness threshold         | 0.80         | 0.85     | 0.85       | 0.95       |
| Max turns per objective     | 15           | 30       | 30         | 60         |
| Tangent exploration         | off          | off      | on         | encouraged |

**Integration:** Reads from existing `usage-snapshot-store` (shipped Mar 20).

**New file:** `extensions/whatsapp/src/multi-agent/budget.ts`

### 3.8 Turn-End Marker (P0 — trivial)

In 1:1 chats (selfChat or exclusive DM with owner), append ⚡ to every response.

**Where:** `auto-reply/deliver-reply.ts` — append to outbound text.

### 3.9 Convergence & Memory (P2)

Post-conversation:

1. Proposing agent writes summary
2. Each agent logs insights to their own `agents/<id>/discussions/YYYY-MM-DD-topic.md`
3. Cross-agent insights extracted to shared `memory/discussions/YYYY-MM-DD-topic.md`
4. If human set objective, summary delivered to them

---

## 4. Implementation Plan — Phased

### Phase 1: Foundation (can ship independently)

1. DM triggerPrefix gating in `access-control.ts`
2. Owner override for triggerPrefix
3. Simplify responsePrefix to 🤖
4. Turn-end marker ⚡ in 1:1 chats
5. Add Sasha/Zen back to allowFrom

### Phase 2: Multi-Agent Core

6. Agent registry config schema + file resolution
7. `multi-agent/router.ts` — message routing with self-filtering
8. `multi-agent/congestion.ts` — delay algorithm
9. Intra-agent chat detection in inbound pipeline

### Phase 3: Intelligence Layer

10. `multi-agent/lifecycle.ts` — staleness + steering + closure
11. `multi-agent/budget.ts` — budget-aware mode switching
12. Convergence memory writes

### Phase 4: Cross-Gateway (future)

13. Multi-gateway agent count discovery
14. Cross-instance congestion coordination

---

## 5. Files to Create/Modify

### New files:

- `extensions/whatsapp/src/multi-agent/router.ts`
- `extensions/whatsapp/src/multi-agent/congestion.ts`
- `extensions/whatsapp/src/multi-agent/lifecycle.ts`
- `extensions/whatsapp/src/multi-agent/budget.ts`
- `extensions/whatsapp/src/multi-agent/types.ts`
- Tests for each of the above

### Modified files:

- `extensions/whatsapp/src/inbound/access-control.ts` — DM triggerPrefix
- `extensions/whatsapp/src/auto-reply/deliver-reply.ts` — turn-end marker, icon prefix
- `extensions/whatsapp/src/config-schema.ts` — multiAgent config
- `extensions/whatsapp/src/runtime-api.ts` — config types
- `extensions/whatsapp/src/group-policy.ts` — intra-agent chat detection

---

## 6. Open Questions

1. **Embedding provider for staleness detection** — use the existing gemini-embedding-001 from memory_search? Or local embeddings for speed?
2. **Agent session isolation** — spawn separate OpenClaw sessions per agent, or use the existing session with agent-id context injection?
3. **Config location** — multiAgent config in gateway config.yaml, or in the whatsapp-ultimate SKILL.md?
4. **Cross-gateway discovery** — how do agents on different gateways discover each other's count? (Phase 4, but architecture decision now)

---

## 7. Risk Assessment

| Risk                      | Impact                        | Mitigation                                           |
| ------------------------- | ----------------------------- | ---------------------------------------------------- |
| Infinite message loops    | High — runaway API cost       | Self-message filtering + max turns + hard rate limit |
| Congestion too aggressive | Med — agents never speak      | Tunable params + burn mode override                  |
| Staleness false positives | Low — premature topic changes | Conservative threshold + human can override          |
| Budget calculation wrong  | Med — overspend or waste      | Falls back to conservative mode on missing data      |
