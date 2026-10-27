import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVENT_CATALOG,
  EVENT_KINDS,
  EVENT_NAME_PATTERN,
  FIELD_TYPES,
  getCatalogEvent,
  RETENTION_CLASSES,
} from "./catalog.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scriptPath = join(repoRoot, "scripts", "bible", "logging-catalog.mjs");
const catalogTsPath = join(repoRoot, "src", "infra", "events", "catalog.ts");
const loggingMdPath = join(repoRoot, "TINKER_UI_DESIGN_BIBLE", "logging.md");

// The events-table columns (logging.md §7.3) plus the three property names the bible gate
// parses textually out of catalog.ts. A declared field key shadowing any of these would either
// collide with a real column or break the gate's format contract.
const RESERVED_FIELD_KEYS = new Set([
  "ts_ms",
  "name",
  "kind",
  "retention",
  "boot_id",
  "session_hash",
  "session_kind",
  "run_id",
  "worker_id",
  "label",
  "dur_ms",
  "n1",
  "n2",
  "n3",
  "n4",
  "fields",
]);

describe("event catalog (logging.md §4 as data)", () => {
  it("declares unique names inside the dotted grammar", () => {
    const names = EVENT_CATALOG.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(EVENT_NAME_PATTERN);
    }
  });

  it("draws kind, retention, paper and field types from the closed sets", () => {
    const kinds = new Set<string>(EVENT_KINDS);
    const retentions = new Set<string>(RETENTION_CLASSES);
    const fieldTypes = new Set<string>(FIELD_TYPES);
    for (const e of EVENT_CATALOG) {
      expect(kinds.has(e.kind), e.name).toBe(true);
      expect(retentions.has(e.retention), e.name).toBe(true);
      if (e.paper !== null) {
        expect(e.paper, e.name).toMatch(/^J([1-9]|1[0-9]|20)$/);
      }
      for (const [key, type] of Object.entries(e.fields)) {
        expect(key, `${e.name}.${key}`).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(
          RESERVED_FIELD_KEYS.has(key),
          `${e.name}.${key} shadows a column or a gate-parsed property`,
        ).toBe(false);
        expect(fieldTypes.has(type), `${e.name}.${key}`).toBe(true);
      }
      expect(typeof e.uiIngestable, e.name).toBe("boolean");
    }
  });

  it("states the question every event answers (the frontmatter gate's bar)", () => {
    for (const e of EVENT_CATALOG) {
      expect(e.question.length, e.name).toBeGreaterThanOrEqual(12);
    }
  });

  it("every span states what dur_ms measures", () => {
    for (const e of EVENT_CATALOG.filter((r) => r.kind === "span")) {
      expect(e.durMs, e.name).not.toBeNull();
    }
  });

  it("j.* rows and the paper column travel together, always research retention (§4.12, §7.3)", () => {
    for (const e of EVENT_CATALOG) {
      expect(e.paper !== null, e.name).toBe(e.name.startsWith("j."));
      if (e.paper !== null) {
        expect(e.retention, e.name).toBe("research");
      }
    }
  });

  it("only ui.* rows are UI-ingestable, and all of them are (§8.2: the UI cannot forge a gateway event)", () => {
    for (const e of EVENT_CATALOG) {
      expect(e.uiIngestable, e.name).toBe(e.name.startsWith("ui."));
    }
  });

  it("getCatalogEvent answers by name and returns undefined for an undeclared one", () => {
    expect(getCatalogEvent("gw.boot")?.kind).toBe("mark");
    expect(getCatalogEvent("zz.not.declared")).toBeUndefined();
  });
});

describe("scripts/bible/logging-catalog.mjs — §4 and catalog.ts agree in both directions", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function runScript(args: string[] = []) {
    return spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8" });
  }

  /** Writes doctored FIXTURE copies to a tmp dir; the real files are never touched. */
  function writeFixtures(tsSource: string, mdSource: string): [string, string] {
    const dir = mkdtempSync(join(tmpdir(), "logging-catalog-"));
    tmpDirs.push(dir);
    const ts = join(dir, "catalog.ts");
    const md = join(dir, "logging.md");
    writeFileSync(ts, tsSource);
    writeFileSync(md, mdSource);
    return [ts, md];
  }

  it("passes on the real tree", () => {
    const res = runScript();
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("logging catalog:");
  });

  it("a name only in code makes the script fail (fixture copies)", () => {
    const src = readFileSync(catalogTsPath, "utf8");
    const marker = "  // catalog rows end";
    expect(src).toContain(marker);
    const bogus =
      '  {\n    name: "zz.bogus.only_in_code",\n    kind: "mark",\n    retention: "event",\n  },\n';
    const [ts, md] = writeFixtures(
      src.replace(marker, `${bogus}${marker}`),
      readFileSync(loggingMdPath, "utf8"),
    );
    const res = runScript([ts, md]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("zz.bogus.only_in_code");
  });

  it("a name only in §4 makes the script fail (fixture copies)", () => {
    const src = readFileSync(catalogTsPath, "utf8");
    const at = src.indexOf('name: "j.orca.lease"');
    expect(at).toBeGreaterThan(-1);
    const open = src.lastIndexOf("\n  {", at);
    const close = src.indexOf("\n  },", at) + "\n  },".length;
    const [ts, md] = writeFixtures(
      src.slice(0, open) + src.slice(close),
      readFileSync(loggingMdPath, "utf8"),
    );
    const res = runScript([ts, md]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("j.orca.lease");
  });

  it("a kind disagreement on a shared name makes the script fail (fixture copies)", () => {
    const src = readFileSync(catalogTsPath, "utf8");
    const at = src.indexOf('name: "gw.boot"');
    expect(at).toBeGreaterThan(-1);
    const kindAt = src.indexOf('kind: "mark"', at);
    expect(kindAt).toBeGreaterThan(at);
    const doctored =
      src.slice(0, kindAt) + 'kind: "sample"' + src.slice(kindAt + 'kind: "mark"'.length);
    const [ts, md] = writeFixtures(doctored, readFileSync(loggingMdPath, "utf8"));
    const res = runScript([ts, md]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("`gw.boot`: code says sample/event, §4 says mark/event");
  });

  it("still fails on drift when the script is reached through a symlink (no silent exit 0)", () => {
    const src = readFileSync(catalogTsPath, "utf8");
    const marker = "  // catalog rows end";
    const bogus =
      '  {\n    name: "zz.bogus.via_symlink",\n    kind: "mark",\n    retention: "event",\n  },\n';
    const [ts, md] = writeFixtures(
      src.replace(marker, `${bogus}${marker}`),
      readFileSync(loggingMdPath, "utf8"),
    );
    const linkDir = mkdtempSync(join(tmpdir(), "logging-catalog-link-"));
    tmpDirs.push(linkDir);
    const linked = join(linkDir, "logging-catalog.mjs");
    symlinkSync(scriptPath, linked);
    const res = spawnSync(process.execPath, [linked, ts, md], { encoding: "utf8" });
    expect(res.status, res.stdout).toBe(1);
    expect(res.stderr).toContain("zz.bogus.via_symlink");
  });
});
