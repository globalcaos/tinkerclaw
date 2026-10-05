// FORK 2026-09-24 — context-window-panel.md §6.2 B4: every branch of the EVICT / COMPACT
// availability model (buttonState), the non-blocking confirm, the compaction liveness bound, the
// next-call lane and the result toast. FORK 2026-09-25 (B3 unit): and the pulse's one transition,
// compactionPulseStep, on every shape an A1 producer sends it. FORK 2026-09-25 (§6.1 A6, option
// (i)): and COMPACT's CLI route on the claude-code lane — its availability, its route, the bare
// `/compact`, its toast from the CLI's own `end`, and the app.ts wiring (source check). CONTROL: on
// the parent commit these fail (the exports do not exist, and that lane disabled COMPACT outright).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buttonState,
  CACHE_ACT_CONFIRM_WINDOW_MS,
  CACHE_ACT_DESCRIPTION,
  cacheActArmed,
  cacheActPress,
  cacheActResultToast,
  cacheActRoute,
  CLI_COMPACT_BUSY_REASON,
  CLI_COMPACT_COMMAND,
  CLI_COMPACT_DESCRIPTION,
  cliCompactionToast,
  COMPACTION_LIVE_MAX_MS,
  compactionIsLive,
  compactionPulseStep,
  contextOwningLane,
  isCompactCommand,
  resolveNextCallProvider,
  type CacheAct,
  type CacheButtonInputs,
} from "./context-buttons.js";
import { EMPTY_COUNTERS, reduceCounters } from "./context-counters.js";

const ACTS: CacheAct[] = ["evict", "compact"];
const KEY = "agent:main:tinker:abc";

/** An idle session on an embedded lane, nothing in flight: the one state where a press fires at once. */
function idle(act: CacheAct, over: Partial<CacheButtonInputs> = {}): CacheButtonInputs {
  return { act, sessionKey: KEY, provider: "anthropic", busy: false, ...over };
}

describe("buttonState — enabled", () => {
  it.each(ACTS)("%s: enabled, no confirm, on an idle embedded-lane session", (act) => {
    expect(buttonState(idle(act))).toEqual({
      act,
      disabled: false,
      confirm: false,
      label: act,
      title: CACHE_ACT_DESCRIPTION[act],
    });
  });

  it.each(ACTS)("%s: an unknown lane is not treated as a context-owning one (P10)", (act) => {
    expect(buttonState(idle(act, { provider: undefined })).disabled).toBe(false);
    expect(buttonState(idle(act, { provider: "   " })).disabled).toBe(false);
  });

  it.each(ACTS)("%s: a busy session keeps it enabled but asks for confirmation", (act) => {
    const s = buttonState(idle(act, { busy: true }));
    expect(s.disabled).toBe(false);
    expect(s.reason).toBeUndefined();
    expect(s.confirm).toBe(true);
    expect(s.label).toBe(act);
    expect(s.title.startsWith(CACHE_ACT_DESCRIPTION[act])).toBe(true);
    expect(s.title).toContain("interrupts the running turn");
  });

  it.each(ACTS)("%s: busy and armed, the label asks for the confirming press", (act) => {
    const s = buttonState(idle(act, { busy: true, armed: true }));
    expect(s).toMatchObject({ disabled: false, confirm: true, label: "sure?" });
    expect(s.title).toContain("Press again now");
  });

  it.each(ACTS)("%s: an arm left over on a session that went idle changes nothing", (act) => {
    expect(buttonState(idle(act, { armed: true }))).toMatchObject({
      disabled: false,
      confirm: false,
      label: act,
    });
  });
});

