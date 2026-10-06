/**
 * Hive door — who may see which chat.
 *
 * WHAT IT IS FOR: in multi-user mode each chat has an owner and a visibility list, and the door
 * enforces it on every request and every streamed event. Nothing here deletes data: a regular
 * user's "delete" only hides the chat from that user; admins keep seeing it until an admin deletes it.
 * HOW IT WAS DERIVED: owner's rules (2026-10-06): a user's new chat is visible to that user and the
 * admins; an admin's new chat is visible to that admin only; admins see every user's chats; admin is
 * a property that can be granted and taken away; deleting a user never removes their chats.
 * WHAT WOULD CHANGE IT: sharing a chat with a named colleague (add their id to `visibleTo`).
 *
 * Store: `<stateDir>/acl.json` = { version, sessions: { <canonical key>: entry } } where
 * entry = { owner, visibleTo: [operatorId | "role:admin"], hiddenFor: [operatorId], createdAt,
 *           legacy?, inheritedFrom?, deletedByAdmin? }.
 */
import fs from "node:fs";

export const ADMIN_ROLE = "role:admin";
const MAX_INHERIT_DEPTH = 6;
/** Background lanes nobody chats in: at migration they stay admin-only, never shared with legacy users. */
const SYSTEM_FAMILIES = new Set(["cron", "fractal-reflection", "orchestrator", "heartbeat"]);

/** Session keys arrive as `tinker:abc` or `agent:main:tinker:abc`; the store keeps the long form. */
export function canonKey(key, defaultAgent = "main") {
  if (typeof key !== "string") return null;
  const k = key.trim();
  if (!k || k.length > 400) return null;
  return k.startsWith("agent:") ? k : `agent:${defaultAgent}:${k}`;
}

/** Each person's own Main chat. Ends in ":main" so the UI files it as the Main tab. */
export function userMainKey(operatorId, defaultAgent = "main") {
  return `agent:${defaultAgent}:hive:${operatorId}:main`;
}

/** Pure visibility rule. `user` = { operatorId, admin }. */
export function isVisible(entry, user) {
  if (!entry || !user) return false;
  if (entry.deletedByAdmin) return false;
  if ((entry.hiddenFor ?? []).includes(user.operatorId)) return false;
  const vis = entry.visibleTo ?? [];
  if (vis.includes(user.operatorId)) return true;
  return Boolean(user.admin && vis.includes(ADMIN_ROLE));
}

/** Visibility of a chat a person creates now. */
export function newEntryFor(user, now) {
  return {
    owner: user.operatorId,
    visibleTo: user.admin ? [user.operatorId] : [user.operatorId, ADMIN_ROLE],
    hiddenFor: [],
    createdAt: new Date(now).toISOString(),
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * @param {object} o
 * @param {string} o.file              acl.json path
 * @param {string} [o.gatewayStoreFile] the gateway's sessions.json (legacy migration + parent lookup)
 * @param {string[]} [o.legacyUsers]   who keeps seeing the chats that existed before multi-user mode
 * @param {string} [o.defaultAgent]
 * @param {() => number} [o.now]
 */
export function createAcl(o) {
  const defaultAgent = o.defaultAgent ?? "main";
  const now = o.now ?? (() => Date.now());
  let state = readJson(o.file, null);
  let storeCache = { mtimeMs: -1, data: {} };

  function gatewayStore() {
    if (!o.gatewayStoreFile) return {};
    try {
      const st = fs.statSync(o.gatewayStoreFile);
      if (st.mtimeMs !== storeCache.mtimeMs) {
        storeCache = { mtimeMs: st.mtimeMs, data: readJson(o.gatewayStoreFile, {}) };
      }
    } catch {
      storeCache = { mtimeMs: -1, data: {} };
    }
    return storeCache.data;
  }

  function save() {
    const tmp = `${o.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, o.file);
  }

  // First start in multi-user mode: every chat that already exists becomes a legacy chat, visible to
  // the admins and to the people who used the agent before (so nobody loses their history).
  if (!state || typeof state !== "object" || !state.sessions) {
    state = { version: 1, migratedAt: new Date(now()).toISOString(), sessions: {} };
    for (const key of Object.keys(gatewayStore())) {
      const system = SYSTEM_FAMILIES.has(key.split(":")[2] ?? "");
      state.sessions[key] = {
        owner: null,
        legacy: true,
        visibleTo: system ? [ADMIN_ROLE] : [ADMIN_ROLE, ...(o.legacyUsers ?? [])],
        hiddenFor: [],
        createdAt: state.migratedAt,
      };
    }
    save();
  }

  /** Entry for a key, resolving a gateway-created chat (subagent) through its parent. */
  function resolve(key, depth = 0) {
    const k = canonKey(key, defaultAgent);
    if (!k) return null;
    const hit = state.sessions[k];
    if (hit) return hit;
    if (depth > MAX_INHERIT_DEPTH) return null;
    const gw = gatewayStore()[k];
    const parent = gw && (gw.spawnedBy || gw.parentSessionKey || gw.requesterSessionKey);
    if (typeof parent === "string") {
      const p = resolve(parent, depth + 1);
      if (p) {
        const e = {
          owner: p.owner,
          visibleTo: [...(p.visibleTo ?? [])],
          hiddenFor: [],
          createdAt: new Date(now()).toISOString(),
          inheritedFrom: canonKey(parent, defaultAgent),
        };
        state.sessions[k] = e;
        save();
        return e;
      }
    }
    return null;
  }

  return {
    canon: (key) => canonKey(key, defaultAgent),
    mainKeyFor: (operatorId) => userMainKey(operatorId, defaultAgent),
    entry: (key) => resolve(key),
    /**
     * Decide a request that names `key`: allow (claiming brand-new chats for `user`) or deny.
     * Unknown chats the gateway created without a parent (crons, reflections) are admin-only.
     */
    authorize(user, key) {
      const k = canonKey(key, defaultAgent);
      if (!k) return { ok: true };
      const e = resolve(k);
      if (e) return isVisible(e, user) ? { ok: true, key: k } : { ok: false, key: k };
      if (!gatewayStore()[k]) {
        state.sessions[k] = newEntryFor(user, now());
        save();
        return { ok: true, key: k, claimed: true };
      }
      return user.admin ? { ok: true, key: k } : { ok: false, key: k };
    },
    /** Event filter: may this user receive an event about `key`? Unknown parentless chats: admins only. */
    canSee(user, key) {
      const e = resolve(key);
      if (e) return isVisible(e, user);
      return Boolean(user.admin);
    },
    claim(user, key) {
      const k = canonKey(key, defaultAgent);
      if (!k) return null;
      if (!state.sessions[k]) {
        state.sessions[k] = newEntryFor(user, now());
        save();
      }
      return state.sessions[k];
    },
    hideFor(user, key) {
      const e = resolve(key);
      if (!e) return false;
      e.hiddenFor = [...new Set([...(e.hiddenFor ?? []), user.operatorId])];
      save();
      return true;
    },
    markDeletedByAdmin(user, key) {
      const e = resolve(key);
      if (!e) return false;
      e.deletedByAdmin = { by: user.operatorId, at: new Date(now()).toISOString() };
      save();
      return true;
    },
    /** Chats per owner, for the admin panel. */
    countsByOwner() {
      const out = {};
      for (const e of Object.values(state.sessions)) {
        const who = e.owner ?? (e.legacy ? "legacy" : "system");
        out[who] = (out[who] ?? 0) + 1;
      }
      return out;
    },
    _state: () => state,
  };
}
