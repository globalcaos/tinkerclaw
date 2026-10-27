/**
 * Situation record builder (design doc §3 M3, paper §7.1 / Appendix B).
 *
 * Pure and synchronous: everything that needs I/O (git history, session state) arrives through
 * the SeamInput / SessionContext arguments. A field that cannot be computed is
 * `{value:null, origin:"missing"}` and is never guessed.
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { isAgentPrompt, stripPromptEnvelope } from "openclaw/plugin-sdk/fork-prompt-envelope";
import { classifyEffect, isShellTool, resolveTargets } from "./effect-class.js";
import type {
  Claim,
  Commitment,
  EvidenceKind,
  Field,
  Origin,
  OwnedTarget,
  ResolvedTarget,
  Seam,
  Situation,
  TargetHistory,
  ToolRecordEntry,
  TurnKind,
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
  /** Who started the turn, as the prompt seam saw it (session-tracker.ts). */
  turnKind?: TurnKind;
  /** Absolute paths the agent created earlier in this session, and existing ones it changed (session-tracker.ts). */
  createdPaths?: string[];
  editedPaths?: string[];
}

export function missing<T>(): Field<T> {
  return { value: null, origin: "missing" };
}

function field<T>(v: T | undefined | null, origin: Origin): Field<T> {
  return v === undefined || v === null ? missing<T>() : { value: v, origin };
}

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

/** The label of an agent's prompt (`⟦AGENT:🌿 Fractal · prompt 3⟧`): the first one, whatever wraps it. */
const AGENT_LABEL = /⟦AGENT:([^⟧\n]*)⟧/;

/**
 * Who started the turn (2026-10-25). The background Fractal reflection runs in its own `…:fractal:…` session and its
 * prompt wears the Fractal label; any other `⟦AGENT:…⟧` prompt is an agent or a job; the rest is the owner. Undefined
 * when there is no prompt to read and the session key does not tell. Reviews up to 2026-10-24: 458 dodged-work flags on
 * reflection turns, 374 noise and 21 harmful against 28 useful, because a reflection's notes were judged as an answer.
 */
export function turnKindOf(sessionKey: string, prompt?: string): TurnKind | undefined {
  if (sessionKey.includes(":fractal:")) return "reflection";
  if (prompt === undefined) return undefined;
  if (!isAgentPrompt(prompt)) return "owner";
  const label = AGENT_LABEL.exec(prompt)?.[1] ?? "";
  return /\bFractal\b/i.test(label) ? "reflection" : "agent";
}

function under(p: string, dirs: string[]): boolean {
  return dirs.some((d) => {
    const nd = path.normalize(d).replace(/\/+$/, "");
    return p === nd || p.startsWith(nd + path.sep);
  });
}

/** Words around a path in prose: quotes, brackets, and the punctuation that ends a sentence. */
const PATH_EDGES = /^[\s"'`([{<]+|[\s"'`)\]}>,;:!?.]+$/g;
const FILE_NAME = /^[\w-][\w.-]*\.[A-Za-z][A-Za-z0-9]{1,7}$/;
const MAX_NAMED = 50;

/**
 * The paths a request names (2026-10-25): absolute, `~/`, `./`, relative with a slash, or a bare file name with an
 * extension. URLs and addresses are not paths. Absolute ones come back resolved; the rest as written, matched by suffix.
 * Text only: nothing is looked up on disk.
 */
export function pathsNamedIn(text: string, home: string): string[] {
  const out = new Set<string>();
  for (const raw of text.slice(0, 4000).split(/\s+/)) {
    const w = raw.replace(PATH_EDGES, "");
    if (!w || w.includes("://") || w.includes("@") || w.includes("$")) continue;
    const abs = w.startsWith("~/") ? home + w.slice(1) : w;
    if (abs.startsWith("/")) out.add(path.normalize(abs).replace(/\/+$/, ""));
    else if (w.includes("/") || FILE_NAME.test(w))
      out.add(w.replace(/^\.\//, "").replace(/\/+$/, ""));
    if (out.size >= MAX_NAMED) break;
  }
  return [...out];
}

function namedBy(p: string, named: readonly string[]): boolean {
  return named.some((n) =>
    n.startsWith("/") ? p === n : n.includes("/") ? p.endsWith(`/${n}`) : path.basename(p) === n,
  );
}

/**
 * The targets of this step that are the agent's own work, familiar to it, or the owner's choice. Novelty skips them all,
 * excess-scope is not asked when every target is `created`, `scratch` or `named`, and danger-level reads them
 * (2026-10-25: novelty 89 % noise, excess-scope 81 %, the danger-level table rows 90-94 %, mostly on files the agent had
 * made or the owner had named). A path the agent wrote counts only as itself: `mkdir -p ~/src` must not make everything
 * under it the agent's. A file that existed before the agent edited it stays `edited`, the owner's data.
 */
export function ownedTargetsOf(
  targets: readonly ResolvedTarget[],
  o: {
    created?: readonly string[];
    edited?: readonly string[];
    scratchDirs?: string[];
    named?: readonly string[];
  },
): OwnedTarget[] {
  const created = new Set(o.created ?? []);
  const edited = new Set(o.edited ?? []);
  const out: OwnedTarget[] = [];
  for (const t of targets) {
    if (t.kind !== "file" && t.kind !== "dir" && t.kind !== "unknown") continue;
    if (created.has(t.path)) out.push({ path: t.path, why: "created" });
    else if (under(t.path, o.scratchDirs ?? [])) out.push({ path: t.path, why: "scratch" });
    else if (namedBy(t.path, o.named ?? [])) out.push({ path: t.path, why: "named" });
    else if (edited.has(t.path)) out.push({ path: t.path, why: "edited" });
  }
  return out;
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
  const requestText =
    c.request ?? (i.prompt !== undefined ? stripPromptEnvelope(i.prompt) : undefined);
  const kind = c.turnKind ?? turnKindOf(i.sessionKey, i.prompt);
  // A reflection's prompt is the Fractal's, not the owner's: the paths it names are not his choice.
  const owned: Field<OwnedTarget[]> =
    targetList.length === 0
      ? missing<OwnedTarget[]>()
      : {
          value: ownedTargetsOf(targetList, {
            created: c.createdPaths,
            edited: c.editedPaths,
            scratchDirs: c.scratchDirs,
            named: requestText && kind !== "reflection" ? pathsNamedIn(requestText, c.homeDir) : [],
          }),
          origin: "derived",
        };

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
    turnKind: field(kind, "derived"),
    ownedTargets: owned,
  };
}