describe("buttonState — disabled, with the reason in the tooltip", () => {
  it.each(ACTS)("%s: no session attached", (act) => {
    for (const sessionKey of ["", "   ", null, undefined]) {
      const s = buttonState(idle(act, { sessionKey }));
      expect(s.disabled).toBe(true);
      expect(s.confirm).toBe(false);
      expect(s.label).toBe(act);
      expect(s.reason).toBe("no session is attached to this tab");
      expect(s.title).toBe(`${CACHE_ACT_DESCRIPTION[act]}\n\nUnavailable: ${s.reason}.`);
    }
  });

  it("EVICT on the claude-code lane: the gateway's own refusal, before the gateway is asked", () => {
    const s = buttonState(idle("evict", { provider: "claude-code" }));
    expect(s.disabled).toBe(true);
    expect(s.reason).toBe(
      "the claude-code runtime keeps its own copy of this session's context, so evicting the gateway transcript would not shrink the next call",
    );
  });

  it("the lane check ignores case and surrounding space", () => {
    expect(buttonState(idle("evict", { provider: " Claude-Code " })).disabled).toBe(true);
    expect(buttonState(idle("compact", { provider: " Claude-Code " })).title).toBe(
      CLI_COMPACT_DESCRIPTION,
    );
  });

  it.each(ACTS)("%s: an eviction RPC in flight turns both buttons off", (act) => {
    const s = buttonState(idle(act, { inFlight: "evict" }));
    expect(s.disabled).toBe(true);
    expect(s.reason).toBe("an eviction is already running on this session");
  });

  it.each(ACTS)("%s: a compaction RPC in flight turns both buttons off", (act) => {
    expect(buttonState(idle(act, { inFlight: "compact" })).reason).toBe(
      "a compaction is already running on this session",
    );
  });

  it.each(ACTS)("%s: a compaction the A1 stream reports running turns both off", (act) => {
    const withTrigger = buttonState(idle(act, { compactionLive: { trigger: "cli-internal" } }));
    expect(withTrigger.disabled).toBe(true);
    expect(withTrigger.reason).toBe(
      "a compaction is running on this session (trigger: cli-internal)",
    );
    expect(buttonState(idle(act, { compactionLive: {} })).reason).toBe(
      "a compaction is running on this session",
    );
  });

  it.each(ACTS)("%s: the gateway's last 'nothing to do' answer turns that button off", (act) => {
    const s = buttonState(idle(act, { nothingToDo: "too few messages to evict" }));
    expect(s.disabled).toBe(true);
    expect(s.reason).toBe(
      `the last ${act} found nothing to do (too few messages to evict); checked again after the next model call`,
    );
  });

  it.each(ACTS)("%s: a blank 'nothing to do' is not a verdict", (act) => {
    expect(buttonState(idle(act, { nothingToDo: "   " })).disabled).toBe(false);
  });

  it("precedence: the first match wins, in P8's order", () => {
    const all: Partial<CacheButtonInputs> = {
      sessionKey: "",
      provider: "claude-code",
      inFlight: "compact",
      compactionLive: { trigger: "pi-auto" },
      nothingToDo: "no transcript",
      busy: true,
      armed: true,
    };
    const reasonOf = (over: Partial<CacheButtonInputs>) =>
      buttonState(idle("evict", { ...all, ...over })).reason;
    expect(reasonOf({})).toMatch(/^no session/);
    expect(reasonOf({ sessionKey: KEY })).toMatch(/^the claude-code runtime/);
    expect(reasonOf({ sessionKey: KEY, provider: "anthropic" })).toMatch(
      /^a compaction is already running/,
    );
    expect(reasonOf({ sessionKey: KEY, provider: "anthropic", inFlight: undefined })).toMatch(
      /^a compaction is running on this session \(trigger: pi-auto\)/,
    );
    expect(
      reasonOf({
        sessionKey: KEY,
        provider: "anthropic",
        inFlight: undefined,
        compactionLive: undefined,
      }),
    ).toMatch(/^the last evict found nothing to do/);
    const open = buttonState(
      idle("evict", {
        ...all,
        sessionKey: KEY,
        provider: "anthropic",
        inFlight: undefined,
        compactionLive: undefined,
        nothingToDo: undefined,
      }),
    );
    expect(open).toMatchObject({ disabled: false, confirm: true, label: "sure?" });
  });
});

