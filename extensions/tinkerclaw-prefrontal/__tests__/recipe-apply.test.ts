import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMutationProposal,
  isApplyEnabled,
  isJarvisAuthored,
  extractKitSpec,
  buildRewritePrompt,
  type ApplyDeps,
  type ApplyProposalInput,
} from "../recipe-apply.js";

// U1: applyMutationProposal must drop the matcher's in-memory index cache after a
// successful persist so the rewritten recipe is matchable next turn. Mock the
// recipe-matcher module so we can assert the invalidation deterministically (the
// real cache keys off dir mtime, whose resolution is too coarse to test against).
const invalidateSpy = vi.fn();
vi.mock("../recipe-matcher.js", () => ({
  invalidateRecipeIndexCache: () => invalidateSpy(),
}));

const JARVIS_KIT = `---
schema: "kit/1.0"
slug: "demo-recipe"
title: "Demo"
summary: "A demo recipe"
authoredBy: jarvis-on-the-fly
tags: [demo]
---
### 1. Step one
Do the thing.`;

const CURATED_KIT = `---
schema: "kit/1.0"
slug: "demo-recipe"
title: "Demo"
summary: "A curated recipe"
tags: [demo]
---
### 1. Step one
Do the thing.`;

const VALID_SPEC = {
  slug: "demo-recipe",
  title: "Demo (improved)",
  summary: "A demo recipe with a guard step",
  tags: ["demo"],
  steps: [
    { title: "Verify preconditions", body: "Check inputs before acting." },
    { title: "Do the thing", body: "Perform the action." },
  ],
};

const INPUT: ApplyProposalInput = {
  recipeId: "demo-recipe",
  op: "add_step",
  intent: "add a verification/guard step before the failing action",
  rationale: "successRate 0.1 < floor 0.5 over 12 runs",
};

function makeDeps(
  over: Partial<ApplyDeps> & { calls?: string[] } = {},
): ApplyDeps & { calls: string[] } {
  const calls = over.calls ?? [];
  return {
    calls,
    loadKitText:
      over.loadKitText ??
      (async () => {
        calls.push("load");
        return { path: "/k/demo-recipe/kit.md", text: JARVIS_KIT };
      }),
    snapshot:
      over.snapshot ??
      (async () => {
        calls.push("snapshot");
        return "/archive/demo-recipe-2026.md";
      }),
    rewrite:
      over.rewrite ??
      (async () => {
        calls.push("rewrite");
        return JSON.stringify(VALID_SPEC);
      }),
    authorKit:
      over.authorKit ??
      (async () => {
        calls.push("author");
        return { ok: true, note: "written" };
      }),
    log: over.log,
  };
}

