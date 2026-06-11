// FORK 2026-06-11 (parallel fractal reflection v2 — bible §5.67a/§5.67b) — pure
// render module for the 🌿 fractal verdict dock: the compacted block the UI
// docks under the main answer a reflection lane judged. Extracted as a
// one-concern module mirroring the 2026-06-10 sectioned-reply.ts extraction:
// app.ts keeps ONLY the `"fractal"` KNOWN_STREAMS entry, a one-line dispatch
// into this module, and the anchor lookup that reads app.ts-owned message
// state (the `_fractalParentRunId` join). NO app.ts imports here — pure DOM +
// types, unit-testable in isolation.
//
// Chrome: the dock reuses the collapsed Commentary chrome emitted by
// sectioned-reply.ts (`<details class="reasoning-group narration-details">`,
// summary `.reasoning-header`, body `.reasoning-content` — CSS at base.css
// ~1334-1386) so it reads as a sibling of the reasoning group, plus
// dock-specific classes for fractal styling and the upsert join.
//
// Liveness contract (two events, §5.67b): a `pending` stub docks instantly at
// lane spawn; the terminal row replaces it IN PLACE via upsertFractalDock
// (matched by `data-fractal-parent`) — replace, never duplicate.
//
// Reporting-channel rule (§5.67b): any "changed X" claim renders ONLY from
// tool-event-derived ledger fields (artifactsTouched / fractalChanges /
// mainChanges) — model prose (`reasoning`) is narrative, never telemetry. The
// reasoning is rendered as plain text-with-line-breaks: no markdown, no HTML
// (every string goes through createTextNode / textContent).

// ---------------------------------------------------------------------------
// Types — structural mirror of the fractal-reflection plugin's FractalRow
// (the results.jsonl ledger row, which also rides the `stream:"fractal"`
// event envelope). tinker-ui never imports from extensions/ — server payload
// shapes are duplicated locally (the same pattern the panels/ modules use for
// their RPC payloads). Only the fields the dock renders are mirrored; extra
// server fields are tolerated and ignored.
// ---------------------------------------------------------------------------

// Canonical status union (§5.67b "status union grows" + the v2 liveness words
// acted / clean / error). FractalDockRow.status stays an open `string` so a
// server status newer than this mirror renders instead of breaking.
export type FractalDockStatus =
  | "pending"
  | "acted"
  | "clean"
  | "flagged"
  | "skipped"
  | "proposed"
  | "applied"
  | "dismissed"
  | "suspended"
  | "error";

export interface FractalDockFinding {
  /** findingKind — rendered as a chip (e.g. "bug", "gap", "stale-doc"). */
  kind?: string;
  /** evidence.claim — the falsifiable one-liner. */
  claim?: string;
  /** evidence.path — the file the claim is about. */
  path?: string;
}

export interface FractalDockRow {
  /** runId of the MAIN turn this reflection judged — the dock join key. */
  parentRunId: string;
  /** the fractal lane's own runId (absent on a pending stub). */
  runId?: string;
  /** canonical values in FractalDockStatus; open for forward tolerance. */
  status: string;
  /** skip reason (quota | superseded | budget) when status is "skipped". */
  reason?: string;
  /** one-line verdict headline. */
  verdict?: string;
  /** triage findings (`flagged` = found-not-fixed in Drop 1). */
  findings?: FractalDockFinding[];
  /** model narrative — rendered as plain text, never parsed as telemetry. */
  reasoning?: string;
  /** tool-event-derived paths the fix lane touched (Drop 1 ships empty). */
  artifactsTouched?: string[];
  /** attribution split, tool-event derived (Drop 1: present-but-empty). */
  fractalChanges?: string[];
  mainChanges?: string[];
}

// Status word shown in the summary. `⚠ error` is the §5.67a liveness-signal
// spelling; `skipped` carries its reason (the ledger's `skipped(reason)`).
function statusWord(row: FractalDockRow): string {
  if (row.status === "error") {
    return "⚠ error";
  }
  if (row.status === "skipped" && row.reason) {
    return `skipped:${row.reason}`;
  }
  return row.status;
}

// Class-safe token: the status is server-controlled, but a malformed row must
// never inject a stray class or selector fragment.
function statusClass(status: string): string {
  return `fractal-status-${status.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`;
}

function textWithLineBreaks(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      frag.appendChild(document.createElement("br"));
    }
    frag.appendChild(document.createTextNode(lines[i] ?? ""));
  }
  return frag;
}

