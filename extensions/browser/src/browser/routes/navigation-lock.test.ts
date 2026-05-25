import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { registerBrowserAgentSnapshotRoutes } from "./agent.snapshot.js";
import { NAVIGATION_FORBIDDEN_REASON } from "./navigation-lock.js";
import { registerBrowserTabRoutes } from "./tabs.js";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  // Stub context — should NEVER be touched because guard fires first.
  const ctx = new Proxy(
    {},
    {
      get() {
        throw new Error("Route context must NOT be touched when navigation is forbidden");
      },
    },
  ) as unknown as Parameters<typeof registerBrowserAgentSnapshotRoutes>[1];
  registerBrowserAgentSnapshotRoutes(app, ctx);
  return app;
}

describe("POST /navigate", () => {
  it("returns 403 forbidden without touching context", async () => {
    const app = buildApp();
    const res = await request(app).post("/navigate").send({ url: "https://example.com" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      status: "forbidden",
      action: "navigate",
      reason: NAVIGATION_FORBIDDEN_REASON,
    });
  });
});

// Anti-regression — click-driven cross-origin navigation must NOT be blocked.
// There is no dedicated /click route; clicks dispatch through POST /act with
// kind: "click". Coverage that clicks succeed (HTTP 200, chrome-mcp click
// invoked) and can legitimately trigger navigation / new tabs lives in
// agent.act.existing-session-navigation-guard.test.ts (see e.g. the
// "checks navigation after click and key-driven submit paths" and "checks
// URLs for tabs opened during the interaction window" cases).

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
