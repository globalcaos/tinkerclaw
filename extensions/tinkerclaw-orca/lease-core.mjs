// ORCA cross-session file-lease core — dependency-free, atomic on-disk leases.
//
// Source of truth = one JSON file per (repo, repo-relative path) under
// <root>/<repo-slug>/<path-slug>.lease, created atomically with O_EXCL ("wx").
// Used three ways from ONE source: imported by the tinkerclaw-orca gateway
// plugin (RPCs), executed as a CLI by the Edit/Write PreToolUse hook, and
// (optionally) called by the ORCA workflow's Phase B. So independent agents —
// Claude Code sessions, Jarvis, ORCA runs — serialize per-file with fast
// handoff on ONE working tree: no branches, no merges.
//
// Robust by construction: the gateway is NOT in the path (a down gateway never
// blocks an edit); staleness reclaim (dead pid on same host, or TTL expiry)
// keeps a crashed holder from wedging a file forever.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ROOT = path.join(os.homedir(), ".openclaw", "run", "orca-leases");
export const DEFAULT_TTL_MS = 300_000;

const HOST = os.hostname();

function hash8(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 8);
}

function slug(s) {
  return String(s)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(-160);
}

function repoDir(root, repo) {
  return path.join(root, `${slug(repo)}-${hash8(repo)}`);
}

function leaseFile(root, repo, relPath) {
  return path.join(repoDir(root, repo), `${slug(relPath)}-${hash8(relPath)}.lease`);
}

function readLease(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function defaultIsAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = alive but not ours (still alive).
    return err && err.code === "EPERM";
  }
}

// A held lease is "stale" (reclaimable) when its TTL has elapsed, or when its
// holder process is dead on THIS host (we can't probe a foreign host's pid).
//
// pid-liveness reclaim is OPT-IN: it fires only for a real, positive pid — i.e.
// a long-lived in-process holder (the ORCA workflow run) that anchors the lease
// to its own process. The hook/CLI path records pid 0 because its OWNER is a
// Claude Code SESSION that outlives the ephemeral `node lease-core.mjs` process;
// there is no live pid to probe, so those leases are governed by TTL alone.
// (Without this guard every short-lived CLI acquirer would instantly look
// "dead-pid" and steal every other session's lease — no protection at all.)
function isStale(lease, now, isAlive) {
  if (!lease) return true;
  const ttl = typeof lease.ttlMs === "number" ? lease.ttlMs : DEFAULT_TTL_MS;
  if (now > (lease.acquiredAt ?? 0) + ttl) return true;
  if (
    lease.host === HOST &&
    typeof lease.pid === "number" &&
    lease.pid > 0 &&
    !isAlive(lease.pid)
  ) {
    return true;
  }
  return false;
}

