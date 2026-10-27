// Types for memory-write-gate.mjs (dependency-free JS so Claude Code can run it as a hook; declared here so core and
// the tests can import it typed). src/memory/engram/write-gate.ts re-declares the public part for the plugin SDK.
export type MemoryGateMode = "enforce" | "watch";
export type MemorySource = "owner" | "chat" | "nightly" | "third-party" | "unknown";
export type MemoryGateLabel =
  | "new"
  | "repeat"
  | "update"
  | "correction"
  | "clash"
  | "unsourced-rule"
  | "third-party";
export type MemoryGateOutcome = "save" | "skip" | "supersede" | "ask" | "quote";

export interface MemoryGateConfig {
  mode: MemoryGateMode;
  roots: string[];
  rulesFiles: string[];
  excludeDirs?: string[];
  claudeProjectMemory?: boolean;
}
export interface MemoryGateMatch {
  file: string;
  line?: number;
}
export interface MemoryGateDecision {
  label: MemoryGateLabel;
  outcome: MemoryGateOutcome;
  source: MemorySource;
  sourceDeclared: boolean;
  sourceCapped: boolean;
  reason: string;
  matches: MemoryGateMatch[];
  pairs?: Array<{ old: string; next: string }>;
  supersedes?: { file: string; name: string };
  clash?: { rule: string; line: string };
  who?: string;
}
export interface GateInput {
  file: string;
  before: string | null;
  after: string;
  sessionKey?: string;
  date: string;
  notes?: Array<{ file: string; text: string }>;
  rules?: Array<{ file: string; line: number; text: string }>;
  isIndex?: boolean;
  rulesFileSelf?: boolean;
}
export type WriteOp =
  | { file: string; kind: "write"; content: string }
  | { file: string; kind: "edit"; edits: Array<{ old: string; next: string; all: boolean }> };
export type MemoryGateResult =
  | { action: "allow"; decision?: MemoryGateDecision }
  | { action: "deny"; reason: string; decision?: MemoryGateDecision }
  | {
      action: "rewrite";
      input: Record<string, unknown>;
      note: string;
      decision?: MemoryGateDecision;
    };
export interface RunMemoryGateArgs {
  door: "claude-code" | "gateway";
  toolName: string;
  input: Record<string, unknown>;
  config: MemoryGateConfig | null;
  stateDir: string;
  sessionKey?: string;
  origin?: string;
  cwd?: string;
  now?: number;
}

export const MEMORY_GATE_MODES: readonly MemoryGateMode[];
export const MEMORY_SOURCES: readonly MemorySource[];
export const GATE_CONFIG_VERSION: number;
export const DEFAULT_EXCLUDE_DIRS: readonly string[];
export const INDEX_NAMES: ReadonlySet<string>;

export function normalizeLine(line: string): string;
export function contentTokens(text: string): Set<string>;
export function isRuleLine(line: string): boolean;
export function jaccard(a: Set<string>, b: Set<string>): number;
export function splitFrontmatter(text: string): {
  fm: string[] | null;
  body: string;
  bodyStart: number;
};
export function readFrontmatter(fm: string[] | null): Record<string, string>;
export function setFrontmatterFields(
  text: string,
  fields: Record<string, string | undefined>,
): string;
export function isScheduledSession(sessionKey: string | undefined): boolean;
export function parseSource(raw: unknown): { source: MemorySource; who: string } | null;
export function resolveSource(args: { declared?: string; sessionKey?: string }): {
  source: MemorySource;
  declared: boolean;
  capped: boolean;
  who: string;
};
export function lineDiff(
  before: string | null,
  after: string,
): { added: string[]; removed: string[] };
export function pairUpdates(
  removed: string[],
  added: string[],
): Array<{ old: string; next: string }>;
export function gateMemoryWrite(input: GateInput): MemoryGateDecision;
export function strikeSuperseded(
  newText: string,
  pairs: Array<{ old: string; next: string }>,
  date: string,
): string;
export function quoteAdded(oldText: string | null, newText: string, attribution: string): string;
export function stampSupersededNote(
  text: string,
  byName: string,
  date: string,
  label: string,
): string;
export function writeOpOf(toolName: unknown, input: unknown): WriteOp | null;
export function inputWithOp(
  toolName: unknown,
  input: Record<string, unknown>,
  op: WriteOp,
): Record<string, unknown>;
export function applyOp(before: string | null, op: WriteOp): string | null;
export function transformOp(
  op: WriteOp,
  before: string | null,
  decision: MemoryGateDecision,
  ctx: { date: string; origin?: string },
): WriteOp;
