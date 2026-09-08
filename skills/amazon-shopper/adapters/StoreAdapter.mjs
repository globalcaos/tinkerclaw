// StoreAdapter.mjs — base class for store adapters.
//
// A store adapter turns a per-store source (HTML / JSON / API) into the
// normalized `Listing[]` the shared core expects. The shared `Listing` schema
// is the `products` table in scripts/store.mjs:27-58 — the fields the
// orchestrator passes to `store.insertProducts`:
//   { asin, position, title, url, image_url, current_price_eur,
//     list_price_eur, rating, review_count, is_prime, is_best_seller,
//     seller_name, seller_is_amazon, in_stock }
// `asin` is the store-agnostic stable product id (Amazon ASIN, milanuncios id,
// etc.) — it must be unique within a result set (UNIQUE constraint on the
// column).
//
// Contract (mirrors the plan's adapter contract):
//   async search(keywords, opts)   REQUIRED → Listing[]
//   extract(raw, context)          REQUIRED → Listing[]   (HTML/JSON → normalized)
//   async detailFetch(productId)   optional → DetailSpec | null
//   rankMode(products, opts)       optional → custom metric or null (rank.mjs default)
//   classifyResponse({status,body})optional → { outcome:"OK"|"BLOCKED", reason? }
//
// The base class throws for the two REQUIRED methods so a subclass that forgets
// to implement them fails loudly. The three optional methods have safe defaults
// (detailFetch → null, rankMode → null, classifyResponse → OK) so the
// orchestrator can call them unconditionally.

export class StoreAdapter {
  // Stable lowercase store name; subclasses override.
  get name() {
    throw new Error(`${this.constructor.name}: 'name' getter not implemented`);
  }

  // REQUIRED. Run a keyword search and return normalized Listing[].
  // Implementations typically fetch then call this.extract(raw, context).
  async search(_keywords, _opts) {
    throw new Error(`${this.constructor.name}.search() not implemented`);
  }

  // REQUIRED. Parse a raw response (HTML string / parsed JSON) into Listing[].
  extract(_raw, _context) {
    throw new Error(`${this.constructor.name}.extract() not implemented`);
  }

  // Optional. Fetch a per-product detail spec. Default: no detail available.
  async detailFetch(_productId, _opts) {
    return null;
  }

  // Optional. Return a custom ranking metric/tier hook, or null to let
  // rank.mjs use its deterministic default. Default: null.
  rankMode(_products, _opts) {
    return null;
  }

  // Optional. Classify an HTTP response into OK / BLOCKED. Default: OK.
  classifyResponse(_resp) {
    return { outcome: "OK" };
  }
}

export default StoreAdapter;
