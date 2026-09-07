import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Skill } from "@mariozechner/pi-coding-agent";
import { writeTextAtomic } from "../../infra/json-files.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SessionEntry, SessionSkillSnapshot } from "./types.js";

/**
 * FORK 2026-09-03 — content-addressed skills snapshots.
 *
 * PROBLEM (measured on the live store, 2026-09-03): `sessions.json` was 10.32 MB
 * across 138 entries and 7.02 MB of that was `skillsSnapshot`, copied
 * near-verbatim into 106 of them — only **13 distinct** snapshot objects existed,
 * so 6.16 MB was pure duplication (`resolvedSkills` 5.67 MB, `prompt` 1.09 MB).
 * Every session-store update re-serialises and rewrites the whole file while
 * holding `sessions.json.lock`; that lock was observed held 80–141 s six times in
 * one day (cap: 15 000 ms), and sends waited 1–4 min before reaching the model
 * (stage=bootstrap-routing ms=119209, stage=mcp-catalog ms=144384).
 *
 * FIX: at the store layer only, replace the two heavy fields with a 16-hex
 * content address and keep each distinct payload once under
 * `<agentDir>/skills-snapshots/` — `prompt` in `<sha>.txt`, `resolvedSkills` in
 * `<sha>.json`. Hydration puts them back on load, so **no reader changes**.
 * Measured on the live store: 10.32 MB -> 2.18 MB (-78.9 %), 7 sidecars totalling
 * 0.24 MB. Externalising `prompt` alone would have recovered only 10.5 %.
 *
 * INVARIANT: `hydrate(externalize(x))` deep-equals `x`. A legacy entry with an
 * inline `prompt` is returned by identity from both directions, and a ref whose
 * sidecar is missing hydrates to `prompt: ""` with one warning — never a throw,
 * because a session store that fails to load takes the gateway with it.
 *
 * Sidecars are immutable and content-addressed: writes are idempotent, and two
 * processes racing on the same address write identical bytes through
 * `writeTextAtomic`'s tmp+rename. They are never garbage-collected here — the set
 * is bounded by the number of distinct skill catalogues (7 live, ~35 KB each).
 * A sweeper belongs with session pruning, not on the write path.
 */

const log = createSubsystemLogger("sessions/skills-snapshot");

/**
 * On-disk shape of a snapshot: the heavy fields may be absent, replaced by a ref.
 * The in-memory {@link SessionSkillSnapshot} is deliberately unchanged — `prompt`
 * stays a required string for every reader.
 */
export type PersistedSessionSkillSnapshot = Omit<SessionSkillSnapshot, "prompt"> & {
  prompt?: string;
};

export const SKILLS_SNAPSHOT_DIR_NAME = "skills-snapshots";

/** Length of the sha256 hex prefix used as the content address. */
const REF_HEX_LENGTH = 16;
const REF_PATTERN = /^[0-9a-f]{16}$/;

/**
 * Below this a sidecar costs more than it saves (a filesystem block, an inode, a
 * stat on every save). Empty prompts and small test fixtures stay inline. Every
 * distinct payload on the live store is far above it (smallest ~8 KB).
 */
export const MIN_EXTERNALIZED_SNAPSHOT_BYTES = 1024;

/** Distinct payloads are few (7 on the live store); this only has to beat re-reads. */
const REF_CACHE_MAX_ENTRIES = 32;

/** filePath -> payload text. "" also caches a *known-missing* ref, so we warn once. */
const REF_CACHE = new Map<string, string>();

/** filePaths of sidecars this process has already confirmed present on disk. */
const WRITTEN_REFS = new Set<string>();

export function clearSkillsSnapshotRefCacheForTest(): void {
  REF_CACHE.clear();
  WRITTEN_REFS.clear();
}

/**
 * Externalisation is opt-in until `store-load.ts` hydrates too: the primary
 * consumer chain (`agents/command/session.ts` -> `agent-command.ts`) imports
 * `loadSessionStore` from `store-load.js` directly, bypassing `store.ts`, and
 * would silently lose the skills prompt. Hydration, by contrast, is ALWAYS on, so
 * a store written while the flag was set still reads back correctly after it is
 * cleared — a rollback must never strand data.
 */
