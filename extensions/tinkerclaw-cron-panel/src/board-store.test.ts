/**
 * FORK 2026-08-18 — behavioural gate on the board merge engine.
 *
 * Everything here is about the three invariants board-store.ts exists to hold:
 * identity survives a bumped counter, a dismissal is never silently overridden,
 * and an unread board compounds while a read one retires what stopped recurring.
 * Report files are written into a temp cronDir so no real cron data is touched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acknowledgeItem,
  boardDigest,
  boardDir,
  boardPath,
  dismissItem,
  ingestBoard,
  markRead,
  pinItem,
  readBoard,
  reorderItems,
  sortBoardItems,
  summarizeBoard,
} from "./board-store.js";
import { RESOLVE_AFTER_MISSED_RUNS } from "./board-types.js";
import type { CronPanelResolvedConfig } from "./cron-data.js";

const JOB = "test-cron";
const tmpRoots: string[] = [];

function makeCfg(): CronPanelResolvedConfig {
  const cronDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-board-"));
  tmpRoots.push(cronDir);
  return {
    cronDir,
    jobsPath: path.join(cronDir, "jobs.json"),
    statePath: path.join(cronDir, "jobs-state.json"),
    reportsDir: path.join(cronDir, "reports"),
  };
}

function writeReport(cfg: CronPanelResolvedConfig, date: string, bullets: string[]): void {
  const dir = path.join(cfg.reportsDir, date);
  fs.mkdirSync(dir, { recursive: true });
  const body = ["---", `job: ${JOB}`, "ran: yes", "status: ok", "headline: test", "---", ""]
    .concat(bullets.map((b) => `- ${b}`))
    .join("\n");
  fs.writeFileSync(path.join(dir, `${JOB}.md`), `${body}\n`, "utf8");
}

/** `2026-08-10` + n days, without dragging in a date library. */
function day(offset: number): string {
  const base = Date.UTC(2026, 7, 10) + offset * 86_400_000;
  return new Date(base).toISOString().slice(0, 10);
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ingestBoard identity", () => {
  it("merges a counter-bumped bullet into ONE aging item and re-ingest is idempotent", () => {
    const cfg = makeCfg();
    writeReport(cfg, day(0), ["FLAG: Baileys #49 day 29 still unpatched"]);
    ingestBoard(cfg, JOB);
    writeReport(cfg, day(1), ["**FLAG:** Baileys #49 day 30 still unpatched"]);
    const board = ingestBoard(cfg, JOB);

    expect(board.items).toHaveLength(1);
    expect(board.items[0].kind).toBe("flag");
    expect(board.items[0].runs).toBe(2);
    // Newest phrasing wins.
    expect(board.items[0].text).toBe("Baileys #49 day 30 still unpatched");
    expect(board.items[0].firstSeen).toBe(day(0));
    expect(board.items[0].lastSeen).toBe(day(1));

    // Re-ingesting with no new report date changes nothing.
    const again = ingestBoard(cfg, JOB);
    expect(again.items).toHaveLength(1);
    expect(again.items[0].runs).toBe(2);
    expect(again.lastIngestedDate).toBe(day(1));
  });

  it("keeps a title-plus-body letter as two lines, not one flattened sentence", () => {
    const cfg = makeCfg();
    const dir = path.join(cfg.reportsDir, day(0));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${JOB}.md`),
      [
        "---",
        `job: ${JOB}`,
        "ran: yes",
        "status: ok",
        "headline: test",
        "---",
        "- ASK: Confirm Thursday at Dexeus",
        "  Two minutes in the portal. Tell me who it is for.",
        "",
      ].join("\n"),
      "utf8",
    );
    const board = ingestBoard(cfg, JOB);
    expect(board.items[0].kind).toBe("ask");
    expect(board.items[0].text).toBe(
      "Confirm Thursday at Dexeus\nTwo minutes in the portal. Tell me who it is for.",
    );
  });

  it("treats an unknown prefix as a note and keeps the whole line", () => {
    const cfg = makeCfg();
    writeReport(cfg, day(0), ["Something odd: the fan spun up"]);
    const board = ingestBoard(cfg, JOB);
    expect(board.items[0].kind).toBe("note");
    expect(board.items[0].text).toBe("Something odd: the fan spun up");
  });

  // REGRESSION (2026-08-18). volatilityStrippedText originally guarded identifiers
  // by rewriting `#49` → `ID49ID` and restoring after the numeric sweep — but the
  // sweep ate the digits inside the sentinel first, so `#49` and `#50` both
  // flattened to "id id" and two unrelated issues MERGED into one board item.
  // That is the inverse of the failure the function exists to prevent, and the
  // worse direction: a wrongly-merged item silently hides a real issue behind
  // another one's text. Sentinels are now letter-encoded so the sweep cannot see
  // them. This test is the guard.
  it("keeps two different identifiers (#49 vs #50, CVE-A vs CVE-B) as DISTINCT items", () => {
    const cfg = makeCfg();
    writeReport(cfg, day(0), [
      "FLAG: Baileys #49 still unpatched",
      "FLAG: Baileys #50 still unpatched",
      "CHANGED: CVE-2026-53359 pending 6.8.0-138",
      "CHANGED: CVE-2026-46331 pending 6.8.0-138",
    ]);
    const board = ingestBoard(cfg, JOB);

    expect(board.items).toHaveLength(4);
    expect(new Set(board.items.map((i) => i.id)).size).toBe(4);

    // ...while the INTENDED merge still works: same identifier, bumped counter.
    writeReport(cfg, day(1), ["FLAG: Baileys #49 day 31 still unpatched"]);
    const merged = ingestBoard(cfg, JOB);
    expect(merged.items).toHaveLength(4);
    expect(merged.items.find((i) => i.text.includes("#49"))?.runs).toBe(2);
    expect(merged.items.find((i) => i.text.includes("#50"))?.runs).toBe(1);
  });
});

describe("reworded recurrence (measured 2026-08-18: exact hashing merged 5 of 1317)", () => {
  it("merges the SAME issue across nights when the cron rewrites its prose", () => {
    const cfg = makeCfg();
    writeReport(cfg, day(0), [
      "FLAG: root disk at 96% — 69 dist.bak-* build backups hold 132 GB against 37 GB free, with no rotation",
    ]);
    ingestBoard(cfg, JOB);
    writeReport(cfg, day(1), [
      "FLAG: stale build data is ~136 GB against 37 GB free, root disk at 96%, dist.bak-* backups still unrotated",
    ]);
    const board = ingestBoard(cfg, JOB);

    const open = board.items.filter((i) => i.status === "open");
    expect(open).toHaveLength(1);
    expect(open[0].runs).toBe(2);
    expect(open[0].firstSeen).toBe(day(0));
    expect(open[0].text).toContain("136 GB");
  });

  it("does NOT merge two different issues that merely share vocabulary", () => {
    const cfg = makeCfg();
    writeReport(cfg, day(0), [
      "FLAG: Baileys #49 pin is exact and the vendored patch is keyed to that literal version",
      "FLAG: Baileys #50 is a separate advisory with its own upstream fix pending review",
    ]);
    const board = ingestBoard(cfg, JOB);
    expect(board.items.filter((i) => i.status === "open")).toHaveLength(2);
  });

  // The cross-kind rule is a FUZZY-path guard, not a global one, and the split is
  // deliberate. Byte-identical text under a new tag is one issue being
  // re-classified (a FLAG that de-escalates to CHANGED), so it merges and adopts
  // the new kind. Merely SIMILAR text under a different tag is not safe to fuse:
  // "flagging X" and "changed X" can be two different claims about one subject,
  // and approximate matching is not a good enough reason to lose one of them.
  it("never merges across kinds, by either identity tier", () => {
    const cfg = makeCfg();
    writeReport(cfg, day(0), [
      "FLAG: the gateway restarted with no deploy and the cause is not established",
    ]);
    ingestBoard(cfg, JOB);
    // Byte-identical text, different tag. `kind` is part of stableItemId, so the
    // EXACT tier splits them too — the two tiers must not disagree, and a FLAG
    // asking the architect for something is not the same claim as a CHANGED telling him.
    writeReport(cfg, day(1), [
      "CHANGED: the gateway restarted with no deploy and the cause is not established",
    ]);
    const identical = ingestBoard(cfg, JOB);
    expect(identical.items).toHaveLength(2);
    expect(new Set(identical.items.map((i) => i.kind))).toEqual(new Set(["flag", "changed"]));

    // Reworded (not identical) under a different kind stays its own item.
    const cfg2 = makeCfg();
    writeReport(cfg2, day(0), [
      "FLAG: the gateway restarted with no deploy and the cause is not established",
    ]);
    ingestBoard(cfg2, JOB);
    writeReport(cfg2, day(1), [
      "CHANGED: the gateway restarted last night without any deploy, cause still unestablished",
    ]);
    const board = ingestBoard(cfg2, JOB);
    expect(board.items).toHaveLength(2);
  });

  it("keeps two bullets from the SAME report distinct even when near-identical", () => {
    const cfg = makeCfg();
    writeReport(cfg, day(0), [
      "CHANGED: repriced glm-5.2 in config, output rose while input fell against the live catalog",
      "CHANGED: repriced deepseek-v4-flash in config, output rose while input fell against the live catalog",
    ]);
    const board = ingestBoard(cfg, JOB);
    expect(board.items).toHaveLength(2);
  });
});

describe("dismissal", () => {
  it("keeps a dismissed item dismissed when it recurs, and counts the recurrence", () => {
    const cfg = makeCfg();
    writeReport(cfg, day(0), ["CHANGED: disk usage crossed 80%"]);
    const first = ingestBoard(cfg, JOB);
    const id = first.items[0].id;

    expect(() => dismissItem(cfg, JOB, id, "   ")).toThrow(/reason/i);
    dismissItem(cfg, JOB, id, "known, the NAS rsync runs Sundays");

    writeReport(cfg, day(1), ["CHANGED: disk usage crossed 82%"]);
    const board = ingestBoard(cfg, JOB);

    expect(board.items).toHaveLength(1);
    expect(board.items[0].status).toBe("dismissed");
    expect(board.items[0].recurrencesSinceDismissal).toBe(1);
    expect(board.items[0].dismissReason).toBe("known, the NAS rsync runs Sundays");
    expect(summarizeBoard(board).openCount).toBe(0);
    expect(summarizeBoard(board).dismissedCount).toBe(1);
  });

  it("replays the dismissal reason VERBATIM to the cron agent in the digest", () => {
    const cfg = makeCfg();
    writeReport(cfg, day(0), ["FLAG: ClawHub install count flat for a week"]);
    const first = ingestBoard(cfg, JOB);
    dismissItem(cfg, JOB, first.items[0].id, "installs are vanity, stop reporting them");

    const digest = boardDigest(cfg, JOB);
    expect(digest).toContain("DISMISSED BY OSCAR");
    expect(digest).toContain("DO NOT RE-RAISE");
    expect(digest).toContain("installs are vanity, stop reporting them");
    expect(digest.length).toBeLessThan(2200);
  });
});

describe("read / compound contract", () => {
  it("archives acknowledged items that stop recurring and reopens the page as unread", () => {
    const cfg = makeCfg();
    writeReport(cfg, day(0), ["FLAG: gateway restart loop", "NOTE: weekly backup ran"]);
    ingestBoard(cfg, JOB);

    const read = markRead(cfg, JOB, true);
    expect(read.readAt).not.toBeNull();
    expect(read.items.every((i) => i.acknowledged === true)).toBe(true);
    expect(summarizeBoard(read).unread).toBe(false);
    expect(summarizeBoard(read).ackedCount).toBe(2);

    writeReport(cfg, day(1), ["FLAG: gateway restart loop"]);
    const board = ingestBoard(cfg, JOB);

    expect(board.readAt).toBeNull();
    expect(board.items.map((i) => i.text)).toEqual(["gateway restart loop"]);
    expect(board.items[0].acknowledged).toBe(false);
    expect(board.archived.map((i) => i.text)).toEqual(["weekly backup ran"]);
    expect(summarizeBoard(board).unread).toBe(true);
  });

  it("compounds while unread — nothing is retired without a read-ack", () => {
    const cfg = makeCfg();
    writeReport(cfg, day(0), ["FLAG: gateway restart loop", "NOTE: weekly backup ran"]);
    ingestBoard(cfg, JOB);
    writeReport(cfg, day(1), ["FLAG: gateway restart loop"]);
    const board = ingestBoard(cfg, JOB);
    expect(board.items).toHaveLength(2);
    expect(board.archived).toHaveLength(0);
  });

  it("retires only the ticked issue — an unticked sibling compounds even after a later ingest", () => {
    const cfg = makeCfg();
    writeReport(cfg, day(0), ["FLAG: gateway restart loop", "NOTE: weekly backup ran"]);
    const first = ingestBoard(cfg, JOB);
    const backup = first.items.find((i) => i.text === "weekly backup ran")!;
    acknowledgeItem(cfg, JOB, backup.id, true);

    writeReport(cfg, day(1), ["FLAG: gateway restart loop"]);
    const board = ingestBoard(cfg, JOB);
    expect(board.items.map((i) => i.text)).toEqual(["gateway restart loop"]);
    expect(board.archived.map((i) => i.text)).toEqual(["weekly backup ran"]);
    expect(board.items[0].acknowledged).not.toBe(true);
    expect(board.readAt).toBeNull();
  });
});

describe("auto-resolve by absence", () => {
  it("resolves an item after RESOLVE_AFTER_MISSED_RUNS missed dates and un-resolves it if it returns", () => {
    const cfg = makeCfg();
    writeReport(cfg, day(0), ["FAILED: nightly sync aborted", "NOTE: heartbeat"]);
    ingestBoard(cfg, JOB);

    for (let k = 1; k <= RESOLVE_AFTER_MISSED_RUNS; k++)
      writeReport(cfg, day(k), ["NOTE: heartbeat"]);
    const resolved = ingestBoard(cfg, JOB);
    const gone = resolved.items.find((i) => i.text === "nightly sync aborted");
    expect(gone?.status).toBe("resolved");
    expect(gone?.resolvedAt).toBeTruthy();
    expect(summarizeBoard(resolved).openCount).toBe(1);

    writeReport(cfg, day(RESOLVE_AFTER_MISSED_RUNS + 1), [
      "FAILED: nightly sync aborted",
      "NOTE: heartbeat",
    ]);
    const back = ingestBoard(cfg, JOB);
    const again = back.items.find((i) => i.text === "nightly sync aborted");
    expect(again?.status).toBe("open");
    expect(again?.resolvedAt).toBeUndefined();
    expect(again?.runs).toBe(2);
  });

  it("never auto-resolves a pinned or dismissed item", () => {
    const cfg = makeCfg();
    writeReport(cfg, day(0), ["FLAG: pin me", "FLAG: dismiss me", "NOTE: heartbeat"]);
    const first = ingestBoard(cfg, JOB);
    const pinned = first.items.find((i) => i.text === "pin me");
    const dismissed = first.items.find((i) => i.text === "dismiss me");
    pinItem(cfg, JOB, pinned!.id, true);
    dismissItem(cfg, JOB, dismissed!.id, "not interesting");

    for (let k = 1; k <= RESOLVE_AFTER_MISSED_RUNS; k++)
      writeReport(cfg, day(k), ["NOTE: heartbeat"]);
    const board = ingestBoard(cfg, JOB);
    expect(board.items.find((i) => i.text === "pin me")?.status).toBe("open");
    expect(board.items.find((i) => i.text === "dismiss me")?.status).toBe("dismissed");
  });
});

describe("ordering and robustness", () => {
  it("reorders listed ids first and keeps the rest in relative order", () => {
    const cfg = makeCfg();
    writeReport(cfg, day(0), ["NOTE: a", "NOTE: b", "NOTE: c"]);
    const first = ingestBoard(cfg, JOB);
    const byText = new Map(first.items.map((i) => [i.text, i.id] as const));

    const board = reorderItems(cfg, JOB, [byText.get("c")!, byText.get("a")!]);
    expect(sortBoardItems(board.items).map((i) => i.text)).toEqual(["c", "a", "b"]);

    const withPin = pinItem(cfg, JOB, byText.get("b")!, true);
    expect(sortBoardItems(withPin.items)[0].text).toBe("b");
  });

  it("falls back to an empty board when the file is missing or corrupt", () => {
    const cfg = makeCfg();
    expect(readBoard(cfg, JOB)).toEqual({
      jobId: JOB,
      readAt: null,
      lastIngestedDate: null,
      items: [],
      archived: [],
    });
    fs.mkdirSync(boardDir(cfg), { recursive: true });
    fs.writeFileSync(boardPath(cfg, JOB), "{ not json", "utf8");
    expect(readBoard(cfg, JOB).items).toEqual([]);
  });

  it("never writes outside the board directory for a hostile job id", () => {
    const cfg = makeCfg();
    const p = boardPath(cfg, "../../escape");
    expect(path.dirname(p)).toBe(boardDir(cfg));
  });
});
