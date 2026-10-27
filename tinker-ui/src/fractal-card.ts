/**
 * FRACTAL CARD — the background Fractal's answer, folded under the reply it reflects on (2026-10-09).
 *
 * The Fractal turn runs in a session of its own (fractal-turn.ts), so nothing it writes enters the
 * chat's transcript. This card is where it shows: one fold per reflected prompt, drawn by
 * chat-units.ts right after that prompt's run, in the same green chrome as the 🌿 Fractal section
 * the reply used to carry (`details.fractal-details`, base.css). Folded by default; the owner opens
 * it when he wants it, and it never moves the reply he is reading.
 *
 * States: `running` while the reflection works (the live text shows if he opens it), `done`,
 * `failed`, and `saved` for a reflection this page did not watch (a reload, another tab): the
 * session list says it exists, and its text is fetched the first time the fold opens.
 *
 * Pure: no DOM, no network. app.ts owns the state map, the fetch and the event feed.
 */

export type FractalCardStatus = "running" | "done" | "failed" | "saved";

/**
 * FORK 2026-10-09 (Fractal v2, charter C2/M4) — what the bridge found when it checked the run: the
 * paths it wrote, the commits it made, and every path or commit its text CLAIMS, each looked up on
 * disk. 131 of 536 failed claims in the census were simply not there; the card now says so itself,
 * so nobody has to vote on a card to learn it.
 */
export type FractalCheckClaim = {
  ref: string;
  kind: "path" | "commit";
  ok: boolean;
  byThisRun?: boolean;
  why?: string;
};

export type FractalCheck = {
  verdict: "acted" | "clean" | "unverified";
  writes: string[];
  commits: Array<{ sha: string; repo?: string }>;
  claims: FractalCheckClaim[];
};

export type FractalCard = {
  parentRunId: string;
  /** The Fractal session (`agent:<id>:fractal:<parentRunId>`). */
  sideKey: string;
  /** The chat the reflected prompt was sent in, when this page fired the turn. */
  parentSessionKey?: string;
  status: FractalCardStatus;
  /** The reflection's text: live while running, its last text block once done. */
  text?: string;
  /** What the page measured for the reflected turn (fractal-turn.ts trailDigestLines). */
  digest?: readonly string[];
  error?: string;
  /** A history fetch for a `saved` card is in flight. */
  loading?: boolean;
  /** A history fetch came back with no answer in it. */
  checked?: boolean;
  startedAt?: number;
  endedAt?: number;
  /** The bridge's ledger row for this run (stream `fractal-check`, or `fractal.ledger` after a reload). */
  check?: FractalCheck;
};

export type FractalCardDeps = {
  md: (text: string) => string;
  esc: (text: string) => string;
  /** ` data-fold-key="…"` plus ` open` when the owner left this fold open. */
  foldAttrs: (key: string) => string;
  fmtDuration: (ms: number) => string;
};

export function fractalCardFoldKey(parentRunId: string): string {
  return `fractal-card:${parentRunId}`;
}

const CLAIM_KINDS = new Set(["path", "commit"]);
const VERDICTS = new Set(["acted", "clean", "unverified"]);

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
}

