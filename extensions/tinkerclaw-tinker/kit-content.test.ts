import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Regression: the 2026-09-23 path-traversal fix dropped the `inWorkspaceKits` declaration
// but kept its use in the success response, so every valid read threw a ReferenceError
// inside the try and answered 404 {"error":"inWorkspaceKits is not defined"}: every recipe
// and kit view in the Tinker UI showed "Error loading recipe".

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

let home: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = undefined;
});

async function loadHandler(): Promise<Handler> {
  const { default: plugin } = await import("./index.js");
  let handler: Handler | undefined;
  plugin.register({
    config: { gateway: { auth: { token: "t" } } },
    registerHttpRoute: (route: { handler: Handler }) => {
      handler = route.handler;
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as never);
  return handler!;
}

async function getKit(handler: Handler, file: string) {
  const res = {
    statusCode: 0,
    body: "",
    setHeader: () => {},
    end(b: string) {
      this.body = b;
    },
  };
  await handler(
    {
      url: `/tinker/api/kit-content?path=${encodeURIComponent(file)}`,
      method: "GET",
      headers: { host: "localhost" },
    },
    res,
  );
  return res;
}

function makeHome(): string {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tinker-kit-")));
  vi.stubEnv("HOME", home);
  return home;
}

describe("/tinker/api/kit-content", () => {
  it("serves a kit file from ~/.openclaw/workspace/kits and marks it downloaded", async () => {
    const h = makeHome();
    const dir = path.join(h, ".openclaw", "workspace", "kits", "demo");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "kit.md");
    fs.writeFileSync(file, "# Demo\n");
    const res = await getKit(await loadHandler(), file);
    expect({ status: res.statusCode, body: JSON.parse(res.body) }).toMatchObject({
      status: 200,
      body: { content: "# Demo\n", isDownloaded: true },
    });
  });

  it("serves a bundled recipe from ~/src/tinkerclaw and marks it not downloaded", async () => {
    const h = makeHome();
    const dir = path.join(h, "src", "tinkerclaw", "recipes");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "r.md");
    fs.writeFileSync(file, "# R\n");
    const res = await getKit(await loadHandler(), file);
    expect({ status: res.statusCode, body: JSON.parse(res.body) }).toMatchObject({
      status: 200,
      body: { content: "# R\n", isDownloaded: false },
    });
  });
});
