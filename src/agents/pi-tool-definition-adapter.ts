import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { recordAlgorithmOutcome } from "../infra/algorithm-metrics.js";
import { declareInstrument, noteInstrumentFired } from "../infra/instrument-liveness.js";
import { logDebug, logError } from "../logger.js";
import { redactToolDetail } from "../logging/redact.js";
import { isPlainObject } from "../utils.js";
import { sanitizeForConsole } from "./console-sanitize.js";
import type { ClientToolDefinition } from "./embedded-agent-runner/run/params.js";
import type { HookContext } from "./pi-tools.before-tool-call.js";
import {
  buildBlockedToolResult,
  isToolWrappedWithBeforeToolCallHook,
  isBeforeToolCallBlockedError,
  runBeforeToolCallHook,
} from "./pi-tools.before-tool-call.js";
import { normalizeToolName } from "./tool-policy.js";
import { jsonResult, payloadTextResult } from "./tools/common.js";

// FORK 2026-07-28 — TOOL-OUTPUT instrument. Tool results are the largest uninstrumented
// consumer of context on this deployment: 20,916,377 bytes of Bash output across 890 sessions,
// addressed by nothing. Every compaction post-mortem so far argued about prompt size while the
// real pressure arrived through THIS seam, unmeasured. Declared at module scope, separately
// from the firing below, so a seam that stops being the path tools take shows up as
// `neverFired` rather than as silence. NOTE the scope: this covers the EMBEDDED tool seam
// (`toToolDefinitions`); the client-tool adapter in this same file delegates execution to the
// client and produces no result bytes here, so it is deliberately not counted.
declareInstrument({
  id: "tools:result-bytes",
  kind: "producer",
  description: "per-tool-call result bytes at the embedded tool seam",
});

// Declared and deliberately NEVER fired. An undeclared zero is indistinguishable from success —
// precisely the defect class this registry exists to catch — so the unbuilt automatic path is
// registered as a known, explained silence instead of an absence nobody notices.
declareInstrument({
  id: "compression:headroom-mcp",
  kind: "integration",
  description: "headroom MCP compression of oversized tool results at the tail seam",
  conditional:
    "no consumer wired yet — headroom is registered as an MCP server for on-demand model use only; the automatic path is a separate, unbuilt piece of work",
});

type AnyAgentTool = AgentTool;

type ToolExecuteArgsCurrent = [
  string,
  unknown,
  AbortSignal | undefined,
  AgentToolUpdateCallback<unknown> | undefined,
  unknown,
];
type ToolExecuteArgsLegacy = [
  string,
  unknown,
  AgentToolUpdateCallback<unknown> | undefined,
  unknown,
  AbortSignal | undefined,
];
type ToolExecuteArgs = ToolDefinition["execute"] extends (...args: infer P) => unknown
  ? P
  : ToolExecuteArgsCurrent;
type ToolExecuteArgsAny = ToolExecuteArgs | ToolExecuteArgsLegacy | ToolExecuteArgsCurrent;
const TOOL_ERROR_PARAM_PREVIEW_MAX_CHARS = 600;

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null && "aborted" in value;
}

function isLegacyToolExecuteArgs(args: ToolExecuteArgsAny): args is ToolExecuteArgsLegacy {
  const third = args[2];
  const fifth = args[4];
  if (typeof third === "function") {
    return true;
  }
  return isAbortSignal(fifth);
}

function describeToolExecutionError(err: unknown): {
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    const message = err.message?.trim() ? err.message : String(err);
    return { message, stack: err.stack };
  }
  return { message: String(err) };
}

function serializeToolParams(value: unknown): string {
  if (value === undefined) {
    return "<undefined>";
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === "string") {
      return serialized;
    }
  } catch {
    // Fall through to String(value).
  }
  if (typeof value === "function") {
    return value.name ? `[Function ${value.name}]` : "[Function anonymous]";
  }
  if (typeof value === "symbol") {
    return value.description ? `Symbol(${value.description})` : "Symbol()";
  }
  return Object.prototype.toString.call(value);
}

function formatToolParamPreview(label: string, value: unknown): string {
  const serialized = serializeToolParams(value);
  const redacted = redactToolDetail(serialized);
  const preview = sanitizeForConsole(redacted, TOOL_ERROR_PARAM_PREVIEW_MAX_CHARS) ?? "<empty>";
  return `${label}=${preview}`;
}

function describeToolFailureInputs(params: {
  rawParams: unknown;
  effectiveParams: unknown;
}): string {
  const parts = [formatToolParamPreview("raw_params", params.rawParams)];
  const rawSerialized = serializeToolParams(params.rawParams);
  const effectiveSerialized = serializeToolParams(params.effectiveParams);
  if (effectiveSerialized !== rawSerialized) {
    parts.push(formatToolParamPreview("effective_params", params.effectiveParams));
  }
  return parts.join(" ");
}

