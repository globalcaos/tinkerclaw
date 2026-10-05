import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  createShortlistHandler,
  MAX_BODY_BYTES,
  newToken,
  SHORTLIST_PATH,
  tokenOk,
} from "../src/http.js";
import type { Prepared } from "../src/shortlist-seam.js";

function req(
  o: { method?: string; url?: string; token?: string; body?: string | Buffer } = {},
): IncomingMessage {
  const r = new EventEmitter() as unknown as IncomingMessage;
  r.method = o.method ?? "POST";
  r.url = o.url ?? SHORTLIST_PATH;
  r.headers = o.token === undefined ? {} : { authorization: `Bearer ${o.token}` };
  (r as unknown as { destroy: () => void }).destroy = () => {};
  queueMicrotask(() => {
    if (o.body !== undefined)
      r.emit("data", typeof o.body === "string" ? Buffer.from(o.body) : o.body);
    r.emit("end");
  });
  return r;
}
function res() {
  const out = { status: 0, body: "" };
  const r = {
    writableEnded: false,
    destroyed: false,
    writeHead: (s: number) => void (out.status = s),
    end: (b: string) => {
      out.body = b;
      r.writableEnded = true;
    },
  };
  return { r: r as unknown as ServerResponse, out };
}

const prepared = (over: Partial<Prepared> = {}): Prepared => ({
  list: { entries: [], noneFitsProb: 1, shown: false, reason: "not-asked", source: "local" },
  injected: false,
  usedJev: false,
  ...over,
});

const TOKEN = "t".repeat(48);
const body = (o: object = {}) =>
  JSON.stringify({ prompt: "compare my translation", session_id: "sess-1", ...o });

describe("the Claude Code short-list route", () => {
  it("only answers its own path", async () => {
    const h = createShortlistHandler(
      { prepare: async () => prepared(), sourceOf: () => "tinker" },
      () => TOKEN,
    );
    const { r } = res();
    expect(await h(req({ url: "/other", token: TOKEN, body: body() }), r)).toBe(false);
  });

  it("refuses a missing or wrong token, and a method other than POST", async () => {
    const prepare = vi.fn(async () => prepared());
    const h = createShortlistHandler({ prepare, sourceOf: () => "tinker" }, () => TOKEN);
    for (const token of [undefined, "wrong", TOKEN.slice(0, -1)]) {
      const { r, out } = res();
      await h(req({ token, body: body() }), r);
      expect(out.status, String(token)).toBe(401);
    }
    const { r, out } = res();
    await h(req({ method: "GET", token: TOKEN }), r);
    expect(out.status).toBe(405);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("refuses every request when the server has no token", async () => {
    const h = createShortlistHandler(
      { prepare: async () => prepared(), sourceOf: () => "tinker" },
      () => "",
    );
    const { r, out } = res();
    await h(req({ token: "", body: body() }), r);
    expect(out.status).toBe(401);
  });

  it("answers empty in shadow: no additionalContext, so the agent's context is untouched", async () => {
    const h = createShortlistHandler(
      { prepare: async () => prepared(), sourceOf: () => "tinker" },
      () => TOKEN,
    );
    const { r, out } = res();
    await h(req({ token: TOKEN, body: body() }), r);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({});
  });

  it("returns the note, and only the note, when the seam has one (enforce)", async () => {
    const h = createShortlistHandler(
      {
        prepare: async () => prepared({ text: "the list", injected: true }),
        sourceOf: () => "tinker",
      },
      () => TOKEN,
    );
    const { r, out } = res();
    await h(req({ token: TOKEN, body: body() }), r);
    expect(JSON.parse(out.body)).toEqual({ additionalContext: "the list" });
  });

  it("passes the prompt, the session and its source to the seam", async () => {
    const prepare = vi.fn(async () => prepared());
    const h = createShortlistHandler(
      { prepare, sourceOf: (k) => (k === "sess-1" ? "channel:sms" : "tinker") },
      () => TOKEN,
      () => 1234,
    );
    await h(req({ token: TOKEN, body: body() }), res().r);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "compare my translation",
        sessionKey: "sess-1",
        source: "channel:sms",
        trigger: "user",
        ts: 1234,
      }),
    );
  });

  it("answers {} rather than an error for a missing prompt, bad JSON aside, and a seam that throws", async () => {
    const h = createShortlistHandler(
      {
        prepare: async () => {
          throw new Error("x");
        },
        sourceOf: () => "tinker",
      },
      () => TOKEN,
    );
    for (const b of [body({ prompt: "" }), JSON.stringify({ prompt: "x" }), body()]) {
      const { r, out } = res();
      await h(req({ token: TOKEN, body: b }), r);
      expect(out.status).toBe(200);
      expect(JSON.parse(out.body)).toEqual({});
    }
    const { r, out } = res();
    await h(req({ token: TOKEN, body: "{not json" }), r);
    expect(out.status).toBe(400);
  });

  it("refuses a body over the limit", async () => {
    const h = createShortlistHandler(
      { prepare: async () => prepared(), sourceOf: () => "tinker" },
      () => TOKEN,
    );
    const { r, out } = res();
    await h(req({ token: TOKEN, body: Buffer.alloc(MAX_BODY_BYTES + 1, 97) }), r);
    expect(out.status).toBe(413);
  });

  it("makes tokens that are long, hexadecimal and different every time", () => {
    const a = newToken();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(newToken()).not.toBe(a);
    expect(tokenOk(`Bearer ${a}`, a)).toBe(true);
    expect(tokenOk(`bearer ${a}`, a)).toBe(false);
    expect(tokenOk(undefined, a)).toBe(false);
  });
});
