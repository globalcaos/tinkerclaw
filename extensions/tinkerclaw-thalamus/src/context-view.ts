// A cheap, read-only look at the context of one model call (design doc section 11.2, "shadow mode").
//
// WHAT THIS IS FOR. The shadow router runs before EVERY call, so it must not copy or serialise the conversation.
// This walks the messages once, sums text lengths, and picks out the two things a read needs: what the person asked
// and what the last tool was. It never mutates what it is given, and it accepts a context of any shape: an
// unknown shape gives an empty view, never an exception.

export type ContextView = {
  /** The most recent user message, as text. */
  lastUserText: string;
  /** The first user message of the run: the task. */
  firstUserText: string;
  /** The tool whose result is the last message, or undefined. */
  lastToolName?: string;
  /** Rough token count: characters over 3.5. */
  estimatedTokens: number;
  messageCount: number;
};

const CHARS_PER_TOKEN = 3.5;
/** A read never needs more than this much of a message; keeps the view small for enormous prompts. */
const MAX_TEXT = 4000;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const b of content) {
    if (typeof b === "string") out += b;
    else if (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string") {
      out += (b as { text: string }).text;
    }
  }
  return out;
}

function lengthOf(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (typeof b === "string") n += b.length;
    else if (b && typeof b === "object") {
      const o = b as { text?: unknown; thinking?: unknown; input?: unknown; arguments?: unknown };
      if (typeof o.text === "string") n += o.text.length;
      else if (typeof o.thinking === "string") n += o.thinking.length;
      else if (o.input !== undefined || o.arguments !== undefined) n += 200;
    }
  }
  return n;
}

export function viewContext(context: unknown): ContextView {
  const empty: ContextView = {
    lastUserText: "",
    firstUserText: "",
    estimatedTokens: 0,
    messageCount: 0,
  };
  if (!context || typeof context !== "object") return empty;
  const c = context as { messages?: unknown; systemPrompt?: unknown };
  const messages = Array.isArray(c.messages) ? c.messages : [];
  let chars = typeof c.systemPrompt === "string" ? c.systemPrompt.length : 0;
  let first: string | undefined;
  let last = "";
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const msg = m as { role?: unknown; content?: unknown };
    chars += lengthOf(msg.content);
    if (msg.role === "user") {
      const t = textOf(msg.content);
      if (t) {
        first ??= t;
        last = t;
      }
    }
  }
  const tail = messages.at(-1) as { role?: unknown; toolName?: unknown } | undefined;
  const lastToolName =
    tail &&
    (tail.role === "toolResult" || tail.role === "tool") &&
    typeof tail.toolName === "string"
      ? tail.toolName
      : undefined;
  return {
    lastUserText: last.slice(0, MAX_TEXT),
    firstUserText: (first ?? "").slice(0, MAX_TEXT),
    ...(lastToolName ? { lastToolName } : {}),
    estimatedTokens: Math.round(chars / CHARS_PER_TOKEN),
    messageCount: messages.length,
  };
}

/** The channel a session key belongs to: "tinker" for the chat, `channel:<name>` for a messaging surface. */
export function sourceOfSessionKey(sessionKey: string | undefined): string {
  const parts = (sessionKey ?? "").split(":");
  const kind = parts[2];
  if (!kind || kind === "tinker" || kind === "webchat" || kind === "main") return "tinker";
  if (kind === "cron" || kind === "orchestrator" || kind === "subagent") return kind;
  return `channel:${kind}`;
}
