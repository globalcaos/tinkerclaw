import { afterEach, describe, expect, test } from "vitest";
import { resetConfigRuntimeState } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { buildGatewaySessionRow } from "./session-utils.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

/**
 * FORK 2026-08-29 — the DURABLE PIN is published separately from the RUNTIME pair.
 *
 * `model`/`modelProvider` mean "what SERVED" (pin ?? last-served). A client reading them as a
 * pin cannot tell "pinned to Opus" from "on Auto, happened to run on Opus" — which is why the
 * Auto button lit up Opus. `modelOverride`/`providerOverride`/`modelOverrideSource` answer that
 * question by PRESENCE.
 */

const PIN_PROVIDER = "anthropic";
const PIN_MODEL = "claude-opus-4-1";

function createCfg(): OpenClawConfig {
  return {
    agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-5" } } },
  } as OpenClawConfig;
}

function buildRow(entry?: SessionEntry): GatewaySessionRow {
  return buildGatewaySessionRow({
    cfg: createCfg(),
    storePath: "",
    store: {},
    key: "main",
    entry,
  });
}

/** A session PINNED by the user to PIN_PROVIDER/PIN_MODEL. */
function pinnedEntry(): SessionEntry {
  return {
    modelOverride: PIN_MODEL,
    providerOverride: PIN_PROVIDER,
    modelOverrideSource: "user",
  } as SessionEntry;
}

/** A session on AUTO whose last run merely happened to be served by the same model. */
function autoEntry(): SessionEntry {
  return {
    modelProvider: PIN_PROVIDER,
    model: PIN_MODEL,
  } as SessionEntry;
}

describe("gateway session row publishes the durable model pin", () => {
  afterEach(() => {
    resetConfigRuntimeState();
    resetPluginRuntimeStateForTest();
  });

  test("a pinned entry publishes all three new fields and leaves the runtime pair unchanged", () => {
    const row = buildRow(pinnedEntry());

    expect(row.modelOverride).toBe(PIN_MODEL);
    expect(row.providerOverride).toBe(PIN_PROVIDER);
    expect(row.modelOverrideSource).toBe("user");

    // Unchanged meaning: the pair is still `pin ?? last-served`, so with a pin it reports the pin.
    expect(row.modelProvider).toBe(PIN_PROVIDER);
    expect(row.model).toBe(PIN_MODEL);
  });

  test("an entry without a pin publishes the new fields as undefined and still reports the runtime model", () => {
    const row = buildRow(autoEntry());

    expect(row.modelOverride).toBeUndefined();
    expect(row.providerOverride).toBeUndefined();
    expect(row.modelOverrideSource).toBeUndefined();

    expect(row.modelProvider).toBe(PIN_PROVIDER);
    expect(row.model).toBe(PIN_MODEL);
  });

  test("CONTROL: the runtime pair cannot tell Auto from pinned — the new fields can", () => {
    const pinned = buildRow(pinnedEntry());
    const auto = buildRow(autoEntry());

    // CONTROL — the OLD signal fails: one session is pinned, the other is on Auto, and the only
    // fields a client had at HEAD are byte-identical for both.
    expect({ provider: auto.modelProvider, model: auto.model }).toEqual({
      provider: pinned.modelProvider,
      model: pinned.model,
    });

    // The NEW signal succeeds, by PRESENCE rather than value.
    expect(pinned.modelOverride).toBeDefined();
    expect(pinned.providerOverride).toBeDefined();
    expect(auto.modelOverride).toBeUndefined();
    expect(auto.providerOverride).toBeUndefined();
  });

  test("the three `?? providerOverride` reads in tinker-ui/src/app.ts stay inert", () => {
    // app.ts (~:727, ~:26622, ~:26732) evaluates `modelProvider ?? providerOverride`. Adding
    // `providerOverride` to the row must not change what those expressions produce. It cannot:
    // row.modelProvider is `selectedModel?.provider ?? modelProvider` and the new field is
    // `selectedModel?.provider`, so the new field is non-undefined only when the pair already is.
    for (const row of [buildRow(pinnedEntry()), buildRow(autoEntry()), buildRow(undefined)]) {
      expect(row.modelProvider ?? row.providerOverride).toBe(row.modelProvider);
    }

    // CONTROL — the assertion above is not vacuous. A row that published the pin WITHOUT the
    // pair would make those reads live, and this is what that looks like.
    const decoupled = { ...buildRow(pinnedEntry()), modelProvider: undefined } as GatewaySessionRow;
    expect(decoupled.modelProvider ?? decoupled.providerOverride).toBe(PIN_PROVIDER);
    expect(decoupled.modelProvider ?? decoupled.providerOverride).not.toBe(decoupled.modelProvider);
  });
});
