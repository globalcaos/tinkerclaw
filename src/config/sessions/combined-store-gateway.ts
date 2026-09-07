import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  canonicalizeSpawnedByForAgent,
  resolveStoredSessionKeyForAgentStore,
} from "../../gateway/session-store-key.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { getFileStatSnapshot } from "../cache-utils.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveStorePath } from "./paths.js";
import { loadSessionStore } from "./store-load.js";
import { resolveAllAgentSessionStoreTargetsSync } from "./targets.js";
import type { SessionEntry } from "./types.js";

function isStorePathTemplate(store?: string): boolean {
  return typeof store === "string" && store.includes("{agentId}");
}

function mergeSessionEntryIntoCombined(params: {
  cfg: OpenClawConfig;
  combined: Record<string, SessionEntry>;
  entry: SessionEntry;
  agentId: string;
  canonicalKey: string;
}) {
  const { cfg, combined, entry, agentId, canonicalKey } = params;
  const existing = combined[canonicalKey];

  if (existing && (existing.updatedAt ?? 0) > (entry.updatedAt ?? 0)) {
    combined[canonicalKey] = {
      ...entry,
      ...existing,
      spawnedBy: canonicalizeSpawnedByForAgent(cfg, agentId, existing.spawnedBy ?? entry.spawnedBy),
    };
  } else {
    combined[canonicalKey] = {
      ...existing,
      ...entry,
      spawnedBy: canonicalizeSpawnedByForAgent(
        cfg,
        agentId,
        entry.spawnedBy ?? existing?.spawnedBy,
      ),
    };
  }
}

/**
 * Memo for the COMBINED map, keyed on the identity of every store file it was derived from.
 *
 * FORK 2026-08-15 — see TINKER_UI_DESIGN_BIBLE/turn-latency.md. `loadSessionStore` already
 * caches the parse per file (mtime+size), but the merge on top of it — resolve a canonical
 * key and fold an entry, once per session — was redone on EVERY call. With 683 sessions and
 * the right-rail panels polling `sessions.usage` / `sessions.list` on a clock, that CPU lands
 * on the gateway's single event loop, the same loop that dispatches turns. Measured event-loop
 * delay on 2026-08-14: p90 8.7s, max 45.1s, with 17% of intervals at >=0.95 utilization.
 *
 * This is NOT a staleness tradeoff. The combined map is a pure function of the store files, so
 * the memo is keyed on their (path, mtimeMs, sizeBytes) — any write invalidates it on the next
 * call, exactly as the underlying parse cache already behaves. A turn that writes the store
 * still sees its own write.
 *
 * The top-level map is copied out per call so callers keep today's "this object is mine"
 * semantics; entry objects are shared, which they already were under `clone: false`.
 */
let combinedMemo: {
  signature: string;
  storePath: string;
  store: Record<string, SessionEntry>;
} | null = null;

function storeFilesSignature(paths: string[]): string {
  const parts: string[] = [];
  for (const p of paths) {
    const s = getFileStatSnapshot(p);
    parts.push(`${p}:${s?.mtimeMs ?? 0}:${s?.sizeBytes ?? 0}`);
  }
  return parts.join("|");
}

/** Test seam: drop the memo so a test that rewrites a store file mid-run is not fooled. */
export function resetCombinedSessionStoreMemoForTest(): void {
  combinedMemo = null;
}

export function loadCombinedSessionStoreForGateway(cfg: OpenClawConfig): {
  storePath: string;
  store: Record<string, SessionEntry>;
} {
  const storeConfig = cfg.session?.store;
  if (storeConfig && !isStorePathTemplate(storeConfig)) {
    const storePath = resolveStorePath(storeConfig);
    const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
    const store = loadSessionStore(storePath, { clone: false });
    const combined: Record<string, SessionEntry> = {};
    for (const [key, entry] of Object.entries(store)) {
      const canonicalKey = resolveStoredSessionKeyForAgentStore({
        cfg,
        agentId: defaultAgentId,
        sessionKey: key,
      });
      mergeSessionEntryIntoCombined({
        cfg,
        combined,
        entry,
        agentId: defaultAgentId,
        canonicalKey,
      });
    }
    return { storePath, store: combined };
  }

  const targets = resolveAllAgentSessionStoreTargetsSync(cfg);
  const signature = storeFilesSignature(targets.map((t) => t.storePath));
  if (combinedMemo && combinedMemo.signature === signature) {
    return { storePath: combinedMemo.storePath, store: { ...combinedMemo.store } };
  }
  const combined: Record<string, SessionEntry> = {};
  for (const target of targets) {
    const agentId = target.agentId;
    const storePath = target.storePath;
    const store = loadSessionStore(storePath, { clone: false });
    for (const [key, entry] of Object.entries(store)) {
      const canonicalKey = resolveStoredSessionKeyForAgentStore({
        cfg,
        agentId,
        sessionKey: key,
      });
      mergeSessionEntryIntoCombined({
        cfg,
        combined,
        entry,
        agentId,
        canonicalKey,
      });
    }
  }

  const storePath =
    typeof storeConfig === "string" && storeConfig.trim() ? storeConfig.trim() : "(multiple)";
  combinedMemo = { signature, storePath, store: combined };
  return { storePath, store: { ...combined } };
}
