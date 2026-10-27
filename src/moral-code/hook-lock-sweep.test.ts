import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEDUPE_WINDOW_MS,
  claim,
} from "../../claude-plugins/tinkerclaw-core/scripts/hook-common.mjs";

// 2026-10-23 (JarvisPi): the dedupe locks were never removed; on the Pi /tmp is RAM, and 21,000 of them held
// about 330 MB after a day and a half. The first slot of each session sweeps the locks of older buckets.
describe("hook dedupe locks", () => {
  const savedTmp = process.env.TMPDIR;
  let tmp = "";

  beforeEach(() => {
    // A fixed clock, so a bucket boundary can never fall between the test's `now` and claim's.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(1_800_000_005_000));
  });

  afterEach(() => {
    vi.useRealTimers();
    // process.env turns `undefined` into the string "undefined", so an unset TMPDIR has to stay unset.
    if (savedTmp === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = savedTmp;
    }
    if (tmp) {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  function lockDir() {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hook-lock-sweep-"));
    process.env.TMPDIR = tmp;
    const dir = path.join(tmp, "tinkerclaw-moral-code");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("slot 1 sweeps locks older than the previous bucket and keeps the two that still count", () => {
    const dir = lockDir();
    const now = Math.floor(Date.now() / DEDUPE_WINDOW_MS);
    for (const b of [now - 500, now - 3, now - 2]) {
      fs.writeFileSync(path.join(dir, `old-session-startup-p4-${b}`), "1");
    }
    fs.writeFileSync(path.join(dir, `other-session-startup-p2-${now - 1}`), "1");

    expect(claim("moral-code", "new-session", "startup", 1)).toBe(true);

    const left = fs.readdirSync(dir).toSorted();
    expect(left).toEqual(
      [`new-session-startup-p1-${now}`, `other-session-startup-p2-${now - 1}`].toSorted(),
    );
  });

  it("other slots leave the sweep to slot 1", () => {
    const dir = lockDir();
    const now = Math.floor(Date.now() / DEDUPE_WINDOW_MS);
    fs.writeFileSync(path.join(dir, `old-session-startup-p4-${now - 500}`), "1");

    expect(claim("moral-code", "new-session", "startup", 3)).toBe(true);

    expect(fs.readdirSync(dir)).toContain(`old-session-startup-p4-${now - 500}`);
  });

  it("still dedupes a second firing of the same slot", () => {
    lockDir();
    expect(claim("moral-code", "same-session", "startup", 1)).toBe(true);
    expect(claim("moral-code", "same-session", "startup", 1)).toBe(false);
  });
});
