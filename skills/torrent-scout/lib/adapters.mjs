// adapters.mjs — one function per source, all returning the same shape.
//
// The normalized candidate contract (every adapter must produce this):
//   { source, id, title, magnet|null, torrentUrl|null, infoHash|null,
//     sizeBytes|null, seeders|null, leechers|null, webseed:bool,
//     publishedAt|null, categories:[], pageUrl|null }
//
// NOTE ON WHAT IS BUILT IN: only archive.org, which is public-domain and
// legal everywhere. Every other source is a user-supplied Torznab endpoint.
// The value of this skill is the verification and ranking engine, not a list
// of sites — and a hardcoded site list rots within months anyway.

async function getText(url, { timeoutMs = 25000, headers = {} } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { "user-agent": "torrent-scout/1.0", ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------------ */
/* Internet Archive — legal, always available, good for public-domain  */
/* film, books, software, scans and engineering documents.             */
/* ------------------------------------------------------------------ */
export async function searchArchiveOrg(
  query,
  { limit = 25, timeoutMs = 25000, mediatype = null } = {},
) {
  const clauses = [`(${query})`, 'format:("Archive BitTorrent")'];
  if (mediatype) clauses.push(`mediatype:(${mediatype})`);
  const q = encodeURIComponent(clauses.join(" AND "));
  const fl = ["identifier", "title", "item_size", "year", "downloads", "mediatype", "format"]
    .map((f) => `fl%5B%5D=${f}`)
    .join("&");
  const url = `https://archive.org/advancedsearch.php?q=${q}&${fl}&rows=${limit}&page=1&output=json`;
  const json = JSON.parse(await getText(url, { timeoutMs }));
  const docs = json?.response?.docs || [];
  return docs.map((d) => ({
    source: "archive.org",
    id: d.identifier,
    title: d.title ? `${d.title}${d.year ? ` (${d.year})` : ""} [${d.identifier}]` : d.identifier,
    magnet: null,
    torrentUrl: `https://archive.org/download/${encodeURIComponent(d.identifier)}/${encodeURIComponent(d.identifier)}_archive.torrent`,
    infoHash: null,
    sizeBytes: Number(d.item_size) || null,
    seeders: null,
    leechers: null,
    webseed: true,
    publishedAt: d.year ? `${d.year}-01-01` : null,
    categories: [d.mediatype].filter(Boolean),
    pageUrl: `https://archive.org/details/${encodeURIComponent(d.identifier)}`,
    extra: { downloads: d.downloads ?? null },
  }));
}

/* ------------------------------------------------------------------ */
/* Generic Torznab — Prowlarr, Jackett, or any Torznab-speaking server */
/* ------------------------------------------------------------------ */
function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d))
    .replace(/&amp;/g, "&");
}

function attr(block, name) {
  const re = new RegExp(`<torznab:attr[^>]*name="${name}"[^>]*value="([^"]*)"`, "i");
  const m = block.match(re);
  return m ? decodeXml(m[1]) : null;
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  if (m) return decodeXml(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").trim());
  const self = block.match(new RegExp(`<${name}[^>]*\\bhref="([^"]*)"`, "i"));
  return self ? decodeXml(self[1]) : null;
}

export function parseTorznab(xml, sourceName) {
  const items = xml
    .split(/<item[\s>]/i)
    .slice(1)
    .map((s) => `<item ${s}`);
  return items.map((block) => {
    const magnet =
      attr(block, "magneturl") || (tag(block, "link") || "").startsWith("magnet:")
        ? attr(block, "magneturl") || tag(block, "link")
        : null;
    const enclosure = block.match(/<enclosure[^>]*url="([^"]*)"/i);
    const link = tag(block, "link");
    const infoHash =
      attr(block, "infohash") ||
      (magnet && (magnet.match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/) || [])[1]) ||
      null;
    const size = Number(
      attr(block, "size") ||
        tag(block, "size") ||
        (enclosure && block.match(/<enclosure[^>]*length="(\d+)"/i)?.[1]) ||
        0,
    );
    return {
      source: sourceName,
      id: attr(block, "guid") || tag(block, "guid") || infoHash || tag(block, "title"),
      title: tag(block, "title") || "(untitled)",
      magnet: magnet && magnet.startsWith("magnet:") ? magnet : null,
      torrentUrl: enclosure
        ? decodeXml(enclosure[1])
        : link && !link.startsWith("magnet:")
          ? link
          : null,
      infoHash,
      sizeBytes: size || null,
      seeders: attr(block, "seeders") !== null ? Number(attr(block, "seeders")) : null,
      leechers:
        attr(block, "peers") !== null
          ? Math.max(0, Number(attr(block, "peers")) - Number(attr(block, "seeders") || 0))
          : null,
      webseed: false,
      publishedAt: tag(block, "pubDate"),
      categories: [attr(block, "category")].filter(Boolean),
      pageUrl: attr(block, "comments") || tag(block, "comments") || null,
    };
  });
}

/**
 * @param {{name:string,url:string,apiKey?:string,categories?:string}} indexer
 *   url is the Torznab api endpoint, e.g. http://localhost:9696/api/v1/indexer/5/newznab
 */
export async function searchTorznab(
  indexer,
  query,
  { limit = 50, timeoutMs = 25000, cat = null } = {},
) {
  const u = new URL(indexer.url);
  u.searchParams.set("t", "search");
  u.searchParams.set("q", query);
  u.searchParams.set("limit", String(limit));
  if (indexer.apiKey) u.searchParams.set("apikey", indexer.apiKey);
  const category = cat || indexer.categories;
  if (category) u.searchParams.set("cat", category);
  const xml = await getText(u.toString(), { timeoutMs });
  return parseTorznab(xml, indexer.name || u.hostname);
}
