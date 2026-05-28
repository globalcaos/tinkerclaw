import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { NAVIGATION_FORBIDDEN_REASON } from "./navigation-lock.js";
import { registerBrowserTabRoutes } from "./tabs.js";

// FORK 2026-05-28: POST /navigate is no longer hard-locked at the gateway —
// within-site navigation is allowed (subdomain hops within the same
// registered domain) and cross-site is rejected at the chrome-extension
// `Page.navigate` guard. See [[feedback_browser-relay-policy]] and
// [[reference_browser-relay-within-site-navigation]]. Coverage for the new
// behaviour lives in pw-session.create-page.navigation-guard.test.ts +
// pw-tools-core.snapshot.navigate-guard.test.ts. /tabs/open remains locked
// (no new tabs, ever) and is the only case still tested here.

describe("POST /tabs/open", () => {
  function buildTabsApp(): Express {
    const app = express();
    app.use(express.json());
    const ctx = new Proxy(
      {},
      {
        get() {
          throw new Error("Route context must NOT be touched when navigation is forbidden");
        },
      },
    ) as unknown as Parameters<typeof registerBrowserTabRoutes>[1];
    registerBrowserTabRoutes(app, ctx);
    return app;
  }

  it("returns 403 forbidden without touching context", async () => {
    const app = buildTabsApp();
    const res = await request(app).post("/tabs/open").send({ url: "https://example.com" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      status: "forbidden",
      action: "open",
      reason: NAVIGATION_FORBIDDEN_REASON,
    });
  });
});
