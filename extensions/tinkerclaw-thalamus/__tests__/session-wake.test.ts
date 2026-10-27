// The harness wake of a matching past chat and the nightly catalogue refresh (2026-10-25, memory post § "Ask the
// expert agent"): watch decides and records, on wakes only when the pointer is shown, the answer is handed over once,
// and the catalogue is refreshed by the gateway when nobody installed the timer.
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  seedCards,
  shortlistContext,
  type EnhancementCard,
  type PointerHit,
} from "openclaw/plugin-sdk/fork-thalamus";
import { describe, expect, it } from "vitest";
import {
  createCatalogRefresh,
  OVERDUE_MS,
  refreshDue,
  RETRY_MS,
  STALE_MS,
  type CatalogRun,
} from "../src/catalog-refresh.js";
import { parseConfig, type WakeConfig } from "../src/config.js";
import { loadQuestions } from "../src/reads/questions.js";
import { DEFAULT_READER_CONFIG, RoutingReader } from "../src/reads/routing-reader.js";
import {
  createSessionWaker,
  PENDING_MS,
  REPEAT_MS,
  resolveAskSessionScript,
  wakeIdFor,
  wakeQuestion,
  type WakeResultFile,
} from "../src/session-wake.js";
import { createShortlistSeam, type PrepareInput } from "../src/shortlist-seam.js";
import { ThalamusStore } from "../src/store.js";
import { createUseTracker } from "../src/use-tracker.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = "/repo/skills/ask-session/scripts/sessions.py";
const WAKES = "/state/ask-session/wakes";
const T0 = new Date(2026, 9, 25, 14, 2, 12).getTime();

const STRONG: PointerHit = {
  kind: "chat",
  id: "95c8c758-aaaa-bbbb-cccc-ddddeeeeffff",
  label: "Find the form link for the paperwork",
  cover: 0.73,
  terms: 7,
  date: "2026-03-12",
};
const WEAK: PointerHit = { ...STRONG, id: "19769a22-0000", cover: 0.6, terms: 3 };
const NOTE: PointerHit = { kind: "note", id: "/m/n.md", label: "A note", cover: 0.9, terms: 6 };

const wakeCfg = (over: Partial<WakeConfig> = {}): WakeConfig => ({
  ...parseConfig({}).anticipate.wake,
  mode: "on",
  ...over,
});

type FakeChild = EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (s?: NodeJS.Signals | number) => boolean;
  killed: Array<NodeJS.Signals | number>;
};
function fakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.pid = 0;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.killed = [];
  c.kill = (s?: NodeJS.Signals | number) => {
    c.killed.push(s ?? "SIGTERM");
    return true;
  };
  return c;
}

function waker(
  o: {
    cfg?: Partial<WakeConfig>;
    script?: string | undefined;
    files?: string[];
    results?: Record<string, WakeResultFile>;
  } = {},
) {
  let t = T0;
  const spawned: Array<{ cmd: string; args: readonly string[]; child: FakeChild }> = [];
  const files = o.files ?? [];
  const w = createSessionWaker({
    config: () => wakeCfg(o.cfg),
    script: () => ("script" in o ? o.script : SCRIPT),
    wakesDir: () => WAKES,
    now: () => t,
    spawn: (cmd, args) => {
      const child = fakeChild();
      spawned.push({ cmd, args, child });
      return child;
    },
    listWakes: () => files,
    readResult: (p) => o.results?.[p],
  });
  return { w, spawned, files, advance: (ms: number) => (t += ms), at: () => t };
}

