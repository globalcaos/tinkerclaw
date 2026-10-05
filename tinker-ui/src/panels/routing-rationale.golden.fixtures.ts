// Signal sets for the "off means absent" proof of THALAMUS v4's panel block (charter phase G).
//
// WHAT THIS IS FOR. The same fixtures are rendered by DEVELOP's routing card (before the v4 block existed) and by this
// branch's. `routing-rationale.develop-golden.json` holds develop's output for each; the test in
// `thalamus-v4-golden.test.ts` requires this branch to reproduce it byte for byte when no v4 data is supplied. That is
// stronger than a snapshot of today's code: it records what the card did before this change.
//
// HOW THE JSON WAS MADE. In a scratch worktree at develop, `dumpGolden()` was run over these fixtures (see the test file).
// WHAT WOULD CHANGE IT. A deliberate change to the card: regenerate from the new develop, never from this branch.
import type { SupplyState } from "../../../src/shared/thalamus-supply.js";
import type { RoutingSignals, ThalamusPlanView } from "./routing-rationale.js";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const base: RoutingSignals = {
  modelLabel: "Opus 5",
  modelPinned: false,
  effortLabel: "Auto",
  effortPinned: false,
  nowMs: NOW,
  parallelCap: 6,
  cores: 8,
};
const WEEK = {
  label: "7-day",
  used: 0.71,
  resetAtMs: NOW + 4 * HOUR,
  lengthMs: 7 * 24 * HOUR,
  elapsed: 0.5,
  pace: 0.21,
};
const supply = (over: Partial<SupplyState> = {}): SupplyState => ({
  id: "anthropic",
  kind: "subscription",
  windows: [{ ...WEEK }],
  spent: false,
  binding: { ...WEEK },
  shadow: 0.21,
  ballistic: false,
  resetAtMs: NOW + 4 * HOUR,
  ...over,
});
const plan = (over: Partial<ThalamusPlanView> = {}): ThalamusPlanView => ({
  primary: "anthropic/claude-opus-5",
  effort: "high",
  mode: "solo",
  panel: [],
  chain: ["xai/grok-4", "openai/gpt-5"],
  ballistic: false,
  vetoes: [],
  domain: "code",
  subject: "none",
  reason: "opus 5 · balanced anchor",
  ...over,
});

export const GOLDEN_FIXTURES: Record<string, RoutingSignals> = {
  bare: base,
  pinned: { ...base, modelPinned: true, effortPinned: true, effortLabel: "high" },
  dial: {
    ...base,
    biasIdx: 5,
    policyPath: "/x/orca-policy.md",
    util7d: 0.42,
    weeklyResetAt: NOW + 3 * 24 * HOUR,
  },
  fanOut: {
    ...base,
    routes: [
      {
        unit: "u1",
        task: "read the contract",
        mode: "solo",
        model: "Haiku 4.5",
        domain: "write",
        why: "cheapest that clears the bar",
      },
      {
        unit: "u2",
        mode: "debate",
        model: "Opus 5",
        panel: ["Opus 5", "Grok 4.7"],
        domain: "reason",
      },
      { unit: "u3", mode: "build-debug", model: "Sonnet 5.5", critic: "Grok 4.7", domain: "code" },
    ],
  },
  frontier: {
    ...base,
    frontierPick: { model: "Sonnet 5.5", effort: "medium", smart: 64, cost: 2.1, frontierSize: 5 },
  },
  v2Supplies: { ...base, supplies: [supply(), supply({ id: "xai", spent: true, shadow: 1 })] },
  v2Plan: {
    ...base,
    supplies: [supply({ ballistic: true })],
    thalamusPlan: plan({
      mode: "debate",
      panel: ["anthropic/claude-opus-5", "xai/grok-4"],
      chair: "anthropic/claude-opus-5",
      ballistic: true,
      reservedReason: "ballistic",
      vetoes: [{ key: "openai/gpt-5", veto: "supply-spent", detail: "weekly window used up" }],
    }),
  },
  v2EmptyChain: { ...base, thalamusPlan: plan({ chain: [] }) },
};
