import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  isRetryOwnableSessionKey,
  resolveRetryKey,
  retryLifecycleAction,
  type RetryLifecycleDeps,
} from "./retry-lifecycle";

// Stand-in for app.ts `sessionKeyMatches` (short "tinker:A" vs canonical
// "agent:main:tinker:A"): exact match, or one key is a suffix of the other.
const keyMatches = (a: string, b: string): boolean =>
  !!a && !!b && (a === b || a.endsWith(":" + b) || b.endsWith(":" + a));

/** Two tabs open, VIEWING tab A. Tab B is the backgrounded one. */
const viewingA = (): RetryLifecycleDeps => ({
  viewedKey: "tinker:A",
  tabKeys: ["tinker:A", "tinker:B"],
  keyMatches,
});

const rateLimited = (sessionKey: string, extra: Record<string, unknown> = {}) => ({
  sessionKey,
  state: "error",
  reason: "rate_limit",
  errorMessage: "429 rate limit exceeded",
  ...extra,
});

describe("resolveRetryKey — the event's session, not the tab on screen", () => {
  it("resolves the viewed session to the viewed key", () => {
    expect(resolveRetryKey("tinker:A", viewingA())).toBe("tinker:A");
  });

  it("resolves the CANONICAL form of the viewed key to the local short key", () => {
    // retryState is a plain Map compared by ===, while keys arrive in both forms. If the
    // canonical form were used as the map key, send()/abort()//clear — which all cancel by
    // the tab's local key — would miss it and the retry would survive its own cancel.
    expect(resolveRetryKey("agent:main:tinker:A", viewingA())).toBe("tinker:A");
  });

  it("REGRESSION (bug B): a backgrounded tab's session resolves to ITS OWN key", () => {
    // The pre-fix code keyed every retry off the global viewed `sessionKey`, so an event
    // for tab B advanced (or clobbered) tab A's track.
    expect(resolveRetryKey("tinker:B", viewingA())).toBe("tinker:B");
    expect(resolveRetryKey("agent:main:tinker:B", viewingA())).toBe("tinker:B");
  });

  it("returns null for a session no tab hosts (cron / WhatsApp / another client)", () => {
    expect(resolveRetryKey("cron:nightly", viewingA())).toBeNull();
  });

  it("returns null when nothing is open at all", () => {
    expect(resolveRetryKey("tinker:A", { viewedKey: "", tabKeys: [], keyMatches })).toBeNull();
  });

  it("skips unattached (null sessionKey) tabs instead of throwing", () => {
    const deps: RetryLifecycleDeps = { viewedKey: "", tabKeys: [null, "tinker:B"], keyMatches };
    expect(resolveRetryKey("tinker:B", deps)).toBe("tinker:B");
  });
});

describe("isRetryOwnableSessionKey", () => {
  it("accepts ordinary tab sessions", () => {
    expect(isRetryOwnableSessionKey("tinker:A")).toBe(true);
    expect(isRetryOwnableSessionKey("agent:main:main")).toBe(true);
  });

  it("refuses subagent / ACP children (driven by their parent turn, never own a tab)", () => {
    expect(isRetryOwnableSessionKey("agent:main:subagent:9f2")).toBe(false);
    expect(isRetryOwnableSessionKey("agent:main:acp:claude")).toBe(false);
  });

  it("refuses an empty key", () => {
    expect(isRetryOwnableSessionKey("")).toBe(false);
  });
});

