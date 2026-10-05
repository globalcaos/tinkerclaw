// fetch.mjs — plain HTTPS client for amazon.es pages.
//
// DESTINATION GUARD (1.2.2). Every request — the first one and every redirect
// hop — is checked before it is sent:
//
//   * HTTPS only, no user:pass@ in the URL;
//   * the host must be amazon.es / www.amazon.es, unless the fetcher was created
//     with allowAnyPublicHost:true — which only research.mjs does, and only when
//     the opt-in off-Amazon rung (AMAZON_SHOPPER_ALLOW_WEB_RESEARCH=1) runs;
//   * the host must resolve to PUBLIC addresses only (no loopback, RFC 1918,
//     link-local, CGNAT, ULA, multicast, reserved, IPv4-mapped private). The same
//     check runs again as the socket's DNS resolver, so the address that was
//     checked is the address that is connected to.
//
// Each response is capped (10 MB, streamed) and each request times out (30 s).
//
// TWO DELIBERATE NON-FEATURES, both removed in 1.2.0 after an audit:
//
//   * It does not impersonate a browser. Earlier versions sent a full Chrome
//     header set, randomised the delay between requests, and "warmed up" against
//     the homepage to collect challenge cookies. That is bot-detection evasion,
//     which is not something this skill should ship. The client now identifies
//     itself honestly and paces itself at a FIXED interval, which is rate
//     limiting (being a good citizen), not cadence jitter (hiding).
//     Consequence, stated plainly: amazon.es may refuse these requests. When it
//     does, the fetcher reports BLOCKED and says so. The two configurable
//     fallbacks are the Apify actor and the Amazon Creators API; there is no
//     browser path and nothing to log into.
//
//   * Its cookie jar is NOT shared across hosts. Cookies are stored and replayed
//     per exact hostname, so a cookie set by amazon.es can never be attached to
//     a request to any other site. The previous flat jar sent every cookie it
//     held to every URL the fetcher was ever given, which leaked amazon.es
//     cookies to search engines and guessed producer domains.

import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import { classifyResponse } from "./detect.mjs";
import {
  UrlNotAllowed,
  AMAZON_PAGE_HOSTS,
  assertHttpsUrl,
  assertPublicHost,
  publicOnlyLookup,
} from "./url-guard.mjs";

const USER_AGENT = "amazon-shopper/1.2 (+https://github.com/globalcaos/tinkerclaw)";

// A fixed, non-random pause between requests. Fixed on purpose: a randomised
// delay exists to look human, a constant one exists to not hammer a server.
const DEFAULT_INTERVAL_MS = 2000;
export const MAX_PAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;

function defaultHeaders() {
  return {
    "user-agent": USER_AGENT,
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    "accept-language": "es-ES,es;q=0.9,en;q=0.8",
  };
}

