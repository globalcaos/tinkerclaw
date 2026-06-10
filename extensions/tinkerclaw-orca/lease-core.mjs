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
function isStale(lease, now, isAlive) {
  if (!lease) return true;
  const ttl = typeof lease.ttlMs === "number" ? lease.ttlMs : DEFAULT_TTL_MS;
  if (now > (lease.acquiredAt ?? 0) + ttl) return true;
  if (lease.host === HOST && !isAlive(lease.pid)) return true;
  return false;
}

function writeLease(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data), "utf8");
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

  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
    return { allowed: true, holder: record, leaseFile: file };
  } catch (err) {
    if (!err || err.code !== "EEXIST") throw err;
  }

  const existing = readLease(file);
  if (existing && existing.owner === owner) {
    writeLease(file, record); // same owner → refresh
    return { allowed: true, holder: record, leaseFile: file };
  }
  if (isStale(existing, now, isAlive)) {
    writeLease(file, record); // steal a stale lease
    return { allowed: true, holder: record, leaseFile: file };
  }
  return { allowed: false, holder: existing, leaseFile: file };
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
    if (isStale(readLease(file), now, isAlive)) {
      try {
        fs.rmSync(file, { force: true });
        reclaimed += 1;
      } catch {
        /* race: already gone */
      }
    }
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
  const existing = readLease(file);
  if (!existing || existing.owner !== owner) return { renewed: false };
  writeLease(file, { ...existing, acquiredAt: now, ttlMs });
  return { renewed: true };
}
