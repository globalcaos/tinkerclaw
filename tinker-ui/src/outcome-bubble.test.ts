import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  answerTextOf,
  deriveOutcome,
  isTurnOutcome,
  outcomeOf,
  renderOutcomeBubble,
  retryKindForOutcome,
  type TurnOutcomeLike,
} from "./outcome-bubble";

const typed = (over: Partial<TurnOutcomeLike> = {}): TurnOutcomeLike => ({
  kind: "rate_limit",
  recoverable: true,
  headline: "Rate limited",
  source: "stop-reason",
  ...over,
});

const assistant = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  role: "assistant",
  content: [{ type: "text", text: "here is your answer" }],
  ...over,
});

describe("isTurnOutcome — the wire guard", () => {
  it("accepts a minimal valid outcome", () => {
    expect(isTurnOutcome(typed())).toBe(true);
  });

  it("rejects an unknown kind, an unknown source and an empty headline", () => {
    expect(isTurnOutcome({ ...typed(), kind: "melted" })).toBe(false);
    expect(isTurnOutcome({ ...typed(), source: "vibes" })).toBe(false);
    expect(isTurnOutcome({ ...typed(), headline: "" })).toBe(false);
  });

  it("rejects non-objects and a NaN retryAfter", () => {
    expect(isTurnOutcome(null)).toBe(false);
    expect(isTurnOutcome("rate_limit")).toBe(false);
    expect(isTurnOutcome({ ...typed(), retryAfter: Number.NaN })).toBe(false);
  });
});

describe("outcomeOf — typed wins, derived is the fallback", () => {
  it("returns a valid typed outcome unchanged", () => {
    const oc = typed({ kind: "quota", headline: "Usage limit reached" });
    expect(outcomeOf(assistant({ outcome: oc }))).toBe(oc);
  });

  it("falls through to the derivation when msg.outcome is malformed", () => {
    const msg = assistant({
      outcome: { kind: "nope" },
      content: [],
      stopReason: "error",
      errorMessage: "429 rate limit exceeded",
    });
    expect(outcomeOf(msg)).toMatchObject({ kind: "rate_limit", recoverable: true });
  });

  it("returns null for an ordinary answer — the legacy render path keeps it", () => {
    expect(outcomeOf(assistant())).toBeNull();
    expect(outcomeOf(assistant({ stopReason: "stop" }))).toBeNull();
  });

  it("returns null for a user message and for junk", () => {
    expect(outcomeOf({ role: "user", content: "hi", stopReason: "error" })).toBeNull();
    expect(outcomeOf(undefined)).toBeNull();
  });

  it("never claims a client-minted lifecycle bubble", () => {
    // Each has its own renderer further down both chains. A derived `empty` on the live reasoning
    // bubble would repaint a half-arrived stream grey; re-classifying the exhausted "gave up after
    // 6 retries" row would promise a retry that is never coming.
    for (const flag of [
      "_isRetryWarning",
      "_isOverloadRetry",
      "_isPhaseTiming",
      "_isExhausted",
      "_isWarning",
      "_isReasoning",
    ]) {
      const msg = assistant({ content: [], stopReason: "stop", [flag]: true });
      expect(outcomeOf(msg), flag).toBeNull();
    }
  });
});

