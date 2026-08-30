// FORK 2026-08-24 (the architect) — ONE LIVE BLOCK PER TURN, not one chat row per finished stage.
//
// What was wrong with the row-per-stage shape it replaces:
//
//   1. A row existed only once its stage had FINISHED. The stage actually running — the one the
//      architect is waiting on — was visible only in the pending pill, never in the list. "They
//      should show at the moment they are ongoing."
//   2. Each finished stage appended ANOTHER message, so the list grew downward through the
//      transcript as the turn progressed. "It does not make sense that they crawl to the end of
//      the chat."
//   3. Being N separate messages, they could not be folded as a unit at turn end the way tool
//      calls and narration are.
//
// So the transcript now holds ONE message per turn whose payload is this ordered entry list, and
// the list is upserted in place: a stage announces itself (running), then reports its own measured
// duration (done) INTO THE SAME ENTRY. The block therefore keeps its position and grows internally
// instead of walking down the chat.
//
// Pure (DOM-free, global-free) — the turn-phase.ts / msg-order.ts precedent: app.ts is a browser
// entry with no unit-test harness, so a rule left inlined there is a rule with no test.

/**
 * FORK 2026-08-24 (the architect) — the breakdown is a TREE, not a flat list.
 *
 * "Total Recall" is a member of the `before_prompt_build` chain AND measures its own internals, so
 * it is a child that is also a parent. A flat `Array<{id,ms}>` could express only one of those, and
 * the consequence was visible: the largest plugin on the pre-model path (5.7s average, measured
 * over 268 turns) was the one row that could not be opened.
 */
export type PhaseChild = {
  /** Plugin id or runner-stage id — whichever `kind` says. */
  id: string;
  ms: number;
  /** Which display-name and doc table `id` belongs to. */
  kind?: "plugin" | "stage";
  /** This child's own breakdown. Present ⇒ it renders collapsible, like a top-level entry. */
  children?: PhaseChild[];
  /** The `kind` of everything in `children`. */
  childKind?: "plugin" | "stage";
};

/**
 * The architect's rule, 2026-08-24: "If a task is in average more than 1 second it should be
 * decomposed further."
 *
 * Encoded here rather than left as a review habit, because the whole point of the block is to
 * decide what to optimise and an undecomposed second is exactly where that decision stalls. The
 * renderer marks anything that trips this and has no children, so the list states its own
 * unfinished work instead of looking complete.
 */
export const PHASE_DECOMPOSE_THRESHOLD_MS = 1000;

/**
 * Does this measurement owe a breakdown?
 *
 * Deliberately reads THIS turn's duration, not a historical average: the block is a record of one
 * turn, and a stage that took 4s on the turn in front of you owes an explanation on that turn
 * whatever its long-run mean. The 1s threshold is the architect's, and the average is how the
 * instrumentation work is PRIORITISED — see the journal survey in the commit that added this.
 */
export function needsDecomposition(ms: number, hasChildren: boolean): boolean {
  return !hasChildren && Number.isFinite(ms) && ms > PHASE_DECOMPOSE_THRESHOLD_MS;
}

/**
 * Children in the order they are to be SHOWN: the order they RAN.
 *
 * This is a deliberate reversal of the 2026-08-22 "slowest first". Slowest-first answers "which one
 * is expensive", which the bar widths already answer at a glance; it destroys the one thing a
 * timeline is for — reading the sequence, and seeing WHERE in the sequence the time went. The
 * producers already push in run order (`recordHandler` per handler, `emitStage` per stage), so this
 * is identity, and exists to make "we do not sort" an explicit, testable decision rather than the
 * absence of a line someone will helpfully re-add.
 */
export function phaseChildrenInOrder<T>(children: readonly T[]): T[] {
  return children.slice();
}

