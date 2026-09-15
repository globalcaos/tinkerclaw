import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TINKER_SEAT_COOKIE,
  formatAgentBanner,
  gatewayCookie,
  loadOperators,
  lookupOperator,
  operatorIdFromName,
  operatorsPath,
  renderTinkerLoginPage,
  sanitizeDisplayName,
  sanitizeSeatId,
  saveOperators,
  seatCookie,
  upsertOperator,
  sessionVisibleToOperator,
  timingSafeEqualString,
  uiStatePathForSeat,
  uiStatePath,
  ownerDeskPath,
} from "./hivemind-seats.ts";

describe("formatAgentBanner", () => {
  it("appends the conductor in parentheses", () => {
    expect(formatAgentBanner("GOKU", "Alice")).toBe("GOKU (Alice)");
  });
  it("leaves the agent name alone when no conductor", () => {
    expect(formatAgentBanner("GOKU", "")).toBe("GOKU");
    expect(formatAgentBanner("GOKU")).toBe("GOKU");
  });
});

describe("sanitizeSeatId", () => {
  it("accepts token-shaped ids", () => {
    expect(sanitizeSeatId("seat-xavi_1")).toBe("seat-xavi_1");
    expect(sanitizeSeatId("dev:abc.def")).toBe("dev:abc.def");
  });
  it("rejects traversal and junk", () => {
    expect(sanitizeSeatId("../etc")).toBeNull();
    expect(sanitizeSeatId("a/b")).toBeNull();
    expect(sanitizeSeatId("")).toBeNull();
    expect(sanitizeSeatId("a b")).toBeNull();
  });
});

describe("sessionVisibleToOperator", () => {
  it("hides untagged sessions from alice/bob and shows them to oscar", () => {
    expect(sessionVisibleToOperator({}, "alice", false)).toBe(false);
    expect(sessionVisibleToOperator({}, "bob", false)).toBe(false);
    expect(sessionVisibleToOperator({}, "oscar", false)).toBe(true);
  });
  it("shows a tagged session only to its operator unless hive", () => {
    expect(sessionVisibleToOperator({ operatorId: "alice" }, "alice", false)).toBe(true);
    expect(sessionVisibleToOperator({ operatorId: "alice" }, "bob", false)).toBe(false);
    expect(sessionVisibleToOperator({ operatorId: "alice" }, "bob", true)).toBe(true);
  });
});

describe("login page", () => {
  it("never embeds a supplied token", () => {
    const html = renderTinkerLoginPage({ error: "nope" });
    expect(html).toContain("Who is at the door?");
    expect(html).not.toContain("secret-token-value");
    expect(html.toLowerCase()).not.toContain("authorization");
  });
  it("sets an HttpOnly cookie scoped to /tinker", () => {
    const c = gatewayCookie("abc", false);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Path=/tinker");
    expect(c).not.toContain("Secure");
  });
  it("compares tokens in constant time on equal length", () => {
    expect(timingSafeEqualString("abcd", "abcd")).toBe(true);
    expect(timingSafeEqualString("abcd", "abce")).toBe(false);
    expect(timingSafeEqualString("ab", "abcd")).toBe(false);
  });
});

describe("operators + desk paths", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });
  function tmpHome(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "hivemind-"));
    tmpDirs.push(d);
    return d;
  }
  it("round-trips operators.json", () => {
    const home = tmpHome();
    saveOperators([{ deviceId: "d1", operatorId: "alice", displayName: "Alice" }], home);
    expect(fs.existsSync(operatorsPath(home))).toBe(true);
    const loaded = loadOperators(home);
    expect(lookupOperator(loaded, "d1")?.displayName).toBe("Alice");
  });
  it("keeps two seats on different files", () => {
    const home = tmpHome();
    const a = uiStatePathForSeat("seat-a", home);
    const b = uiStatePathForSeat("seat-b", home);
    expect(a).not.toBe(b);
    fs.mkdirSync(path.dirname(a), { recursive: true });
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.writeFileSync(a, JSON.stringify({ tabs: [{ id: "alice" }] }));
    fs.writeFileSync(b, JSON.stringify({ tabs: [{ id: "bob" }] }));
    expect(JSON.parse(fs.readFileSync(a, "utf8")).tabs[0].id).toBe("alice");
    expect(JSON.parse(fs.readFileSync(b, "utf8")).tabs[0].id).toBe("bob");
  });
  it("routes a seat-less request to the owner desk and a seat to its own file", () => {
    const home = tmpHome();
    expect(uiStatePath(null, home)).toBe(ownerDeskPath(home));
    expect(uiStatePath(undefined, home)).toBe(ownerDeskPath(home));
    expect(uiStatePath("", home)).toBe(ownerDeskPath(home));
    expect(ownerDeskPath(home).endsWith("/.openclaw/data/tinker-ui-state.json")).toBe(true);
    expect(uiStatePath("seat-a", home)).toBe(uiStatePathForSeat("seat-a", home));
    expect(uiStatePath("seat-a", home)).not.toBe(ownerDeskPath(home));
  });
  it("refuses a traversal seat id for the desk path", () => {
    expect(() => uiStatePathForSeat("../etc", tmpHome())).toThrow(/invalid seat id/);
  });
});

describe("the door names the seat", () => {
  it("turns a typed name into a stable seat id", () => {
    expect(operatorIdFromName("Alice")).toBe("alice");
    expect(operatorIdFromName("  Àlex  Pérez ")).toBe("alex-perez");
    expect(operatorIdFromName("../../etc")).toBe("etc");
    expect(operatorIdFromName("???")).toBeNull();
  });

  it("cleans a display name and refuses empty or oversized ones", () => {
    expect(sanitizeDisplayName("  Bob   the <b>Builder</b> ")).toBe("Bob the bBuilder/b");
    expect(sanitizeDisplayName("   ")).toBeNull();
    expect(sanitizeDisplayName("x".repeat(41))).toBeNull();
    expect(sanitizeDisplayName(42)).toBeNull();
  });

  it("upserts one record per name, so re-entering the same name keeps the same seat", () => {
    const first = upsertOperator([], "Alice");
    expect(first?.record).toEqual({ deviceId: "alice", operatorId: "alice", displayName: "Alice" });
    const again = upsertOperator(first!.records, "ALICE");
    expect(again?.records).toHaveLength(1);
    expect(again?.record.displayName).toBe("ALICE");
    const bob = upsertOperator(again!.records, "Bob");
    expect(bob?.records.map((r) => r.deviceId).sort()).toEqual(["alice", "bob"]);
    expect(upsertOperator([], "")).toBeNull();
  });

  it("round-trips the seat through operators.json and lookupOperator", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "hive-door-"));
    try {
      const seat = upsertOperator(loadOperators(home), "Alice")!;
      saveOperators(seat.records, home);
      expect(lookupOperator(loadOperators(home), "alice")?.displayName).toBe("Alice");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("sets a readable seat cookie scoped to /tinker", () => {
    const c = seatCookie("alice", false);
    expect(c.startsWith(`${TINKER_SEAT_COOKIE}=alice`)).toBe(true);
    expect(c).toContain("Path=/tinker");
    expect(c).not.toContain("HttpOnly");
    expect(seatCookie("alice", true)).toContain("Secure");
  });

  it("asks for a name on the login page", () => {
    const html = renderTinkerLoginPage();
    expect(html).toContain('name="name"');
    expect(html).toContain('name="token"');
  });
});
