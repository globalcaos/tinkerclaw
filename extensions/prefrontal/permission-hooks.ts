// extensions/prefrontal/permission-hooks.ts
// FORK: Hook-based permission system — user-defined shell scripts gate tool calls.

import { execSync } from "node:child_process";

export interface HookDef {
  tool: string;
  script: string;
  timeout: number;
}

export interface HookResult {
  decision: "approve" | "deny";
  feedback?: string;
}

export interface PermissionHooks {
  check(toolName: string, context: Record<string, unknown>): Promise<HookResult>;
}

export function createPermissionHooks(hooks: HookDef[]): PermissionHooks {
  return {
    async check(toolName: string, context: Record<string, unknown>): Promise<HookResult> {
      const matching = hooks.filter((h) => h.tool === toolName || h.tool === "*");
      if (matching.length === 0) {return { decision: "approve" };}

      for (const hook of matching) {
        try {
          const input = JSON.stringify({ tool: toolName, ...context });
          const output = execSync(hook.script, {
            input,
            timeout: hook.timeout,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          const result = JSON.parse(output.trim()) as HookResult;
          if (result.decision === "deny") {return result;}
        } catch {
          // Timeout or error → approve (fail-open for hooks)
          continue;
        }
      }

      return { decision: "approve" };
    },
  };
}
