import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveMemoryIndexMaxChars,
  resolveMemoryIndexWarningMode,
} from "../agents/embedded-agent-helpers.js";
import type { WorkspaceBootstrapFile } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CANONICAL_ROOT_MEMORY_FILENAME } from "../memory/root-memory-files.js";
import { note } from "../terminal/note.js";

// An index line is a pointer plus a short hook; past this it is carrying the detail itself.
export const MEMORY_INDEX_MAX_LINE_CHARS = 200;
const MAX_LISTED_LINES = 5;

const MARKDOWN_LINK = /\[[^\]\n]*\]\(([^()\s]+)(?:\s+"[^"\n]*")?\)/g;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/;

export type MemoryIndexShape = {
  chars: number;
  entries: number;
  maxChars: number;
  overBudget: boolean;
  longLines: Array<{ line: number; chars: number }>;
  missingPointers: Array<{ line: number; target: string }>;
};

function resolvePointerPath(target: string, baseDir: string): string | undefined {
  if (!target || target.startsWith("#") || URL_SCHEME.test(target)) {
    return undefined;
  }
  let local = target.replace(/[#?].*$/, "");
  if (!local) {
    return undefined;
  }
  try {
    local = decodeURI(local);
  } catch {
    // keep the raw target when it is not valid URI encoding
  }
  if (local === "~" || local.startsWith("~/")) {
    return path.join(os.homedir(), local.slice(1));
  }
  return path.resolve(baseDir, local);
}

/** Shape check for MEMORY.md as the memory palace's index: size, line length, dead pointers. */
export function inspectMemoryIndex(params: {
  content: string;
  filePath: string;
  maxChars: number;
  maxLineChars?: number;
  pointerExists?: (absolutePath: string) => boolean;
}): MemoryIndexShape {
  const content = params.content.trimEnd();
  const maxLineChars = params.maxLineChars ?? MEMORY_INDEX_MAX_LINE_CHARS;
  const pointerExists = params.pointerExists ?? ((absolutePath) => fs.existsSync(absolutePath));
  const baseDir = path.dirname(params.filePath);
  const longLines: MemoryIndexShape["longLines"] = [];
  const missingPointers: MemoryIndexShape["missingPointers"] = [];
  let entries = 0;
  let inFence = false;
  content.split("\n").forEach((rawLine, index) => {
    const line = rawLine.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) {
      return;
    }
    if (LIST_ITEM.test(line)) {
      entries += 1;
    }
    if (line.length > maxLineChars) {
      longLines.push({ line: index + 1, chars: line.length });
    }
    for (const match of line.matchAll(MARKDOWN_LINK)) {
      const target = match[1] ?? "";
      const resolved = resolvePointerPath(target, baseDir);
      if (resolved && !pointerExists(resolved)) {
        missingPointers.push({ line: index + 1, target });
      }
    }
  });
  return {
    chars: content.length,
    entries,
    maxChars: params.maxChars,
    overBudget: content.length > params.maxChars,
    longLines,
    missingPointers,
  };
}

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.floor(value)));
}

export function formatMemoryIndexShapeLines(shape: MemoryIndexShape): string[] {
  if (!shape.overBudget && shape.longLines.length === 0 && shape.missingPointers.length === 0) {
    return [];
  }
  const lines = [
    `${CANONICAL_ROOT_MEMORY_FILENAME} is the memory index, loaded on every main-session turn: ${formatInt(shape.entries)} entries, ${formatInt(shape.chars)} chars (index budget ${formatInt(shape.maxChars)}).`,
  ];
  if (shape.overBudget) {
    lines.push(
      `- Over budget by ${formatInt(shape.chars - shape.maxChars)} chars. Move detail into topic files (memory/<topic>.md) and keep one line per topic.`,
    );
  }
  if (shape.longLines.length > 0) {
    const listed = shape.longLines.slice(0, MAX_LISTED_LINES).map((entry) => entry.line);
    const more = shape.longLines.length > listed.length ? ", …" : "";
    lines.push(
      `- ${shape.longLines.length} line(s) over ${MEMORY_INDEX_MAX_LINE_CHARS} chars (line ${listed.join(", ")}${more}): an index line is a pointer; its detail belongs in the topic file.`,
    );
  }
  if (shape.missingPointers.length > 0) {
    const listed = shape.missingPointers
      .slice(0, MAX_LISTED_LINES)
      .map((entry) => `line ${entry.line} → ${entry.target}`);
    const more = shape.missingPointers.length > listed.length ? "; …" : "";
    lines.push(
      `- ${shape.missingPointers.length} pointer(s) to missing files: ${listed.join("; ")}${more}.`,
    );
  }
  lines.push(
    "Tip: `agents.defaults.memoryIndexMaxChars` sets the index budget; it never truncates the file.",
  );
  return lines;
}

export function noteMemoryIndexShape(params: {
  cfg: OpenClawConfig;
  bootstrapFiles: WorkspaceBootstrapFile[];
  pointerExists?: (absolutePath: string) => boolean;
}): MemoryIndexShape | undefined {
  if (resolveMemoryIndexWarningMode(params.cfg) === "off") {
    return undefined;
  }
  const index = params.bootstrapFiles.find(
    (file) => !file.missing && file.name === CANONICAL_ROOT_MEMORY_FILENAME,
  );
  if (!index?.content || !index.path) {
    return undefined;
  }
  const shape = inspectMemoryIndex({
    content: index.content,
    filePath: index.path,
    maxChars: resolveMemoryIndexMaxChars(params.cfg),
    pointerExists: params.pointerExists,
  });
  const lines = formatMemoryIndexShapeLines(shape);
  if (lines.length > 0) {
    note(lines.join("\n"), "Memory index");
  }
  return shape;
}