function normalizeToolExecutionResult(params: {
  toolName: string;
  result: unknown;
}): AgentToolResult<unknown> {
  const { toolName, result } = params;
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      return result as AgentToolResult<unknown>;
    }
    logDebug(`tools: ${toolName} returned non-standard result (missing content[]); coercing`);
    const details = "details" in record ? record.details : record;
    const safeDetails = details ?? { status: "ok", tool: toolName };
    return payloadTextResult(safeDetails);
  }
  const safeDetails = result ?? { status: "ok", tool: toolName };
  return payloadTextResult(safeDetails);
}

/**
 * Bytes this tool result contributes to the model's context. MEASURED, never estimated.
 *
 * Computed from the ALREADY-NORMALIZED result rather than by serializing the raw one a second
 * time. `normalizeToolExecutionResult` has just produced the exact `content[]` that goes to the
 * model — either the tool's own text, or the single `JSON.stringify` inside `payloadTextResult`
 * — so reading those lengths walks strings we already hold instead of re-stringifying a result
 * that can be megabytes of Bash output. `details` is deliberately NOT counted: it feeds logs
 * and the UI, not the context window.
 *
 * Text is counted in UTF-8 bytes; `ImageContent.data` is already base64, where one character is
 * one wire byte. An unrecognized shape returns 0 rather than a guess.
 */
export function measureToolResultBytes(result: AgentToolResult<unknown> | undefined): number {
  const content: unknown = result?.content;
  if (!Array.isArray(content)) {
    return 0;
  }
  let bytes = 0;
  for (const part of content as unknown[]) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const record = part as { text?: unknown; data?: unknown };
    if (typeof record.text === "string") {
      bytes += Buffer.byteLength(record.text, "utf8");
    } else if (typeof record.data === "string") {
      bytes += record.data.length;
    }
  }
  return bytes;
}

/**
 * Fire the TOOL-OUTPUT instrument for one completed tool call.
 *
 * Swallows everything. `noteInstrumentFired` and `recordAlgorithmOutcome` already swallow their
 * own errors, but the measurement above touches a foreign object, so the whole block is guarded:
 * telemetry must never disturb the path it observes, and must never turn a successful tool call
 * into a tool error.
 */
function noteToolResultBytes(params: {
  toolName: string;
  result: AgentToolResult<unknown>;
  durationMs: number;
}): void {
  try {
    const bytesOut = measureToolResultBytes(params.result);
    noteInstrumentFired("tools:result-bytes", `${params.toolName} ${bytesOut}B`);
    recordAlgorithmOutcome({
      algorithm: "tool-output",
      variant: params.toolName,
      outcome: "observed",
      metrics: { bytesOut, durationMs: params.durationMs },
      provenance: { bytesOut: "local-measured", durationMs: "local-measured" },
    });
  } catch {
    /* telemetry must never disturb the path it observes */
  }
}

function buildToolExecutionErrorResult(params: {
  toolName: string;
  message: string;
}): AgentToolResult<unknown> {
  return jsonResult({
    status: "error",
    tool: params.toolName,
    error: params.message,
  });
}

function splitToolExecuteArgs(args: ToolExecuteArgsAny): {
  toolCallId: string;
  params: unknown;
  onUpdate: AgentToolUpdateCallback<unknown> | undefined;
  signal: AbortSignal | undefined;
} {
  if (isLegacyToolExecuteArgs(args)) {
    const [toolCallId, params, onUpdate, _ctx, signal] = args;
    return {
      toolCallId,
      params,
      onUpdate,
      signal,
    };
  }
  const [toolCallId, params, signal, onUpdate] = args;
  return {
    toolCallId,
    params,
    onUpdate,
    signal,
  };
}

export const CLIENT_TOOL_NAME_CONFLICT_PREFIX = "client tool name conflict:";

export function findClientToolNameConflicts(params: {
  tools: ClientToolDefinition[];
  existingToolNames?: Iterable<string>;
}): string[] {
  const existingNormalized = new Set<string>();
  for (const name of params.existingToolNames ?? []) {
    const trimmed = name.trim();
    if (trimmed) {
      existingNormalized.add(normalizeToolName(trimmed));
    }
  }

  const conflicts = new Set<string>();
  const seenClientNames = new Map<string, string>();
  for (const tool of params.tools) {
    const rawName = (tool.function?.name ?? "").trim();
    if (!rawName) {
      continue;
    }
    const normalizedName = normalizeToolName(rawName);
    if (existingNormalized.has(normalizedName)) {
      conflicts.add(rawName);
    }
    const priorClientName = seenClientNames.get(normalizedName);
    if (priorClientName) {
      conflicts.add(priorClientName);
      conflicts.add(rawName);
      continue;
    }
    seenClientNames.set(normalizedName, rawName);
  }
  return Array.from(conflicts);
}

export function createClientToolNameConflictError(conflicts: string[]): Error {
  return new Error(`${CLIENT_TOOL_NAME_CONFLICT_PREFIX} ${conflicts.join(", ")}`);
}

export function isClientToolNameConflictError(err: unknown): err is Error {
  return err instanceof Error && err.message.startsWith(CLIENT_TOOL_NAME_CONFLICT_PREFIX);
}

