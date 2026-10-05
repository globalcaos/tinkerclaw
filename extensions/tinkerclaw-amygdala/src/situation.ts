/**
 * Situation record builder (design doc §3 M3, paper §7.1 / Appendix B).
 *
 * Pure and synchronous: everything that needs I/O (git history, session state) arrives through
 * the SeamInput / SessionContext arguments. A field that cannot be computed is
 * `{value:null, origin:"missing"}` and is never guessed.
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { classifyEffect, isShellTool, resolveTargets } from "./effect-class.js";
import type {
  Claim,
  Commitment,
  EvidenceKind,
  Field,
  Origin,
  Seam,
  Situation,
  TargetHistory,
  ToolRecordEntry,
} from "./types.js";

export interface SeamInput {
  seam: Seam;
  sessionKey: string;
  turnId: string;
  now: number;
  originKind?: "real" | "synthetic";
  tool?: string;
  toolInput?: Record<string, unknown>;
  toolResponse?: unknown;
  toolUseId?: string;
  prompt?: string;
  reply?: string;
  cwd?: string;
}

export interface SessionContext {
  workspaceRoot: string;
  homeDir: string;
  request?: string;
  toolRecord?: ToolRecordEntry[];
  scratchDirs?: string[];
  recentHolds?: { goalFp: string; ts: number }[];
  standingFacts?: string[];
  expectation?: string;
  restatement?: string;
  draftCommitments?: Commitment[];
  repeatedErrors?: number;
  stepsSinceNewFact?: number;
  similarIncidents?: string[];
  claims?: Claim[];
  provenance?: { callId: string; instructionLike: boolean }[];
  holdNeeds?: EvidenceKind[];
  candidates?: { id: string; description: string }[];
  scheduledJobs?: string[];
  contextCounts?: { seen: number; alarms: number };
  history?: (absPath: string) => TargetHistory | null;
}

export function missing<T>(): Field<T> {
  return { value: null, origin: "missing" };
}

function field<T>(v: T | undefined | null, origin: Origin): Field<T> {
  return v === undefined || v === null ? missing<T>() : { value: v, origin };
}

/** Strip leading metadata wrappers such as `[Tue 2026-09-29 17:45 GMT+2]` or `⟦AGENT:x⟧`. */
/**
 * Blocks the chat appends AFTER the user's words: the reflection doctrine and the chat-row contract. They are not the
 * request; left in, a two-line question reached Jev as 23 000 characters of doctrine (2026-09-30, CTO tab).
 */
const APPENDED_BLOCKS = [
  /\n\s*-{3,}\s*\n+\s*\*\*After your reply, append a 🌿 FRACTAL/,
  /\n\s*<!-- TINKERCLAW chat-row contract -->/,
];

/**
 * The reply the stop questions judge: the answer, not the reflection after it, and not a failure placeholder.
 * 2026-10-01: 2 of 5 live "refusals" were the FRACTAL block judged as the reply, 1 was a failed turn's error text.
 */
export function judgedReply(reply: string | undefined): string | undefined {
  if (reply === undefined) return undefined;
  if (/^\s*\[assistant turn failed before producing content\]\s*$/.test(reply)) return undefined;
  if (/^\s*⚠️ Agent failed before reply:/.test(reply)) return undefined;
  const m = /(^|\n)\s*🌿 FRACTAL( ACTION)?:/.exec(reply);
  const answer = (m ? reply.slice(0, m.index) : reply).trim();
  return answer === "" ? undefined : answer;
}

/** The web chat's header in front of a prompt it relays: `Sender (untrusted metadata):` and a fenced JSON block. */
const SENDER_BLOCK = /^\s*Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/;
const DATE_STAMP = /^\s*\[(?:Day\b|[A-Z][a-z]{2}\b)[^\]\n]*\]\s*/;

/** A prompt an agent or a job wrote into the chat (a long-job wake-up, a sub-agent's task), marked `⟦AGENT:…⟧`. */
export function isAgentPrompt(prompt: string | undefined): boolean {
  if (!prompt) return false;
  return /^\s*⟦AGENT:/.test(prompt.replace(SENDER_BLOCK, "").replace(DATE_STAMP, ""));
}

function stripWrapper(prompt: string): string {
  let s = prompt;
  for (const re of APPENDED_BLOCKS) {
    const m = re.exec(s);
    if (m) s = s.slice(0, m.index);
  }
  for (;;) {
    const next = s
      .replace(SENDER_BLOCK, "")
      .replace(DATE_STAMP, "")
      .replace(/^\s*⟦[^⟧]*⟧\s*/, "");
    if (next === s) {
      return s.trim();
    }
    s = next;
  }
}

function under(p: string, dirs: string[]): boolean {
  return dirs.some((d) => {
    const nd = path.normalize(d).replace(/\/+$/, "");
    return p === nd || p.startsWith(nd + path.sep);
  });
}

export function buildSituation(i: SeamInput, c: SessionContext): Situation {
  const tool = field(i.tool, "observed");
  const args = field(i.toolInput, "observed");
  const rawCommand =
    isShellTool(i.tool) && typeof i.toolInput?.command === "string" ? i.toolInput.command : null;
  const command = field(rawCommand, "observed");

  const hasTool = i.tool !== undefined && i.tool !== "";
  const effectClass = hasTool
    ? classifyEffect(i.tool ?? null, rawCommand, i.toolInput)
    : missing<never>();
  const targets = hasTool
    ? resolveTargets(rawCommand, i.toolInput, i.cwd ?? c.workspaceRoot, c.homeDir)
    : missing<never>();
  const targetList = targets.value ?? [];

  const scratch: Field<boolean> =
    targetList.length === 0
      ? missing<boolean>()
      : {
          value: targetList.every((t) => under(t.path, c.scratchDirs ?? [])),
          origin: "derived",
        };

  const hist = c.history && targetList.length > 0 ? c.history(targetList[0].path) : null;
  const requestText = c.request ?? (i.prompt !== undefined ? stripWrapper(i.prompt) : undefined);

  return {
    id: randomUUID(),
    ts: i.now,
    sessionKey: i.sessionKey,
    turnId: i.turnId,
    seam: i.seam,
    originKind: i.originKind ?? "real",
    tool,
    args,
    command,
    effectClass,
    targets,
    targetHistory: field(hist, "derived"),
    scratch,
    toolRecord: field(c.toolRecord, "derived"),
    request: field(requestText === "" ? undefined : requestText, "derived"),
    restatement: field(c.restatement, "inferred"),
    expectation: field(c.expectation, "inferred"),
    draftCommitments: field(c.draftCommitments, "inferred"),
    repeatedErrors: field(c.repeatedErrors, "derived"),
    stepsSinceNewFact: field(c.stepsSinceNewFact, "derived"),
    recentHolds: field(c.recentHolds, "derived"),
    standingFacts: field(c.standingFacts, "inferred"),
    similarIncidents: field(c.similarIncidents, "inferred"),
    reply: field(judgedReply(i.reply), "observed"),
    claims: field(c.claims, "inferred"),
    provenance: field(c.provenance, "inferred"),
    holdNeeds: field(c.holdNeeds, "derived"),
    candidates: field(c.candidates, "derived"),
    scheduledJobs: field(c.scheduledJobs, "observed"),
    contextCounts: field(c.contextCounts, "derived"),
  };
}
