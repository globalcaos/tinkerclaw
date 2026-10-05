/**
 * The Thalamus v4 panel's client (charter phase G): it asks the gateway for `thalamus.panel`, keeps the answer, and remembers
 * which expanders are open so a repaint does not close them. The card's own drawing is `panels/thalamus-v4-card.ts`.
 *
 * INERT UNLESS THE GATEWAY HAS THE METHOD. An `unknown method` answer (the plugin is off, missing, or this is a gateway from
 * before it) leaves `view()` undefined, and the card is drawn exactly as before. It is not asked again for a long while.
 * Any other failure is shown as one quiet line, and tried again at the normal pace.
 *
 * NO POLLING LOOP OF ITS OWN. `refreshIfDue` is called whenever the panel is drawn; it does nothing until `refreshMs` has
 * passed, so drawing often costs nothing. When an answer changes what is on screen it asks for one repaint.
 */
import type { ThalamusV4Panel, ThalamusV4View } from "./panels/thalamus-v4-card.js";

export interface ThalamusV4UiDeps {
  req<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Draw the panel again (the caller's own repaint). */
  repaint(): void;
  now?(): number;
  /** How often to ask while the plugin answers. */
  refreshMs?: number;
  /** How long to leave a gateway alone after it said it has no such method. */
  absentMs?: number;
}

export interface ThalamusV4Ui {
  /** What to draw, or undefined for nothing at all. */
  view(): ThalamusV4View | undefined;
  openKeys(): ReadonlySet<string>;
  /** The reader opened or closed a `<details>` of the block. */
  onToggle(key: string, open: boolean): void;
  refreshIfDue(): void;
  /** The socket (re)connected: ask again at the next draw. */
  reset(): void;
}

/** Only a gateway saying it has no such method counts as "the plugin is not there"; a real failure must stay visible. */
const UNKNOWN = /unknown method|no such method/i;

/** The gateway rejects with `{ code, message }`, not always an `Error`; `String(err)` of that is "[object Object]". */
export function readableMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err)
    return String((err as { message: unknown }).message);
  try {
    return JSON.stringify(err) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

export function createThalamusV4Ui(d: ThalamusV4UiDeps): ThalamusV4Ui {
  const now = d.now ?? Date.now;
  const refreshMs = d.refreshMs ?? 15_000;
  const absentMs = d.absentMs ?? 5 * 60_000;
  let current: ThalamusV4View | undefined;
  let nextAt = 0;
  let inFlight = false;
  const open = new Set<string>();

  const same = (a: ThalamusV4View | undefined, b: ThalamusV4View | undefined): boolean =>
    JSON.stringify(a) === JSON.stringify(b);

  function settle(next: ThalamusV4View | undefined, wait: number): void {
    nextAt = now() + wait;
    if (same(current, next)) return;
    current = next;
    d.repaint();
  }

  async function ask(): Promise<void> {
    try {
      const out = await d.req<{ ok?: boolean; error?: string } & Partial<ThalamusV4Panel>>(
        "thalamus.panel",
        {},
      );
      if (out && out.ok === true) {
        const { ok: _ok, ...panel } = out;
        settle({ state: "ok", panel: panel as ThalamusV4Panel }, refreshMs);
      } else {
        // `not-running`: the plugin is loaded but has not started. Nothing to show yet, ask again soon.
        settle(undefined, refreshMs * 2);
      }
    } catch (err) {
      const message = readableMessage(err);
      if (UNKNOWN.test(message)) settle(undefined, absentMs);
      else {
        // A real failure: the readable line goes on the panel, the whole object to the console (devtools has the rest).
        console.error("[thalamus-v4] panel request failed", err);
        settle({ state: "error", message: message.slice(0, 160) }, refreshMs);
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    view: () => current,
    openKeys: () => open,
    onToggle(key, isOpen) {
      if (isOpen) open.add(key);
      else open.delete(key);
    },
    refreshIfDue() {
      if (inFlight || now() < nextAt) return;
      inFlight = true;
      void ask();
    },
    reset() {
      nextAt = 0;
    },
  };
}
