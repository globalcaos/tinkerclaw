// fetch.mjs — plain HTTPS client for amazon.es pages.
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
//     does, the fetcher reports BLOCKED and the supported data paths are the
//     Apify actor, the Amazon Creators API, or the opt-in browser relay.
//
//   * Its cookie jar is NOT shared across hosts. Cookies are stored and replayed
//     per exact hostname, so a cookie set by amazon.es can never be attached to
//     a request to any other site. The previous flat jar sent every cookie it
//     held to every URL the fetcher was ever given, which leaked amazon.es
//     cookies to search engines and guessed producer domains.

import { classifyResponse } from "./detect.mjs";
import { UrlNotAllowed } from "./url-guard.mjs";

const USER_AGENT = "amazon-shopper/1.2 (+https://github.com/globalcaos/tinkerclaw)";

// A fixed, non-random pause between requests. Fixed on purpose: a randomised
// delay exists to look human, a constant one exists to not hammer a server.
const DEFAULT_INTERVAL_MS = 2000;

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

function hostOf(url) {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new UrlNotAllowed(`refusing non-HTTPS URL: ${url}`);
  return u.hostname.toLowerCase();
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export function createFetcher({ fetch = globalThis.fetch, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  // host → { name: value }. Never merged across hosts.
  const jars = new Map();
  let lastRequestAt = 0;

  function jarFor(host) {
    if (!jars.has(host)) jars.set(host, {});
    return jars.get(host);
  }

  async function rawGet(url) {
    const host = hostOf(url);
    const headers = defaultHeaders();
    const cookie = cookieHeader(jarFor(host));
    if (cookie) headers.cookie = cookie;

    // redirect:"manual" so a cross-host redirect cannot carry this host's
    // cookies onward: each hop is re-validated and re-jarred by hostname.
    const res = await fetch(url, { headers, redirect: "manual" });
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
