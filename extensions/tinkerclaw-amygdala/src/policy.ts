/**
 * Digital amygdala v2 - policy compile and hook staging.
 *
 * The gateway compiles the hard rules into `policy.json`, stages the hook scripts into the data
 * dir and writes a claude-cli settings file registering them. The hooks run in claude-cli's
 * sandbox and read only these files, so everything here is plain JSON on disk.
 * `floorActive` says whether v2's hook owns the hard-rule floor (v3.1 not already enforcing it).
 */

import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { serializeRules, type SerializedRule } from "./rules.js";

export interface PolicyJson {
  version: number;
  generatedAt: number;
  mode: "shadow" | "enforce";
  floorActive: boolean;
  failClosed: true;
  rules: SerializedRule[];
}

type Mode = "shadow" | "enforce";

export function computeFloorActive(mode: Mode, v31Enforcing: boolean): boolean {
  return mode === "enforce" || !v31Enforcing;
}

export function compilePolicy(o: { mode: Mode; v31Enforcing: boolean; now?: number }): PolicyJson {
  return {
    version: 1,
    generatedAt: o.now ?? Date.now(),
    mode: o.mode,
    floorActive: computeFloorActive(o.mode, o.v31Enforcing),
    failClosed: true,
    rules: serializeRules(),
  };
}

export function policyPaths(dataDir: string): {
  dataDir: string;
  policyPath: string;
  settingsPath: string;
  endpointPath: string;
  hooksDir: string;
  spoolPath: string;
} {
  return {
    dataDir,
    policyPath: join(dataDir, "policy.json"),
    settingsPath: join(dataDir, "hook-settings.json"),
    endpointPath: join(dataDir, "endpoint.json"),
    hooksDir: join(dataDir, "hooks"),
    spoolPath: join(dataDir, "hook-spool.jsonl"),
  };
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* not ours to chmod */
  }
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function writePolicy(dataDir: string, p: PolicyJson): void {
  ensureDir(dataDir);
  atomicWrite(policyPaths(dataDir).policyPath, JSON.stringify(p, null, 2) + "\n");
}

/** Copy every `*.mjs` from `srcHooksDir` into `<dataDir>/hooks/`; returns the file names. */
export function stageHooks(dataDir: string, srcHooksDir: string): string[] {
  const dest = policyPaths(dataDir).hooksDir;
  ensureDir(dataDir);
  ensureDir(dest);
  const copied: string[] = [];
  for (const name of readdirSync(srcHooksDir)) {
    if (!name.endsWith(".mjs")) continue;
    copyFileSync(join(srcHooksDir, name), join(dest, name));
    copied.push(name);
  }
  return copied;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function buildHookSettings(
  dataDir: string,
  o: { mode: Mode; timeouts?: { prompt?: number; pre?: number; post?: number; stop?: number } },
): object {
  const t = o.timeouts ?? {};
  const env =
    `AMYGDALA2_DATA_DIR=${shq(dataDir)}` + (o.mode === "enforce" ? "" : " AMYGDALA2_SHADOW=1");
  const entry = (file: string, timeout: number, matcher?: string) => ({
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [
      {
        type: "command",
        command: `${env} node ${shq(join(dataDir, "hooks", file))}`,
        timeout,
      },
    ],
  });
  return {
    hooks: {
      UserPromptSubmit: [entry("prompt.mjs", t.prompt ?? 5)],
      PreToolUse: [entry("pre-tool.mjs", t.pre ?? 330, "*")],
      PostToolUse: [entry("post-tool.mjs", t.post ?? 5, "*")],
      Stop: [entry("stop.mjs", t.stop ?? 8)],
    },
  };
}

type Json = Record<string, unknown>;

/**
 * Combine v3.1's hook settings with ours. Per event, v3.1's entries come first, verbatim, then
 * ours. Other top-level keys: v3.1's win, ours are added when absent. Inputs are not mutated.
 */
export function mergeHookSettings(v31: object | null, next: object | null): object | null {
  if (!v31 && !next) return null;
  if (!v31) return structuredClone(next);
  if (!next) return structuredClone(v31);
  const a = structuredClone(v31) as Json;
  const b = structuredClone(next) as Json;
  const out: Json = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k !== "hooks" && !(k in out)) out[k] = v;
  }
  const ah = (a.hooks ?? {}) as Record<string, unknown[]>;
  const bh = (b.hooks ?? {}) as Record<string, unknown[]>;
  const hooks: Record<string, unknown[]> = { ...ah };
  for (const [ev, entries] of Object.entries(bh)) {
    hooks[ev] = [
      ...(Array.isArray(ah[ev]) ? ah[ev] : []),
      ...(Array.isArray(entries) ? entries : []),
    ];
  }
  out.hooks = hooks;
  return out;
}

export function writeHookSettings(
  dataDir: string,
  settings: object,
  name = "hook-settings.json",
): string {
  ensureDir(dataDir);
  const path = join(dataDir, name);
  atomicWrite(path, JSON.stringify(settings, null, 2) + "\n");
  return path;
}
