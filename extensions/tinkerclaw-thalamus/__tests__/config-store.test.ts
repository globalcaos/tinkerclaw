import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { CallDecision, EnhancementCard } from "openclaw/plugin-sdk/fork-thalamus";
import { routeCall, seedCards } from "openclaw/plugin-sdk/fork-thalamus";
import { afterAll, describe, expect, it } from "vitest";
// Integration only: the shared test fixtures build a real decision.
import { callParams, OPUS, R } from "../../../src/shared/thalamus-v4.test-support.js";
import { parseConfig, parseMode } from "../src/config.js";
import { viewContext, sourceOfSessionKey } from "../src/context-view.js";
import { ThalamusStore } from "../src/store.js";

const tmp = mkdtempSync(join(tmpdir(), "thalamus-store-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("config", () => {
  it("is off, with no outside reads, by default", () => {
    const c = parseConfig(undefined);
    expect(c.mode).toBe("off");
    expect(c.jev).toMatchObject({ enabled: false, sendRealSituations: false });
    expect(c.privacy.privateSources).toEqual(["channel:*"]);
    expect(c.privacy.approvedProviders).toEqual(["claude-code"]);
    expect(c.reads.confidenceFloor).toBe(0.6);
    expect(c.retentionDays).toBe(90);
  });

  it("treats anything but shadow or enforce as off, so a typo cannot switch routing on", () => {
    expect(parseMode("shadow")).toBe("shadow");
    expect(parseMode("enforce")).toBe("enforce");
    for (const v of ["on", "SHADOW", "", undefined, null, 1, true, {}])
      expect(parseMode(v)).toBe("off");
  });

  it("takes what it is given and ignores what it is not", () => {
    const c = parseConfig({
      mode: "shadow",
      jev: { enabled: true, timeoutMs: "slow" },
      reads: { confidenceFloor: 7 },
      privacy: { privateSources: ["channel:*", 3, ""], jevApprovedSources: ["channel:sms"] },
      shortlist: { budgetMs: -5 },
      dataDir: "/x",
    });
    expect(c).toMatchObject({ mode: "shadow", dataDir: "/x" });
    expect(c.jev.enabled).toBe(true);
    expect(c.jev.timeoutMs).toBe(2600);
    expect(c.reads.confidenceFloor).toBe(1);
    expect(c.privacy.privateSources).toEqual(["channel:*"]);
    expect(c.privacy.jevApprovedSources).toEqual(["channel:sms"]);
    expect(c.shortlist.budgetMs).toBe(0);
  });
});

const decision = (over: Parameters<typeof callParams>[0] = {}): CallDecision =>
  routeCall(callParams({ rungs: [R.opus, R.sonnet, R.haiku, R.grok], ...over }))!;