describe("retryLifecycleAction — a recoverable error schedules THAT session's ladder", () => {
  it("schedules for the viewed session", () => {
    expect(retryLifecycleAction(rateLimited("tinker:A"), viewingA())).toEqual({
      kind: "schedule",
      sessionKey: "tinker:A",
      retryKind: "rate_limit",
      retryAfterSec: undefined,
    });
  });

  it("REGRESSION (bug B): schedules for a BACKGROUNDED session under its own key", () => {
    // Pre-fix this call site sat below onEvent's non-viewed-session early return, so the
    // ladder simply died after one attempt once the user switched tabs.
    expect(retryLifecycleAction(rateLimited("agent:main:tinker:B"), viewingA())).toEqual({
      kind: "schedule",
      sessionKey: "tinker:B",
      retryKind: "rate_limit",
      retryAfterSec: undefined,
    });
  });

  it("carries a provider Retry-After through", () => {
    const action = retryLifecycleAction(rateLimited("tinker:B", { retryAfter: 45 }), viewingA());
    expect(action).toMatchObject({ kind: "schedule", sessionKey: "tinker:B", retryAfterSec: 45 });
  });

  it("ignores a non-numeric Retry-After rather than passing junk to the ladder", () => {
    const action = retryLifecycleAction(rateLimited("tinker:B", { retryAfter: "45" }), viewingA());
    expect(action).toMatchObject({ kind: "schedule", retryAfterSec: undefined });
  });

  it("classifies from the error TEXT when no structured reason is present", () => {
    expect(
      retryLifecycleAction(
        { sessionKey: "tinker:A", state: "error", errorMessage: "model is overloaded" },
        viewingA(),
      ),
    ).toMatchObject({ kind: "schedule", retryKind: "overloaded" });
  });

  it("does NOT retry an unrecoverable error (that keeps the red dead-end bubble)", () => {
    expect(
      retryLifecycleAction(
        { sessionKey: "tinker:A", state: "error", errorMessage: "invalid API key" },
        viewingA(),
      ),
    ).toEqual({ kind: "none" });
  });

  it("does NOT retry an error with no message to classify", () => {
    expect(retryLifecycleAction({ sessionKey: "tinker:A", state: "error" }, viewingA())).toEqual({
      kind: "none",
    });
  });

  it("does NOT retry a subagent's rate limit", () => {
    expect(retryLifecycleAction(rateLimited("agent:main:subagent:9f2"), viewingA())).toEqual({
      kind: "none",
    });
  });

  it("does NOT retry a session no tab hosts", () => {
    expect(retryLifecycleAction(rateLimited("cron:nightly"), viewingA())).toEqual({ kind: "none" });
  });
});

// FORK 2026-08-24 — the 529 that arrived dressed as a successful turn.
describe("a `final` whose body IS the error", () => {
  // Verbatim from the 2026-08-24 incident: the gateway sent state:"final" with this as the
  // entire assistant message, so the lifecycle read a SUCCESS and cancelled the ladder.
  const INCIDENT_529 =
    "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.";

  it("REGRESSION: schedules a retry instead of cancelling", () => {
    expect(
      retryLifecycleAction(
        { sessionKey: "tinker:A", state: "final", finalText: INCIDENT_529 },
        viewingA(),
      ),
    ).toMatchObject({ kind: "schedule", sessionKey: "tinker:A", retryKind: "overloaded" });
  });

  it("advances a BACKGROUNDED tab's ladder on its own key", () => {
    expect(
      retryLifecycleAction(
        { sessionKey: "agent:main:tinker:B", state: "final", finalText: INCIDENT_529 },
        viewingA(),
      ),
    ).toMatchObject({ kind: "schedule", sessionKey: "tinker:B" });
  });

  it("honours a provider Retry-After riding on the final", () => {
    expect(
      retryLifecycleAction(
        { sessionKey: "tinker:A", state: "final", finalText: INCIDENT_529, retryAfter: 30 },
        viewingA(),
      ),
    ).toMatchObject({ kind: "schedule", retryAfterSec: 30 });
  });

  it("still CANCELS on a genuine answer — the ladder must end when the turn works", () => {
    expect(
      retryLifecycleAction(
        { sessionKey: "tinker:A", state: "final", finalText: "Here is the summary you asked for." },
        viewingA(),
      ),
    ).toEqual({ kind: "cancel", sessionKey: "tinker:A" });
  });

  it("still CANCELS when no text rode along (unchanged legacy behaviour)", () => {
    expect(retryLifecycleAction({ sessionKey: "tinker:A", state: "final" }, viewingA())).toEqual({
      kind: "cancel",
      sessionKey: "tinker:A",
    });
  });

  it("CANCELS on an UNrecoverable failure — red dead-end, no ladder", () => {
    expect(
      retryLifecycleAction(
        { sessionKey: "tinker:A", state: "final", finalText: "All models failed after 3 attempts" },
        viewingA(),
      ),
    ).toEqual({ kind: "cancel", sessionKey: "tinker:A" });
  });

  it("does NOT arm a retry from a long answer that merely QUOTES a 529", () => {
    // The guard that stops an answer about the bug from re-sending the user's prompt.
    const essay = `Yesterday the gateway returned "API Error: 529 Overloaded" and ${"x".repeat(500)}`;
    expect(
      retryLifecycleAction(
        { sessionKey: "tinker:A", state: "final", finalText: essay },
        viewingA(),
      ),
    ).toEqual({ kind: "cancel", sessionKey: "tinker:A" });
  });
});