describe("cacheActPress — the non-blocking confirm", () => {
  const now = 1_000_000;

  it("ignores a press on a disabled button, armed or not", () => {
    expect(cacheActPress(buttonState(idle("evict", { sessionKey: "" })), undefined, now)).toBe(
      "ignore",
    );
    const laneOff = buttonState(idle("evict", { provider: "claude-code", busy: true }));
    expect(cacheActPress(laneOff, now - 1, now)).toBe("ignore");
  });

  it("fires at once on an idle session", () => {
    expect(cacheActPress(buttonState(idle("evict")), undefined, now)).toBe("fire");
  });

  it("arms the first press on a busy session", () => {
    expect(cacheActPress(buttonState(idle("evict", { busy: true })), undefined, now)).toBe("arm");
  });

  it("fires the second press inside the window, up to its edge", () => {
    const busy = buttonState(idle("compact", { busy: true }));
    expect(cacheActPress(busy, now - 1, now)).toBe("fire");
    expect(cacheActPress(busy, now - CACHE_ACT_CONFIRM_WINDOW_MS, now)).toBe("fire");
  });

  it("re-arms once the window has lapsed, and never trusts an arm stamped in the future", () => {
    const busy = buttonState(idle("compact", { busy: true }));
    expect(cacheActPress(busy, now - CACHE_ACT_CONFIRM_WINDOW_MS - 1, now)).toBe("arm");
    expect(cacheActPress(busy, now + 10, now)).toBe("arm");
  });
});

describe("cacheActArmed", () => {
  const now = 5_000_000;

  it("is false with no arm or a non-finite stamp", () => {
    expect(cacheActArmed(undefined, now)).toBe(false);
    expect(cacheActArmed(Number.NaN, now)).toBe(false);
    expect(cacheActArmed(Number.POSITIVE_INFINITY, now)).toBe(false);
  });

  it("holds for exactly the confirm window", () => {
    expect(cacheActArmed(now, now)).toBe(true);
    expect(cacheActArmed(now - CACHE_ACT_CONFIRM_WINDOW_MS, now)).toBe(true);
    expect(cacheActArmed(now - CACHE_ACT_CONFIRM_WINDOW_MS - 1, now)).toBe(false);
  });
});

describe("compactionIsLive", () => {
  const now = 50_000_000;

  it("is false with no start seen", () => {
    expect(compactionIsLive(undefined, now)).toBe(false);
    expect(compactionIsLive(Number.NaN, now)).toBe(false);
  });

  it("holds a start through the longest compaction measured (the CLI's, 217 s)", () => {
    expect(compactionIsLive(now, now)).toBe(true);
    expect(compactionIsLive(now - 217_000, now)).toBe(true);
  });

  it("drops a start at the bound, so a lost end cannot pulse or lock the buttons forever", () => {
    expect(compactionIsLive(now - COMPACTION_LIVE_MAX_MS + 1, now)).toBe(true);
    expect(compactionIsLive(now - COMPACTION_LIVE_MAX_MS, now)).toBe(false);
  });

  it("the bound clears the measured CLI maximum and the COMPACT RPC's 180 s timeout", () => {
    expect(COMPACTION_LIVE_MAX_MS).toBeGreaterThan(217_000);
    expect(COMPACTION_LIVE_MAX_MS).toBeGreaterThan(180_000);
  });
});

describe("compactionPulseStep — the pulse's one transition (B4, F11; every shape A1 producers send)", () => {
  const now = 80_000_000;

  it("a start with nothing running starts the pulse, keeping a non-blank trigger", () => {
    expect(
      compactionPulseStep(undefined, { phase: "start", trigger: "cli-internal" }, now),
    ).toEqual({ kind: "start", next: { at: now, trigger: "cli-internal" } });
    expect(compactionPulseStep(undefined, { phase: "start", trigger: "  " }, now)).toEqual({
      kind: "start",
      next: { at: now },
    });
  });

  it("a repeated start keeps the FIRST stamp, so a repeating executor cannot extend its life", () => {
    const first = { at: now - 30_000, trigger: "cli-internal" };
    expect(compactionPulseStep(first, { phase: "start", trigger: "cli-internal" }, now)).toEqual({
      kind: "start",
      next: first,
    });
  });

  it("a start past the liveness bound replaces the stale mark", () => {
    const stale = { at: now - COMPACTION_LIVE_MAX_MS, trigger: "pi-auto" };
    expect(compactionPulseStep(stale, { phase: "start", trigger: "manual" }, now)).toEqual({
      kind: "start",
      next: { at: now, trigger: "manual" },
    });
  });

  it("an `end` with no `start` before it ends the pulse and is not an error", () => {
    // A3: a compact_boundary with no `compacting` status line before it still ends.
    const boundary = {
      phase: "end",
      completed: true,
      trigger: "cli-internal",
      lane: "cc-bridge",
      provenance: "exact",
      tokensBefore: 971_000,
      tokensAfter: 12_400,
    };
    expect(compactionPulseStep(undefined, boundary, now)).toEqual({ kind: "end" });
  });

  it("an `end` with completed:false ends the pulse all the same (a failed CLI compaction)", () => {
    // A3's `compact_result:"failed"` status line: the verdict and no figures.
    const failed = {
      phase: "end",
      completed: false,
      trigger: "cli-internal",
      lane: "cc-bridge",
      provenance: "exact",
    };
    expect(compactionPulseStep({ at: now - 5_000, trigger: "cli-internal" }, failed, now)).toEqual({
      kind: "end",
    });
    expect(compactionPulseStep(undefined, failed, now)).toEqual({ kind: "end" });
  });

  it("anything that is not a phase of the contract neither starts nor stops it", () => {
    const live = { at: now - 1_000 };
    for (const data of [undefined, null, "end", 7, {}, { phase: "compacting" }, { phase: 1 }]) {
      expect(compactionPulseStep(live, data, now)).toEqual({ kind: "ignore" });
    }
  });
});

