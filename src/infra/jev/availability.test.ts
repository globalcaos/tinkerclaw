import { describe, expect, it, vi } from "vitest";
import { createJevAvailability, type JevAvailabilityDeps } from "./availability.js";

// One source says whether Jev can be asked at all: no token = dormant (nothing is asked, nothing errors), a token arms
// itself without a restart when it arrives in the key file, and the snapshot never carries the token.

type Fs = { text?: string; mtime: number };

function harness(over: Partial<JevAvailabilityDeps> = {}) {
  const fs: Fs = { mtime: 1 };
  const env: Record<string, string | undefined> = {};
  let t = 1_000;
  const info = vi.fn();
  const warn = vi.fn();
  const j = createJevAvailability({
    env: () => env,
    tokenFile: () => "/state/jev/token",
    readFile: () => fs.text,
    statFile: () => (fs.text === undefined ? undefined : fs.mtime),
    now: () => t,
    logger: { info, warn },
    ...over,
  });
  return {
    j,
    fs,
    env,
    info,
    warn,
    tick: (ms: number) => {
      t += ms;
    },
  };
}

describe("jev availability: state from the token", () => {
  it("is dormant with no token anywhere", () => {
    const { j } = harness();
    const s = j.snapshot();
    expect(s.state).toBe("dormant");
    expect(s.on).toBe(false);
    expect(s.reason).toBe("no-token");
    expect(s.keySource).toBeNull();
    expect(j.token()).toBeUndefined();
    expect(s.line).toMatch(
      /^Jev: off — no token \(enables: safety checks, routing reads, recipe ranking\)$/,
    );
  });

  it("is unverified (askable) when the environment holds a token", () => {
    const { j, env } = harness();
    env.TYPESAFE_API_KEY = "tok-env";
    j.refresh();
    const s = j.snapshot();
    expect(s.state).toBe("unverified");
    expect(s.on).toBe(true);
    expect(s.keySource).toBe("env");
    expect(j.token()).toBe("tok-env");
  });

  it("reads the key file: a raw token, a KEY= line, quotes and comments", () => {
    const cases: [string, string][] = [
      ["tok-raw\n", "tok-raw"],
      ["# the Jev token\n\ntok-comment\n", "tok-comment"],
      ['TYPESAFE_API_KEY="tok-quoted"\n', "tok-quoted"],
      ["  tok-space  \r\n", "tok-space"],
    ];
    for (const [text, want] of cases) {
      const { j, fs } = harness();
      fs.text = text;
      j.refresh();
      expect(j.token()).toBe(want);
      expect(j.snapshot().keySource).toBe("file");
    }
  });

  it("treats an empty or comment-only file as no token", () => {
    const { j, fs } = harness();
    fs.text = "# nothing yet\n\n";
    j.refresh();
    expect(j.snapshot().state).toBe("dormant");
  });

  it("prefers env over the key file", () => {
    const { j, fs, env } = harness();
    fs.text = "tok-file";
    fs.mtime += 1;
    j.refresh();
    expect(j.snapshot().keySource).toBe("file");
    env.TYPESAFE_API_KEY = "tok-env";
    j.refresh();
    expect(j.snapshot().keySource).toBe("env");
    expect(j.token()).toBe("tok-env");
  });

  it("never puts the token in the snapshot", () => {
    const { j, env } = harness();
    env.TYPESAFE_API_KEY = "tok-secret-123";
    j.refresh();
    expect(JSON.stringify(j.snapshot())).not.toContain("tok-secret-123");
  });
});

