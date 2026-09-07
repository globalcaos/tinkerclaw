import { describe, expect, it } from "vitest";
import {
  detectArchivedStateTwin,
  guardArchivedStateFile,
  restoreArchivedStateTwin,
  type StateFileGuardFs,
} from "./state-file-guard.js";

/** In-memory fs: path -> byte size. Absent key means the file does not exist. */
function fakeFs(
  initial: Record<string, number>,
): StateFileGuardFs & { files: Map<string, number> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    exists: (p) => files.has(p),
    sizeOf: (p) => files.get(p) ?? 0,
    rename: (from, to) => {
      const size = files.get(from);
      if (size === undefined) {
        throw new Error(`ENOENT: ${from}`);
      }
      files.delete(from);
      files.set(to, size);
    },
  };
}

const DB = "/state/tasks/runs.sqlite";

describe("detectArchivedStateTwin", () => {
  it("returns null when the canonical database exists", () => {
    // The common case, and the one that must never trigger a repair.
    const fs = fakeFs({ [DB]: 1961984, [`${DB}.migrated`]: 999 });
    expect(detectArchivedStateTwin(DB, fs)).toBeNull();
  });

  it("returns null when nothing at all is present", () => {
    const fs = fakeFs({});
    expect(detectArchivedStateTwin(DB, fs)).toBeNull();
  });

  it("finds a .migrated twin when the canonical database is gone", () => {
    const fs = fakeFs({ [`${DB}.migrated`]: 1961984 });
    expect(detectArchivedStateTwin(DB, fs)).toEqual({
      canonicalPath: DB,
      archivedPath: `${DB}.migrated`,
      suffix: ".migrated",
      bytes: 1961984,
    });
  });

  it("ignores a zero-byte archive, which is worth no more than a fresh database", () => {
    const fs = fakeFs({ [`${DB}.migrated`]: 0 });
    expect(detectArchivedStateTwin(DB, fs)).toBeNull();
  });

  it("prefers .migrated over .bak when both are present", () => {
    const fs = fakeFs({ [`${DB}.migrated`]: 100, [`${DB}.bak`]: 200 });
    expect(detectArchivedStateTwin(DB, fs)?.suffix).toBe(".migrated");
  });
});

describe("restoreArchivedStateTwin", () => {
  it("restores the main database and its WAL/SHM sidecars", () => {
    const fs = fakeFs({
      [`${DB}.migrated`]: 1961984,
      [`${DB}-wal.migrated`]: 0,
      [`${DB}-shm.migrated`]: 32768,
    });
    const twin = detectArchivedStateTwin(DB, fs);
    expect(twin).not.toBeNull();
    restoreArchivedStateTwin(twin!, fs);

    expect(fs.exists(DB)).toBe(true);
    expect(fs.exists(`${DB}-wal`)).toBe(true);
    expect(fs.exists(`${DB}-shm`)).toBe(true);
    expect(fs.exists(`${DB}.migrated`)).toBe(false);
    expect(fs.sizeOf(DB)).toBe(1961984);
  });

  it("restores the main database even when no sidecars were archived", () => {
    const fs = fakeFs({ [`${DB}.migrated`]: 512 });
    restoreArchivedStateTwin(detectArchivedStateTwin(DB, fs)!, fs);
    expect(fs.exists(DB)).toBe(true);
  });

  it("refuses to overwrite a canonical file that appeared in the meantime", () => {
    // Fill a hole; never clobber. If something else won the race, stand down.
    const fs = fakeFs({ [`${DB}.migrated`]: 1961984 });
    const twin = detectArchivedStateTwin(DB, fs)!;
    fs.files.set(DB, 4096); // a live database materialises before we act
    restoreArchivedStateTwin(twin, fs);
    expect(fs.sizeOf(DB)).toBe(4096);
    expect(fs.exists(`${DB}.migrated`)).toBe(true);
  });

  it("does not clobber an existing sidecar", () => {
    const fs = fakeFs({ [`${DB}.migrated`]: 100, [`${DB}-wal.migrated`]: 10, [`${DB}-wal`]: 77 });
    restoreArchivedStateTwin(detectArchivedStateTwin(DB, fs)!, fs);
    expect(fs.sizeOf(`${DB}-wal`)).toBe(77);
  });
});

describe("guardArchivedStateFile", () => {
  it("reproduces the 2026-07-29 incident: upstream archived the live registry aside", () => {
    // Upstream OpenClaw's doctor renamed runs.sqlite -> runs.sqlite.migrated
    // while the fork gateway held it open. Without the guard, the next open
    // creates an empty database and orphans 258 task runs.
    const fs = fakeFs({
      [`${DB}.migrated`]: 1961984,
      [`${DB}-wal.migrated`]: 0,
      [`${DB}-shm.migrated`]: 32768,
    });
    const restored = guardArchivedStateFile(DB, fs);
    expect(restored?.archivedPath).toBe(`${DB}.migrated`);
    expect(restored?.bytes).toBe(1961984);
    expect(fs.exists(DB)).toBe(true);
  });

  it("is a no-op on a healthy install, and reports nothing", () => {
    const fs = fakeFs({ [DB]: 1961984, [`${DB}-wal`]: 0 });
    expect(guardArchivedStateFile(DB, fs)).toBeNull();
    expect(fs.sizeOf(DB)).toBe(1961984);
  });

  it("is idempotent across repeated opens", () => {
    const fs = fakeFs({ [`${DB}.migrated`]: 1961984 });
    expect(guardArchivedStateFile(DB, fs)).not.toBeNull();
    expect(guardArchivedStateFile(DB, fs)).toBeNull();
    expect(fs.sizeOf(DB)).toBe(1961984);
  });
});
