import { extractErrorCode, formatErrorMessage } from "../infra/errors.js";

export type PwAiModule = typeof import("./pw-ai.js");

type PwAiLoadMode = "soft" | "strict";

let pwAiModuleSoft: Promise<PwAiModule | null> | null = null;
let pwAiModuleStrict: Promise<PwAiModule | null> | null = null;

function isModuleNotFoundError(err: unknown): boolean {
  const code = extractErrorCode(err);
  if (code === "ERR_MODULE_NOT_FOUND") {
    return true;
  }
  const msg = formatErrorMessage(err);
  return (
    msg.includes("Cannot find module") ||
    msg.includes("Cannot find package") ||
    msg.includes("Failed to resolve import") ||
    msg.includes("Failed to resolve entry for package") ||
    msg.includes("Failed to load url")
  );
}

async function loadPwAiModule(mode: PwAiLoadMode): Promise<PwAiModule | null> {
  try {
    return await import("./pw-ai.js");
  } catch (err) {
    if (mode === "soft") {
      return null;
    }
    if (isModuleNotFoundError(err)) {
      return null;
    }
    throw err;
  }
}

export async function getPwAiModule(opts?: { mode?: PwAiLoadMode }): Promise<PwAiModule | null> {
  const mode: PwAiLoadMode = opts?.mode ?? "soft";
  if (mode === "soft") {
    if (!pwAiModuleSoft) {
      pwAiModuleSoft = loadPwAiModule("soft");
    }
    const mod = await pwAiModuleSoft;
    // Do not memoize failures: a null here is usually transient (e.g. a dist
    // rebuild orphaned the lazily-imported pw-ai chunk under a long-running
    // gateway). Clearing the cache lets the next request self-heal once the
    // dist is coherent again, instead of disabling Playwright until restart.
    if (!mod) {
      pwAiModuleSoft = null;
    }
    return mod;
  }
  if (!pwAiModuleStrict) {
    pwAiModuleStrict = loadPwAiModule("strict");
  }
  const mod = await pwAiModuleStrict;
  if (!mod) {
    pwAiModuleStrict = null;
  }
  return mod;
}