/** A ledger row (charter C2) as the card needs it, or null when it is not one. */
export function fractalCheckFromRow(row: unknown): FractalCheck | null {
  const r = row as Record<string, unknown> | null;
  if (!r || typeof r !== "object") {
    return null;
  }
  const commits = (Array.isArray(r.commits) ? r.commits : [])
    .map((c) => c as { sha?: unknown; repo?: unknown } | null)
    .filter((c): c is { sha: string; repo?: unknown } => typeof c?.sha === "string" && c.sha !== "")
    .map((c) =>
      typeof c.repo === "string" && c.repo ? { sha: c.sha, repo: c.repo } : { sha: c.sha },
    );
  const claims: FractalCheckClaim[] = [];
  for (const raw of Array.isArray(r.claims) ? r.claims : []) {
    const c = raw as Record<string, unknown> | null;
    if (!c || typeof c.ref !== "string" || !c.ref || typeof c.ok !== "boolean") {
      continue;
    }
    claims.push({
      ref: c.ref,
      kind: CLAIM_KINDS.has(String(c.kind)) ? (c.kind as "path" | "commit") : "path",
      ok: c.ok,
      ...(typeof c.byThisRun === "boolean" ? { byThisRun: c.byThisRun } : {}),
      ...(typeof c.why === "string" && c.why ? { why: c.why } : {}),
    });
  }
  const writes = strings(r.writes);
  if (
    !VERDICTS.has(String(r.verdict)) &&
    writes.length === 0 &&
    commits.length === 0 &&
    claims.length === 0
  ) {
    return null;
  }
  const verdict = VERDICTS.has(String(r.verdict))
    ? (r.verdict as FractalCheck["verdict"])
    : claims.some((c) => !c.ok)
      ? "unverified"
      : writes.length + commits.length > 0
        ? "acted"
        : "clean";
  return { verdict, writes, commits, claims };
}

/** Changes the bridge saw the run make: distinct written paths plus distinct commits. */
export function fractalCheckChanges(check: FractalCheck): number {
  return new Set(check.writes).size + new Set(check.commits.map((c) => c.sha)).size;
}

/** The claims the bridge could not find: a path that does not exist, a commit no repo has. */
export function fractalCheckMissing(check: FractalCheck): FractalCheckClaim[] {
  const seen = new Set<string>();
  const out: FractalCheckClaim[] = [];
  for (const c of check.claims) {
    if (!c.ok && !seen.has(c.ref)) {
      seen.add(c.ref);
      out.push(c);
    }
  }
  return out;
}

/** The short line under the reflection's text: "✓ N changes checked", then one ✗ per missing claim. */
export function fractalCheckHtml(check: FractalCheck, esc: (text: string) => string): string {
  const n = fractalCheckChanges(check);
  const ok = `<div class="fractal-check-ok">✓ ${n} change${n === 1 ? "" : "s"} checked</div>`;
  const missing = fractalCheckMissing(check)
    .map(
      (c) =>
        `<div class="fractal-check-missing">✗ claimed but not found: <code>${esc(c.ref)}</code></div>`,
    )
    .join("");
  return `<div class="fractal-check fractal-check-${check.verdict}">${ok}${missing}</div>`;
}

/**
 * FORK 2026-10-10 (the owner: "The 1-line collapsed form needs to explain what file has changed (since file changes mean
 * something remains after the turn). If nothing is changed, just say nothing to report"). From the bridge's measured
 * writes and commits, never from the reflection's own words: "changed a.md, b.ts +2 · commit abc1234", or
 * "nothing to report" when the run left nothing on disk. Null until the check arrives.
 */
export function fractalChangedLabel(check: FractalCheck | undefined): string | null {
  if (!check) {
    return null;
  }
  const files = [...new Set(check.writes.map((w) => w.split("/").pop() || w))];
  const shas = [...new Set(check.commits.map((c) => c.sha.slice(0, 7)))];
  if (files.length === 0 && shas.length === 0) {
    return "nothing to report";
  }
  const parts: string[] = [];
  if (files.length > 0) {
    parts.push(
      `changed ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` +${files.length - 3}` : ""}`,
    );
  }
  if (shas.length > 0) {
    parts.push(
      `commit${shas.length === 1 ? "" : "s"} ${shas.slice(0, 2).join(", ")}${shas.length > 2 ? ` +${shas.length - 2}` : ""}`,
    );
  }
  return parts.join(" · ");
}

