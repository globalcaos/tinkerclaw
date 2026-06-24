/**
 * FORK 2026-06-23: pure helpers for locating + sizing a claude-cli transcript.
 *
 * The claude CLI persists each conversation to
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * where <encoded-cwd> is the ABSOLUTE working directory with every
 * non-alphanumeric character replaced by '-'. Verified against the live
 * layout on this host, e.g. `/home/user/.openclaw` ->
 * `-home-globalcaos--openclaw` (the leading '/' and the '.' each become '-').
 *
 * Both functions are pure / side-effect-free aside from the explicit
 * `fs.statSync` in `isTranscriptOversized`, so they unit-test trivially.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Encode an absolute path the way claude-cli names its projects/ dir:
 *  every non-alphanumeric character becomes '-'. */
export function encodeProjectDir(absCwd: string): string {
  return absCwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Resolve the transcript .jsonl path claude-cli would write/resume for a
 *  given cwd + sessionId. `cwd` is resolved to absolute first so a relative
 *  cwd encodes identically to how claude-cli (which runs --same-dir) sees it. */
export function resolveTranscriptPath(cwd: string, sessionId: string): string {
  const absCwd = path.resolve(cwd);
  const encoded = encodeProjectDir(absCwd);
  return path.join(os.homedir(), ".claude", "projects", encoded, `${sessionId}.jsonl`);
}

/** True iff the transcript file exists AND is strictly larger than maxBytes.
 *  A missing file (ENOENT) or any stat failure returns false (NOT oversized) —
 *  callers fail open into a normal resume. */
export function isTranscriptOversized(filePath: string, maxBytes: number): boolean {
  try {
    const st = fs.statSync(filePath);
    return st.size > maxBytes;
  } catch {
    return false;
  }
}
