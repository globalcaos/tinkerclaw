import { getToolResultDigester, type CallRouteMeta } from "../../infra/thalamus-call-router.js";

type ToolLike = {
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: the agent tool's own signature is passed through untouched
  execute?: (...args: any[]) => any;
};

type TextBlock = { type: "text"; text: string };
const isTextResult = (r: unknown): r is { content: TextBlock[] } =>
  !!r &&
  typeof r === "object" &&
  Array.isArray((r as { content?: unknown }).content) &&
  (r as { content: unknown[] }).content.length > 0 &&
  (r as { content: Array<{ type?: unknown }> }).content.every(
    (b) => b?.type === "text" && typeof (b as TextBlock).text === "string",
  );

/**
 * FORK 2026-09-30 (THALAMUS v4, design doc section 6.2, unit D3): let a registered digester condense a long text
 * tool result before it enters the thread.
 *
 * INERT WHEN OFF. With no digester registered when the run is wired, this returns the very array it was given: no
 * wrapper, no copy, no extra frame on any tool call. With one registered, each tool's `execute` runs as before and
 * its result is offered, when it is text only, to the digester; anything but a non-empty string back leaves the
 * result exactly as the tool returned it, and a throw or rejection is swallowed.
 */
export function wrapToolsWithDigest<T extends ToolLike>(tools: T[], meta: CallRouteMeta): T[] {
  if (!getToolResultDigester()) return tools;
  return tools.map((tool) => {
    const execute = tool.execute;
    if (typeof execute !== "function") return tool;
    const wrapped = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
      execute: async (...args: unknown[]) => {
        const result = await execute.apply(tool, args);
        const digester = getToolResultDigester();
        if (!digester || !isTextResult(result)) return result;
        const signal = args[2] as AbortSignal | undefined;
        if (signal?.aborted) return result;
        try {
          const text = result.content.map((b) => b.text).join("\n");
          const replacement = await digester.digest({
            meta,
            toolName: tool.name,
            toolCallId: String(args[0] ?? ""),
            params: args[1],
            text,
          });
          if (typeof replacement !== "string" || replacement.length === 0) return result;
          return { ...result, content: [{ type: "text", text: replacement }] };
        } catch {
          return result;
        }
      },
    });
    return wrapped as T;
  });
}