describe("resolveNextCallProvider", () => {
  it("the tab's client pin wins, split at its FIRST slash", () => {
    expect(
      resolveNextCallProvider({
        clientPin: "openrouter/qwen/qwen3.8-max",
        durablePinProvider: "claude-code",
        servedProvider: "anthropic",
      }),
    ).toBe("openrouter");
  });

  it("then the durable pin, then the provider that served the last call", () => {
    expect(
      resolveNextCallProvider({ durablePinProvider: "claude-code", servedProvider: "anthropic" }),
    ).toBe("claude-code");
    expect(resolveNextCallProvider({ servedProvider: "claude-code" })).toBe("claude-code");
  });

  it("ignores a client pin with no provider segment, and blanks", () => {
    expect(resolveNextCallProvider({ clientPin: "claude-opus-5", durablePinProvider: "xai" })).toBe(
      "xai",
    );
    expect(
      resolveNextCallProvider({ clientPin: " ", durablePinProvider: " ", servedProvider: "xai" }),
    ).toBe("xai");
  });

  it("is undefined when nothing is known", () => {
    expect(resolveNextCallProvider({})).toBeUndefined();
  });
});

describe("contextOwningLane", () => {
  it("names claude-code, in any case", () => {
    expect(contextOwningLane("claude-code")).toBe("claude-code");
    expect(contextOwningLane("CLAUDE-CODE")).toBe("claude-code");
  });

  it("is undefined on an embedded lane or an unknown one", () => {
    expect(contextOwningLane("anthropic")).toBeUndefined();
    expect(contextOwningLane("")).toBeUndefined();
    expect(contextOwningLane(undefined)).toBeUndefined();
  });
});

