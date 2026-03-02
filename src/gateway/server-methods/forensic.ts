/* oxlint-disable typescript/no-explicit-any -- forensic introspection uses dynamic JSON structures */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE_DIR } from "../../config/paths.js";
import {
  getLatestDump,
  getLatestRun,
  getDumpByIndex,
  getRunForSession,
  getDumpForSession,
  getDumpByIndexForSession,
} from "../../forensic/dump-writer.js";
import type { ForensicRun } from "../../forensic/dump-writer.js";
import { isForensicMode, setForensicMode } from "../../forensic/mode.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const DUMP_DIR = path.join(STATE_DIR, "forensic-dumps");

// ─── Model pricing (per 1M tokens, USD) ───
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4": { input: 15, output: 75 },
  "claude-opus-4-5": { input: 15, output: 75 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "gemini-3-pro": { input: 1.25, output: 5 },
  "gemini-3.1-pro": { input: 1.25, output: 5 },
  "gemini-2-flash": { input: 0.1, output: 0.4 },
  "gemini-2-flash-lite": { input: 0.02, output: 0.08 },
  default: { input: 3, output: 15 },
};

function getModelPricing(model: string): { input: number; output: number } {
  const norm = (model ?? "").toLowerCase();
  for (const [key, p] of Object.entries(MODEL_PRICING)) {
    if (key !== "default" && norm.includes(key)) {
      return p;
    }
  }
  return MODEL_PRICING.default;
}

