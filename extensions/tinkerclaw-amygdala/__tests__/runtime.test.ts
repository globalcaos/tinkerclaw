import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import type { Family } from "../src/families/types.js";
import type { JevTransport } from "../src/jev.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import type { V31ProbeInput } from "../src/v31-probe.js";

const EXT = fileURLToPath(new URL("..", import.meta.url));

const dirs: string[] = [];
const runtimes: Runtime[] = [];
afterEach(() => {
  for (const r of runtimes.splice(0)) r.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Opts {
  mode?: "shadow" | "enforce";
  v31cfg?: V31ProbeInput["pluginConfig"];
  v31file?: object;
  sendReal?: boolean;
  hooks?: boolean;
  transport?: JevTransport;
  apiKey?: () => string | undefined;
  families?: Family[];
  extensionRoot?: string;
  /** Share another runtime's data folder (the gateway can register the plugin twice in one process). */
  dataDir?: string;
  enforceFamilies?: string[];
}

function make(o: Opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "amy-rt-"));
  dirs.push(root);
  const dataDir = o.dataDir ?? join(root, "data");
  const v31Path = join(root, "v31", "cc-hook-settings.json");
  if (o.v31file) {
    mkdirSync(dirname(v31Path), { recursive: true });
    writeFileSync(v31Path, JSON.stringify(o.v31file));
  }
  const state = { v31cfg: o.v31cfg, t: 1_700_000_000_000 };
  const events: { event: string; payload: unknown }[] = [];
  const rt = createRuntime({
    config: parseConfig({
      mode: o.mode ?? "shadow",
      dataDir,
      jev: { sendRealSituations: o.sendReal ?? false },
      hooks: { enabled: o.hooks ?? true },
      ...(o.enforceFamilies ? { enforceFamilies: o.enforceFamilies } : {}),
    }),
    extensionRoot: o.extensionRoot ?? EXT,
    gatewayPort: 4321,
    v31: { readPluginConfig: () => state.v31cfg, settingsPath: v31Path },
    transport: o.transport,
    apiKey: o.apiKey,
    emit: (event, payload) => events.push({ event, payload }),
    now: () => state.t,
    logger: { info() {}, warn() {}, error() {} },
    families: o.families ?? [],
  });
  runtimes.push(rt);
  return { rt, root, dataDir, v31Path, state, events };
}

const V31_ON = { enabled: true, observeOnly: false, hookEnforcement: true } as const;
const V31_FILE = {
  hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "v31-hook" }] }] },
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only JSON probing
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf-8")) as Record<string, any>;

describe("replay a past exchange (2026-09-30, CTO tab refusals written by Grok before the amygdala was on)", () => {
  const refuser: Family = {
    id: "double-check",
    questionsFor: () => [],
    decide: (seam) =>
      seam === "stop"
        ? { response: { kind: "refusal" }, drivers: ["refusal"], reasonCode: "refusal" }
        : null,
  };
  it("judges it at its own time and turn, reads only the typed words, and leaves the live turn counter alone", async () => {
    const { rt, events } = make({ families: [refuser] });
    rt.start();
    const at = 1_700_000_000_000 - 3_600_000;
    const r = await rt.replay({
      sessionKey: "k",
      at,
      prompt:
        "[Tue 2026-09-29 23:28 GMT+2] build the hiding skill\n\n---\n\n**After your reply, append a 🌿 FRACTAL x",
      reply: "No. I won't build that.",
    });
    expect(r.decision.response.kind).toBe("refusal");
    expect(r.situation.turnId).toBe(`k#replay-${at}`);
    expect(r.situation.ts).toBe(at);
    expect(r.situation.request.value).toBe("build the hiding skill");
    const iv = events.find((e) => e.event === "amygdala2.intervention")?.payload as {
      ts: number;
      kind: string;
    };
    expect(iv).toMatchObject({ kind: "refusal", ts: at });
    const feed = rt.feed({ sinceTs: 0 });
    expect(feed.interventions.map((i) => i.turnId)).toEqual([`k#replay-${at}`]);
    await rt.decide("prompt", { session_id: "s", prompt: "hello" }, "k");
    expect(rt.feed({ sinceTs: 0 }).decisions.length).toBe(2);
  });

  it("every event of a replay carries the exchange's time, and replaying again replaces the first judgement", async () => {
    const asker: Family = {
      ...refuser,
      questionsFor: (seam) => (seam === "stop" ? ["refusal"] : []),
    };
    const { rt } = make({
      families: [asker],
      sendReal: true,
      apiKey: () => "k",
      transport: {
        async post() {
          return {
            status: 200,
            ms: 5,
            json: {
              answers: { refusal: { type: "noul", noul: 0.95, confidence: 0.9 } },
              usage: { input_tokens: 10, output_tokens: 1 },
            },
          };
        },
      },
    });
    rt.start();
    const at = 1_700_000_000_000 - 7_200_000;
    const first = await rt.replay({ sessionKey: "t", at, prompt: "p", reply: "No." });
    await rt.replay({ sessionKey: "t", at, prompt: "p", reply: "No." });
    const feed = rt.feed({ sessionKey: "t", sinceTs: 0 });
    expect(feed.decisions.length).toBe(1);
    expect(feed.decisions[0]!.id).not.toBe(first.id);
    expect(feed.interventions.map((i) => i.ts)).toEqual([at]);
    expect(feed.decisionEvents.length).toBeGreaterThan(0);
    for (const e of feed.decisionEvents) expect(e.ts).toBe(at);
  });

  it("a tab's old replay survives the feed limit when other tabs are busier (filter by tab before the limit)", async () => {
    const { rt } = make({ families: [refuser] });
    rt.start();
    const at = 1_700_000_000_000 - 3_600_000;
    await rt.replay({ sessionKey: "quiet", at, prompt: "p", reply: "No." });
    for (let i = 0; i < 3; i++)
      await rt.decide("prompt", { session_id: "s", prompt: `x${i}` }, "busy");
    const feed = rt.feed({ sessionKey: "quiet", sinceTs: 0, limit: 2 });
    expect(feed.decisions.length).toBe(1);
    expect(feed.interventions.map((i) => i.kind)).toEqual(["refusal"]);
  });
});