describe("isApplyEnabled", () => {
  it("is true ONLY for the literal 'true'", () => {
    expect(isApplyEnabled({ RECIPE_AUTOAPPLY_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isApplyEnabled({ RECIPE_AUTOAPPLY_ENABLED: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isApplyEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isApplyEnabled({ RECIPE_AUTOAPPLY_ENABLED: "false" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("isJarvisAuthored", () => {
  it("detects jarvis-authored kits, protects curated", () => {
    expect(isJarvisAuthored(JARVIS_KIT)).toBe(true);
    expect(isJarvisAuthored(CURATED_KIT)).toBe(false);
    expect(isJarvisAuthored('authoredBy: "jarvis-on-the-fly"')).toBe(true);
  });
});

describe("extractKitSpec", () => {
  it("parses a bare JSON object", () => {
    expect(extractKitSpec(JSON.stringify(VALID_SPEC))).toMatchObject({ slug: "demo-recipe" });
  });
  it("parses JSON inside ```json fences", () => {
    expect(extractKitSpec("```json\n" + JSON.stringify(VALID_SPEC) + "\n```")).toMatchObject({
      slug: "demo-recipe",
    });
  });
  it("parses the first object even with surrounding prose + nested braces", () => {
    const reply = `Here is the recipe:\n${JSON.stringify(VALID_SPEC)}\nDone!`;
    expect(extractKitSpec(reply)).toMatchObject({ title: "Demo (improved)" });
  });
  it("returns undefined for empty / non-JSON", () => {
    expect(extractKitSpec(undefined)).toBeUndefined();
    expect(extractKitSpec("no json here")).toBeUndefined();
    expect(extractKitSpec("{ broken")).toBeUndefined();
  });
});

describe("buildRewritePrompt", () => {
  it("includes the op, intent, and the current recipe", () => {
    const p = buildRewritePrompt("CURRENT-RECIPE-TEXT", "add_step", "add a guard step");
    expect(p).toContain("add_step");
    expect(p).toContain("add a guard step");
    expect(p).toContain("CURRENT-RECIPE-TEXT");
    expect(p).toContain("ONLY a single JSON object");
  });
});

describe("applyMutationProposal", () => {
  it("applies a valid rewrite, snapshotting BEFORE the write", async () => {
    const deps = makeDeps();
    const res = await applyMutationProposal(INPUT, deps);
    expect(res).toMatchObject({ applied: true, reason: "applied" });
    expect(res.archivePath).toBeTruthy();
    // snapshot must precede author
    expect(deps.calls.indexOf("snapshot")).toBeLessThan(deps.calls.indexOf("author"));
  });

  it("skips a missing recipe (no snapshot, no rewrite)", async () => {
    const deps = makeDeps({ loadKitText: async () => null });
    const res = await applyMutationProposal(INPUT, deps);
    expect(res.reason).toBe("recipe-missing");
    expect(deps.calls).not.toContain("snapshot");
    expect(deps.calls).not.toContain("rewrite");
  });

  it("refuses a curated (non-jarvis) recipe before any rewrite or write", async () => {
    const deps = makeDeps({ loadKitText: async () => ({ path: "/k", text: CURATED_KIT }) });
    const res = await applyMutationProposal(INPUT, deps);
    expect(res.reason).toBe("curated-skip");
    expect(deps.calls).not.toContain("snapshot");
    expect(deps.calls).not.toContain("rewrite");
    expect(deps.calls).not.toContain("author");
  });

  it("keeps the original when the rewrite is empty (snapshot taken, no write)", async () => {
    const deps = makeDeps({ rewrite: async () => undefined });
    const res = await applyMutationProposal(INPUT, deps);
    expect(res.reason).toBe("rewrite-empty");
    expect(deps.calls).toContain("snapshot");
    expect(deps.calls).not.toContain("author");
  });

  it("keeps the original when the rewrite is invalid (fails validateRecipeSpec)", async () => {
    const deps = makeDeps({
      rewrite: async () => JSON.stringify({ slug: "demo-recipe", title: "x" }),
    });
    const res = await applyMutationProposal(INPUT, deps);
    expect(res.reason).toBe("rewrite-invalid");
    expect(res.errors && res.errors.length).toBeTruthy();
    expect(deps.calls).not.toContain("author");
  });

  it("reports author-rejected when the guarded write refuses", async () => {
    const deps = makeDeps({ authorKit: async () => ({ ok: false, note: "curated kit" }) });
    const res = await applyMutationProposal(INPUT, deps);
    expect(res.reason).toBe("author-rejected");
    expect(res.applied).toBe(false);
  });

  it("forces the slug back to the proposal's recipeId (no identity fork)", async () => {
    let written: { slug?: string } = {};
    const deps = makeDeps({
      rewrite: async () => JSON.stringify({ ...VALID_SPEC, slug: "hijacked-slug" }),
      authorKit: async (spec) => {
        written = spec;
        return { ok: true, note: "written" };
      },
    });
    const res = await applyMutationProposal(INPUT, deps);
    expect(res.applied).toBe(true);
    expect(written.slug).toBe("demo-recipe");
  });
});

// U1 (2026-06): after a self-apply rewrite is persisted, the matcher's in-memory
// kit index must be dropped so the NEXT turn re-reads the rewritten recipe (else
// the autonomous edit would only take effect after a process restart or an
// unrelated dir-mtime change). recipe-apply owns this invalidation so it holds
// regardless of which authorKit injection persisted the write.
describe("applyMutationProposal — matcher cache invalidation", () => {
  beforeEach(() => invalidateSpy.mockClear());
  afterEach(() => invalidateSpy.mockClear());

  it("a successful apply invalidates the matcher index cache exactly once", async () => {
    const res = await applyMutationProposal(INPUT, makeDeps());
    expect(res.applied).toBe(true);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it("a missing recipe never invalidates the cache (no write, no re-scan)", async () => {
    const res = await applyMutationProposal(INPUT, makeDeps({ loadKitText: async () => null }));
    expect(res.reason).toBe("recipe-missing");
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("a curated-skip never invalidates the cache", async () => {
    const res = await applyMutationProposal(
      INPUT,
      makeDeps({ loadKitText: async () => ({ path: "/k", text: CURATED_KIT }) }),
    );
    expect(res.reason).toBe("curated-skip");
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("an author-rejected apply does NOT invalidate the cache (no spurious re-scan)", async () => {
    const res = await applyMutationProposal(
      INPUT,
      makeDeps({ authorKit: async () => ({ ok: false, note: "rejected" }) }),
    );
    expect(res.applied).toBe(false);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("an invalid rewrite does NOT invalidate the cache", async () => {
    const res = await applyMutationProposal(
      INPUT,
      makeDeps({ rewrite: async () => JSON.stringify({ slug: "demo-recipe", title: "x" }) }),
    );
    expect(res.reason).toBe("rewrite-invalid");
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
