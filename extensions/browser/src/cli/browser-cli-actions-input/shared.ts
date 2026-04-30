import fs from "node:fs/promises";
import type { Command } from "commander";
import { callBrowserRequest, type BrowserParentOpts } from "../browser-cli-shared.js";
import {
  danger,
  defaultRuntime,
  normalizeBrowserFormField,
  normalizeBrowserFormFieldValue,
  type BrowserFormField,
} from "../core-api.js";

export type BrowserActionContext = {
  parent: BrowserParentOpts;
  profile: string | undefined;
};

export function resolveBrowserActionContext(
  cmd: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
): BrowserActionContext {
  const parent = parentOpts(cmd);
  const profile = parent?.browserProfile;
  return { parent, profile };
}

export async function callBrowserAct<T = unknown>(params: {
  parent: BrowserParentOpts;
  profile?: string;
  body: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<T> {
  // FORK 2026-04-30 (Bible §5.81f): bumped from 20s to 60s. The chrome-relay
  // profile path goes through a chrome-mcp subprocess which spawns on first
  // call after gateway restart and runs Playwright's connectOverCDP — the
  // full handshake against an already-loaded page like npmjs.com sends 250+
  // CDP messages and routinely takes 8-15s before the first userland
  // operation can run. 20s was upstream's tight budget for managed Chrome
  // (no subprocess overhead). For our relay path 60s is the realistic floor;
  // anything tighter and Jarvis sees "browser request timed out" on every
  // first call after restart even when the relay is healthy.
  return await callBrowserRequest<T>(
    params.parent,
    {
      method: "POST",
      path: "/act",
      query: params.profile ? { profile: params.profile } : undefined,
      body: params.body,
    },
    { timeoutMs: params.timeoutMs ?? 60000 },
  );
}

export function logBrowserActionResult(
  parent: BrowserParentOpts,
  result: unknown,
  successMessage: string,
) {
  if (parent?.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  defaultRuntime.log(successMessage);
}

export function requireRef(ref: string | undefined) {
  const refValue = typeof ref === "string" ? ref.trim() : "";
  if (!refValue) {
    defaultRuntime.error(danger("ref is required"));
    defaultRuntime.exit(1);
    return null;
  }
  return refValue;
}

async function readFile(path: string): Promise<string> {
  return await fs.readFile(path, "utf8");
}

export async function readFields(opts: {
  fields?: string;
  fieldsFile?: string;
}): Promise<BrowserFormField[]> {
  const payload = opts.fieldsFile ? await readFile(opts.fieldsFile) : (opts.fields ?? "");
  if (!payload.trim()) {
    throw new Error("fields are required");
  }
  const parsed = JSON.parse(payload) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("fields must be an array");
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`fields[${index}] must be an object`);
    }
    const rec = entry as Record<string, unknown>;
    const parsedField = normalizeBrowserFormField(rec);
    if (!parsedField) {
      throw new Error(`fields[${index}] must include ref`);
    }
    if (
      rec.value === undefined ||
      rec.value === null ||
      normalizeBrowserFormFieldValue(rec.value) !== undefined
    ) {
      return parsedField;
    }
    throw new Error(`fields[${index}].value must be string, number, boolean, or null`);
  });
}
