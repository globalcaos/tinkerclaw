/**
 * The moral code's PUBLISHED CONTRACT — owned by TinkerClaw, read by every harness.
 *
 * FORK 2026-09-23 (the architect: "I would rather have tinkerclaw initiate, concentrate, say handle
 * this injection … the functionalities should be native in tinkerclaw but then used as extensions
 * from claude code only, like symlinks").
 *
 * TinkerClaw survives token windows because it can switch models, so the moral code has to belong
 * to TinkerClaw, not to whichever model happens to be answering. The split:
 *   - WHAT and WHETHER — TinkerClaw. The `tinkerclaw-moral-code` plugin builds the pack from the
 *     workspace files, delivers it to every non-Claude model itself (including the model a turn
 *     falls back to when Claude runs out), and PUBLISHES it to one file.
 *   - WHEN, for Claude's own context — Claude Code. Claude compacts and starts sessions internally,
 *     where the gateway cannot see, so its SessionStart hook (claude-plugins/tinkerclaw-core) and the
 *     tinker-bridge's resume check read the published file at those moments. Nothing else.
 *
 * The file is the symlink: Claude-side code never builds, edits or decides the content. And when
 * TinkerClaw's moral code is OFF, the gateway retires the file at startup, so Claude cannot keep
 * carrying rules the other models no longer get (measured 2026-09-23: the plugin had been disabled
 * since it shipped, Grok/Sol/fallback turns got nothing, and Claude read a copy frozen for a day).
 */
import fs from "node:fs";
import path from "node:path";

/** The plugin that owns the pack. */
export const MORAL_CODE_PLUGIN_ID = "tinkerclaw-moral-code";

/** Opening tag of the pack. With its closing tag, it delimits one delivery of the pack. */
export const MORAL_CODE_MARKER = '<moral_code source="tinkerclaw">';

/** Closing tag of the pack. A block without it was cut short: it is NOT a delivery. */
export const MORAL_CODE_CLOSE = "</moral_code>";

/**
 * FORK 2026-10-02 — the label a delivery PART carries on the line right after its opening marker.
 * The claude CLI replaces any hook additionalContext over 10,000 chars with a ~2,000-char preview
 * and a file path (CLI 2.1.287, applied to each hook's output), so the tinkerclaw-core SessionStart
 * hook delivers the pack as N complete blocks under that cap
 * (claude-plugins/tinkerclaw-core/scripts/moral-code-parts.mjs writes this label; the hook has no
 * dependencies, so it cannot import it, and delivery-parts.test.ts runs the hook to keep the two in
 * step). The CLI gathers hook outputs as each finishes, so parts may arrive in any order.
 */
export const MORAL_CODE_PART_LABEL = /^\n?\[moral code, part (\d+) of (\d+)\]\n/;

/** The marker as it appears inside a JSONL transcript, JSON-escaped (`source=\"…\"`). */
const MORAL_CODE_MARKER_JSON = JSON.stringify(MORAL_CODE_MARKER).slice(1, -1);

/** Where TinkerClaw publishes the pack: <stateDir>/moral-code/moral-code.md. */
export function moralCodePackPath(stateDir: string): string {
  return path.join(stateDir, "moral-code", "moral-code.md");
}