describe("deriveOutcome — structured fields only", () => {
  it("classifies a recoverable stopReason:error by its errorMessage", () => {
    expect(
      deriveOutcome(assistant({ stopReason: "error", errorMessage: "429 rate limit exceeded" })),
    ).toMatchObject({ kind: "rate_limit", recoverable: true, source: "stop-reason" });
    expect(
      deriveOutcome(assistant({ stopReason: "error", errorMessage: "You exceeded your quota" })),
    ).toMatchObject({ kind: "quota", recoverable: true });
    expect(
      deriveOutcome(assistant({ stopReason: "error", errorMessage: "529 Overloaded" })),
    ).toMatchObject({ kind: "overload", recoverable: true });
  });

  it("prefers a structured `reason` over the text, as the ladder does", () => {
    expect(
      deriveOutcome(
        assistant({ stopReason: "error", reason: "quota", errorMessage: "something opaque" }),
      ),
    ).toMatchObject({ kind: "quota", recoverable: true });
  });

  it("classifies an unrecognised failure as a terminal `error`", () => {
    expect(
      deriveOutcome(assistant({ stopReason: "error", errorMessage: "401 invalid api key" })),
    ).toMatchObject({ kind: "error", recoverable: false });
  });

  it("carries the error text as the detail, capped", () => {
    const long = "x".repeat(5000);
    const oc = deriveOutcome(assistant({ stopReason: "error", errorMessage: long }));
    expect(oc?.detail?.length).toBe(2000);
  });

  it("falls back to the message text when there is no errorMessage", () => {
    const oc = deriveOutcome({
      role: "assistant",
      content: [{ type: "text", text: "API Error: 529 Overloaded" }],
      stopReason: "error",
    });
    expect(oc).toMatchObject({ kind: "overload", recoverable: true });
  });

  it("derives `aborted` from stopReason", () => {
    expect(deriveOutcome(assistant({ stopReason: "aborted" }))).toMatchObject({
      kind: "aborted",
      recoverable: false,
    });
  });

  it("derives `empty` only for a finished, contentless, tool-free turn", () => {
    expect(deriveOutcome({ role: "assistant", content: [], stopReason: "stop" })).toMatchObject({
      kind: "empty",
      recoverable: false,
      source: "empty",
    });
  });

  it("does NOT derive `empty` for a live bubble with no stopReason", () => {
    // Narrower than the gateway's rule 8 on purpose: a half-arrived streaming bubble has no
    // stopReason, and painting those "∅ No answer" would regress every streaming turn.
    expect(deriveOutcome({ role: "assistant", content: [], stopReason: undefined })).toBeNull();
  });

  it("does NOT derive `empty` when the turn ran tools or only thought", () => {
    expect(
      deriveOutcome({
        role: "assistant",
        content: [{ type: "tool_use", id: "t1" }],
        stopReason: "stop",
      }),
    ).toBeNull();
    expect(
      deriveOutcome({
        role: "assistant",
        content: [{ type: "thinking", thinking: "hmm" }],
        stopReason: "stop",
      }),
    ).toBeNull();
  });
});

describe("answerTextOf — a real answer survives, scaffolding does not", () => {
  it("keeps a partial answer and drops the envelope after it", () => {
    const text = 'Here is half an answer.\n__ERR_ENV__:{"kind":"error","headline":"boom"}';
    expect(answerTextOf(text, typed())).toBe("Here is half an answer.");
  });

  it("drops the gateway's pre-content placeholder", () => {
    expect(answerTextOf("[assistant turn failed before producing content]", typed())).toBe("");
  });

  it("drops text that IS the outcome's own detail", () => {
    const err = "API Error: 429 rate limit exceeded";
    expect(answerTextOf(err, typed({ detail: err }))).toBe("");
    expect(answerTextOf(`  ${err}\n`, typed({ detail: err }))).toBe("");
  });

  it("drops the error text when the detail is a trimmed or capped copy of it", () => {
    const full = "429 rate limit exceeded for model claude-opus-5 on this key. Logs: /tmp/x.log";
    const trimmed = "429 rate limit exceeded for model claude-opus-5 on this key.";
    expect(answerTextOf(full, typed({ detail: trimmed }))).toBe("");
    expect(answerTextOf(trimmed, typed({ detail: full }))).toBe("");
  });

  it("does NOT drop a real answer that merely shares a short prefix with the detail", () => {
    expect(answerTextOf("Error handling in Rust uses Result.", typed({ detail: "Error" }))).toBe(
      "Error handling in Rust uses Result.",
    );
  });

  it("keeps the text when the outcome carries no detail (aborted mid-answer)", () => {
    expect(answerTextOf("half an answer", typed({ kind: "aborted", detail: undefined }))).toBe(
      "half an answer",
    );
  });

  it("is total over junk", () => {
    expect(answerTextOf(undefined, typed())).toBe("");
    expect(answerTextOf("", typed())).toBe("");
  });
});

