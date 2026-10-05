// The shape of the board THALAMUS routes over (rungs, supplies, windows, dial). Types only.
//
// The live reader is `src/infra/thalamus-board.ts`; the shadow router in the extension needs only this shape, so it can
// take a fake board in a test and does not import the gateway to name a type.

import type { FrontierRung, RouteSuggestion } from "./thalamus-frontier.js";
import type { SupplyId, SupplyState } from "./thalamus-supply.js";

export type ThalamusBoardLike = {
  rungs: FrontierRung[];
  supplies: Map<SupplyId, SupplyState>;
  contextWindowFor: (key: string) => number | undefined;
  /** The dial, 0 (budget) to 6 (smart). */
  dialIdx: number;
  /** The architect's suggestion for the dial's stop (model, effort), key normalised like the rungs'. Absent when unset. */
  suggestion?: RouteSuggestion;
  /** Supplies cooling after a limit (the cooling store), and when each reopens. Absent when none. */
  cooling?: ReadonlySet<SupplyId>;
  coolingUntil?: ReadonlyMap<SupplyId, number>;
  builtAtMs: number;
};
