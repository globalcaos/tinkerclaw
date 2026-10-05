/**
 * FORK 2026-09-08 — the budget panel must read only credentials the operator
 * gave THIS gateway, never another application's credential store.
 *
 * Two reads were removed in the audit that produced this file: the Claude Code
 * CLI's ~/.claude/.credentials.json (an OAuth token fallback) and gcloud's
 * ~/.config/gcloud/service-account.json (the Gemini quota key). Both were
 * plausible-looking conveniences, which is exactly why they need a test — the
 * next person to hit a dead refresh token will be tempted to add them back.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  googleServiceAccountFile,
  setAnthropicProfiles,
  setGoogleServiceAccountFile,
  usageProfiles,
} from "../index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(here, "..", "index.ts"), "utf-8");

/** Strip block and line comments so prose ABOUT a removed path can't pass for code. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

afterEach(() => {
  setGoogleServiceAccountFile(null);
  setAnthropicProfiles(null);
  delete process.env.BUDGET_PANEL_GOOGLE_SA_FILE;
});

describe("no foreign credential stores", () => {
  it("never references the Claude Code CLI credential file in code", () => {
    expect(code(SOURCE)).not.toMatch(/\.claude\/\.credentials\.json/);
  });

  it("never references gcloud's credential directory in code", () => {
    expect(code(SOURCE)).not.toMatch(/\.config\/gcloud/);
  });

  it("never reads openclaw.json from disk", () => {
    expect(code(SOURCE)).not.toMatch(/readFileSync\([^)]*openclaw\.json/);
  });

  it("does not write credentials back to any store", () => {
    const c = code(SOURCE);
    expect(c).not.toMatch(/saveAuthProfileStore/);
    expect(c).not.toMatch(/writeCredentialFile/);
  });
});

describe("google service account is operator-supplied", () => {
  it("has no default path — unset means the Gemini poll is skipped", () => {
    expect(googleServiceAccountFile()).toBeNull();
  });

  it("uses the configured path when one is given", () => {
    setGoogleServiceAccountFile("/tmp/my-sa.json");
    expect(googleServiceAccountFile()).toBe("/tmp/my-sa.json");
  });

  it("falls back to the documented environment variable", () => {
    process.env.BUDGET_PANEL_GOOGLE_SA_FILE = "/tmp/env-sa.json";
    expect(googleServiceAccountFile()).toBe("/tmp/env-sa.json");
  });
});

describe("anthropic profiles are operator-supplied", () => {
  it("polls exactly the configured profiles, keyed without the provider prefix", () => {
    setAnthropicProfiles(["anthropic:work", "anthropic:personal"]);
    expect(usageProfiles()).toEqual({
      work: "anthropic:work",
      personal: "anthropic:personal",
    });
  });

  it("bakes in no specific person's profile names", () => {
    expect(code(SOURCE)).not.toMatch(/anthropic:cli-(sv|gm)/);
  });
});
