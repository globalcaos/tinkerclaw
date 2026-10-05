import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDoubleCheckFamily } from "../src/families/double-check.js";
import { renderTemplate } from "../src/templates.js";
import type { Response, Seam, Situation, ToolRecordEntry } from "../src/types.js";
import {
  book,
  caseSituation,
  freshState,
  loadCaseFile,
  meetsCeiling,
  meetsFloor,
  respond,
  result,
  V,
  verdictsFromCase,
} from "./helpers/family-harness.js";

const fam = createDoubleCheckFamily({ book });
const F = <T>(value: T, origin: "observed" | "derived" = "observed") => ({ value, origin });
const rec = (tool: string, effects: ToolRecordEntry["effects"], exit: number | null = 0) =>
  ({ tool, argsDigest: "d", exit, filesWritten: [], effects, ts: 1 }) as ToolRecordEntry;

const stop = (over: Partial<Situation> = {}): Situation =>
  caseSituation(
    null,
    "stop",
    {},
    { reply: F("I uploaded the PDF."), toolRecord: F<ToolRecordEntry[]>([]), ...over },
  );

function renders(r: Response): void {
  if (r.kind === "send-back") expect(() => renderTemplate(r.templateId, r.slots)).not.toThrow();
}

const dodge = (option: string, p = 0.9) => V("dodged-work", option, p);
const preTool = (over: Partial<Situation> = {}): Situation =>
  caseSituation(null, "pre-tool", {}, over);

describe("double-check decision table (design 5.2)", () => {
  it("a refusal outranked by a claim send-back is flagged, so the strip is still offered (2026-09-30, CTO tab)", () => {
    const r = result(fam, "stop", stop(), [V("refusal", 0.99), V("claim-record", 0.9)]);
    expect(r?.response.kind).toBe("send-back");
    expect(r?.alsoRefusal).toBe(true);
    const alone = result(fam, "stop", stop(), [V("refusal", 0.99)]);
    expect(alone?.response.kind).toBe("refusal");
    expect(alone?.alsoRefusal).toBeUndefined();
  });

  it("claim-record crosses -> send-back-claim attempt 1", () => {
    const r = result(fam, "stop", stop(), [V("claim-record", 0.9)]);
    expect(r?.response).toEqual({
      kind: "send-back",
      templateId: "send-back-claim",
      slots: {
        claim: "I uploaded the PDF.",
        missing: "no tool call in this task uploaded anything",
      },
      attempt: 1,
    });
    expect(r?.drivers).toEqual(["claim-record"]);
    expect(r?.reasonCode).toBe("claim-unsupported");
    renders(r!.response);
  });

  it("claim-support below its cut-off crosses too; drivers list the crossing questions", () => {
    const r = result(fam, "stop", stop(), [V("claim-record", 0.2), V("claim-support", 0.1)]);
    expect(r?.response.kind).toBe("send-back");
    expect(r?.drivers).toEqual(["claim-support"]);
    const both = result(fam, "stop", stop(), [V("claim-record", 0.9), V("claim-support", 0.1)]);
    expect(both?.drivers).toEqual(["claim-record", "claim-support"]);
  });

  it("claim-support at or above its cut-off does not act", () => {
    const vs = [V("claim-record", 0.2), V("claim-support", 0.9)];
    expect(respond(fam, "stop", stop(), vs).kind).toBe("proceed");
  });

  it("names the first unsupported claim, not a supported one", () => {
    const s = stop({
      reply: F("I saved the file. I deleted the copy."),
      toolRecord: F([rec("Write", ["local-write"])]),
    });
    const r = result(fam, "stop", s, [V("claim-record", 0.9)]);
    const slots = (r?.response as { slots: Record<string, string> }).slots;
    expect(slots.claim).toBe("I deleted the copy.");
    expect(slots.missing).toBe("no successful call that deleted anything");
  });

  it("no done claim but a completion verb in the reply: the whole reply is checked", () => {
    const s = stop({ reply: F("I have not deleted the file yet.") });
    expect(fam.questionsFor("stop", s, freshState())).toContain("claim-record");
    const r = result(fam, "stop", s, [V("claim-record", 0.9)]);
    expect(r?.response.kind).toBe("send-back");
  });

  for (const [option, problem] of [
    ["placeholder", "leaves a placeholder"],
    ["handed-back", "hands the work back"],
    ["question-open", "leaves your question open"],
    ["promise-later", "promises later work that nothing will run"],
    ["unverified-fix", "reports a fix that was not verified in this task"],
  ] as const) {
    it(`dodged-work ${option} -> send-back-dodged`, () => {
      const r = result(fam, "stop", stop({ reply: F("Some reply.") }), [dodge(option)]);
      expect(r?.response).toEqual({
        kind: "send-back",
        templateId: "send-back-dodged",
        slots: { problem },
        attempt: 1,
      });
      expect(r?.drivers).toEqual(["dodged-work"]);
      expect(r?.reasonCode).toBe("dodged-work");
      renders(r!.response);
    });
  }

  it("promise-later is ignored when a job is scheduled, other dodges still act", () => {
    const s = stop({ reply: F("I will report."), scheduledJobs: F(["job-1"]) });
    expect(respond(fam, "stop", s, [dodge("promise-later")]).kind).toBe("proceed");
    const mixed = V("dodged-work", "promise-later", 0.5);
    mixed.probs = { "promise-later": 0.3, placeholder: 0.65, complete: 0.05 };
    expect(respond(fam, "stop", s, [mixed]).kind).toBe("send-back");
  });

  it("complete does not act", () => {
    const s = stop({ reply: F("Here.") });
    expect(respond(fam, "stop", s, [dodge("complete")]).kind).toBe("proceed");
  });

  it("stale-state-claim -> send-back-claim with the state claim", () => {
    const s = stop({ reply: F("The service is running. Also I uploaded it.") });
    const r = result(fam, "stop", s, [V("stale-state-claim", 0.9)]);
    expect(r?.response).toMatchObject({
      kind: "send-back",
      templateId: "send-back-claim",
      slots: {
        claim: "The service is running.",
        missing: "no check of the running state in this task",
      },
    });
    expect(r?.reasonCode).toBe("stale-state");
    renders(r!.response);
  });

  it("refusal -> {kind:refusal}, drivers [refusal], renders nothing", () => {
    const s = stop({ reply: F("I can't help with that.") });
    const r = result(fam, "stop", s, [V("refusal", 0.9)]);
    expect(r).toEqual({
      response: { kind: "refusal" },
      drivers: ["refusal"],
      reasonCode: "refusal",
    });
    renders(r!.response);
  });

  it("a send-back outranks a refusal candidate", () => {
    const r = result(fam, "stop", stop(), [V("refusal", 0.9), V("claim-record", 0.9)]);
    expect(r?.response.kind).toBe("send-back");
  });

  it("attempt numbering: 1, then 2, then none (the refusal candidate survives)", () => {
    const vs = [V("claim-record", 0.9)];
    const at = (n: number) => respond(fam, "stop", stop(), vs, freshState({ sendBackAttempts: n }));
    expect((at(0) as { attempt: number }).attempt).toBe(1);
    expect((at(1) as { attempt: number }).attempt).toBe(2);
    expect(at(2).kind).toBe("proceed");
    const withRefusal = respond(
      fam,
      "stop",
      stop(),
      [...vs, V("refusal", 0.9)],
      freshState({ sendBackAttempts: 2 }),
    );
    expect(withRefusal.kind).toBe("refusal");
  });

  it("pre-tool: weakens-own-check crosses -> hold", () => {
    const s = preTool({
      command: F("sed -i s/1/2/ tests/a.py"),
      effectClass: F("local-write" as const, "derived"),
    });
    const r = result(fam, "pre-tool", s, [V("weakens-own-check", 0.9)]);
    expect(r).toEqual({
      response: { kind: "hold", ruleOrQuestion: "weakens-own-check", releasable: "user-only" },
      drivers: ["weakens-own-check"],
      reasonCode: "weakens-own-check",
    });
    expect(respond(fam, "pre-tool", s, [V("weakens-own-check", 0.59)]).kind).toBe("proceed");
  });
});

