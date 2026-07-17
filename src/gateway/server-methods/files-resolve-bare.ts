/**
 * FORK 2026-05-09 — `files.resolveBareName` RPC.
 *
 * Resolves a bare filename like `BRIEFING.md` or `package.json` to an
 * absolute path on the host. Strategy, in order, picks the first that
 * yields exactly one match:
 *
 *   1. Workspace root (e.g. ~/.openclaw/workspace/)
 *   2. ~/src/tinkerclaw/
 *   3. ~/src/jarvis-icu/
 *   4. ~/.openclaw/ (top-level config + cron + media)
 *
 * If a single root yields multiple matches, return all candidates so the
 * caller can disambiguate (typically with a cheap LLM call using the chat
 * context). If zero matches across all roots, return null so the click
 * handler can fall back to "no-op" or surface a "not found" toast.
 *
 * Search depth capped at 4 levels to keep recursion cheap. Symlinks NOT
 * followed (avoids looping on workspace symlinks back to source repos).
 * Path allowlist mirrors `config-open-external.ts` so the resolved path is
 * already inside what `config.openExternalFile` will accept.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { GatewayRequestHandlers } from "./types.js";

// FORK 2026-07-08: 4 → 6. Real deliverables live deeper than 4 under
// ~/Documents (e.g. Documents/Insync/__Projects/<project>/Workshop/<sub>/x.html
// is depth 5). ~2k dirs at depth 6 across the roots — still a sub-second walk.
const MAX_DEPTH = 6;
const MAX_CANDIDATES_PER_ROOT = 8;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-runtime",
  "build",
  ".next",
  ".cache",
  ".vite",
  ".turbo",
  ".pnpm-store",
  "coverage",
  ".pytest_cache",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
  "media",
]);

async function searchRoot(
  root: string,
  filename: string,
  matches: string[],
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH || matches.length >= MAX_CANDIDATES_PER_ROOT) {
    return;
  }
  let entries: { name: string; isDir: boolean; isFile: boolean }[];
  try {
    const dirents = await fs.readdir(root, { withFileTypes: true });
    entries = dirents.map((d) => ({
      name: d.name,
      isDir: d.isDirectory(),
      isFile: d.isFile(),
    }));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== "." && entry.name !== "..") {
      // Skip hidden files/dirs except known exceptions are NOT special-cased
      // (we're searching plain filenames anyway, so hidden hits are unlikely).
      // Exception: allow descending into top-level dotted roots like .openclaw
      // because the search root itself was passed in absolute form.
      if (entry.isDir && depth === 0 && entry.name === ".openclaw") {
        // Already at the workspace root, descend
      } else if (entry.isDir) {
        continue;
      }
    }
    if (entry.isFile && entry.name === filename) {
      matches.push(path.join(root, entry.name));
      if (matches.length >= MAX_CANDIDATES_PER_ROOT) {
        return;
      }
    } else if (entry.isDir && !SKIP_DIRS.has(entry.name)) {
      await searchRoot(path.join(root, entry.name), filename, matches, depth + 1);
      if (matches.length >= MAX_CANDIDATES_PER_ROOT) {
        return;
      }
    }
  }
}

function buildRoots(workspaceDir: string | undefined | null): string[] {
  const home = os.homedir();
  const roots: string[] = [];
  if (workspaceDir && workspaceDir.length > 0) {
    roots.push(path.resolve(workspaceDir));
  }
  roots.push(path.resolve(home, "src/tinkerclaw"));
  roots.push(path.resolve(home, "src/jarvis-icu"));
  roots.push(path.resolve(home, ".openclaw"));
  // FORK 2026-07-08: mirror config-open-external's user-content roots — a bare
  // name the click handler can open must also be findable here, or the link
  // renders fine and then dies at resolve ("no match in allowlisted roots").
  roots.push(path.resolve(home, "Documents"));
  roots.push(path.resolve(home, "Downloads"));
  roots.push(path.resolve(home, "Desktop"));
  roots.push(path.resolve(home, "Pictures"));
  // De-dupe (workspaceDir might overlap with ~/.openclaw)
  const seen = new Set<string>();
  return roots.filter((r) => {
    if (seen.has(r)) return false;
    seen.add(r);
    return true;
  });
}

function isSafeFilename(name: string): boolean {
  // Filename only, no slashes, no traversal, no NUL
  if (!name || name.length > 255) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  if (name === "." || name === "..") return false;
  // Require at least one dot (extension) to avoid matching arbitrary words
  if (!name.includes(".")) return false;
  // Restrict to a sensible character set — letters, digits, dots, dashes,
  // underscores. This excludes anything weird like wildcards or quotes.
  // FORK 2026-07-08: unicode (\p{L}\p{M}\p{N}, /u) — the old \w-only class
  // rejected accented filenames like `memòria_informe.html` as "invalid name",
  // the same ASCII bug fixed in the client linkifier the same day.
  return /^[\p{L}\p{M}\p{N}.\-_]+$/u.test(name);
}

export const filesResolveBareHandlers: GatewayRequestHandlers = {
  "files.resolveBareName": async ({ params, context, respond }) => {
    const p = (params ?? {}) as { name?: unknown };
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!isSafeFilename(name)) {
      respond(true, { matches: [], reason: "invalid name" }, undefined);
      return;
    }
    const cfg = context.getRuntimeConfig();
    const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const roots = buildRoots(workspaceDir);
    // Search each root in order; return on first root with matches so the
    // workspace beats source repos when the same filename exists in both.
    for (const root of roots) {
      const matches: string[] = [];
      await searchRoot(root, name, matches, 0);
      if (matches.length > 0) {
        respond(
          true,
          {
            matches,
            root,
            count: matches.length,
            ambiguous: matches.length > 1,
          },
          undefined,
        );
        return;
      }
    }
    respond(true, { matches: [], reason: "no match in allowlisted roots" }, undefined);
  },
};