describe("renderOutcomeBubble — colour vocabulary and escaping", () => {
  it("recoverable → the existing orange bubble, no exhausted class", () => {
    const h = renderOutcomeBubble(typed());
    expect(h).toContain("msg-overload-bubble");
    expect(h).toContain("msg-outcome-bubble");
    expect(h).toContain("outcome-rate_limit");
    expect(h).not.toContain("exhausted");
    expect(h).not.toContain("quiet");
    expect(h).toContain("⚠️ Rate limited");
  });

  it("not recoverable → red via the existing `.exhausted`", () => {
    const h = renderOutcomeBubble(
      typed({ kind: "billing", recoverable: false, headline: "Billing problem" }),
    );
    expect(h).toContain("exhausted");
    expect(h).toContain("🛑 Billing problem");
  });

  it("aborted → grey ⏹ Stopped", () => {
    const h = renderOutcomeBubble(
      typed({ kind: "aborted", recoverable: false, headline: "Stopped", source: "stop-reason" }),
    );
    expect(h).toContain("quiet");
    expect(h).not.toContain("exhausted");
    expect(h).toContain("⏹ Stopped");
  });

  it("empty → grey ∅ No answer (the short copy, not the logged sentence)", () => {
    const h = renderOutcomeBubble(
      typed({
        kind: "empty",
        recoverable: false,
        headline: "No answer — the model returned nothing",
        source: "empty",
      }),
    );
    expect(h).toContain("quiet");
    expect(h).toContain("∅ No answer");
  });

  it("shows retryAfter as a human wait", () => {
    expect(renderOutcomeBubble(typed({ retryAfter: 262 * 60 }))).toContain("retry after 262m");
    expect(renderOutcomeBubble(typed({ retryAfter: 90 }))).toContain("retry after 1m 30s");
    expect(renderOutcomeBubble(typed({ retryAfter: 0 }))).not.toContain("retry after");
    expect(renderOutcomeBubble(typed())).not.toContain("retry after");
  });

  it("puts the raw detail in a <details> expander, and omits it when there is none", () => {
    expect(renderOutcomeBubble(typed({ detail: "429 from upstream" }))).toContain(
      '<details class="msg-outcome-detail"><summary>details</summary><pre>429 from upstream</pre></details>',
    );
    expect(renderOutcomeBubble(typed())).not.toContain("<details");
  });

  it("carries the caller's keyed-fold attribute on the expander (2026-10-02)", () => {
    expect(renderOutcomeBubble(typed({ detail: "429" }), ' data-fold-key="o:m7" open')).toContain(
      '<details class="msg-outcome-detail" data-fold-key="o:m7" open><summary>',
    );
  });

  it("prefers the envelope's own icon when the outcome carries one", () => {
    expect(renderOutcomeBubble(typed({ envelope: { icon: "🪫" } }))).toContain("🪫 Rate limited");
  });

  it("ESCAPES the headline and the detail — both are provider text", () => {
    const h = renderOutcomeBubble(
      typed({ headline: '<img src=x onerror="alert(1)">', detail: "</pre><script>bad()</script>" }),
    );
    expect(h).not.toContain("<img");
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;img");
    expect(h).toContain("&lt;script&gt;");
  });

  it("is DETERMINISTIC — §5.8X reuses a node whose HTML string is unchanged", () => {
    const oc = typed({ detail: "boom", retryAfter: 30 });
    expect(renderOutcomeBubble(oc)).toBe(renderOutcomeBubble(oc));
  });
});

describe("retryKindForOutcome — handing a typed outcome to the §5.8j ladder", () => {
  it("maps the recoverable kinds onto the existing RetryKind values", () => {
    expect(retryKindForOutcome("rate_limit")).toBe("rate_limit");
    expect(retryKindForOutcome("quota")).toBe("quota");
    expect(retryKindForOutcome("overload")).toBe("overloaded");
    expect(retryKindForOutcome("network")).toBe("unavailable");
    expect(retryKindForOutcome("timeout")).toBe("unavailable");
  });

  it("maps everything terminal to null", () => {
    for (const k of ["auth", "billing", "refusal", "aborted", "empty", "error", "nonsense"]) {
      expect(retryKindForOutcome(k), k).toBeNull();
    }
  });
});

