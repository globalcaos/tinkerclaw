// src/fork/deferred-tools.ts
// FORK: Deferred tool loading — only sends core tool schemas to the LLM,
// deferring non-essential tools to on-demand loading via ToolSearch.

export interface ToolDef {
  name: string;
  description: string;
  schema?: Record<string, unknown>;
}

export interface FilterResult {
  eager: ToolDef[];
  deferred: ToolDef[];
}

export interface FilterOptions {
  mode: "auto" | "all" | "defer";
  contextWindow?: number;
  thresholdPct?: number;
}

const CORE_TOOLS = new Set([
  "Read",
  "Edit",
  "Write",
  "Bash",
  "Grep",
  "Glob",
  "AskUserQuestion",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
]);

function estimateTokens(tool: ToolDef): number {
  const schemaStr = tool.schema ? JSON.stringify(tool.schema) : "";
  return Math.ceil((tool.name.length + tool.description.length + schemaStr.length) / 4);
}

export function filterTools(tools: ToolDef[], opts: FilterOptions): FilterResult {
  if (opts.mode === "all") {
    return { eager: tools, deferred: [] };
  }

  if (opts.mode === "defer") {
    const eager = tools.filter((t) => CORE_TOOLS.has(t.name));
    const deferred = tools
      .filter((t) => !CORE_TOOLS.has(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
      }));
    return { eager, deferred };
  }

  // mode === "auto": defer only if total tokens exceed threshold
  const contextWindow = opts.contextWindow ?? 200_000;
  const thresholdPct = opts.thresholdPct ?? 10;
  const totalTokens = tools.reduce((sum, t) => sum + estimateTokens(t), 0);
  const threshold = (contextWindow * thresholdPct) / 100;

  if (totalTokens <= threshold) {
    return { eager: tools, deferred: [] };
  }

  const eager = tools.filter((t) => CORE_TOOLS.has(t.name));
  const deferred = tools
    .filter((t) => !CORE_TOOLS.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
    }));
  return { eager, deferred };
}

export interface ToolRegistry {
  search(query: string): ToolDef[];
  getAll(): ToolDef[];
}

export function createToolRegistry(tools: ToolDef[]): ToolRegistry {
  const byName = new Map<string, ToolDef>();
  for (const t of tools) {
    byName.set(t.name, t);
  }

  return {
    search(query: string): ToolDef[] {
      const q = query.toLowerCase();
      const results: ToolDef[] = [];
      // Exact name match first
      const exact = byName.get(query);
      if (exact) {
        return [exact];
      }
      // Fuzzy search by name and description
      for (const t of tools) {
        if (t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)) {
          results.push(t);
        }
      }
      return results;
    },
    getAll(): ToolDef[] {
      return [...tools];
    },
  };
}