function renderAttribution(label: string, files: string[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "fractal-dock-attribution";
  const head = document.createElement("div");
  head.className = "fractal-attribution-label";
  head.textContent = label;
  wrap.appendChild(head);
  const list = document.createElement("ul");
  list.className = "fractal-attribution-files";
  for (const file of files) {
    const li = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = file;
    li.appendChild(code);
    list.appendChild(li);
  }
  wrap.appendChild(list);
  return wrap;
}

// Render one verdict dock. Collapsed by default — this function never sets
// the `open` attribute (upsertFractalDock carries the user's open state
// across the pending→final morph instead).
export function renderFractalDock(row: FractalDockRow): HTMLElement {
  const dock = document.createElement("details");
  dock.className = `reasoning-group narration-details fractal-dock ${statusClass(row.status)}`;
  dock.dataset.fractalParent = row.parentRunId;

  const findings = row.findings ?? [];
  const summary = document.createElement("summary");
  summary.className = "reasoning-header fractal-dock-summary";
  summary.textContent =
    `🌿 Fractal · ${statusWord(row)}` +
    (findings.length > 0 ? ` · ${findings.length} finding${findings.length === 1 ? "" : "s"}` : "");
  dock.appendChild(summary);

  const body = document.createElement("div");
  body.className = "reasoning-content fractal-dock-body";

  const headline = (row.verdict ?? "").trim();
  if (headline) {
    const el = document.createElement("div");
    el.className = "fractal-dock-headline";
    el.textContent = headline;
    body.appendChild(el);
  }

  if (findings.length > 0) {
    const list = document.createElement("ul");
    list.className = "fractal-dock-findings";
    for (const finding of findings) {
      const li = document.createElement("li");
      li.className = "fractal-dock-finding";
      if (finding.kind) {
        const chip = document.createElement("span");
        chip.className = "fractal-finding-kind";
        chip.textContent = finding.kind;
        li.appendChild(chip);
        li.appendChild(document.createTextNode(" "));
      }
      if (finding.claim) {
        const claim = document.createElement("span");
        claim.className = "fractal-finding-claim";
        claim.textContent = finding.claim;
        li.appendChild(claim);
      }
      if (finding.path) {
        li.appendChild(document.createTextNode(" "));
        const path = document.createElement("code");
        path.className = "fractal-finding-path";
        path.textContent = finding.path;
        li.appendChild(path);
      }
      list.appendChild(li);
    }
    body.appendChild(list);
  }

  const reasoning = (row.reasoning ?? "").trim();
  if (reasoning) {
    // Plain text-with-line-breaks ON PURPOSE: sectioned-reply.ts takes its
    // markdown renderer injected from app.ts (there is no reusable standalone
    // md() to share), and reasoning is narrative — never telemetry — so it
    // gets no markup interpretation at all.
    const el = document.createElement("div");
    el.className = "fractal-dock-reasoning";
    el.appendChild(textWithLineBreaks(reasoning));
    body.appendChild(el);
  }

  // Attribution lists render ONLY when the fix lane actually touched files
  // (artifactsTouched is tool-event-derived). Drop 1 ships fractalChanges /
  // mainChanges present-but-empty, so no Drop-1 row renders these.
  if ((row.artifactsTouched ?? []).length > 0) {
    body.appendChild(renderAttribution("Reflection changed", row.fractalChanges ?? []));
    body.appendChild(renderAttribution("Main turn changed", row.mainChanges ?? []));
  }

  dock.appendChild(body);
  return dock;
}

// Locate an existing dock for a parent runId. The attribute value is escaped
// so a malformed runId can never break the selector.
function findExistingDock(container: HTMLElement, parentRunId: string): HTMLElement | null {
  const escaped = parentRunId.replace(/["\\]/g, "\\$&");
  return container.querySelector<HTMLElement>(
    `details.fractal-dock[data-fractal-parent="${escaped}"]`,
  );
}

// Dock placement. app.ts owns the message state, so it supplies the lookup
// that resolves the answer element for a parentRunId (answer bubbles carry NO
// runId in the DOM — the `_reasoningRunId`/`_subagentId` precedent). When the
// lookup resolves to an attached element the dock goes immediately AFTER it;
// otherwise it appends to the container tagged `fractal-orphan` (a late or
// raced event must still land somewhere visible). Returns the dock.
export function findDockAnchor(
  container: HTMLElement,
  dock: HTMLElement,
  parentRunId: string,
  lookupAnchor?: (parentRunId: string) => HTMLElement | null,
): HTMLElement {
  const anchor = lookupAnchor ? lookupAnchor(parentRunId) : null;
  if (anchor && anchor.parentElement) {
    dock.classList.remove("fractal-orphan");
    anchor.insertAdjacentElement("afterend", dock);
    return dock;
  }
  dock.classList.add("fractal-orphan");
  container.appendChild(dock);
  return dock;
}

// The pending→final fill: if a dock for row.parentRunId already exists in the
// container it is morphed IN PLACE (replace, never duplicate — position, the
// user's open state, and the orphan tag survive); otherwise a fresh dock is
// placed via findDockAnchor. Returns the live element.
export function upsertFractalDock(
  container: HTMLElement,
  row: FractalDockRow,
  lookupAnchor?: (parentRunId: string) => HTMLElement | null,
): HTMLElement {
  const fresh = renderFractalDock(row);
  const existing = findExistingDock(container, row.parentRunId);
  if (existing) {
    if (
      existing instanceof HTMLDetailsElement &&
      existing.open &&
      fresh instanceof HTMLDetailsElement
    ) {
      fresh.open = true;
    }
    if (existing.classList.contains("fractal-orphan")) {
      fresh.classList.add("fractal-orphan");
    }
    existing.replaceWith(fresh);
    return fresh;
  }
  return findDockAnchor(container, fresh, row.parentRunId, lookupAnchor);
}
