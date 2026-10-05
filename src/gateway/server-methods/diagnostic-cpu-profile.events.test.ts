/**
 * TINKER_UI_DESIGN_BIBLE/logging.md §4.1 `gw.profile.captured` (§9 step 4) — the row
 * `diagnostic.cpuProfile` writes once the .cpuprofile file exists.
 *
 * CONTROL: before this change the RPC wrote a file, answered a summary, and recorded NOTHING. No
 * row named a profile, so §4.1's question — "was a CPU profile taken during this incident, and
 * which one?" — could only be answered by listing a directory, and not at all for a past incident
 * whose files had been cleaned up. Both tests below fail on the missing row.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCatalogEvent } from "../../infra/events/catalog.js";
import { diagnosticCpuProfileHandlers } from "./diagnostic-cpu-profile.js";

type Row = { name: string; record: Record<string, unknown> };

/** vi.hoisted: the mock factory runs above the imports, so its sink has to be created there too. */
const { rows } = vi.hoisted(() => ({ rows: [] as Row[] }));

vi.mock("../../infra/events/emit.js", () => ({
  emitEvent: (name: string, record: Record<string, unknown> = {}) => {
    rows.push({ name, record });
  },
}));

type Handler = (args: {
  params: unknown;
  respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
}) => Promise<void>;

async function callHandler(params: unknown): Promise<Record<string, unknown>> {
  let payload: unknown;
  const handler = diagnosticCpuProfileHandlers["diagnostic.cpuProfile"] as unknown as Handler;
  await handler({
    params,
    respond: (_ok, p) => {
      payload = p;
    },
  });
  return payload as Record<string, unknown>;
}

function burnCpuForMs(ms: number): number {
  const end = performance.now() + ms;
  let x = 0;
  while (performance.now() < end) {
    x += Math.sqrt(x + 1);
  }
  return x;
}

/** emit.ts's own id rule, restated so a value the writer would silently drop fails HERE instead. */
const ID_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$/;

const tmpDirs: string[] = [];

beforeEach(() => {
  rows.length = 0;
});

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("gw.profile.captured (logging.md §4.1)", () => {
  it("writes exactly one row of its catalog entry's declared shape, naming the file by basename", async () => {
    const entry = getCatalogEvent("gw.profile.captured");
    expect(entry?.kind).toBe("mark");
    expect(entry?.label).toBeNull();
    expect(entry?.fields).toEqual({ profile_id: "id" });

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cpuprofile-events-"));
    tmpDirs.push(dir);
    setTimeout(() => {
      burnCpuForMs(60);
    }, 5);
    const payload = await callHandler({ durationMs: 150, samplingIntervalUs: 500, outDir: dir });
    expect(payload.ok).toBe(true);

    expect(rows.map((row) => row.name)).toEqual(["gw.profile.captured"]);
    const record = rows[0].record;
    const summary = payload.summary as { samples: number };
    expect(summary.samples).toBeGreaterThan(0);
    expect(record.n1).toBe(150);
    expect(record.n2).toBe(summary.samples);
    // Declared slots ONLY: §4.1 gives this row no label, no n3 and no n4, and a value in any of
    // them would be counted as invalidValues by the writer without a word.
    expect(record.label).toBeUndefined();
    expect(record.n3).toBeUndefined();
    expect(record.n4).toBeUndefined();

    const fields = record.fields as { profile_id: string };
    expect(fields.profile_id).toBe(path.basename(payload.file as string));
    // L4: the basename, never the path — the default profile directory is under a home directory.
    expect(fields.profile_id).not.toContain("/");
    expect(fields.profile_id).not.toContain(dir);
    expect(fields.profile_id).toMatch(ID_VALUE);
  }, 20_000);

  it("CONTROL: a refused profile writes no row — a row always has a written file behind it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cpuprofile-events-"));
    tmpDirs.push(dir);
    const first = callHandler({ durationMs: 400, outDir: dir });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const refused = await callHandler({ durationMs: 10, outDir: dir });
    expect(refused.ok).toBe(false);
    expect(rows).toEqual([]);
    expect((await first).ok).toBe(true);
    expect(rows.map((row) => row.name)).toEqual(["gw.profile.captured"]);
  }, 20_000);
});
