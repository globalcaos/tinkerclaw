/**
 * The ask-session card (FORK 2026-10-21): a purple box in the feed, in the theme, saying which question was asked,
 * which session was woken and what it answered. Expanded, it shows that session's thinking and tool calls in the same
 * purple, and the tool calls expand as usual.
 *
 * The agent runs the skill through Bash (`python3 -I …/ask-session/scripts/sessions.py ask <id> "<question>"`), so the
 * call arrives as an ordinary tool_use. `parseAskSessionCall` recognises it from the command and reads the result:
 * `sessions.py ask` ends with one `[ask-session] {…}` line naming the woken session, the question and the byte range
 * the wake appended to that session's transcript (with --json the same fields sit in the object). Expanding the card
 * asks the gateway for that range (`askSession.slice`) and draws the woken session's thinking, narration and tool
 * calls inside the purple frame, with the feed's own `tool-row` / `tool-detail` markup, so each call opens on click
 * exactly like a row of the main feed (app.ts's `[data-tid]` handler and `expandedTools`).
 *
 * Pure HTML-string builders plus one small loader; no DOM. Every dynamic string goes through `esc` or `md`.
 */

export type AskSessionState = "running" | "answered" | "failed" | "refused";

export interface AskSessionCall {
  sessionId: string | null;
  question: string | null;
  title: string | null;
  /** The woken session's knowledge date (its last real work), YYYY-MM-DD. */
  date: string | null;
  answer: string | null;
  state: AskSessionState;
  /** A refusal or failure, in the tool's own words. */
  note: string | null;
  /** The transcript bytes the wake appended; null before the result, or from a tool older than the record. */
  range: { fromByte: number; toByte: number } | null;
  durationS: number | null;
}

export const ASK_RECORD_TAG = "[ask-session]";

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Only a shell tool can run the skill: Claude Code's `Bash`, OpenClaw's `exec`. */
function commandOf(name: unknown, input: unknown): string | null {
  const n = String(name ?? "").toLowerCase();
  if (n !== "bash" && n !== "exec") {
    return null;
  }
  return str((input as { command?: unknown } | null)?.command);
}

/** The argument that starts at `s[0]`: a quoted string (with shell escapes undone) or a bare word. */
function shellWord(s: string): string | null {
  const q = s[0];
  if (q === '"' || q === "'") {
    let out = "";
    for (let i = 1; i < s.length; i++) {
      const c = s[i];
      if (c === q) {
        return out;
      }
      if (q === '"' && c === "\\" && i + 1 < s.length) {
        out += s[++i];
        continue;
      }
      out += c;
    }
    return out || null;
  }
  return s.match(/^\S+/)?.[0] ?? null;
}

const ASK_CMD =
  /(?:ask-session\/scripts\/sessions\.py|\$\{?S\}?)["']?\s+ask\s+["']?([A-Za-z0-9][A-Za-z0-9_-]{3,})["']?\s+([\s\S]+)/;

/** The id and question a command asks, or null when the command is not an ask-session `ask`. */
export function askFromCommand(
  command: string,
): { sessionId: string; question: string | null } | null {
  if (!command.includes("ask-session")) {
    return null;
  }
  const m = command.match(ASK_CMD);
  if (!m) {
    return null;
  }
  return { sessionId: m[1], question: shellWord(m[2].trimStart()) };
}

/** A tool result as plain text: a string, or the `[{type:"text",text}]` array some paths serialise. */
export function resultText(content: unknown): string {
  if (typeof content === "string") {
    const t = content.trimStart();
    if (t.startsWith('[{"type":"text"')) {
      try {
        return resultText(JSON.parse(t));
      } catch {
        return content;
      }
    }
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : (str((b as { text?: unknown })?.text) ?? "")))
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

function rangeOf(t: unknown): AskSessionCall["range"] {
  const r = t as { fromByte?: unknown; toByte?: unknown } | null;
  const from = num(r?.fromByte);
  const to = num(r?.toByte);
  return from !== null && to !== null && to >= from ? { fromByte: from, toByte: to } : null;
}