/** The published pack, or "" when TinkerClaw has not published one (feature off, or not built). */
export function readPublishedMoralCode(stateDir: string): string {
  try {
    return fs.readFileSync(moralCodePackPath(stateDir), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Does this claude CLI transcript carry the WHOLE pack in what the CLI sends to the model? The tinker-
 * bridge asks before resuming a conversation: false means the pack is prefixed to the next user
 * message. Fail-safe: an unreadable transcript counts as "already delivered" (never re-inject blindly).
 */
export function transcriptHasMoralCode(transcriptPath: string): boolean {
  let jsonl: string;
  try {
    jsonl = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return true;
  }
  return moralCodeDeliveredIn(jsonl);
}

/**
 * Pure half of transcriptHasMoralCode. FORK 2026-10-02 — until then ANY occurrence of the opening
 * marker counted, and two things the model never received passed: the CLI's ~2 KB preview of a hook
 * output over its 10,000-char cap (the opening tag, no closing one), and the hook's raw stdout, which
 * the CLI stores in the transcript but never sends. A pack the model saw a sliver of read as delivered,
 * so the resume fallback never fired. Now a delivery is:
 *   - in text the CLI SENDS: a SessionStart (or any) hook_additional_context, a user message's text,
 *     a tool result (the model may have read the pack); never a hook's stdout or a subagent sidechain;
 *   - after the LAST compaction boundary: what came before it is gone from the model's context;
 *   - COMPLETE: one block from the opening marker to the closing tag with no part label (the resume
 *     prefix), or every part 1..N of one N-part set (the SessionStart hook).
 * Only lines that hold the marker or a compaction boundary are parsed, so a multi-MB transcript costs
 * a string scan, not a JSON parse per line.
 */
export function moralCodeDeliveredIn(jsonl: string): boolean {
  const lines = jsonl.split("\n");
  let from = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("compact_boundary") && isCompactBoundary(lines[i])) {
      from = i + 1;
    }
  }
  const parts = new Map<number, Set<number>>();
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(MORAL_CODE_MARKER_JSON) && !line.includes(MORAL_CODE_MARKER)) {
      continue;
    }
    for (const text of sentTexts(line)) {
      let at = text.indexOf(MORAL_CODE_MARKER);
      while (at >= 0) {
        const end = text.indexOf(MORAL_CODE_CLOSE, at + MORAL_CODE_MARKER.length);
        if (end < 0) {
          break;
        }
        const label = MORAL_CODE_PART_LABEL.exec(text.slice(at + MORAL_CODE_MARKER.length, end));
        if (!label) {
          return true;
        }
        const n = Number(label[2]);
        const set = parts.get(n) ?? new Set<number>();
        set.add(Number(label[1]));
        parts.set(n, set);
        if (set.size === n) {
          return true;
        }
        at = text.indexOf(MORAL_CODE_MARKER, end);
      }
    }
  }
  return false;
}

function isCompactBoundary(line: string): boolean {
  try {
    const r = JSON.parse(line) as { type?: unknown; subtype?: unknown; isSidechain?: unknown };
    return r.type === "system" && r.subtype === "compact_boundary" && r.isSidechain !== true;
  } catch {
    return false;
  }
}

/** The texts of one transcript line that the CLI sends to the model (see moralCodeDeliveredIn). */
function sentTexts(line: string): string[] {
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (r.isSidechain === true) {
    return [];
  }
  const out: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === "string") {
      out.push(v);
    } else if (Array.isArray(v)) {
      v.forEach(collect);
    } else if (v && typeof v === "object") {
      const b = v as { type?: unknown; text?: unknown; content?: unknown };
      if (b.type === "text" && typeof b.text === "string") {
        out.push(b.text);
      } else if (b.type === "tool_result") {
        collect(b.content);
      }
    }
  };
  if (r.type === "attachment") {
    const a = r.attachment as { type?: unknown; content?: unknown } | undefined;
    if (a?.type === "hook_additional_context") {
      collect(a.content);
    }
  } else if (r.type === "user") {
    collect((r.message as { content?: unknown } | undefined)?.content);
  }
  return out;
}

/**
 * Should the published pack be withdrawn? Only when the owning plugin is KNOWN to this registry and
 * did not load (disabled or failed). A plugin the registry does not list at all may simply load
 * later (deferred), and removing the file then would leave Claude sessions bare for no reason.
 */
export function shouldRetirePublishedMoralCode(
  plugins: ReadonlyArray<{ id: string; status: string }>,
): boolean {
  const entry = plugins.find((p) => p.id === MORAL_CODE_PLUGIN_ID);
  return entry !== undefined && entry.status !== "loaded";
}

/** Remove the published pack. Returns true when a file was removed. */
export function retirePublishedMoralCode(stateDir: string): boolean {
  try {
    fs.unlinkSync(moralCodePackPath(stateDir));
    return true;
  } catch {
    return false;
  }
}