describe("resolveAskSessionScript: the skill's own script, from the plugin's folder", () => {
  it("walks up from a checkout or dist folder to skills/ask-session", () => {
    const have = new Set(["/repo/skills/ask-session/scripts/sessions.py"]);
    expect(
      resolveAskSessionScript("/repo/dist/extensions/tinkerclaw-thalamus", {}, (p) => have.has(p)),
    ).toBe(SCRIPT);
    expect(resolveAskSessionScript("/elsewhere/x", {}, (p) => have.has(p))).toBeUndefined();
  });

  it("an OPENCLAW_BUNDLED_SKILLS_DIR override wins, and is not walked past", () => {
    const have = new Set(["/b/ask-session/scripts/sessions.py", SCRIPT]);
    const ex = (p: string) => have.has(p);
    expect(resolveAskSessionScript("/repo/x", { OPENCLAW_BUNDLED_SKILLS_DIR: "/b" }, ex)).toBe(
      "/b/ask-session/scripts/sessions.py",
    );
    expect(
      resolveAskSessionScript("/repo/x", { OPENCLAW_BUNDLED_SKILLS_DIR: "/none" }, ex),
    ).toBeUndefined();
  });

  it("finds the real script in this repository", () => {
    expect(resolveAskSessionScript(join(HERE, ".."))).toMatch(
      /skills\/ask-session\/scripts\/sessions\.py$/,
    );
  });
});

describe("the wake decision", () => {
  it("watch decides as on would and starts nothing", () => {
    const { w, spawned } = waker({ cfg: { mode: "watch" } });
    const r = w.consider({
      sessionKey: "s1",
      hits: [NOTE, STRONG],
      ownText: "the link we used",
      canStart: true,
    });
    expect(r).toEqual({ id: STRONG.id, outcome: "watched" });
    expect(spawned).toHaveLength(0);
  });

  it("off, or no past chat over the bar, decides nothing", () => {
    expect(
      waker({ cfg: { mode: "off" } }).w.consider({
        sessionKey: "s1",
        hits: [STRONG],
        ownText: "x",
        canStart: true,
      }),
    ).toEqual({});
    const { w, spawned } = waker();
    expect(
      w.consider({ sessionKey: "s1", hits: [NOTE, WEAK], ownText: "x", canStart: true }),
    ).toEqual({});
    expect(spawned).toHaveLength(0);
  });

  it("on wakes only when the pointer is shown", () => {
    const { w, spawned } = waker();
    expect(
      w.consider({ sessionKey: "s1", hits: [STRONG], ownText: "q", canStart: false }).outcome,
    ).toBe("watched");
    expect(spawned).toHaveLength(0);
  });

  it("on starts the skill's own ask with the owner's prompt and says how to read the answer", () => {
    const { w, spawned } = waker();
    const r = w.consider({
      sessionKey: "s1",
      hits: [STRONG],
      ownText: "get me the link we used last time",
      canStart: true,
    });
    const wakeId = wakeIdFor(STRONG.id, T0);
    expect(wakeId).toBe("20261025-140212-95c8c758");
    expect(r.outcome).toBe("started");
    expect(r.line).toContain("session 95c8c758");
    expect(r.line).toContain(`python3 -I ${SCRIPT} answer ${wakeId}`);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].cmd).toBe("python3");
    expect(spawned[0].args).toEqual([
      "-I",
      SCRIPT,
      "ask",
      STRONG.id,
      wakeQuestion("get me the link we used last time"),
      "--json",
      "--wake-id",
      wakeId,
      "--timeout",
      "110",
    ]);
    expect(wakeQuestion("q")).toContain("«q»");
    expect(wakeQuestion("x".repeat(5000)).length).toBeLessThan(1800);
  });

  it("never the same past chat twice for one chat, one wake at a time, and a follow-up has no question", () => {
    const { w, spawned, advance } = waker();
    const go = (sessionKey: string, ownText: string | undefined) =>
      w.consider({ sessionKey, hits: [STRONG], ownText, canStart: true }).outcome;
    expect(go("s1", "the link")).toBe("started");
    expect(go("s1", "the link")).toBe("repeat");
    expect(go("s2", undefined)).toBe("follow-up");
    advance(REPEAT_MS + 1);
    expect(go("s1", "the link")).toBe("started");
    expect(spawned).toHaveLength(2);
    const other: PointerHit = { ...STRONG, id: "aaaaaaaa-1111" };
    expect(
      w.consider({ sessionKey: "s1", hits: [other], ownText: "x", canStart: true }).outcome,
    ).toBe("busy");
  });

  it("the daily cap is counted from today's result files on disk; no script, no wake", () => {
    const today = wakeIdFor("x", T0).slice(0, 8);
    const files = [
      `${today}-090000-aaaaaaaa.json`,
      `${today}-100000-bbbbbbbb.json`,
      "20261024-230000-cccccccc.json",
      `${today}-110000-dddddddd.json.123.tmp`,
    ];
    const capped = waker({ cfg: { dailyCap: 2 }, files });
    expect(
      capped.w.consider({ sessionKey: "s1", hits: [STRONG], ownText: "x", canStart: true }).outcome,
    ).toBe("capped");
    expect(capped.w.stats()).toEqual({ today: 2, pending: 0 });
    const none = waker({ script: undefined });
    expect(
      none.w.consider({ sessionKey: "s1", hits: [STRONG], ownText: "x", canStart: true }).outcome,
    ).toBe("no-script");
  });
});

