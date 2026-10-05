// url-guard.mjs — destination validation for every outbound request.
//
// Three jobs, all of them security boundaries rather than conveniences:
//
//   1. assertAmazonPageUrl() — a page URL handed to the amazon.es fetcher must
//      be HTTPS and must be an amazon.es host. A URL that arrives from a listing,
//      a search result, or a CLI flag is untrusted input.
//   2. assertPublicHost() / publicOnlyLookup() — EVERY request this package
//      makes through scripts/fetch.mjs (amazon.es pages, and the opt-in
//      off-Amazon research rung) is refused unless the destination resolves to
//      a public unicast address. publicOnlyLookup is handed to node:https as the
//      connection's DNS resolver, so the address that was checked is the address
//      that is connected to (no DNS-rebinding gap between check and use).
//   3. fetchImageSafely() — product image URLs come out of marketplace HTML or a
//      third-party scraper, i.e. they are attacker-influenceable. Fetching one
//      without checks is a server-side request forgery primitive pointed at
//      whatever the host can reach, and reading the whole body into memory is an
//      unbounded allocation. Both are closed here.
//
// The IP checks matter because a hostname on an allowlist is not the same as an
// address on the public internet: DNS is controlled by whoever owns the name, so
// the resolved address is validated too.

import { lookup as lookupCb } from "node:dns";
import { lookup } from "node:dns/promises";

// Hosts whose PAGES this skill may request at all. Requests are anonymous: since
// 1.2.1 the package holds no credential to attach to one.
export const AMAZON_PAGE_HOSTS = new Set(["amazon.es", "www.amazon.es"]);

// Hosts that may serve product IMAGES. Amazon's image CDNs only.
const IMAGE_HOST_SUFFIXES = [
  "media-amazon.com",
  "ssl-images-amazon.com",
  "images-amazon.com",
  "amazon.es",
];

// 8 MB is far above any product packshot and far below "exhaust the process".
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export class UrlNotAllowed extends Error {}

// assertHttpsUrl — parse, require https:, refuse embedded credentials. Returns a URL.
export function assertHttpsUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new UrlNotAllowed(`not a valid URL: ${String(url).slice(0, 120)}`);
  }
  if (u.protocol !== "https:") {
    throw new UrlNotAllowed(`refusing non-HTTPS URL (${u.protocol}//): ${u.host}`);
  }
  // user:pass@host is a classic way to make a URL read as one host and resolve
  // as another; there is no legitimate use for it here.
  if (u.username || u.password) throw new UrlNotAllowed("refusing URL with embedded credentials");
  return u;
}

// assertAmazonPageUrl — throws unless `url` is an HTTPS amazon.es page.
// Returns the normalised URL string so callers can use the validated value.
export function assertAmazonPageUrl(url) {
  const u = assertHttpsUrl(url);
  if (!AMAZON_PAGE_HOSTS.has(u.hostname.toLowerCase())) {
    throw new UrlNotAllowed(
      `refusing request to ${u.hostname}: this skill only fetches ${[...AMAZON_PAGE_HOSTS].join(" / ")}`,
    );
  }
  return u.toString();
}

export function isAmazonPageUrl(url) {
  try {
    assertAmazonPageUrl(url);
    return true;
  } catch {
    return false;
  }
}

function hostAllowedForImages(hostname) {
  const h = hostname.toLowerCase();
  return IMAGE_HOST_SUFFIXES.some((s) => h === s || h.endsWith("." + s));
}

// isPrivateAddress — true for anything that is not a public unicast address:
// loopback, private, link-local, CGNAT, multicast, reserved, documentation,
// unspecified, and the IPv6 equivalents — including IPv4-mapped (both the
// dotted "::ffff:127.0.0.1" and the hex "::ffff:7f00:1" form the WHATWG URL
// parser normalises to), IPv4-compatible, NAT64 and 6to4 embeddings.
export function isPrivateAddress(addr, family) {
  let a = String(addr).toLowerCase();
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  if (family === 4 || /^\d+\.\d+\.\d+\.\d+$/.test(a)) {
    const p = a.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [x, y, z] = p;
    if (x === 0 || x === 10 || x === 127) return true;
    if (x === 169 && y === 254) return true; // link-local
    if (x === 172 && y >= 16 && y <= 31) return true; // private
    if (x === 192 && y === 168) return true; // private
    if (x === 192 && y === 0) return true; // IETF protocol assignments + TEST-NET-1
    if (x === 100 && y >= 64 && y <= 127) return true; // CGNAT
    if (x === 198 && (y === 18 || y === 19)) return true; // benchmarking
    if (x === 198 && y === 51 && z === 100) return true; // TEST-NET-2
    if (x === 203 && y === 0 && z === 113) return true; // TEST-NET-3
    if (x >= 224) return true; // multicast + reserved + broadcast
    return false;
  }
  const g = expandIPv6(a);
  if (!g) return true; // unparseable: refuse rather than guess
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.every((n) => n === 0)) return true; // ::
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff)
    return isPrivateAddress(v4(g[6], g[7]), 4); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((n) => n === 0)) return true; // ::a.b.c.d (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0))
    return isPrivateAddress(v4(g[6], g[7]), 4); // NAT64
  if (g[0] === 0x2002) return isPrivateAddress(v4(g[1], g[2]), 4); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard-only
  return false;
}

