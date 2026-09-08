// url-guard.mjs — destination validation for every outbound request.
//
// Two jobs, both of them security boundaries rather than conveniences:
//
//   1. assertAmazonPageUrl() — a page URL handed to an AUTHENTICATED fetch must
//      be HTTPS and must be an amazon.es host. A URL that arrives from a listing,
//      a search result, or a CLI flag is untrusted input.
//   2. fetchImageSafely() — product image URLs come out of marketplace HTML or a
//      third-party scraper, i.e. they are attacker-influenceable. Fetching one
//      without checks is a server-side request forgery primitive pointed at
//      whatever the host can reach, and reading the whole body into memory is an
//      unbounded allocation. Both are closed here.
//
// The IP checks matter because a hostname on the allowlist is not the same as an
// address on the public internet: DNS is controlled by whoever owns the name, so
// the resolved address is validated too, and redirects are refused outright
// rather than followed into a different destination.

import { lookup } from "node:dns/promises";

// Hosts whose PAGES may receive an authenticated (cookie-bearing) request.
const AMAZON_PAGE_HOSTS = new Set(["amazon.es", "www.amazon.es"]);

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

function parse(url) {
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
  const u = parse(url);
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
// loopback, private, link-local, CGNAT, multicast, reserved, unspecified, and
// the IPv6 equivalents including IPv4-mapped forms.
export function isPrivateAddress(addr, family) {
  const a = String(addr).toLowerCase();
  if (family === 4 || /^\d+\.\d+\.\d+\.\d+$/.test(a)) {
    const p = a.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [x, y] = p;
    if (x === 0 || x === 10 || x === 127) return true;
    if (x === 169 && y === 254) return true; // link-local
    if (x === 172 && y >= 16 && y <= 31) return true; // private
    if (x === 192 && y === 168) return true; // private
    if (x === 192 && y === 0) return true; // IETF protocol assignments
    if (x === 100 && y >= 64 && y <= 127) return true; // CGNAT
    if (x >= 224) return true; // multicast + reserved + broadcast
    return false;
  }
  // IPv6
  if (a === "::" || a === "::1") return true;
  if (a.startsWith("fe80") || a.startsWith("fc") || a.startsWith("fd")) return true; // link-local, ULA
  if (a.startsWith("ff")) return true; // multicast
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1], 4);
  return false;
}

// assertPublicHost — resolve the hostname and refuse any non-public address.
export async function assertPublicHost(hostname, { _lookup = lookup } = {}) {
  let addrs;
  try {
    addrs = await _lookup(hostname, { all: true });
  } catch {
    throw new UrlNotAllowed(`cannot resolve ${hostname}`);
  }
  if (!addrs.length) throw new UrlNotAllowed(`cannot resolve ${hostname}`);
  for (const { address, family } of addrs) {
    if (isPrivateAddress(address, family)) {
      throw new UrlNotAllowed(`refusing ${hostname}: resolves to non-public address ${address}`);
    }
  }
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
  const u = parse(url);
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