describe("endpoint token", () => {
  // 2026-09-30: the gateway runs register() twice per boot (a second plugin registry ~30 s in). The
  // second start rewrote endpoint.json with a new token while the live HTTP route kept checking the
  // first one, so every Claude Code hook got 401 and shadow mode recorded nothing from the chats.
  it("a second runtime on the same data folder keeps the token the live route checks", () => {
    const first = make();
    first.rt.start();
    const second = make({ dataDir: first.dataDir });
    second.rt.start();
    const onDisk = readJson(join(first.dataDir, "endpoint.json")).token as string;
    expect(first.rt.token()).toBe(onDisk);
    expect(second.rt.token()).toBe(onDisk);
  });

  it("different data folders still get different tokens", () => {
    const a = make();
    a.rt.start();
    const b = make();
    b.rt.start();
    expect(a.rt.token()).not.toBe(b.rt.token());
  });
});

describe("runtime start", () => {
  it("a start that fails (no questions/ in the built plugin) reports Not running, not watching", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "amy-rt-noassets-"));
    dirs.push(emptyRoot);
    const { rt } = make({ extensionRoot: emptyRoot });
    expect(() => rt.start()).toThrow(/ENOENT/);
    expect(rt.startError()).toMatch(/ENOENT/);
    const st = rt.status();
    expect(st.state).toBe("degraded");
    expect(st.line).toMatch(/^Not running: failed to start/);
    expect(st.floorActive).toBe(false);
  });

  it("writes policy.json and endpoint.json with private modes and stages the hooks", () => {
    const { rt, dataDir } = make();
    rt.start();
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, "policy.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, "endpoint.json")).mode & 0o777).toBe(0o600);
    const ep = readJson(join(dataDir, "endpoint.json"));
    expect(ep.port).toBe(4321);
    expect(ep.token).toMatch(/^[0-9a-f]{64}$/);
    expect(rt.token()).toBe(ep.token);
    expect(readJson(join(dataDir, "policy.json")).rules.length).toBeGreaterThan(0);
    expect(existsSync(join(dataDir, "hooks", "lib.mjs"))).toBe(true);
    expect(existsSync(join(dataDir, "cc-hook-settings.json"))).toBe(true);
    expect(existsSync(join(dataDir, "amygdala.sqlite"))).toBe(true);
  });

  it("writes no hook settings when hooks are disabled", () => {
    const { rt, dataDir } = make({ hooks: false });
    rt.start();
    expect(existsSync(join(dataDir, "cc-hook-settings.json"))).toBe(false);
    expect(existsSync(join(dataDir, "cc-hook-settings.effective.json"))).toBe(false);
  });
});