// expandIPv6 — "fe80::1" → [0xfe80,0,0,0,0,0,0,1], or null if not an IPv6 literal.
function expandIPv6(a) {
  if (!a.includes(":") || a.includes("%")) return null;
  let s = a;
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const p = dotted[2].split(".").map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${dotted[1]}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (h) => (h === "" ? [] : h.split(":"));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return groups.map((x) => parseInt(x, 16));
}

function bareHost(hostname) {
  const h = String(hostname);
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

// assertPublicHost — resolve the hostname and refuse any non-public address.
// An IP literal is checked as-is.
export async function assertPublicHost(hostname, { _lookup = lookup } = {}) {
  const host = bareHost(hostname);
  let addrs;
  try {
    addrs = await _lookup(host, { all: true });
  } catch {
    throw new UrlNotAllowed(`cannot resolve ${host}`);
  }
  if (!addrs || !addrs.length) throw new UrlNotAllowed(`cannot resolve ${host}`);
  for (const { address, family } of addrs) {
    if (isPrivateAddress(address, family)) {
      throw new UrlNotAllowed(`refusing ${host}: resolves to non-public address ${address}`);
    }
  }
}

// publicOnlyLookup — a dns.lookup-compatible resolver for node:https/net. The
// socket connects only to an address this function returned, and it returns
// nothing unless EVERY resolved address is public. Using it as the connection's
// lookup is what pins the checked address to the connected one.
export function publicOnlyLookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  const opts = typeof options === "number" ? { family: options } : { ...(options || {}) };
  lookupCb(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return callback(err);
    if (!addrs || !addrs.length) return callback(new UrlNotAllowed(`cannot resolve ${hostname}`));
    const bad = addrs.find(({ address, family }) => isPrivateAddress(address, family));
    if (bad)
      return callback(
        new UrlNotAllowed(`refusing ${hostname}: resolves to non-public address ${bad.address}`),
      );
    if (opts.all) return callback(null, addrs);
    return callback(null, addrs[0].address, addrs[0].family);
  });
}

// fetchImageSafely — the ONLY way this skill downloads a product image.
// Returns { buffer, contentType }. Throws UrlNotAllowed for a destination that
// fails any check, and a plain Error for a transport/size failure.
export async function fetchImageSafely(
  url,
  {
    _fetch = globalThis.fetch,
    _lookup = lookup,
    maxBytes = MAX_IMAGE_BYTES,
    timeoutMs = 20000,
  } = {},
) {
  const u = assertHttpsUrl(url);
  if (!hostAllowedForImages(u.hostname)) {
    throw new UrlNotAllowed(`refusing image host ${u.hostname}: not an Amazon image CDN`);
  }
  await assertPublicHost(u.hostname, { _lookup });

  // redirect:"error" — a 30x to an internal address would defeat every check
  // above, so a redirect is a hard failure rather than something to re-validate.
  const res = await _fetch(u.toString(), {
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);

  const ctype = String(res.headers?.get?.("content-type") || "").toLowerCase();
  if (!ctype.startsWith("image/")) {
    throw new UrlNotAllowed(`refusing non-image response (content-type: ${ctype || "none"})`);
  }
  const declared = Number(res.headers?.get?.("content-length") || 0);
  if (declared > maxBytes) {
    throw new Error(`image too large: ${declared} bytes (cap ${maxBytes})`);
  }

  // Read incrementally so a lying or absent content-length cannot make us
  // allocate an unbounded buffer.
  const buffer = await readCapped(res, maxBytes);
  return { buffer, contentType: ctype };
}

async function readCapped(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== "function") {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes)
      throw new Error(`image too large: ${buf.length} bytes (cap ${maxBytes})`);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`image exceeded ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}
