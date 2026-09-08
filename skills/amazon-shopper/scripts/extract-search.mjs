// extract-search.mjs — parse amazon.es /s?k=... results into product[].
// Regex-based (no DOM parser) to keep zero-dep convention.

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function parseSpanishNumber(s) {
  if (!s) return null;
  const cleaned = String(s).replace(/[^0-9.,-]/g, "");
  if (!cleaned) return null;
  // Spanish format: thousand-sep is ".", decimal sep is ",". Strip dots, replace comma with dot.
  const norm = cleaned.includes(",") ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned;
  const n = Number(norm);
  return Number.isFinite(n) ? n : null;
}

function extractCardField(card, regex, group = 1) {
  const m = card.match(regex);
  return m ? decodeHtml(m[group]).trim() : null;
}

function parseCard(asin, card, position) {
  // Live amazon.es carries the full title in <h2 aria-label="...">; older markup
  // nested it in an <h2><span>. Try the aria-label first, then the span forms.
  let title = extractCardField(card, /<h2[^>]*\baria-label="([^"]+)"/);
  if (!title) {
    title = extractCardField(card, /<h2[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>[\s\S]*?<\/h2>/);
  }
  if (!title) {
    title = extractCardField(card, /<span class="a-size-medium[^"]*"[^>]*>([^<]+)<\/span>/);
  }

  // FORK 2026-08-06: ALWAYS build the canonical /dp/<ASIN> URL. Scraping the
  // first a-link-normal href yielded an ad click-tracker on sponsored cards
  // (`/sspa/click?...`, `aax-eu-zaz.amazon.es/x/c/...`) and a bare "#" on
  // others — every product in the 2026-08-06 microSD run had url
  // "https://www.amazon.es#", i.e. no usable link at all. The ASIN is already
  // parsed and is the stable identity, so derive from it.
  const url = `https://www.amazon.es/dp/${asin}`;

  // Sponsored cards prefix the title ("Anuncio patrocinado: ..."), which
  // corrupts any title-based spec parsing and misleads on ranking.
  const is_sponsored = /Anuncio patrocinado|Sponsored\b|\/sspa\/click/i.test(card);
  if (title)
    title = title.replace(/^\s*(Anuncio patrocinado|Sponsored Ad|Sponsored)\s*:?\s*/i, "").trim();

  const image_url = extractCardField(card, /<img[^>]*class="s-image"[^>]*src="([^"]+)"/);

  const priceWhole = extractCardField(card, /<span class="a-price-whole">([^<]*)/);
  const priceFrac = extractCardField(card, /<span class="a-price-fraction">([^<]+)<\/span>/);
  let current_price_eur = null;
  if (priceWhole) {
    const wholeNum = priceWhole.replace(/[^\d]/g, "");
    const fracNum = (priceFrac || "0").replace(/[^\d]/g, "");
    current_price_eur = wholeNum ? Number(`${wholeNum}.${fracNum}`) : null;
  }

  // Also support the a-offscreen pattern (e.g. "25,99 €") as fallback.
  if (current_price_eur == null) {
    const off = extractCardField(card, /<span class="a-offscreen">([^<]+)<\/span>/);
    if (off) current_price_eur = parseSpanishNumber(off);
  }

  const listText = extractCardField(
    card,
    /<span class="a-price a-text-price[^"]*"[^>]*>[\s\S]*?<span class="a-offscreen">([^<]+)<\/span>/,
  );
  const list_price_eur = listText ? parseSpanishNumber(listText) : null;

  // A logged-in tab may serve the /-/en/ locale, where the same field reads
  // "4.5 out of 5 stars". Spanish-only patterns returned null for every row.
  let ratingText = extractCardField(card, /([0-9],[0-9])\s+de\s+5\s+estrellas/);
  if (!ratingText) ratingText = extractCardField(card, /([0-9][.,][0-9])\s+out of\s+5\s+stars/i);
  const rating = ratingText ? parseSpanishNumber(ratingText) : null;

  const reviewText = extractCardField(
    card,
    /<span[^>]*class="a-size-base s-underline-text[^"]*"[^>]*>([0-9.,]+)<\/span>/,
  );
  const review_count = reviewText ? parseSpanishNumber(reviewText) : null;

  const is_prime = /class="[^"]*a-icon-prime[^"]*"/.test(card);
  const is_best_seller = /Best Seller|Más vendido/i.test(card);

  // FORK 2026-08-06: amazon.es no longer emits the a-icon-prime badge (0 hits
  // across 47 live cards) — is_prime alone can no longer answer "when does it
  // arrive". Capture the delivery DATE text instead; callers filter by date.
  //
  // The first version of this regex required `el ` and a bare
  // `<span class="a-text-bold">`, which silently missed the ONE case that
  // matters most — amazon.es renders next-day delivery as
  //   Entrega más rápida <span id="WVCRIAFWG" class="a-text-bold">mañana, 7 de ago
  // with no "el" and a randomised id BEFORE class. 40 "mañana" strings were
  // present on the page and the extractor reported zero next-day options.
  // Tolerate optional "entre"/"el" and arbitrary attributes on the span.
  // FORK 2026-08-06 (2): a SHARED LOGGED-IN tab serves the /-/en/ locale and
  // renders the same promise in English:
  //   FREE delivery <span id="WVCRIAFWG" class="a-text-bold">Tomorrow, 7 Aug</span>
  // plus a Prime badge <span class="a-icon-text">Tomorrow</span>. Matching only
  // Spanish returned delivery for 0 of 59 real cards.
  const BOLD = '<span[^>]*class="[^"]*a-text-bold[^"]*"[^>]*>([^<]+)<';
  const delivery_fastest =
    extractCardField(card, new RegExp(`Entrega más rápida(?:\\s+entre)?(?:\\s+el)?\\s*${BOLD}`)) ??
    extractCardField(card, new RegExp(`(?:Or f|F)astest delivery\\s*${BOLD}`, "i"));
  const delivery_free =
    extractCardField(card, new RegExp(`Entrega GRATIS(?:\\s+entre)?(?:\\s+el)?\\s*${BOLD}`)) ??
    extractCardField(card, new RegExp(`FREE delivery\\s*${BOLD}`, "i"));

  // The Prime badge carries the same claim in one word and survives layout
  // changes to the message line, so treat it as an independent signal.
  const delivery_badge = extractCardField(card, /<span class="a-icon-text">([^<]+)<\/span>/);

  // "mañana"/"Tomorrow" is Amazon's own word for next-day; a date range
  // ("10 - 11 de ago") is never next-day. Callers filter on this flag.
  const delivery_tomorrow = /mañana|tomorrow/i.test(
    `${delivery_fastest ?? ""} ${delivery_free ?? ""} ${delivery_badge ?? ""}`,
  );

  if (!title) return null;
  return {
    asin,
    position,
    title,
    url,
    image_url,
    current_price_eur,
    list_price_eur,
    rating,
    review_count,
    is_prime,
    is_best_seller,
    is_sponsored,
    delivery_fastest,
    delivery_free,
    delivery_badge,
    delivery_tomorrow,
  };
}

export function extractSearchResults(html, { maxProducts = 100 } = {}) {
  const out = [];
  // Match the opening <div> of each search-result card, then pull data-asin
  // from inside that tag. Order-independent: live amazon.es emits
  // `data-asin="..." ... data-component-type="s-search-result"` (asin first),
  // while older/synthetic markup put component-type first — both must parse.
  const cardRe = /<div\b([^>]*\bdata-component-type="s-search-result"[^>]*)>/g;
  const positions = [];
  let match;
  while ((match = cardRe.exec(html)) !== null) {
    const asinM = match[1].match(/\bdata-asin="([A-Z0-9]{10})"/);
    if (asinM) positions.push({ asin: asinM[1], start: match.index });
  }
  for (let i = 0; i < positions.length && out.length < maxProducts; i++) {
    const { asin, start } = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1].start : html.length;
    const card = html.slice(start, end);
    const parsed = parseCard(asin, card, out.length + 1);
    if (parsed) out.push(parsed);
  }
  return out;
}
