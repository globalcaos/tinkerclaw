import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Tests for the cross-session file-lease core. Dependency-free; run with:
//   node --test extensions/tinkerclaw-orca/lease-core.test.mjs
import { test } from "node:test";
import { acquire, release, status, list, gc, renew } from "./lease-core.mjs";

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orca-lease-test-"));
}
const REPO = "/home/x/src/tinkerclaw";
const base = (over = {}) => ({
  repo: REPO,
  path: "extensions/cc-bridge/src/worker.ts",
  owner: "sessA",
  pid: process.pid,
  sessionId: "sessA",
  ttlMs: 300000,
  intent: "edit worker",
  now: 1_000_000,
  isAlive: () => true,
  ...over,
});

test("acquire on a free path wins and writes the holder", () => {
  const root = freshRoot();
  const r = acquire(base({ root }));
  assert.equal(r.allowed, true);
  assert.equal(r.holder.owner, "sessA");
  const s = status({ root, repo: REPO, path: base().path });
  assert.equal(s.held, true);
  assert.equal(s.holder.owner, "sessA");
});

test("a second acquire by a different owner is blocked", () => {
  const root = freshRoot();
  assert.equal(acquire(base({ root, owner: "sessA" })).allowed, true);
  const r = acquire(base({ root, owner: "sessB", sessionId: "sessB" }));
  assert.equal(r.allowed, false);
  assert.equal(r.holder.owner, "sessA");
});

test("re-acquire by the same owner is allowed (idempotent refresh)", () => {
  const root = freshRoot();
  assert.equal(acquire(base({ root, owner: "sessA" })).allowed, true);
  const r = acquire(base({ root, owner: "sessA", now: 1_000_500 }));
  assert.equal(r.allowed, true);
});

test("release by the owner frees the path for others", () => {
  const root = freshRoot();
  assert.equal(acquire(base({ root, owner: "sessA" })).allowed, true);
  const rel = release({ root, repo: REPO, path: base().path, owner: "sessA" });
  assert.equal(rel.released, true);
  assert.equal(acquire(base({ root, owner: "sessB" })).allowed, true);
});

test("release by a non-owner is refused and the lease stays", () => {
  const root = freshRoot();
  assert.equal(acquire(base({ root, owner: "sessA" })).allowed, true);
  const rel = release({ root, repo: REPO, path: base().path, owner: "sessB" });
  assert.equal(rel.released, false);
  assert.equal(status({ root, repo: REPO, path: base().path }).holder.owner, "sessA");
});

test("a TTL-expired lease is stolen by a new owner", () => {
  const root = freshRoot();
  assert.equal(acquire(base({ root, owner: "sessA", now: 1_000_000, ttlMs: 1000 })).allowed, true);
  const r = acquire(base({ root, owner: "sessB", sessionId: "sessB", now: 1_002_000 }));
  assert.equal(r.allowed, true);
  assert.equal(r.holder.owner, "sessB");
});

test("a lease held by a dead pid (same host) is stolen", () => {
  const root = freshRoot();
  assert.equal(acquire(base({ root, owner: "sessA", pid: 999999 })).allowed, true);
  const r = acquire(base({ root, owner: "sessB", sessionId: "sessB", isAlive: () => false }));
  assert.equal(r.allowed, true);
  assert.equal(r.holder.owner, "sessB");
});

test("disjoint paths are independent (no false contention)", () => {
  const root = freshRoot();
  assert.equal(acquire(base({ root, owner: "sessA", path: "a.ts" })).allowed, true);
  assert.equal(acquire(base({ root, owner: "sessB", path: "b.ts" })).allowed, true);
});

test("the same relpath under different repos does not collide", () => {
  const root = freshRoot();
  assert.equal(acquire(base({ root, owner: "sessA", repo: "/r1", path: "x.ts" })).allowed, true);
  assert.equal(acquire(base({ root, owner: "sessB", repo: "/r2", path: "x.ts" })).allowed, true);
});

test("list returns the held paths for a repo; gc reclaims stale ones", () => {
  const root = freshRoot();
  acquire(base({ root, owner: "sessA", path: "a.ts", now: 1_000_000, ttlMs: 1000 }));
  acquire(base({ root, owner: "sessA", path: "b.ts", now: 1_000_000, ttlMs: 999999 }));
  assert.equal(list({ root, repo: REPO }).length, 2);
  const g = gc({ root, repo: REPO, now: 1_002_000, isAlive: () => true });
  assert.equal(g.reclaimed, 1); // only a.ts expired
  assert.equal(list({ root, repo: REPO }).length, 1);
});

test("renew extends a held lease for its owner", () => {
  const root = freshRoot();
  acquire(base({ root, owner: "sessA", now: 1_000_000, ttlMs: 1000 }));
  const rn = renew({
    root,
    repo: REPO,
    path: base().path,
    owner: "sessA",
    now: 1_000_500,
    ttlMs: 5000,
  });
  assert.equal(rn.renewed, true);
  // a would-be-expired-at-1_001_000 lease is now valid at 1_002_000
  const r = acquire(base({ root, owner: "sessB", sessionId: "sessB", now: 1_002_000 }));
  assert.equal(r.allowed, false);
});