describe("cacheActResultToast", () => {
  it("EVICT: before → after, labelled estimated, plus the freed estimate", () => {
    expect(
      cacheActResultToast("evict", {
        ok: true,
        compacted: true,
        evictedTokens: 88_109,
        tokensBefore: 180_213,
        tokensAfter: 92_104,
      }),
    ).toEqual({
      text: "Evicted: 180,213 → 92,104 tokens (estimated), 88,109 freed",
      isError: false,
    });
  });

  it("COMPACT: after and freed, never the nested store-wide tokensBefore", () => {
    const t = cacheActResultToast("compact", {
      ok: true,
      compacted: true,
      evictedTokens: 128_260,
      tokensAfter: 47_590,
      result: { tokensBefore: 7_855_029 },
    });
    expect(t).toEqual({ text: "Compacted: now 47,590 tokens, 128,260 freed", isError: false });
    expect(t.text).not.toContain("7,855,029");
  });

  it("only a freed figure, or nothing measured at all", () => {
    expect(
      cacheActResultToast("compact", { ok: true, compacted: true, evictedTokens: 128_260 }).text,
    ).toBe("Compacted — 128,260 tokens freed");
    expect(cacheActResultToast("evict", { ok: true, compacted: true }).text).toBe(
      "Evicted — context window refreshed",
    );
  });

  it("absent is not zero: NaN, negative and non-number counts are dropped, a measured 0 is kept", () => {
    expect(
      cacheActResultToast("evict", {
        ok: true,
        compacted: true,
        tokensBefore: Number.NaN,
        tokensAfter: -1,
        evictedTokens: "12",
      }).text,
    ).toBe("Evicted — context window refreshed");
    expect(
      cacheActResultToast("evict", { ok: true, compacted: true, tokensBefore: 10, tokensAfter: 0 })
        .text,
    ).toBe("Evicted: 10 → 0 tokens (estimated)");
  });

  it("nothing to do: reports the reason and hands it to buttonState", () => {
    expect(
      cacheActResultToast("evict", {
        ok: true,
        compacted: false,
        kept: 3,
        reason: "too few messages to evict",
      }),
    ).toEqual({
      text: "Nothing to evict: too few messages to evict",
      isError: false,
      nothingToDo: "too few messages to evict",
    });
    expect(cacheActResultToast("compact", { ok: true, compacted: false })).toEqual({
      text: "Nothing to compact",
      isError: false,
      nothingToDo: "the gateway reported nothing to do",
    });
  });

  it("a refusal is an error and is NOT remembered as nothing-to-do", () => {
    const t = cacheActResultToast("evict", {
      ok: false,
      compacted: false,
      reason: "the lane owns its context",
    });
    expect(t).toEqual({ text: "Could not evict: the lane owns its context", isError: true });
    expect(cacheActResultToast("compact", { ok: false }).text).toBe(
      "Could not compact: the gateway declined without a reason",
    );
  });

  it("tolerates a missing reply", () => {
    expect(cacheActResultToast("evict", null)).toEqual({
      text: "Nothing to evict",
      isError: false,
      nothingToDo: "the gateway reported nothing to do",
    });
    expect(cacheActResultToast("compact", undefined).text).toBe("Nothing to compact");
  });
});

// ── §6.1 A6 (the owner's decision 2026-09-25, option (i)): COMPACT on the claude-code lane ──

/** The bridge's A3 `end`, from a compact_boundary: the claude CLI's own pre_tokens / post_tokens. */
const CLI_END = {
  phase: "end",
  completed: true,
  trigger: "cli-internal",
  lane: "cc-bridge",
  provenance: "exact",
  tokensBefore: 971_000,
  tokensAfter: 12_400,
};
const cliEnd = (over: Record<string, unknown> = {}) => ({ ...CLI_END, ...over });

describe("buttonState — COMPACT on the claude-code lane is the CLI's own /compact (A6)", () => {
  const cc = (over: Partial<CacheButtonInputs> = {}) =>
    buttonState(idle("compact", { provider: "claude-code", ...over }));

  it("idle: enabled, fires at once, and the tooltip says the CLI compacts", () => {
    expect(cc()).toEqual({
      act: "compact",
      disabled: false,
      confirm: false,
      label: "compact",
      title: CLI_COMPACT_DESCRIPTION,
    });
    expect(cacheActPress(cc(), undefined, 1_000)).toBe("fire");
  });

  it("busy: disabled with the reason, never the two-press confirm, armed or not", () => {
    expect(CLI_COMPACT_BUSY_REASON).toBe(
      "wait for the turn to finish — the CLI compacts between turns",
    );
    for (const armed of [false, true]) {
      const s = cc({ busy: true, armed });
      expect(s).toMatchObject({
        disabled: true,
        confirm: false,
        label: "compact",
        reason: CLI_COMPACT_BUSY_REASON,
      });
      expect(s.title).toBe(
        `${CLI_COMPACT_DESCRIPTION}\n\nUnavailable: ${CLI_COMPACT_BUSY_REASON}.`,
      );
      expect(cacheActPress(s, 1_000, 1_000)).toBe("ignore");
    }
  });

  it("a compaction running, or a press in flight, still turns it off first", () => {
    const live = cc({ busy: true, compactionLive: { trigger: "cli-internal" } });
    expect(live.reason).toBe("a compaction is running on this session (trigger: cli-internal)");
    expect(live.title.startsWith(CLI_COMPACT_DESCRIPTION)).toBe(true);
    expect(cc({ inFlight: "compact" }).reason).toBe(
      "a compaction is already running on this session",
    );
  });

  it("the gateway's 'nothing to do' does not gate it: that was about the gateway's transcript", () => {
    expect(cc({ nothingToDo: "nothing compactable in this session yet" }).disabled).toBe(false);
  });

  it("no session attached still comes first", () => {
    expect(cc({ sessionKey: "" }).reason).toBe("no session is attached to this tab");
  });

  it("EVICT on the same lane stays disabled exactly as before, idle or busy", () => {
    for (const busy of [false, true]) {
      const s = buttonState(idle("evict", { provider: "claude-code", busy }));
      expect(s.disabled).toBe(true);
      expect(s.reason).toBe(
        "the claude-code runtime keeps its own copy of this session's context, so evicting the gateway transcript would not shrink the next call",
      );
      expect(s.title.startsWith(CACHE_ACT_DESCRIPTION.evict)).toBe(true);
    }
  });
});

