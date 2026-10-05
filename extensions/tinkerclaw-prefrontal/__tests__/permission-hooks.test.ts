import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDenialTracker } from "../denial-tracking.js";
import { createPermissionHooks, type HookDef } from "../permission-hooks.js";

// Hooks now execute FILES inside an allowed root, never shell strings, so the
// fixtures are real executables in a temp dir that stands in as the root.
let root: string;
const silent = { warn: () => {} };

function writeHook(name: string, body: string, mode = 0o700): string {
  const p = path.join(root, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode });
  fs.chmodSync(p, mode);
  return p;
}

function hooks(defs: HookDef[], opts: { enabled?: boolean; allowedRoots?: string[] } = {}) {
  return createPermissionHooks(defs, {
    enabled: opts.enabled ?? true,
    allowedRoots: opts.allowedRoots ?? [root],
    logger: silent,
  });
}

let approveScript: string;
let denyScript: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "prefrontal-hooks-"));
  approveScript = writeHook("approve.sh", `echo '{"decision":"approve"}'`);
  denyScript = writeHook("deny.sh", `echo '{"decision":"deny","feedback":"too dangerous"}'`);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("PermissionHooks", () => {
  it("approves when no hooks match", async () => {
    const h = hooks([{ tool: "Bash", script: denyScript, timeout: 5000 }]);
    expect((await h.check("Edit", {})).decision).toBe("approve");
  });

  it("runs matching hook", async () => {
    const h = hooks([{ tool: "Bash", script: approveScript, timeout: 5000 }]);
    expect((await h.check("Bash", {})).decision).toBe("approve");
  });

  it("returns deny from hook", async () => {
    const h = hooks([{ tool: "Bash", script: denyScript, timeout: 5000 }]);
    const r = await h.check("Bash", {});
    expect(r.decision).toBe("deny");
    expect(r.feedback).toBe("too dangerous");
  });

  it("wildcard matches all tools", async () => {
    const h = hooks([{ tool: "*", script: approveScript, timeout: 5000 }]);
    expect((await h.check("Edit", {})).decision).toBe("approve");
  });

  it("passes the tool name and context to the hook on stdin", async () => {
    // Denies only when it can actually read the payload it was handed.
    const echoScript = writeHook(
      "reads-stdin.sh",
      `payload=$(cat); case "$payload" in *'"tool":"Bash"'*) echo '{"decision":"deny","feedback":"saw it"}';; *) echo '{"decision":"approve"}';; esac`,
    );
    const h = hooks([{ tool: "Bash", script: echoScript, timeout: 5000 }]);
    const r = await h.check("Bash", { sessionKey: "agent:main:main" });
    expect(r.decision).toBe("deny");
    expect(r.feedback).toBe("saw it");
  });

  // ── Opt-in ──
  it("does NOT execute hooks unless explicitly enabled", async () => {
    const marker = path.join(root, "ran.marker");
    fs.rmSync(marker, { force: true });
    const sideEffect = writeHook("side-effect.sh", `touch ${marker}; echo '{"decision":"deny"}'`);
    const h = hooks([{ tool: "Bash", script: sideEffect, timeout: 5000 }], { enabled: false });
    expect((await h.check("Bash", {})).decision).toBe("approve");
    expect(fs.existsSync(marker)).toBe(false);
  });

  // ── Fail closed ──
  it("DENIES on timeout (fail-closed)", async () => {
    const slow = writeHook("slow.sh", "sleep 10");
    const h = hooks([{ tool: "Bash", script: slow, timeout: 100 }]);
    const r = await h.check("Bash", {});
    expect(r.decision).toBe("deny");
    expect(r.feedback).toContain("fail-closed");
  });

  it("DENIES when the hook exits non-zero", async () => {
    const boom = writeHook("boom.sh", "exit 3");
    const h = hooks([{ tool: "Bash", script: boom, timeout: 5000 }]);
    expect((await h.check("Bash", {})).decision).toBe("deny");
  });

  it("DENIES when the hook emits invalid JSON", async () => {
    const junk = writeHook("junk.sh", "echo not-json");
    const h = hooks([{ tool: "Bash", script: junk, timeout: 5000 }]);
    const r = await h.check("Bash", {});
    expect(r.decision).toBe("deny");
    expect(r.feedback).toContain("valid JSON");
  });

  // ── No shell ──
  it("refuses a shell command string instead of running it", async () => {
    const marker = path.join(root, "injected.marker");
    fs.rmSync(marker, { force: true });
    const h = hooks([{ tool: "Bash", script: `touch ${marker}`, timeout: 5000 }]);
    const r = await h.check("Bash", {});
    expect(r.decision).toBe("deny");
    expect(r.feedback).toContain("absolute path");
    expect(fs.existsSync(marker)).toBe(false);
  });

  // ── Path allowlist ──
  it("refuses a script outside the allowed roots", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "prefrontal-outside-"));
    const p = path.join(outside, "evil.sh");
    fs.writeFileSync(p, `#!/bin/sh\necho '{"decision":"approve"}'\n`, { mode: 0o700 });
    const h = hooks([{ tool: "Bash", script: p, timeout: 5000 }]);
    const r = await h.check("Bash", {});
    expect(r.decision).toBe("deny");
    expect(r.feedback).toContain("outside the allowed roots");
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a symlink that escapes an allowed root", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "prefrontal-escape-"));
    const target = path.join(outside, "real.sh");
    fs.writeFileSync(target, `#!/bin/sh\necho '{"decision":"approve"}'\n`, { mode: 0o700 });
    const link = path.join(root, "looks-legit.sh");
    fs.symlinkSync(target, link);
    const h = hooks([{ tool: "Bash", script: link, timeout: 5000 }]);
    expect((await h.check("Bash", {})).decision).toBe("deny");
    fs.rmSync(link, { force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a world-writable hook script", async () => {
    const loose = writeHook("loose.sh", `echo '{"decision":"approve"}'`, 0o777);
    const h = hooks([{ tool: "Bash", script: loose, timeout: 5000 }]);
    const r = await h.check("Bash", {});
    expect(r.decision).toBe("deny");
    expect(r.feedback).toContain("writable");
  });

  it("refuses a missing hook script", async () => {
    const h = hooks([{ tool: "Bash", script: path.join(root, "nope.sh"), timeout: 5000 }]);
    expect((await h.check("Bash", {})).decision).toBe("deny");
  });

  // ── Least privilege env ──
  it("does not leak the gateway environment to the hook", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "super-secret-token";
    const probe = writeHook(
      "env-probe.sh",
      `if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then echo '{"decision":"deny","feedback":"leaked"}'; else echo '{"decision":"approve"}'; fi`,
    );
    const h = hooks([{ tool: "Bash", script: probe, timeout: 5000 }]);
    const r = await h.check("Bash", {});
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    expect(r.feedback).not.toBe("leaked");
    expect(r.decision).toBe("approve");
  });
});

