// registry.mjs — map a store name → adapter instance.
//
// The orchestrator resolves `--store <name>` through here. Default store is
// "amazon".
//
// SCOPE GATE: this skill presents itself as an amazon.es shopping tool, and the
// non-Amazon adapters scrape sites the description never names. Shipping them
// enabled means the skill quietly does more than it says, so since 1.2.0 they are
// refused unless AMAZON_SHOPPER_ENABLE_OTHER_STORES=1 is set. The Amazon adapter
// is unaffected.

import { AmazonAdapter } from "./AmazonAdapter.mjs";
import { MilanunciosAdapter } from "./MilanunciosAdapter.mjs";
import { WallapopAdapter } from "./WallapopAdapter.mjs";

export const DEFAULT_STORE = "amazon";

// Stores outside the skill's declared amazon.es scope.
const OPT_IN_STORES = new Set(["milanuncios", "wallapop"]);

export function otherStoresEnabled() {
  return process.env.AMAZON_SHOPPER_ENABLE_OTHER_STORES === "1";
}

// name → factory (lazy instance, one per resolve call).
const FACTORIES = Object.freeze({
  amazon: () => new AmazonAdapter(),
  milanuncios: () => new MilanunciosAdapter(),
  wallapop: () => new WallapopAdapter(),
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
    throw new Error(`unknown store "${name}" (known: ${knownStores().join(", ")})`);
  }
  if (OPT_IN_STORES.has(key) && !otherStoresEnabled()) {
    throw new Error(
      `store "${key}" is outside this skill's declared amazon.es scope and is disabled by default. ` +
        "It scrapes a classifieds site and returns listings with different availability and seller " +
        "semantics. Set AMAZON_SHOPPER_ENABLE_OTHER_STORES=1 to enable it.",
    );
  }
  return factory();
}

export default resolveAdapter;