describe("cannot-tell and skipped never act", () => {
  it("dodged-work: cannot-tell p=0.95 and the acting option just below its cut-off", () => {
    const s = stop({ reply: F("Some reply.") });
    expect(respond(fam, "stop", s, [dodge("cannot-tell", 0.95)]).kind).toBe("proceed");
    const below = V("dodged-work", "placeholder", 0.59);
    below.probs = { placeholder: 0.59, complete: 0.41 };
    expect(respond(fam, "stop", s, [below]).kind).toBe("proceed");
  });

  it("noul questions just below their cut-offs do not act", () => {
    const s = stop({ reply: F("The service is running. I uploaded it.") });
    const vs = [V("claim-record", 0.39), V("stale-state-claim", 0.59), V("refusal", 0.49)];
    expect(respond(fam, "stop", s, vs).kind).toBe("proceed");
    expect(respond(fam, "pre-tool", preTool(), [V("weakens-own-check", 0.59)]).kind).toBe(
      "proceed",
    );
  });

  it("skipped verdicts are absent", () => {
    const vs = ["claim-record", "claim-support", "stale-state-claim", "refusal", "dodged-work"].map(
      (id) => ({
        ...V(id, id === "dodged-work" ? "placeholder" : 0.99),
        skipped: "error" as const,
      }),
    );
    const s = stop({ reply: F("The service is running. I uploaded it.") });
    expect(respond(fam, "stop", s, vs).kind).toBe("proceed");
    const w = { ...V("weakens-own-check", 0.99), skipped: "error" as const };
    expect(respond(fam, "pre-tool", preTool(), [w]).kind).toBe("proceed");
  });
});

