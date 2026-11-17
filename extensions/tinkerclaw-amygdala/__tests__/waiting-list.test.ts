import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import type { InterventionEvent } from "../src/events.js";
import type { Family } from "../src/families/types.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { WAITING_FILE, WaitingList, type WaitingEntry } from "../src/waiting-list.js";

// 2026-11-13. A held step asked its question only in the chat it ran in. The owner was working in Zen Mail, the
// five-minute wait ran out unseen and an Allow sat for eight hours. The questions are now kept in a file any screen
// can read: live while a hook waits, then as expired ones his `allow <grant>` answers.

const dirs: string[] = [];
const runtimes: Runtime[] = [];
afterEach(() => {
  for (const r of runtimes.splice(0)) {
    r.stop();
  }
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "amy-wait-"));
  dirs.push(d);
  return d;
};
const readEntries = (path: string): WaitingEntry[] =>
  (JSON.parse(readFileSync(path, "utf8")) as { entries: WaitingEntry[] }).entries;

const event = (id: string, o: Partial<InterventionEvent> = {}): InterventionEvent => ({
  id,
  ts: 1000,
  sessionKey: "agent:main:tinker:t1",
  turnId: "t#1",
  kind: "hold",
  state: "open",
  title: "Held before it ran",
  chips: [],
  cmd: "openclaw message send -t +34600000000 -m hi",
  sentence: "Sending a first WhatsApp message.",
  ask: "Allow a first message to this person?",
  rule: "first-contact",
  grant: "JEV-AAA111",
  ...o,
});

