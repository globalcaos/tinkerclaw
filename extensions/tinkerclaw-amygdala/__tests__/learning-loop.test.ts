import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { TurnContexts } from "../src/context.js";
import { decide, type DecideDeps, type DecideInput } from "../src/decide.js";
import { createSafetyFamily } from "../src/families/safety.js";
import { createLearning } from "../src/learning.js";
import { QuestionBook } from "../src/question-book.js";
import { AmygdalaStore } from "../src/store.js";
import type { Question, Situation, Verdict } from "../src/types.js";

const extensionRoot = new URL("..", import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A judge that always reads "1.2 on the danger scale, and it does run": a near miss below the seed cut-off of 2. */
const judge = {
  async ask(s: Situation, qs: Question[]): Promise<Verdict[]> {
    return qs.map((q, i) => ({
      id: `v-${s.id}-${i}`,
      situationId: s.id,
      questionId: q.id,
      questionVersion: q.version,
      type: q.type,
      answer: q.id === "danger-level" ? 1.2 : q.type === "noul" ? 0.9 : "x",
      prob: q.id === "danger-level" ? 0.4 : 0.9,
      confidence: 0.9,
      cacheHit: false,
      latencyMs: 5,
      tokensIn: 10,
      tokensOut: 1,
      costUsd: 0,
      ts: 1,
    }));
  },
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "amy-loop-"));
  dirs.push(dataDir);
  const store = new AmygdalaStore(":memory:");
  const book = new QuestionBook({ seedDir: join(extensionRoot, "questions") });
  let t = 1_000_000;
  const now = () => (t += 1000);
  const learning = createLearning({
    store,
    book,
    jev: judge,
    config: parseConfig({ mode: "enforce" }),
    extensionRoot,
    dataDir,
    emit: () => {},
    now,
  });
  const deps: DecideDeps = {
    jev: judge,
    book,
    store,
    contexts: new TurnContexts({ store, now }),
    families: [createSafetyFamily({ book })],
    config: { mode: "enforce", failClosedOnLevel3: false },
    floorActive: () => true,
    now,
    cutoffFor: learning.cutoffFor,
    precedents: learning.precedents,
  };
  return { store, learning, deps };
}

const step = (command: string, turn: string): DecideInput => ({
  seam: "pre-tool",
  payload: {
    seam: "pre-tool",
    sessionKey: "s",
    turnId: turn,
    now: 1,
    tool: "Bash",
    toolInput: { command },
  },
  session: { workspaceRoot: "/work/demo", homeDir: "/home/demo" },
});

describe("the loop closes: a miss makes the next similar step act, and Undo restores the old behaviour", () => {
  it("proceed → miss → nightly tightens that context → the step is caught, another context is not → undo", async () => {
    const { store, learning, deps } = setup();

    // 1. The judge reads 1.2: below the seed cut-off, so the step proceeds.
    const first = await decide(
      deps,
      step("mv /work/demo/plans.docx /work/demo/old/plans.docx", "s#1"),
    );
    expect(first.decision.response.kind).toBe("proceed");

    // 2. The user says it should have acted. (The label is written directly: a precedent would raise the danger floor
    //    by itself and hide what the retuned cut-off does.)
    store.addLabel({
      id: "m1",
      targetId: first.id,
      targetKind: "decision",
      kind: "miss",
      value: 1,
      source: "user",
      weight: 3,
      ts: 2_000_000,
    });

    // 3. The nightly online retune tightens the cut-off in that context only.
    const night = await learning.nightly();
    expect(night.online.tighten).toHaveLength(1);
    expect(night.online.tighten[0]).toMatchObject({ outcome: "applied" });
    const change = learning.changes().find((c) => c.status === "applied");
    expect(change?.questionId).toBe("danger-level");

    // 4. The same kind of step, same context: now it acts. A step in another context still proceeds.
    const again = await decide(
      deps,
      step("mv /work/demo/plans.docx /work/demo/old/plans2.docx", "s#2"),
    );
    expect(again.decision.response.kind).not.toBe("proceed");
    const elsewhere = await decide(deps, step("mv /srv/other/a.txt /srv/other/b.txt", "s#3"));
    expect(elsewhere.decision.response.kind).toBe("proceed");

    // 5. Undo is exact: the same step proceeds again.
    expect(learning.undo((change as { id: string }).id)).toMatchObject({ ok: true });
    const restored = await decide(
      deps,
      step("mv /work/demo/plans.docx /work/demo/old/plans3.docx", "s#4"),
    );
    expect(restored.decision.response.kind).toBe("proceed");
  });
});
