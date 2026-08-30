import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// REGRESSION 2026-07-27 — the "SERRA Dades scan" wedge.
//
// `claude --resume <id>` on an id whose transcript .jsonl no longer exists exits
// code=1 with `No conversation found with session ID: <id>` before emitting a
// single stream event. The turn then surfaces as "ended with an incomplete
// terminal response" — and because nothing purged the binding, EVERY retry
// re-derived the same dead id from session-map.json. One tab died on every turn
// in ~1.3s with 0 tokens, unaffected by switching model or effort.
//
// SANDBOXING — read before touching this file.
//
// This suite calls clearSessionMap(), which UNLINKS the map. Redirecting $HOME
// is not sufficient: vitest may already have evaluated session-map.js in this
// worker process for a sibling test file, and a module-load-time path const
// keeps the real $HOME. That is not hypothetical — the first draft of this
// suite deleted the LIVE ~/.openclaw map and its 4,641 resume bindings
// (caught + restored from backup, 2026-07-27). session-map.ts now resolves its
// path at CALL time via OPENCLAW_TINKER_BRIDGE_SESSION_MAP, so the redirect
// works on a cached module too. The assertion in beforeAll is the second line
// of defence: it throws BEFORE any mutation if the path is not sandboxed.
let tmpHome: string;
let realHome: string | undefined;
let ClaudeCodeWorker: typeof import("./worker.js").ClaudeCodeWorker;
let setResumeSessionId: typeof import("./session-map.js").setResumeSessionId;
let forgetResumeSessionId: typeof import("./session-map.js").forgetResumeSessionId;
let getResumeSessionId: typeof import("./session-map.js").getResumeSessionId;
let getLatestResumeSessionIdByOpenclawSessionId: typeof import("./session-map.js").getLatestResumeSessionIdByOpenclawSessionId;
let clearSessionMap: typeof import("./session-map.js").clearSessionMap;
let getSessionMapPath: typeof import("./session-map.js").getSessionMapPath;

const DEAD = "04f52934-dead-4000-a000-000000000000";
const OC_SESSION = "72be302a-9d17-4e7c-b59d-12c4a0803481";

beforeAll(async () => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dead-resume-home-"));
  process.env.HOME = tmpHome;
  process.env.OPENCLAW_TINKER_BRIDGE_SESSION_MAP = path.join(tmpHome, "session-map.json");
  vi.resetModules();
  const sm = await import("./session-map.js");
  const mapPath = sm.getSessionMapPath();
  if (!mapPath.startsWith(tmpHome)) {
    throw new Error(
      `REFUSING TO RUN: session-map resolved to ${mapPath}, outside the sandbox ${tmpHome}. ` +
        `This suite calls clearSessionMap(), which would unlink the live map.`,
    );
  }
  setResumeSessionId = sm.setResumeSessionId;
  forgetResumeSessionId = sm.forgetResumeSessionId;
  getResumeSessionId = sm.getResumeSessionId;
  getLatestResumeSessionIdByOpenclawSessionId = sm.getLatestResumeSessionIdByOpenclawSessionId;
  clearSessionMap = sm.clearSessionMap;
  getSessionMapPath = sm.getSessionMapPath;
  ({ ClaudeCodeWorker } = await import("./worker.js"));
});

afterAll(() => {
  if (realHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = realHome;
  }
  delete process.env.OPENCLAW_TINKER_BRIDGE_SESSION_MAP;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  clearSessionMap();
});

/** Reproduce the live shape: many sessionKeys, all bound to ONE dead id,
 *  all sharing the openclawSessionId of a single long-lived tab. */
function seedWedgedMap(count: number): void {
  for (let i = 0; i < count; i++) {
    setResumeSessionId(`tinker-sp-twin${i}`, DEAD, OC_SESSION);
  }
}

