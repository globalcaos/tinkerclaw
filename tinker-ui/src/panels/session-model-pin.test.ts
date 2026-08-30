import { describe, expect, it } from "vitest";
import { serverPinOf, servedLabelIdOf, type PinRow } from "./session-model-pin.js";

/** A row that has ANSWERED (so `model` is populated) but carries NO durable pin. */
const SERVED_UNPINNED: PinRow = { model: "claude-opus-5", modelProvider: "anthropic" };

describe("serverPinOf", () => {
  it("qualifies a bare pin with its providerOverride", () => {
    const row: PinRow = { modelOverride: "grok-4.6", providerOverride: "xai" };
    expect(serverPinOf(row, false)).toEqual({ id: "xai/grok-4.6", provider: "xai" });
  });

  // THE REGRESSION CASE — the whole reason this module exists. `model` is the LAST-SERVED model,
  // not a pin: both call sites read it as one, so a tab that had merely answered once rendered as
  // pinned and Auto could not clear it. A populated `model` with no override must read as Auto.
  it("returns the Auto answer when there is no pin, even though `model` is populated", () => {
    expect(serverPinOf(SERVED_UNPINNED, false)).toEqual({ id: "", provider: undefined });
  });

  // CONTROL for the regression above: the OLD derivation, `pinnedModel ?? row.model`, applied to
  // the very same row. It really does report a pin on an unpinned session — which is the failure
  // the assertion above is worth anything against.
  it("CONTROL — the old `?? row.model` derivation reports a pin on this same unpinned row", () => {
    const oldDerivation = (row: PinRow) => row.modelOverride ?? row.model ?? "";
    expect(oldDerivation(SERVED_UNPINNED)).toBe("claude-opus-5");
    expect(serverPinOf(SERVED_UNPINNED, false).id).toBe("");
  });

  it("treats an absent row and a blank override alike as Auto", () => {
    expect(serverPinOf(undefined, false)).toEqual({ id: "", provider: undefined });
    const blank: PinRow = { model: "claude-opus-5", modelOverride: "   " };
    expect(serverPinOf(blank, false)).toEqual({ id: "", provider: undefined });
  });

  // THE OPTIMISTIC-CLEAR CASE: Auto was just pressed, `sessions.patch` has not round-tripped, so
  // the row still carries the old override. The assertion wins, or the picker springs back.
  it("returns the Auto answer when autoAsserted, with a stale pin still on the row", () => {
    const stale: PinRow = {
      model: "grok-4.6",
      modelProvider: "xai",
      modelOverride: "grok-4.6",
      providerOverride: "xai",
    };
    expect(serverPinOf(stale, true)).toEqual({ id: "", provider: undefined });
  });

  it("leaves a pin that already carries its provider unchanged", () => {
    const row: PinRow = { modelOverride: "xai/grok-4.6", providerOverride: "xai" };
    expect(serverPinOf(row, false)).toEqual({ id: "xai/grok-4.6", provider: "xai" });
  });

  it("keeps a pin bare when no providerOverride can qualify it", () => {
    expect(serverPinOf({ modelOverride: "claude-fable-5" }, false)).toEqual({
      id: "claude-fable-5",
      provider: undefined,
    });
    // Nothing to attach: hand the raw id through and let the bare-tail fallback match it.
    expect(serverPinOf({ modelOverride: "xai/grok-4.6" }, false)).toEqual({
      id: "xai/grok-4.6",
      provider: undefined,
    });
  });

  // NOT `pin.includes("/")`. parseModelRef splits a ref at the FIRST slash, so the catalog id
  // `openrouter/qwen/qwen3.8-max` is stored as providerOverride `openrouter` + modelOverride
  // `qwen/qwen3.8-max` — a bare model name that CONTAINS a slash. Short-circuiting on the slash
  // yields an id no stop carries: this module's own bug, on the architect's live openrouter pins.
  it("qualifies a multi-segment bare model whose provider is not its first segment", () => {
    const row: PinRow = { modelOverride: "qwen/qwen3.8-max", providerOverride: "openrouter" };
    expect(serverPinOf(row, false)).toEqual({
      id: "openrouter/qwen/qwen3.8-max",
      provider: "openrouter",
    });
  });
});

describe("servedLabelIdOf", () => {
  it("qualifies the served model with its provider", () => {
    expect(servedLabelIdOf(SERVED_UNPINNED)).toBe("anthropic/claude-opus-5");
  });

  it("returns the bare model when no provider came with it", () => {
    expect(servedLabelIdOf({ model: "claude-opus-5" })).toBe("claude-opus-5");
  });

  it("returns the empty string when nothing has served yet", () => {
    expect(servedLabelIdOf(undefined)).toBe("");
    expect(servedLabelIdOf({})).toBe("");
    expect(servedLabelIdOf({ modelProvider: "anthropic" })).toBe("");
  });

  // The mirror of the regression: the annotation must not INVENT a served model out of the pin.
  it("ignores the pin fields entirely", () => {
    const pinnedNeverRan: PinRow = { modelOverride: "grok-4.6", providerOverride: "xai" };
    expect(servedLabelIdOf(pinnedNeverRan)).toBe("");
  });

  // Both facts on one row, reported distinctly: a fallback served Opus while xai/grok is pinned.
  it("reports the served model independently of the pin", () => {
    const row: PinRow = {
      model: "claude-opus-5",
      modelProvider: "claude-code",
      modelOverride: "grok-4.6",
      providerOverride: "xai",
    };
    expect(serverPinOf(row, false).id).toBe("xai/grok-4.6");
    expect(servedLabelIdOf(row)).toBe("claude-code/claude-opus-5");
  });
});
