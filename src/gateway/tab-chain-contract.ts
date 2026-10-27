// FORK 2026-10-15 (the architect: "when a tab has no master-slave contract set up, it should not be
// allowed to infiltrate another chat") — the cross-tab contract, enforced where the message
// lands. Bible §5.8AG.
//
// A message that speaks AS an agent into a chat (`⟦AGENT:<label>⟧ …`, written by converse.mjs
// and wake-on-finish.mjs) is a tab talking to another tab. Tabs only talk across a master/slave
// chain the human drew (right-click → "Set conversation slave"; the UI mirrors the pairs to
// `tinker-ui-state.json` under the choice `loop:chains`). The sender names itself with
// `fromSessionKey`; the gateway lets the message through only when sender and target are the two
// ends of one chain (or the same session). Everything else is refused with the fix in the error.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ChainEnd = { tabId: string; sessionKey?: string };
export type ChainPair = { master: ChainEnd; slave: ChainEnd };

type UiTab = { id?: unknown; sessionKey?: unknown };
type UiChain = {
  master?: unknown;
  slave?: unknown;
  masterKey?: unknown;
  slaveKey?: unknown;
};

/** `agent:main:` is implied on a bare key, as in loop-partner.mjs. */
function fullKey(key: string | undefined): string | undefined {
  if (!key) {
    return undefined;
  }
  return key.startsWith("agent:") ? key : `agent:main:${key}`;
}

/** The marker an agent's cross-tab message wears: `⟦AGENT⟧ …` or `⟦AGENT:label⟧ …`. */
export function isAgentTabMessage(message: string): boolean {
  return /^\s*⟦AGENT(?::[^⟧]*)?⟧/.test(message);
}

/** Resolve the saved chains to session keys. A tab's live key wins over the snapshot the chain
 *  stored when it was linked (a /clear rotates the key, not the tab). */
export function resolveChains(state: unknown): ChainPair[] {
  const s = (state ?? {}) as { tabs?: unknown; choices?: Record<string, unknown> };
  const tabs: UiTab[] = Array.isArray(s.tabs) ? (s.tabs as UiTab[]) : [];
  const keyOfTab = new Map<string, string | undefined>();
  for (const t of tabs) {
    if (typeof t?.id === "string") {
      keyOfTab.set(t.id, typeof t.sessionKey === "string" ? fullKey(t.sessionKey) : undefined);
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(String(s.choices?.["loop:chains"] ?? "[]"));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ChainPair[] = [];
  for (const c of raw as UiChain[]) {
    if (typeof c?.master !== "string" || typeof c?.slave !== "string") {
      continue;
    }
    const masterKey =
      keyOfTab.get(c.master) ??
      (typeof c.masterKey === "string" ? fullKey(c.masterKey) : undefined);
    const slaveKey =
      keyOfTab.get(c.slave) ?? (typeof c.slaveKey === "string" ? fullKey(c.slaveKey) : undefined);
    out.push({
      master: { tabId: c.master, sessionKey: masterKey },
      slave: { tabId: c.slave, sessionKey: slaveKey },
    });
  }
  return out;
}

export type ContractVerdict = { ok: true } | { ok: false; reason: string };

/** Pure decision. `fromKey` is who says it, `toKey` is whose chat it lands in. */
export function checkTabContract(params: {
  fromKey: string | undefined;
  toKey: string;
  chains: ChainPair[];
}): ContractVerdict {
  const from = fullKey(params.fromKey);
  const to = fullKey(params.toKey);
  if (!from) {
    return {
      ok: false,
      reason:
        "an agent message into another chat must say who sends it (fromSessionKey); anonymous " +
        "agent text may not enter a chat",
    };
  }
  if (from === to) {
    return { ok: true };
  }
  const paired = params.chains.some(
    (c) =>
      (c.master.sessionKey === from && c.slave.sessionKey === to) ||
      (c.slave.sessionKey === from && c.master.sessionKey === to),
  );
  if (paired) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      `no master-slave contract between ${from} and ${to}: a tab may only talk into its own ` +
      `chain partner. Chain the two tabs (right-click a tab → "Set conversation slave"), or ` +
      `keep the work in your own tab`,
  };
}

export function defaultUiStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.TINKER_UI_STATE || path.join(os.homedir(), ".openclaw", "data", "tinker-ui-state.json")
  );
}

/** Read the mirrored UI state; a missing or corrupt file means "no chains" (so: refuse). */
export function loadChains(statePath: string = defaultUiStatePath()): ChainPair[] {
  try {
    return resolveChains(JSON.parse(fs.readFileSync(statePath, "utf8")));
  } catch {
    return [];
  }
}
