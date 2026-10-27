import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventStore } from "../../memory/engram/event-store.js";
import { EVENTS_SPOOL_DIRNAME } from "./paths.js";

// CONTROL (2026-10-10): the nightly run spooled one `j.consolidation.run` row PER STORE — 4,736
// rows in two seconds for one cycle — while the catalog (logging.md §4.12, J5) promises one row
// per consolidation cycle. The script owns the cycle, so it writes one aggregated row.
const script = fileURLToPath(new URL("../../../scripts/engram-sleep.mjs", import.meta.url));

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "engram-sleep-cycle-row-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedStore(baseDir: string, sessionKey: string, events: number): void {
  const store = createEventStore({ baseDir, sessionKey });
  for (let turnId = 0; turnId < events; turnId++) {
    store.append({
      turnId,
      sessionKey,
      kind: turnId % 2 === 0 ? "user_message" : "agent_message",
      content: `turn ${turnId} of ${sessionKey}`,
      tokens: 5,
      metadata: {},
    });
  }
}

function spooledRows(name: string): Array<Record<string, unknown>> {
  const dir = join(tmp, EVENTS_SPOOL_DIRNAME);
  return readdirSync(dir)
    .flatMap((file) => readFileSync(join(dir, file), "utf8").split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { name: string; record: Record<string, unknown> })
    .filter((row) => row.name === name)
    .map((row) => row.record);
}

describe("scripts/engram-sleep.mjs cycle row", () => {
  it("spools ONE j.consolidation.run row for a cycle over many stores", () => {
    const baseDir = join(tmp, "engram");
    seedStore(baseDir, "agent-main-a", 2);
    seedStore(baseDir, "agent-main-b", 1);
    seedStore(baseDir, "agent-main-c", 3);

    execFileSync(process.execPath, [script, "--base-dir", baseDir], {
      env: { ...process.env, OPENCLAW_EVENTS_DB_PATH: join(tmp, "events.sqlite") },
      stdio: "pipe",
      timeout: 120_000,
    });

    const rows = spooledRows("j.consolidation.run");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ n1: 6, n2: 0, n3: 0 });
    expect(typeof rows[0].durMs).toBe("number");
  }, 150_000);
});
