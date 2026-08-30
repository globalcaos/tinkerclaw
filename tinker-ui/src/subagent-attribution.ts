/**
 * FORK 2026-07-28b: does a subagent belong to the tab currently being viewed?
 *
 * WHY THIS IS ITS OWN MODULE. This one question is asked from two places in `app.ts` — the RENDER
 * path (`chatEventIsSubagentOfView`, deciding whether a chat event is shown) and the COUNTING path
 * (`isSubagentOfViewedSession`, driving the thinking indicator, the Models badge and the live glow).
 * It has now been implemented wrongly twice, in two different ways, and each time fixing one copy
 * left the other broken:
 *
 *   1. The counting path built its prefix from `sessionKey.replace(/:main$/, "")`, so it counted
 *      other tabs' subagents on Main and ZERO on every other tab.
 *   2. The repair for (1) matched on the agent root alone, which admitted EVERY subagent under the
 *      agent into EVERY tab — so a tab the user was merely typing in rendered a thinking indicator
 *      for work dispatched elsewhere, appearing to act on its own.
 *
 * Design principle #18: one canonical derivation, named, injected, tested. Both call sites in
 * `app.ts` delegate here; neither re-derives the rule.
 *
 * THE RULE, in order of confidence:
 *   a. Not a subagent key, or no viewed session -> false.
 *   b. Different agent root -> false. (Subagents are minted FLAT as `agent:<name>:subagent:<uuid>`
 *      regardless of which tab spawned them; the parent tab is NOT encoded in the key.)
 *   c. Ownership resolves to a TAB -> belongs iff that tab is this one. This is the precise
 *      answer and the only one that is correct with several tabs open.
 *   c'. Ownership resolves to something that is NOT a tab -> treat as UNKNOWN, fall to (d).
 *   d. Ownership UNKNOWN (a run or delta observed before its spawn event) -> claim it only when
 *      this is the lone tab attached to the agent. With siblings open, refuse: an unattributed
 *      subagent must never surface as phantom activity in someone else's tab.
 *
 * (d) is deliberately asymmetric. Under-attributing costs a missing count in a panel; over-
 * attributing tells the user their session is doing something they never asked for. A gap is a
 * gap; a phantom is a false statement about what the system is doing.
 *
 * WHY (c') EXISTS — FORK 2026-08-08 (the architect: "Jarvis is doing things in parallel but the EEG does
 * not show the traces"). A fan-out dispatched through the orchestrator is minted with
 * `requesterSessionKey = "agent:main:orchestrator"`, so `recordSubagentOwner` resolved the leg's
 * owner to the ORCHESTRATOR LANE rather than to the tab that asked for the work. That key is a
 * session but it is not a tab, so (c) compared it against every tab, found no match, and returned
 * false EVERYWHERE — the four live legs were invisible in all tabs at once.
 *
 * This is not a heuristic — it is what that key MEANS. `src/agents/headless-requester-session-key.ts`
 * defines it as "the sink for subagent spawns whose caller has no UI tab identity (CLI / ORCA /
 * Claude Code sessions)". So an owner of `agent:<id>:orchestrator` is a POSITIVE statement that the
 * spawn had no tab identity — i.e. tab-level ownership is unknown. (c) was reading that exact
 * statement as "owned by a rival tab" and returning the confident no. Reading it as UNKNOWN restores
 * the documented asymmetry: a lone tab shows its fan-out again, and with siblings open we still
 * refuse rather than paint a phantom.
 *
 * KNOWN RESIDUAL: with several tabs attached, an orchestrator-dispatched fan-out stays invisible.
 * That is not fixable from the UI — the spawn genuinely carries no tab identity, so there is nothing
 * here to attribute it WITH. Closing it means the spawner passing a real tab identity when one
 * exists (a fan-out launched from inside a tab's turn is not truly headless), which is a
 * gateway/spawn-path change, not a rendering one. This fix deliberately does not guess.
 */

export type SubagentAttributionDeps = {
  /** Owning session key for a subagent key, if the spawn event has been seen. NOT guaranteed to
   *  be a tab: an orchestrator/controller lane can be the resolved owner — see (c') above. */
  ownerOf: (subagentKey: string) => string | undefined;
  /** How many tabs are currently attached to this agent root. */
  attachedTabCount: (agentRoot: string) => number;
  /** Session-key equivalence as the UI defines it (alias/short forms included). */
  keyMatches: (candidate: string, viewedSessionKey: string) => boolean;
  /** Is this session key one of the UI's tabs at all? Distinguishes a rival TAB (real evidence
   *  the work is someone else's) from a controller lane like `agent:main:orchestrator` (no
   *  tab-level evidence either way). Required: a silent default here is how (c) went wrong. */
  isTab: (sessionKey: string) => boolean;
};

export const SUBAGENT_MARKER = ":subagent:";

/** The agent root of any session key: `agent:main:tinker:abc` -> `agent:main`. */
export function agentRootOf(sessionKey: string): string {
  return sessionKey.split(":").slice(0, 2).join(":");
}

/**
 * Does `subagentKey` belong to the tab identified by `viewedSessionKey`?
 * Pure: every ambient lookup arrives through `deps`, so this is directly testable.
 */
export function subagentBelongsToViewedTab(
  subagentKey: string | undefined | null,
  viewedSessionKey: string | undefined | null,
  deps: SubagentAttributionDeps,
): boolean {
  const sub = subagentKey ?? "";
  const viewed = viewedSessionKey ?? "";
  if (!sub.includes(SUBAGENT_MARKER) || !viewed) return false;

  const root = agentRootOf(viewed);
  if (!root || !sub.startsWith(root + SUBAGENT_MARKER)) return false;

  const owner = deps.ownerOf(sub);
  if (owner) {
    // (c) resolved to THIS tab — the precise yes.
    if (owner === viewed || deps.keyMatches(owner, viewed)) return true;
    // (c) resolved to a RIVAL TAB — the precise no. Only a real tab earns this.
    if (deps.isTab(owner)) return false;
    // (c') resolved to a non-tab lane (orchestrator/controller). No tab-level evidence: fall
    // through to the unknown-ownership rule rather than reading it as "belongs to someone else".
  }

  return deps.attachedTabCount(root) <= 1;
}
