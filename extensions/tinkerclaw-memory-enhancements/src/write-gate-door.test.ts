/**
 * The memory write gate's gateway door and its config (FORK 2026-10-25). The gate's own labels are tested in core
 * (src/memory/engram/write-gate.test.ts); here: the contradictionGate switch, the default roots and rule files, the
 * before_tool_call shapes for the embedded runner's write and edit, and what register() publishes for the Claude Code
 * hook. Every run uses a scratch state dir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGateConfig, createWriteGateHook, resolveGateMode } from "./write-gate-door.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "memory-gate-door-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
let n = 0;

function world() {
  const base = path.join(scratch, `w${n++}`);
  const mem = path.join(base, "memory");
  const state = path.join(base, "state");
  fs.mkdirSync(mem, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(
    path.join(mem, "weekly_call.md"),
    "---\nname: weekly_call\ndescription: the team call\n---\n\n- The weekly team call is on Wednesday at 10:00 with the whole lab.\n",
  );
  return { base, mem, state };
}

describe("contradictionGate → gate mode", () => {
  it("is watch unless told otherwise", () => {
    expect(resolveGateMode(undefined)).toBe("watch");
    expect(resolveGateMode({ mode: "warn" })).toBe("watch");
    expect(resolveGateMode({ mode: "block" })).toBe("enforce");
    expect(resolveGateMode({ enabled: false, mode: "block" })).toBeNull();
  });
});

describe("buildGateConfig", () => {
  it("guards the auto-memory folder and each workspace's MEMORY.md and memory/", () => {
    const cfg = buildGateConfig({ mode: "watch", workspaceDirs: ["/ws"], autoMemoryDir: "/am" });
    expect(cfg.roots).toEqual(["/am", "/ws/MEMORY.md", "/ws/memory"]);
    expect(cfg.rulesFiles).toEqual([
      "/am/MEMORY.md",
      "/ws/AGENTS.md",
      "/ws/SOUL.md",
      "/ws/USER.md",
      "/ws/IDENTITY.md",
      "/ws/MEMORY.md",
    ]);
    expect(cfg.excludeDirs).toContain("archive");
  });

  it("takes configured roots and rule files instead of the defaults", () => {
    const cfg = buildGateConfig({
      mode: "enforce",
      workspaceDirs: ["/ws"],
      autoMemoryDir: null,
      cg: { roots: ["/notes"], rulesFiles: ["/rules.md"], excludeDirs: [] },
    });
    expect(cfg).toMatchObject({
      mode: "enforce",
      roots: ["/notes"],
      rulesFiles: ["/rules.md"],
      excludeDirs: [],
    });
  });
});

describe("the before_tool_call door", () => {
  const hookFor = (w: ReturnType<typeof world>, mode: "enforce" | "watch") =>
    createWriteGateHook({
      config: { mode, roots: [w.mem], rulesFiles: [], excludeDirs: [], claudeProjectMemory: false },
      stateDir: w.state,
      workspaceFor: () => w.mem,
    });

  it("leaves every other tool alone", () => {
    const w = world();
    expect(
      hookFor(w, "enforce")({ toolName: "exec", params: { command: "ls" } }, {}),
    ).toBeUndefined();
  });

  it("blocks a repeat written by a cron in enforce, with the gate's reason", () => {
    const w = world();
    const res = hookFor(w, "enforce")(
      {
        toolName: "write",
        params: {
          path: "dupe.md",
          content:
            "---\nname: dupe\n---\n\n- The weekly team call is on Wednesday at 10:00 with the whole lab.\n",
        },
      },
      { sessionKey: "agent:main:cron:nightly:run:1" },
    );
    expect(res).toMatchObject({ block: true });
    expect(res && "blockReason" in res && res.blockReason).toContain("repeat");
    const row = JSON.parse(
      fs.readFileSync(path.join(w.state, "data", "memory-gate", "gate.jsonl"), "utf8").trim(),
    );
    expect(row).toMatchObject({
      door: "gateway",
      label: "repeat",
      source: "nightly",
      decision: "deny",
    });
  });

  it("returns new params for an edit that changes a fact (old line struck and dated)", () => {
    const w = world();
    const res = hookFor(w, "enforce")(
      {
        toolName: "edit",
        params: {
          path: path.join(w.mem, "weekly_call.md"),
          edits: [
            {
              oldText: "- The weekly team call is on Wednesday at 10:00 with the whole lab.",
              newText: "- The weekly team call is on Thursday at 10:00 with the whole lab.",
            },
          ],
        },
      },
      {},
    );
    const edits = res && "params" in res ? (res.params.edits as Array<{ newText: string }>) : [];
    expect(edits[0]?.newText).toMatch(
      /Thursday.*\n- ~~The weekly team call is on Wednesday.*~~ _\(superseded \d{4}-\d{2}-\d{2}\)_$/s,
    );
  });

  it("only logs in watch", () => {
    const w = world();
    const res = hookFor(w, "watch")(
      {
        toolName: "write",
        params: {
          path: "dupe.md",
          content:
            "---\nname: dupe\n---\n\n- The weekly team call is on Wednesday at 10:00 with the whole lab.\n",
        },
      },
      {},
    );
    expect(res).toBeUndefined();
    const row = JSON.parse(
      fs.readFileSync(path.join(w.state, "data", "memory-gate", "gate.jsonl"), "utf8").trim(),
    );
    expect(row).toMatchObject({ mode: "watch", decision: "would-deny" });
  });
});

describe("register()", () => {
  const savedStateDir = process.env.OPENCLAW_STATE_DIR;
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    w = world();
    process.env.OPENCLAW_STATE_DIR = w.state;
  });
  afterEach(() => {
    if (savedStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = savedStateDir;
    }
  });

  function mockApi(pluginConfig: Record<string, unknown>) {
    const hooks = new Map<string, unknown[]>();
    const api = {
      id: "tinkerclaw-memory-enhancements",
      name: "Memory Enhancements",
      source: "local" as const,
      pluginConfig,
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runtime: { agent: { resolveAgentWorkspaceDir: () => w.base } },
      on: vi.fn((event: string, handler: unknown) => {
        hooks.set(event, [...(hooks.get(event) ?? []), handler]);
      }),
    };
    return { api, hooks };
  }

  const configFile = () => path.join(w.state, "memory-gate", "config.json");
  const base = { hippocampusIndex: { enabled: false }, taskConditionedScoring: { enabled: false } };

  it("publishes the gate config for the Claude Code hook and guards write/edit", async () => {
    const { api, hooks } = mockApi({
      ...base,
      contradictionGate: { mode: "block", roots: [w.mem], rulesFiles: [] },
    });
    const mod = await import("../index.js");
    mod.default.register(api as never);
    expect(JSON.parse(fs.readFileSync(configFile(), "utf8"))).toMatchObject({
      mode: "enforce",
      roots: [w.mem],
    });
    expect(hooks.get("before_tool_call")).toHaveLength(1);
  });

  it("removes the published config and adds no hook when the gate is off", async () => {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), "{}");
    const { api, hooks } = mockApi({ ...base, contradictionGate: { enabled: false } });
    const mod = await import("../index.js");
    mod.default.register(api as never);
    expect(fs.existsSync(configFile())).toBe(false);
    expect(hooks.get("before_tool_call")).toBeUndefined();
  });
});
