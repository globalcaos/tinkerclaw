import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetJevAvailabilityForTests } from "../infra/jev/availability.js";
import type { WizardPrompter } from "./prompts.js";
import { setupJevToken } from "./setup.jev.js";

let stateDir: string;
let savedState: string | undefined;
let savedKey: string | undefined;

beforeEach(() => {
  savedState = process.env.OPENCLAW_STATE_DIR;
  savedKey = process.env.TYPESAFE_API_KEY;
  stateDir = mkdtempSync(join(tmpdir(), "jev-wizard-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  delete process.env.TYPESAFE_API_KEY;
  resetJevAvailabilityForTests();
});
afterEach(() => {
  resetJevAvailabilityForTests();
  if (savedState === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = savedState;
  }
  if (savedKey === undefined) {
    delete process.env.TYPESAFE_API_KEY;
  } else {
    process.env.TYPESAFE_API_KEY = savedKey;
  }
  rmSync(stateDir, { recursive: true, force: true });
});

function prompter(answer: string) {
  const notes: string[] = [];
  const p = {
    text: vi.fn(async () => answer),
    note: vi.fn(async (m: string) => {
      notes.push(m);
    }),
  } as unknown as WizardPrompter;
  return { p, notes };
}

describe("setup: optional Jev token", () => {
  it("skip leaves Jev dormant, writes nothing, and says so in one note", async () => {
    const { p, notes } = prompter("");
    await setupJevToken(p);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Jev is off: no token");
    expect(notes[0]).toContain(join(stateDir, "jev", "token"));
    expect(() => statSync(join(stateDir, "jev"))).toThrow();
  });

  it("a pasted token goes to the key file with mode 0600, and the note never repeats it", async () => {
    const { p, notes } = prompter("tok-wizard-secret");
    await setupJevToken(p);
    const file = join(stateDir, "jev", "token");
    expect(readFileSync(file, "utf8")).toBe("tok-wizard-secret\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(notes.join("\n")).not.toContain("tok-wizard-secret");
  });

  it("asks nothing when a token already exists", async () => {
    process.env.TYPESAFE_API_KEY = "tok-env";
    resetJevAvailabilityForTests();
    const { p, notes } = prompter("ignored");
    await setupJevToken(p);
    expect(p.text).not.toHaveBeenCalled();
    expect(notes[0]).toContain("already set up");
  });
});