// ─── Anthropic API key (lazy, cached) ───
let _cachedApiKey: string | null = null;
function getAnthropicApiKey(): string | null {
  if (_cachedApiKey) {
    return _cachedApiKey;
  }
  try {
    const authPath = path.join(
      os.homedir(),
      ".openclaw",
      "agents",
      "main",
      "agent",
      "auth-profiles.json",
    );
    const data = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    const profile = data?.profiles?.["anthropic:api"];
    if (profile?.key) {
      _cachedApiKey = profile.key;
      return _cachedApiKey;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ─── Extract text from dump (promise-based wrapper around extractDetail) ───
function extractText(dump: any, component: string, key: string | undefined): string | null {
  let result: string | null = null;
  const fakeRespond: RespondFn = (ok, payload) => {
    if (ok && payload) {
      result = (payload as any).text ?? JSON.stringify(payload, null, 2);
    }
  };
  extractDetail(dump, component, key, fakeRespond);
  return result;
}

// ─── Call Anthropic Messages API for summarization ───
async function summarizeText(text: string): Promise<string> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    throw new Error("No Anthropic API key found in auth-profiles.json");
  }

  // Truncate to ~30k chars to stay within haiku limits
  const truncated = text.length > 30_000 ? text.slice(0, 30_000) + "\n…[truncated]" : text;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system:
        "Summarize the following content in 2-3 concise sentences. Focus on what it does and why it matters.",
      messages: [{ role: "user", content: truncated }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as any;
  const textBlock = (data.content ?? []).find((b: any) => b.type === "text");
  return textBlock?.text ?? "(no summary returned)";
}

function safeDumpFilename(filename: unknown): string | null {
  if (typeof filename !== "string") {
    return null;
  }
  if (filename.includes("/") || filename.includes("..") || !filename.endsWith(".json")) {
    return null;
  }
  return filename;
}

// ─── Shared detail extraction (works on any dump object) ───
function extractDetail(dump: any, component: string, key: string | undefined, respond: Function) {
  if (component === "system_prompt") {
    if (key) {
      const section = (dump.system_prompt?.sections ?? []).find((s: any) => s.name === key);
      if (!section) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Section "${key}" not found` });
        return;
      }
      respond(true, { name: section.name, text: section.text, chars: section.chars });
    } else {
      respond(true, {
        text: dump.system_prompt?.full_text ?? "",
        chars: dump.system_prompt?.chars ?? 0,
      });
    }
  } else if (component === "tools") {
    if (key) {
      const defs = dump.tools?.definitions ?? [];
      const tool = defs.find((t: any) => t.name === key);
      if (!tool) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Tool "${key}" not found` });
        return;
      }
      const text = tool.schema_text || JSON.stringify(tool, null, 2);
      respond(true, { name: tool.name, text, chars: tool.schema_chars ?? 0 });
    } else {
      respond(true, {
        definitions: dump.tools?.definitions ?? [],
        count: dump.tools?.count ?? 0,
        chars: dump.tools?.chars ?? 0,
      });
    }
  } else if (component === "conversation_history") {
    const msgs = dump.conversation_history?.messages ?? [];
    if (key) {
      // key may be a numeric index or a role name
      const idx = parseInt(key, 10);
      if (!isNaN(idx) && idx >= 0 && idx < msgs.length) {
        const m = msgs[idx];
        const content = Array.isArray(m.content)
          ? m.content
              .map((b: any) => {
                if (b.type === "text") {
                  return b.text ?? "";
                }
                if (b.type === "tool_use") {
                  return `[tool_use: ${b.name ?? "?"}]\n${JSON.stringify(b.input ?? {}, null, 2)}`;
                }
                if (b.type === "tool_result") {
                  return `[tool_result: ${b.tool_use_id ?? "?"}]\n${typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "", null, 2)}`;
                }
                if (b.type === "thinking") {
                  return `[thinking]\n${b.thinking ?? b.text ?? ""}`;
                }
                return JSON.stringify(b, null, 2);
              })
              .join("\n\n")
          : typeof m.content === "string"
            ? m.content
            : JSON.stringify(m.content ?? "", null, 2);
        const chars = JSON.stringify(m).length;
        respond(true, { name: `${m.role ?? "?"}[${idx}]`, text: content, chars });
        return;
      }
      // Treat as role name
      const roleMsgs = msgs.filter((m: any) => m.role === key);
      if (roleMsgs.length === 0) {
        respond(false, undefined, { code: "NOT_FOUND", message: `No messages for role "${key}"` });
        return;
      }
      const parts = roleMsgs.map((m: any, i: number) => {
        const content = Array.isArray(m.content)
          ? m.content
              .map((b: any) => {
                if (b.type === "text") {
                  return b.text ?? "";
                }
                if (b.type === "tool_use") {
                  return `[tool_use: ${b.name ?? "?"}]\n${JSON.stringify(b.input ?? {}, null, 2)}`;
                }
                if (b.type === "tool_result") {
                  return `[tool_result: ${b.tool_use_id ?? "?"}]\n${typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "", null, 2)}`;
                }
                return JSON.stringify(b, null, 2);
              })
              .join("\n")
          : typeof m.content === "string"
            ? m.content
            : JSON.stringify(m.content ?? "", null, 2);
        return `── message ${i + 1} ──\n${content}`;
      });
      const text = parts.join("\n\n");
      const chars = dump.conversation_history?.by_role?.[key]?.chars ?? text.length;
      respond(true, { name: key, text, chars });
    } else {
      const byRole = dump.conversation_history?.by_role ?? {};
      const first = msgs[0] ?? null;
      const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      const summary: any = {
        message_count: msgs.length,
        chars: dump.conversation_history?.chars ?? 0,
        by_role: byRole,
      };
      if (first) {
        const fc = Array.isArray(first.content) ? first.content : [];
        const ft = fc.find((b: any) => b.type === "text");
        summary.first_message = { role: first.role, preview: (ft?.text ?? "").slice(0, 200) };
      }
      if (last) {
        const lc = Array.isArray(last.content) ? last.content : [];
        const lt = lc.find((b: any) => b.type === "text");
        summary.last_message = { role: last.role, preview: (lt?.text ?? "").slice(0, 200) };
      }
      respond(true, summary);
    }
  } else if (component === "current_prompt") {
    respond(true, {
      text: dump.current_prompt?.text ?? "",
      chars: dump.current_prompt?.chars ?? 0,
    });
  } else {
    respond(false, undefined, {
      code: "INVALID_COMPONENT",
      message: `Unknown component "${component}"`,
    });
  }
}

