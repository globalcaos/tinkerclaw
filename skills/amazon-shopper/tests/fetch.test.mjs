import assert from "node:assert/strict";
import test from "node:test";
import { createFetcher } from "../scripts/fetch.mjs";

// Offline: a resolver that answers every name with one public
// address, so no test touches real DNS. Tests about non-public destinations
// pass their own resolver.
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

const okBody =
  "<html><head><title>Amazon.es : test</title></head><body>" + "x".repeat(6000) + "</body></html>";

test("search succeeds, identifies itself honestly, and does not warm up", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    return {
      status: 200,
      headers: {
        getSetCookie: () => ["session-id=foo; Path=/", "ubid-acbes=bar; Path=/"],
        get: () => null,
      },
      text: async () => okBody,
    };
  };
  const f = createFetcher({ fetch: fetchImpl, intervalMs: 0, lookup: publicLookup });
  const res = await f.get("https://www.amazon.es/s?k=ph+minus");
  assert.equal(res.outcome, "OK");
  assert.equal(calls.length, 1, "target only — no homepage warmup / challenge seeding");
  assert.equal(calls[0].url, "https://www.amazon.es/s?k=ph+minus");
  assert.match(calls[0].headers["user-agent"], /^amazon-shopper\//);
  assert.doesNotMatch(calls[0].headers["user-agent"], /Chrome/, "must not impersonate a browser");
  assert.equal(calls[0].headers["sec-ch-ua"], undefined, "no client-hint spoofing");
  assert.equal(f.cookiesFor("www.amazon.es")["session-id"], "foo");
});

test("cookies are per-host: an amazon.es cookie is never sent to another host", async () => {
  const sent = [];
  const fetchImpl = async (url, opts) => {
    sent.push({ url, cookie: opts.headers.cookie });
    return {
      status: 200,
      headers: { getSetCookie: () => ["session-id=secret; Path=/"], get: () => null },
      text: async () => okBody,
    };
  };
  const f = createFetcher({
    fetch: fetchImpl,
    intervalMs: 0,
    lookup: publicLookup,
    allowAnyPublicHost: true,
  });
  await f.get("https://www.amazon.es/s?k=x");
  await f.get("https://duckduckgo.com/html/?q=x");

  assert.equal(sent[0].cookie, undefined, "first amazon call has no cookie yet");
  assert.equal(sent[1].cookie, undefined, "amazon's cookie must NOT leak to duckduckgo.com");

  await f.get("https://www.amazon.es/s?k=y");
  assert.equal(sent[2].cookie, "session-id=secret", "amazon's own cookie replays to amazon");
  assert.equal(f.cookiesFor("duckduckgo.com")["session-id"], "secret", "each host keeps its own");
});

test("open fetcher: a cross-host redirect does not carry the origin host's cookies", async () => {
  const sent = [];
  const fetchImpl = async (url, opts) => {
    sent.push({ url, cookie: opts.headers.cookie });
    if (url === "https://www.amazon.es/s?k=x") {
      return {
        status: 302,
        headers: {
          getSetCookie: () => ["session-id=secret; Path=/"],
          get: (h) => (h === "location" ? "https://evil.example/collect" : null),
        },
        text: async () => "",
      };
    }
    return { status: 200, headers: new Map(), text: async () => okBody };
  };
  const f = createFetcher({
    fetch: fetchImpl,
    intervalMs: 0,
    lookup: publicLookup,
    allowAnyPublicHost: true,
  });
  await f.get("https://www.amazon.es/s?k=x");
  assert.equal(sent.length, 2);
  assert.equal(sent[1].url, "https://evil.example/collect");
  assert.equal(sent[1].cookie, undefined, "redirect target must not receive amazon.es cookies");
});

test("non-HTTPS URL is refused outright", async () => {
  const f = createFetcher({
    fetch: async () => {
      throw new Error("must not be called");
    },
    intervalMs: 0,
    lookup: publicLookup,
  });
  await assert.rejects(() => f.get("http://www.amazon.es/s?k=x"), /non-HTTPS/);
});

test("captcha on target → BLOCKED:captcha, no retry", async () => {
  let n = 0;
  const fetchImpl = async (_url, _opts) => {
    n++;
    return {
      status: 200,
      headers: new Map(),
      text: async () => "<html><body>Enter the characters you see below</body></html>",
    };
  };
  const f = createFetcher({ fetch: fetchImpl, intervalMs: 0, lookup: publicLookup });
  const res = await f.get("https://www.amazon.es/s?k=foo");
  assert.equal(res.outcome, "BLOCKED");
  assert.equal(res.reason, "captcha");
  assert.equal(n, 1, "must not retry on captcha");
});

