import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Tests for the cross-session file-lease core. Dependency-free; run with:
//   node --test extensions/tinkerclaw-orca/lease-core.test.mjs
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  acquire,
  release,
  releaseAllByOwner,
  status,
  list,
  gc,
  gcAll,
  renew,
} from "./lease-core.mjs";

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orca-lease-test-"));
}
const REPO = "/home/x/src/tinkerclaw";
const base = (over = {}) => ({
  repo: REPO,
  path: "extensions/tinker-bridge/src/worker.ts",
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

test("re-acquire by the same owner RESETS the TTL clock (refresh, not just allowed)", () => {
  const root = freshRoot();
  acquire(base({ root, owner: "sessA", now: 1_000_000, ttlMs: 1000 })); // expires at 1_001_000
  acquire(base({ root, owner: "sessA", now: 1_000_900, ttlMs: 1000 })); // refresh → expires at 1_001_900
  // At 1_001_500 the ORIGINAL lease would have expired, but the refresh moved it.
  const r = acquire(base({ root, owner: "sessB", sessionId: "sessB", now: 1_001_500 }));
  assert.equal(r.allowed, false); // still held because the refresh advanced acquiredAt
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

test("a lease with pid 0 (ephemeral owner) is governed by TTL only, not pid-liveness", () => {
  const root = freshRoot();
  // The hook/CLI path records pid 0: the OWNER is a session that outlives the
  // short-lived `node lease-core.mjs` process, so there is no live pid to probe.
  // A fresh-TTL lease must NOT be reclaimable just because "pid 0 isn't alive" —
  // otherwise every ephemeral acquirer would instantly steal every other's lease.
  assert.equal(acquire(base({ root, owner: "sessA", pid: 0, now: 1_000_000 })).allowed, true);
  const r = acquire(
    base({
      root,
      owner: "sessB",
      sessionId: "sessB",
      pid: 0,
      now: 1_000_500, // well within the 300s TTL
      isAlive: () => false,
    }),
  );
  assert.equal(r.allowed, false); // not stale: TTL not elapsed + pid-liveness skipped
  assert.equal(r.holder.owner, "sessA");
});

test("a pid-0 lease IS still reclaimed once its TTL elapses", () => {
  const root = freshRoot();
  assert.equal(
    acquire(base({ root, owner: "sessA", pid: 0, now: 1_000_000, ttlMs: 1000 })).allowed,
    true,
  );
  const r = acquire(base({ root, owner: "sessB", sessionId: "sessB", pid: 0, now: 1_002_000 }));
  assert.equal(r.allowed, true); // TTL elapsed → stealable even with pid-liveness disabled
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

test("gcAll reclaims stale leases across every repo under the root", () => {
  const root = freshRoot();
  acquire(base({ root, repo: "/r1", path: "a.ts", now: 1_000_000, ttlMs: 1000 }));
  acquire(base({ root, repo: "/r2", path: "b.ts", now: 1_000_000, ttlMs: 999999 }));
  const g = gcAll({ root, now: 1_002_000, isAlive: () => true });
  assert.equal(g.reclaimed, 1); // r1/a.ts expired; r2/b.ts still valid
  assert.equal(list({ root, repo: "/r1" }).length, 0);
  assert.equal(list({ root, repo: "/r2" }).length, 1);
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

// ── releaseAllByOwner: the Stop-hook primitive (free everything a session held) ──

test("releaseAllByOwner frees every lease an owner holds across all repos, leaving others", () => {
  const root = freshRoot();
  acquire(base({ root, owner: "sessA", repo: "/r1", path: "a.ts" }));
  acquire(base({ root, owner: "sessA", repo: "/r1", path: "b.ts" }));
  acquire(base({ root, owner: "sessA", repo: "/r2", path: "c.ts" }));
  acquire(base({ root, owner: "sessB", sessionId: "sessB", repo: "/r1", path: "d.ts" }));
  const res = releaseAllByOwner({ root, owner: "sessA" });
  assert.equal(res.released, 3);
  assert.equal(list({ root, repo: "/r1" }).length, 1); // only sessB's d.ts remains
  assert.equal(list({ root, repo: "/r2" }).length, 0);
  assert.equal(status({ root, repo: "/r1", path: "d.ts" }).holder.owner, "sessB");
});

test("releaseAllByOwner for an owner holding nothing releases zero and disturbs nothing", () => {
  const root = freshRoot();
  acquire(base({ root, owner: "sessB", sessionId: "sessB", repo: "/r1", path: "d.ts" }));
  const res = releaseAllByOwner({ root, owner: "ghost" });
  assert.equal(res.released, 0);
  assert.equal(list({ root, repo: "/r1" }).length, 1);
});

// ── CLI dispatcher: the exact contract the PreToolUse hook depends on ──
//   exit 0 = allowed/ok, exit 3 = lease DENIED, exit 1 = usage/infra error
//   (the hook denies on 3, fail-OPENs on 1/other). Output is always JSON to stdout.

const CLI = fileURLToPath(new URL("./lease-core.mjs", import.meta.url));
function cli(args, root) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--root", root], { encoding: "utf8" });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* leave null so assertions surface the bad output */
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

test("CLI acquire on a free path exits 0 and prints allowed:true", () => {
  const root = freshRoot();
  const r = cli(["acquire", "--repo", "/r1", "--path", "x.ts", "--owner", "s1"], root);
  assert.equal(r.code, 0);
  assert.equal(r.json.allowed, true);
  assert.equal(r.json.holder.owner, "s1");
});

test("CLI acquire on a path held by another owner exits 3 and prints allowed:false", () => {
  const root = freshRoot();
  cli(["acquire", "--repo", "/r1", "--path", "x.ts", "--owner", "s1"], root);
  const r = cli(["acquire", "--repo", "/r1", "--path", "x.ts", "--owner", "s2"], root);
  assert.equal(r.code, 3);
  assert.equal(r.json.allowed, false);
  assert.equal(r.json.holder.owner, "s1");
});

test("CLI release-all frees every lease the owner holds and exits 0", () => {
  const root = freshRoot();
  cli(["acquire", "--repo", "/r1", "--path", "x.ts", "--owner", "s1"], root);
  cli(["acquire", "--repo", "/r2", "--path", "y.ts", "--owner", "s1"], root);
  const r = cli(["release-all", "--owner", "s1"], root);
  assert.equal(r.code, 0);
  assert.equal(r.json.released, 2);
  const a = cli(["acquire", "--repo", "/r1", "--path", "x.ts", "--owner", "s2"], root);
  assert.equal(a.json.allowed, true); // freed → another owner can take it
});

test("CLI status reports the current holder and exits 0", () => {
  const root = freshRoot();
  cli(["acquire", "--repo", "/r1", "--path", "x.ts", "--owner", "s1"], root);
  const r = cli(["status", "--repo", "/r1", "--path", "x.ts"], root);
  assert.equal(r.code, 0);
  assert.equal(r.json.held, true);
  assert.equal(r.json.holder.owner, "s1");
});

test("CLI release frees one path for the owner and exits 0", () => {
  const root = freshRoot();
  cli(["acquire", "--repo", "/r1", "--path", "x.ts", "--owner", "s1"], root);
  const r = cli(["release", "--repo", "/r1", "--path", "x.ts", "--owner", "s1"], root);
  assert.equal(r.code, 0);
  assert.equal(r.json.released, true);
  assert.equal(cli(["status", "--repo", "/r1", "--path", "x.ts"], root).json.held, false);
});

test("CLI list reports held paths with a count and exits 0", () => {
  const root = freshRoot();
  cli(["acquire", "--repo", "/r1", "--path", "x.ts", "--owner", "s1"], root);
  cli(["acquire", "--repo", "/r1", "--path", "y.ts", "--owner", "s1"], root);
  const r = cli(["list", "--repo", "/r1"], root);
  assert.equal(r.code, 0);
  assert.equal(r.json.count, 2);
});

test("CLI gc-all exits 0 and reports a reclaimed count", () => {
  const root = freshRoot();
  cli(["acquire", "--repo", "/r1", "--path", "x.ts", "--owner", "s1", "--ttl", "1"], root);
  // ttl=1ms → already stale on the next tick; gc-all reclaims it.
  const r = cli(["gc-all"], root);
  assert.equal(r.code, 0);
  assert.equal(typeof r.json.reclaimed, "number");
});

test("CLI renew on a held lease for its owner exits 0 and reports renewed:true", () => {
  const root = freshRoot();
  cli(["acquire", "--repo", "/r1", "--path", "x.ts", "--owner", "s1"], root);
  const r = cli(
    ["renew", "--repo", "/r1", "--path", "x.ts", "--owner", "s1", "--ttl", "60000"],
    root,
  );
  assert.equal(r.code, 0);
  assert.equal(r.json.renewed, true);
});

test("CLI gc reclaims stale leases for one repo and exits 0", () => {
  const root = freshRoot();
  cli(["acquire", "--repo", "/r1", "--path", "x.ts", "--owner", "s1", "--ttl", "1"], root);
  const r = cli(["gc", "--repo", "/r1"], root);
  assert.equal(r.code, 0);
  assert.equal(typeof r.json.reclaimed, "number");
});

test("CLI --pid anchors pid-liveness: an explicit dead pid is reclaimable immediately", () => {
  const root = freshRoot();
  // s1 anchors the lease to pid 999999 (a real positive pid, dead on this host).
  cli(["acquire", "--repo", "/r1", "--path", "x.ts", "--owner", "s1", "--pid", "999999"], root);
  // s2 (default pid 0) should STEAL it — pid-liveness reclaim fires for the dead pid.
  const r = cli(["acquire", "--repo", "/r1", "--path", "x.ts", "--owner", "s2"], root);
  assert.equal(r.code, 0);
  assert.equal(r.json.allowed, true);
  assert.equal(r.json.holder.owner, "s2");
});

// ── Atomicity under TRUE process concurrency — the mutual-exclusion guarantee ──
// Spawns N real `node lease-core.mjs acquire` processes at once against ONE
// already-stale lease. The lease's whole reason to exist is that AT MOST ONE
// acquirer may win. (On a non-atomic steal this yields many winners.)

function acquireAsync(args, root) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args, "--root", root], { encoding: "utf8" });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", (code) => {
      let json = null;
      try {
        json = JSON.parse(out);
      } catch {
        /* leave null */
      }
      resolve({ code, json });
    });
  });
}

async function raceWinners(root, pathName, N, seedStale) {
  if (seedStale) {
    cli(["acquire", "--repo", "/r", "--path", pathName, "--owner", "seed", "--ttl", "1"], root);
    await new Promise((r) => setTimeout(r, 20)); // let the 1ms TTL elapse
  }
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      acquireAsync(["acquire", "--repo", "/r", "--path", pathName, "--owner", `s${i}`], root),
    ),
  );
  return results.filter((r) => r.json && r.json.allowed === true).length;
}

