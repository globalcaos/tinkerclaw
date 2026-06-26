/**
 * FORK (2026-04-25): types shared between the tinker-bridge tool buffer (which
 * lives inside the bundled tinker-bridge plugin) and the fork's onTurnComplete
 * hook (which lives in `src/fork/attempt-hooks.ts`). Splitting the types
 * out of `tool-buffer.ts` keeps the importing module — `attempt-hooks.ts`
 * — from pulling the runtime buffer state into its own module graph; it
 * imports the *runtime* via dynamic `import()` at drain time (so the
 * bundled tinker-bridge owns the singleton).
 */

export interface ToolBufferedToolStart {
  phase: "start";
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  purpose?: string;
  /** ms since epoch when the start was observed. */
  startedAt: number;
  /**
   * FORK (Mechanism A): the count of assistant-text chars accumulated in the
   * turn's coalesced text BEFORE this tool fired — i.e. the byte boundary at
   * which the tool interrupts the running narration. Persisted onto the
   * `tinker-bridge-tool` entry so the read path can slice the single coalesced
   * assistant-text block back into interleaved per-segment messages. Optional
   * for backward compatibility: entries persisted before this change simply
   * lack it, and the read path falls back to the legacy splice-before-text
   * reorder.
   */
  textOffset?: number;
}

export interface ToolBufferedToolResult {
  phase: "result";
  toolCallId: string;
  result: string;
  isError: boolean;
  purpose?: string;
  /** ms since epoch when the result was observed. */
  endedAt: number;
}

export type ToolBufferedEvent = ToolBufferedToolStart | ToolBufferedToolResult;
