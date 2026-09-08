import assert from "node:assert/strict";
import test from "node:test";
import { createFetcher } from "../scripts/fetch.mjs";

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
  const f = createFetcher({ fetch: fetchImpl, intervalMs: 0 });
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
  const f = createFetcher({ fetch: fetchImpl, intervalMs: 0 });
  await f.get("https://www.amazon.es/s?k=x");
  await f.get("https://duckduckgo.com/html/?q=x");

  assert.equal(sent[0].cookie, undefined, "first amazon call has no cookie yet");
  assert.equal(sent[1].cookie, undefined, "amazon's cookie must NOT leak to duckduckgo.com");

  await f.get("https://www.amazon.es/s?k=y");
  assert.equal(sent[2].cookie, "session-id=secret", "amazon's own cookie replays to amazon");
  assert.equal(f.cookiesFor("duckduckgo.com")["session-id"], "secret", "each host keeps its own");
});

test("a cross-host redirect does not carry the origin host's cookies", async () => {
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
  const f = createFetcher({ fetch: fetchImpl, intervalMs: 0 });
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
  const f = createFetcher({ fetch: fetchImpl, intervalMs: 0 });
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
  const f = createFetcher({ fetch: fetchImpl, intervalMs: 0 });
  const res = await f.get("https://www.amazon.es/s?k=x");
  assert.equal(res.outcome, "BLOCKED");
  assert.equal(res.reason, "rate-limit");
  assert.equal(n, 2, "503 retried once");
});
