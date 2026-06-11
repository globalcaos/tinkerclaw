/**
 * FORK: Fractal Reflection v2 — triage-lane runner (Drop 1: COLD arm).
 *
 * Runs the read-only triage judge for one finished main turn on its own
 * subagent lane (design of record: bible §5.67a + §5.67b; §5.67b wins).
 * Drop 1 scope:
 * - COLD arm only: no session fork (no warm prefix) and NO fix-lane spawn —
 *   surviving findings make the row status "flagged", never "acted".
 * - The spawn/wait call shape is copied from the stock dreaming plugin
 *   (extensions/memory-core/src/dreaming-narrative.ts:210-241), including its
 *   RequestScopedSubagentRuntimeError graceful fallback.
 * - runTriage NEVER throws: every failure path returns a status "error" row.
 */

import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { join } from "node:path";
import {
  extractErrorCode,
  formatErrorMessage,
  RequestScopedSubagentRuntimeError,
  SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE,
} from "openclaw/plugin-sdk/error-runtime";
import { FRACTAL_SESSION_PREFIX, type FractalConfig, type FractalRow } from "./types.js";

// ---------------------------------------------------------------------------
// Constants — documented CEILINGS (design-principle #19), never working targets
// ---------------------------------------------------------------------------

/**
 * CEILING on the digest size, not a working truncation target.
 * Derivation: ~8k chars ≈ 2k tokens at ~4 chars/token — enough to carry a
 * full final answer plus immediate context while keeping the COLD (cache-less)
 * triage spend bounded. When over the ceiling, the OLDEST content drops first
 * (earlier-turn notes, then the head of the last user message, then the head
 * of the final answer) — the newest/tail content always survives.
 */
export const DIGEST_CHAR_CEILING = 8_000;

/**
 * CEILING on how long we wait for the triage run, aligned with the U5
 * dead-run watchdog ceiling (~120s of total silence — §5.67b). Triage runs at
 * low thinking and should finish well under this.
 */
export const TRIAGE_WAIT_CEILING_MS = 120_000;

/**
 * Dedicated triage lane — split from the fix lane so coalescing can never
 * cancel a queued fix (§5.67b flood control).
 */
export const TRIAGE_LANE = "fractal-triage";

/** Max chars for one earlier-turn note line in the digest. */
const NOTE_LINE_MAX_CHARS = 160;

/**
 * Tail of the last user message kept when the full-text sections alone bust
 * the ceiling (keeps the actual ask visible under a pasted blob).
 */
const USER_TAIL_KEEP_CHARS = 400;

/** Reserved chars for the notes section heading + spacing when notes are present. */
const NOTES_SECTION_OVERHEAD_CHARS = 64;

/** How many trailing session messages to fetch when extracting the triage reply. */
const TRIAGE_REPLY_FETCH_LIMIT = 8;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FractalFinding = NonNullable<FractalRow["findings"]>[number];

/**
 * The gateway subagent surface this runner needs — the exact shape the stock
 * dreaming plugin declares against `api.runtime.subagent`
 * (extensions/memory-core/src/dreaming-narrative.ts SubagentSurface).
 */
export type TriageSubagentSurface = {
  run: (params: {
    idempotencyKey: string;
    sessionKey: string;
    message: string;
    model?: string;
    extraSystemPrompt?: string;
    lane?: string;
    lightContext?: boolean;
    deliver?: boolean;
  }) => Promise<{ runId: string }>;
  waitForRun: (params: { runId: string; timeoutMs?: number }) => Promise<{
    status: string;
    error?: string;
  }>;
  getSessionMessages: (params: { sessionKey: string; limit?: number }) => Promise<{
    messages: unknown[];
  }>;
};

export type TriageLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export type TriageLedger = {
  /** How many prior ledger rows carry a finding of this kind at this path (U2). */
  recurrenceCount: (kind: string, path: string) => number | Promise<number>;
};

/** Narrow structural view of the plugin api (OpenClawPluginApi is assignable). */
export type FractalRunnerApi = {
  rootDir?: string;
  runtime?: { subagent?: TriageSubagentSurface };
};

