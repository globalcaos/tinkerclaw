import { describe, expect, it } from "vitest";
import { buildSituation, judgedReply, missing } from "../src/situation.js";
import type { SeamInput, SessionContext } from "../src/situation.js";

const ctx: SessionContext = { workspaceRoot: "/work/proj", homeDir: "/home/u" };
const base: SeamInput = { seam: "pre-tool", sessionKey: "s", turnId: "t", now: 1000 };

describe("buildSituation", () => {
  it("sets identity, defaults originKind to real and gives a fresh id", () => {
    const a = buildSituation(base, ctx);
    const b = buildSituation(base, ctx);
    expect(a.originKind).toBe("real");
    expect(a.ts).toBe(1000);
    expect(a.id).not.toBe(b.id);
    expect(buildSituation({ ...base, originKind: "synthetic" }, ctx).originKind).toBe("synthetic");
  });

  it("marks tool, args and command observed and effect/targets derived", () => {
    const s = buildSituation({ ...base, tool: "Bash", toolInput: { command: "rm -rf ~/x" } }, ctx);
    expect(s.tool).toEqual({ value: "Bash", origin: "observed" });
    expect(s.args.origin).toBe("observed");
    expect(s.command).toEqual({ value: "rm -rf ~/x", origin: "observed" });
    expect(s.effectClass.value).toBe("delete");
    expect(s.effectClass.origin).toBe("derived");
    expect(s.targets.origin).toBe("derived");
    expect(s.targets.value?.[0].path).toBe("/home/u/x");
  });

  it("leaves command missing for a non-shell tool", () => {
    const s = buildSituation({ ...base, tool: "Write", toolInput: { file_path: "a.ts" } }, ctx);
    expect(s.command).toEqual(missing());
    expect(s.effectClass.value).toBe("local-write");
  });

  it("does not guess: everything absent is missing", () => {
    const s = buildSituation({ ...base, seam: "prompt" }, ctx);
    for (const f of [
      s.tool,
      s.args,
      s.command,
      s.effectClass,
      s.targets,
      s.targetHistory,
      s.scratch,
      s.toolRecord,
      s.request,
      s.restatement,
      s.expectation,
      s.draftCommitments,
      s.repeatedErrors,
      s.stepsSinceNewFact,
      s.recentHolds,
      s.standingFacts,
      s.similarIncidents,
      s.reply,
      s.claims,
      s.provenance,
    ]) {
      expect(f).toEqual({ value: null, origin: "missing" });
    }
  });

  it("scratch is true, false or missing", () => {
    const scratchCtx = { ...ctx, scratchDirs: ["/tmp/scratch"] };
    const inScratch = buildSituation(
      { ...base, tool: "Write", toolInput: { file_path: "/tmp/scratch/a.txt" } },
      scratchCtx,
    );
    expect(inScratch.scratch).toEqual({ value: true, origin: "derived" });
    const outside = buildSituation(
      { ...base, tool: "Write", toolInput: { file_path: "/tmp/scratchy/a.txt" } },
      scratchCtx,
    );
    expect(outside.scratch.value).toBe(false);
    const mixed = buildSituation(
      { ...base, tool: "Bash", toolInput: { command: "rm /tmp/scratch/a /etc/b" } },
      scratchCtx,
    );
    expect(mixed.scratch.value).toBe(false);
    const none = buildSituation(
      { ...base, tool: "Bash", toolInput: { command: "pwd" } },
      scratchCtx,
    );
    expect(none.scratch).toEqual(missing());
  });

  it("takes targetHistory from the injected function for the first target", () => {
    const seen: string[] = [];
    const s = buildSituation(
      { ...base, tool: "Write", toolInput: { file_path: "/a/b.ts" } },
      {
        ...ctx,
        history: (p) => {
          seen.push(p);
          return { ageH: 1, sizeB: 2, edits72h: 3, authors72h: 1, lastMentionedByUser: null };
        },
      },
    );
    expect(seen).toEqual(["/a/b.ts"]);
    expect(s.targetHistory).toMatchObject({ origin: "derived", value: { edits72h: 3 } });
    const none = buildSituation(
      { ...base, tool: "Write", toolInput: { file_path: "/a/b.ts" } },
      { ...ctx, history: () => null },
    );
    expect(none.targetHistory).toEqual(missing());
  });

  it("judges the answer, not the reflection after it, and not a failed turn's placeholder (2026-10-01)", () => {
    expect(judgedReply("**Jarvis:** *No.*\n\nWhy not.\n\n🌿 FRACTAL: the zoom")).toBe(
      "**Jarvis:** *No.*\n\nWhy not.",
    );
    expect(judgedReply("🌿 FRACTAL ACTION: wrote a file")).toBeUndefined();
    expect(judgedReply("[assistant turn failed before producing content]")).toBeUndefined();
    expect(
      judgedReply("⚠️ Agent failed before reply: Live session model switch requested"),
    ).toBeUndefined();
    expect(judgedReply("Done. The build is green.")).toBe("Done. The build is green.");
    expect(judgedReply(undefined)).toBeUndefined();
  });

  it("drops the blocks the chat appends after the user's words (reflection doctrine, chat-row contract)", () => {
    const prompt =
      "[Wed 2026-09-30 00:10 GMT+2] no thinking indicator visible, are you stuck?\n\n---\n\n" +
      "**After your reply, append a 🌿 FRACTAL reflection section** on its own line.\n## Who Fractal is\n" +
      "x".repeat(5000) +
      "\n\n<!-- TINKERCLAW chat-row contract -->\nBefore EVERY tool call...";
    const s = buildSituation({ seam: "prompt", sessionKey: "k", turnId: "t", now: 1, prompt }, ctx);
    expect(s.request.value).toBe("no thinking indicator visible, are you stuck?");
    const onlyContract = buildSituation(
      {
        seam: "prompt",
        sessionKey: "k",
        turnId: "t",
        now: 1,
        prompt: "do X\n<!-- TINKERCLAW chat-row contract -->\nrules",
      },
      ctx,
    );
    expect(onlyContract.request.value).toBe("do X");
  });

  it("strips a metadata wrapper from the prompt; c.request wins", () => {
    const s = buildSituation(
      {
        ...base,
        seam: "prompt",
        prompt: "[Day 2026-09-29 17:45 GMT+2] ⟦AGENT:main⟧ please fix it",
      },
      ctx,
    );
    expect(s.request).toEqual({ value: "please fix it", origin: "derived" });
    const s2 = buildSituation(
      { ...base, seam: "prompt", prompt: "ignored" },
      { ...ctx, request: "real words" },
    );
    expect(s2.request.value).toBe("real words");
  });

  it("marks supplied context fields with their origins", () => {
    const s = buildSituation(
      { ...base, seam: "stop", reply: "done" },
      {
        ...ctx,
        toolRecord: [],
        recentHolds: [],
        repeatedErrors: 0,
        stepsSinceNewFact: 4,
        restatement: "r",
        expectation: "e",
        standingFacts: ["f"],
        similarIncidents: ["i"],
        claims: [],
        provenance: [],
        draftCommitments: [],
      },
    );
    expect(s.reply).toEqual({ value: "done", origin: "observed" });
    expect(s.repeatedErrors).toEqual({ value: 0, origin: "derived" });
    expect(s.stepsSinceNewFact.origin).toBe("derived");
    expect(s.toolRecord.origin).toBe("derived");
    expect(s.recentHolds.origin).toBe("derived");
    for (const f of [
      s.restatement,
      s.expectation,
      s.standingFacts,
      s.similarIncidents,
      s.claims,
      s.provenance,
      s.draftCommitments,
    ]) {
      expect(f.origin).toBe("inferred");
    }
  });

  it("carries the proof-needs, candidates, scheduled-jobs and context-count fields, missing unless supplied", () => {
    const bare = buildSituation({ ...base, tool: "Read", toolInput: { file_path: "/x" } }, ctx);
    for (const f of [bare.holdNeeds, bare.candidates, bare.scheduledJobs, bare.contextCounts]) {
      expect(f).toEqual({ value: null, origin: "missing" });
    }
    const full = buildSituation(
      { ...base, tool: "Read", toolInput: { file_path: "/x" } },
      {
        ...ctx,
        holdNeeds: ["listing"],
        candidates: [{ id: "recipe-a", description: "a" }],
        scheduledJobs: ["nightly"],
        contextCounts: { seen: 3, alarms: 1 },
      },
    );
    expect(full.holdNeeds).toEqual({ value: ["listing"], origin: "derived" });
    expect(full.candidates.value).toHaveLength(1);
    expect(full.scheduledJobs).toEqual({ value: ["nightly"], origin: "observed" });
    expect(full.contextCounts.value).toEqual({ seen: 3, alarms: 1 });
  });

  it("is pure: same input gives the same output except the id", () => {
    const input = { ...base, tool: "Bash", toolInput: { command: "git push" } };
    const a = buildSituation(input, ctx);
    const b = buildSituation(input, ctx);
    expect({ ...a, id: "" }).toEqual({ ...b, id: "" });
  });
});
