// Where an Amygdala bubble that names no tool call goes in a run: next to the thing it judged.
//
// A PROMPT check judged a prompt. The one of the run's own turn judged the prompt that opened the
// run, so it sits right under that prompt, before anything the agent wrote. A prompt check of a later
// turn in the same run (a job's or an agent's wake-up, which has no row of its own) goes by time.
//
// A STOP check judged the answer the agent had just finished. In the run's last turn that answer is
// counted from the end: every send-back from this check on made the agent write one more answer
// after it, so a check with k send-backs at or after it judged the k-th answer from the end, and its
// bubble goes right after that answer. Rows' times cannot decide this (2026-11-04): a page that was
// asleep during the turn receives the answers after every check, so by time all the checks went
// above the first answer. Checks of earlier turns go by time.
//
// By time: before the first row that came after the bubble, or right after the run's last row when
// nothing came after it. Rows carry the CLI transcript's emission time, checks when they judged.
// Only rows drawn as their own bubble can host one (tool steps fold into the reasoning group). A
// bubble nothing can place is left to the closing block, which is why the keys placed are returned.

/**
 * `opens`: true when the check sent the reply back (the agent writes again), false for a note.
 * `seam` defaults to "stop". `turnId` is the Jev turn the check belongs to. `opensRun`: a prompt
 * check of the turn whose prompt opened this run.
 */
export type StopBubble = {
  key: string;
  ts: number;
  html: string;
  opens?: boolean;
  seam?: "stop" | "prompt";
  turnId?: string;
  opensRun?: boolean;
};
export type RowAt = { key: string; at: number | undefined };

export function placeStopBubbles<U extends { key: string; html: string }>(
  units: U[],
  rows: RowAt[],
  bubbles: StopBubble[],
  makeUnit: (b: StopBubble) => U,
  /** Index of the run's first unit, right under its prompt. */
  runFirstUnit = 0,
): Set<string> {
  const placed = new Set<string>();
  const shown = rows.filter((r) => units.some((u) => u.key === r.key));
  const timed = shown.filter((r) => r.at !== undefined);
  const indexOf = (key: string) => units.findIndex((u) => u.key === key);
  /** The bubbles inserted so far, by unit key, with their time: a later one goes after them. */
  const inserted = new Map<string, number>();
  const skipEarlier = (at: number, ts: number) => {
    while (at < units.length && (inserted.get(units[at].key) ?? Infinity) <= ts) at++;
    return at;
  };
  const byTime = (b: StopBubble): number => {
    if (timed.length === 0) return -1;
    const next = timed.find((r) => (r.at as number) > b.ts);
    return next ? indexOf(next.key) : skipEarlier(indexOf(timed[timed.length - 1].key) + 1, b.ts);
  };
  const insert = (b: StopBubble, at: number) => {
    const u = makeUnit(b);
    units.splice(at, 0, u);
    inserted.set(u.key, b.ts);
    placed.add(b.key);
  };

  const sorted = [...bubbles].sort((x, y) => x.ts - y.ts);
  for (const b of sorted.filter((x) => x.seam === "prompt")) {
    const at = b.opensRun ? skipEarlier(runFirstUnit, b.ts) : byTime(b);
    if (at >= 0) insert(b, at);
  }
  const stops = sorted.filter((x) => x.seam !== "prompt");
  const lastTurn = stops[stops.length - 1]?.turnId;
  for (const b of stops) {
    let at: number;
    if (lastTurn !== undefined && b.turnId === lastTurn && shown.length > 0) {
      // FORK 2026-11-13 (F2): a send-back counts only when a row began after it. One that opened no
      // further answer (the turn was stopped, the hook's answer came too late, a runner that records
      // the check and never blocks) used to push its own card above the answer it judged.
      const later = stops.filter(
        (s) =>
          s.turnId === lastTurn &&
          s.ts >= b.ts &&
          s.opens &&
          (timed.length === 0 || timed.some((r) => (r.at as number) > s.ts)),
      ).length;
      const judged = shown.length - 1 - later;
      at = judged >= 0 ? skipEarlier(indexOf(shown[judged].key) + 1, b.ts) : indexOf(shown[0].key);
    } else {
      at = byTime(b);
    }
    if (at >= 0) insert(b, at);
  }
  return placed;
}