export type RunTriageDeps = {
  api: FractalRunnerApi;
  cfg: FractalConfig;
  ledger: TriageLedger;
  log: TriageLog;
};

export type RunTriageInput = {
  parentRunId: string;
  /**
   * The MAIN session's key (from the agent_end ctx) — logging/telemetry only;
   * the triage run gets its own plugin-minted key (FRACTAL_SESSION_PREFIX).
   */
  sessionKey: string;
  /** The agent_end payload's message history. */
  messages: unknown[];
  /** U5 two-event contract: invoked with the pending stub BEFORE the subagent spawn. */
  onPending: (stub: FractalRow) => void;
};

export type ParsedFinding = {
  kind: string;
  claim: string;
  path?: string;
  quote?: string;
  fixHint?: string;
  hard: boolean;
};

export type TriageVerdict = {
  verdict: "clean" | "act" | "gap";
  headline: string;
  findings: ParsedFinding[];
  reasoning: string;
};

// ---------------------------------------------------------------------------
// Digest construction — (1) compact view of the finished turn
// ---------------------------------------------------------------------------

const DIGEST_HEADER = [
  "# Finished-turn digest (fractal triage, COLD arm)",
  "",
  "NOTE: this triage lane is COLD — it did NOT inherit the main session's",
  "retrieval/memory evidence (no forked context). Retrieval evidence may be",
  "absent from this digest, so GROUNDING / `gap` findings MUST be conservative:",
  "flag a gap only when the digest itself shows owned knowledge was asserted",
  "without being retrieved.",
].join("\n");

type DigestTurn = { role: string; text: string };

function toDigestTurn(msg: unknown): DigestTurn | null {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return null;
  }
  const m = msg as Record<string, unknown>;
  if (typeof m.role !== "string" || !m.role) {
    return null;
  }
  const texts: string[] = [];
  if (typeof m.content === "string") {
    texts.push(m.content);
  } else if (Array.isArray(m.content)) {
    for (const block of m.content as Array<Record<string, unknown>>) {
      if (
        block &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string"
      ) {
        texts.push(block.text);
      }
    }
  }
  const text = texts.join("\n").trim();
  if (!text) {
    return null;
  }
  return { role: m.role, text };
}

