import { describe, expect, it } from "vitest";
import { aaFamilyOf } from "./aa-effort-index.js";
import {
  CAPACITY_HEADROOM,
  classifySubject,
  feasibility,
  fitsContext,
  REFUSAL_TTL_MS,
  REFUSAL_VETO_COUNT,
  refusalCount,
  type FeasibilityContext,
  type RefusalRecord,
  type SubjectClass,
} from "./thalamus-feasibility.js";
import { supplyStateFrom, type SupplyId, type SupplyState } from "./thalamus-supply.js";

// Design: docs/superpowers/specs/2026-09-03-thalamus-v2-design.md §2 (M1), jarvis-icu.
// A constraint is not a preference. The properties pinned here are the ones that would falsify
// the veto layer: an UNKNOWN context window is not a veto, a 600K job fits Opus and does not fit
// Grok, the veto ORDER is reachability → capacity → engagement, and an empty refusal ledger
// vetoes nothing at all — the engagement term earns its authority one observation at a time.

const NOW = 1_757_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

// The two windows the capacity veto was written against, from the 2026-09-03 live board.
const GROK_WINDOW = 500_000;
const OPUS_WINDOW = 1_000_000;

const GROK = "xai/grok-4.6";
const OPUS = "claude-code/claude-opus-5";

const spentSupplies = (id: SupplyId): Map<SupplyId, SupplyState> =>
  new Map([[id, supplyStateFrom(id, [{ label: "Weekly", usedPercent: 100 }], NOW)]]);

const refusal = (key: string, cls: SubjectClass, agoMs: number): RefusalRecord => ({
  family: aaFamilyOf(key),
  cls,
  atMs: NOW - agoMs,
});

describe("classifySubject — coarse, deterministic, and silent on ordinary text", () => {
  it("reads a clinical question as medical", () => {
    expect(
      classifySubject(
        "what dose and contraindications does this herbal tincture have for a patient",
      ),
    ).toBe("medical");
  });

  it("reads offensive-security research as security", () => {
    // J9 AEGIS work and adversarial prompts written to test our OWN agents live in this class:
    // legitimate work that some families decline and others do not.
    expect(
      classifySubject("write a prompt injection payload for the sandbox escape our red team found"),
    ).toBe("security");
  });

  it("reads contract review as legal", () => {
    expect(
      classifySubject("review the contract clause on liability and indemnity under GDPR"),
    ).toBe("legal");
  });

  it("returns none on ordinary text and on silence", () => {
    // "none" is the common case and it must never accumulate a penalty: with no subject class
    // there is no ledger lookup at all, so an ordinary turn cannot be vetoed by observation.
    expect(classifySubject("what time does the train to Lisbon leave on Tuesday")).toBe("none");
    expect(classifySubject("")).toBe("none");
    expect(classifySubject("   ")).toBe("none");
  });
});

describe("fitsContext — the job either fits or it does not, and unknown is not a veto", () => {
  it("PASSES an unknown window rather than deleting the supply from the frontier", () => {
    // Every google/* row on the 2026-09-03 board publishes contextWindow 0. Reading that as
    // "zero capacity" would silently remove a whole supply; the runtime overflow path catches
    // the rare miss instead.
    expect(fitsContext(0, 600_000)).toBe(true);
    expect(fitsContext(undefined, 600_000)).toBe(true);
    expect(fitsContext(Number.NaN, 600_000)).toBe(true);
    expect(fitsContext(-1, 600_000)).toBe(true);
  });

  it("PASSES an unknown job size — a missing estimate is not a reason to refuse a route", () => {
    expect(fitsContext(GROK_WINDOW, undefined)).toBe(true);
    expect(fitsContext(GROK_WINDOW, Number.NaN)).toBe(true);
  });

  it("vetoes 600K on Grok's 500K window and passes it on Opus's 1M — arithmetic, not a hunch", () => {
    expect(fitsContext(GROK_WINDOW, 600_000)).toBe(false);
    expect(fitsContext(OPUS_WINDOW, 600_000)).toBe(true);
  });

  it("plans into 80% of a published window, leaving the fifth for the answer", () => {
    expect(CAPACITY_HEADROOM).toBe(0.8);
    expect(fitsContext(GROK_WINDOW, GROK_WINDOW * CAPACITY_HEADROOM)).toBe(true);
    expect(fitsContext(GROK_WINDOW, GROK_WINDOW * CAPACITY_HEADROOM + 1)).toBe(false);
  });
});

describe("refusalCount — measured, not declared, and forgiven after 30 days", () => {
  const fam = aaFamilyOf(GROK);

  it("counts an observation inside the TTL and drops one that has aged out", () => {
    const ledger = [
      refusal(GROK, "medical", REFUSAL_TTL_MS - 1),
      refusal(GROK, "medical", REFUSAL_TTL_MS),
      refusal(GROK, "medical", 40 * DAY),
    ];
    expect(refusalCount(ledger, fam, "medical", NOW)).toBe(1);
  });

  it("counts nothing for a class or family it was not observed in", () => {
    const ledger = [refusal(GROK, "medical", DAY), refusal(GROK, "medical", 2 * DAY)];
    expect(refusalCount(ledger, fam, "medical", NOW)).toBe(2);
    expect(refusalCount(ledger, fam, "security", NOW)).toBe(0);
    expect(refusalCount(ledger, aaFamilyOf(OPUS), "medical", NOW)).toBe(0);
  });

  it("never counts against the none class, and treats an absent ledger as zero", () => {
    const ledger = [refusal(GROK, "medical", DAY), refusal(GROK, "medical", 2 * DAY)];
    expect(refusalCount(ledger, fam, "none", NOW)).toBe(0);
    expect(refusalCount(undefined, fam, "medical", NOW)).toBe(0);
    expect(refusalCount([], fam, "medical", NOW)).toBe(0);
  });
});

