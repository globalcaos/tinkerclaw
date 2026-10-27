// FORK 2026-10-05 (the architect: "When we have a master-slave chain set up and the task at hand needs a
// gantt chart, I would like to have a dedicated tab to visualize it. This tab would appear as a
// slither tab (only a graph icon) between master and slave, and would be attached to the master,
// meaning that deleting the first would delete the graph tab.")
//
// Pure module: no DOM. The board list comes from tinker-prod-ui (/api/gantt/boards), which reads
// what skill build-gantt registered (`gantt.py render` from a Tinker chat, or `gantt.py attach`).
// A board belongs to a SESSION, so it follows the master through a reopen; it only shows while
// that session is the master end of a chain whose tab is open. The tab is not a chat tab: it has
// no data-tab-id, so drag, close, chain anchors and session switching never see it.

import type { TabChain } from "./tab-chains.js";

export type GanttBoard = { session: string; plan: string; title: string };

type KeyMatch = (a: string, b: string) => boolean;

/** ui-state choice: the master tab whose chart covers the chat, restored after a reload. */
export const GANTT_VIEW_CHOICE = "gantt:view";

/** Never throws: anything malformed reads as "no boards". */
export function parseGanttBoards(raw: unknown): GanttBoard[] {
  const list = (raw as { boards?: unknown } | null)?.boards;
  if (!Array.isArray(list)) return [];
  const out: GanttBoard[] = [];
  for (const b of list) {
    if (!b || typeof b !== "object") continue;
    const { session, plan, title } = b as Record<string, unknown>;
    if (typeof session !== "string" || !session || typeof plan !== "string" || !plan) continue;
    out.push({ session, plan, title: typeof title === "string" ? title : "" });
  }
  return out;
}

/** Master tab id → its board, for every chain whose master tab is open and has a board. */
export function ganttBoardsByMaster(
  chains: readonly TabChain[],
  boards: readonly GanttBoard[],
  sessionKeyOfOpenTab: (tabId: string) => string | null | undefined,
  match: KeyMatch,
): Map<string, GanttBoard> {
  const out = new Map<string, GanttBoard>();
  if (!boards.length) return out;
  for (const c of chains) {
    const key = sessionKeyOfOpenTab(c.master);
    if (!key) continue;
    const board = boards.find((b) => match(b.session, key));
    if (board) out.set(c.master, board);
  }
  return out;
}

/** Three bars: done (solid), running (lighter), planned (dashed), like the chart itself. */
export const GANTT_ICON_SVG =
  '<svg viewBox="0 0 16 14" width="16" height="14" focusable="false" aria-hidden="true">' +
  '<rect x="1" y="1.5" width="7" height="3" rx="1" fill="currentColor"/>' +
  '<rect x="5" y="5.5" width="7.5" height="3" rx="1" fill="currentColor" opacity=".65"/>' +
  '<rect x="9.5" y="10" width="5.5" height="2.6" rx="1" fill="none" stroke="currentColor" ' +
  'stroke-width="1" stroke-dasharray="1.8 1.2"/>' +
  "</svg>";

export function ganttTabHtml(
  masterTabId: string,
  board: GanttBoard,
  opts: { active: boolean; color: string; escape: (s: string) => string },
): string {
  const hint = `Gantt chart${board.title ? ` · ${board.title}` : ""}`;
  return (
    `<div class="tab tab-gantt${opts.active ? " tab-active" : ""}" data-gantt-for="${opts.escape(masterTabId)}"` +
    ` data-hint="${opts.escape(hint)}" style="color:${opts.escape(opts.color)}" role="tab"` +
    ` aria-label="${opts.escape(hint)}">${GANTT_ICON_SVG}</div>`
  );
}

/** What the Gantt tab's frame loads. Same origin as the page (tinker-prod-ui). */
export function ganttViewUrl(sessionKey: string): string {
  return `/api/gantt/view?session=${encodeURIComponent(sessionKey)}`;
}
