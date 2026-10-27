import { describe, expect, it } from "vitest";
import { __defaultSpawnForTest, headlessReason } from "./config-open-external.js";

describe("config.openExternalFile", () => {
  it("survives an opener that does not exist (it used to kill the gateway)", async () => {
    const errors: unknown[] = [];
    const onUncaught = (err: unknown) => errors.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      __defaultSpawnForTest("definitely-not-an-opener-9f3a", ["/tmp/x.md"]);
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    expect(errors).toEqual([]);
  });

  it("refuses on a headless Linux host instead of reporting a false ok", () => {
    expect(headlessReason({}, "linux")).toMatch(/no desktop session/);
    expect(headlessReason({ DISPLAY: ":0" }, "linux")).toBeNull();
    expect(headlessReason({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBeNull();
    expect(headlessReason({}, "darwin")).toBeNull();
  });
});

describe("config.readExternalFile (2026-10-15: the browser shows the file)", () => {
  async function call(p: string, workspace: string) {
    const { configOpenExternalHandlers } = await import("./config-open-external.js");
    let out: Record<string, unknown> = {};
    await configOpenExternalHandlers["config.readExternalFile"]({
      params: { path: p },
      context: {
        getRuntimeConfig: () => ({ agents: { defaults: { workspace } } }),
      },
      respond: (_ok: boolean, payload: Record<string, unknown>) => {
        out = payload;
      },
    } as never);
    return out;
  }

  it("returns an allowlisted file's bytes and type", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const ws = mkdtempSync(join(tmpdir(), "read-ext-"));
    writeFileSync(join(ws, "note.md"), "# Hello");
    const r = await call(join(ws, "note.md"), ws);
    expect(r.ok).toBe(true);
    expect(r.mime).toBe("text/markdown");
    expect(Buffer.from(String(r.base64), "base64").toString()).toBe("# Hello");
  });

  it("refuses paths outside the allowlist and traversal", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const ws = mkdtempSync(join(tmpdir(), "read-ext-"));
    expect((await call("/etc/passwd", ws)).error).toBe("outside allowlist");
    expect((await call(`${ws}/../etc/passwd`, ws)).error).toBe("path traversal not allowed");
  });

  it("refuses a file larger than the browser cap", async () => {
    const { mkdtempSync, writeFileSync, truncateSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { READ_EXTERNAL_MAX_BYTES } = await import("./config-open-external.js");
    const ws = mkdtempSync(join(tmpdir(), "read-ext-"));
    const big = join(ws, "big.bin");
    writeFileSync(big, "");
    truncateSync(big, READ_EXTERNAL_MAX_BYTES + 1);
    expect((await call(big, ws)).error).toBe("file too large for the browser");
  });
});
