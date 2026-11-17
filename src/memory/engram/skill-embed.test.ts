/**
 * FORK 2026-10-29 (TINKER_UI_DESIGN_BIBLE/embedder-fit.md): skill search follows this machine's
 * embedder fit. A words-only machine builds no provider, and an embedding failure falls back to
 * the keyword ranking instead of failing the search.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  __resetEmbedderFitForTest,
  cheapFingerprint,
  writeEmbedderFit,
  type FitDecision,
} from "../../fork/embedder-fit.js";
import { __resetEmbedGovernorsForTest, getEmbedGovernor } from "../../fork/embedder-governor.js";
import { resolveOllamaEmbeddingBaseUrl } from "../embeddings-ollama.js";
import type { Skill } from "../storage/types.js";
import { resolveSkillEmbedFn } from "./skill-embed.js";
import { initialSuccessMetrics } from "./skill-extraction.js";
import { createSkillLibrary } from "./skill-library.js";

// getRuntimeConfig would read the real config file and createConfiguredEmbeddingProvider would
// build a real adapter, so both are stubbed. vi.mock and vi.hoisted run before the imports.
const h = vi.hoisted(() => ({
  cfg: {} as OpenClawConfig,
  createConfiguredEmbeddingProvider: vi.fn(),
}));

vi.mock("../../config/io.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/io.js")>();
  return { ...actual, getRuntimeConfig: () => h.cfg };
});

vi.mock("../../gateway/embeddings-http.js", () => ({
  createConfiguredEmbeddingProvider: h.createConfiguredEmbeddingProvider,
}));

// A model name no code carries as a literal: it can only come from the fit record.
const FIXTURE_MODEL = "fixture-embedder:test";

// An embedder-fit record measured on this machine (its fingerprint is this process's own), written
// into the test's temp state dir.
function writeFitRecord(decision: Pick<FitDecision, "mode" | "provider" | "model">): void {
  const fixture = (value: number, unit: string) => ({
    value,
    unit,
    provenance: "estimated" as const,
    source: "test fixture",
  });
  writeEmbedderFit({
    schemaVersion: 1,
    createdAt: "2026-10-29T08:00:00.000Z",
    fingerprint: cheapFingerprint(),
    inventory: {
      ollama: { baseUrl: "http://127.0.0.1:11434", reachable: true, models: [] },
      nodeLlamaCpp: false,
      remoteKeys: [],
    },
    candidates: [],
    missCostSec: fixture(21.57, "s"),
    nonEnglishShare: fixture(0, "share"),
    fitWallSeconds: fixture(150, "s"),
    decision: {
      dormantUntilDemand: false,
      reasons: ["test fixture"],
      verdicts: [],
      ...decision,
    },
    consent: { remote: null },
    tool: { command: "openclaw embedder fit", version: "test" },
    history: [],
  });
}

let counter = 0;
function skill(overrides: Partial<Skill>): Skill {
  counter += 1;
  return {
    skillId: `skill-embed-${counter}`,
    version: 1,
    name: "merge-conflict-resolution",
    description: "Resolve a git merge conflict and re-verify with tests",
    prerequisites: [],
    steps: ["identify conflicting files", "pick a resolution side", "re-run the test suite"],
    testCases: [],
    successMetrics: initialSuccessMetrics(),
    sourceEpisodeIds: ["ep-1"],
    created: "2026-10-29T08:00:00Z",
    deprecated: false,
    ...overrides,
  };
}

describe("resolveSkillEmbedFn follows the embedder fit", () => {
  const savedStateDir = process.env.OPENCLAW_STATE_DIR;
  let stateDir = "";
  let libDir = "";

  beforeEach(() => {
    // Each test gets an empty state dir, so a fit record on the host never changes the outcome.
    stateDir = mkdtempSync(join(tmpdir(), "skill-embed-state-"));
    libDir = mkdtempSync(join(tmpdir(), "skill-embed-lib-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    __resetEmbedderFitForTest();
    __resetEmbedGovernorsForTest({ stateDir: null });
    h.cfg = {} as OpenClawConfig;
    h.createConfiguredEmbeddingProvider.mockReset();
  });

  afterEach(() => {
    if (savedStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = savedStateDir;
    }
    __resetEmbedderFitForTest();
    __resetEmbedGovernorsForTest();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(libDir, { recursive: true, force: true });
  });

  it("returns undefined and builds no provider when memory search runs words only", async () => {
    // No fit record and no pinned provider: the seam resolves memorySearch.provider to 'none'.
    expect(await resolveSkillEmbedFn()).toBeUndefined();
    expect(h.createConfiguredEmbeddingProvider).not.toHaveBeenCalled();
  });

  it("an embedding failure falls back to the keyword ranking", async () => {
    writeFitRecord({ mode: "memory", provider: "ollama", model: FIXTURE_MODEL });
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const provider = {
      id: "ollama",
      model: FIXTURE_MODEL,
      embedQuery: vi.fn().mockRejectedValue(refused),
      embedBatch: vi.fn().mockRejectedValue(refused),
    };
    h.createConfiguredEmbeddingProvider.mockResolvedValue(provider);

    const embedFn = await resolveSkillEmbedFn();
    expect(embedFn).toBeDefined();
    expect(h.createConfiguredEmbeddingProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "ollama", model: FIXTURE_MODEL }),
    );

    const lib = createSkillLibrary({ baseDir: libDir, ...(embedFn ? { embedFn } : {}) });
    await lib.put(skill({ name: "merge", description: "resolve a git merge conflict" }));
    await lib.put(
      skill({
        name: "deploy",
        description: "roll back a failed deployment",
        steps: ["identify", "rollback"],
      }),
    );
    const hits = await lib.search("git merge conflict", 5);
    const keywordLib = createSkillLibrary({ baseDir: libDir });
    expect(hits[0]?.name).toBe("merge");
    expect(hits).toEqual(await keywordLib.search("git merge conflict", 5));

    // The embed went through the governor (it hands the provider an abort signal), on the
    // foreground lane, and that governor is the fit's endpoint queue in 'fit' mode.
    expect(provider.embedBatch).toHaveBeenCalledTimes(1);
    expect(provider.embedBatch).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ priority: "foreground", signal: expect.any(AbortSignal) }),
    );
    const governor = getEmbedGovernor({
      providerId: "ollama",
      model: FIXTURE_MODEL,
      baseUrl: resolveOllamaEmbeddingBaseUrl({ config: {} as OpenClawConfig }),
    });
    expect(governor.mode).toBe("fit");
  });
});