test("concurrent acquirers of one STALE lease yield EXACTLY ONE winner each round (atomic steal)", async () => {
  // Multiple rounds: a single round only races ~13% of the time, so loop to make
  // the non-atomic steal reliably visible. The link-based fix is deterministically 1.
  for (let round = 0; round < 8; round += 1) {
    const root = freshRoot();
    const winners = await raceWinners(root, `x${round}.ts`, 64, true);
    assert.equal(winners, 1, `round ${round}: expected exactly 1 winner, got ${winners}`);
  }
});

test("concurrent acquirers of one FREE path yield EXACTLY ONE winner each round (atomic claim)", async () => {
  for (let round = 0; round < 8; round += 1) {
    const root = freshRoot();
    const winners = await raceWinners(root, `fresh${round}.ts`, 64, false);
    assert.equal(winners, 1, `round ${round}: expected exactly 1 winner, got ${winners}`);
  }
});

test("CLI with missing required args exits 1 (usage error → hook fails open)", () => {
  const root = freshRoot();
  const r = cli(["acquire", "--repo", "/r1"], root); // no --path / --owner
  assert.equal(r.code, 1);
});

test("CLI with an unknown command exits 1 (usage error → hook fails open)", () => {
  const root = freshRoot();
  const r = cli(["frobnicate", "--repo", "/r1"], root);
  assert.equal(r.code, 1);
});