export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => {
    const name = tool.name || "tool";
    const normalizedName = normalizeToolName(name);
    const beforeHookWrapped = isToolWrappedWithBeforeToolCallHook(tool);
    return {
      name,
      label: tool.label ?? name,
      description: tool.description ?? "",
      parameters: tool.parameters,
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { toolCallId, params, onUpdate, signal } = splitToolExecuteArgs(args);
        let executeParams = params;
        try {
          if (!beforeHookWrapped) {
            const hookOutcome = await runBeforeToolCallHook({
              toolName: name,
              params,
              toolCallId,
            });
            if (hookOutcome.blocked) {
              if (hookOutcome.kind === "veto") {
                return buildBlockedToolResult({
                  reason: hookOutcome.reason,
                  deniedReason: hookOutcome.deniedReason,
                });
              }
              throw new Error(hookOutcome.reason);
            }
            executeParams = hookOutcome.params;
          }
          const toolStartedAtMs = Date.now();
          const rawResult = await tool.execute(toolCallId, executeParams, signal, onUpdate);
          const durationMs = Date.now() - toolStartedAtMs;
          const result = normalizeToolExecutionResult({
            toolName: normalizedName,
            result: rawResult,
          });
          // Fired HERE — on the path where the work actually happened, with the result in hand,
          // so the size is a FACT rather than an estimate, and never behind the same condition
          // that decided whether anything was registered. Every embedded tool call passes
          // through this site. The error path below is deliberately NOT counted: it emits a
          // small JSON envelope, not tool output, and mixing the two would blur the number.
          noteToolResultBytes({
            toolName: normalizedName,
            result,
            durationMs,
          });
          return result;
        } catch (err) {
          if (signal?.aborted) {
            throw err;
          }
          const name =
            err && typeof err === "object" && "name" in err
              ? String((err as { name?: unknown }).name)
              : "";
          if (name === "AbortError") {
            throw err;
          }
          if (isBeforeToolCallBlockedError(err)) {
            logDebug(`tools: ${normalizedName} blocked by before_tool_call: ${err.reason}`);
            return buildBlockedToolResult({
              reason: err.reason,
            });
          }
          const described = describeToolExecutionError(err);
          if (described.stack && described.stack !== described.message) {
            logDebug(`tools: ${normalizedName} failed stack:\n${described.stack}`);
          }
          const inputPreview = describeToolFailureInputs({
            rawParams: params,
            effectiveParams: executeParams,
          });
          logError(`[tools] ${normalizedName} failed: ${described.message} ${inputPreview}`);

          return buildToolExecutionErrorResult({
            toolName: normalizedName,
            message: described.message,
          });
        }
      },
    } satisfies ToolDefinition;
  });
}

/**
 * Coerce tool-call params into a plain object.
 *
 * Some providers (e.g. Gemini) stream tool-call arguments as incremental
 * string deltas.  By the time the framework invokes the tool's `execute`
 * callback the accumulated value may still be a JSON **string** rather than
 * a parsed object.  `isPlainObject()` returns `false` for strings, which
 * caused the params to be silently replaced with `{}`.
 *
 * This helper tries `JSON.parse` when the value is a string and falls back
 * to an empty object only when parsing genuinely fails.
 */
function coerceParamsRecord(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isPlainObject(parsed)) {
          return parsed;
        }
      } catch {
        // not valid JSON – fall through to empty object
      }
    }
  }
  return {};
}

// Convert client tools (OpenResponses hosted tools) to ToolDefinition format
// These tools are intercepted to return a "pending" result instead of executing
export function toClientToolDefinitions(
  tools: ClientToolDefinition[],
  onClientToolCall?: (toolName: string, params: Record<string, unknown>) => void,
  hookContext?: HookContext,
): ToolDefinition[] {
  return tools.map((tool) => {
    const func = tool.function;
    return {
      name: func.name,
      label: func.name,
      description: func.description ?? "",
      parameters: func.parameters as ToolDefinition["parameters"],
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { toolCallId, params } = splitToolExecuteArgs(args);
        const initialParamsRecord = coerceParamsRecord(params);
        const outcome = await runBeforeToolCallHook({
          toolName: func.name,
          params: initialParamsRecord,
          toolCallId,
          ctx: hookContext,
        });
        if (outcome.blocked) {
          if (outcome.kind === "veto") {
            return buildBlockedToolResult({
              reason: outcome.reason,
              deniedReason: outcome.deniedReason,
            });
          }
          throw new Error(outcome.reason);
        }
        const adjustedParams = outcome.params;
        const paramsRecord = coerceParamsRecord(adjustedParams);
        // Notify handler that a client tool was called
        if (onClientToolCall) {
          onClientToolCall(func.name, paramsRecord);
        }
        // Return a pending result - the client will execute this tool
        return jsonResult({
          status: "pending",
          tool: func.name,
          message: "Tool execution delegated to client",
        });
      },
    } satisfies ToolDefinition;
  });
}