describe("forgetResumeSessionId", () => {
  it("purges EVERY key bound to the dead id, not just one", () => {
    seedWedgedMap(22); // the live wedge had exactly 22 twins
    expect(forgetResumeSessionId(DEAD)).toBe(22);
    expect(getResumeSessionId("tinker-sp-twin0")).toBeUndefined();
    expect(getResumeSessionId("tinker-sp-twin21")).toBeUndefined();
  });

  // The crux: purging by sessionKey would leave twins behind, and the
  // by-openclawSessionId fallback would resurrect the same corpse next turn.
  it("leaves the by-openclawSessionId fallback with nothing to resurrect", () => {
    seedWedgedMap(5);
    expect(getLatestResumeSessionIdByOpenclawSessionId(OC_SESSION)).toBe(DEAD);
    forgetResumeSessionId(DEAD);
    expect(getLatestResumeSessionIdByOpenclawSessionId(OC_SESSION)).toBeUndefined();
  });

  it("spares bindings on OTHER ids (never a blanket wipe)", () => {
    seedWedgedMap(3);
    setResumeSessionId("tinker-sp-healthy", "live-session-id", "other-oc-session");
    expect(forgetResumeSessionId(DEAD)).toBe(3);
    expect(getResumeSessionId("tinker-sp-healthy")).toBe("live-session-id");
  });

  it("is a no-op for an unknown id and for an empty id", () => {
    seedWedgedMap(2);
    expect(forgetResumeSessionId("never-seen")).toBe(0);
    expect(forgetResumeSessionId("")).toBe(0);
    expect(getResumeSessionId("tinker-sp-twin0")).toBe(DEAD);
  });

  it("persists the purge to disk, so a gateway restart cannot resurrect the id", () => {
    seedWedgedMap(4);
    forgetResumeSessionId(DEAD);
    const onDisk = JSON.parse(fs.readFileSync(getSessionMapPath(), "utf8")) as Record<
      string,
      { sessionId: string }
    >;
    expect(Object.values(onDisk).filter((e) => e.sessionId === DEAD)).toHaveLength(0);
  });
});

describe("ClaudeCodeWorker dead-resume self-heal on exit", () => {
  // The constructor is inert (no subprocess spawn), so drive the private
  // stderr buffer + exit handler directly — same code the live worker runs.
  function exitWith(stderr: string, code: number | null = 1): void {
    const w = new ClaudeCodeWorker({ sessionKey: "tinker-sp-twin0", cwd: "/tmp" } as never);
    // biome-ignore lint/suspicious/noExplicitAny: test reaches private worker state
    const wAny = w as any;
    wAny.stderrBuf = stderr;
    wAny.onExit(code, null);
  }

  it("purges the id claude names in stderr", () => {
    seedWedgedMap(22);
    exitWith(`Error: No conversation found with session ID: ${DEAD}\n`);
    expect(getLatestResumeSessionIdByOpenclawSessionId(OC_SESSION)).toBeUndefined();
  });

  it("purges the named id even when it is not the exiting worker's own key", () => {
    // The live failure spawned under a FRESH sessionKey (tinker-sp-a938215e)
    // that had no map entry at all — the dead id came from the fallback lookup.
    seedWedgedMap(3);
    const w = new ClaudeCodeWorker({ sessionKey: "tinker-sp-unmapped", cwd: "/tmp" } as never);
    // biome-ignore lint/suspicious/noExplicitAny: test reaches private worker state
    const wAny = w as any;
    wAny.stderrBuf = `No conversation found with session ID: ${DEAD}`;
    wAny.onExit(1, null);
    expect(getLatestResumeSessionIdByOpenclawSessionId(OC_SESSION)).toBeUndefined();
  });

  it("leaves the map alone on an ordinary non-resume crash", () => {
    seedWedgedMap(3);
    exitWith("Error: ECONNRESET while streaming\n");
    expect(getLatestResumeSessionIdByOpenclawSessionId(OC_SESSION)).toBe(DEAD);
  });

  it("leaves the map alone on a clean exit", () => {
    seedWedgedMap(3);
    exitWith("", 0);
    expect(getLatestResumeSessionIdByOpenclawSessionId(OC_SESSION)).toBe(DEAD);
  });
});
