/**
 * How Amygdala's live events reach the pages (2026-10-22). The plugin API has no `broadcast`: the gateway hands it only
 * to a method handler, in `context.broadcast` (the tinkerclaw-auth-reload precedent). The old `api.broadcast?.()` was
 * undefined, so every `amygdala2.*` event was dropped without a word and a page learned of a refusal only when it
 * reloaded its feed: Jev recorded the 18:58 refusal, the open page never drew its strip.
 *
 * One holder per process, not per start: the gateway runs register() several times, and the runtime that emits is not
 * always the one whose methods the page calls ([[reference_plugin_register_runs_many_times]]). The page calls
 * `amygdala2.status` and `amygdala2.feed` as it connects, so the holder fills before any event matters.
 */
export type BroadcastFn = (event: string, payload: unknown) => void;

const KEY = Symbol.for("tinkerclaw.amygdala.broadcast");
type Holder = { [KEY]?: BroadcastFn };

/** Keep the first broadcast a method call hands over; later calls carry the same one. */
export function captureBroadcast(context: unknown): void {
  const fn = (context as { broadcast?: unknown } | null | undefined)?.broadcast;
  if (typeof fn !== "function") return;
  const g = globalThis as Holder;
  g[KEY] ??= fn as BroadcastFn;
}

/** The broadcast to use now: the API's own if a host ever provides one, else the captured one, else nothing. */
export function currentBroadcast(api: unknown): BroadcastFn | undefined {
  const own = (api as { broadcast?: unknown } | null | undefined)?.broadcast;
  if (typeof own === "function") return own as BroadcastFn;
  return (globalThis as Holder)[KEY];
}

/** Tests only: forget the captured broadcast. */
export function resetBroadcastForTests(): void {
  delete (globalThis as Holder)[KEY];
}