describe("WaitingList", () => {
  it("keeps the question in plain words and never the command", () => {
    const path = join(tmp(), WAITING_FILE);
    const list = new WaitingList({ path, now: () => 1000 });
    list.add(event("i1"), 301_000);
    const [e] = readEntries(path);
    expect(e).toMatchObject({
      id: "i1",
      state: "waiting",
      kind: "hold",
      ask: "Allow a first message to this person?",
      sentence: "Sending a first WhatsApp message.",
      grant: "JEV-AAA111",
      expiresTs: 301_000,
    });
    expect(JSON.stringify(e)).not.toContain("openclaw message send");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("an answer removes it; a wait that ran out stays as expired for a day", () => {
    let t = 1000;
    const path = join(tmp(), WAITING_FILE);
    const list = new WaitingList({ path, now: () => t });
    list.add(event("i1"), 301_000);
    list.add(event("i2", { grant: "JEV-BBB222" }), 301_000);
    expect(list.remove("i1")).toBe(true);
    list.expire("i2");
    expect(readEntries(path).map((e) => [e.id, e.state])).toEqual([["i2", "expired"]]);
    t = 301_000 + 23 * 3_600_000;
    expect(list.list()).toHaveLength(1);
    t = 301_000 + 25 * 3_600_000;
    expect(list.list()).toEqual([]);
  });

  it("a wait nobody closed is expired by the clock", () => {
    let t = 1000;
    const list = new WaitingList({ path: join(tmp(), WAITING_FILE), now: () => t });
    list.add(event("i1"), 301_000);
    t = 400_000;
    expect(list.get("i1")?.state).toBe("expired");
  });

  it("his allow in that chat settles the question, in that chat only", () => {
    const list = new WaitingList({ path: join(tmp(), WAITING_FILE), now: () => 1000 });
    list.add(event("i1"), 301_000);
    list.add(event("i2", { sessionKey: "agent:main:main" }), 301_000);
    expect(list.removeGrant("agent:main:tinker:t1", "jev-aaa111")).toBe(1);
    expect(list.list().map((e) => e.id)).toEqual(["i2"]);
  });

  it("a new question for the same goal replaces the old one, and only holds and asks are kept", () => {
    const list = new WaitingList({ path: join(tmp(), WAITING_FILE), now: () => 1000 });
    list.add(event("i1"), 301_000);
    list.add(event("i2"), 302_000);
    list.add(event("i3", { kind: "proof", grant: "JEV-CCC333" }), 302_000);
    expect(list.list().map((e) => e.id)).toEqual(["i2"]);
  });

  it("after a restart a waiting question comes back as expired; a broken file starts empty", () => {
    const path = join(tmp(), WAITING_FILE);
    new WaitingList({ path, now: () => 1000 }).add(event("i1"), 301_000);
    const next = new WaitingList({ path, now: () => 2000 });
    next.restore();
    expect(next.list().map((e) => [e.id, e.state])).toEqual([["i1", "expired"]]);
    writeFileSync(path, "{not json");
    const broken = new WaitingList({ path, now: () => 2000 });
    broken.restore();
    expect(broken.list()).toEqual([]);
  });
});

const EXT = fileURLToPath(new URL("..", import.meta.url));
const holds: Family = {
  id: "safety",
  questionsFor: () => [],
  decide: (seam) =>
    seam === "pre-tool"
      ? {
          response: { kind: "hold", ruleOrQuestion: "first-contact", releasable: "user-only" },
          drivers: ["first-contact"],
          reasonCode: "first-contact",
        }
      : null,
};

function runtime(dataDir = join(tmp(), "data")) {
  const state = { t: 1_700_000_000_000 };
  const rt = createRuntime({
    config: parseConfig({ mode: "enforce", dataDir, hooks: { enabled: true } }),
    extensionRoot: EXT,
    gatewayPort: 4321,
    v31: { readPluginConfig: () => undefined, settingsPath: join(dataDir, "no-v31.json") },
    emit: () => {},
    now: () => state.t,
    logger: { info() {}, warn() {}, error() {} },
    families: [holds],
    explainDelayMs: 0,
  });
  runtimes.push(rt);
  rt.start();
  return { rt, state, file: join(dataDir, WAITING_FILE), dataDir };
}

const CHAT = "agent:main:tinker:t1";
const held = async (rt: Runtime, session = CHAT): Promise<string> => {
  const r = await rt.decide(
    "pre-tool",
    { session_id: "s", tool_name: "Bash", tool_input: { command: "echo hi" } },
    session,
  );
  if (r.hook.kind !== "wait") {
    throw new Error(`expected a wait, got ${r.hook.kind}`);
  }
  return r.hook.interventionId;
};

describe("the runtime keeps the waiting list in step", () => {
  it("a held step is listed while it waits, and his answer takes it off", async () => {
    const { rt, file } = runtime();
    const id = await held(rt);
    expect(readEntries(file)).toMatchObject([
      { id, state: "waiting", sessionKey: CHAT, kind: "hold" },
    ]);
    const waiter = rt.waitFor(id, 60_000);
    expect(rt.answer(id, "allow-once")).toBe(true);
    expect((await waiter).answer).toBe("allow-once");
    expect(readEntries(file)).toEqual([]);
  });

  it("a wait that runs out leaves an expired question, which 'keep held' takes off", async () => {
    const { rt, file } = runtime();
    const id = await held(rt);
    expect((await rt.waitFor(id, 0)).answer).toBe("timeout");
    expect(readEntries(file)).toMatchObject([{ id, state: "expired" }]);
    // No hook waits any more: an allow cannot release anything here, and says so.
    expect(rt.answer(id, "allow-once")).toBe(false);
    expect(readEntries(file)).toHaveLength(1);
    expect(rt.answer(id, "keep-held")).toBe(true);
    expect(readEntries(file)).toEqual([]);
  });

  it("his allow typed in the chat settles the expired question; an agent's prompt does not", async () => {
    const { rt, file } = runtime();
    const id = await held(rt);
    await rt.waitFor(id, 0);
    const grant = readEntries(file)[0].grant;
    expect(grant).toMatch(/^JEV-[0-9A-Z]{6}$/);
    await rt.decide(
      "prompt",
      { session_id: "s", prompt: `⟦AGENT:⏳ Longjob · x⟧ allow ${grant}` },
      CHAT,
    );
    expect(readEntries(file)).toHaveLength(1);
    await rt.decide("prompt", { session_id: "s", prompt: `allow ${grant}` }, "agent:main:main");
    expect(readEntries(file)).toHaveLength(1);
    await rt.decide("prompt", { session_id: "s", prompt: `allow ${grant}` }, CHAT);
    expect(readEntries(file)).toEqual([]);
  });
});
