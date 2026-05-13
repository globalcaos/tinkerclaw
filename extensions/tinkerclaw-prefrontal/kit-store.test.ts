import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { KitStore } from "./kit-store.js";

describe("KitStore", () => {
  let root: string;
  let store: KitStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-kit-"));
    store = new KitStore({ rootDir: root });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("rejects file entries whose path escapes the sandbox", () => {
    expect(() => store.resolveSandboxPath("owner", "slug", "../../etc/passwd")).toThrow(
      /escapes sandbox/,
    );
    expect(() => store.resolveSandboxPath("owner", "slug", "/absolute/path")).toThrow(
      /absolute|escapes/,
    );
  });

  it("accepts plain relative paths", () => {
    const p = store.resolveSandboxPath("o", "s", "subdir/file.md");
    expect(p.startsWith(path.join(root, "o", "s"))).toBe(true);
  });

  it("writeKitFiles persists files inside the sandbox", async () => {
    await store.writeKitFiles({
      owner: "o",
      slug: "s",
      files: [{ path: "kit.md", content: "hello", writeMode: "overwrite" }],
    });
    const written = fs.readFileSync(path.join(root, "o", "s", "kit.md"), "utf-8");
    expect(written).toBe("hello");
  });

  it("list returns inventory of installed kits", async () => {
    await store.writeKitFiles({ owner: "a", slug: "x", files: [{ path: "kit.md", content: "" }] });
    await store.writeKitFiles({ owner: "b", slug: "y", files: [{ path: "kit.md", content: "" }] });
    const entries = await store.list();
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.owner === "a" && e.slug === "x")).toBeTruthy();
  });
});
