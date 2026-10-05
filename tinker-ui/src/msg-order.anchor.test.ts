/**
 * FORK 2026-09-08 — a client row is anchored to the PROMPT it was measured under, not to an
 * ordinal.
 *
 * THE BUG (the architect, clawhub tab, 2026-09-08 07:2x): "In the chat I see multiple TURN TIMING, which
 * indicates the amount of parallelism initiated, except it is a bug to see it so many times."
 * The DOM snapshot of that tab held 25 timing blocks: SEVEN complete four-stage blocks stacked under
 * one prompt ("You can do the 11 in parallel"), seven more ABOVE the first prompt, and none at all
 * under prompts 3 through 31. The gateway had run exactly one turn for that prompt.
 *
 * WHY: `turnAnchorOf` returns "how many user messages precede this row" and the store kept only
 * that number. `reinsertByTurnAnchor` then flushed a row with turn N before the (N+1)-th user
 * message OF THE LIST IT WAS HANDED. In a Claude Code bridge tab that list is not stable: the bridge
 * re-imports the CLI transcript on every history reload (every ~20 s during a turn), the import
 * flood valve truncates it, task-notification and auto-resume rows count as user messages. So the
 * ordinal drifted, and every ordinal past the served count landed at the tail — under the newest
 * prompt, where seven old measurements read as seven parallel turns.
 *
 * These specs pin the anchor to the prompt text (with the row's own time to break ties), and the
 * time alone when the prompt is gone. The raw ordinal is the LAST resort, never the first.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetMsgOrderForTests,
  describeTurnAnchor,
  reinsertByTurnAnchor,
  resolveTurnAnchor,
  stampOrder,
  stampTurnAnchorOn,
} from "./msg-order.js";

type Msg = Record<string, unknown>;

const user = (text: string, at?: number): Msg => ({
  role: "user",
  content: text,
  ...(at !== undefined ? { _promptStartedAt: at } : {}),
});
const assistant = (text: string): Msg => ({ role: "assistant", content: text });
/** A timing block exactly as `recordPhaseTiming` creates it: client-only, with its own `ts`. */
const block = (ts: number, tag = "t"): Msg => ({
  role: "assistant",
  content: "turn timing",
  _isPhaseTiming: true,
  _tag: tag,
  ts,
});
const textOf = (m: unknown): unknown => (m as Msg).content;
const promptIndex = (list: unknown[], text: string): number =>
  list.findIndex((m) => (m as Msg).role === "user" && (m as Msg).content === text);

beforeEach(() => {
  __resetMsgOrderForTests();
});

describe("describeTurnAnchor — what is captured when a row is born", () => {
  it("records the ordinal, the row's own time and the prompt it sits under", () => {
    const b = block(5000);
    const list = [user("u1", 1000), assistant("a1"), user("u2", 4000), b];
    const a = describeTurnAnchor(list, b);
    expect(a.turn).toBe(2);
    expect(a.at).toBe(5000);
    expect(a.prompt).toBe("u2");
  });

  it("strips the gateway's bracketed timestamp prefix and keeps a bounded prefix of the prompt", () => {
    const b = block(5000);
    const long = "[Tue 2026-09-08 07:05 GMT+2] " + "x".repeat(300);
    const a = describeTurnAnchor([user(long, 1000), b], b);
    expect(a.prompt).toBe("x".repeat(80));
  });

  it("reads array content the way a bridge-persisted prompt is shaped", () => {
    const b = block(5000);
    const u: Msg = { role: "user", content: [{ type: "text", text: "  hello   there " }] };
    expect(describeTurnAnchor([u, b], b).prompt).toBe("hello there");
  });

  it("has no prompt at turn 0, and uses the arrival clock when the row carries no ts", () => {
    const b: Msg = { role: "assistant", _isWarning: true };
    const list = [b, user("u1", 1000)];
    stampOrder(list);
    const a = describeTurnAnchor(list, b);
    expect(a.turn).toBe(0);
    expect(a.prompt).toBeUndefined();
    expect(a.at).toBe((b as Msg)._arrivedAt);
  });
});