describe("cacheActRoute — where a fired press goes", () => {
  it("COMPACT on a context-owning lane is a CLI turn, in any case", () => {
    expect(cacheActRoute("compact", "claude-code")).toBe("cli-turn");
    expect(cacheActRoute("compact", " Claude-Code ")).toBe("cli-turn");
  });

  it("everything else is the sessions.compact RPC, an unknown lane included (P10)", () => {
    expect(cacheActRoute("evict", "claude-code")).toBe("rpc");
    expect(cacheActRoute("compact", "anthropic")).toBe("rpc");
    expect(cacheActRoute("compact", undefined)).toBe("rpc");
  });

  it("buttonState paints the CLI's description exactly where the route is the CLI's", () => {
    for (const act of ACTS) {
      for (const provider of ["claude-code", "anthropic", undefined]) {
        const title = buttonState(idle(act, { provider })).title;
        const cli = cacheActRoute(act, provider) === "cli-turn";
        expect(title.startsWith(CLI_COMPACT_DESCRIPTION), `${act} ${provider}`).toBe(cli);
      }
    }
  });
});

describe("isCompactCommand — the prompt that goes out bare, on every lane", () => {
  it("is /compact alone or with its instructions, and the button sends exactly that", () => {
    expect(CLI_COMPACT_COMMAND).toBe("/compact");
    for (const text of [
      CLI_COMPACT_COMMAND,
      " /compact ",
      "/compact focus on the open plan",
      "/compact: keep the file paths",
      "/compact\nkeep the file paths",
      "/COMPACT",
    ]) {
      expect(isCompactCommand(text), text).toBe(true);
    }
  });

  it("is not a prompt that mentions it, a longer word, another command or a path", () => {
    for (const text of [
      "please /compact",
      "/compactor",
      "/compacting now",
      "/new",
      "/home/me/compact.ts",
      "compact",
      "",
      "   ",
    ]) {
      expect(isCompactCommand(text), text).toBe(false);
    }
  });
});

describe("cliCompactionToast — the claude-code lane's result, from the CLI's own `end` (A3)", () => {
  it("an exact end: CLI compacted, before → after", () => {
    expect(cliCompactionToast(cliEnd())).toEqual({
      text: "CLI compacted: 971,000 → 12,400 tokens",
      isError: false,
    });
  });

  it("a boundary with no post_tokens shows the before alone; with neither, no figure", () => {
    const noAfter = cliEnd({ tokensAfter: undefined });
    expect(cliCompactionToast(noAfter)?.text).toBe("CLI compacted: from 971,000 tokens");
    const bare = cliEnd({ tokensBefore: undefined, tokensAfter: undefined });
    expect(cliCompactionToast(bare)?.text).toBe("CLI compacted — no token figures reported");
  });

  it("figures that are not the CLI's exact ones are not shown", () => {
    const estimated = cliEnd({ provenance: "estimated" });
    expect(cliCompactionToast(estimated)?.text).toBe("CLI compacted — no token figures reported");
  });

  it("a failed CLI compaction (A3's compact_result failed) is an error toast", () => {
    const failed = cliEnd({ completed: false, tokensBefore: undefined, tokensAfter: undefined });
    expect(cliCompactionToast(failed)).toEqual({
      text: "CLI compaction failed: the CLI gave it up and wrote no compaction boundary",
      isError: true,
    });
  });

  it("nothing else toasts: a start, another executor's end, a non-boolean completed, junk", () => {
    for (const data of [
      { phase: "start", trigger: "cli-internal", lane: "cc-bridge", provenance: "exact" },
      cliEnd({ trigger: "manual" }),
      cliEnd({ trigger: "pi-auto" }),
      cliEnd({ completed: "yes" }),
      undefined,
      null,
      "end",
      7,
    ]) {
      expect(cliCompactionToast(data)).toBeNull();
    }
  });
});

