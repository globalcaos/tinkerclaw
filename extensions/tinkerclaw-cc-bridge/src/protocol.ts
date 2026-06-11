/**
 * FORK: tinkerclaw-cc-bridge — stream-json protocol definitions.
 *
 * Claude Code's `--input-format stream-json --output-format stream-json`
 * mode is officially supported but the stdin/stdout message schemas are
 * NOT publicly documented (issue anthropics/claude-code#24594, closed
 * "not planned"). These shapes are reverse-engineered from:
 *   - Observed `claude -p --output-format stream-json` runs
 *   - The @anthropic-ai/claude-agent-sdk TS source
 *   - Kirie (github.com/khaterdev/kirie) which uses the SDK internally
 *
 * If a claude version bumps the schema, tweaks land here and only here.
 */

// ---------- stdin (what we write, one JSON per line) ----------

/**
 * One user turn. `message.content` is either a plain string or the full
 * content-block array (for multi-modal turns).
 */
export interface CcStreamStdinUserMessage {
  type: "user";
  message: {
    role: "user";
    content: string | CcContentBlock[];
  };
  /** Optional — attaches this turn to a specific session when resuming. */
  session_id?: string;
  /** Optional parent_tool_use_id for tool-result turns (not used in v0.1). */
  parent_tool_use_id?: string | null;
}

export type CcStreamStdinLine = CcStreamStdinUserMessage;

// ---------- stdout (what claude emits, one JSON per line) ----------

/** Initial metadata line when claude boots and again on session resume. */
export interface CcStreamStdoutInit {
  type: "system";
  subtype: "init";
  session_id: string;
  model?: string;
  cwd?: string;
  tools?: string[];
}

export interface CcStreamStdoutAssistantMessage {
  type: "assistant";
  message: {
    id?: string;
    role: "assistant";
    content: CcContentBlock[];
    model?: string;
    stop_reason?: string | null;
    usage?: CcUsage;
  };
  session_id?: string;
}

export interface CcStreamStdoutUserMessage {
  type: "user";
  message: {
    role: "user";
    content: CcContentBlock[];
  };
  session_id?: string;
}

export interface CcStreamStdoutResult {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution" | "error";
  session_id: string;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  num_turns?: number;
  result?: string;
  usage?: CcUsage;
  total_cost_usd?: number;
}

export interface CcStreamStdoutStreamEvent {
  type: "stream_event";
  uuid?: string;
  session_id?: string;
  /** Inner raw Anthropic API event (content_block_delta etc.). */
  event?: {
    type: string;
    delta?: { type?: string; text?: string; thinking?: string; [key: string]: unknown };
    [key: string]: unknown;
  };
}

export type CcStreamStdoutLine =
  | CcStreamStdoutInit
  | CcStreamStdoutAssistantMessage
  | CcStreamStdoutUserMessage
  | CcStreamStdoutResult
  | CcStreamStdoutStreamEvent
  | { type: string; [key: string]: unknown }; // forward-compat

// ---------- shared content shapes ----------

export type CcContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | CcContentBlock[];
      is_error?: boolean;
    }
  | { type: "server_tool_use"; id: string; name: string; input: unknown }
  | {
      type: "web_search_tool_result";
      tool_use_id: string;
      content: string | CcContentBlock[];
      is_error?: boolean;
    }
  | { type: "redacted_thinking"; data?: string };

export interface CcUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export function parseStreamJsonLine(line: string): CcStreamStdoutLine | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as CcStreamStdoutLine;
  } catch {
    return null;
  }
}

export function serializeStdinLine(msg: CcStreamStdinLine): string {
  return JSON.stringify(msg) + "\n";
}