// ── Atomic write primitives ──────────────────────────────────────────────────
// Lease writes MUST be atomic. A plain fs.writeFileSync truncates-then-writes, so
// a concurrent reader can observe an empty/partial file → JSON.parse fails →
// readLease returns null → isStale(null) is true → a LIVE lease gets stolen with
// no TTL expiry and no dead pid. We avoid that entirely:
//   • CREATE  via fs.linkSync — the new record is fully written to a temp file,
//     then linked into place in ONE atomic step that also FAILS (EEXIST) if the
//     slot is taken. That gives O_EXCL-style mutual exclusion AND atomic content.
//   • REPLACE via fs.renameSync — atomic on a single filesystem: a reader sees
//     either the complete old file or the complete new one, never a torn write.
function tmpName(file) {
  return `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
}

/** Create `file` with `data` only if absent. Returns true if created, false if it already existed. */
function atomicCreate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpName(file);
  fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
  try {
    fs.linkSync(tmp, file); // atomic appear-or-EEXIST
    return true;
  } catch (err) {
    if (err && err.code === "EEXIST") return false;
    throw err;
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* temp already gone */
    }
  }
}

/** Atomically replace `file`'s contents with `data` (caller must already hold the right to write). */
function atomicReplace(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpName(file);
  fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
  fs.renameSync(tmp, file); // atomic replace
}

// ── Per-lease critical-section lock ──────────────────────────────────────────
// Atomic writes make individual reads/writes safe, but STEALING a stale lease is
// a read→check→write sequence: two acquirers could both read the same stale lease
// and both decide to steal (double-grant). We serialize that sequence with a
// short-lived O_EXCL lock file per lease. The section is microseconds, contention
// is low (a handful of sessions), and a lock older than LOCK_TTL_MS is reclaimed
// so a crash mid-section can't wedge a file forever.
const LOCK_TTL_MS = 5000;
const LOCK_MAX_WAIT_MS = 6000; // > LOCK_TTL_MS, so a dead holder's lock is always reclaimed within the spin

function sleepMs(ms) {
  // synchronous sleep without busy-spinning the CPU
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `fn` while holding `file`'s exclusive lock. Falls back to running `fn` unlocked only if the lock can't be taken within the bound (a dead-holder edge that the stale reclaim almost always resolves first). */
function withLeaseLock(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx"); // O_EXCL — atomic claim
      try {
        fs.writeSync(fd, String(Date.now()));
      } finally {
        fs.closeSync(fd);
      }
      try {
        return fn();
      } finally {
        try {
          fs.rmSync(lock, { force: true });
        } catch {
          /* already gone */
        }
      }
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      // Lock is held. Reclaim it if stale (holder crashed mid-section).
      try {
        const ts = Number(fs.readFileSync(lock, "utf8"));
        if (!Number.isFinite(ts) || Date.now() - ts > LOCK_TTL_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between EEXIST and read → retry immediately
      }
      if (Date.now() - start > LOCK_MAX_WAIT_MS) return fn(); // give up waiting → best-effort
      sleepMs(2);
    }
  }
}

/**
 * Try to claim (repo, path) for `owner`. Wins if free, already owned by the
 * same owner (idempotent refresh), or currently held by a stale holder.
 * Returns { allowed, holder, leaseFile }.
 */
export function acquire(opts) {
  const {
    repo,
    path: relPath,
    owner,
    pid = process.pid,
    sessionId = owner,
    ttlMs = DEFAULT_TTL_MS,
    intent = "",
    root = DEFAULT_ROOT,
    now = Date.now(),
    isAlive = defaultIsAlive,
  } = opts;
  const file = leaseFile(root, repo, relPath);
  const record = {
    owner,
    pid,
    host: HOST,
    sessionId,
    acquiredAt: now,
    ttlMs,
    intent,
    repo,
    path: relPath,
  };

  // Fast path: a free slot is claimed atomically + exclusively with no lock.
  if (atomicCreate(file, record)) {
    return { allowed: true, holder: record, leaseFile: file };
  }

  // The slot is taken. Resolve refresh-vs-steal-vs-blocked inside the critical
  // section so two acquirers can't both steal the same stale lease.
  return withLeaseLock(file, () => {
    const existing = readLease(file);
    if (!existing) {
      atomicReplace(file, record); // vanished under us → take it (we hold the lock)
      return { allowed: true, holder: record, leaseFile: file };
    }
    if (existing.owner === owner) {
      atomicReplace(file, record); // same owner → refresh
      return { allowed: true, holder: record, leaseFile: file };
    }
    if (isStale(existing, now, isAlive)) {
      atomicReplace(file, record); // steal a stale lease (serialized by the lock)
      return { allowed: true, holder: record, leaseFile: file };
    }
    return { allowed: false, holder: existing, leaseFile: file };
  });
}

/** Release (repo, path) — only the owner may. Returns { released }. */
export function release(opts) {
  const { repo, path: relPath, owner, root = DEFAULT_ROOT } = opts;
  const file = leaseFile(root, repo, relPath);
  const existing = readLease(file);
  if (!existing) return { released: true };
  if (existing.owner !== owner) return { released: false, holder: existing };
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* already gone */
  }
  return { released: true };
}

/**
 * Release EVERY lease held by `owner`, across every repo under the root. This
 * is the Stop-hook primitive: when an agent session ends, free everything it
 * still holds in one sweep so no file stays wedged for the next session.
 * Returns { released } (count). Other owners' leases are untouched.
 */
export function releaseAllByOwner(opts) {
  const { owner, root = DEFAULT_ROOT } = opts;
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { released: 0 };
  }
  let released = 0;
  for (const ent of dirs) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(root, ent.name);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".lease")) continue;
      const file = path.join(dir, name);
      const lease = readLease(file);
      if (lease && lease.owner === owner) {
        try {
          fs.rmSync(file, { force: true });
          released += 1;
        } catch {
          /* race: already gone */
        }
      }
    }
  }
  return { released };
}

/** Current holder of (repo, path), if any. Returns { held, holder }. */
export function status(opts) {
  const { repo, path: relPath, root = DEFAULT_ROOT } = opts;
  const existing = readLease(leaseFile(root, repo, relPath));
  return existing ? { held: true, holder: existing } : { held: false };
}

/** All currently-held leases for a repo. Returns [{ path, holder }]. */
export function list(opts) {
  const { repo, root = DEFAULT_ROOT } = opts;
  const dir = repoDir(root, repo);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".lease")) continue;
    const holder = readLease(path.join(dir, name));
    if (holder) out.push({ path: holder.path, holder });
  }
  return out;
}

function reclaimStaleInDir(dir, now, isAlive) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let reclaimed = 0;
  for (const name of names) {
    if (!name.endsWith(".lease")) continue;
    const file = path.join(dir, name);
    if (!isStale(readLease(file), now, isAlive)) continue; // cheap pre-check
    // Re-check under the lock so we never evict a lease an acquirer just
    // refreshed in the window between our read and our remove.
    const removed = withLeaseLock(file, () => {
      if (!isStale(readLease(file), now, isAlive)) return false;
      try {
        fs.rmSync(file, { force: true });
        return true;
      } catch {
        return false; // already gone
      }
    });
    if (removed) reclaimed += 1;
  }
  return reclaimed;
}

/** Reclaim stale leases for one repo. Returns { reclaimed }. */
export function gc(opts) {
  const { repo, root = DEFAULT_ROOT, now = Date.now(), isAlive = defaultIsAlive } = opts;
  return { reclaimed: reclaimStaleInDir(repoDir(root, repo), now, isAlive) };
}

/** Reclaim stale leases across EVERY repo under the root (the janitor sweep). */
export function gcAll(opts = {}) {
  const { root = DEFAULT_ROOT, now = Date.now(), isAlive = defaultIsAlive } = opts;
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { reclaimed: 0 };
  }
  let reclaimed = 0;
  for (const ent of dirs) {
    if (ent.isDirectory()) {
      reclaimed += reclaimStaleInDir(path.join(root, ent.name), now, isAlive);
    }
  }
  return { reclaimed };
}

/** Extend a held lease for its owner. Returns { renewed }. */
export function renew(opts) {
  const {
    repo,
    path: relPath,
    owner,
    ttlMs = DEFAULT_TTL_MS,
    root = DEFAULT_ROOT,
    now = Date.now(),
  } = opts;
  const file = leaseFile(root, repo, relPath);
  return withLeaseLock(file, () => {
    const existing = readLease(file);
    if (!existing || existing.owner !== owner) return { renewed: false };
    atomicReplace(file, { ...existing, acquiredAt: now, ttlMs });
    return { renewed: true };
  });
}

// ───────────────────────────────────────────────────────────────────────────
// CLI — `node lease-core.mjs <cmd> --repo R --path P --owner O [--ttl MS] …`
//
// This is the contract the Edit/Write PreToolUse hook depends on. ONE source of
// truth: the hook runs this exact file as a subprocess; the gateway plugin
// imports the same functions. Output is ALWAYS JSON to stdout. Exit codes:
//   0 = allowed / ok        (acquire won, or a non-acquire command succeeded)
//   3 = lease DENIED        (acquire blocked by another live owner)
//   1 = usage / infra error (bad args, unknown command, exception)
// The hook treats 3 as a real "no" (deny/warn) and 1/other as fail-OPEN (allow).
// ───────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true; // bare flag
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

/** Dispatch one CLI invocation. Returns the process exit code. */
export function runCli(argv) {
  const cmd = argv[0];
  const a = parseArgs(argv.slice(1));
  const root = typeof a.root === "string" ? a.root : DEFAULT_ROOT;
  const ttlMs = typeof a.ttl === "string" ? Number(a.ttl) : DEFAULT_TTL_MS;
  // Default pid 0 → TTL-governed (the owner is a session, not this node process).
  // Pass --pid N to anchor pid-liveness to a real long-lived holder.
  const pid = typeof a.pid === "string" ? Number(a.pid) : 0;
  const need = (...keys) => {
    for (const k of keys) {
      if (typeof a[k] !== "string" || !a[k]) throw new Error(`missing required --${k}`);
    }
  };

  switch (cmd) {
    case "acquire": {
      need("repo", "path", "owner");
      const r = acquire({
        repo: a.repo,
        path: a.path,
        owner: a.owner,
        sessionId: typeof a.session === "string" ? a.session : a.owner,
        pid,
        ttlMs,
        intent: typeof a.intent === "string" ? a.intent : "",
        root,
      });
      emit(r);
      return r.allowed ? 0 : 3;
    }
    case "release": {
      need("repo", "path", "owner");
      emit(release({ repo: a.repo, path: a.path, owner: a.owner, root }));
      return 0;
    }
    case "release-all": {
      need("owner");
      emit(releaseAllByOwner({ owner: a.owner, root }));
      return 0;
    }
    case "renew": {
      need("repo", "path", "owner");
      emit(renew({ repo: a.repo, path: a.path, owner: a.owner, ttlMs, root }));
      return 0;
    }
    case "status": {
      need("repo", "path");
      emit(status({ repo: a.repo, path: a.path, root }));
      return 0;
    }
    case "list": {
      need("repo");
      const leases = list({ repo: a.repo, root });
      emit({ leases, count: leases.length });
      return 0;
    }
    case "gc": {
      need("repo");
      emit(gc({ repo: a.repo, root }));
      return 0;
    }
    case "gc-all": {
      emit(gcAll({ root }));
      return 0;
    }
    default:
      throw new Error(`unknown command: ${cmd ?? "(none)"}`);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (err) {
    emit({ error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  }
}
