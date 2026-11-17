import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { goalFingerprint } from "../src/context.js";
import { createDoubleCheckFamily } from "../src/families/double-check.js";
import { proofGrantCode } from "../src/grant-code.js";
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
  it("claim-support at or above its cut-off does not act", () => {
    const vs = [V("claim-record", 0.2), V("claim-support", 0.9)];
    expect(respond(fam, "stop", stop(), vs).kind).toBe("proceed");
  });

  it("a negated, future, conditional or proposed sentence claims nothing, so no claim question is asked", () => {
    for (const reply of [
      "I have not deleted the file yet.",
      "Nothing was restarted.",
      "I will push it tomorrow.",
      "If the build is finally done, the page updates.",
      "We should have it merged by Friday.",
      "I propose to get the branch deleted.",
    ]) {
      const s = stop({ reply: F(reply) });
      expect(fam.questionsFor("stop", s, freshState())).not.toContain("claim-record");
      expect(respond(fam, "stop", s, [V("claim-record", 0.9)]).kind).toBe("proceed");
    }
  });

  it("complete does not act", () => {
    const s = stop({ reply: F("Here.") });
    expect(respond(fam, "stop", s, [dodge("complete")]).kind).toBe("proceed");
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

  it("pre-tool: his Allow releases the hold, in his own turn and for this step only (2026-10-31)", () => {
    const base = preTool({
      sessionKey: "agent:main:tinker:t1",
      turnKind: F("owner" as const, "derived"),
      command: F("sed -i s/1/2/ tests/a.py"),
      effectClass: F("local-write" as const, "derived"),
    });
    const allow = F(`allow ${proofGrantCode(goalFingerprint(base))}`);
    const crossing = [V("weakens-own-check", 0.9)];
    expect(result(fam, "pre-tool", { ...base, request: allow }, crossing)).toEqual({
      response: { kind: "proceed" },
      drivers: [],
      reasonCode: "evidence-released-owner",
    });
    for (const s of [
      { ...base, request: F("allow JEV-000000") },
      { ...base, request: allow, sessionKey: "agent:main:subagent:u1" },
      { ...base, request: allow, turnKind: F("agent" as const, "derived") },
    ]) {
      expect(respond(fam, "pre-tool", s, crossing).kind).toBe("hold");
    }
  });
});

describe("unchecked admission (2026-11-10)", () => {
  const admits = () => stop({ reply: F("The page is live. The backups may be off (inferred).") });
  it("a reply that admits it did not check something is sent back once, naming the sentence", () => {
    const r = result(fam, "stop", admits(), []);
    expect(r?.reasonCode).toBe("unchecked-admission");
    expect(r?.response).toMatchObject({ kind: "send-back", templateId: "send-back-unchecked" });
    if (r?.response.kind !== "send-back") return;
    expect(renderTemplate(r.response.templateId, r.response.slots)).toContain(
      "The backups may be off (inferred).",
    );
  });
  it("after its one send-back the reply passes, and a reflection turn is never sent back", () => {
    expect(result(fam, "stop", admits(), [], freshState({ sendBackAttempts: 1 }))).toBeNull();
    const note = stop({
      reply: F("Not confirmed: the card on his page."),
      turnKind: F("reflection", "derived"),
    });
    expect(result(fam, "stop", note, [])).toBeNull();
  });
  it("a reply with nothing unchecked is left alone", () => {
    expect(
      result(fam, "stop", stop({ reply: F("I checked the page: it answers 200.") }), []),
    ).toBeNull();
  });
});