describe("retryLifecycleAction — a successful turn cancels THAT session's ladder", () => {
  it("REGRESSION (bug B): a final for a BACKGROUNDED session cancels its own track", () => {
    // This is the immortal-countdown half of the bug: pre-fix the `final` never reached the
    // clear (viewed-gate) and, when it did, cleared the VIEWED key. The orange
    // "retry N/6, retrying in 7m…" bubble stayed in localStorage and loadChat() re-injected
    // it into that transcript on every later open — for a turn that had already succeeded.
    expect(retryLifecycleAction({ sessionKey: "tinker:B", state: "final" }, viewingA())).toEqual({
      kind: "cancel",
      sessionKey: "tinker:B",
    });
  });

  it("cancels for the viewed session too, via the same rule", () => {
    expect(
      retryLifecycleAction({ sessionKey: "agent:main:tinker:A", state: "final" }, viewingA()),
    ).toEqual({ kind: "cancel", sessionKey: "tinker:A" });
  });

  it("leaves `aborted` alone — the manual stop paths already cancel", () => {
    expect(retryLifecycleAction({ sessionKey: "tinker:B", state: "aborted" }, viewingA())).toEqual({
      kind: "none",
    });
  });

  it("ignores streaming deltas", () => {
    expect(retryLifecycleAction({ sessionKey: "tinker:B", state: "delta" }, viewingA())).toEqual({
      kind: "none",
    });
  });

  it("survives a malformed / absent payload", () => {
    expect(retryLifecycleAction(undefined, viewingA())).toEqual({ kind: "none" });
    expect(retryLifecycleAction({}, viewingA())).toEqual({ kind: "none" });
    expect(retryLifecycleAction({ sessionKey: 42, state: "final" }, viewingA())).toEqual({
      kind: "none",
    });
  });
});

// ─── Bug A: /clear must cancel a pending auto-retry ────────────────────────────────────
// This one is a CALL-ORDERING defect inside app.ts's send(), not a pure rule, so it is
// locked structurally: the `/clear` branch returns early (it never reaches the
// `retryState.delete(sessionKey)` the normal send path runs), and the 1 Hz tick iterates
// `retryState` rather than the DOM — so an uncancelled track kept counting down in a wiped
// tab and re-sent the OLD user turn up to 15 minutes later (the ladder tops out at 900s),
// with no keystroke from the user. Deleting the cancel would restore exactly that.
describe("app.ts /clear branch (bug A)", () => {
  // Walk up from the vitest cwd rather than `import.meta.url`: under this jsdom project the
  // module URL is an http:// one (vite transform), so fileURLToPath() throws "URL must be of
  // scheme file" and the whole suite fails to collect.
  const findAppSource = (): string => {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, "tinker-ui", "src", "app.ts");
      if (existsSync(candidate)) {
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    throw new Error(`could not locate tinker-ui/src/app.ts from ${process.cwd()}`);
  };
  const appSrc = readFileSync(findAppSource(), "utf8");

  /** The body of `if (text.trim() === "/clear") { … return; }` in send(). */
  const clearBranch = (): string => {
    const start = appSrc.indexOf('if (text.trim() === "/clear") {');
    expect(start, "the /clear branch in send() moved or was renamed").toBeGreaterThan(-1);
    const end = appSrc.indexOf("\n    return;", start);
    expect(end, "the /clear branch no longer returns early").toBeGreaterThan(start);
    return appSrc.slice(start, end);
  };

  it("REGRESSION: cancels the archived session's pending auto-retry before returning", () => {
    expect(clearBranch()).toMatch(/cancelRetry\(\s*oldSessionKey\s*,/);
  });

  it("REGRESSION: drops the archived session's persisted retry bubbles", () => {
    // tab-main keeps its sessionKey across /clear, so without this a reload would repaint
    // the "cleared" chat with a live-looking countdown for a retry that no longer exists.
    expect(clearBranch()).toMatch(/clearPersistedErrors\(\s*oldSessionKey\s*\)/);
  });
});
