// AmazonAdapter.mjs — Amazon.es store adapter.
//
// Wraps the EXISTING, unchanged Amazon code paths:
//   - scripts/extract-search.mjs  → extract() (HTML → normalized Listing[])
//   - scripts/extract-detail.mjs  → detailFetch() (HTML → DetailSpec)
//   - scripts/detect.mjs          → classifyResponse() (OK/BLOCKED)
//   - scripts/rank.mjs refundTier → rankMode() (Amazon A-to-z refund tier)
//
// It produces the IDENTICAL normalized Listing[] the skill produces today on
// the existing fixtures (it literally calls extractSearchResults), so the
// default --store amazon path is behaviour-preserving.

import { classifyResponse as amazonClassify } from "../scripts/detect.mjs";
import { extractDetailSpec } from "../scripts/extract-detail.mjs";
import { extractSearchResults } from "../scripts/extract-search.mjs";
import { refundTier } from "../scripts/rank.mjs";
import { StoreAdapter } from "./StoreAdapter.mjs";

export class AmazonAdapter extends StoreAdapter {
  get name() {
    return "amazon";
  }

  searchUrl(keywords) {
    return `https://www.amazon.es/s?k=${encodeURIComponent(keywords)}`;
  }

  // REQUIRED. Parse Amazon search HTML into normalized Listing[]. Identical to
  // the legacy `extractSearchResults(html)` call the orchestrator used inline.
  extract(html, _context = {}) {
    return extractSearchResults(html);
  }

  // REQUIRED. Run a keyword search via the injected fetcher, then extract.
  // Returns { outcome:"OK", products } on success, or the blocked envelope
  // ({ outcome:"BLOCKED", reason }) when the fetch is WAF/captcha-gated — the
  // same shape the legacy fetcher returns, so the orchestrator's blocked
  // handling is unchanged.
  async search(keywords, opts = {}) {
    const fetcher = opts.fetcher;
    if (!fetcher) throw new Error("AmazonAdapter.search() requires opts.fetcher");
    const url = this.searchUrl(keywords);
    const r = await fetcher.get(url);
    if (r.outcome !== "OK") {
      return { outcome: "BLOCKED", reason: r.reason };
    }
    return { outcome: "OK", products: this.extract(r.body, { keywords }) };
  }

  // Optional. Fetch a /dp/<ASIN>/ detail page and parse it. Returns the
  // DetailSpec on OK, or the blocked envelope (so the caller can fall back to
  // the title-only spec, exactly as the legacy rank loop did).
  async detailFetch(product, opts = {}) {
    const fetcher = opts.fetcher;
    if (!fetcher) throw new Error("AmazonAdapter.detailFetch() requires opts.fetcher");
    const url = product?.url;
    const r = await fetcher.get(url);
    if (r.outcome !== "OK") {
      return { outcome: "BLOCKED", reason: r.reason, url };
    }
    return { outcome: "OK", url, detailSpec: extractDetailSpec(r.body) };
  }

  // Optional. Amazon's refund-tier ranking hook. Returns the per-product
  // refund-tier function rank.mjs uses; null formula means "use rank.mjs's
  // default normalization metric ladder".
  rankMode(_products, _opts) {
    return { metric: null, refundTier };
  }

  // Optional. Classify an Amazon HTTP response (captcha/WAF/etc.).
  classifyResponse(resp) {
    return amazonClassify(resp);
  }
}

export default AmazonAdapter;
