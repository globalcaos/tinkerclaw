import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveInsideRoots } from "./index.js";

// Regression: /tinker/api/kit-content and /tinker/api/save-file took an ABSOLUTE path
// as given and only tested `startsWith(root + sep)`, so `<root>/../../secret` escaped —
// a read and a write primitive over HTTP, unauthenticated when device auth is disabled.

let tmp: string;
let root: string;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tinker-roots-")));
  root = path.join(tmp, "root");
  fs.mkdirSync(path.join(root, "kits"), { recursive: true });
  fs.writeFileSync(path.join(root, "kits", "kit.md"), "ok");
  fs.writeFileSync(path.join(tmp, "secret"), "secret");
  fs.symlinkSync(path.join(tmp, "secret"), path.join(root, "escape-link"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("resolveInsideRoots", () => {
  it("allows a real file inside a root, relative or absolute", () => {
    const want = path.join(root, "kits", "kit.md");
    expect(resolveInsideRoots("kits/kit.md", [root])).toBe(want);
    expect(resolveInsideRoots(want, [root])).toBe(want);
  });

  it("allows a path that does not exist yet (writes create it)", () => {
    expect(resolveInsideRoots("kits/new/recipe.md", [root])).toBe(
      path.join(root, "kits", "new", "recipe.md"),
    );
  });

  it("refuses ../ escapes, including the absolute form that used to pass", () => {
    expect(resolveInsideRoots(`${root}/../secret`, [root])).toBeNull();
    expect(resolveInsideRoots("../secret", [root])).toBeNull();
    expect(resolveInsideRoots(`${root}/kits/../../secret`, [root])).toBeNull();
  });

  it("refuses a prefix sibling of the root", () => {
    fs.mkdirSync(`${root}-evil`, { recursive: true });
    expect(resolveInsideRoots(`${root}-evil/x`, [root])).toBeNull();
  });

  it("refuses a symlink that leaves the root", () => {
    expect(resolveInsideRoots(path.join(root, "escape-link"), [root])).toBeNull();
  });

  it("refuses empty paths and NUL bytes", () => {
    expect(resolveInsideRoots("", [root])).toBeNull();
    expect(resolveInsideRoots("kits/kit.md\0.png", [root])).toBeNull();
  });

  it("accepts any of several roots, including one that does not exist yet", () => {
    const pending = path.join(tmp, "overlay");
    expect(resolveInsideRoots(path.join(pending, "r", "recipe.md"), [root, pending])).toBe(
      path.join(pending, "r", "recipe.md"),
    );
  });
});