/** The `[ask-session] {…}` record line, or the --json object; null when the output has neither. */
function recordOf(out: string): Record<string, unknown> | null {
  const line = out.match(/^\[ask-session\] (\{.*\})\s*$/m);
  const raw = line ? line[1] : out.trim().startsWith("{") ? out.trim() : null;
  if (!raw) {
    return null;
  }
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return o && typeof o === "object" && ("transcript" in o || "testimony" in o || "refused" in o)
      ? o
      : null;
  } catch {
    return null;
  }
}

/** The answer text between the `Session <id> (<date>) says:` label and the `[testimony, …]` footer. */
function answerOf(out: string): string | null {
  const label = out.match(/^Session \S+ \([^)]*\) says:[ \t]*$/m);
  if (!label || label.index === undefined) {
    return null;
  }
  let rest = out.slice(label.index + label[0].length);
  const foot = rest.search(/\n\[testimony, not verified/);
  if (foot >= 0) {
    rest = rest.slice(0, foot);
  } else {
    const rec = rest.search(/\n\[ask-session\] \{/);
    if (rec >= 0) {
      rest = rest.slice(0, rec);
    }
  }
  return str(rest.trim());
}

/**
 * An ask-session `ask` call, read from its tool_use and (when it has one) its result. Null for any other tool call,
 * including the skill's `find`, `show` and `cost`, which stay ordinary rows.
 */
export function parseAskSessionCall(
  name: unknown,
  input: unknown,
  result?: { content: unknown; isError?: boolean } | null,
): AskSessionCall | null {
  const command = commandOf(name, input);
  const asked = command ? askFromCommand(command) : null;
  if (!asked) {
    return null;
  }
  const call: AskSessionCall = {
    sessionId: asked.sessionId,
    question: asked.question,
    title: null,
    date: null,
    answer: null,
    state: "running",
    note: null,
    range: null,
    durationS: null,
  };
  if (!result) {
    return call;
  }
  const out = resultText(result.content);
  const rec = recordOf(out);
  if (rec) {
    call.sessionId = str(rec.id) ?? call.sessionId;
    call.question = str(rec.question) ?? call.question;
    call.title = str(rec.title);
    call.date = str(rec.date);
    call.range = rangeOf(rec.transcript);
    call.durationS = num(rec.duration_s);
    if (str(rec.refused)) {
      call.state = "refused";
      call.note = str(rec.refused);
      return call;
    }
  }
  call.answer = str(rec?.answer)?.trim() || answerOf(out);
  const refused = out.match(/ask-session: (refused[^\n]*)/);
  const failed = out.match(/ask-session: (the wake failed[^\n]*)/);
  if (call.answer && !(rec && rec.error === true)) {
    call.state = "answered";
  } else if (refused) {
    call.state = "refused";
    call.note = refused[1];
  } else {
    call.state = "failed";
    call.note = failed?.[1] ?? (str(out.trim().split("\n")[0]) || "the wake gave no answer");
  }
  return call;
}

// ---------------------------------------------------------------- the woken session's trail

export type SliceState =
  | { status: "loading" }
  | { status: "ready"; messages: unknown[]; truncated: boolean }
  | { status: "error"; message: string };

export interface AskCardDeps {
  esc: (s: string) => string;
  md: (s: string) => string;
  /** The feed's one-line tool title and its expanded detail (app.ts toolSummary / toolExpandedDetail). */
  toolSummary: (name: string, input: unknown) => string;
  toolDetail: (name: string, input: unknown) => string;
  isExpanded: (tid: string) => boolean;
}

type Block = Record<string, unknown>;

function blocksOf(msg: unknown): Block[] {
  const c = (msg as { content?: unknown } | null)?.content;
  return Array.isArray(c) ? (c.filter((b) => b && typeof b === "object") as Block[]) : [];
}

const isToolCall = (b: Block) =>
  b.type === "tool_use" || b.type === "toolcall" || b.type === "toolCall";

/** How many tool calls a slice holds (the card's header counts them once loaded). */
export function countToolCalls(messages: readonly unknown[]): number {
  let n = 0;
  for (const m of messages) {
    for (const b of blocksOf(m)) {
      if (isToolCall(b)) {
        n++;
      }
    }
  }
  return n;
}

/**
 * The woken session's turn, in order: thinking, narration and tool calls. The wake's own prompt (the user message
 * that carries the question and the wake-up note) is left out: the card already shows the question. Tool results
 * sit inside their call's row, as in the main feed.
 */
export function renderTrail(messages: readonly unknown[], tid: string, deps: AskCardDeps): string {
  const { esc, md } = deps;
  const results = new Map<string, { content: string; isError: boolean }>();
  for (const m of messages) {
    for (const b of blocksOf(m)) {
      if (b.type === "tool_result") {
        const id = str(b.tool_use_id) ?? str(b.toolUseId) ?? str(b.id);
        if (id) {
          results.set(id, { content: resultText(b.content), isError: b.is_error === true });
        }
      }
    }
  }
  let h = "";
  let k = 0;
  for (const m of messages) {
    if ((m as { role?: unknown } | null)?.role !== "assistant") {
      continue;
    }
    for (const b of blocksOf(m)) {
      if (b.type === "thinking") {
        const t = str(b.thinking) ?? str(b.text);
        if (t?.trim()) {
          h += `<div class="ask-trail-thinking"><span class="thinking-label">Thinking:</span> ${md(t)}</div>`;
        }
      } else if (b.type === "text") {
        const t = str(b.text);
        if (t?.trim()) {
          h += `<div class="ask-trail-text">${md(t)}</div>`;
        }
      } else if (isToolCall(b)) {
        const name = str(b.name) ?? "tool";
        const input = b.input ?? b.arguments ?? {};
        const id = str(b.id);
        const rowTid = `${tid}:${id ?? `n${k}`}`;
        k++;
        const paired = id ? results.get(id) : undefined;
        const icon = paired ? (paired.isError ? "✗" : "✓") : "⋯";
        const cls = paired ? (paired.isError ? "err" : "ok") : "run";
        h += `<div class="tool-row" data-tid="${esc(rowTid)}"><span class="status ${cls}">${icon}</span><span class="detail">${esc(deps.toolSummary(name, input))}</span></div>`;
        if (deps.isExpanded(rowTid)) {
          h += `<div class="tool-detail">${deps.toolDetail(name, input)}`;
          if (paired?.content) {
            h += `<div class="tool-result-inline"><div class="explanation">${paired.isError ? "❌ Something went wrong:" : "stdout:"}</div><div class="code-block">${esc(paired.content)}</div></div>`;
          }
          h += `</div>`;
        }
      }
    }
  }
  return h;
}

const STATE_WORD: Record<AskSessionState, string> = {
  running: "waking it…",
  answered: "",
  failed: "the wake failed",
  refused: "refused",
};

/** The purple card. `slice` is the woken session's trail state; undefined while the card is closed. */
export function renderAskCard(
  call: AskSessionCall,
  tid: string,
  slice: SliceState | undefined,
  deps: AskCardDeps,
): string {
  const { esc, md } = deps;
  const open = deps.isExpanded(tid);
  const who = call.title ? esc(call.title) : "a past session";
  const meta = [
    call.sessionId ? call.sessionId.slice(0, 8) : null,
    call.date,
    call.durationS !== null ? `${call.durationS} s` : null,
  ]
    .filter(Boolean)
    .map((s) => esc(String(s)))
    .join(" · ");
  const calls = slice?.status === "ready" ? countToolCalls(slice.messages) : null;
  const toggleWord = open ? "Hide its thinking and tool calls" : "Show its thinking and tool calls";
  const toggleCount = calls !== null ? ` (${calls} tool call${calls === 1 ? "" : "s"})` : "";
  const status = STATE_WORD[call.state];

  let h = `<div class="ask-card ask-card-${call.state}" data-ask-card="${esc(tid)}">`;
  h += `<div class="ask-card-head" data-tid="${esc(tid)}" title="${open ? "Collapse" : "Expand"} the woken session's turn">`;
  h += `<span class="ask-card-icon">🗣️</span><span class="ask-card-kind">Woke a session</span>`;
  h += `<span class="ask-card-who">${who}</span>`;
  if (meta) {
    h += `<span class="ask-card-meta">${meta}</span>`;
  }
  if (status) {
    h += `<span class="ask-card-status">${esc(status)}</span>`;
  }
  h += `<span class="ask-card-chev">${open ? "▾" : "▸"}</span></div>`;
  h += `<div class="ask-card-field"><span class="ask-card-label">Asked</span><div class="ask-card-q">${esc(call.question ?? "(question not readable from the command)")}</div></div>`;
  if (call.answer) {
    h += `<div class="ask-card-field"><span class="ask-card-label">Answer</span><div class="ask-card-a">${md(call.answer)}</div></div>`;
  } else if (call.note) {
    h += `<div class="ask-card-field"><span class="ask-card-label">Result</span><div class="ask-card-note">${esc(call.note)}</div></div>`;
  }
  if (call.state !== "running") {
    h += `<div class="ask-card-toggle" data-tid="${esc(tid)}">${open ? "▾" : "▸"} ${toggleWord}${toggleCount}</div>`;
  }
  if (open) {
    h += `<div class="ask-card-trail">`;
    if (!call.range) {
      h += `<div class="ask-card-empty">No transcript range was recorded for this ask (a skill older than 2026-10-21, or a wake that never started).</div>`;
    } else if (!slice || slice.status === "loading") {
      h += `<div class="ask-card-empty">Loading the woken session's turn…</div>`;
    } else if (slice.status === "error") {
      h += `<div class="ask-card-empty">Could not load the woken session's turn: ${esc(slice.message)}</div>`;
    } else {
      const trail = renderTrail(slice.messages, tid, deps);
      h +=
        trail ||
        `<div class="ask-card-empty">The wake added nothing to the session's transcript.</div>`;
      if (slice.truncated) {
        h += `<div class="ask-card-empty">The turn was longer than the loader reads; the rest is cut.</div>`;
      }
    }
    h += `</div>`;
  }
  h += `</div>`;
  return h;
}

// ---------------------------------------------------------------- the loader

export interface AskSessionUiDeps extends AskCardDeps {
  req: (method: string, params?: unknown) => Promise<unknown>;
  repaint: () => void;
}

/**
 * One card per call. A slice is fetched once per (session, range), the first time its card is drawn open, and kept:
 * the bytes a finished wake appended never change.
 */
export function createAskSessionUi(deps: AskSessionUiDeps) {
  const slices = new Map<string, SliceState>();
  const keyOf = (c: AskSessionCall) =>
    c.sessionId && c.range ? `${c.sessionId}:${c.range.fromByte}:${c.range.toByte}` : null;

  function load(c: AskSessionCall, key: string): void {
    slices.set(key, { status: "loading" });
    deps
      .req("askSession.slice", {
        sessionId: c.sessionId,
        fromByte: c.range!.fromByte,
        toByte: c.range!.toByte,
      })
      .then((r) => {
        const res = (r ?? {}) as { messages?: unknown; truncated?: unknown };
        slices.set(key, {
          status: "ready",
          messages: Array.isArray(res.messages) ? res.messages : [],
          truncated: res.truncated === true,
        });
      })
      .catch((e: unknown) => {
        const msg =
          e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e);
        slices.set(key, { status: "error", message: msg });
      })
      .finally(() => deps.repaint());
  }

  return {
    parse: parseAskSessionCall,
    /** The card for one call; drawing it open starts the slice's one fetch. */
    cardHtml(call: AskSessionCall, tid: string): string {
      const key = keyOf(call);
      if (key && deps.isExpanded(tid) && !slices.has(key)) {
        load(call, key);
      }
      return renderAskCard(call, tid, key ? slices.get(key) : undefined, deps);
    },
  };
}