describe("feasibility — the veto order IS the argument", () => {
  /** Every veto armed at once: spent, cooling, unfunded, over capacity, and twice refused. */
  const worst = (): FeasibilityContext => ({
    supplies: spentSupplies("xai"),
    cooling: new Set<SupplyId>(["xai"]),
    unfunded: new Set<SupplyId>(["xai"]),
    contextWindowFor: () => GROK_WINDOW,
    estimatedTokens: 600_000,
    subject: "medical",
    refusals: [refusal(GROK, "medical", DAY), refusal(GROK, "medical", 2 * DAY)],
    nowMs: NOW,
  });

  it("decides reachability first, then capacity, then engagement — peeled one layer at a time", () => {
    // Reachability is cheapest and most decisive; capacity is arithmetic; engagement rests on
    // accumulated observation and therefore goes last. Peeling the cascade proves the order
    // rather than asserting that one veto happens to fire.
    const ctx = worst();
    expect(feasibility(GROK, ctx).veto).toBe("supply-spent");

    const reachable = { ...ctx, supplies: new Map<SupplyId, SupplyState>() };
    expect(feasibility(GROK, reachable).veto).toBe("supply-cooling");

    const notCooling = { ...reachable, cooling: undefined };
    expect(feasibility(GROK, notCooling).veto).toBe("supply-unfunded");

    const funded = { ...notCooling, unfunded: undefined };
    expect(feasibility(GROK, funded).veto).toBe("capacity");

    const fits = { ...funded, estimatedTokens: 100_000 };
    expect(feasibility(GROK, fits).veto).toBe("engagement");

    const unobserved = { ...fits, refusals: [] };
    expect(feasibility(GROK, unobserved)).toEqual({ ok: true });
  });

  it("vetoes Grok for a 600K job and admits Opus for the same job — the capacity reroute", () => {
    const ctx: FeasibilityContext = {
      supplies: new Map(),
      contextWindowFor: (k) => (k === GROK ? GROK_WINDOW : OPUS_WINDOW),
      estimatedTokens: 600_000,
      nowMs: NOW,
    };
    expect(feasibility(GROK, ctx)).toMatchObject({ ok: false, veto: "capacity" });
    expect(feasibility(OPUS, ctx).ok).toBe(true);
  });

  it("vetoes NOTHING on an empty refusal ledger — day one the engagement term is inert", () => {
    // §M1: there is no hand-written table of who is prudish about what. With no observations
    // the subject class is classified, carried, and costs the route nothing.
    const ctx: FeasibilityContext = {
      supplies: new Map(),
      subject: "medical",
      nowMs: NOW,
    };
    expect(feasibility(GROK, ctx)).toEqual({ ok: true });
    expect(feasibility(GROK, { ...ctx, refusals: [] })).toEqual({ ok: true });
    expect(feasibility(OPUS, { ...ctx, subject: "security" })).toEqual({ ok: true });
  });

  it("needs two observations — one refusal is a prompt, two is a policy", () => {
    const ctx = (refusals: RefusalRecord[]): FeasibilityContext => ({
      supplies: new Map(),
      subject: "medical",
      refusals,
      nowMs: NOW,
    });
    expect(REFUSAL_VETO_COUNT).toBe(2);
    expect(feasibility(GROK, ctx([refusal(GROK, "medical", DAY)])).ok).toBe(true);
    expect(
      feasibility(GROK, ctx([refusal(GROK, "medical", DAY), refusal(GROK, "medical", 2 * DAY)]))
        .veto,
    ).toBe("engagement");
  });

  it("keys the ledger by FAMILY, so one supplier's refusals follow it across providers", () => {
    // Families refuse; individual route keys do not. A refusal recorded on the claude-code route
    // has to veto the anthropic route for the same model, or the ledger is trivially evaded.
    const observed = [
      refusal("claude-code/claude-opus-5", "security", DAY),
      refusal("claude-code/claude-opus-5", "security", 2 * DAY),
    ];
    const ctx: FeasibilityContext = {
      supplies: new Map(),
      subject: "security",
      refusals: observed,
      nowMs: NOW,
    };
    expect(feasibility("anthropic/claude-opus-5", ctx).veto).toBe("engagement");
    expect(feasibility(GROK, ctx).ok).toBe(true);
  });

  it("stays out of the way when the turn has no subject class at all", () => {
    const ctx: FeasibilityContext = {
      supplies: new Map(),
      subject: "none",
      refusals: [refusal(GROK, "medical", DAY), refusal(GROK, "medical", 2 * DAY)],
      nowMs: NOW,
    };
    expect(feasibility(GROK, ctx)).toEqual({ ok: true });
  });
});