function summaryText(card: FractalCard, deps: FractalCardDeps): string {
  const took =
    card.startedAt !== undefined && card.endedAt !== undefined && card.endedAt > card.startedAt
      ? ` · ${deps.fmtDuration(card.endedAt - card.startedAt)}`
      : "";
  // FORK 2026-10-09 — a claim the bridge could not find shows on the FOLDED card too: the fold is
  // all the owner sees unless he opens it, and a phantom claim is the one thing he must not miss.
  const missing = card.check ? fractalCheckMissing(card.check).length : 0;
  const flag = missing > 0 ? ` · ✗ ${missing} not found` : "";
  switch (card.status) {
    case "running":
      return "🌿 Fractal · reflecting in the background…";
    case "done": {
      const changed = fractalChangedLabel(card.check);
      return changed ? `🌿 Fractal · ${changed}${flag}` : `🌿 Fractal · done${took}${flag}`;
    }
    case "failed":
      return `🌿 Fractal · failed${card.error ? `: ${card.error}` : ""}`;
    default: {
      const changed = fractalChangedLabel(card.check);
      return changed ? `🌿 Fractal · ${changed}${flag}` : `🌿 Fractal${flag}`;
    }
  }
}

function bodyHtml(card: FractalCard, deps: FractalCardDeps): string {
  const text = (card.text ?? "").trim();
  if (text) {
    return deps.md(text);
  }
  if (card.loading) {
    return "<em>loading…</em>";
  }
  if (card.status === "running") {
    return "<em>Working. The reflection shows here as it is written.</em>";
  }
  if (card.status === "failed") {
    return "<em>The reflection did not finish.</em>";
  }
  if (card.status === "done") {
    return "<em>The reflection ended without a text block.</em>";
  }
  if (card.checked) {
    return "<em>No reflection text yet. It may still be running.</em>";
  }
  return "<em>Open to load the reflection.</em>";
}

export function fractalCardHtml(card: FractalCard, deps: FractalCardDeps): string {
  const digest =
    card.digest && card.digest.length > 0
      ? `<div class="fractal-card-digest"><div class="fractal-card-digest-head">What the page measured for the turn</div>` +
        card.digest.map((line) => `<div>${deps.esc(line.replace(/^- /, ""))}</div>`).join("") +
        `</div>`
      : "";
  return (
    `<details class="fractal-details fractal-card fractal-card-${card.status}" ` +
    `data-fractal-card="${deps.esc(card.parentRunId)}"${deps.foldAttrs(fractalCardFoldKey(card.parentRunId))}>` +
    `<summary class="fractal-summary">${deps.esc(summaryText(card, deps))}</summary>` +
    `<div class="msg msg-fractal">${bodyHtml(card, deps)}${card.check ? fractalCheckHtml(card.check, deps.esc) : ""}${digest}</div>` +
    `</details>`
  );
}

/** The text of one transcript content value: its text blocks only, joined. */
function textBlocks(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((b) =>
      b && typeof b === "object" && (b as { type?: unknown }).type === "text"
        ? String((b as { text?: unknown }).text ?? "")
        : "",
    )
    .filter((t) => t.trim() !== "")
    .join("\n\n");
}

const TOOL_CALL_TYPES = new Set(["tool_use", "toolcall", "tooluse"]);

/**
 * The reflection's answer in a Fractal session's history: the text of its LAST assistant row. The
 * prompt asks for the answer as the turn's last text block, after every tool call, so the narration
 * before each tool call stays out. "" while that row is still a tool call (the run is going, or its
 * last row is not written yet): an earlier narration line is never passed off as the answer.
 */
export function reflectionTextFromHistory(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown; text?: unknown } | null;
    if (!m || m.role !== "assistant") {
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    const callsATool = blocks.some((b) =>
      TOOL_CALL_TYPES.has(String((b as { type?: unknown } | null)?.type ?? "").toLowerCase()),
    );
    if (callsATool) {
      return "";
    }
    // A thinking-only row (the bridge stores thinking as its own row) says nothing; look past it.
    const text = textBlocks(m.content ?? m.text).trim();
    if (text) {
      return text;
    }
  }
  return "";
}