describe("jev availability: arming without a restart", () => {
  it("arms itself when the key file appears, with one log line and one change event", () => {
    const { j, fs, info } = harness();
    const events: string[] = [];
    j.onChange((s) => events.push(s.state));
    j.refresh();
    expect(events).toEqual([]); // nothing changed yet
    fs.text = "tok-late\n";
    fs.mtime = 5;
    j.refresh();
    expect(events).toEqual(["unverified"]);
    expect(j.token()).toBe("tok-late");
    j.refresh(); // same file, same mtime: nothing new
    expect(events).toEqual(["unverified"]);
    expect(info.mock.calls.filter((c) => /token found/i.test(String(c[0])))).toHaveLength(1);
  });

  it("does not reread an unchanged file", () => {
    const readFile = vi.fn(() => "tok\n");
    const { j } = harness({ readFile, statFile: () => 7 });
    j.refresh();
    j.refresh();
    j.refresh();
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("a first successful answer arms it (one log line, one event); later answers are silent", () => {
    const { j, env, info } = harness();
    env.TYPESAFE_API_KEY = "tok";
    j.refresh();
    const events: string[] = [];
    j.onChange((s) => events.push(s.state));
    j.report({ ok: true });
    j.report({ ok: true });
    expect(j.snapshot().state).toBe("armed");
    expect(j.snapshot().line).toBe("Jev: on");
    expect(events).toEqual(["armed"]);
    expect(info.mock.calls.filter((c) => /armed/i.test(String(c[0])))).toHaveLength(1);
  });

  it("a rejected token (401/403) turns it off until the token changes", () => {
    const { j, fs, tick } = harness();
    fs.text = "tok-bad\n";
    j.refresh();
    j.report({ ok: false, status: 401 });
    let s = j.snapshot();
    expect(s.state).toBe("rejected");
    expect(s.on).toBe(false);
    expect(s.line).toBe("Jev: off — the token was rejected by Jev");
    tick(60_000);
    j.refresh(); // same token: stays rejected
    expect(j.snapshot().state).toBe("rejected");
    fs.text = "tok-good\n";
    fs.mtime += 1;
    j.refresh();
    s = j.snapshot();
    expect(s.state).toBe("unverified");
    expect(s.on).toBe(true);
  });

  it("another failure (timeout, 500) leaves the state alone", () => {
    const { j, env } = harness();
    env.TYPESAFE_API_KEY = "tok";
    j.refresh();
    j.report({ ok: true });
    j.report({ ok: false, status: 500 });
    j.report({ ok: false });
    expect(j.snapshot().state).toBe("armed");
    expect(j.snapshot().lastProbe?.ok).toBe(false);
  });

  it("goes dormant again when the token is removed", () => {
    const { j, fs, info } = harness();
    fs.text = "tok\n";
    j.refresh();
    j.report({ ok: true });
    fs.text = undefined;
    j.refresh();
    expect(j.snapshot().state).toBe("dormant");
    expect(j.token()).toBeUndefined();
    expect(info.mock.calls.some((c) => /dormant/i.test(String(c[0])))).toBe(true);
  });

  it("tracks the breaker", () => {
    const { j, env } = harness();
    env.TYPESAFE_API_KEY = "tok";
    j.refresh();
    const seen: boolean[] = [];
    j.onChange((s) => seen.push(s.breakerOpen));
    j.noteBreaker("amygdala", true);
    j.noteBreaker("thalamus", true);
    j.noteBreaker("amygdala", false);
    expect(j.snapshot().breakerOpen).toBe(true); // thalamus still open
    j.noteBreaker("thalamus", false);
    expect(j.snapshot().breakerOpen).toBe(false);
    expect(seen).toEqual([true, false]);
  });
});

describe("jev availability: the start line and the probe", () => {
  it("says once, at start, what is dormant and why", () => {
    const { j, info } = harness({ tokenHelpUrl: () => undefined });
    j.announce("amygdala");
    j.announce("thalamus");
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/dormant/);
    expect(lines[0]).toMatch(/no token/);
    expect(lines[0]).toMatch(/safety checks/);
    expect(lines[0]).toMatch(/\/state\/jev\/token/);
    expect(lines[0]).toMatch(/TYPESAFE_API_KEY/);
  });

  it("includes the owner's token pointer only when one is configured", () => {
    const a = harness({ tokenHelpUrl: () => "https://example.test/get-token" });
    a.j.announce("x");
    expect(String(a.info.mock.calls[0][0])).toContain("https://example.test/get-token");
    const b = harness({ tokenHelpUrl: () => undefined });
    b.j.announce("x");
    expect(String(b.info.mock.calls[0][0])).not.toContain("http");
  });

  it("runs the registered probe when a token appears, at most once per cooldown", async () => {
    const probe = vi.fn(async () => undefined);
    const { j, fs, tick } = harness();
    j.setProbe(probe);
    j.refresh();
    expect(probe).not.toHaveBeenCalled(); // dormant: nothing to probe
    fs.text = "tok\n";
    fs.mtime = 9;
    j.refresh();
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(1);
    tick(60_000);
    j.refresh();
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(1); // inside the cooldown
    tick(5 * 60_000);
    j.refresh();
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(2); // still unverified after the cooldown: try again
  });

  it("keeps one probe per owner: a second plugin does not replace the first, and removing one leaves the other", async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const { j, env } = harness();
    j.setProbe(first, "amygdala");
    j.setProbe(second, "thalamus");
    env.TYPESAFE_API_KEY = "tok";
    j.refresh();
    await Promise.resolve();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    j.setProbe(undefined, "amygdala");
    env.TYPESAFE_API_KEY = "tok-2"; // a changed token starts unverified again
    j.refresh();
    await Promise.resolve();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not probe once armed, and a throwing probe never escapes", async () => {
    const probe = vi.fn(async () => {
      throw new Error("boom");
    });
    const { j, env } = harness();
    j.setProbe(probe);
    env.TYPESAFE_API_KEY = "tok";
    expect(() => j.refresh()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    j.report({ ok: true });
    const calls = probe.mock.calls.length;
    j.refresh();
    expect(probe.mock.calls.length).toBe(calls);
  });
});
