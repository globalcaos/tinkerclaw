import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planHistoryAroundLooseRows, planOlderPage, planRowsByTime } from "./history-paging.js";
import {
  DEFAULT_HISTORY_RECONCILE_DEPS as deps,
  historyPromptKey,
  promptKeysOf,
  reconcileHistoryIntoPage,
} from "./history-reconcile.js";
import { outboxEntriesNeedingBubble, type OutboxEntry } from "./outbox.js";

// FORK 2026-10-03 — a served prompt that carries the page's prompt key IS that prompt (bible bug-log,
// "the prompt drawn twice", 2026-10-03). The page's bubble and the gateway's row of
// one prompt share a key: send() mints one uuid for the bubble's `_clientMsgId` and for chat.send's
// `idempotencyKey`, and the gateway stamps that key on the prompt row it serves. Before this rule
// the planners knew a served row only by `__openclaw.id` / `externalId` or by a time window, and the
// outbox counted a prompt as on screen only by `_clientMsgId`, so the served copy of a prompt the
// page drew itself came out as a second prompt whenever it fell outside the bubble's ±15 s instant.
//
// Times are the replayed capture's (cap1, 2026-10-03): the turn started 37.3 s after the send, the
// keyed local row is stamped then, and the claude-cli import copy 1.5 s later.

const SEND = Date.parse("2026-10-03T05:04:03.000Z");
const K = "dupcap-g2cp9yur-1791003843374";
const PROMPT = "This is a rendering test of the chat UI, run by Claude Code.";

/** The page's own bubble, as send() draws it. */
const bubble = (key = K, text = PROMPT) => ({
  role: "user",
  _clientMsgId: key,
  content: [{ type: "text", text }],
  _promptStartedAt: SEND,
  _promptState: { transport: "acked", deferred: false },
});
/** The keyed local row the gateway serves once pi wrote it (the run's start on an established tab). */
const localPrompt = (key: string | null = K, text = PROMPT) => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: SEND + 37_289,
  __openclaw: { id: "4f9944e3", seq: 1 },
  ...(key !== null ? { idempotencyKey: key } : {}),
});
/** The claude-cli import copy of the prompt, keyed the way the gateway would key it. */
const importPrompt = (key: string | null = K) => ({
  role: "user",
  content: `${PROMPT}\n\n<!-- TINKERCLAW chat-row contract -->`,
  timestamp: SEND + 38_777,
  __openclaw: { importedFrom: "claude-cli", cliSessionId: "881e938f", externalId: "f6c42c58" },
  ...(key !== null ? { idempotencyKey: key } : {}),
});
const importAnswer = (ext: string, atMs: number, text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp: atMs,
  __openclaw: { importedFrom: "claude-cli", cliSessionId: "881e938f", externalId: ext },
});
/** A prior turn, so the page holds server rows (an established tab). */
const prior = (id: string, role: string, atMs: number) => ({
  role,
  content: [{ type: "text", text: `${role}:${id}` }],
  timestamp: atMs,
  __openclaw: { id, seq: 0 },
});

const ANSWERS = [
  importAnswer("794a0640", SEND + 41_000, "I'll check the clock with the date command first."),
  importAnswer("b81d71ee", SEND + 70_000, "Jarvis: The test turn is done."),
];
const userRows = (rows: readonly unknown[]) =>
  rows.filter((r) => (r as { role?: string }).role === "user");

describe("historyPromptKey — the one key a prompt row carries", () => {
  it("a served prompt's idempotencyKey, the page bubble's _clientMsgId", () => {
    expect(historyPromptKey(localPrompt())).toBe(K);
    expect(historyPromptKey(importPrompt())).toBe(K);
    expect(historyPromptKey(bubble())).toBe(K);
  });

  it("never an answer, never a row with no key, never a superseded key", () => {
    expect(historyPromptKey({ ...ANSWERS[0], idempotencyKey: K })).toBeNull();
    expect(historyPromptKey(importPrompt(null))).toBeNull();
    expect(historyPromptKey({ ...localPrompt(null), supersededIdempotencyKeys: [K] })).toBeNull();
  });

  it("the default deps read it, and the page's keys map to the row that holds each", () => {
    expect(deps.promptKeyOf).toBe(historyPromptKey);
    const b = bubble();
    const keys = promptKeysOf([prior("p1", "user", SEND - 60_000), b], deps);
    expect([...keys.keys()]).toEqual([K]);
    expect(keys.get(K)).toBe(b);
  });
});