// ─── The mirror's drift guard ───────────────────────────────────────────────────────────
// TurnOutcome is MIRRORED in outcome-bubble.ts rather than imported (see its header: `src/fork/` is
// gateway territory and one node import there would break the UI bundle). The cost of a mirror is
// drift, so read the gateway's own module off disk and FAIL when the two disagree — a check that
// breaks on the defect beats prose describing it. Walk up from the vitest cwd rather than
// import.meta.url: under this jsdom project the module URL is an http:// one.
describe("mirror of src/fork/turn-outcome.ts", () => {
  const findSource = (): string => {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, "src", "fork", "turn-outcome.ts");
      if (existsSync(candidate)) {
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    throw new Error(`could not locate src/fork/turn-outcome.ts from ${process.cwd()}`);
  };
  const src = readFileSync(findSource(), "utf8");

  const unionMembers = (typeName: string): string[] => {
    const start = src.indexOf(`export type ${typeName} =`);
    expect(start, `${typeName} moved or was renamed in turn-outcome.ts`).toBeGreaterThan(-1);
    const end = src.indexOf(";", start);
    return [...src.slice(start, end).matchAll(/"([a-z_-]+)"/g)].map((m) => m[1]);
  };

  it("KINDS covers exactly TurnOutcomeKind", () => {
    const gateway = unionMembers("TurnOutcomeKind").sort();
    const mine = [
      "rate_limit",
      "quota",
      "overload",
      "network",
      "timeout",
      "auth",
      "billing",
      "context_overflow",
      "refusal",
      "aborted",
      "empty",
      "error",
    ].sort();
    expect(mine).toEqual(gateway);
    for (const kind of gateway) {
      expect(isTurnOutcome({ ...typed(), kind }), kind).toBe(true);
    }
  });

  it("SOURCES covers exactly TurnOutcomeSource", () => {
    const gateway = unionMembers("TurnOutcomeSource").sort();
    for (const source of gateway) {
      expect(isTurnOutcome({ ...typed(), source }), source).toBe(true);
    }
    expect(gateway).toEqual(
      ["stop-reason", "envelope", "cli", "injected", "prompt-error", "empty"].sort(),
    );
  });

  it("the derived headlines match the gateway's HEADLINES table", () => {
    const start = src.indexOf("const HEADLINES: Record<TurnOutcomeKind, string> = {");
    expect(start, "the HEADLINES table moved in turn-outcome.ts").toBeGreaterThan(-1);
    const end = src.indexOf("};", start);
    const table = Object.fromEntries(
      [...src.slice(start, end).matchAll(/(\w+):\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]),
    );
    // Every kind a DERIVED outcome can produce must read identically to the typed one, or the same
    // failure would be worded differently live and after a reload.
    expect(deriveOutcome(assistant({ stopReason: "aborted" }))?.headline).toBe(table.aborted);
    expect(deriveOutcome({ role: "assistant", content: [], stopReason: "stop" })?.headline).toBe(
      table.empty,
    );
    expect(
      deriveOutcome(assistant({ stopReason: "error", errorMessage: "429 rate limit" }))?.headline,
    ).toBe(table.rate_limit);
    expect(
      deriveOutcome(assistant({ stopReason: "error", errorMessage: "You exceeded your quota" }))
        ?.headline,
    ).toBe(table.quota);
    expect(
      deriveOutcome(assistant({ stopReason: "error", errorMessage: "529 Overloaded" }))?.headline,
    ).toBe(table.overload);
    expect(
      deriveOutcome(assistant({ stopReason: "error", errorMessage: "401 invalid key" }))?.headline,
    ).toBe(table.error);
  });
});
