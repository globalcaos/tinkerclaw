import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { goalFingerprint, TurnContexts } from "../src/context.js";
import { buildSituation } from "../src/situation.js";
import { AmygdalaStore } from "../src/store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make(o: { now?: () => number; facts?: string } = {}) {
  const store = new AmygdalaStore(":memory:");
  let path: string | undefined;
  if (o.facts !== undefined) {
    const d = mkdtempSync(join(tmpdir(), "amy-ctx-"));
    dirs.push(d);
    path = join(d, "standing-facts.json");
    writeFileSync(path, o.facts);
  }
  return { store, ctx: new TurnContexts({ store, now: o.now, standingFactsPath: path }) };
}
const sit = (command: string) =>
  buildSituation(
    {
      seam: "pre-tool",
      sessionKey: "s",
      turnId: "t",
      now: 1,
      tool: "Bash",
      toolInput: { command },
    },
    { workspaceRoot: "/w", homeDir: "/h" },
  );

describe("TurnContexts", () => {
  it("state is per turn, notes reset per call, and the send-back counter survives a fresh instance (store-backed)", () => {
    const { store, ctx } = make();
    const st = ctx.get("s", "t1");
    st.seenNotes.add("n");
    st.notesThisCall = 1;
    expect(ctx.get("s", "t1")).toBe(st);
    expect(ctx.get("s", "t2")).not.toBe(st);
    ctx.beginCall(st);
    expect(st.notesThisCall).toBe(0);
    expect(st.seenNotes.has("n")).toBe(true);
    expect(ctx.bumpSendBack(st)).toBe(1);
    expect(ctx.bumpSendBack(st)).toBe(2);
    const fresh = new TurnContexts({ store });
    expect(fresh.get("s", "t1").sendBackAttempts).toBe(2);
  });
  it("recent holds age out of the window", () => {
    let t = 0;
    const { ctx } = make({ now: () => t });
    ctx.recordHold("s", "fp1", 0);
    t = 30 * 60_000;
    ctx.recordHold("s", "fp2", t);
    expect(ctx.recentHolds("s").map((h) => h.goalFp)).toEqual(["fp1", "fp2"]);
    t = 61 * 60_000;
    expect(ctx.recentHolds("s").map((h) => h.goalFp)).toEqual(["fp2"]);
  });
  it("standing facts: file read once per mtime, bad file or missing file → none", () => {
    expect(make({ facts: '["a","b",3]' }).ctx.standingFacts()).toEqual(["a", "b"]);
    expect(make({ facts: "not json" }).ctx.standingFacts()).toEqual([]);
    expect(make().ctx.standingFacts()).toEqual([]);
  });
  it("hurry needs three prompts, each under 20 s after the last", () => {
    const { ctx } = make();
    ctx.notePrompt("s", 0);
    ctx.notePrompt("s", 10_000);
    expect(ctx.hurry("s")).toBe(false);
    ctx.notePrompt("s", 25_000);
    expect(ctx.hurry("s")).toBe(true);
    ctx.notePrompt("s", 90_000);
    expect(ctx.hurry("s")).toBe(false);
  });
  it("buildSessionContext merges tracked state; the caller's values win", () => {
    const { ctx } = make({ facts: '["fact one"]' });
    ctx.recordHold("s", "fpX", Date.now());
    ctx.setScheduledJobs(["nightly"]);
    const c = ctx.buildSessionContext(
      { workspaceRoot: "/w", homeDir: "/h", standingFacts: ["mine"] },
      "s",
      "t",
    );
    expect(c.standingFacts).toEqual(["mine"]);
    expect(c.recentHolds?.[0].goalFp).toBe("fpX");
    expect(c.scheduledJobs).toEqual(["nightly"]);
  });
});

describe("goalFingerprint", () => {
  it("survives rewording of the same delete and differs by target and effect", () => {
    expect(goalFingerprint(sit("rm -rf ./data"))).toBe(goalFingerprint(sit("rm -r -f ./data")));
    expect(goalFingerprint(sit("rm -rf ./data"))).not.toBe(goalFingerprint(sit("rm -rf ./other")));
    expect(goalFingerprint(sit("ls ./data"))).not.toBe(goalFingerprint(sit("rm -rf ./data")));
  });
});
