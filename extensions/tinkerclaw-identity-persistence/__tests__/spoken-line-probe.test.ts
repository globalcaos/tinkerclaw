/**
 * J4 Level 1, first marker: the spoken line, checked on every finished home-chat answer and written
 * as `j.cortex.probe` (label `spoken-line`, n1 = 1 present / 0 missing).
 *
 * CONTROL: before this change both `llm_output` handlers read `payload.text ?? payload.content`,
 * fields the host event does not have (hook-types.ts PluginHookLlmOutputEvent carries
 * `assistantTexts`), so every turn returned early: 0 `j.cortex.probe` rows (09-25 → 10-09), no
 * sync-score log and no observations file ever written. The cases below send the host's real shape.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasSpokenLine } from "../src/spoken-line-probe.js";

type EmittedRow = { name: string; record: Record<string, unknown> };
const emitted = vi.hoisted(() => ({ rows: [] as EmittedRow[] }));
vi.mock("openclaw/plugin-sdk/fork-telemetry", () => ({
  emitEvent: (name: string, record: Record<string, unknown> = {}) => {
    emitted.rows.push({ name, record });
  },
}));

type LlmOutputHandler = (
  payload: { assistantTexts?: string[] },
  context: { sessionKey?: string; runId?: string; trigger?: string },
) => Promise<void>;

let dir: string;
let personaPath: string;

const HOME_CHAT = { sessionKey: "agent:main:tinker:ms39dshj", runId: "run-1", trigger: "user" };

async function register(
  persona: string,
  config: Record<string, unknown> = {},
): Promise<LlmOutputHandler[]> {
  writeFileSync(personaPath, persona);
  const on = vi.fn();
  const api = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    pluginConfig: { enabled: true, personaPath, evaluationInterval: 10, ...config },
    rootDir: __dirname,
    config: { agents: { defaults: { name: "TestAgent" } } },
    registerTool: vi.fn(),
    registerGatewayMethod: vi.fn(),
    on,
  };
  const mod = await import("../index.js");
  (mod.default as unknown as { register: (a: unknown) => void }).register(api);
  return on.mock.calls
    .filter(([name]: [string]) => name === "llm_output")
    .map(([, handler]: [string, LlmOutputHandler]) => handler);
}

async function answer(
  handlers: LlmOutputHandler[],
  assistantTexts: string[],
  context: { sessionKey?: string; runId?: string; trigger?: string } = HOME_CHAT,
): Promise<void> {
  for (const handler of handlers) {
    await handler({ assistantTexts }, context);
  }
}

const probeRows = (): Array<Record<string, unknown>> =>
  emitted.rows.filter((row) => row.name === "j.cortex.probe").map((row) => row.record);

const MARKED_PERSONA =
  "# TestAgent\n\nThe first line of every answer is `**TestAgent:** *spoken text*`.\n";

beforeEach(() => {
  vi.resetModules();
  emitted.rows.length = 0;
  dir = mkdtempSync(join(tmpdir(), "cortex-probe-"));
  vi.stubEnv("HOME", dir);
  mkdirSync(join(dir, ".openclaw", "workspace"), { recursive: true });
  personaPath = join(dir, ".openclaw", "workspace", "SOUL.md");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("the spoken-line probe at the llm_output hook", () => {
  it("rows a home-chat answer that carries the line as 1, one without it as 0", async () => {
    const handlers = await register(MARKED_PERSONA);

    await answer(handlers, ["Checking the file.", "**TestAgent:** *Done.*\n\nThe body."]);
    await answer(handlers, ["The body, with no spoken line."]);

    expect(probeRows()).toEqual([
      { label: "spoken-line", n1: 1, sessionKey: HOME_CHAT.sessionKey, runId: "run-1" },
      { label: "spoken-line", n1: 0, sessionKey: HOME_CHAT.sessionKey, runId: "run-1" },
    ]);
  });

  it("judges only finished, typed home-chat answers", async () => {
    const handlers = await register(MARKED_PERSONA);

    await answer(handlers, ["No line."], { ...HOME_CHAT, sessionKey: "agent:main:whatsapp:x" });
    await answer(handlers, ["No line."], { ...HOME_CHAT, sessionKey: "agent:main:fractal:p1" });
    await answer(handlers, ["No line."], { ...HOME_CHAT, runId: "fractal-run-1" });
    await answer(handlers, ["No line."], { ...HOME_CHAT, trigger: "heartbeat" });
    await answer(handlers, []); // ended on a tool call: nothing to judge
    await answer(handlers, ["NO_REPLY"]);
    await answer(handlers, ["No line."], { ...HOME_CHAT, sessionKey: "agent:main:main" });

    expect(probeRows()).toEqual([
      { label: "spoken-line", n1: 0, sessionKey: "agent:main:main", runId: "run-1" },
    ]);
  });

  it("writes nothing for a persona that never declares the spoken line", async () => {
    const handlers = await register("# TestAgent\n\n## Identity\nA test persona.\n");

    await answer(handlers, ["No line."]);

    expect(probeRows()).toEqual([]);
  });

  it("the SyncScore handler reads assistantTexts (its log is written at last)", async () => {
    const handlers = await register(MARKED_PERSONA, { evaluationInterval: 1 });

    await answer(handlers, ["**TestAgent:** *Done.*"]);

    const log = join(dir, ".openclaw", "cortex", "sync-score-log.jsonl");
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("the observation handler reads assistantTexts (its file is written at last)", async () => {
    const handlers = await register(MARKED_PERSONA);

    // Past the 30K-token batch threshold, with a fact pattern in it.
    await answer(handlers, ["I work at Acme Corp as a software engineer. ".repeat(12_000)]);

    expect(existsSync(join(dir, ".openclaw", "cortex", "observations.jsonl"))).toBe(true);
  });
});

describe("hasSpokenLine — the shape the Tinker UI paints purple", () => {
  it("accepts the line anywhere, closed or still streaming, name case-insensitive", () => {
    expect(hasSpokenLine("**Jarvis:** *Done.*", "Jarvis")).toBe(true);
    expect(hasSpokenLine("Narration.\n\n**jarvis:** *still stream", "Jarvis")).toBe(true);
  });

  it("refuses bold instead of italics, a bare name, a line break before the italics, another name", () => {
    expect(hasSpokenLine("**Jarvis:** **Done.**", "Jarvis")).toBe(false);
    expect(hasSpokenLine("Jarvis: *Done.*", "Jarvis")).toBe(false);
    expect(hasSpokenLine("**Jarvis:**\n*Done.*", "Jarvis")).toBe(false);
    expect(hasSpokenLine("**Goku:** *Done.*", "Jarvis")).toBe(false);
  });
});
