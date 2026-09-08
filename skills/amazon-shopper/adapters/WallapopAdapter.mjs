// WallapopAdapter.mjs — Wallapop (Spain second-hand) store adapter — STUB.
//
// Wallapop's public search edge (api.wallapop.com) is 403-gated for plain HTTP
// from this gateway IP (the marketplace-watcher cron hit the same wall and had
// to drive it through the browser-relay CDP path). Until a browser-relay search
// path exists, this adapter is a documented placeholder: `search` returns a
// clear BLOCKED result that names the unblock path, and `detailFetch` returns
// null. We deliberately do NOT implement scraping here.
//
// When unblocked (Phase 1+), `search` should drive the shared browser-relay
// (gateway WS `browser.request`) to load the search page / API and then call
// `extract()` on the response, normalizing to the shared Listing schema
// (scripts/store.mjs:27-58).

import { StoreAdapter } from "./StoreAdapter.mjs";

const BLOCKED_REASON =
  "wallapop HTTP search is 403-gated; needs browser-relay (gateway WS browser.request) — not implemented in Phase 0";

export class WallapopAdapter extends StoreAdapter {
  get name() {
    return "wallapop";
  }

  // REQUIRED. Stub: always BLOCKED, naming the unblock path. No products.
  async search(_keywords, _opts = {}) {
    return { outcome: "BLOCKED", reason: BLOCKED_REASON, products: [] };
  }

  // REQUIRED. Stub: cannot parse without a browser-relay response. Throws so a
  // future caller that wires this up by mistake fails loudly rather than
  // silently returning garbage.
  extract(_raw, _context) {
    throw new Error(`WallapopAdapter.extract() not implemented — ${BLOCKED_REASON}`);
  }

  // Optional. No detail without a browser-relay path. Documented null.
  async detailFetch(_productId, _opts) {
    return null;
  }
}

export default WallapopAdapter;
