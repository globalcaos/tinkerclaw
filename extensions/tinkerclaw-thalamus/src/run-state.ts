// What Thalamus remembers about a run between events (design doc section 6; units D3, D4).
//
// WHAT THIS IS FOR. The digest, the check, the finish and the stuck rule all need the run's own context at the moment a
// tool ends or a run finishes: the last `routeCall` parameters (board, cache, task read, incumbent), a short log of the
// work done, how many other models already had a hand in it, and which writer the run has settled on. The shadow router
// stores the first; the event listener stores the rest. Everything is bounded and kept in memory only.
//
// NO BODIES. The work log keeps short excerpts for the checker's brief, capped per entry and per run, and lives only as
// long as the run does; it is never written to the store.

import { WRITE_TOOLS, type RouteCallParams } from "openclaw/plugin-sdk/fork-thalamus";

export type WorkEntry = {
  name: string;
  args: string;
  result: string;
  isError: boolean;
  /** The tool changes something outside the conversation. */
  commits: boolean;
};

export type RunState = {
  runId: string;
  sessionKey?: string;
  /** What the run is trying to do, in the user's words, clipped: the digest reader's brief. Kept in memory only. */
  aim?: string;
  /** The `routeCall` parameters of the run's latest call. */
  base?: RouteCallParams;
  work: WorkEntry[];
  /** How many times another model already took part: an acted digest or check. */
  others: number;
  writer?: string;
  /** The tool calls seen but not yet finished, by id, so a result can be joined to its arguments. */
  pending: Map<string, { name: string; args: string }>;
};

export type RunStates = ReturnType<typeof createRunStates>;

const clip = (t: string, n: number): string => (t.length <= n ? t : `${t.slice(0, n)}…`);

export function createRunStates(o: { maxRuns?: number; maxWork?: number; excerpt?: number } = {}) {
  const maxRuns = o.maxRuns ?? 256;
  const maxWork = o.maxWork ?? 12;
  const excerpt = o.excerpt ?? 600;
  const runs = new Map<string, RunState>();

  const ensure = (runId: string, sessionKey?: string): RunState => {
    let r = runs.get(runId);
    if (!r) {
      r = { runId, work: [], others: 0, pending: new Map(), ...(sessionKey ? { sessionKey } : {}) };
      runs.set(runId, r);
      if (runs.size > maxRuns) runs.delete(runs.keys().next().value as string);
    } else if (sessionKey && !r.sessionKey) {
      r.sessionKey = sessionKey;
    }
    return r;
  };

  return {
    ensure,
    get: (runId: string): RunState | undefined => runs.get(runId),
    setBase(
      runId: string,
      base: RouteCallParams,
      meta: { sessionKey?: string; aim?: string } = {},
    ): void {
      const r = ensure(runId, meta.sessionKey);
      r.base = base;
      if (meta.aim && !r.aim) r.aim = clip(meta.aim.replace(/\s+/g, " ").trim(), 600);
    },
    toolStart(runId: string, toolCallId: string, name: string, args: unknown): void {
      const r = ensure(runId);
      let text = "";
      try {
        text = typeof args === "string" ? args : JSON.stringify(args ?? {});
      } catch {
        text = "";
      }
      r.pending.set(toolCallId, { name, args: clip(text, excerpt) });
      if (r.pending.size > 64) r.pending.delete(r.pending.keys().next().value as string);
    },
    toolResult(
      runId: string,
      toolCallId: string,
      name: string,
      result: string,
      isError: boolean,
    ): WorkEntry {
      const r = ensure(runId);
      const started = r.pending.get(toolCallId);
      r.pending.delete(toolCallId);
      const entry: WorkEntry = {
        name: started?.name ?? name,
        args: started?.args ?? "",
        result: clip(result, excerpt),
        isError,
        commits: WRITE_TOOLS.test(started?.name ?? name),
      };
      r.work.push(entry);
      if (r.work.length > maxWork) r.work.splice(0, r.work.length - maxWork);
      return entry;
    },
    noteOther(runId: string): void {
      ensure(runId).others += 1;
    },
    setWriter(runId: string, key: string): void {
      ensure(runId).writer = key;
    },
    /** The newest run of a session that has a base (a call was routed), or undefined. */
    latestForSession(sessionKey: string): RunState | undefined {
      let found: RunState | undefined;
      for (const r of runs.values()) if (r.sessionKey === sessionKey && r.base) found = r;
      return found;
    },
    forget: (runId: string): void => void runs.delete(runId),
    size: (): number => runs.size,
  };
}
