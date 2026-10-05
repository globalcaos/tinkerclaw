import { describe, expect, it } from "vitest";
import { buildSessionsListParams, settleSessionsFetch } from "./sessions-list-params";

// FORK 2026-09-12 — the gateway validates `sessions.list` params with
// `additionalProperties: false`. A UI bundle built from a newer tree than the
// running gateway must therefore never send a field the older schema does not
// know unless the user actually turned the feature on: on 2026-09-12 a rebuilt
// bundle sent `includeHive:false` to a 09-08 gateway, every list call failed
// with "unexpected property 'includeHive'", the client swallowed it into `[]`,
// and the sessions panel showed only the open tabs.

describe("buildSessionsListParams", () => {
  it("sends {} when every optional filter is at its default", () => {
    expect(buildSessionsListParams({ includeHive: false, operatorId: "" })).toEqual({});
    expect(buildSessionsListParams({})).toEqual({});
  });

  it("sends includeHive only when it is on", () => {
    expect(buildSessionsListParams({ includeHive: true })).toEqual({ includeHive: true });
  });

  it("sends operatorId only when non-blank, trimmed", () => {
    expect(buildSessionsListParams({ operatorId: "  " })).toEqual({});
    expect(buildSessionsListParams({ operatorId: " ada " })).toEqual({ operatorId: "ada" });
  });

  it("passes the pre-hivemind booleans through only when set", () => {
    expect(buildSessionsListParams({ includeGlobal: true, includeUnknown: false })).toEqual({
      includeGlobal: true,
    });
  });
});

describe("settleSessionsFetch", () => {
  const prev = [{ key: "agent:main:tinker:a" }, { key: "agent:main:tinker:b" }];

  it("replaces the list on a successful fetch, even with an empty result", () => {
    expect(settleSessionsFetch(prev, { ok: true, sessions: [] })).toEqual({
      sessions: [],
      fetched: true,
    });
    expect(settleSessionsFetch(prev, { ok: true, sessions: [{ key: "x" }] }).sessions).toEqual([
      { key: "x" },
    ]);
  });

  it("keeps the previous list when the fetch failed — an error is not an empty server", () => {
    const out = settleSessionsFetch(prev, { ok: false, error: new Error("invalid params") });
    expect(out.sessions).toBe(prev);
    expect(out.fetched).toBe(false);
  });

  it("treats a response without a sessions array as a failure, not as zero sessions", () => {
    const out = settleSessionsFetch(prev, { ok: true, sessions: undefined });
    expect(out.sessions).toBe(prev);
    expect(out.fetched).toBe(false);
  });
});
