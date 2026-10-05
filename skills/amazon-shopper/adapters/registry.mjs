// registry.mjs — map a store name → adapter instance.
//
// The orchestrator resolves `--store <name>` through here. There is exactly one
// store: amazon.
//
// SCOPE, ENFORCED BY ABSENCE: this skill presents itself as an amazon.es shopping
// tool. Earlier versions also shipped classifieds adapters (Milanuncios, Wallapop)
// behind an AMAZON_SHOPPER_ENABLE_OTHER_STORES=1 gate, which meant the published
// package still carried scrapers for sites its own description never named — an
// env var away from running. Since 1.2.1 that code is not in the package at all,
// so there is no flag, no env var and no argument that reaches another site.
// Removed capability beats disabled capability.

import { AmazonAdapter } from "./AmazonAdapter.mjs";

export const DEFAULT_STORE = "amazon";

// name → factory (lazy instance, one per resolve call).
const FACTORIES = Object.freeze({
  amazon: () => new AmazonAdapter(),
});

export function knownStores() {
  return Object.keys(FACTORIES);
}

export function isKnownStore(name) {
  return Object.prototype.hasOwnProperty.call(FACTORIES, String(name).toLowerCase());
}

// Resolve a store name to a fresh adapter instance. Throws a clear error for
// an unknown store so the CLI can surface it.
export function resolveAdapter(name = DEFAULT_STORE) {
  const key = String(name || DEFAULT_STORE).toLowerCase();
  const factory = FACTORIES[key];
  if (!factory) {
    throw new Error(
      `unknown store "${name}" (this skill searches amazon.es only; known: ${knownStores().join(", ")})`,
    );
  }
  return factory();
}

export default resolveAdapter;
