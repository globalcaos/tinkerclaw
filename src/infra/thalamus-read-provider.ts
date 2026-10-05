// The seam between THALAMUS v4 and the amygdala's per-step Jev call (design doc section 10, "how it merges").
//
// WHAT THIS IS FOR. When both run, the step read rides on the amygdala's own call: one HTTP request carries the
// guard's questions and the routing questions (paper P§4 "one call, two jobs"). An extension cannot import
// another extension, so the amygdala's small `routing` family asks whatever provider Thalamus registered here.
// With no provider registered, the family asks nothing and the amygdala behaves exactly as before.
//
// The registration lives on `globalThis` under a Symbol.for key, so the amygdala and Thalamus agree on it even
// when the bundler gives each of them its own copy of this module.

import type { JevQuestion, JevVerdict } from "./jev/types.js";

export type RoutingSeam = "prompt" | "pre-tool" | "post-tool" | "stop";

/** The parts of the amygdala's situation a provider may read. The request text is the routing input. */
export type RoutingSituationView = {
  id: string;
  sessionKey: string;
  turnId: string;
  originKind: "real" | "synthetic";
  request?: string;
  tool?: string;
};

/** A question plus the two labels the amygdala's book shows. */
export type ProviderQuestion = JevQuestion & { name: string; purpose: string };

export interface RoutingReadProvider {
  /** Extra questions for this seam of the amygdala's call. Quick, and never throws. */
  questionsFor(seam: RoutingSeam, situation: RoutingSituationView): ProviderQuestion[];
  /** The verdicts of those questions from the same call. Never throws. */
  observe(seam: RoutingSeam, situation: RoutingSituationView, verdicts: JevVerdict[]): void;
}

const KEY = Symbol.for("openclaw.thalamus.routingReadProvider");
type Slot = { [KEY]?: RoutingReadProvider };

/** Register a provider; the returned function removes it (and only it). */
export function setRoutingReadProvider(p: RoutingReadProvider): () => void {
  (globalThis as Slot)[KEY] = p;
  return () => {
    if ((globalThis as Slot)[KEY] === p) delete (globalThis as Slot)[KEY];
  };
}

export function getRoutingReadProvider(): RoutingReadProvider | undefined {
  return (globalThis as Slot)[KEY];
}
