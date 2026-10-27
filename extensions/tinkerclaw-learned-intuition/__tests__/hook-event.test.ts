import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The live hook event (CONTRACT.md "Live hook event", FORK 2026-10-15): a spool row →
 * `amygdala.hook`, and the tail that notices the row. HOME is redirected before the module
 * loads, as registration.test.ts does: index.ts resolves its data paths from the home dir and
 * this test must never look at the real one.
 */

let home: string;
let dir: string;

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), "amy-hook-event-"));
  vi.stubEnv("HOME", home);
  dir = join(home, ".openclaw", "data", "amygdala");
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

async function load() {
  return await import("../index.js");
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for the tail");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TS = "2026-10-15T10:00:00.000Z";

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: TS,
    tool: "Bash",
    target: "rm -rf ~/src",
    decision: "deny",
    rule: "DESTRUCTIVE_RM",
    enforced: true,
    src: "cc-hook",
    toolUseId: "toolu_01",
    sessionId: "sess-1",
    ...over,
  };
}

describe("hookEventFromRow", () => {
  it("maps a deny row to the event shape with a ms ts and a stable 12-hex id", async () => {
    const { hookEventFromRow, hookRowId } = await load();
    const ev = hookEventFromRow(row());
    expect(ev).toEqual({
      id: hookRowId(Date.parse(TS), "toolu_01", "DESTRUCTIVE_RM"),
      ts: Date.parse(TS),
      tool: "Bash",
      target: "rm -rf ~/src",
      decision: "deny",
      rule: "DESTRUCTIVE_RM",
      toolUseId: "toolu_01",
      sessionId: "sess-1",
      enforced: true,
    });
    expect(ev!.id).toMatch(/^hook-[0-9a-f]{12}$/);
    expect(hookEventFromRow(row())!.id).toBe(ev!.id);
  });

  it("passes every bubble decision and skips allow, observe and non-rows", async () => {
    const { hookEventFromRow } = await load();
    for (const decision of ["deny", "owner-intent", "owner-pasted-secret", "owner-allow"]) {
      expect(hookEventFromRow(row({ decision }))?.decision).toBe(decision);
    }
    expect(hookEventFromRow(row({ decision: "allow", rule: null, enforced: false }))).toBeNull();
    expect(hookEventFromRow(row({ decision: "observe" }))).toBeNull();
    expect(hookEventFromRow(row({ decision: undefined }))).toBeNull();
    expect(hookEventFromRow(null)).toBeNull();
    expect(hookEventFromRow("deny")).toBeNull();
    expect(hookEventFromRow(42)).toBeNull();
  });

  it("tolerates rows spooled before toolUseId/sessionId existed, and a numeric ts", async () => {
    const { hookEventFromRow, hookRowId } = await load();
    const ev = hookEventFromRow({ ts: 1_700_000_000_000, tool: "Edit", decision: "deny" });
    expect(ev).toEqual({
      id: hookRowId(1_700_000_000_000, null, null),
      ts: 1_700_000_000_000,
      tool: "Edit",
      target: "",
      decision: "deny",
      rule: null,
      toolUseId: null,
      sessionId: null,
      enforced: false,
    });
    expect(hookEventFromRow(row({ ts: "not a date" }))!.ts).toBe(0);
  });

  it("gives a different id when the tool call or the rule differs", async () => {
    const { hookEventFromRow } = await load();
    const a = hookEventFromRow(row())!.id;
    expect(hookEventFromRow(row({ toolUseId: "toolu_02" }))!.id).not.toBe(a);
    expect(hookEventFromRow(row({ rule: "CREDENTIAL_WRITE" }))!.id).not.toBe(a);
    expect(hookEventFromRow(row({ ts: "2026-10-15T10:00:01.000Z" }))!.id).not.toBe(a);
  });
});

describe("createHookSpoolTail", () => {
  it("emits only rows appended after start, keeps a torn line, survives the feed trim, stops", async () => {
    const { createHookSpoolTail } = await load();
    const file = join(dir, "hook-decisions.jsonl");
    writeFileSync(file, JSON.stringify(row({ target: "old" })) + "\n");
    const got: Array<Record<string, unknown>> = [];
    const tail = createHookSpoolTail({ file, onRow: (r) => got.push(r), pollMs: 20 });
    tail.start();

    // the tail hands over every row; allow/observe filtering is the service's job
    appendFileSync(
      file,
      JSON.stringify(row({ target: "new-1" })) +
        "\n" +
        JSON.stringify(row({ decision: "allow", target: "new-2" })) +
        "\n",
    );
    await until(() => got.length >= 2);
    expect(got.map((r) => r.target)).toEqual(["new-1", "new-2"]);

    // a line without its newline waits (the hook writes a row in one append, but a reader
    // can still see the first half of it)
    appendFileSync(file, '{"ts":"2026-10-15T10:00:01.000Z","decision":"deny","target":"ha');
    await sleep(80);
    expect(got.length).toBe(2);
    appendFileSync(file, 'lf","tool":"Bash"}\n');
    await until(() => got.length >= 3);
    expect(got[2].target).toBe("half");

    // amygdala.feed rewrites the file shorter: the offset resets and the new content is read
    writeFileSync(file, JSON.stringify(row({ target: "after-trim" })) + "\n");
    await until(() => got.length >= 4);
    expect(got[3].target).toBe("after-trim");

    tail.stop();
    appendFileSync(file, JSON.stringify(row({ target: "after-stop" })) + "\n");
    await sleep(80);
    expect(got.length).toBe(4);
  });

  it("starts before the file exists and picks up its first row", async () => {
    const { createHookSpoolTail } = await load();
    const file = join(dir, "hook-decisions.jsonl");
    const got: Array<Record<string, unknown>> = [];
    const tail = createHookSpoolTail({ file, onRow: (r) => got.push(r), pollMs: 20 });
    tail.start();
    writeFileSync(file, JSON.stringify(row({ target: "first" })) + "\n");
    await until(() => got.length >= 1);
    expect(got[0].target).toBe("first");
    tail.stop();
  });

  it("skips a torn line and keeps going", async () => {
    const { createHookSpoolTail } = await load();
    const file = join(dir, "hook-decisions.jsonl");
    writeFileSync(file, "");
    const got: Array<Record<string, unknown>> = [];
    const tail = createHookSpoolTail({ file, onRow: (r) => got.push(r), pollMs: 20 });
    tail.start();
    appendFileSync(file, "{not json}\n" + JSON.stringify(row({ target: "good" })) + "\n");
    await until(() => got.length >= 1);
    expect(got.map((r) => r.target)).toEqual(["good"]);
    tail.stop();
  });
});