describe("handing the answer over", () => {
  const started = (results: Record<string, WakeResultFile>) => {
    const h = waker({ results });
    h.w.consider({ sessionKey: "s1", hits: [STRONG], ownText: "the link", canStart: true });
    return { ...h, file: join(WAKES, `${wakeIdFor(STRONG.id, T0)}.json`) };
  };

  it("a finished, unread answer is handed over once, as testimony", () => {
    const results: Record<string, WakeResultFile> = {};
    const h = started(results);
    results[h.file] = { state: "running" };
    expect(h.w.collect("s1")).toBeUndefined();
    results[h.file] = {
      state: "done",
      text: "Session 95c8c758 (2026-03-12) says:\n\nhttps://sede.example/form-123",
    };
    const block = h.w.collect("s1");
    expect(block).toContain("It is testimony");
    expect(block).toContain("https://sede.example/form-123");
    expect(h.w.collect("s1")).toBeUndefined();
    expect(h.w.collect("other")).toBeUndefined();
  });

  it("an answer the agent already read, a refusal, a failure or a stale wake is dropped", () => {
    for (const r of [
      { state: "done", text: "x", read_at: "2026-10-25T12:00:00+00:00" },
      { state: "refused", refused: "refused: a running process holds this session" },
      { state: "failed" },
    ] as WakeResultFile[]) {
      const results: Record<string, WakeResultFile> = {};
      const h = started(results);
      results[h.file] = r;
      expect(h.w.collect("s1")).toBeUndefined();
      expect(h.w.stats().pending).toBe(0);
    }
    const results: Record<string, WakeResultFile> = {};
    const h = started(results);
    results[h.file] = { state: "running" };
    h.advance(PENDING_MS + 1);
    expect(h.w.collect("s1")).toBeUndefined();
    expect(h.w.stats().pending).toBe(0);
  });

  it("stop() ends the wakes still running", () => {
    const h = waker();
    h.w.consider({ sessionKey: "s1", hits: [STRONG], ownText: "x", canStart: true });
    h.w.stop();
    expect(h.spawned[0].child.killed).toEqual(["SIGTERM"]);
  });
});

// The seam, with the waker in place: what the agent reads and what the ledger keeps.
const questions = loadQuestions(join(HERE, "..", "questions"));
const cards: EnhancementCard[] = seedCards([
  { kind: "skill", name: "form-filler", path: "/s/ff/SKILL.md", description: "Fills a web form." },
]);
const byId = new Map(cards.map((c) => [c.id, c]));
const input = (over: Partial<PrepareInput> = {}): PrepareInput => ({
  id: "t1",
  runId: "run-1",
  ts: 1,
  sessionKey: "agent:main:tinker:abc",
  text: "Get me the link to the paperwork form we used last time, the one for the yearly filing.",
  source: "tinker",
  trigger: "user",
  ...over,
});