describe("weakens-own-check: only a step that can change a live check", () => {
  const q = (over: Partial<Situation>) => fam.questionsFor("pre-tool", preTool(over), freshState());
  const write = { effectClass: F("local-write" as const, "derived") };
  const at = (...paths: string[]) => ({
    targets: F(
      paths.map((path) => ({ path, kind: "file" as const, resolvedFrom: path })),
      "derived",
    ),
  });

  it("a write to a live test file is asked", () => {
    expect(q({ ...write, ...at("/w/src/a.test.ts") })).toEqual(["weakens-own-check"]);
    expect(q({ ...write, ...at("/w/tests/test_a.py") })).toEqual(["weakens-own-check"]);
  });
  it("a read and a copy in /tmp are not", () => {
    expect(q({ effectClass: F("read" as const, "derived"), ...at("/w/a.test.ts") })).toEqual([]);
    expect(q({ ...write, ...at("/tmp/jarvis/x/a.test.ts") })).toEqual([]);
  });
  it("a plain cp changes only its destination", () => {
    const cp = F("cp /w/src/a.test.ts /tmp/jarvis/x/a.test.ts");
    expect(
      q({ ...write, command: cp, ...at("/w/src/a.test.ts", "/tmp/jarvis/x/a.test.ts") }),
    ).toEqual([]);
    const over = F("cp /tmp/a.ts /w/src/a.test.ts");
    expect(q({ ...write, command: over, ...at("/tmp/a.ts", "/w/src/a.test.ts") })).toEqual([
      "weakens-own-check",
    ]);
  });
  it("a command with no target: running a check is not asked, writing one is", () => {
    const other = { effectClass: F("other" as const, "derived") };
    expect(q({ ...other, command: F("pnpm exec vitest run src/a.test.ts") })).toEqual([]);
    expect(q({ ...other, command: F("python3 fix.py > tests/a.test.ts") })).toEqual([
      "weakens-own-check",
    ]);
  });
  it("a checkout in /tmp is not scratch: its tests grade real work", () => {
    const wt = mkdtempSync("/tmp/amy-checkout-");
    try {
      writeFileSync(join(wt, ".git"), "gitdir: /elsewhere\n");
      expect(q({ ...write, ...at(join(wt, "tests/test_a.py")) })).toEqual(["weakens-own-check"]);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
  it("a live test the target parser cannot see stays asked", () => {
    const other = { effectClass: F("other" as const, "derived") };
    const viaVar = F("W=~/wt; mv $W/src/__tests__/a.test.ts /tmp/jarvis/x/a.txt");
    expect(q({ ...other, command: viaVar, ...at("/tmp/jarvis/x/a.txt") })).toEqual([
      "weakens-own-check",
    ]);
    const inHeredoc = F(
      "cd ~/wt && python3 - <<'E' > /tmp/jarvis/x/out.log\np='src/a.test.ts'; s=open(p).read(); open(p,'w').write(s)\nE",
    );
    expect(q({ ...other, command: inHeredoc, ...at("/tmp/jarvis/x/out.log") })).toEqual([
      "weakens-own-check",
    ]);
    const viaPathlib = F(
      "cd ~/wt && python3 - <<'E'\nfrom pathlib import Path\nPath('e2e/a.spec.ts').write_text('')\nE",
    );
    expect(q({ ...other, command: viaPathlib })).toEqual(["weakens-own-check"]);
  });
  it("a scripted step that stays in scratch is not asked", () => {
    const other = { effectClass: F("other" as const, "derived") };
    const py = F(
      "cd /tmp/jarvis/x && python3 - <<'E'\ns=open('replay.mts').read(); open('out.mts','w').write(s)\nE",
    );
    expect(q({ ...other, command: py, ...at("/tmp/jarvis/x") })).toEqual([]);
  });
  it("an e2e file is a check", () => {
    expect(q({ ...write, ...at("/w/e2e/walkthrough.ts") })).toEqual(["weakens-own-check"]);
  });
});

describe("report-defect: the formal way to say a test is wrong", () => {
  const reply =
    "The test pins the old date format.\nreport-defect: tests/a.test.ts: pins 2019 rules";

  it("reaches the owner as a note and asks nothing", () => {
    const s = stop({ reply: F(reply) });
    expect(fam.questionsFor("stop", s, freshState())).toEqual([]);
    const r = result(fam, "stop", s, []);
    expect(r?.response).toEqual({
      kind: "note",
      templateId: "defect-reported",
      slots: { what: "tests/a.test.ts: pins 2019 rules" },
      channel: "additionalContext",
    });
    expect(r?.reasonCode).toBe("report-defect");
    renders(r!.response);
  });

  it("a mention inside a sentence is not a report", () => {
    const s = stop({ reply: F("I could use report-defect: but the test is right.") });
    expect(fam.questionsFor("stop", s, freshState())).toContain("refusal");
  });
});

describe("selfModification: weakens-own-check", () => {
  const own = "/repo/own";
  const family = (selfModification: "locked" | "unlocked") =>
    createDoubleCheckFamily({ book, selfModification, ownRepoRoots: () => [own] });
  const step = (path: string) =>
    preTool({
      command: F("edit"),
      effectClass: F("local-write" as const, "derived"),
      targets: F([{ path, kind: "file" as const, resolvedFrom: "x" }], "derived"),
    });
  const asked = (selfModification: "locked" | "unlocked", path: string) =>
    family(selfModification).questionsFor("pre-tool", step(path), freshState());

  it("locked: the check over its own repo code is asked", () => {
    expect(asked("locked", `${own}/tests/a.test.ts`)).toEqual(["weakens-own-check"]);
  });
  it("unlocked: not asked for its own repo code, still asked for any other project", () => {
    expect(asked("unlocked", `${own}/tests/a.test.ts`)).toEqual([]);
    expect(asked("unlocked", "/repo/client/tests/a.test.ts")).toEqual(["weakens-own-check"]);
  });
  it("unlocked with no repository found: nothing counts as its own", () => {
    const f = createDoubleCheckFamily({
      book,
      selfModification: "unlocked",
      ownRepoRoots: () => [],
    });
    expect(f.questionsFor("pre-tool", step(`${own}/tests/a.test.ts`), freshState())).toEqual([
      "weakens-own-check",
    ]);
  });
});

describe("output as evidence (2026-11-01)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  /** A transcript: a Bash call with `output`, then whatever lines follow. */
  const tail = (output: string, ...after: object[]): string => {
    const d = mkdtempSync(join(tmpdir(), "dc-"));
    dirs.push(d);
    const p = join(d, "t.jsonl");
    const lines = [
      { type: "user", message: { content: "clean up the branch" } },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git x" } }],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: output }] },
      },
      ...after,
    ];
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
    return p;
  };
  const askedAfterEnrich = (reply: string, transcriptPath: string): string[] => {
    const s = stop({ reply: F(reply), claims: F<never>(null as never) });
    const state = freshState({ transcriptPath });
    fam.enrich?.("stop", s, state);
    return fam.questionsFor("stop", s, state);
  };

  it("a restart report proves the restart, and the report does not wipe the record", () => {
    const report = {
      type: "user",
      message: {
        content:
          "<turn_context>x</turn_context>\n⟦AGENT:⏳ Longjob · x⟧ done\n[System] The gateway restart you requested at 07:57 finished. Gateway healthy on build abc1234.",
      },
    };
    const p = tail("nothing here", report);
    expect(askedAfterEnrich("The gateway restarted on build abc1234.", p)).not.toContain(
      "claim-record",
    );
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

  // FORK 2026-11-08: the stop seam asks only the refusal question; the send-backs it fed are gone.
  it("stop: only the refusal question, with or without a done claim, reflection or not", () => {
    expect(q("stop", stop({ reply: F("I uploaded the report and the server is fixed.") }))).toEqual(
      ["refusal"],
    );
    expect(q("stop", stop({ turnKind: F("reflection", "derived") }))).toEqual(["refusal"]);
  });

  // 2026-10-25: 458 dodged-work flags on reflection turns were reviewed, 395 noise or harmful. A reflection leaves notes
  // for later; an open question in it is the point. Its done claims are still checked.

  it("stop: a provider error in the reply slot is not agent prose, so nothing is asked", () => {
    const raw =
      "API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations.";
    expect(q("stop", stop({ reply: F(raw) }))).toEqual([]);
    expect(q("stop", stop({ reply: F('__ERR_ENV__:{"kind":"error"}') }))).toEqual([]);
  });

  it("stop: Anthropic's safeguard refusal is a refusal (Rewind strip) with no Jev call; other provider errors are not", () => {
    const raw =
      "API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations.";
    const r = result(fam, "stop", stop({ reply: F(raw) }), []);
    expect(r?.response.kind).toBe("refusal");
    expect(r?.reasonCode).toBe("provider-safeguard");
    const env =
      '__ERR_ENV__:{"kind":"error","category":"safeguard","raw":"API Error: Opus 5.5\'s safeguards flagged this message"}';
    expect(respond(fam, "stop", stop({ reply: F(env) }), []).kind).toBe("refusal");
    expect(result(fam, "stop", stop({ reply: F("API Error: 429 rate limited") }), [])).toBeNull();
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
    // 2026-11-08: the nine send-back cases retired with the send-backs (cases/retired).
    expect(mustCatch.length).toBeGreaterThanOrEqual(2);
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
