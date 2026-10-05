// FORK 2026-09-29 (plan docs/superpowers/plans/2026-09-29-chat-usage-chips-and-typed-outcomes.md,
// U10). ONE producer for every "we used X" chip in the chat: the recipe chip (§5.8N), the skill
// chip (§5.8O), and the plugin chip added here.
//
// THE DEFECT. Measured on the live transcripts 2026-09-29: a chip drew in 91 of about 370 turns
// that used a skill, a recipe or a plugin. Recipe and plugin chips drew ZERO times. The cause was
// not one bug but a shape: three independent producers, each with its own markup, its own dedupe
// rule and its own render site, and no producer at all for a plugin. The gateway now attributes
// every tool call once (`src/fork/usage-attribution.ts`) and ships `UsageMark[]` in two carriers —
// `data.usage` on live `stream:"tool"` start events, and `__openclaw.usage` on the served user
// message that opened the turn. This module is the single consumer of both.
//
// WHY A MIRROR TYPE. tinker-ui is a separate Vite build and cannot import from `src/`, so the shape
// is restated here. Everything that crosses the wire is re-validated by `isUsageMark` before it can
// reach the DOM: a transcript is data, not a contract, and a `name` comes off a tool ARGUMENT.
//
// WHY `via` IS NOT VALIDATED AGAINST A CLOSED SET. The gateway's `UsageVia` is a closed union
// today, but nothing here RENDERS it. A guard that rejected an unseen `via` would make one new
// gateway-side value blank the entire chip family with no error anywhere — the silent failure this
// whole unit exists to end. Kind and name are load-bearing and are checked strictly.
//
// WHY THE UI STILL HAS LEGACY PRODUCERS. A row written before the gateway restart carries no
// `usage` at all (plan, review focus 4). `collectUsage` merges the typed field with the marks the
// UI derives itself from the old structural tells, so an old transcript renders at least as well as
// it did before, through this one renderer.
//
// Kept pure and DOM-free so it is unit-testable; app.ts owns where the row is placed.

/** Mirror of `UsageKind` in src/fork/usage-attribution.ts. */
export type UsageKind = "skill" | "recipe" | "plugin";

/**
 * Mirror of `UsageMark` in src/fork/usage-attribution.ts.
 *
 * `via` is typed loosely on purpose (see the header): the gateway's union is
 * `"read" | "exec" | "skill-tool" | "recipe-cli" | "recipe-skill" | "mcp" | "plugin-tool"`, but the
 * UI must not drop a chip over a field it never draws.
 */
export interface UsageMark {
  kind: UsageKind;
  name: string;
  path?: string;
  via?: string;
  toolCallId?: string;
}

const USAGE_KINDS: ReadonlySet<string> = new Set<string>(["skill", "recipe", "plugin"]);

/** Re-validate anything that arrived over the wire before it can reach the DOM. */
export function isUsageMark(v: unknown): v is UsageMark {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return false;
  }
  const m = v as Record<string, unknown>;
  return (
    typeof m.kind === "string" &&
    USAGE_KINDS.has(m.kind) &&
    typeof m.name === "string" &&
    m.name.trim().length > 0 &&
    (m.path === undefined || typeof m.path === "string") &&
    (m.via === undefined || typeof m.via === "string") &&
    (m.toolCallId === undefined || typeof m.toolCallId === "string")
  );
}

/**
 * Merge any number of mark sources into one de-duplicated list, in first-seen order.
 *
 * Identity is `kind` + trimmed `name`. The FIRST mark with a path wins: a later duplicate can
 * UPGRADE a pathless mark to a linked one, but never overwrite a path already known and never
 * downgrade one back to nothing. Non-marks — a stale field, a hand-edited transcript, a kind from a
 * future gateway — are dropped silently; they are data the UI does not understand, not an error.
 */