describe("the store", () => {
  it("creates its folder on open and never assumes it exists", () => {
    const file = join(tmp, "deep", "er", "thalamus.sqlite");
    expect(existsSync(join(tmp, "deep"))).toBe(false);
    const s = new ThalamusStore(file);
    expect(existsSync(file)).toBe(true);
    expect(s.schemaVersion()).toBe(2);
    s.close();
  });

  it("refuses a file from a newer build instead of guessing", () => {
    const file = join(tmp, "newer.sqlite");
    const s = new ThalamusStore(file);
    s.close();
    const raw = new Database(file);
    raw.prepare("UPDATE meta SET value='99' WHERE key='schema_version'").run();
    raw.close();
    expect(() => new ThalamusStore(file)).toThrow(/schema 99/);
  });

  it("records a decision with its options, vetoes and ladder, and reads it back", () => {
    const s = new ThalamusStore(":memory:");
    const d = decision({ cooling: new Set(["xai"]) });
    s.insertDecision(d, {
      ladder: {
        handPicked: false,
        byReason: { rate_limit: [], overloaded: [], capacity: [], engagement: [], timeout: [] },
      },
      computeMs: 1.5,
      sessionKey: "s1",
      privateTask: false,
    });
    const r = s.getDecision(d.id)!;
    expect(r).toMatchObject({
      id: d.id,
      runId: "run-1",
      lane: "embedded",
      mode: "shadow",
      incumbent: OPUS,
      applied: false,
      session: "s1",
      computeMs: 1.5,
    });
    expect(r.options.length).toBe(d.options.length);
    expect(r.vetoes).toEqual(d.vetoes);
    expect((r.ladder as { handPicked: boolean }).handPicked).toBe(false);
    expect(r.moneyBasis).toBe("list");
    s.close();
  });

  it("stores a break-even that never arrives as null, not as text", () => {
    const s = new ThalamusStore(":memory:");
    const d = decision();
    const inf = { ...d, switch: { ...d.switch, nStar: Number.POSITIVE_INFINITY } };
    s.insertDecision(inf);
    expect(s.getDecision(d.id)!.nStar).toBeNull();
    s.close();
  });

  it("keeps no request or response body", () => {
    const s = new ThalamusStore(":memory:");
    const d = decision();
    s.insertDecision(d);
    const text = JSON.stringify(s.getDecision(d.id));
    expect(text).not.toMatch(/messages|systemPrompt|content/);
    s.close();
  });

  it("lists newest first, by session, capped at 200", () => {
    const s = new ThalamusStore(":memory:");
    for (let i = 0; i < 5; i++)
      s.insertDecision(
        { ...decision(), id: `d${i}`, ts: 1000 + i, callIndex: i },
        { sessionKey: i % 2 ? "odd" : "even" },
      );
    expect(s.listDecisions().map((r) => r.id)).toEqual(["d4", "d3", "d2", "d1", "d0"]);
    expect(s.listDecisions({ sessionKey: "odd" }).map((r) => r.id)).toEqual(["d3", "d1"]);
    expect(s.listDecisions({ sinceTs: 1003 }).map((r) => r.id)).toEqual(["d4", "d3"]);
    expect(s.listDecisions({ limit: 2 })).toHaveLength(2);
    expect(s.listDecisions({ limit: 99999 })).toHaveLength(5);
    s.close();
  });

  it("joins an outcome to its decision, and drops both when it prunes", () => {
    const s = new ThalamusStore(":memory:");
    const d = decision();
    s.insertDecision({ ...d, ts: 10 });
    s.insertOutcome({
      decisionId: d.id,
      ts: 11,
      actualModel: OPUS,
      input: 5,
      cacheRead: 100,
      cacheWrite: 0,
      output: 50,
      durationMs: 900,
      outcome: "done",
      refused: false,
      moneyBasis: "list",
    });
    expect(s.getOutcome(d.id)).toMatchObject({
      actual_model: OPUS,
      cache_read: 100,
      money_basis: "list",
    });
    expect(s.counts()).toMatchObject({ decisions: 1, outcomes: 1 });
    expect(s.pruneDecisions(11)).toBe(1);
    expect(s.counts()).toMatchObject({ decisions: 0, outcomes: 0 });
    s.close();
  });
});

const cards = seedCards([
  { kind: "skill", name: "a", description: "Extract a PDF." },
  { kind: "recipe", name: "b", description: "Review a diff." },
]);