// ─── Build slim version (strips large text fields for treemap layout) ───
function toSlim(dump: any): any {
  return {
    meta: dump.meta,
    system_prompt: {
      chars: dump.system_prompt?.chars ?? 0,
      sections: (dump.system_prompt?.sections ?? []).map((s: any) => ({
        name: s.name,
        chars: s.chars,
      })),
    },
    tools: {
      count: dump.tools?.count ?? 0,
      chars: dump.tools?.chars ?? 0,
      definitions: (dump.tools?.definitions ?? []).map((d: any) => ({
        name: d.name,
        schema_chars: d.schema_chars,
      })),
    },
    conversation_history: {
      message_count: dump.conversation_history?.message_count ?? 0,
      chars: dump.conversation_history?.chars ?? 0,
      by_role: dump.conversation_history?.by_role ?? {},
      messages_slim: (dump.conversation_history?.messages ?? []).map((m: any, i: number) => {
        const content = Array.isArray(m.content) ? m.content : [];
        const blocks = content.map((b: any) => b.type ?? "unknown");
        const chars = JSON.stringify(m).length;
        return { index: i, role: m.role ?? "unknown", blocks, chars };
      }),
    },
    current_prompt: {
      chars: dump.current_prompt?.chars ?? 0,
    },
    totals: dump.totals ?? {},
  };
}

// ─── Build slim run overview (for L0 treemap) ───
function toSlimRun(run: ForensicRun): any {
  const firstTs = run.dumps[0]?.meta?.timestamp
    ? new Date(run.dumps[0].meta.timestamp).getTime()
    : 0;
  return {
    runId: run.runId,
    callCount: run.dumps.length,
    totalChars: run.dumps.reduce((s, d) => s + (d.totals?.chars ?? 0), 0),
    estimatedTokens: run.dumps.reduce((s, d) => s + (d.totals?.estimated_tokens ?? 0), 0),
    startedAt: run.startedAt,
    calls: run.dumps.map((d, i) => {
      const ts = d.meta?.timestamp ? new Date(d.meta.timestamp).getTime() : 0;
      return {
        index: i,
        model: d.meta?.model ?? "",
        provider: d.meta?.provider ?? "",
        timestamp: d.meta?.timestamp ?? "",
        totalChars: d.totals?.chars ?? 0,
        estimatedTokens: d.totals?.estimated_tokens ?? 0,
        deltaMsFromFirst: ts && firstTs ? ts - firstTs : 0,
      };
    }),
  };
}

// ─── Build slim response data for treemap (groups content blocks by type) ───
function buildResponseSlim(content: any[]): any {
  const categories: { key: string; label: string; chars: number; count: number }[] = [];
  const buckets: Record<string, { label: string; chars: number; count: number }> = {};

  for (const block of content) {
    const type = block?.type ?? "unknown";
    let chars = 0;
    if (type === "text") {
      chars = (block.text ?? "").length;
    } else if (type === "thinking") {
      chars = (block.thinking ?? block.text ?? "").length;
    } else if (type === "tool_use") {
      const input = JSON.stringify(block.input ?? {}, null, 2);
      chars = (block.name ?? "").length + input.length;
    } else if (type === "tool_result") {
      const rt =
        typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content ?? "", null, 2);
      chars = rt.length;
    } else if (type === "redacted_thinking") {
      // Redacted thinking blocks contain large base64 data blobs — skip entirely.
      // The actual thinking content was captured pre-redaction in dumps when available.
      continue;
    } else {
      chars = JSON.stringify(block).length;
    }

    const label =
      type === "tool_use" ? "tool calls" : type === "tool_result" ? "tool results" : type;
    if (!buckets[type]) {
      buckets[type] = { label, chars: 0, count: 0 };
    }
    buckets[type].chars += chars;
    buckets[type].count++;
  }

  for (const [key, val] of Object.entries(buckets)) {
    categories.push({ key, ...val });
  }

  const totalChars = categories.reduce((s, c) => s + c.chars, 0);
  return { totalChars, categories };
}

