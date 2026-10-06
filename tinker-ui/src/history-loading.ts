/**
 * FORK 2026-10-06 (the architect: "When a ui rebuild or gateway restart happens, the chats take forever to
 * reload their content … make sure there are 'loading...' indicators when loading the chat
 * history, indicators that have some movement so the user understands there is something turning.
 * Also, use the loading indicator for when we scroll backwards").
 *
 * Measured on the 2026-10-06 06:15 restart: the page reloaded onto a gateway that refused
 * chat.history for 47 s ("unavailable during gateway startup") and then served the viewed tab's
 * first, cold read in 15 s. The chat stayed blank for the whole minute and only an amber strip
 * appeared, after a failure, saying "history unavailable". He pressed F5.
 *
 * Pure: which history reads are in flight for the tab on screen, and what the indicator says and
 * where. app.ts owns the reads (loadChat, loadOlderPage, loadResetArchivePage) and the DOM.
 */

/** "tail": the page's newest rows (a load, a reload, a reconnect). "older": a scroll back. */
export type HistoryLoadKind = "tail" | "older";

export type HistoryLoad = { key: string; kind: HistoryLoadKind; startedAt: number };

/** Top of the pane for an older page; centred on an empty page. */
export type IndicatorPlace = "top" | "center";

export type HistoryIndicator = { place: IndicatorPlace; kind: HistoryLoadKind; label: string };

/**
 * A scroll back shorter than this never shows. Most reads of a warm gateway take 60–800 ms
 * (journal, 2026-10-06), and a pill flashing on every page up reads as flicker, not as progress.
 */
export const HISTORY_INDICATOR_DELAY_MS = 300;

/**
 * Is this a failure the page simply waits out, because the gateway is not answering YET? The
 * startup refusal (`chat.history unavailable during gateway startup`) and a socket that is down or
 * reconnecting. Those are retried on a short fixed cadence and drawn as loading, never as an error.
 */
export function isGatewayWait(reason: string): boolean {
  return /during gateway startup|disconnected|socket|closed|econnrefused|econnreset/i.test(reason);
}

/** What the indicator says while a read is being retried, by why it failed. */
export function retryLabel(reason: string): string {
  if (/during gateway startup/i.test(reason)) {
    return "Waiting for the gateway to start";
  }
  if (isGatewayWait(reason)) {
    return "Reconnecting to the gateway";
  }
  if (/timeout|timed out/i.test(reason)) {
    return "The gateway is slow, still loading the chat";
  }
  return "Retrying the chat history";
}

/**
 * The indicators to draw for the viewed session, at most one per place.
 *
 * `retryReason` is the viewed session's retry state (null when its read has not failed): a read
 * being retried shows at once, with the reason in its words, since it has already taken a while.
 *
 * FORK 2026-10-06 (the architect: "Make the message 'connecting to gateway' also as fast as possible and
 * also moving") — `connecting`: the page has no gateway connection (a first load, a restart). It
 * replaces the static "Connecting to gateway..." line that sat in the pane until the first render,
 * in the same moving pill, at once. On an EMPTY page a read shows at once too.
 *
 * FORK 2026-10-06 (the architect, after a restart that kept his page: "I could see a 'loading context'
 * indicator that did not add anything … Consider what the front-end has loaded, and do not try to
 * reload that which is already loaded") — over a page that already HOLDS rows nothing is drawn for
 * the newest rows: not the connecting pill, not the catch-up read, not its retry words. Those rows
 * are loaded; the catch-up only appends what came after them (a restart notice, a resumed answer),
 * and the header's dots already say the socket is down. Only a scroll back, which the user asked
 * for, still shows over rows.
 */
export function historyIndicators(p: {
  loads: Iterable<HistoryLoad>;
  viewedKey: string;
  matches: (loadKey: string, viewedKey: string) => boolean;
  pageHasRows: boolean;
  retryReason: string | null;
  now: number;
  connecting?: boolean;
}): HistoryIndicator[] {
  if (p.connecting) {
    return p.pageHasRows
      ? []
      : [{ place: "center", kind: "tail", label: "Connecting to the gateway" }];
  }
  if (!p.viewedKey) {
    return [];
  }
  let older: HistoryLoad | null = null;
  let tail: HistoryLoad | null = null;
  for (const load of p.loads) {
    if (!p.matches(load.key, p.viewedKey)) {
      continue;
    }
    if (load.kind === "older") {
      older = older && older.startedAt <= load.startedAt ? older : load;
    } else {
      tail = tail && tail.startedAt <= load.startedAt ? tail : load;
    }
  }
  const out: HistoryIndicator[] = [];
  if (older && p.now - older.startedAt >= HISTORY_INDICATOR_DELAY_MS) {
    out.push({ place: "top", kind: "older", label: "Loading earlier turns" });
  }
  if (tail && !p.pageHasRows) {
    out.push({
      place: "center",
      kind: "tail",
      label: p.retryReason !== null ? retryLabel(p.retryReason) : "Loading chat history",
    });
  }
  return out;
}