export function collectUsage(...sources: readonly unknown[]): UsageMark[] {
  const out: UsageMark[] = [];
  const at = new Map<string, number>();
  for (const src of sources) {
    if (!Array.isArray(src)) {
      continue;
    }
    for (const raw of src) {
      if (!isUsageMark(raw)) {
        continue;
      }
      const name = raw.name.trim();
      const path = typeof raw.path === "string" && raw.path.trim() ? raw.path.trim() : undefined;
      const key = `${raw.kind}\u0000${name}`;
      const i = at.get(key);
      if (i === undefined) {
        at.set(key, out.length);
        out.push({
          kind: raw.kind,
          name,
          ...(path ? { path } : {}),
          ...(raw.via ? { via: raw.via } : {}),
          ...(raw.toolCallId ? { toolCallId: raw.toolCallId } : {}),
        });
      } else if (!out[i].path && path) {
        out[i] = { ...out[i], path };
      }
    }
  }
  return out;
}

/** Alias kept for the plan's contract name; `collectUsage` is the n-ary form. */
export function mergeUsageMarks(
  a: readonly UsageMark[] | undefined,
  b: readonly UsageMark[] | undefined,
): UsageMark[] {
  return collectUsage(a, b);
}

/** recipe → skill → plugin. Stable within a kind, so a repaint produces byte-identical HTML. */
const KIND_ORDER: Record<UsageKind, number> = { recipe: 0, skill: 1, plugin: 2 };

const CHIP: Record<UsageKind, { cls: string; icon: string; lead: string }> = {
  recipe: { cls: "msg-recipe-notice", icon: "\u{1F373}", lead: "Using recipe" },
  skill: { cls: "msg-skill-notice", icon: "\u{1F527}", lead: "Using skill" },
  plugin: { cls: "msg-plugin-notice", icon: "\u{1F9E9}", lead: "Using plugin" },
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Last path segment — `SKILL.md`, `recipe.md`, `acme-coding.md`, … */
function basename(path: string): string {
  const seg = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return seg[seg.length - 1] || path;
}

/**
 * The link's visible label. A recipe and a skill name the file the link opens, which is what makes
 * it worth clicking; a plugin's path is a manifest or an entry point with no canonical name, so it
 * gets the bare arrow.
 */
function linkLabel(kind: UsageKind, path: string): string {
  return kind === "plugin" ? "" : basename(path);
}

/** One chip. Exported so a lone-chip site (the injected skill-body fold, §5.8O) shares the markup. */
export function renderUsageChip(mark: UsageMark): string {
  const spec = CHIP[mark.kind];
  if (!spec) {
    return "";
  }
  const path = typeof mark.path === "string" ? mark.path.trim() : "";
  let link = "";
  if (path) {
    // NEVER a guessed link (plan, global constraints; the same call as §5.8N/§5.8O): a confidently
    // wrong path is worse than no link, because it looks authoritative and opens the wrong file.
    const p = esc(path);
    const label = linkLabel(mark.kind, path);
    link =
      `<code class="fs-link ${spec.cls}-link" data-path="${p}" ` +
      `title="Open ${p}">${label ? `${esc(label)} ` : ""}↗</code>`;
  }
  return (
    `<div class="${spec.cls}">` +
    `<span class="${spec.cls}-icon">${spec.icon}</span>` +
    `<span class="${spec.cls}-text">${spec.lead} <strong>${esc(mark.name)}</strong></span>` +
    link +
    `</div>`
  );
}

/**
 * One chip per distinct kind+name, ordered recipe → skill → plugin.
 *
 * Deterministic for §5.8X: the same marks in any order produce the same string, so a keyed repaint
 * compares equal and the node is reused rather than re-parsed.
 */
export function renderUsageChips(marks: unknown): string {
  const merged = collectUsage(marks);
  if (merged.length === 0) {
    return "";
  }
  return merged
    .map((m, i) => ({ m, i }))
    .sort((a, b) => KIND_ORDER[a.m.kind] - KIND_ORDER[b.m.kind] || a.i - b.i)
    .map((e) => renderUsageChip(e.m))
    .join("");
}

/** Adapter: the legacy `SkillNotice` producers in injected-prompt.ts speak `{name, path}`. */
export function skillMark(n: { name: string; path?: string }, via = "read"): UsageMark {
  return { kind: "skill", name: n.name, via, ...(n.path ? { path: n.path } : {}) };
}

/** Adapter: the legacy recipe producers speak `{title, path}`. */
export function recipeMark(n: { title: string; path?: string }): UsageMark {
  return { kind: "recipe", name: n.title, via: "recipe-cli", ...(n.path ? { path: n.path } : {}) };
}
