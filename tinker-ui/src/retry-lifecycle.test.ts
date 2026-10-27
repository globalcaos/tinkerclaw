import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  envelopeVerdictOf,
  isRetryOwnableSessionKey,
  pageSentPromptKey,
  resolveRetryKey,
  retryLifecycleAction,
  retryPromptForRun,
  retryTrackStep,
  type RetryLifecycleDeps,
} from "./retry-lifecycle";
import { nextRetryDelayMs, RETRY_LADDER_MS } from "./retry-policy";

// Stand-in for app.ts `sessionKeyMatches` (short "tinker:A" vs canonical
// "agent:main:tinker:A"): exact match, or one key is a suffix of the other.
const keyMatches = (a: string, b: string): boolean =>
  !!a && !!b && (a === b || a.endsWith(":" + b) || b.endsWith(":" + a));

/**
 * Two tabs open, VIEWING tab A. Tab B is the backgrounded one.
 *
 * FORK 2026-10-01 — `isOwnRun` is a REQUIRED dep: the ladder only moves for a run THIS page sent.
 * `own` lists the run ids this page owns, and the default is NONE on purpose — it is the strictest
 * possible predicate, so every test built on `viewingA()` proves that an event carrying no `runId`
 * is decided exactly as it was before the gate existed.
 */