describe("resolveTurnAnchor — the prompt wins, then time, then the ordinal", () => {
  it("finds the prompt even when the served copy carries the injected prefix and suffix", () => {
    const server = [
      user("[Tue 2026-09-08 07:05 GMT+2] Ok, ship the 11. At the same time, fix it  ---  **After your reply**", 100),
      assistant("a1"),
      user("next", 200),
    ];
    expect(resolveTurnAnchor(server, { turn: 9, at: 150, prompt: "Ok, ship the 11. At the same time, fix it" })).toBe(1);
  });

  it("disambiguates identical prompts ('keep going' × 3) by the row's time", () => {
    const server = [
      user("keep going", 100),
      assistant("a1"),
      user("keep going", 300),
      assistant("a2"),
      user("keep going", 500),
      assistant("a3"),
    ];
    expect(resolveTurnAnchor(server, { turn: 1, at: 320, prompt: "keep going" })).toBe(2);
    expect(resolveTurnAnchor(server, { turn: 1, at: 90, prompt: "keep going" })).toBe(1);
    expect(resolveTurnAnchor(server, { turn: 1, at: 9000, prompt: "keep going" })).toBe(3);
  });

  it("with no prompt on file, keeps the ordinal when its prompt's time agrees with the row (the steer case)", () => {
    // A steered prompt is persisted by the gateway ~50 s after the tab sent it, so the row's `at`
    // PRECEDES its own prompt's server time. The ordinal is still right, and the time agrees.
    const server = [user("u1", 100_000), assistant("a1"), user("u2", 151_000), assistant("a2")];
    expect(resolveTurnAnchor(server, { turn: 2, at: 101_000 })).toBe(2);
  });

  it("with no prompt on file and an ordinal that no longer fits, counts prompts by time", () => {
    const server = [user("u1", 100), assistant("a1"), user("u2", 300), assistant("a2"), user("u3", 500)];
    // ordinal 44 came from a much longer local list; the row was measured between u2 and u3
    expect(resolveTurnAnchor(server, { turn: 44, at: 320 })).toBe(2);
    // and one measured before anything was ever asked is turn 0
    expect(resolveTurnAnchor(server, { turn: 44, at: 50 })).toBe(0);
  });

  it("counts an untimed prompt as preceding (the optimistic local bubble has no server stamp yet)", () => {
    const server = [user("u1", 100), assistant("a1"), user("u2")];
    expect(resolveTurnAnchor(server, { turn: 0, at: 200 })).toBe(2);
  });

  it("falls back to the raw ordinal only when it knows nothing else", () => {
    const server = [user("u1"), user("u2")];
    expect(resolveTurnAnchor(server, { turn: 1 })).toBe(1);
    expect(resolveTurnAnchor(server, { turn: 7 })).toBe(7);
    expect(resolveTurnAnchor(null as unknown as unknown[], { turn: 3 })).toBe(3);
  });
});