/** One stage inside a turn's timing block. */
export type PhaseEntry = {
  /** Human label — always a word the gateway sent, or a plugin's display name. */
  label: string;
  /** Wall time the stage held. Meaningless while `done` is false; read `startedAt` instead. */
  ms: number;
  /** False ⇒ still running: the renderer ticks it against `startedAt`. */
  done: boolean;
  /** Client-measured (wall time INCLUDING queueing) rather than gateway-measured. */
  client?: boolean;
  /** Set when this entry IS a plugin promoted out of its chain, so a click opens its doc. */
  pluginId?: string;
  /** Sub-breakdown: plugins of a hook chain, or runner stages inside a client window. */
  plugins?: PhaseChild[];
  /** Which of the two the breakdown is. They are different quantities — see app.ts. */
  kind?: "plugin" | "stage";
  /** Client wall-clock ms when the stage was first seen. Drives the live counter. */
  startedAt?: number;
  /**
   * True when `ms` was DERIVED (a stage that announced itself and never reported a completion,
   * closed out when the next stage started) rather than measured server-side around the work.
   * Kept distinct because the whole point of these numbers is to decide what to optimise, and a
   * derived duration silently folds in event-loop and network latency.
   */
  inferred?: boolean;
};

/**
 * Hard cap. A turn has ~6 narrated phases plus the two client windows; anything past this means
 * something is looping, and truncating is better than an unbounded chat row.
 */
export const MAX_PHASE_ENTRIES = 24;

/**
 * Upsert one entry into a turn's block.
 *
 * THE ONE RULE: a stage occupies exactly ONE slot for the whole of its life. It is appended when
 * it starts and completed in place when it ends — it is never appended twice, which is what made
 * the previous shape crawl.
 *
 * Matching is by label against the LAST not-yet-done entry. Labels repeat across turns but not
 * within one (the gateway narrates each hook once), and scoping the search to the tail means a
 * genuine re-announcement later in the same turn opens a new slot rather than back-filling an
 * older one.
 *
 * A still-running entry that a DIFFERENT stage supersedes is closed out at `nowMs` and tagged
 * `inferred`, never dropped: a stage whose completion event was lost is a real stage that really
 * took time, and deleting it would understate the turn.
 */
export function upsertPhaseEntry(
  entries: readonly PhaseEntry[],
  next: PhaseEntry,
  nowMs: number,
): PhaseEntry[] {
  const out = entries.slice();
  const openIdx = lastOpenIndex(out);
  if (openIdx >= 0 && out[openIdx].label === next.label) {
    // The completion of the stage already on screen. Keep the ORIGINAL startedAt so a later
    // re-render of a running entry cannot restart its clock.
    out[openIdx] = {
      ...out[openIdx],
      ...next,
      startedAt: out[openIdx].startedAt ?? next.startedAt,
    };
    return out;
  }
  if (openIdx >= 0) {
    const opened = out[openIdx];
    out[openIdx] = {
      ...opened,
      done: true,
      inferred: true,
      ms: Math.max(0, nowMs - (opened.startedAt ?? nowMs)),
    };
  }
  out.push(next);
  return out.length > MAX_PHASE_ENTRIES ? out.slice(out.length - MAX_PHASE_ENTRIES) : out;
}

/** Index of the entry still running, or -1. There is at most one by construction. */
function lastOpenIndex(entries: readonly PhaseEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!entries[i].done) {
      return i;
    }
  }
  return -1;
}

/** Is any stage in this block still running? Drives the block's live styling. */
export function phaseGroupIsLive(entries: readonly PhaseEntry[]): boolean {
  return lastOpenIndex(entries) >= 0;
}

/**
 * Total of the block, with running entries counted against the clock.
 *
 * A SUM OF STAGES IS NOT THE WALL TIME OF THE TURN, and this function does not pretend otherwise —
 * the client windows ("sending", "preparing context") overlap the gateway stages that run inside
 * them. The header therefore labels this "measured", not "total". See the gap row in app.ts, which
 * makes the same distinction one level down.
 */