describe("questionsFor", () => {
  const q = (seam: Seam, s: Situation) => fam.questionsFor(seam, s, freshState());

  it("stop: refusal and dodged-work always; claim questions only with a done claim", () => {
    expect(q("stop", stop({ reply: F("The answer is 4.") }))).toEqual(["refusal", "dodged-work"]);
    expect(q("stop", stop({ reply: F("I uploaded the PDF.") }))).toEqual([
      "refusal",
      "dodged-work",
      "claim-record",
      "claim-support",
      "claim-source",
    ]);
    expect(q("stop", stop({ reply: F("The site is live.") }))).toEqual([
      "refusal",
      "dodged-work",
      "stale-state-claim",
    ]);
  });

  it("pre-tool: only a write-ish step that touches a check", () => {
    const base = { command: F("edit"), effectClass: F("local-write" as const, "derived") };
    const hit = preTool({
      ...base,
      targets: F([{ path: "/w/tests/a.py", kind: "file" as const, resolvedFrom: "x" }], "derived"),
    });
    expect(q("pre-tool", hit)).toEqual(["weakens-own-check"]);
    const viaCommand = preTool({
      command: F("sed -i s/a/b/ pytest.ini"),
      effectClass: F("other" as const, "derived"),
    });
    expect(q("pre-tool", viaCommand)).toEqual(["weakens-own-check"]);
    expect(q("pre-tool", preTool({ ...base, command: F("edit src/a.ts") }))).toEqual([]);
    const read = preTool({
      command: F("cat tests/a.py"),
      effectClass: F("read" as const, "derived"),
    });
    expect(q("pre-tool", read)).toEqual([]);
    expect(q("prompt", stop())).toEqual([]);
    expect(q("post-tool", stop())).toEqual([]);
  });

  it("every id returned exists in the seed file and lists the seam", () => {
    const seen: [Seam, string[]][] = [
      ["stop", q("stop", stop({ reply: F("I uploaded it. The site is live.") }))],
      [
        "pre-tool",
        q(
          "pre-tool",
          preTool({
            command: F("delete tests/a.py"),
            effectClass: F("delete" as const, "derived"),
          }),
        ),
      ],
    ];
    for (const [seam, ids] of seen) {
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(book.get(id)?.seams).toContain(seam);
    }
  });
});

describe("enrich", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("sets claims from the reply and reads the transcript tail", () => {
    const d = mkdtempSync(join(tmpdir(), "amyg-dc-"));
    dirs.push(d);
    const p = join(d, "t.jsonl");
    writeFileSync(
      p,
      [
        JSON.stringify({ type: "user", message: { content: "go" } }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "ls" } }],
          },
        }),
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "a", is_error: false }] },
        }),
      ].join("\n"),
    );
    const s = caseSituation(null, "stop", {}, { reply: F("I uploaded it.") });
    fam.enrich?.("stop", s, freshState({ transcriptPath: p }));
    expect(s.claims.origin).toBe("derived");
    expect(s.claims.value?.[0]?.kind).toBe("done");
    expect(s.toolRecord.origin).toBe("observed");
    expect(s.toolRecord.value?.map((e) => e.tool)).toEqual(["Bash"]);
  });

  it("keeps a longer given record and given claims; ignores other seams", () => {
    const s = stop({ claims: F([], "derived") });
    s.toolRecord = F([rec("A", []), rec("B", [])]);
    fam.enrich?.("stop", s, freshState({ transcriptPath: "/nonexistent/x.jsonl" }));
    expect(s.claims.value).toEqual([]);
    expect(s.toolRecord.value).toHaveLength(2);
    const p = preTool();
    fam.enrich?.("pre-tool", p, freshState());
    expect(p.claims.origin).toBe("missing");
  });
});

describe("cases replay", () => {
  const seamOf = (c: { answers?: Record<string, unknown> }): Seam => {
    const id = Object.keys(c.answers ?? {})[0] as string;
    return book.get(id)?.seams[0] as Seam;
  };
  const run = (c: Parameters<typeof verdictsFromCase>[0]) => {
    const seam = seamOf(c);
    return respond(fam, seam, caseSituation(c, seam), verdictsFromCase(c));
  };
  const mustCatch = loadCaseFile("must-catch", "double-check");
  const controls = loadCaseFile("controls", "double-check");

  it("has the cases", () => {
    expect(mustCatch.length).toBeGreaterThanOrEqual(10);
    expect(controls.length).toBeGreaterThanOrEqual(5);
  });
  for (const c of mustCatch)
    it(`must-catch ${c.id}`, () => {
      expect(c.answers).toBeDefined();
      const r = run(c);
      expect(meetsFloor(r, c.mustBeAtLeast!)).toBe(true);
      renders(r);
    });
  for (const c of controls)
    it(`control ${c.id}`, () => {
      expect(meetsCeiling(run(c), c.mustBeAtMost!)).toBe(true);
    });
});