describe("DenialTracker", () => {
  it("tracks consecutive denials", () => {
    const t = createDenialTracker({ limit: 3 });
    t.recordDenial("Bash");
    t.recordDenial("Bash");
    expect(t.shouldEscalate("Bash")).toBe(false);
    t.recordDenial("Bash");
    expect(t.shouldEscalate("Bash")).toBe(true);
  });

  it("resets on approval", () => {
    const t = createDenialTracker({ limit: 3 });
    t.recordDenial("Bash");
    t.recordDenial("Bash");
    t.recordApproval("Bash");
    expect(t.shouldEscalate("Bash")).toBe(false);
    expect(t.getCount("Bash")).toBe(0);
  });

  it("tracks tools independently", () => {
    const t = createDenialTracker({ limit: 2 });
    t.recordDenial("Bash");
    t.recordDenial("Edit");
    expect(t.shouldEscalate("Bash")).toBe(false);
    expect(t.shouldEscalate("Edit")).toBe(false);
  });

  it("produces escalation message", () => {
    const t = createDenialTracker({ limit: 1 });
    t.recordDenial("Bash");
    const msg = t.getEscalationMessage("Bash");
    expect(msg).toContain("denied");
    expect(msg).toContain("ask the user");
  });

  it("getCount returns 0 for unknown tool", () => {
    const t = createDenialTracker({ limit: 3 });
    expect(t.getCount("Unknown")).toBe(0);
  });
});
