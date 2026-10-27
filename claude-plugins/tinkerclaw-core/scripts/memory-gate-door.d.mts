// Types for memory-gate-door.mjs (dependency-free JS run by the tinkerclaw-core Claude Code hook; declared here so core
// and the tests can import it typed). src/memory/engram/write-gate.ts re-declares the public part for the plugin SDK.
import type {
  MemoryGateConfig,
  MemoryGateDecision,
  MemoryGateResult,
  RunMemoryGateArgs,
} from "./memory-write-gate.mjs";

export function gateStateDir(env?: NodeJS.ProcessEnv): string;
export function gateConfigPath(stateDir: string): string;
export function readGateConfig(stateDir: string): Required<MemoryGateConfig> | null;
export function publishGateConfig(stateDir: string, config: MemoryGateConfig | null): string | null;
export function claudeAutoMemoryDir(home?: string): string | null;
export function memoryRootOf(file: string, config: MemoryGateConfig, home?: string): string | null;
export function loadFolderNotes(
  file: string,
  opts?: { maxScan?: number },
): Array<{ file: string; text: string }>;
export function loadRuleLines(
  rulesFiles: string[],
): Array<{ file: string; line: number; text: string }>;
export function denyReason(decision: MemoryGateDecision): string;
export function runMemoryGate(args: RunMemoryGateArgs): MemoryGateResult;
export function backfillSources(
  dir: string,
  opts?: { apply?: boolean },
): { scanned: number; missing: number; written: number };