describe("reinsertByTurnAnchor with a described anchor — THE REPORTED SHAPE", () => {
  it("a bridge tab whose served transcript GAINED user rows above keeps the block under its prompt", () => {
    const b = block(5000);
    const live = [user("u1", 1000), assistant("a1"), user("u2", 4000), b];
    const anchor = describeTurnAnchor(live, b);
    expect(anchor.turn).toBe(2);
    // The cli-history import later inserted two task-notification user rows ABOVE it.
    const server = [
      user("<task-notification> x", 500),
      user("u1", 1000),
      assistant("a1"),
      user("<task-notification> y", 2000),
      user("u2", 4000),
      assistant("a2"),
      user("u3", 9000),
      assistant("a3"),
    ];
    reinsertByTurnAnchor(server, [{ m: b, ...anchor }]);
    // Right after u2's answer and BEFORE u3 — the raw ordinal 2 would have dropped it after u3.
    expect(server.indexOf(b)).toBe(promptIndex(server, "u3") - 1);
  });

  it("blocks whose ordinals exceed the served user count do NOT pile under the last prompt", () => {
    // Five blocks captured at turns 40..44 of a long local list, one per prompt. The served
    // transcript was truncated by the import flood valve to six prompts, three of ours among them.
    const b40 = block(210, "b40");
    const b41 = block(310, "b41");
    const b42 = block(410, "b42");
    const b43 = block(510, "b43");
    const b44 = block(610, "b44");
    const anchored = [
      { m: b40, turn: 40, at: 210, prompt: "p40" },
      { m: b41, turn: 41, at: 310, prompt: "p41" },
      { m: b42, turn: 42, at: 410, prompt: "p42" },
      { m: b43, turn: 43, at: 510, prompt: "p43" },
      { m: b44, turn: 44, at: 610, prompt: "p44" },
    ];
    const server = [
      user("p39", 100),
      assistant("x"),
      user("p40", 200),
      assistant("x"),
      user("p42", 400),
      assistant("x"),
      user("p44", 600),
      assistant("x"),
      user("p45", 800),
      assistant("x"),
    ];
    reinsertByTurnAnchor(server, anchored);
    // Present prompts: each block directly precedes the NEXT prompt after its own.
    expect(server.indexOf(b40)).toBeLessThan(promptIndex(server, "p42"));
    expect(server.indexOf(b40)).toBeGreaterThan(promptIndex(server, "p40"));
    expect(server.indexOf(b42)).toBeLessThan(promptIndex(server, "p44"));
    expect(server.indexOf(b42)).toBeGreaterThan(promptIndex(server, "p42"));
    expect(server.indexOf(b44)).toBeLessThan(promptIndex(server, "p45"));
    expect(server.indexOf(b44)).toBeGreaterThan(promptIndex(server, "p44"));
    // Absent prompts (p41, p43): placed by TIME, next to the prompt that was live when measured.
    expect(server.indexOf(b41)).toBeLessThan(promptIndex(server, "p42"));
    expect(server.indexOf(b43)).toBeLessThan(promptIndex(server, "p44"));
    // And the tail — everything after the last prompt — holds no block at all.
    const tail = server.slice(promptIndex(server, "p45"));
    expect(tail.filter((m) => (m as Msg)._isPhaseTiming)).toHaveLength(0);
    // Nothing was dropped.
    expect(server).toHaveLength(15);
  });

  it("an entry with only { m, turn } whose ROW carries the anchor resolves like a described one", () => {
    // This is the shape every restore/preserve caller uses, including one that copies the old code.
    const b = block(5000);
    const live = [user("u1", 1000), assistant("a1"), user("u2", 4000), b];
    stampTurnAnchorOn(b, describeTurnAnchor(live, b));
    expect((b as Msg)._anchorAt).toBe(5000);
    expect((b as Msg)._anchorPrompt).toBe("u2");
    const server = [
      user("<task-notification> x", 500),
      user("u1", 1000),
      assistant("a1"),
      user("u2", 4000),
      assistant("a2"),
      user("u3", 9000),
    ];
    reinsertByTurnAnchor(server, [{ m: b, turn: 44 }]);
    expect(server.indexOf(b)).toBe(promptIndex(server, "u3") - 1);
  });

  it("a legacy entry with only a number still lands where the old code put it", () => {
    const b = block(0);
    const server = [user("u1"), assistant("a1"), user("u2"), assistant("a2")];
    reinsertByTurnAnchor(server, [{ m: b, turn: 1 }]);
    expect(textOf(server[1])).toBe("a1");
    expect(server[2]).toBe(b);
    expect(textOf(server[3])).toBe("u2");
  });
});