describe("A6 x B3 — a CLI COMPACT press has no reply half, so the counters wait for none", () => {
  it("the CLI's exact `end` sizes the drop at once and leaves nothing pending", () => {
    // No sessions.compact reply ever comes on this route. The `end`'s A1 trigger, "cli-internal",
    // is not a press trigger (context-counters.ts rule 4), so it is folded in whole on arrival.
    const s = reduceCounters(EMPTY_COUNTERS, { kind: "compaction", data: CLI_END, at: 1_000 });
    expect(s.pending).toBeUndefined();
    expect(s).toMatchObject({
      dropsWatched: 1,
      droppedWatched: 958_600,
      lastDropped: 958_600,
      lastDroppedProvenance: "exact",
    });
  });
});

describe("app.ts wires the CLI route (source check; CONTROL: fails on the parent commit)", () => {
  // Resolved from the run root, NOT from import.meta.url: under jsdom that is an http:// URL.
  const srcRoot = ["tinker-ui/src", "src"]
    .map((p) => join(process.cwd(), p))
    .find((p) => existsSync(join(p, "app.ts")));
  const raw = srcRoot ? readFileSync(join(srcRoot, "app.ts"), "utf8") : "";
  // Line comments stripped, so a comment can neither satisfy nor break an assertion.
  const app = raw.replace(/\/\/.*$/gm, "");
  const slice = (from: string, to: string): string => {
    const i = app.indexOf(from);
    return i < 0 ? "" : app.slice(i, app.indexOf(to, i));
  };

  it("finds app.ts", () => {
    expect(srcRoot, `app.ts not found from ${process.cwd()}`).toBeTruthy();
  });

  it("a CLI-route COMPACT press sends exactly CLI_COMPACT_COMMAND via send(), before any RPC", () => {
    const h = slice('closest?.("[data-cache-act]")', "\n});");
    const route = h.indexOf('if (cacheActRoute(act, viewedNextCallProvider()) === "cli-turn") {');
    const sent = h.indexOf(
      "void send(CLI_COMPACT_COMMAND, undefined, undefined, true);\n    return;",
    );
    const rpc = h.indexOf('req("sessions.compact"');
    expect(route).toBeGreaterThan(-1);
    expect(sent).toBeGreaterThan(route);
    expect(rpc).toBeGreaterThan(sent);
  });

  it("buildInjectedPrompt sends /compact bare and trimmed, before any suffix can be appended", () => {
    const body = slice("async function buildInjectedPrompt(", "\n}\n");
    const trimmed = body.indexOf("const trimmed = userText.trim();");
    const bare = body.indexOf("if (isCompactCommand(userText)) {\n    return trimmed;\n  }");
    expect(trimmed).toBeGreaterThan(-1);
    expect(bare).toBeGreaterThan(trimmed);
    expect(body.indexOf("FRACTAL_DOCTRINE")).toBeGreaterThan(bare);
  });

  it("the button's send leaves the composer draft alone", () => {
    expect(app).toMatch(/async function send\([^)]*keepDraft = false,?\s*\)/);
    expect(app).toContain("if (draftTabId && !resendOf && !keepDraft) {");
  });

  it("the viewed session's compaction `end` toasts through cliCompactionToast", () => {
    const block = slice('p?.stream === "compaction" && sessionKeyMatches(p.sessionKey)', "return;");
    expect(block).toContain("const cliToast = cliCompactionToast(p.data);");
    expect(block).toContain("showToast(cliToast.text, cliToast.isError);");
  });
});
