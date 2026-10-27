import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  existsSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRawStore } from "../src/raw-store.js";
import { ThalamusStore } from "../src/store.js";

const tmp = mkdtempSync(join(tmpdir(), "thalamus-raw-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function make(over: { maxBytes?: number; noStore?: boolean } = {}) {
  const store = new ThalamusStore(":memory:");
  let t = 1000;
  const dir = join(tmp, `raw-${Math.random().toString(36).slice(2)}`);
  const raw = createRawStore({
    dir,
    store: () => (over.noStore ? undefined : store),
    now: () => t,
    maxBytes: over.maxBytes,
  });
  return { raw, store, dir, tick: (n: number) => (t += n) };
}

describe("the raw store", () => {
  it("creates its folders on first use, with private modes, and keeps the text", () => {
    const { raw, dir } = make();
    expect(existsSync(dir)).toBe(false);
    const kept = raw.put({
      session: "agent:main:tinker:a",
      tool: "exec",
      text: "the full result\n".repeat(50),
      tokens: 200,
    })!;
    expect(kept.name).toMatch(/^res-[0-9a-f]{8}-[0-9a-z]+$/);
    expect(readFileSync(kept.path, "utf8")).toBe("the full result\n".repeat(50));
    expect(statSync(kept.path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(kept.path.startsWith(dir)).toBe(true);
    expect(kept.path).not.toContain("agent:main");
  });
  it("the same text is one file", () => {
    const { raw, dir } = make();
    const a = raw.put({ session: "s", tool: "exec", text: "same", tokens: 1 })!;
    const b = raw.put({ session: "s", tool: "exec", text: "same", tokens: 1 })!;
    expect(a.path).toBe(b.path);
    expect(readdirSync(join(dir, readdirSync(dir)[0]))).toHaveLength(1);
  });
  it("hands the full text back by name and counts the recall", () => {
    const { raw, store, tick } = make();
    const k = raw.put({ session: "s", tool: "read", text: "FULL", tokens: 1 })!;
    tick(500);
    expect(raw.recall(k.name)).toBe("FULL");
    expect(store.getRaw(k.name)).toMatchObject({ recalls: 1, lastRecallTs: 1500 });
  });
  it("refuses any name that is not exactly a raw name, before a path is built", () => {
    const { raw } = make();
    for (const bad of [
      "../../etc/passwd",
      "res-zzzzzzzz-1",
      "res-00000000-1/../x",
      "",
      "RES-00000000-1",
      "res-00000000-",
    ]) {
      expect(raw.recall(bad)).toBeUndefined();
    }
  });
  it("refuses a recorded path that points outside its folder", () => {
    const { raw, store } = make();
    const outside = join(tmp, "outside.txt");
    writeFileSync(outside, "SECRET");
    store.putRaw({
      name: "res-deadbeef-1",
      ts: 1,
      session: "s",
      path: outside,
      bytes: 6,
      tokens: 1,
      tool: "x",
    });
    expect(raw.recall("res-deadbeef-1")).toBeUndefined();
  });
  it("does not keep a result over the size cap, and does not keep one without a store", () => {
    expect(
      make({ maxBytes: 10 }).raw.put({ session: "s", tool: "x", text: "x".repeat(50), tokens: 1 }),
    ).toBeUndefined();
    expect(
      make({ noStore: true }).raw.put({ session: "s", tool: "x", text: "hi", tokens: 1 }),
    ).toBeUndefined();
  });
  it("recall of an unknown or vanished file is undefined", () => {
    const { raw } = make();
    expect(raw.recall("res-00000000-1")).toBeUndefined();
    const k = raw.put({ session: "s", tool: "x", text: "gone soon", tokens: 1 })!;
    rmSync(k.path);
    expect(raw.recall(k.name)).toBeUndefined();
  });
  it("prunes old copies and the folders they leave empty, and keeps new ones", () => {
    const { raw, store, dir, tick } = make();
    const old = raw.put({ session: "s1", tool: "x", text: "old", tokens: 1 })!;
    tick(10_000);
    const fresh = raw.put({ session: "s2", tool: "x", text: "fresh", tokens: 1 })!;
    expect(raw.prune(5000)).toBe(1);
    expect(existsSync(old.path)).toBe(false);
    expect(existsSync(fresh.path)).toBe(true);
    expect(store.getRaw(old.name)).toBeUndefined();
    expect(readdirSync(dir)).toHaveLength(1);
  });
});