function parseSetCookie(headers) {
  const sc = [];
  if (typeof headers?.getSetCookie === "function") {
    for (const v of headers.getSetCookie()) sc.push(v);
  } else if (headers?.get) {
    const v = headers.get("set-cookie");
    if (v) sc.push(v);
  }
  const jar = {};
  for (const line of sc) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// checkDestination — throws UrlNotAllowed unless `url` may be requested.
async function checkDestination(url, { allowAnyPublicHost, lookup }) {
  const u = assertHttpsUrl(url);
  const host = u.hostname.toLowerCase();
  if (!allowAnyPublicHost && !AMAZON_PAGE_HOSTS.has(host)) {
    throw new UrlNotAllowed(
      `refusing request to ${host}: this fetcher only requests ${[...AMAZON_PAGE_HOSTS].join(" / ")}`,
    );
  }
  await assertPublicHost(host, { _lookup: lookup });
  return host;
}

// headerView — the tiny subset of the fetch Headers API this module reads.
function headerView(raw) {
  return {
    get(name) {
      const v = raw[String(name).toLowerCase()];
      return Array.isArray(v) ? v.join(", ") : (v ?? null);
    },
    getSetCookie() {
      const v = raw["set-cookie"];
      return Array.isArray(v) ? v : v ? [v] : [];
    },
  };
}

// httpsGet — the production transport. No redirect following (the caller
// re-validates every hop), a public-only DNS resolver bound to the socket, a
// streamed byte cap and a hard deadline.
function httpsGet(url, { headers, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers,
        agent: false, // a fresh connection, so every request re-resolves
        lookup: publicOnlyLookup,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on("data", (c) => {
          total += c.length;
          if (total > maxBytes) {
            req.destroy(
              new Error(`response from ${new URL(url).hostname} exceeded ${maxBytes} bytes`),
            );
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode,
            headers: headerView(res.headers),
            text: async () => body,
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
  });
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// createFetcher options:
//   allowAnyPublicHost — false (default): amazon.es hosts only. true: any HTTPS
//                        host that resolves to public addresses (research.mjs's
//                        opt-in off-Amazon rung is the only caller).
//   fetch              — TEST SEAM: a fetch-like function used instead of the
//                        node:https transport. The destination checks still run.
//   lookup             — TEST SEAM: resolver for the pre-request public-address check.
export function createFetcher({
  fetch = null,
  intervalMs = DEFAULT_INTERVAL_MS,
  allowAnyPublicHost = false,
  lookup = dnsLookup,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_PAGE_BYTES,
} = {}) {
  // host → { name: value }. Never merged across hosts.
  const jars = new Map();
  let lastRequestAt = 0;

  function jarFor(host) {
    if (!jars.has(host)) jars.set(host, {});
    return jars.get(host);
  }

  async function rawGet(url) {
    // Runs for the first request AND for every redirect hop (fetchFollowing
    // calls back in here), so a redirect cannot lead anywhere a direct request
    // could not go.
    const host = await checkDestination(url, { allowAnyPublicHost, lookup });
    const headers = defaultHeaders();
    const cookie = cookieHeader(jarFor(host));
    if (cookie) headers.cookie = cookie;

    // Redirects are never followed by the transport: each hop is re-validated
    // and re-jarred by hostname, so a cross-host redirect cannot carry this
    // host's cookies onward either.
    const res = fetch
      ? await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) })
      : await httpsGet(url, { headers, timeoutMs, maxBytes });
    Object.assign(jarFor(host), parseSetCookie(res.headers));
    const status = res.status;
    const location = res.headers?.get?.("location");
    if (status >= 300 && status < 400 && location) {
      return {
        status,
        headers: res.headers,
        body: "",
        redirectTo: new URL(location, url).toString(),
      };
    }
    const body = await res.text();
    if (Buffer.byteLength(body) > maxBytes) {
      throw new Error(`response from ${host} exceeded ${maxBytes} bytes`);
    }
    return { status, headers: res.headers, body };
  }

  async function fetchFollowing(url, maxHops = 3) {
    let current = url;
    for (let hop = 0; hop <= maxHops; hop++) {
      const r = await rawGet(current);
      if (!r.redirectTo) return { ...r, finalUrl: current };
      current = r.redirectTo;
      // Each hop is a fresh request, so it observes the same pacing.
      await sleep(intervalMs);
    }
    throw new Error(`too many redirects starting at ${url}`);
  }

  async function pace() {
    const wait = lastRequestAt + intervalMs - Date.now();
    await sleep(wait);
    lastRequestAt = Date.now();
  }

  async function get(url) {
    await pace();
    let r = await fetchFollowing(url);
    let cls = classifyResponse({ status: r.status, body: r.body });
    if (cls.outcome === "BLOCKED" && cls.reason === "rate-limit") {
      // Back off once on an explicit rate-limit, then accept the verdict.
      await sleep(intervalMs * 2);
      lastRequestAt = Date.now();
      r = await fetchFollowing(url);
      cls = classifyResponse({ status: r.status, body: r.body });
    }
    if (cls.outcome === "OK") return { outcome: "OK", body: r.body, finalUrl: r.finalUrl };
    return { outcome: "BLOCKED", reason: cls.reason, body: r.body, finalUrl: r.finalUrl };
  }

  return {
    get,
    // Read-only view, per host. Callers cannot mutate the live jars.
    cookiesFor(host) {
      return { ...(jars.get(String(host).toLowerCase()) || {}) };
    },
  };
}