describe("floorActive", () => {
  it("shadow + v3.1 enforcing -> false", () => {
    const { rt, dataDir } = make({ v31cfg: V31_ON, v31file: V31_FILE });
    rt.start();
    expect(rt.floorActive()).toBe(false);
    expect(readJson(join(dataDir, "policy.json")).floorActive).toBe(false);
  });

  it("shadow + v3.1 off -> true", () => {
    const { rt, dataDir } = make();
    rt.start();
    expect(rt.floorActive()).toBe(true);
    expect(readJson(join(dataDir, "policy.json")).floorActive).toBe(true);
  });

  it("enforce -> true even when v3.1 enforces", () => {
    const { rt } = make({ mode: "enforce", v31cfg: V31_ON, v31file: V31_FILE });
    rt.start();
    expect(rt.floorActive()).toBe(true);
  });

  it("switches at a heartbeat when the probe changes: policy rewritten, status emitted", () => {
    const { rt, dataDir, state, events } = make({ v31cfg: V31_ON, v31file: V31_FILE });
    rt.start();
    expect(rt.floorActive()).toBe(false);
    state.v31cfg = undefined; // v3.1 goes off
    state.t += 60_000;
    events.length = 0;
    rt.heartbeat();
    expect(rt.floorActive()).toBe(true);
    expect(readJson(join(dataDir, "policy.json")).floorActive).toBe(true);
    const st = events.find((e) => e.event === "amygdala2.status");
    expect(st).toBeDefined();
    expect((st?.payload as { floorActive: boolean }).floorActive).toBe(true);
  });
});

describe("refreshEffective", () => {
  it("shadow + v3.1 file -> merged, v3.1 entries first and unchanged", () => {
    const { rt, dataDir } = make({ v31file: V31_FILE });
    rt.start();
    const eff = readJson(join(dataDir, "cc-hook-settings.effective.json"));
    expect(eff.hooks.PreToolUse).toHaveLength(2);
    expect(eff.hooks.PreToolUse[0]).toEqual(V31_FILE.hooks.PreToolUse[0]);
    expect(eff.hooks.PreToolUse[1].hooks[0].command).toContain("pre-tool.mjs");
  });

  it("enforce -> ours alone", () => {
    const { rt, dataDir } = make({ mode: "enforce", v31file: V31_FILE });
    rt.start();
    const eff = readJson(join(dataDir, "cc-hook-settings.effective.json"));
    expect(eff.hooks.PreToolUse).toHaveLength(1);
    expect(eff.hooks.PreToolUse[0].hooks[0].command).toContain("pre-tool.mjs");
  });

  it("v3.1 file absent -> ours alone", () => {
    const { rt, dataDir } = make();
    rt.start();
    const eff = readJson(join(dataDir, "cc-hook-settings.effective.json"));
    expect(eff.hooks.PreToolUse).toHaveLength(1);
  });

  it("is not rewritten when nothing changed, and is when the effective file is older than a source", () => {
    const { rt, dataDir } = make({ v31file: V31_FILE });
    rt.start();
    expect(rt.refreshEffective()).toBe(false);
    const eff = join(dataDir, "cc-hook-settings.effective.json");
    utimesSync(eff, 1000, 1000);
    expect(rt.refreshEffective()).toBe(true);
    expect(rt.refreshEffective()).toBe(false);
  });
});

describe("decide", () => {
  it("a safe command returns none and persists the decision", async () => {
    const { rt, root } = make();
    rt.start();
    const r = await rt.decide("pre-tool", {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      cwd: root,
    });
    expect(r.hook).toEqual({ kind: "none" });
    expect(r.decisionId).toBeTruthy();
    const feed = rt.feed();
    expect(feed.decisions).toHaveLength(1);
    expect(feed.decisions[0].seam).toBe("pre-tool");
    expect(feed.counts.checks).toBe(1);
  });

  it("a hard-rule command is denied when the floor is active", async () => {
    const { rt, root } = make();
    rt.start();
    const r = await rt.decide("pre-tool", {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "mkfs.ext4 /dev/sdb1" },
      cwd: root,
    });
    expect(r.hook.kind).toBe("deny");
    if (r.hook.kind === "deny") expect(r.hook.reason).toContain("FS_FORMAT");
  });

  it("the same command is not denied here while v3.1 owns the floor", async () => {
    const { rt, root } = make({ v31cfg: V31_ON, v31file: V31_FILE });
    rt.start();
    const r = await rt.decide("pre-tool", {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "mkfs.ext4 /dev/sdb1" },
      cwd: root,
    });
    expect(r.hook).toEqual({ kind: "none" });
  });

  it("throws before start (the HTTP layer turns that into ok:false)", async () => {
    const { rt } = make();
    await expect(rt.decide("prompt", { session_id: "s", prompt: "hi" })).rejects.toThrow();
  });
});