export function isSkillsSnapshotExternalizationEnabled(): boolean {
  const raw = process.env.OPENCLAW_SESSIONS_SKILLS_SNAPSHOT_REFS?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/**
 * `<agentDir>/sessions/sessions.json` -> `<agentDir>/skills-snapshots`.
 *
 * A SIBLING of `sessions/` on purpose: the transcript archive/prune sweepers are
 * scoped to the store directory (`restrictToStoreDir`), so sidecars parked next
 * to the store would eventually look like orphaned session files. Any layout that
 * is not `<dir>/sessions/<file>` keeps the sidecars beside the store instead of
 * escaping into its parent — an ad-hoc test store must never write to `/tmp`.
 */
export function resolveSkillsSnapshotDir(storePath: string): string {
  const storeDir = path.dirname(path.resolve(storePath));
  const base = path.basename(storeDir) === "sessions" ? path.dirname(storeDir) : storeDir;
  return path.join(base, SKILLS_SNAPSHOT_DIR_NAME);
}

function contentRef(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, REF_HEX_LENGTH);
}

function isValidRef(ref: unknown): ref is string {
  return typeof ref === "string" && REF_PATTERN.test(ref);
}

function rememberRefPayload(filePath: string, text: string): void {
  REF_CACHE.delete(filePath);
  REF_CACHE.set(filePath, text);
  while (REF_CACHE.size > REF_CACHE_MAX_ENTRIES) {
    const oldest = REF_CACHE.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    REF_CACHE.delete(oldest);
  }
}

function readRefPayload(filePath: string): string {
  const cached = REF_CACHE.get(filePath);
  if (cached !== undefined) {
    // Touch for LRU recency.
    REF_CACHE.delete(filePath);
    REF_CACHE.set(filePath, cached);
    return cached;
  }
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    // Caching the miss is what makes this warn once per ref per process rather
    // than once per entry per load (106 entries share 7 payloads).
    log.warn("skills snapshot sidecar missing; hydrating empty", {
      filePath,
      code: (err as NodeJS.ErrnoException | null)?.code,
    });
    text = "";
  }
  rememberRefPayload(filePath, text);
  return text;
}

async function ensureRefFile(filePath: string, text: string): Promise<void> {
  if (WRITTEN_REFS.has(filePath)) {
    return;
  }
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile() && stat.size > 0) {
      WRITTEN_REFS.add(filePath);
      return;
    }
  } catch {
    // Missing or unreadable — (re)write it below.
  }
  await writeTextAtomic(filePath, text, { mode: 0o600, ensureDirMode: 0o700 });
  WRITTEN_REFS.add(filePath);
  rememberRefPayload(filePath, text);
}

function parseResolvedSkills(raw: string, filePath: string): Skill[] | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed as Skill[];
    }
    log.warn("skills snapshot sidecar is not an array; dropping resolvedSkills", { filePath });
    return undefined;
  } catch {
    log.warn("skills snapshot sidecar is not valid JSON; dropping resolvedSkills", { filePath });
    return undefined;
  }
}

/**
 * Replace the heavy fields of one snapshot with refs, writing each distinct
 * payload exactly once. Returns the input by identity when there is nothing worth
 * externalising, so callers can cheaply detect "no change".
 */
export async function externalizeSkillsSnapshot(params: {
  storePath: string;
  snapshot: SessionSkillSnapshot | PersistedSessionSkillSnapshot;
}): Promise<PersistedSessionSkillSnapshot> {
  const snapshot = params.snapshot as PersistedSessionSkillSnapshot;
  const dir = resolveSkillsSnapshotDir(params.storePath);
  let next: PersistedSessionSkillSnapshot | null = null;

  const prompt = snapshot.prompt;
  if (
    typeof prompt === "string" &&
    Buffer.byteLength(prompt, "utf8") >= MIN_EXTERNALIZED_SNAPSHOT_BYTES
  ) {
    const ref = contentRef(prompt);
    await ensureRefFile(path.join(dir, `${ref}.txt`), prompt);
    next = { ...snapshot, promptRef: ref };
    delete next.prompt;
  }

  const resolvedSkills = snapshot.resolvedSkills;
  if (Array.isArray(resolvedSkills) && resolvedSkills.length > 0) {
    const json = JSON.stringify(resolvedSkills);
    if (Buffer.byteLength(json, "utf8") >= MIN_EXTERNALIZED_SNAPSHOT_BYTES) {
      const ref = contentRef(json);
      await ensureRefFile(path.join(dir, `${ref}.json`), json);
      next = { ...(next ?? snapshot), resolvedSkillsRef: ref };
      delete next.resolvedSkills;
    }
  }

  return next ?? snapshot;
}