function toOneLine(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars - 1)}…`;
}

function assembleDigest(notes: string[], lastUser: string, finalAnswer: string): string {
  const parts: string[] = [DIGEST_HEADER, ""];
  if (notes.length > 0) {
    parts.push("## Earlier turns (oldest first, one line each)", ...notes, "");
  }
  parts.push(
    "## Last user message",
    lastUser,
    "",
    "## Final assistant answer (in full)",
    finalAnswer,
  );
  return parts.join("\n");
}

/**
 * Build the compact digest of the finished turn: the final assistant answer
 * in full + the last user message + a one-line note per earlier turn, capped
 * at DIGEST_CHAR_CEILING by dropping the OLDEST content first.
 */
export function buildTurnDigest(messages: unknown[]): string {
  const turns: DigestTurn[] = [];
  for (const msg of messages) {
    const turn = toDigestTurn(msg);
    if (turn) {
      turns.push(turn);
    }
  }

  let answerIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.role === "assistant") {
      answerIdx = i;
      break;
    }
  }
  let userIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (i !== answerIdx && turns[i]?.role === "user") {
      userIdx = i;
      break;
    }
  }

  const answerTurn = answerIdx >= 0 ? turns[answerIdx] : undefined;
  const userTurn = userIdx >= 0 ? turns[userIdx] : undefined;
  let finalAnswer = answerTurn ? answerTurn.text : "(no assistant answer in the agent_end payload)";
  let lastUser = userTurn ? userTurn.text : "(no user message in the agent_end payload)";

  // Ceiling pass 1: the two full-text sections. Drop oldest content first —
  // trim the user message to its tail, then the answer head.
  if (assembleDigest([], lastUser, finalAnswer).length > DIGEST_CHAR_CEILING) {
    lastUser = `…${lastUser.slice(-USER_TAIL_KEEP_CHARS)}`;
  }
  const overshoot = assembleDigest([], lastUser, finalAnswer).length - DIGEST_CHAR_CEILING;
  if (overshoot > 0) {
    finalAnswer = `…${finalAnswer.slice(overshoot + 1)}`;
  }

  // Ceiling pass 2: earlier-turn notes fill the remaining budget NEWEST-first
  // (prefer dropping oldest), rendered oldest-first.
  const baseLength = assembleDigest([], lastUser, finalAnswer).length;
  let budget = DIGEST_CHAR_CEILING - baseLength - NOTES_SECTION_OVERHEAD_CHARS;
  const notes: string[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    if (i === answerIdx || i === userIdx) {
      continue;
    }
    const turn = turns[i];
    if (!turn) {
      continue;
    }
    const note = `- [${turn.role}] ${toOneLine(turn.text, NOTE_LINE_MAX_CHARS)}`;
    if (note.length + 1 > budget) {
      break;
    }
    notes.unshift(note);
    budget -= note.length + 1;
  }

  return assembleDigest(notes, lastUser, finalAnswer);
}

// ---------------------------------------------------------------------------
// Prompt loading — (2) extension-local ONLY (mirrors v1's loadPrompt in
// fractal-inject.ts; v1 had NO workspace-override pattern, so none is mirrored)
// ---------------------------------------------------------------------------

let triagePromptCache: string | null = null;

/** Clear cache to pick up prompt edits without restart (and between tests). */
export function clearTriagePromptCache(): void {
  triagePromptCache = null;
}

export function loadTriagePrompt(extensionDir: string): string | null {
  if (triagePromptCache) {
    return triagePromptCache;
  }
  try {
    const raw = readFileSync(join(extensionDir, "triage-prompt.md"), "utf-8").trim();
    triagePromptCache = raw.length > 0 ? raw : null;
  } catch {
    // Missing prompt is a hard config error for triage (a fallback prompt
    // could not honor the JSON verdict contract) — caller emits an error row.
    triagePromptCache = null;
  }
  return triagePromptCache;
}

function resolveExtensionDir(api: FractalRunnerApi): string {
  // The plugin host provides rootDir (index.ts uses `api.rootDir ?? __dirname`);
  // this module lives in src/, one level below the extension root.
  return api.rootDir ?? (typeof __dirname === "string" ? join(__dirname, "..") : process.cwd());
}

// ---------------------------------------------------------------------------
// Verdict parsing — (6) tolerant: LAST fenced ```json block wins, never throw
// ---------------------------------------------------------------------------

