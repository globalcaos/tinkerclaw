import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  leafModelOwnerText,
  subagentModelOwnerText,
  THALAMUS_LEAF_RESOLVER_SLOT,
  thalamusOwnsModelChoice,
} from "./thalamus-worker-seam.js";

// FORK 2026-10-03: the spawn guidance tells the agent who picks a model. When Thalamus owns the choice the agent is told
// to leave the model out; otherwise it picks by weight as before.

const here = dirname(fileURLToPath(import.meta.url));
const SLOT = Symbol.for(THALAMUS_LEAF_RESOLVER_SLOT);
const g = globalThis as Record<symbol, unknown>;
afterEach(() => {
  delete g[SLOT];
});

describe("who picks a model, as the worker's guidance says it", () => {
  it("says nobody owns it with no resolver, one without owns, one that says no, or one that throws", () => {
    expect(thalamusOwnsModelChoice("subagent")).toBe(false);
    g[SLOT] = { resolve: () => undefined };
    expect(thalamusOwnsModelChoice("subagent")).toBe(false);
    g[SLOT] = { resolve: () => undefined, owns: () => false };
    expect(thalamusOwnsModelChoice("subagent")).toBe(false);
    g[SLOT] = {
      owns: () => {
        throw new Error("boom");
      },
    };
    expect(thalamusOwnsModelChoice("subagent")).toBe(false);
  });

  it("asks per site and renders the matching text", () => {
    g[SLOT] = { owns: (site: string) => site === "subagent" };
    expect(thalamusOwnsModelChoice("subagent")).toBe(true);
    expect(thalamusOwnsModelChoice("orchestrate-default")).toBe(false);
    expect(subagentModelOwnerText()).toMatch(/^Thalamus picks it right now: leave `--model` out/);
    expect(leafModelOwnerText()).toMatch(/^Pick the leaf model PER UNIT by weight/);
    expect(subagentModelOwnerText(false)).toMatch(/not picking models right now/);
    expect(leafModelOwnerText(true)).toMatch(/^Thalamus picks each leaf's model right now/);
  });

  it("is wired: both prompts carry their placeholder and the worker substitutes both", () => {
    const helper = readFileSync(join(here, "../prompts/subagent-helper.md"), "utf8");
    const disposition = readFileSync(join(here, "../prompts/orchestration-disposition.md"), "utf8");
    const worker = readFileSync(join(here, "worker.ts"), "utf8");
    expect(helper).toContain("{{MODEL_CHOICE_OWNER}}");
    expect(disposition).toContain("{{LEAF_MODEL_OWNER}}");
    expect(worker).toContain("MODEL_CHOICE_OWNER: subagentModelOwnerText()");
    expect(worker).toContain("LEAF_MODEL_OWNER: leafModelOwnerText()");
  });

  it("reads the same slot key as core", () => {
    const core = readFileSync(join(here, "../../../src/infra/thalamus-call-router.ts"), "utf8");
    expect(core).toContain(`LEAF_RESOLVER_SLOT = "${THALAMUS_LEAF_RESOLVER_SLOT}"`);
  });
});