function seamWith(wakeMode: "watch" | "on", results: Record<string, WakeResultFile> = {}) {
  const store = new ThalamusStore(":memory:");
  const tracker = createUseTracker({
    store: () => store,
    cards: () => byId,
    attribute: () => [],
    now: () => 1,
    mode: () => "enforce",
  });
  const h = waker({ cfg: { mode: wakeMode }, results });
  const seam = createShortlistSeam({
    reader: new RoutingReader({
      questions,
      cards: () => cards,
      config: { ...DEFAULT_READER_CONFIG },
    }),
    cards: () => cards,
    mode: () => "enforce",
    budgetMs: () => 500,
    tracker,
    pointers: { mode: () => "inject", find: () => ({ notes: [], chats: [STRONG] }) },
    wake: h.w,
  });
  return { seam, tracker, store, ...h };
}

describe("the seam with the wake leg", () => {
  it("on: the note says the answer is on its way, and the ledger row says the wake started", async () => {
    const { seam, tracker, store, spawned } = seamWith("on");
    const out = await seam.prepare(input());
    expect(spawned).toHaveLength(1);
    expect(out.wake?.outcome).toBe("started");
    const lines = out.text?.split("\n") ?? [];
    expect(lines.at(-1)).toBe("None of these may fit; use your own judgment.");
    expect(lines.at(-2)).toContain("The harness is already asking that past chat");
    expect(out.text).toContain('- past chat 2026-03-12: "Find the form link for the paperwork"');
    tracker.finish("run-1", "done");
    expect(store.getUse("run-1")?.pointers).toEqual([
      { kind: "chat", id: STRONG.id, cover: 0.73, terms: 7, injected: true, wake: "started" },
    ]);
  });

  it("the next turn of that chat gets the unread answer on top of its note", async () => {
    const results: Record<string, WakeResultFile> = {};
    const { seam } = seamWith("on", results);
    await seam.prepare(input());
    results[join(WAKES, `${wakeIdFor(STRONG.id, T0)}.json`)] = {
      state: "done",
      text: "Session 95c8c758 (2026-03-12) says:\n\nhttps://sede.example/form-123",
    };
    const next = await seam.prepare(
      input({ runId: "run-2", text: "and fill it in for me please, same as last year" }),
    );
    expect(
      next.text?.startsWith("A past chat the harness woke for your previous prompt has answered."),
    ).toBe(true);
    expect(next.text).toContain("form-123");
    const third = await seam.prepare(
      input({ runId: "run-3", text: "thanks, now the other form for the yearly filing" }),
    );
    expect(third.text ?? "").not.toContain("form-123");
  });

  it("watch: the note is exactly what it was, and the ledger row says watched", async () => {
    const { seam, tracker, store, spawned } = seamWith("watch");
    const out = await seam.prepare(input());
    expect(spawned).toHaveLength(0);
    expect(out.text).toBe(
      shortlistContext(out.list, byId, [
        { kind: "chat", label: STRONG.label, where: STRONG.id, date: "2026-03-12" },
      ]),
    );
    tracker.finish("run-1", "done");
    expect(store.getUse("run-1")?.pointers?.[0]?.wake).toBe("watched");
  });
});