describe("reconcileHistoryIntoPage — the served copy of the page's own prompt is that prompt", () => {
  const page = () => [
    prior("p1", "user", SEND - 60_000),
    prior("p2", "assistant", SEND - 50_000),
    bubble(),
  ];

  it("a keyed prompt stamped when the turn started (37 s after the send) is known, not added", () => {
    const r = reconcileHistoryIntoPage(page(), [localPrompt(), ...ANSWERS], deps);
    expect(r.mode).toBe("gapfill");
    expect(userRows(r.added)).toEqual([]);
    expect(r.added).toEqual(ANSWERS);
    expect(r.skippedKnown).toBe(1);
  });

  it("CONTROL: a prompt keyed to another send is another prompt, and is drawn", () => {
    const other = localPrompt("another-send");
    const r = reconcileHistoryIntoPage(page(), [other, ...ANSWERS], deps);
    expect(userRows(r.added)).toEqual([other]);
  });

  it("CONTROL: the same text with no key is drawn: text never decides", () => {
    const unkeyed = localPrompt(null);
    const r = reconcileHistoryIntoPage(page(), [unkeyed, ...ANSWERS], deps);
    expect(userRows(r.added)).toEqual([unkeyed]);
  });

  it("the server switching the prompt's identity at final #1 (import copy, then local row) adds no second prompt", () => {
    // The page drew the keyed import copy mid-run, before any answer; from final #1 the gateway
    // serves the local row under another identity (oc: instead of ext:), with the same key, 1.5 s
    // EARLIER, so neither identity nor the watermark recognises it.
    const r = reconcileHistoryIntoPage(
      [prior("p1", "user", SEND - 60_000), importPrompt()],
      [localPrompt(), ...ANSWERS],
      deps,
    );
    expect(r.added).toEqual(ANSWERS);
  });

  it("a reply carrying two copies of one keyed prompt writes the first only", () => {
    const r = reconcileHistoryIntoPage(
      [prior("p1", "user", SEND - 60_000)],
      [localPrompt(), importPrompt(), ...ANSWERS],
      deps,
    );
    expect(userRows(r.added)).toEqual([localPrompt()]);
  });
});

describe("the planners know the page's prompt by its key", () => {
  it("planHistoryAroundLooseRows: a reload under a live run leaves the bubble alone on the page", () => {
    const plan = planHistoryAroundLooseRows([bubble()], [localPrompt(), ...ANSWERS], deps);
    const written = plan.groups.flatMap((g) => g.rows);
    expect(userRows(written)).toEqual([]);
    expect(written).toEqual(ANSWERS);
    expect(plan.skippedKnown).toBe(1);
  });

  it("planHistoryAroundLooseRows CONTROL: an unkeyed import copy is still written (it needs the gateway's key)", () => {
    const plan = planHistoryAroundLooseRows([bubble()], [importPrompt(null), ...ANSWERS], deps);
    expect(userRows(plan.groups.flatMap((g) => g.rows))).toHaveLength(1);
  });

  it("planRowsByTime: the keyed prompt is held by the bubble, which is the last row on the page", () => {
    const b = bubble();
    const plan = planRowsByTime([prior("p1", "user", SEND - 60_000), b], [localPrompt()], deps);
    expect(plan.groups).toEqual([]);
    expect(plan.skippedKnown).toBe(1);
    expect(plan.lastOnPage).toBe(b);
  });

  it("planOlderPage: a keyed prompt in an older reply is skipped and anchors the rows before it", () => {
    const b = bubble();
    // Outside the bubble's own ±15 s instant, which would skip it as watched.
    const older = prior("o1", "assistant", SEND - 30_000);
    const plan = planOlderPage(
      [prior("p1", "user", SEND - 60_000), b],
      [older, localPrompt()],
      null,
      0,
      deps,
    );
    expect(plan.skippedKnown).toBe(1);
    expect(plan.skippedKnownLocal).toBe(0);
    expect(plan.groups.flatMap((g) => g.rows)).toEqual([older]);
  });
});

describe("the outbox puts no bubble back beside a served row that carries its key", () => {
  const entry = (id: string): OutboxEntry => ({
    id,
    sessionKey: "agent:main:tinker:dupcapa1",
    text: PROMPT,
    ts: SEND,
    attempts: 1,
    lastAttemptAt: SEND,
  });
  /** On screen, as app.ts reinjectOutboxBubbles collects it. */
  const onScreenOf = (page: ReadonlyArray<Record<string, unknown>>) => {
    const ids = new Set<string>();
    for (const m of page) {
      if (typeof m._clientMsgId === "string") {
        ids.add(m._clientMsgId);
      }
      const k = historyPromptKey(m);
      if (k !== null) {
        ids.add(k);
      }
    }
    return ids;
  };

  it("a page written from history under a live run already shows the prompt", () => {
    const page = [prior("p1", "user", SEND - 60_000), localPrompt(), ...ANSWERS];
    expect(outboxEntriesNeedingBubble([entry(K)], onScreenOf(page))).toEqual([]);
  });

  it("CONTROL: an entry whose key no row carries still gets its bubble", () => {
    const page = [prior("p1", "user", SEND - 60_000), localPrompt(), ...ANSWERS];
    expect(
      outboxEntriesNeedingBubble([entry("lost-one")], onScreenOf(page)).map((e) => e.id),
    ).toEqual(["lost-one"]);
  });

  it("app.ts reinjectOutboxBubbles counts a served row's key as on screen (source check)", () => {
    const srcRoot = ["tinker-ui/src", "src"]
      .map((p) => join(process.cwd(), p))
      .find((p) => existsSync(join(p, "app.ts")));
    expect(srcRoot).toBeDefined();
    // Line comments stripped, so a comment can neither satisfy nor break an assertion.
    const src = readFileSync(join(srcRoot!, "app.ts"), "utf8").replace(/\/\/.*$/gm, "");
    const start = src.indexOf("function reinjectOutboxBubbles(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("outboxEntriesNeedingBubble(mine, onScreen)", start));
    expect(body).toMatch(/historyPromptKey\(m\)/);
    expect(body).toMatch(/onScreen\.add\(servedKey\)/);
  });
});