export function phaseGroupMeasuredMs(entries: readonly PhaseEntry[], nowMs: number): number {
  let total = 0;
  for (const e of entries) {
    total += e.done ? Math.max(0, e.ms) : Math.max(0, nowMs - (e.startedAt ?? nowMs));
  }
  return total;
}

/**
 * The wall time the block spans: first start to last finish (or now).
 *
 * This is the honest headline number — it does not double-count the gateway stages that run
 * INSIDE the client-measured windows, which is exactly what summing the entries would do.
 */
export function phaseGroupSpanMs(entries: readonly PhaseEntry[], nowMs: number): number {
  const starts = entries.map((e) => e.startedAt).filter((t): t is number => typeof t === "number");
  if (starts.length === 0) {
    return phaseGroupMeasuredMs(entries, nowMs);
  }
  const first = Math.min(...starts);
  let last = first;
  for (const e of entries) {
    const start = e.startedAt ?? first;
    last = Math.max(last, e.done ? start + Math.max(0, e.ms) : nowMs);
  }
  return Math.max(0, last - first);
}

/**
 * FORK 2026-08-24 (the architect: "The elements need to be rendered expanded initially, but when the task
 * is completed it needs to collapse into the task level") — AUTOMATIC DISCLOSURE.
 *
 * The rows exist to be watched while you wait, and to be out of the way afterwards. Collapsed-by-
 * default got the second half right and the first half exactly wrong: the breakdown was hidden
 * during the only window in which anyone is actually looking at it.
 *
 * WHY THIS IS DECIDED PER BLOCK AND NOT PER ROW. A gateway phase ships its children ON its
 * completion event — one envelope carries the label, the duration and the plugin list together. So
 * a row is childless while it runs and only becomes expandable at the instant it finishes. A
 * literal "open while running, close when done" rule would therefore open nothing, ever: at the
 * moment there is something to show, the thing showing it is already done. The unit that has a
 * meaningful "still going" is the TURN — which is what "the task" means here, and what the rows
 * collapse INTO.
 *
 * THE HARD PART IS NOT FIGHTING THE USER. Auto-open and auto-collapse each fire AT MOST ONCE per
 * row, on the transition; after that the row is the user's. Without the two ledgers below, every
 * repaint (and there is one per second while a turn is live) would re-assert the automatic state
 * and a manually-closed row would flap back open under the cursor.
 *
 * Pure: the caller owns the sets and applies the returned actions, so this is testable without a
 * DOM or a clock.
 */
export type AutoDisclosureAction = { toOpen: string[]; toClose: string[] };

export function resolveAutoDisclosure(input: {
  /** Every collapsible row in this block, as its stable toggle id. */
  tids: readonly string[];
  /** Is the block still running — i.e. has the task not completed yet? */
  live: boolean;
  /** Rows this mechanism has already auto-opened. Mutated by the caller, read here. */
  autoOpened: ReadonlySet<string>;
  /** Rows this mechanism has already auto-collapsed. */
  autoCollapsed: ReadonlySet<string>;
}): AutoDisclosureAction {
  const toOpen: string[] = [];
  const toClose: string[] = [];
  for (const tid of input.tids) {
    if (input.live) {
      // First sight of a row while the task is running: open it. Only once — a row the user
      // closed mid-turn must stay closed.
      if (!input.autoOpened.has(tid)) {
        toOpen.push(tid);
      }
      continue;
    }
    // The task finished. Collapse what THIS mechanism opened, once. A row that was never
    // auto-opened is not ours to close: that is a block restored from disk after a reload, which
    // must render collapsed without any transition, and a row the user opened by hand afterwards.
    if (input.autoOpened.has(tid) && !input.autoCollapsed.has(tid)) {
      toClose.push(tid);
    }
  }
  return { toOpen, toClose };
}

/** "6 stages" / "1 stage" — the countable part of the block header. */
export function phaseGroupCountLabel(entries: readonly PhaseEntry[]): string {
  const n = entries.length;
  return `${n} stage${n === 1 ? "" : "s"}`;
}
