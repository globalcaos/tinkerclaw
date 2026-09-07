import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { stripNulBytesFromArgv } from "./worker.js";

// REGRESSION 2026-08-18: 27 fatal worker deaths in nine hours because a single
// NUL byte reached the spawn argv. Node refuses such an argv outright
// ("The argument 'args[N]' must be a string without null bytes") and throws
// BEFORE the child exists, so the failure surfaces as an unrecoverable
// "Provider error — retrying" loop rather than anything the retry could fix.
//
// The byte's origin was three commits that shipped a literal NUL as the
// separator in board-types.ts's stableItemId. Correcting the source did NOT
// end the outage: every agent that had READ the file carried the byte in its
// transcript, and the transcript is replayed into --append-system-prompt.
//
// The NUL is built with String.fromCharCode(0) rather than written into this
// file, deliberately: a test that embeds the byte would put it back into the
// transcript of any agent that reads the test, which is the exact loop above.
const NUL = String.fromCharCode(0);

describe("stripNulBytesFromArgv", () => {
  it("leaves a clean argv untouched, including its array identity of values", () => {
    const argv = ["--model", "claude-opus-5", "--append-system-prompt", "# Persona\nhello"];
    const { argv: out, stripped } = stripNulBytesFromArgv(argv);
    expect(stripped).toBe(0);
    expect(out).toEqual(argv);
  });

  it("removes the NUL and keeps every other character of the prompt", () => {
    const prompt = `# Persona: JarvisOne (v1)${NUL}\n## Identity`;
    const { argv: out, stripped } = stripNulBytesFromArgv(["--append-system-prompt", prompt]);
    expect(stripped).toBe(1);
    expect(out[1]).toBe("# Persona: JarvisOne (v1)\n## Identity");
  });

  it("counts every occurrence across every entry, not just the first", () => {
    const { stripped } = stripNulBytesFromArgv([
      `a${NUL}b${NUL}c`,
      "clean",
      `--setenv=FOO=bar${NUL}`,
    ]);
    expect(stripped).toBe(3);
  });

  it("makes an argv that Node REFUSES into one it accepts", () => {
    const poisoned = ["--append-system-prompt", `# Persona${NUL}`];

    // The failure exactly as it reached the user, asserted rather than assumed.
    expect(() => spawnSync("/bin/echo", poisoned)).toThrow(/must be a string without null bytes/);

    const { argv: cleaned } = stripNulBytesFromArgv(poisoned);
    const res = spawnSync("/bin/echo", cleaned);
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
  });
});