describe("cards and uses", () => {
  it("seeds version 1 once and leaves an existing card exactly as it is", () => {
    const s = new ThalamusStore(":memory:");
    expect(s.seedCards(cards, 100)).toBe(2);
    expect(s.activeCards().map((c) => c.id)).toEqual(["recipe:b", "skill:a"]);
    // A later seed with different text must not overwrite what is stored.
    const changed: EnhancementCard[] = cards.map((c) => ({ ...c, purpose: "different" }));
    expect(s.seedCards(changed, 200)).toBe(0);
    expect(s.activeCards().find((c) => c.id === "skill:a")!.purpose).toBe("Extract a PDF.");
    s.close();
  });

  it("keeps every version and points at the active one", () => {
    const s = new ThalamusStore(":memory:");
    s.seedCards(cards, 100);
    const a = s.activeCards().find((c) => c.id === "skill:a")!;
    s.addCardVersion(
      {
        ...a,
        version: 2,
        purpose: "Extract text from a PDF.",
        alsoServed: ["forms"],
        origin: "nightly",
      },
      { createdAt: 300, parent: 1, replay: { before: 0.4, after: 0.5, n: 30 } },
    );
    expect(s.activeCards().find((c) => c.id === "skill:a")).toMatchObject({
      version: 2,
      alsoServed: ["forms"],
      origin: "nightly",
    });
    expect(s.cardVersions("skill:a").map((c) => c.version)).toEqual([1, 2]);
    s.close();
  });

  it("refuses to edit a version in place", () => {
    const s = new ThalamusStore(":memory:");
    s.seedCards(cards, 100);
    const a = s.activeCards()[0];
    expect(() => s.addCardVersion({ ...a, purpose: "sneaky edit" }, { createdAt: 1 })).toThrow();
    s.close();
  });

  it("records one use row per task with the list shown, what was used, and the outcome", () => {
    const s = new ThalamusStore(":memory:");
    s.upsertUse({
      taskId: "run-1",
      ts: 5,
      session: "s",
      source: "tinker",
      private: false,
      shuffled: false,
      shown: [{ cardId: "skill:a", rank: 1, prob: 0.6 }],
      noneFits: 0.2,
      listShown: true,
      listReason: "shown",
      listSource: "local",
      used: [{ cardId: "skill:a", onList: true, rank: 1, via: "read", how: "unknown" }],
      outcome: "done",
      cardVersions: { "skill:a": 1 },
      questionVersion: 0,
      mode: "shadow",
    });
    const u = s.getUse("run-1")!;
    expect(u.shown[0]).toMatchObject({ cardId: "skill:a", rank: 1, prob: 0.6 });
    expect(u.used[0]).toMatchObject({ onList: true, rank: 1, how: "unknown" });
    expect(u).toMatchObject({ listShown: true, outcome: "done", mode: "shadow" });
    expect(s.counts().uses).toBe(1);
    s.close();
  });
});

describe("reading a call's context", () => {
  it("finds the task, the latest ask and the last tool without copying anything", () => {
    const context = Object.freeze({
      systemPrompt: "x".repeat(70),
      messages: Object.freeze([
        Object.freeze({ role: "user", content: "Compare my translation." }),
        Object.freeze({
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            { type: "toolCall", name: "Read" },
          ],
        }),
        Object.freeze({
          role: "toolResult",
          toolName: "Read",
          content: [{ type: "text", text: "file text" }],
        }),
        Object.freeze({
          role: "user",
          content: [{ type: "text", text: "and now the second one" }],
        }),
        Object.freeze({ role: "toolResult", toolName: "Grep", content: "hit" }),
      ]),
    });
    const v = viewContext(context);
    expect(v).toMatchObject({
      firstUserText: "Compare my translation.",
      lastUserText: "and now the second one",
      lastToolName: "Grep",
      messageCount: 5,
    });
    expect(v.estimatedTokens).toBeGreaterThan(20);
  });

  it("gives an empty view, never an exception, for a shape it does not know", () => {
    for (const bad of [
      undefined,
      null,
      5,
      "s",
      {},
      { messages: 3 },
      { messages: [null, 4, "x"] },
    ]) {
      expect(() => viewContext(bad), String(bad)).not.toThrow();
    }
    expect(viewContext(undefined)).toMatchObject({
      lastUserText: "",
      estimatedTokens: 0,
      messageCount: 0,
    });
  });

  it("cuts an enormous prompt down to what a read needs", () => {
    expect(
      viewContext({ messages: [{ role: "user", content: "y".repeat(50_000) }] }).lastUserText,
    ).toHaveLength(4000);
  });

  it("names the source of a session key", () => {
    expect(sourceOfSessionKey("agent:main:tinker:abc")).toBe("tinker");
    expect(sourceOfSessionKey("agent:main:whatsapp:+34")).toBe("channel:whatsapp");
    expect(sourceOfSessionKey("agent:main:cron:job1")).toBe("cron");
    expect(sourceOfSessionKey(undefined)).toBe("tinker");
  });
});