/**
 * Inverse of {@link externalizeSkillsSnapshot}. Returns the input by identity for
 * a legacy inline entry (or one whose refs are unusable), so callers can cheaply
 * detect "nothing to do".
 */
export function hydrateSkillsSnapshot(params: {
  storePath: string;
  snapshot: PersistedSessionSkillSnapshot;
}): SessionSkillSnapshot {
  const snapshot = params.snapshot;
  const needsPrompt = typeof snapshot.prompt !== "string" && isValidRef(snapshot.promptRef);
  const needsSkills =
    snapshot.resolvedSkills === undefined && isValidRef(snapshot.resolvedSkillsRef);
  if (!needsPrompt && !needsSkills) {
    return snapshot as SessionSkillSnapshot;
  }
  const dir = resolveSkillsSnapshotDir(params.storePath);
  const next: PersistedSessionSkillSnapshot = { ...snapshot };
  if (needsPrompt) {
    next.prompt = readRefPayload(path.join(dir, `${snapshot.promptRef}.txt`));
    delete next.promptRef;
  }
  if (needsSkills) {
    const filePath = path.join(dir, `${snapshot.resolvedSkillsRef}.json`);
    const parsed = parseResolvedSkills(readRefPayload(filePath), filePath);
    if (parsed) {
      next.resolvedSkills = parsed;
    } else {
      delete next.resolvedSkills;
    }
    delete next.resolvedSkillsRef;
  }
  // `prompt` is required by the in-memory type. A snapshot that never had one, or
  // whose sidecar vanished, hydrates to "" — never undefined.
  return { ...next, prompt: next.prompt ?? "" };
}

/**
 * Persist-view of a whole store: a shallow copy in which every entry's snapshot
 * has been externalised. The caller's `store` is NOT mutated, so the in-memory
 * object cache and every live reader keep the hydrated values.
 */
export async function externalizeSessionStoreSkillsSnapshots(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
}): Promise<Record<string, SessionEntry>> {
  if (!isSkillsSnapshotExternalizationEnabled()) {
    return params.store;
  }
  let next: Record<string, SessionEntry> | null = null;
  for (const [key, entry] of Object.entries(params.store)) {
    const snapshot = entry?.skillsSnapshot as PersistedSessionSkillSnapshot | undefined;
    if (!snapshot) {
      continue;
    }
    const persisted = await externalizeSkillsSnapshot({ storePath: params.storePath, snapshot });
    if (persisted === snapshot) {
      continue;
    }
    next ??= { ...params.store };
    next[key] = { ...entry, skillsSnapshot: persisted as SessionSkillSnapshot };
  }
  return next ?? params.store;
}

/**
 * Hydrate every entry of a freshly loaded store, in place. In place is
 * deliberate: `loadSessionStore(..., { clone: false })` hands back the cached
 * object itself, so hydrating once keeps every later cache hit hydrated.
 */
export function hydrateSessionStoreSkillsSnapshots(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
}): Record<string, SessionEntry> {
  for (const [key, entry] of Object.entries(params.store)) {
    const snapshot = entry?.skillsSnapshot as PersistedSessionSkillSnapshot | undefined;
    if (!snapshot) {
      continue;
    }
    const hydrated = hydrateSkillsSnapshot({ storePath: params.storePath, snapshot });
    if (hydrated === snapshot) {
      continue;
    }
    params.store[key] = { ...entry, skillsSnapshot: hydrated };
  }
  return params.store;
}
