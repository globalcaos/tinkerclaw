import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildStatus, readSpool, type StatusInputs } from "../src/status.js";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function inputs(o: Partial<StatusInputs> = {}): StatusInputs {
  return {
    now: NOW,
    mode: "enforce",
    floorActive: true,
    seams: { "pre-tool": NOW - 1000 },
    rules: { n: 20, version: 1 },
    judge: { lastMs: 180, errors: 0 },
    spendEurToday: 0.003,
    counts: { checks: 214, held: 3, asked: 1 },
    waitingForYou: 0,
    floorMissing: false,
    ...o,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("buildStatus", () => {
  it("working: enforce, healthy", () => {
    const s = buildStatus(inputs());
    expect(s.state).toBe("working");
    expect(s.line).toBe("Working · 214 checks · 3 held · 1 asked · €0.003 today");
    expect(s.checksToday).toBe(214);
    expect(s.heldToday).toBe(3);
    expect(s.askedToday).toBe(1);
    expect(s.rules).toEqual({ n: 20, version: 1 });
    expect(s.seams.pre.lastTs).toBe(NOW - 1000);
    expect(s.seams.stop.lastTs).toBeNull();
  });

  it("a failed start says Not running, never watching", () => {
    const st = buildStatus(
      inputs({
        mode: "shadow",
        startError: "ENOENT: no such file or directory, scandir 'questions'",
      }),
    );
    expect(st.state).toBe("degraded");
    expect(st.line).toMatch(/^Not running: failed to start \(ENOENT/);
    expect(st.line).not.toMatch(/watching/);
  });

  it("shadow: watching, not enforcing", () => {
    const s = buildStatus(inputs({ mode: "shadow", floorActive: false }));
    expect(s.state).toBe("shadow");
    expect(s.line).toBe(
      "Shadow: watching, not enforcing · 214 checks · 3 held · 1 asked · €0.003 today",
    );
  });

  it("shadow with the floor on says so", () => {
    const s = buildStatus(inputs({ mode: "shadow", floorActive: true }));
    expect(s.state).toBe("shadow");
    expect(s.line).toContain("hard rules on");
  });

  it("mentions what is waiting for the user", () => {
    expect(buildStatus(inputs({ waitingForYou: 2 })).line).toContain("2 waiting for you");
  });

  it("red when the judge has been silent over 5 minutes while checks arrive", () => {
    const s = buildStatus(
      inputs({ judge: { lastMs: null, errors: 4, silentSince: NOW - 6 * MIN } }),
    );
    expect(s.state).toBe("degraded");
    expect(s.line).toBe("Judge silent 6 min · hard rules still on");
  });

  it("not red when the judge was silent under 5 minutes, or no check has arrived lately", () => {
    const recent = buildStatus(
      inputs({ judge: { lastMs: null, errors: 1, silentSince: NOW - 2 * MIN } }),
    );
    expect(recent.state).toBe("working");
    const idle = buildStatus(
      inputs({
        seams: { "pre-tool": NOW - 20 * MIN },
        judge: { lastMs: null, errors: 1, silentSince: NOW - 10 * MIN },
      }),
    );
    expect(idle.state).toBe("working");
  });

  it("red when the policy floor is missing", () => {
    const s = buildStatus(inputs({ floorMissing: true, mode: "shadow" }));
    expect(s.state).toBe("degraded");
    expect(s.line).toBe("Hard rules floor missing");
  });

  it("red in enforce mode with the floor off", () => {
    const s = buildStatus(inputs({ floorActive: false }));
    expect(s.state).toBe("degraded");
    expect(s.line).toBe("Hard rules floor off");
  });

  it("shadow with the floor off is not red (v3.1 owns the floor)", () => {
    expect(buildStatus(inputs({ mode: "shadow", floorActive: false })).state).toBe("shadow");
  });

  it("red when the gateway refused a hook in the last 5 minutes, even in shadow", () => {
    const s = buildStatus(
      inputs({
        mode: "shadow",
        seams: { "pre-tool": NOW - 2 * MIN },
        hooksRefused: { ts: NOW - MIN, status: 401 },
      }),
    );
    expect(s.state).toBe("degraded");
    expect(s.line).toMatch(/^Hooks refused by the gateway \(HTTP 401\)/);
    const old = buildStatus(
      inputs({ mode: "shadow", hooksRefused: { ts: NOW - 6 * MIN, status: 401 } }),
    );
    expect(old.state).toBe("shadow");
  });

  // 2026-10-02: one oversized step got 413 and the panel said "the chats reach nothing" while 98 % arrived.
  it("a refusal followed by checks that arrive is a partial loss: named in the line, not red", () => {
    const s = buildStatus(
      inputs({
        mode: "shadow",
        seams: { "pre-tool": NOW - 1000 },
        hooksRefused: { ts: NOW - MIN, status: 413 },
      }),
    );
    expect(s.state).toBe("shadow");
    expect(s.line).toMatch(/^Shadow: watching/);
    expect(s.line).toContain("some hook calls refused (HTTP 413)");
    expect(s.line).not.toContain("reach nothing");
  });

  it("the line always matches the state, over every combination of inputs", () => {
    const lineStart = {
      working: "Working",
      shadow: "Shadow",
      degraded: /^(Hard rules floor|Judge silent)/,
    };
    let seen = 0;
    for (const mode of ["shadow", "enforce"] as const) {
      for (const floorActive of [true, false]) {
        for (const floorMissing of [true, false]) {
          for (const silentMin of [undefined, 2, 6]) {
            for (const seamAgeMin of [0, 20]) {
              const s = buildStatus(
                inputs({
                  mode,
                  floorActive,
                  floorMissing,
                  seams: { "pre-tool": NOW - seamAgeMin * MIN },
                  judge: {
                    lastMs: null,
                    errors: 1,
                    ...(silentMin === undefined ? {} : { silentSince: NOW - silentMin * MIN }),
                  },
                }),
              );
              const want = lineStart[s.state];
              if (typeof want === "string") expect(s.line.startsWith(want)).toBe(true);
              else expect(s.line).toMatch(want);
              // A red state never reads as healthy; a healthy one never names a fault.
              if (s.state === "degraded") expect(s.line.startsWith("Working")).toBe(false);
              else expect(s.line).not.toMatch(/floor missing|floor off|Judge silent/);
              seen++;
            }
          }
        }
      }
    }
    expect(seen).toBe(48);
  });
});

describe("readSpool", () => {
  it("a missing spool is empty", () => {
    const d = mkdtempSync(join(tmpdir(), "amy-spool-"));
    dirs.push(d);
    expect(readSpool(d)).toEqual({ seams: {}, floorMissingTs: null, refused: null });
  });

  it("reads per-seam liveness and floor-missing, skipping garbage lines", () => {
    const d = mkdtempSync(join(tmpdir(), "amy-spool-"));
    dirs.push(d);
    const rows = [
      JSON.stringify({ ts: 100, seam: "prompt", action: "none" }),
      "not json",
      JSON.stringify({ ts: 200, seam: "pre-tool", action: "floor-missing" }),
      JSON.stringify({ ts: 300, seam: "pre-tool", action: "none" }),
      JSON.stringify({ ts: 250, seam: "post-tool", action: "none" }),
    ];
    writeFileSync(join(d, "hook-spool.jsonl"), rows.join("\n") + "\n");
    const s = readSpool(d);
    expect(s.seams).toEqual({ prompt: 100, "pre-tool": 300, "post-tool": 250 });
    expect(s.floorMissingTs).toBe(200);
  });

  it("a refused call is not liveness: it is reported as refused, with its HTTP status", () => {
    const d = mkdtempSync(join(tmpdir(), "amy-spool-"));
    dirs.push(d);
    const rows = [
      JSON.stringify({ ts: 100, seam: "pre-tool", action: "shadow" }),
      JSON.stringify({ ts: 400, seam: "pre-tool", action: "refused", status: 401 }),
      JSON.stringify({ ts: 500, seam: "stop", action: "refused", status: 401 }),
    ];
    writeFileSync(join(d, "hook-spool.jsonl"), rows.join("\n") + "\n");
    const s = readSpool(d);
    expect(s.seams).toEqual({ "pre-tool": 100 });
    expect(s.refused).toEqual({ ts: 500, status: 401 });
  });

  it("only the last 200 lines count", () => {
    const d = mkdtempSync(join(tmpdir(), "amy-spool-"));
    dirs.push(d);
    const rows = [JSON.stringify({ ts: 1, seam: "stop", action: "floor-missing" })];
    for (let i = 0; i < 200; i++) {
      rows.push(JSON.stringify({ ts: 2 + i, seam: "prompt", action: "none" }));
    }
    writeFileSync(join(d, "hook-spool.jsonl"), rows.join("\n") + "\n");
    const s = readSpool(d);
    expect(s.floorMissingTs).toBeNull();
    expect(s.seams.stop).toBeUndefined();
  });
});