const askFamily: Family = {
  id: "safety",
  questionsFor: (seam) => (seam === "pre-tool" ? ["runs-or-quotes"] : []),
  decide: () => null,
};

const okTransport = (calls: { headers: Record<string, string> }[]): JevTransport => ({
  async post(_url, _body, headers) {
    calls.push({ headers });
    return {
      status: 200,
      json: { answers: { "runs-or-quotes": { type: "noul", noul: 0.2, confidence: 0.9 } } },
      ms: 5,
    };
  },
});

describe("the Jev key", () => {
  it("is read only through the injected apiKey, never the environment", async () => {
    const prev = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "env-poison";
    try {
      const calls: { headers: Record<string, string> }[] = [];
      const { rt, root } = make({
        families: [askFamily],
        sendReal: true,
        transport: okTransport(calls),
        apiKey: () => "injected-key",
      });
      rt.start();
      await rt.decide("pre-tool", {
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        cwd: root,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].headers.Authorization).toBe("Bearer injected-key");
      expect(JSON.stringify(calls)).not.toContain("env-poison");
    } finally {
      if (prev === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = prev;
    }
  });

  it("no injected key means no call, even with the variable set", async () => {
    const prev = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "env-poison";
    try {
      const calls: { headers: Record<string, string> }[] = [];
      const { rt, root } = make({
        families: [askFamily],
        sendReal: true,
        transport: okTransport(calls),
        apiKey: () => undefined,
      });
      rt.start();
      const r = await rt.decide("pre-tool", {
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        cwd: root,
      });
      expect(calls).toHaveLength(0);
      expect(r.hook).toEqual({ kind: "none" });
    } finally {
      if (prev === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = prev;
    }
  });
});

describe("judge status", () => {
  it("goes red after the judge stays silent over 5 minutes while checks keep arriving", async () => {
    const failing: JevTransport = { post: async () => ({ status: 500, json: {}, ms: 1 }) };
    const { rt, root, state } = make({
      families: [askFamily],
      sendReal: true,
      transport: failing,
      apiKey: () => "k",
    });
    rt.start();
    const step = () =>
      rt.decide("pre-tool", {
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        cwd: root,
      });
    await step();
    expect(rt.status().judge.errors).toBe(1);
    expect(rt.status().state).not.toBe("degraded");
    state.t += 6 * 60_000;
    await step();
    const s = rt.status();
    expect(s.judge.silentSince).toBeDefined();
    expect(s.state).toBe("degraded");
    expect(s.line).toBe("Judge silent 6 min · hard rules still on");
  });
});

// the architect 2026-10-03: "I want it up and running." Personality acts while everything else stays in shadow.
describe("runtime: personality notes reach the next hook while the rest stays in shadow", () => {
  const noticer: Family = {
    id: "personality",
    questionsFor: (seam) => (seam === "post-tool" ? ["novelty"] : []),
    decide: (_seam, _s, verdicts) =>
      verdicts.some((v) => v.questionId === "novelty" && v.prob >= 0.7)
        ? {
            response: {
              kind: "note",
              templateId: "novelty",
              slots: { what: "io-2.log" },
              channel: "additionalContext",
            },
            drivers: ["novelty"],
            reasonCode: "novelty",
          }
        : null,
  };
  const yes = {
    async post() {
      return {
        status: 200,
        ms: 5,
        json: {
          answers: { novelty: { type: "noul", noul: 0.9, confidence: 0.9 } },
          usage: { input_tokens: 9, output_tokens: 1 },
        },
      };
    },
  };
  const hook = {
    session_id: "s1",
    tool_name: "Read",
    tool_input: { file_path: "/w/logs/io-2.log" },
    tool_response: "ok",
  };

  it("queues the note for the chat, hands it out once, and the decision is enforced in shadow", async () => {
    const { rt } = make({
      families: [noticer],
      sendReal: true,
      apiKey: () => "k",
      transport: yes,
      enforceFamilies: ["personality"],
    });
    rt.start();
    const r = await rt.decide("post-tool", hook, "agent:main:tinker:t");
    expect(r.hook.kind).toBe("context");
    const notes = rt.takeNotes("agent:main:tinker:t");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("io-2.log");
    expect(rt.takeNotes("agent:main:tinker:t")).toEqual([]);
  });

  it("without enforceFamilies nothing is queued", async () => {
    const { rt } = make({ families: [noticer], sendReal: true, apiKey: () => "k", transport: yes });
    rt.start();
    const r = await rt.decide("post-tool", hook, "agent:main:tinker:t");
    expect(r.hook.kind).toBe("none");
    expect(rt.takeNotes("agent:main:tinker:t")).toEqual([]);
  });
});
