/**
 * The Jev chip: a compact line next to the composer saying whether Jev is off (no token), checking a token, on, or refused.
 * It draws what the gateway's `jev.status` answers and follows its `jev.status` event; on a gateway without the method it
 * draws nothing, so an older gateway and this page stay exactly as they were. The status never carries the token.
 */
import { esc as escapeHtml } from "./amygdala-html.js";

export type JevView = {
  state: "dormant" | "unverified" | "armed" | "rejected";
  on: boolean;
  breakerOpen: boolean;
  line: string;
  tokenFile: string;
  tokenHelpUrl?: string;
};

const STATES = new Set(["dormant", "unverified", "armed", "rejected"]);

export function parseJevStatus(raw: unknown): JevView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.state !== "string" || !STATES.has(r.state)) return null;
  if (typeof r.line !== "string" || r.line === "") return null;
  return {
    state: r.state as JevView["state"],
    on: r.on === true,
    breakerOpen: r.breakerOpen === true,
    line: r.line,
    tokenFile: typeof r.tokenFile === "string" ? r.tokenFile : "",
    ...(typeof r.tokenHelpUrl === "string" ? { tokenHelpUrl: r.tokenHelpUrl } : {}),
  };
}

function look(s: JevView): { cls: string; text: string } {
  if (s.state === "dormant") return { cls: "off", text: "Jev: off — no token" };
  if (s.state === "rejected") return { cls: "refused", text: "Jev: off — token refused" };
  if (s.breakerOpen) return { cls: "checking", text: "Jev: on — paused" };
  if (s.state === "unverified") return { cls: "checking", text: "Jev: on — checking" };
  return { cls: "on", text: "Jev: on" };
}

export function renderJevChip(s: JevView | null): string {
  if (!s) return "";
  const { cls, text } = look(s);
  const hint = [
    s.line,
    s.state === "dormant" || s.state === "rejected"
      ? `Put the token in ${s.tokenFile} (no restart), or set TYPESAFE_API_KEY (needs a restart).`
      : "",
    s.tokenHelpUrl ? `Get a token: ${s.tokenHelpUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `<span class="jev-chip jev-chip--${cls}" data-jev-state="${s.state}" title="${escapeHtml(hint)}">${escapeHtml(text)}</span>`;
}

export function createJevChip(deps: {
  req: (method: string) => Promise<unknown>;
  repaint: () => void;
}) {
  let view: JevView | null = null;
  return {
    html: () => renderJevChip(view),
    async onConnected(): Promise<void> {
      try {
        view = parseJevStatus(await deps.req("jev.status"));
      } catch {
        view = null; // a gateway without the method: the page stays as it was
      }
      deps.repaint();
    },
    onEvent(payload: unknown): void {
      const next = parseJevStatus(payload);
      if (!next) return;
      view = next;
      deps.repaint();
    },
  };
}
