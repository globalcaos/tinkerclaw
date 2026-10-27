import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeFractalLedgerParams,
  readFractalLedger,
  resolveFractalLedgerPath,
} from "./ledger.js";

// The ledger reader (charter C3): newest last, filtered by parent run, a torn or junk line skipped, no file = no rows.

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "fractal-ledger-"));
  file = path.join(dir, "ledger.jsonl");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const row = (p: string, ts: number) =>
  JSON.stringify({ v: 1, ts, parentRunId: p, runId: `fractal-${p}`, verdict: "clean" });

describe("readFractalLedger", () => {
  it("a missing file is no rows", async () => {
    expect(await readFractalLedger({ file: path.join(dir, "nope.jsonl") })).toEqual({ rows: [] });
  });

  it("skips bad lines and keeps file order", async () => {
    await fs.writeFile(
      file,
      [row("A", 1), "not json", "[1,2]", "", '{"torn": ', row("B", 2), "null", row("C", 3)].join(
        "\n",
      ),
    );
    const { rows } = await readFractalLedger({ file });
    expect(rows.map((r) => r.parentRunId)).toEqual(["A", "B", "C"]);
  });

  it("filters by parentRunIds and keeps the newest `limit`", async () => {
    await fs.writeFile(
      file,
      [row("A", 1), row("B", 2), row("A", 3), row("C", 4), row("A", 5)].join("\n") + "\n",
    );
    const a = await readFractalLedger({ file, parentRunIds: ["A", "C"], limit: 2 });
    expect(a.rows.map((r) => r.ts)).toEqual([4, 5]);
    expect((await readFractalLedger({ file, parentRunIds: [] })).rows).toEqual([]);
  });

  it("the limit holds over a long file", async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => row(`R${i}`, i));
    await fs.writeFile(file, lines.join("\n"));
    const { rows } = await readFractalLedger({ file, limit: 7 });
    expect(rows.map((r) => r.ts)).toEqual([993, 994, 995, 996, 997, 998, 999]);
  });
});

describe("params and path", () => {
  it("defaults to 200 and clamps", () => {
    expect(normalizeFractalLedgerParams({})).toEqual({ limit: 200 });
    expect(normalizeFractalLedgerParams({ limit: 0 }).limit).toBe(1);
    expect(normalizeFractalLedgerParams({ limit: 1e9 }).limit).toBe(5000);
    expect(normalizeFractalLedgerParams({ parentRunIds: ["a", 3, ""] })).toEqual({
      parentRunIds: ["a"],
      limit: 200,
    });
  });

  it("lives under <stateDir>/data/fractal", () => {
    expect(resolveFractalLedgerPath("/s")).toBe("/s/data/fractal/ledger.jsonl");
  });
});