export function parseTriageVerdict(replyText: string): TriageVerdict | { error: string } {
  const matches = [...replyText.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const last = matches.length > 0 ? matches[matches.length - 1] : undefined;
  const raw = last?.[1]?.trim() ?? "";
  if (!raw) {
    return { error: "no fenced ```json verdict block in the triage reply" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `verdict JSON.parse failed: ${String(err)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "verdict JSON is not an object" };
  }
  const obj = parsed as Record<string, unknown>;
  const verdict = obj.verdict;
  if (verdict !== "clean" && verdict !== "act" && verdict !== "gap") {
    return { error: `invalid verdict: ${JSON.stringify(obj.verdict)}` };
  }
  const findings: ParsedFinding[] = [];
  if (Array.isArray(obj.findings)) {
    for (const entry of obj.findings) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const f = entry as Record<string, unknown>;
      if (typeof f.kind !== "string" || !f.kind || typeof f.claim !== "string" || !f.claim) {
        // tolerant: drop malformed individual findings, keep the verdict
        continue;
      }
      findings.push({
        kind: f.kind,
        claim: f.claim,
        path: typeof f.path === "string" && f.path ? f.path : undefined,
        quote: typeof f.quote === "string" && f.quote ? f.quote : undefined,
        fixHint: typeof f.fix_hint === "string" && f.fix_hint ? f.fix_hint : undefined,
        hard: f.hard === true,
      });
    }
  }
  return {
    verdict,
    headline: typeof obj.headline === "string" ? obj.headline : "",
    findings,
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "",
  };
}

export function extractLastAssistantText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const turn = toDigestTurn(messages[i]);
    if (turn && turn.role === "assistant") {
      return turn.text;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Quote pre-verification — (7) evidence is falsifiable: re-read the file and
// require the verbatim quote; a miss drops the finding (abstain), never errors
// ---------------------------------------------------------------------------

async function verifyFindingQuotes(findings: ParsedFinding[]): Promise<{
  surviving: ParsedFinding[];
  abstainedFindings: number;
}> {
  const surviving: ParsedFinding[] = [];
  let abstainedFindings = 0;
  for (const finding of findings) {
    if (!finding.path || !finding.quote) {
      // Non-file findings (people/commitment/staleness-online) carry no
      // on-disk quote per the triage-prompt contract — nothing to verify.
      surviving.push(finding);
      continue;
    }
    let content: string;
    try {
      content = await fs.readFile(finding.path, "utf-8");
    } catch {
      abstainedFindings += 1; // missing/unreadable file → drop
      continue;
    }
    if (!content.includes(finding.quote)) {
      abstainedFindings += 1; // stale quote → drop
      continue;
    }
    surviving.push(finding);
  }
  return { surviving, abstainedFindings };
}

// ---------------------------------------------------------------------------
// Spawn — (4) the dreaming plugin's exact run shape + request-scoped fallback
// ---------------------------------------------------------------------------

function isRequestScopedSubagentRuntimeError(err: unknown): boolean {
  return (
    err instanceof RequestScopedSubagentRuntimeError ||
    (err instanceof Error &&
      err.name === "RequestScopedSubagentRuntimeError" &&
      extractErrorCode(err) === SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE)
  );
}

async function startTriageRunOrNull(params: {
  subagent: TriageSubagentSurface;
  sessionKey: string;
  idempotencyKey: string;
  message: string;
  log: TriageLog;
}): Promise<string | null> {
  try {
    const run = await params.subagent.run({
      idempotencyKey: params.idempotencyKey,
      sessionKey: params.sessionKey,
      message: params.message,
      lane: TRIAGE_LANE,
      lightContext: true,
      deliver: false,
      // TODO(Drop 2): cfg.triageThinkLevel cannot be threaded yet — the
      // subagent.run surface has NO thinking knob today (SubagentRunParams in
      // src/plugins/runtime/types.ts; §5.67a flagged this). The gateway agent
      // RPC already accepts `thinking` + `label`; route through it (or extend
      // the surface) in Drop 2. Until then the lane name carries identity.
    });
    return run.runId;
  } catch (runErr) {
    if (!isRequestScopedSubagentRuntimeError(runErr)) {
      throw runErr;
    }
    params.log.info(
      "[fractal-reflection] triage skipped — subagent runtime is request-scoped (no detached spawn from this context)",
    );
    return null;
  }
}

async function readRecurrenceCount(
  ledger: TriageLedger,
  kind: string,
  findingPath: string,
  log: TriageLog,
): Promise<number> {
  try {
    return await ledger.recurrenceCount(kind, findingPath);
  } catch (err) {
    log.warn(
      `[fractal-reflection] recurrenceCount(${kind}, ${findingPath}) failed: ${formatErrorMessage(err)}`,
    );
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run the triage lane for one finished main turn (Drop 1 COLD arm).
 *
 * Emits the pending stub via input.onPending BEFORE spawning (U5 two-event
 * contract), spawns the triage subagent on the `fractal-triage` lane, parses
 * the JSON verdict, pre-verifies finding quotes on disk, stamps recurrence
 * counts from the ledger, and returns the completed FractalRow.
 *
 * Never throws — failures return a status "error" row.
 * NOTE: usage telemetry is omitted — SubagentWaitResult carries no usage today.
 */
export async function runTriage(deps: RunTriageDeps, input: RunTriageInput): Promise<FractalRow> {
  const ts = Date.now();
  let spawnedAtMs: number | undefined;
  let triageRunId: string | undefined;

  const errorRow = (message: string): FractalRow => ({
    parentRunId: input.parentRunId,
    ...(triageRunId !== undefined ? { triageRunId } : {}),
    status: "error",
    headline: message,
    findings: [],
    abstainedFindings: 0,
    escalated: false,
    ...(spawnedAtMs !== undefined ? { timeToDockMs: Date.now() - spawnedAtMs } : {}),
    ts,
  });

  try {
    // (1) compact digest of the finished turn
    const digest = buildTurnDigest(Array.isArray(input.messages) ? input.messages : []);

    // (2) triage prompt (extension-local only — see loadTriagePrompt note)
    const prompt = loadTriagePrompt(resolveExtensionDir(deps.api));
    if (!prompt) {
      return errorRow("triage-prompt.md missing or unreadable in the extension dir");
    }

    const subagent = deps.api.runtime?.subagent;
    if (!subagent) {
      return errorRow("subagent runtime unavailable on the plugin api");
    }

    // (3) pending stub BEFORE the spawn (U5 two-event contract)
    input.onPending({
      parentRunId: input.parentRunId,
      status: "pending",
      findings: [],
      abstainedFindings: 0,
      escalated: false,
      ts,
    });

    // (4) spawn the triage subagent (dreaming-plugin call shape)
    const triageSessionKey = `${FRACTAL_SESSION_PREFIX}${input.parentRunId}`;
    spawnedAtMs = Date.now();
    const runId = await startTriageRunOrNull({
      subagent,
      sessionKey: triageSessionKey,
      idempotencyKey: `fractal:triage:${input.parentRunId}`,
      message: `${prompt}\n\n---\n\n${digest}`,
      log: deps.log,
    });
    if (runId === null) {
      return errorRow("subagent runtime is request-scoped — triage cannot spawn detached");
    }
    triageRunId = runId;
    deps.log.info(
      `[fractal-reflection] triage spawned (run=${runId}, parent=${input.parentRunId}, mainSession=${input.sessionKey})`,
    );

    // (5) await the run (dreaming wait pattern)
    const result = await subagent.waitForRun({ runId, timeoutMs: TRIAGE_WAIT_CEILING_MS });
    if (result.status !== "ok") {
      const detail = result.error?.trim();
      return errorRow(
        detail
          ? `triage run ended status=${result.status} (${detail})`
          : `triage run ended status=${result.status}`,
      );
    }

    const { messages: sessionMessages } = await subagent.getSessionMessages({
      sessionKey: triageSessionKey,
      limit: TRIAGE_REPLY_FETCH_LIMIT,
    });
    const replyText = extractLastAssistantText(sessionMessages);
    if (!replyText) {
      return errorRow("triage run produced no assistant reply text");
    }

    // (6) parse the LAST fenced json verdict block
    const parsed = parseTriageVerdict(replyText);
    if ("error" in parsed) {
      return errorRow(`triage verdict unusable: ${parsed.error}`);
    }
    const timeToDockMs = Date.now() - spawnedAtMs;

    // (7) pre-verify every finding's quote on disk
    const { surviving, abstainedFindings } = await verifyFindingQuotes(parsed.findings);

    // (8) stamp recurrence counts from the ledger
    const findings: FractalFinding[] = [];
    for (const f of surviving) {
      findings.push({
        kind: f.kind,
        evidence: { claim: f.claim, path: f.path ?? "", verbatimQuote: f.quote ?? "" },
        ...(f.fixHint !== undefined ? { fixHint: f.fixHint } : {}),
        hard: f.hard,
        recurrenceCount: await readRecurrenceCount(deps.ledger, f.kind, f.path ?? "", deps.log),
      });
    }

    // (9) final row — Drop 1 never spawns the fix lane: findings → "flagged"
    const status: FractalRow["status"] =
      findings.length > 0 ? "flagged" : parsed.verdict === "gap" ? "gap" : "clean";
    return {
      parentRunId: input.parentRunId,
      triageRunId,
      status,
      verdict: parsed.verdict,
      headline: parsed.headline,
      findings,
      abstainedFindings,
      escalated: false,
      timeToDockMs,
      ts,
    };
  } catch (err) {
    deps.log.warn(`[fractal-reflection] triage failed: ${formatErrorMessage(err)}`);
    return errorRow(`triage failed: ${formatErrorMessage(err)}`);
  }
}
