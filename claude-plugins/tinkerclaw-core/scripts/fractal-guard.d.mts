// Types for fractal-guard.mjs (dependency-free JS so Claude Code can run it as a hook; declared here so the
// tests can import it typed).
export type FractalGuardKind = "send" | "delete" | "publish" | "spend" | "restart";
export interface FractalGuardVerdict {
  kind: FractalGuardKind;
  /** The short phrase that matched, e.g. "git push". */
  match: string;
}
export interface FractalGuardBase {
  /** Where the command runs (the hook payload's cwd). */
  cwd?: string;
  /** When the reflection's worker started (epoch ms): a file born after it is the reflection's own. */
  since?: number;
  /** A command ssh runs on another host. */
  remote?: boolean;
}
export const FRACTAL_GUARD_MODES: readonly string[];
export function classifyCommand(
  command: string,
  base?: FractalGuardBase,
): FractalGuardVerdict | null;
export function classifyFractalCall(
  toolName: unknown,
  toolInput: unknown,
  base?: FractalGuardBase,
): FractalGuardVerdict | null;
export function denyReason(verdict: FractalGuardVerdict): string;