export const forensicHandlers: GatewayRequestHandlers = {
  "forensic.setMode": async ({ params, respond }) => {
    const enabled = params?.enabled === true;
    setForensicMode(enabled);
    respond(true, { enabled: isForensicMode() });
  },
  "forensic.getMode": async ({ respond }) => {
    respond(true, { enabled: isForensicMode() });
  },

  // ─── Live (in-memory) endpoints — no disk I/O ───
  "forensic.getLive": async ({ params, respond }) => {
    const sk = typeof params?.sessionKey === "string" ? params.sessionKey : undefined;
    const dump = sk ? getDumpForSession(sk) : getLatestDump();
    if (!dump) {
      respond(false, undefined, {
        code: "NO_DATA",
        message: "No context captured yet. Send a message first.",
      });
      return;
    }
    const run = sk ? getRunForSession(sk) : getLatestRun();
    const result = toSlim(dump);
    if (run) {
      result._run = toSlimRun(run);
    }
    // Include pricing so the client can compute per-block costs
    const model = dump.meta?.model ?? "";
    result._pricing = getModelPricing(model);
    respond(true, result);
  },

  "forensic.getLiveDetail": async ({ params, respond }) => {
    const sk = typeof params?.sessionKey === "string" ? params.sessionKey : undefined;
    const callIndex = typeof params?.callIndex === "number" ? params.callIndex : undefined;
    const dump =
      callIndex !== undefined
        ? sk
          ? getDumpByIndexForSession(sk, callIndex)
          : getDumpByIndex(callIndex)
        : sk
          ? getDumpForSession(sk)
          : getLatestDump();
    if (!dump) {
      respond(false, undefined, {
        code: "NO_DATA",
        message:
          callIndex !== undefined
            ? `No dump at call index ${callIndex}.`
            : "No context captured yet.",
      });
      return;
    }
    extractDetail(dump, params?.component as string, params?.key as string | undefined, respond);
  },

  // ─── Disk-based endpoints (for forensic mode archival browsing) ───
  "forensic.listDumps": async ({ respond }) => {
    try {
      if (!fs.existsSync(DUMP_DIR)) {
        respond(true, { dumps: [] });
        return;
      }
      const files = fs
        .readdirSync(DUMP_DIR)
        .filter((f) => f.endsWith(".json"))
        .toSorted()
        .toReversed()
        .slice(0, 20);

      const dumps = files.map((f) => {
        const base = f.replace(/\.json$/, "");
        const parts = base.split("_");
        const timestamp = parts[0] ?? "";
        const known = new Set(["anthropic", "google", "openai", "ollama"]);
        let providerIdx = -1;
        for (let i = parts.length - 1; i >= 1; i--) {
          if (known.has(parts[i])) {
            providerIdx = i;
            break;
          }
        }
        const provider = providerIdx >= 0 ? parts[providerIdx] : "";
        const model = providerIdx >= 0 ? parts.slice(providerIdx + 1).join("_") : "";
        const sessionKey = providerIdx >= 2 ? parts.slice(1, providerIdx).join("_") : "";
        return { filename: f, timestamp, sessionKey, provider, model };
      });

      respond(true, { dumps });
    } catch (e: any) {
      respond(false, undefined, { code: "READ_ERROR", message: e.message });
    }
  },

  "forensic.getDump": async ({ params, respond }) => {
    const filename = safeDumpFilename(params?.filename);
    if (!filename) {
      respond(false, undefined, { code: "INVALID_FILENAME", message: "Invalid filename" });
      return;
    }
    try {
      const raw = fs.readFileSync(path.join(DUMP_DIR, filename), "utf-8");
      const dump = JSON.parse(raw);
      respond(true, toSlim(dump));
    } catch (e: any) {
      respond(false, undefined, { code: "READ_ERROR", message: e.message });
    }
  },

  "forensic.getDumpDetail": async ({ params, respond }) => {
    const filename = safeDumpFilename(params?.filename);
    if (!filename) {
      respond(false, undefined, { code: "INVALID_FILENAME", message: "Invalid filename" });
      return;
    }
    try {
      const raw = fs.readFileSync(path.join(DUMP_DIR, filename), "utf-8");
      const dump = JSON.parse(raw);
      extractDetail(dump, params?.component as string, params?.key as string | undefined, respond);
    } catch (e: any) {
      respond(false, undefined, { code: "READ_ERROR", message: e.message });
    }
  },

  // ─── Get a specific call's slim dump ───
  "forensic.getCallLive": async ({ params, respond }) => {
    const sk = typeof params?.sessionKey === "string" ? params.sessionKey : undefined;
    const index = typeof params?.index === "number" ? params.index : -1;
    const dump = sk ? getDumpByIndexForSession(sk, index) : getDumpByIndex(index);
    if (!dump) {
      respond(false, undefined, { code: "NOT_FOUND", message: `No dump at call index ${index}.` });
      return;
    }
    const result = toSlim(dump);
    result._pricing = getModelPricing(dump.meta?.model ?? "");
    respond(true, result);
  },

  // ─── Summarize a context component via Anthropic Haiku ───
  "forensic.summarize": async ({ params, respond }) => {
    const sk = typeof params?.sessionKey === "string" ? params.sessionKey : undefined;
    const callIndex = typeof params?.callIndex === "number" ? params.callIndex : undefined;
    const dump =
      callIndex !== undefined
        ? sk
          ? getDumpByIndexForSession(sk, callIndex)
          : getDumpByIndex(callIndex)
        : sk
          ? getDumpForSession(sk)
          : getLatestDump();
    if (!dump) {
      respond(false, undefined, { code: "NO_DATA", message: "No context captured yet." });
      return;
    }
    const component = params?.component as string;
    const key = params?.key as string | undefined;
    const text = extractText(dump, component, key);
    if (text == null) {
      respond(false, undefined, {
        code: "NOT_FOUND",
        message: `Could not extract text for ${component}/${key ?? ""}`,
      });
      return;
    }
    try {
      const summary = await summarizeText(text);
      respond(true, { summary });
    } catch (e: any) {
      respond(false, undefined, { code: "SUMMARIZE_ERROR", message: e.message });
    }
  },

  // ─── Response treemap: per-call response data ───
  "forensic.getResponseLive": async ({ params, respond }) => {
    const sk = typeof params?.sessionKey === "string" ? params.sessionKey : undefined;
    const run = sk ? getRunForSession(sk) : getLatestRun();
    if (!run || !run.responses?.length) {
      respond(false, undefined, { code: "NO_DATA", message: "No response data yet." });
      return;
    }
    const calls = run.responses.map((content: any[], i: number) => {
      const slim = buildResponseSlim(content);
      const callModel = run.dumps?.[i]?.meta?.model ?? "";
      return { index: i, model: callModel, ...slim };
    });
    // Use the LAST dump's model (most recent — reflects failover if any)
    const model = run.dumps?.at(-1)?.meta?.model ?? run.dumps?.[0]?.meta?.model ?? "";
    respond(true, {
      runId: run.runId,
      callCount: calls.length,
      totalChars: calls.reduce((s: number, c: any) => s + c.totalChars, 0),
      calls,
      model,
      pricing: getModelPricing(model),
    });
  },

  "forensic.getResponseDetail": async ({ params, respond }) => {
    const sk = typeof params?.sessionKey === "string" ? params.sessionKey : undefined;
    const callIndex = typeof params?.callIndex === "number" ? params.callIndex : undefined;
    const run = sk ? getRunForSession(sk) : getLatestRun();
    if (!run || !run.responses?.length) {
      respond(false, undefined, { code: "NO_DATA", message: "No response data yet." });
      return;
    }
    const content =
      callIndex != null ? run.responses[callIndex] : run.responses[run.responses.length - 1];
    if (!content) {
      respond(false, undefined, {
        code: "NOT_FOUND",
        message: `No response at call index ${callIndex}.`,
      });
      return;
    }
    const totalChars = (content as any[]).reduce((s: number, b: any) => {
      if (b.type === "text") {
        return s + (b.text ?? "").length;
      }
      if (b.type === "thinking") {
        return s + (b.thinking ?? b.text ?? "").length;
      }
      if (b.type === "redacted_thinking") {
        return s;
      } // skip base64 data blobs
      if (b.type === "tool_use") {
        const input = JSON.stringify(b.input ?? {}, null, 2);
        return s + (b.name ?? "").length + input.length;
      }
      if (b.type === "tool_result") {
        const rt =
          typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "", null, 2);
        return s + rt.length;
      }
      return s + JSON.stringify(b).length;
    }, 0);
    respond(true, { content, totalChars });
  },
};