const viewingA = (own: readonly string[] = []): RetryLifecycleDeps => ({
  viewedKey: "tinker:A",
  tabKeys: ["tinker:A", "tinker:B"],
  keyMatches,
  isOwnRun: (runId) => own.includes(runId),
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
    const deps = { viewedKey: "", tabKeys: [null, "tinker:B"], keyMatches };
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

// ─── U9: a typed outcome on the final outranks the state word ───────────────────────────
// Plan 2026-09-29-chat-usage-chips-and-typed-outcomes.md, review focus 3. Measured: the backstop
// `final` the gateway sends after a surfaced error CANCELLED the ladder the error had just armed,
// so a rate-limited turn retried zero times. The typed field makes that judgement structural.
describe("U9 — a `final` that carries a TurnOutcome is not a success", () => {
  const outcome = (over: Record<string, unknown> = {}) => ({
    kind: "rate_limit",
    recoverable: true,
    headline: "Rate limited",
    source: "stop-reason",
    ...over,
  });

  it("keeps the ladder alive on a recoverable outcome — and only arms it if idle", () => {
    expect(
      retryLifecycleAction(
        { sessionKey: "tinker:B", state: "final", finalOutcome: outcome() },
        viewingA(),
      ),
    ).toEqual({
      kind: "schedule",
      sessionKey: "tinker:B",
      retryKind: "rate_limit",
      onlyIfIdle: true,
    });
  });

  it("maps every recoverable kind onto the ladder's own RetryKind", () => {
    const kindOf = (kind: string) =>
      retryLifecycleAction(
        { sessionKey: "tinker:A", state: "final", finalOutcome: outcome({ kind }) },
        viewingA(),
      );
    expect(kindOf("quota")).toMatchObject({ retryKind: "quota" });
    expect(kindOf("overload")).toMatchObject({ retryKind: "overloaded" });
    expect(kindOf("network")).toMatchObject({ retryKind: "unavailable" });
    expect(kindOf("timeout")).toMatchObject({ retryKind: "unavailable" });
  });

  it("prefers the outcome's own retryAfter, falling back to the event's", () => {
    expect(
      retryLifecycleAction(
        {
          sessionKey: "tinker:A",
          state: "final",
          retryAfter: 30,
          finalOutcome: outcome({ retryAfter: 262 * 60 }),
        },
        viewingA(),
      ),
    ).toMatchObject({ retryAfterSec: 262 * 60 });
    expect(
      retryLifecycleAction(
        { sessionKey: "tinker:A", state: "final", retryAfter: 30, finalOutcome: outcome() },
        viewingA(),
      ),
    ).toMatchObject({ retryAfterSec: 30 });
  });

  it("a non-recoverable outcome STOPS its run's track, and never cancels it as a success", () => {
    // Cancelling would run the SUCCESS cleanup on a failure. FORK 2026-10-05: no retry can help a
    // run that failed this way, so the action is `stop`, and app.ts applies it only to a track whose
    // own prompt or last fire it names (retryTrackStep, tested below).
    for (const kind of [
      "auth",
      "billing",
      "refusal",
      "context_overflow",
      "aborted",
      "empty",
      "error",
    ]) {
      expect(
        retryLifecycleAction(
          {
            sessionKey: "tinker:A",
            state: "final",
            finalOutcome: outcome({ kind, recoverable: false }),
          },
          viewingA(),
        ),
        kind,
      ).toEqual({ kind: "stop", sessionKey: "tinker:A" });
    }
  });

  it("REGRESSION: a final with NO outcome still cancels — old transcripts unchanged", () => {
    expect(retryLifecycleAction({ sessionKey: "tinker:A", state: "final" }, viewingA())).toEqual({
      kind: "cancel",
      sessionKey: "tinker:A",
    });
    // a malformed outcome is not an outcome: fall through to the 2026-08-24 text rule
    expect(
      retryLifecycleAction(
        { sessionKey: "tinker:A", state: "final", finalOutcome: { kind: "melted" } },
        viewingA(),
      ),
    ).toEqual({ kind: "cancel", sessionKey: "tinker:A" });
  });

  it("REGRESSION: the 2026-08-24 finalText path still schedules, WITHOUT onlyIfIdle", () => {
    // That failure arrives only as a final (no `state:"error"` precedes it), so it must arm a fresh
    // ladder unconditionally — flagging it onlyIfIdle would put it back to zero retries.
    const action = retryLifecycleAction(
      { sessionKey: "tinker:A", state: "final", finalText: "API Error: 529 Overloaded" },
      viewingA(),
    );
    expect(action).toMatchObject({ kind: "schedule", retryKind: "overloaded" });
    expect((action as { onlyIfIdle?: boolean }).onlyIfIdle).toBeUndefined();
  });
});

// ─── Bug A: /clear must cancel a pending auto-retry ────────────────────────────────────
// This one is a CALL-ORDERING defect inside app.ts's send(), not a pure rule, so it is
// locked structurally: the `/clear` branch returns early (it never reaches the
// `retryState.delete(sessionKey)` the normal send path runs), and the 1 Hz tick iterates
// `retryState` rather than the DOM — so an uncancelled track kept counting down in a wiped
// tab and re-sent the OLD user turn up to 15 minutes later (the ladder tops out at 900s),
// with no keystroke from the user. Deleting the cancel would restore exactly that.
// Walk up from the vitest cwd rather than `import.meta.url`: under this jsdom project the
// module URL is an http:// one (vite transform), so fileURLToPath() throws "URL must be of
// scheme file" and the whole suite fails to collect.
// FORK 2026-10-01 — hoisted to module scope: the own-run WIRING gate at the bottom of this file
// reads the same source, and a second copy of this walker is the duplication that rots.
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

describe("app.ts /clear branch (bug A)", () => {
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

// ─── Bug [chat-divergence] cause 3: "retries nobody asked for" (2026-10-01) ─────────────
// MEASURED, not hypothesised: session agent:main:tinker:mugmkh6p, 2026-09-26 10:43–10:58 UTC.
// Three SUBAGENT announce runs (`announce:v1:agent:main:subagent:…`) hit an openai-codex
// `(rate_limit)` cooldown. Their chat events carried the OWNER's sessionKey, so
// `isRetryOwnableSessionKey` — which reads only the SESSION key — waved them through, and each
// failure armed the owner's ladder and re-sent a prompt answered 75 minutes earlier under a fresh
// key (bug-reports/2026-09-26/140450-*, 140451-*, 140454-*: three fires, all carrying
// `retryOf a6aec32b-cd48-44df-8bd3-37a7e5dd2e83`). The cooldown is the only reason it stopped at
// three repeated PROMPTS rather than three repeated runs of the whole task.
describe("retryLifecycleAction — only a run THIS page sent moves the ladder", () => {
  const OWNER = "agent:main:tinker:mugmkh6p";
  /** The shape of the announce runs' ids from the incident. */
  const FOREIGN_RUN = "announce:v1:agent:main:subagent:mugmkh6p:7f3a1c";
  /** The owner's prompt key — the `retryOf` all three bug reports carry. */
  const OWN_RUN = "a6aec32b-cd48-44df-8bd3-37a7e5dd2e83";

  const viewingOwner = (own: readonly string[] = [OWN_RUN]): RetryLifecycleDeps => ({
    viewedKey: OWNER,
    tabKeys: [OWNER],
    keyMatches,
    isOwnRun: (runId) => own.includes(runId),
  });

  /** The openai-codex cooldown that armed the ladder three times. */
  const codexCooldown = (extra: Record<string, unknown> = {}) => ({
    sessionKey: OWNER,
    state: "error",
    errorMessage: "openai-codex (rate_limit): usage limit reached, resets in 262 minutes",
    ...extra,
  });

  it("REGRESSION: a foreign run's cooldown neither schedules nor cancels", () => {
    expect(retryLifecycleAction(codexCooldown({ runId: FOREIGN_RUN }), viewingOwner())).toEqual({
      kind: "none",
    });
  });

  it("the SAME failure on a run this page sent still schedules", () => {
    expect(retryLifecycleAction(codexCooldown({ runId: OWN_RUN }), viewingOwner())).toEqual({
      kind: "schedule",
      sessionKey: OWNER,
      retryKind: "rate_limit",
      retryAfterSec: undefined,
      runId: OWN_RUN,
    });
  });

  it("an event with NO runId is decided exactly as before the gate existed", () => {
    // Note `own: []` — the predicate would refuse everything it was asked about. Pre-fix
    // transcripts and any event the gateway sends without a runId must not go dark.
    expect(retryLifecycleAction(codexCooldown(), viewingOwner([]))).toEqual({
      kind: "schedule",
      sessionKey: OWNER,
      retryKind: "rate_limit",
      retryAfterSec: undefined,
    });
  });

  it("a non-string runId is no runId", () => {
    expect(retryLifecycleAction(codexCooldown({ runId: 42 }), viewingOwner([]))).toMatchObject({
      kind: "schedule",
      sessionKey: OWNER,
    });
  });

  it("a foreign run's `final` does NOT cancel the owner's ladder", () => {
    // The mirror-image defect: a foreign run's success says nothing about the owner's prompt, and
    // the cancel retires the countdown of a failure that is still standing.
    expect(
      retryLifecycleAction(
        { sessionKey: OWNER, state: "final", runId: FOREIGN_RUN },
        viewingOwner(),
      ),
    ).toEqual({ kind: "none" });
    expect(
      retryLifecycleAction({ sessionKey: OWNER, state: "final", runId: OWN_RUN }, viewingOwner()),
    ).toEqual({ kind: "cancel", sessionKey: OWNER });
  });

  it("a foreign run's TYPED recoverable outcome does not arm the ladder either", () => {
    // The U9 path reaches `schedule` from a `final`, so the gate has to sit ABOVE all three
    // branches, not just the `state:"error"` one.
    expect(
      retryLifecycleAction(
        {
          sessionKey: OWNER,
          state: "final",
          runId: FOREIGN_RUN,
          finalOutcome: {
            kind: "rate_limit",
            recoverable: true,
            headline: "Rate limited",
            source: "stop-reason",
          },
        },
        viewingOwner(),
      ),
    ).toEqual({ kind: "none" });
  });

  it("a foreign run's `final` whose BODY is a 529 does not arm it either", () => {
    expect(
      retryLifecycleAction(
        {
          sessionKey: OWNER,
          state: "final",
          runId: FOREIGN_RUN,
          finalText: "API Error: 529 Overloaded",
        },
        viewingOwner(),
      ),
    ).toEqual({ kind: "none" });
  });

  it("carries the failed run's id out on the action, so a fire can find its prompt", () => {
    const action = retryLifecycleAction(codexCooldown({ runId: OWN_RUN }), viewingOwner());
    expect((action as { runId?: string }).runId).toBe(OWN_RUN);
  });
});

// ─── WHICH prompt a fire re-sends ───────────────────────────────────────────────────────
// The second half of the same incident, and the half that survives the gate above:
// `lastUserTurnFor` picks the last user bubble ON SCREEN, which in that session was a prompt
// answered 75 minutes earlier. A run's id IS its prompt's key (chat.send: `const clientRunId =
// p.idempotencyKey`), so the prompt the failed run was carrying is addressable.
describe("retryPromptForRun — the prompt the FAILED run was carrying", () => {
  const P = "a6aec32b-cd48-44df-8bd3-37a7e5dd2e83";
  const K1 = "abd81ba2-c1b0-4f16-8bec-a5716f6be4df";
  const TEXT = "improve the online test platform";
  const bubble = (over: Record<string, unknown>) => ({
    role: "user",
    content: [{ type: "text", text: TEXT }],
    ...over,
  });

  it("maps a run id to its own prompt", () => {
    expect(retryPromptForRun(P, [[bubble({ _clientMsgId: P })]])).toEqual({ text: TEXT, key: P });
  });

  it("a failed FIRE re-sends the prompt the owner typed: K1 with retryOf P → P", () => {
    const page = [
      bubble({ _clientMsgId: P }),
      bubble({ _clientMsgId: K1, _retryOf: P, content: [{ type: "text", text: "stale copy" }] }),
    ];
    // Text from P, and key P so the NEXT fire links to the original too — never to the fire,
    // which is what would chain the ladder onto its own output.
    expect(retryPromptForRun(K1, [page])).toEqual({ text: TEXT, key: P });
  });

  it("still names P when the original row is no longer on the page", () => {
    expect(retryPromptForRun(K1, [[bubble({ _clientMsgId: K1, _retryOf: P })]])).toEqual({
      text: TEXT,
      key: P,
    });
  });

  it("reads a server transcript row by its served idempotencyKey", () => {
    expect(
      retryPromptForRun(P, [[{ role: "user", content: "typed by hand", idempotencyKey: P }]]),
    ).toEqual({ text: "typed by hand", key: P });
  });

  it("searches every page handed in (queued sends, the outbox, a background tab)", () => {
    expect(retryPromptForRun(P, [[], [bubble({ _clientMsgId: P })]])).toMatchObject({ key: P });
  });

  it("returns null for a run no page holds, and for a junk id", () => {
    expect(retryPromptForRun(P, [[bubble({ _clientMsgId: K1 })]])).toBeNull();
    expect(retryPromptForRun(undefined, [[bubble({ _clientMsgId: P })]])).toBeNull();
    expect(retryPromptForRun("", [[bubble({ _clientMsgId: P })]])).toBeNull();
  });

  it("ignores assistant rows and in-flight temporaries", () => {
    expect(
      retryPromptForRun(P, [[{ role: "assistant", content: "answer", _clientMsgId: P }]]),
    ).toBeNull();
    expect(retryPromptForRun(P, [[bubble({ _clientMsgId: P, _temporary: true })]])).toBeNull();
  });

  it("survives a retryOf CYCLE instead of spinning", () => {
    const page = [
      bubble({ _clientMsgId: P, _retryOf: K1 }),
      bubble({ _clientMsgId: K1, _retryOf: P }),
    ];
    expect(retryPromptForRun(K1, [page])).toMatchObject({ text: TEXT });
  });

  it("pageSentPromptKey answers the own-run question off the same rows", () => {
    const page = [bubble({ _clientMsgId: P })];
    expect(pageSentPromptKey(P, [page])).toBe(true);
    expect(pageSentPromptKey("announce:v1:agent:main:subagent:x:y", [page])).toBe(false);
    expect(pageSentPromptKey(P, [])).toBe(false);
    expect(pageSentPromptKey(42, [page])).toBe(false);
  });

  it("a follow-up run gateway G3 linked to a prompt this page sent is own, by that link", () => {
    // followup-runner.ts mints a follow-up run (the one that answers a prompt the gateway put
    // BEHIND a running turn) under a fresh UUID, and names the prompt keys it answers on its
    // `followup` stream (app.ts `followupPromptLinks`). Its id is no prompt key, so without the
    // link every backlogged prompt's run would read as foreign: its rate limit would arm no
    // ladder, and its `final` could not end a ladder whose fire it carried.
    const FOLLOWUP = "0b9f2c4e-6f1a-4d3b-9a7e-2c5d8e1f4a6b";
    const page = [bubble({ _clientMsgId: P })];
    expect(pageSentPromptKey(FOLLOWUP, [page])).toBe(false); // CONTROL: the run id alone names none
    expect(pageSentPromptKey(FOLLOWUP, [page], [P])).toBe(true);
    expect(pageSentPromptKey(FOLLOWUP, [page], ["another-client", P])).toBe(true);
    // A link counts only through a key this page sent: anything else makes nothing own.
    expect(pageSentPromptKey(FOLLOWUP, [page], ["another-client", "", 42])).toBe(false);
    expect(pageSentPromptKey(undefined, [page], [P])).toBe(false);
  });
});

// ─── The own-run gate must actually be WIRED ────────────────────────────────────────────
// "An optional call to a missing method is silent." `isOwnRun` is REQUIRED in the type, so a deps
// object without it is a type error and, at runtime, a TypeError rather than a quiet "yes" — but a
// required field can still be answered with a stub that always says yes, which looks green and
// restores the bug. These lock the two live call sites structurally, the way the /clear branch
// above is locked. (Nothing type-checks tinker-ui in the build, so the type alone gates nothing.)
describe("app.ts own-run wiring", () => {
  /** The body of `function retryLifecycleDeps()`. */
  const depsFn = (): string => {
    const start = appSrc.indexOf("function retryLifecycleDeps(): RetryLifecycleDeps {");
    expect(start, "retryLifecycleDeps moved or was renamed").toBeGreaterThan(-1);
    const end = appSrc.indexOf("\n}", start);
    expect(end, "retryLifecycleDeps no longer closes").toBeGreaterThan(start);
    return appSrc.slice(start, end);
  };

  it("REGRESSION: hands the lifecycle the page's own-run predicate", () => {
    expect(depsFn()).toMatch(/isOwnRun:\s*isOwnRunId\b/);
  });

  it("REGRESSION: that predicate reads the page's prompt keys, not a constant", () => {
    // `isOwnRun: () => true` would type-check and silently re-open the hole.
    expect(appSrc).toMatch(/function isOwnRunId[\s\S]{0,240}?pageSentPromptKey\(/);
    expect(appSrc).toMatch(/function retryPromptPagesAll[\s\S]{0,600}?readOutbox\(outboxStore\)/);
  });

  it("REGRESSION: a follow-up run's G3 link counts, so a backlogged prompt keeps its ladder", () => {
    expect(appSrc).toMatch(/function isOwnRunId[\s\S]{0,240}?followupPromptLinks\.get\(runId\)/);
  });

  it("REGRESSION: a fire re-sends the FAILED run's prompt, not the newest bubble", () => {
    // Both halves must consult it: the schedule path (advanceRetryLifecycle) and the fire path
    // (retryLastTurn). `lastUserTextForSession` survives only as the named fallback.
    expect(appSrc.match(/retryPromptForRun\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("REGRESSION: a fire records its run, and every action goes through retryTrackStep", () => {
    // FORK 2026-10-05: without the fired run on the track, a fire's failure is indistinguishable
    // from a repeat signal, and the ladder either stalls or re-arms at attempt 0.
    expect(appSrc).toMatch(/function retryLastTurn[\s\S]*?st\.firedRunId = fired\.entry\.id;/);
    expect(appSrc).toMatch(/function advanceRetryLifecycle[\s\S]{0,2400}?retryTrackStep\(/);
  });
});

// ─── FORK 2026-10-05 — the ladder that never gave up (bug-log `[failure-as-value+retry-storm]`) ──
// One prompt was re-sent 169 times between 2026-10-03 22:08 and 10-04 00:30. Each fire's run failed
// with the Claude weekly limit and reached the page as TWO finals: the lifecycle final, whose whole
// body is the gateway's error envelope and which carries no typed outcome, and the backstop final,
// which does. The first read as a success and cancelled the track; the second armed a new one at
// attempt 0. The ladder never reached its last step.
describe("an error envelope in a final is never a success; a run moves the ladder once", () => {
  /** The envelope the gateway wrote for that run (muqqajso, 20:07:25 UTC), id and actions trimmed. */
  const weekly =
    '__ERR_ENV__:{"kind":"error","id":"err_mustpsc3","fatal":false,"category":"rate_limit",' +
    '"headline":"Rate limited","explanation":"You hit the Claude subscription\'s WEEKLY usage limit.' +
    ' This is your own usage and it clears at the next weekly reset.","icon":"🚦",' +
    '"raw":"You\'ve hit your weekly limit · resets Oct 8, 6pm (Europe/Madrid)"}';
  const burst =
    '__ERR_ENV__:{"kind":"error","id":"err_burst","fatal":false,"category":"rate_limit",' +
    '"headline":"Rate limited","raw":"429 Too Many Requests"}';
  const fatal =
    '__ERR_ENV__:{"kind":"error","id":"err_auth","fatal":true,"category":"auth",' +
    '"headline":"Sign in again","raw":"401 Unauthorized"}';
  const typed = {
    kind: "rate_limit",
    recoverable: true,
    headline: "Rate limited",
    source: "envelope",
  };

  it("reads the envelope: a burst can clear; a weekly window and a fatal error cannot", () => {
    expect(envelopeVerdictOf(burst)).toEqual({ recoverable: true, retryKind: "rate_limit" });
    expect(envelopeVerdictOf(weekly)).toEqual({ recoverable: false, retryKind: "rate_limit" });
    expect(envelopeVerdictOf(fatal)).toEqual({ recoverable: false, retryKind: null });
    expect(envelopeVerdictOf(`a partial answer\n\n${burst}`)).toEqual({
      recoverable: true,
      retryKind: "rate_limit",
    });
    expect(envelopeVerdictOf("An ordinary answer.")).toBeNull();
    expect(envelopeVerdictOf("__ERR_ENV__:{not json")).toBeNull();
    expect(envelopeVerdictOf(undefined)).toBeNull();
  });

  it("an envelope final never cancels: recoverable schedules if idle, the weekly window stops", () => {
    const deps = viewingA(["run-1"]);
    expect(
      retryLifecycleAction(
        { sessionKey: "tinker:A", state: "final", runId: "run-1", finalText: burst },
        deps,
      ),
    ).toEqual({
      kind: "schedule",
      sessionKey: "tinker:A",
      retryKind: "rate_limit",
      onlyIfIdle: true,
      runId: "run-1",
    });
    expect(
      retryLifecycleAction(
        { sessionKey: "tinker:A", state: "final", runId: "run-1", finalText: weekly },
        deps,
      ),
    ).toEqual({ kind: "stop", sessionKey: "tinker:A", runId: "run-1" });
  });

  it("a long window stops even when an older gateway stamped the outcome recoverable", () => {
    expect(
      retryLifecycleAction(
        {
          sessionKey: "tinker:A",
          state: "final",
          finalOutcome: {
            ...typed,
            detail: "You've hit your weekly limit · resets Oct 8, 6pm (Europe/Madrid)",
          },
        },
        viewingA(),
      ),
    ).toEqual({ kind: "stop", sessionKey: "tinker:A" });
    expect(
      retryLifecycleAction(
        rateLimited("tinker:A", { errorMessage: "You've hit your weekly limit · resets 6pm" }),
        viewingA(),
      ),
    ).toEqual({ kind: "stop", sessionKey: "tinker:A" });
  });

  it("retryTrackStep: arm; advance on the fired run's failure; ignore repeats; stop its own only", () => {
    const sched = (over: Record<string, unknown> = {}) => ({
      kind: "schedule" as const,
      sessionKey: "tinker:A",
      retryKind: "rate_limit" as const,
      ...over,
    });
    const stop = (runId?: string) => ({
      kind: "stop" as const,
      sessionKey: "tinker:A",
      ...(runId ? { runId } : {}),
    });
    const firing = { firing: true, firedRunId: "fire-1", retryOf: "prompt-0" };
    const waiting = { firing: false, firedRunId: "fire-1", retryOf: "prompt-0" };
    expect(retryTrackStep(sched({ onlyIfIdle: true }), undefined)).toBe("arm");
    expect(retryTrackStep(sched({ onlyIfIdle: true, runId: "fire-1" }), firing)).toBe("advance");
    expect(retryTrackStep(sched({ onlyIfIdle: true, runId: "another" }), firing)).toBe("ignore");
    expect(retryTrackStep(sched({ onlyIfIdle: true, runId: "fire-1" }), waiting)).toBe("ignore");
    expect(retryTrackStep(sched(), waiting)).toBe("advance");
    expect(retryTrackStep(stop("fire-1"), waiting)).toBe("stop");
    expect(retryTrackStep(stop("prompt-0"), waiting)).toBe("stop");
    expect(retryTrackStep(stop("another"), waiting)).toBe("ignore");
    expect(retryTrackStep(stop(), waiting)).toBe("ignore");
    expect(retryTrackStep(stop("fire-1"), undefined)).toBe("ignore");
    expect(retryTrackStep({ kind: "cancel", sessionKey: "tinker:A" }, waiting)).toBe("ignore");
    // A run whose failure ended a ladder cannot start a new one; a new run still can.
    const ended = new Set(["fire-6"]);
    expect(retryTrackStep(sched({ onlyIfIdle: true, runId: "fire-6" }), undefined, ended)).toBe(
      "ignore",
    );
    expect(retryTrackStep(sched({ runId: "fire-6" }), undefined, ended)).toBe("ignore");
    expect(retryTrackStep(sched({ onlyIfIdle: true, runId: "typed-7" }), undefined, ended)).toBe(
      "arm",
    );
  });

  it("REPLAY: every run failing as two finals moves the ladder once, and it gives up", () => {
    // app.ts's track, driven by the real decisions: scheduleRetry arms or steps the track and ends
    // it when nextRetryDelayMs runs out; retryLastTurn fires (attempt++, firing, firedRunId).
    let track:
      | { attempt: number; firing: boolean; firedRunId?: string; retryOf?: string }
      | undefined;
    let fires = 0;
    let gaveUp = false;
    const own = ["prompt-0"];
    const ended = new Set<string>();
    const scheduleRetry = () => {
      track ??= { attempt: 0, firing: false, retryOf: "prompt-0" };
      track.firing = false;
      if (nextRetryDelayMs(track.attempt) === null) {
        gaveUp = true;
        if (track.firedRunId) {
          ended.add(track.firedRunId);
        }
        track = undefined;
      }
    };
    const deliver = (ev: Record<string, unknown>) => {
      const action = retryLifecycleAction(ev, viewingA(own));
      const step = retryTrackStep(action, track, ended);
      if (action.kind === "stop" && step === "stop" && action.runId) {
        ended.add(action.runId);
      }
      if (action.kind === "cancel" || (action.kind === "stop" && step === "stop")) {
        track = undefined;
      } else if (action.kind === "schedule" && step !== "ignore") {
        scheduleRetry();
      }
    };
    const runFails = (runId: string, text: string) => {
      deliver({ sessionKey: "tinker:A", state: "final", runId, finalText: text });
      deliver({
        sessionKey: "tinker:A",
        state: "final",
        runId,
        finalText: text,
        finalOutcome: { ...typed, ...(text === weekly ? { recoverable: false } : {}) },
      });
    };

    runFails("prompt-0", burst);
    for (let i = 1; i <= 50 && track; i++) {
      const id = `fire-${i}`;
      own.push(id);
      track.attempt++;
      track.firing = true;
      track.firedRunId = id;
      fires++;
      runFails(id, burst);
    }
    expect(gaveUp).toBe(true);
    expect(fires).toBe(RETRY_LADDER_MS.length);

    // And the weekly limit is never retried at all.
    track = undefined;
    gaveUp = false;
    runFails("prompt-0", weekly);
    expect(track).toBeUndefined();
  });
});