describe("the catalogue keeps itself", () => {
  const H = 3_600_000;
  it("is due once when missing, nightly when a day old, at any hour when two days old", () => {
    const now = T0;
    expect(refreshDue({ now, localHour: 14, catalogExists: false, stampAt: undefined })).toEqual({
      why: "first",
      args: ["catalog"],
    });
    expect(
      refreshDue({ now, localHour: 3, catalogExists: true, stampAt: now - 2 * H }),
    ).toBeUndefined();
    expect(refreshDue({ now, localHour: 3, catalogExists: true, stampAt: now - STALE_MS })).toEqual(
      {
        why: "nightly",
        args: ["catalog", "--since", "2"],
      },
    );
    expect(
      refreshDue({ now, localHour: 14, catalogExists: true, stampAt: now - STALE_MS }),
    ).toBeUndefined();
    expect(
      refreshDue({ now, localHour: 14, catalogExists: true, stampAt: now - 5 * 24 * H }),
    ).toEqual({
      why: "overdue",
      args: ["catalog", "--since", "6"],
    });
    expect(refreshDue({ now, localHour: 3, catalogExists: true, stampAt: undefined })).toEqual({
      why: "overdue",
      args: ["catalog", "--since", "3"],
    });
    expect(OVERDUE_MS).toBeGreaterThan(STALE_MS);
  });

  function refresher(
    o: { path?: string; exists?: boolean; stampAt?: number; code?: number; hour?: number } = {},
  ) {
    let t = T0;
    const runs: string[][] = [];
    const r = createCatalogRefresh({
      enabled: () => true,
      script: () => SCRIPT,
      catalogPath: () => o.path ?? "/state/ask-session/catalog.sqlite",
      defaultPath: () => "/state/ask-session/catalog.sqlite",
      now: () => t,
      localHour: () => o.hour ?? 3,
      exists: () => o.exists ?? true,
      mtime: (p) => (p === "/state/ask-session/catalog.stamp" ? o.stampAt : undefined),
      run: async (python, args): Promise<CatalogRun> => {
        runs.push([python, ...args]);
        return { code: o.code ?? 0, out: "catalog: 3 session files seen, 1 (re)indexed\n" };
      },
    });
    return { r, runs, advance: (ms: number) => (t += ms) };
  }

  it("runs the skill's incremental scan and records how it ended", async () => {
    const { r, runs } = refresher({ stampAt: T0 - 21 * H });
    await r.tick();
    expect(runs).toEqual([["python3", "-I", SCRIPT, "catalog", "--since", "2"]]);
    expect(r.stats()).toMatchObject({ running: false, last: { why: "nightly", ok: true } });
    expect(r.stats().last?.line).toContain("1 (re)indexed");
  });

  it("builds a missing catalogue once, and waits an hour after a failure", async () => {
    const { r, runs, advance } = refresher({ exists: false, code: 1 });
    await r.tick();
    expect(runs).toEqual([["python3", "-I", SCRIPT, "catalog"]]);
    expect(r.stats().last?.ok).toBe(false);
    expect(r.tick()).toBeUndefined();
    advance(RETRY_MS);
    await r.tick();
    expect(runs).toHaveLength(2);
  });

  it("never touches a custom catalogue, and leaves a fresh one alone", () => {
    expect(refresher({ path: "/mine/chats.sqlite", exists: false }).r.tick()).toBeUndefined();
    expect(refresher({ stampAt: T0 - H }).r.tick()).toBeUndefined();
  });
});

describe("config: the wake and the refresh", () => {
  const manifest = JSON.parse(readFileSync(join(HERE, "..", "openclaw.plugin.json"), "utf8")) as {
    configSchema: {
      properties: {
        anticipate: {
          properties: {
            refreshCatalog: { default: unknown };
            wake: { properties: Record<string, { default?: unknown }> };
          };
        };
      };
    };
  };

  it("defaults to watch and a refreshing catalogue, the same as the manifest says", () => {
    const c = parseConfig({}).anticipate;
    expect(c.wake).toEqual({
      mode: "watch",
      minCover: 0.65,
      minTerms: 5,
      dailyCap: 5,
      timeoutS: 110,
    });
    expect(c.refreshCatalog).toBe(true);
    const m = manifest.configSchema.properties.anticipate.properties;
    expect(m.refreshCatalog.default).toBe(true);
    for (const [k, v] of Object.entries(c.wake)) {
      expect(m.wake.properties[k]?.default).toBe(v);
    }
  });

  it("a misspelt mode is off, and the numbers stay in range", () => {
    const c = parseConfig({
      anticipate: { wake: { mode: "yes", minCover: 0.1, minTerms: 1, dailyCap: 900, timeoutS: 5 } },
    }).anticipate.wake;
    expect(c).toEqual({ mode: "off", minCover: 0.45, minTerms: 3, dailyCap: 50, timeoutS: 20 });
    expect(parseConfig({ anticipate: { refreshCatalog: false } }).anticipate.refreshCatalog).toBe(
      false,
    );
  });
});
