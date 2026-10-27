/**
 * FORK 2026-09-17 — the localstate poller must never read outside its base
 * directory. These specs pin the confinement: relative .json inside the base
 * resolves; absolute paths, `..` traversal, non-.json names and symlinks that
 * escape the base are rejected before any read.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveLocalStateFile } from "./localstate.js";

let root: string;
let base: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-localstate-"));
  base = path.join(root, "online-presence");
  fs.mkdirSync(path.join(base, "sub"), { recursive: true });
  fs.writeFileSync(path.join(base, "state.json"), '{"a":{"b":3}}');
  fs.writeFileSync(path.join(base, "sub", "nested.json"), "{}");
  fs.writeFileSync(path.join(root, "secret.json"), '{"x":1}');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveLocalStateFile", () => {
  it("resolves a .json file inside the base directory", () => {
    expect(resolveLocalStateFile("state.json", base)).toBe(
      fs.realpathSync(path.join(base, "state.json")),
    );
    expect(resolveLocalStateFile("sub/nested.json", base)).toBe(
      fs.realpathSync(path.join(base, "sub", "nested.json")),
    );
  });

  it("rejects .. traversal and absolute paths", () => {
    expect(() => resolveLocalStateFile("../secret.json", base)).toThrow(/outside/);
    expect(() => resolveLocalStateFile("sub/../../secret.json", base)).toThrow(/outside/);
    expect(() => resolveLocalStateFile(path.join(root, "secret.json"), base)).toThrow(
      /relative \.json/,
    );
  });

  it("rejects non-.json files", () => {
    expect(() => resolveLocalStateFile("state.txt", base)).toThrow(/relative \.json/);
  });

  it("rejects a symlink that points outside the base directory", () => {
    fs.symlinkSync(path.join(root, "secret.json"), path.join(base, "link.json"));
    expect(() => resolveLocalStateFile("link.json", base)).toThrow(/outside/);
  });
});