test("503 on target → BLOCKED:rate-limit with one retry", async () => {
  let n = 0;
  const fetchImpl = async (_url, _opts) => {
    n++;
    return { status: 503, headers: new Map(), text: async () => "" };
  };
  const f = createFetcher({ fetch: fetchImpl, intervalMs: 0, lookup: publicLookup });
  const res = await f.get("https://www.amazon.es/s?k=x");
  assert.equal(res.outcome, "BLOCKED");
  assert.equal(res.reason, "rate-limit");
  assert.equal(n, 2, "503 retried once");
});

// ── Destination guard (1.2.2) ────────────────────────────────────────────────

function redirectingFetch(from, to, sent) {
  return async (url, opts) => {
    sent.push(url);
    if (url === from) {
      return {
        status: 302,
        headers: { getSetCookie: () => [], get: (h) => (h === "location" ? to : null) },
        text: async () => "",
      };
    }
    return { status: 200, headers: new Map(), text: async () => okBody };
  };
}

test("default fetcher refuses any host other than amazon.es, before sending", async () => {
  const f = createFetcher({
    fetch: async () => {
      throw new Error("must not be called");
    },
    intervalMs: 0,
    lookup: publicLookup,
  });
  await assert.rejects(() => f.get("https://duckduckgo.com/html/?q=x"), /only requests amazon\.es/);
  await assert.rejects(() => f.get("https://amazon.es.evil.example/x"), /only requests amazon\.es/);
  await assert.rejects(() => f.get("https://u:p@www.amazon.es/x"), /embedded credentials/);
});

test("default fetcher: an amazon.es redirect to another host is refused, not followed", async () => {
  const sent = [];
  const f = createFetcher({
    fetch: redirectingFetch("https://www.amazon.es/s?k=x", "https://evil.example/collect", sent),
    intervalMs: 0,
    lookup: publicLookup,
  });
  await assert.rejects(() => f.get("https://www.amazon.es/s?k=x"), /only requests amazon\.es/);
  assert.deepEqual(
    sent,
    ["https://www.amazon.es/s?k=x"],
    "the redirect target must never be requested",
  );
});

test("open fetcher refuses IP literals in non-public ranges, before sending", async () => {
  const realLookup = (await import("node:dns/promises")).lookup;
  const f = createFetcher({
    fetch: async () => {
      throw new Error("must not be called");
    },
    intervalMs: 0,
    allowAnyPublicHost: true,
    lookup: realLookup,
  });
  for (const url of [
    "https://127.0.0.1/",
    "https://10.0.0.5/admin",
    "https://192.168.1.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://100.64.0.1/",
    "https://[::1]/",
    "https://[fd00::1]/",
    "https://[fe80::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://2130706433/",
    "https://0x7f.1/",
  ]) {
    await assert.rejects(() => f.get(url), /non-public address|cannot resolve/, url);
  }
});

test("open fetcher refuses a hostname that resolves to a private address", async () => {
  const f = createFetcher({
    fetch: async () => {
      throw new Error("must not be called");
    },
    intervalMs: 0,
    allowAnyPublicHost: true,
    lookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ],
  });
  await assert.rejects(() => f.get("https://intranet.example/"), /non-public address 10\.0\.0\.7/);
});

test("open fetcher: a public result that redirects to an internal host is refused at the hop", async () => {
  const sent = [];
  const lookup = async (host) =>
    host === "internal.example"
      ? [{ address: "192.168.0.10", family: 4 }]
      : [{ address: "93.184.216.34", family: 4 }];
  const f = createFetcher({
    fetch: redirectingFetch("https://public.example/spec", "https://internal.example/admin", sent),
    intervalMs: 0,
    allowAnyPublicHost: true,
    lookup,
  });
  await assert.rejects(
    () => f.get("https://public.example/spec"),
    /non-public address 192\.168\.0\.10/,
  );
  assert.deepEqual(sent, ["https://public.example/spec"]);
});

test("open fetcher: a redirect to plaintext HTTP is refused", async () => {
  const sent = [];
  const f = createFetcher({
    fetch: redirectingFetch("https://public.example/spec", "http://public.example/spec", sent),
    intervalMs: 0,
    allowAnyPublicHost: true,
    lookup: publicLookup,
  });
  await assert.rejects(() => f.get("https://public.example/spec"), /non-HTTPS/);
  assert.equal(sent.length, 1);
});

test("response bodies over the byte cap are refused", async () => {
  const f = createFetcher({
    fetch: async () => ({ status: 200, headers: new Map(), text: async () => "x".repeat(2048) }),
    intervalMs: 0,
    lookup: publicLookup,
    maxBytes: 1024,
  });
  await assert.rejects(() => f.get("https://www.amazon.es/s?k=x"), /exceeded 1024 bytes/);
});
