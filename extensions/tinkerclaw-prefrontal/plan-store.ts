import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { Plan, PlanStep } from "../../src/gateway/protocol/schema/prefrontal-plan.js";

export interface PlanStoreOptions {
  rootDir: string; // ~/.openclaw/workspace/state/prefrontal/plans
  archiveDir?: string; // defaults to rootDir/archive/<YYYY-MM-DD>
  onMutation?: (sessionKey: string, plan: Plan | null) => void;
}

const SLUG = (k: string) => k.replace(/:/g, "__").replace(/[^a-zA-Z0-9_\-.]/g, "_");

export class PlanStore {
  constructor(private opts: PlanStoreOptions) {
    fsSync.mkdirSync(opts.rootDir, { recursive: true });
  }

  private filePath(sessionKey: string): string {
    return path.join(this.opts.rootDir, `${SLUG(sessionKey)}.md`);
  }

  /** Public accessor for downstream RPCs (Task 1.5 will use this). */
  filePathPublic(sessionKey: string): string {
    return this.filePath(sessionKey);
  }

  /** Public accessor for the plans root directory. */
  rootDirPublic(): string {
    return this.opts.rootDir;
  }

  async set(params: {
    sessionKey: string;
    intent: string;
    runId: string;
    recipe?: string;
    kitRef?: string;
    steps: Array<{ title: string }>;
  }): Promise<Plan> {
    const now = new Date().toISOString();
    const plan: Plan = {
      sessionKey: params.sessionKey,
      runId: params.runId,
      intent: params.intent,
      recipe: params.recipe,
      kitRef: params.kitRef,
      started: now,
      updated: now,
      status: "in_progress",
      currentStep: 0,
      steps: params.steps.map((s) => ({ title: s.title, status: "pending" })),
    };
    await this.writeLocked(params.sessionKey, plan);
    this.opts.onMutation?.(params.sessionKey, plan);
    return plan;
  }

  /**
   * Advance or update a step's status/note/artifact.
   * Invariant: at most ONE step per plan is in_progress at a time.
   * Setting a new step to in_progress demotes the previous in_progress step back to pending.
   * When a step flips to done, currentStep advances to the next still-pending index.
   */
  async step(params: {
    sessionKey: string;
    stepIndex: number;
    status: PlanStep["status"];
    note?: string;
    artifact?: string;
    output?: unknown;
    outputKind?: "json";
    error?: { kind: string; message: string; recoverable: boolean; details?: unknown };
  }): Promise<Plan> {
    const plan = await this.get(params.sessionKey);
    if (!plan) throw new Error(`plan-store: no plan for sessionKey=${params.sessionKey}`);

    const step = plan.steps[params.stepIndex];
    if (!step) throw new Error(`plan-store: step ${params.stepIndex} out of range`);

    const now = new Date().toISOString();

    if (params.status === "in_progress") {
      // Demote previous in_progress step back to pending
      if (plan.currentStep !== params.stepIndex) {
        const prev = plan.steps[plan.currentStep];
        if (prev && prev.status === "in_progress") {
          prev.status = "pending";
        }
      }
      step.startedAt = step.startedAt ?? now;
      step.status = "in_progress";
      plan.currentStep = params.stepIndex;
    } else if (params.status === "done") {
      step.completedAt = now;
      step.status = "done";
      const next = plan.steps.findIndex((s, i) => i > params.stepIndex && s.status === "pending");
      plan.currentStep = next === -1 ? params.stepIndex : next;
    } else {
      if (params.status === "error") {
        step.completedAt = now;
      }
      step.status = params.status;
    }

    if (params.note !== undefined) step.note = params.note;
    if (params.artifact !== undefined) step.artifact = params.artifact;
    if (params.output !== undefined) step.output = params.output;
    if (params.outputKind !== undefined) step.outputKind = params.outputKind;
    if (params.error !== undefined) step.error = params.error;
    plan.updated = now;

    await this.writeLocked(params.sessionKey, plan);
    this.opts.onMutation?.(params.sessionKey, plan);
    return plan;
  }

  /**
   * BROCA P1.1 (ask-for-missing): set the PLAN-LEVEL status (durable pause writer).
   * Distinct from step() — this mutates plan.status (e.g. 'blocked-awaiting-input'),
   * not a step's status. Reads the plan, sets plan.status, bumps plan.updated, then
   * writeLocked + onMutation. The plan-level status line round-trips as a free string
   * (renderPlanMd writes `status: ${plan.status}`; parsePlanMd reads it back as-is),
   * so any PlanStatusSchema literal — including 'blocked-awaiting-input' — persists.
   */
  async setStatus(sessionKey: string, status: Plan["status"]): Promise<Plan> {
    const plan = await this.get(sessionKey);
    if (!plan) throw new Error(`plan-store: no plan for sessionKey=${sessionKey}`);
    plan.status = status;
    plan.updated = new Date().toISOString();
    await this.writeLocked(sessionKey, plan);
    this.opts.onMutation?.(sessionKey, plan);
    return plan;
  }

  async get(sessionKey: string): Promise<Plan | null> {
    const fp = this.filePath(sessionKey);
    try {
      const text = await fs.readFile(fp, "utf-8");
      return parsePlanMd(text);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return null;
      // malformed file → quarantine then return null
      const broken = `${fp}.broken-${Date.now()}.md`;
      await fs.rename(fp, broken).catch(() => {});
      return null;
    }
  }

  /**
   * Close a plan (done | aborted), archive it under archive/<YYYY-MM-DD>/, and remove the live file.
   */
  async close(params: { sessionKey: string; status: "done" | "aborted" }): Promise<{
    ok: true;
    archivedTo: string;
  }> {
    const fp = this.filePath(params.sessionKey);
    const plan = await this.get(params.sessionKey);
    if (!plan) throw new Error(`no plan for sessionKey ${params.sessionKey}`);
    plan.status = params.status;
    plan.updated = new Date().toISOString();
    const date = plan.updated.slice(0, 10);
    const archiveDir = path.join(
      this.opts.archiveDir ?? path.join(this.opts.rootDir, "archive"),
      date,
    );
    await fs.mkdir(archiveDir, { recursive: true });
    const archivedTo = path.join(archiveDir, `${SLUG(params.sessionKey)}-${plan.runId}.md`);
    await fs.writeFile(archivedTo, renderPlanMd(plan), "utf-8");
    await fs.unlink(fp).catch(() => {});
    this.opts.onMutation?.(params.sessionKey, null);
    return { ok: true, archivedTo };
  }

  private async writeLocked(sessionKey: string, plan: Plan): Promise<void> {
    const fp = this.filePath(sessionKey);
    // Ensure file exists for lockfile (proper-lockfile requires the file to exist)
    try {
      await fs.access(fp);
    } catch {
      await fs.writeFile(fp, "", "utf-8");
    }
    const release = await lockfile.lock(fp, {
      retries: { retries: 5, factor: 1.5, minTimeout: 50 },
    });
    try {
      const tmp = `${fp}.tmp-${process.pid}`;
      await fs.writeFile(tmp, renderPlanMd(plan), "utf-8");
      await fs.rename(tmp, fp);
    } finally {
      await release();
    }
  }
}

function renderPlanMd(plan: Plan): string {
  const lines: string[] = [
    "---",
    `schema: prefrontal-plan/1.0`,
    `sessionKey: ${plan.sessionKey}`,
    `runId: ${plan.runId}`,
    `intent: ${JSON.stringify(plan.intent)}`,
  ];
  if (plan.recipe) lines.push(`recipe: ${plan.recipe}`);
  if (plan.kitRef) lines.push(`kitRef: ${plan.kitRef}`);
  lines.push(
    `started: ${plan.started}`,
    `updated: ${plan.updated}`,
    `status: ${plan.status}`,
    `currentStep: ${plan.currentStep}`,
    "---",
    "",
    "## Plan",
    "",
  );
  const body = plan.steps.map((s, i) => renderStep(s, i)).join("\n\n");
  return `${lines.join("\n")}${body}\n`;
}

function renderStep(s: PlanStep, i: number): string {
  const marker =
    s.status === "done"
      ? "[x]"
      : s.status === "in_progress"
        ? "[▶]"
        : s.status === "error"
          ? "[!]"
          : "[ ]";
  // Timestamps are token-shaped (no spaces) so they round-trip on one comment
  // line split by spaces. The artifact digest CAN contain spaces, so it gets its
  // OWN comment line, base64-encoded, to survive the space-split parser
  // (FORK 2026-05-30, Upgrade 5: durable per-step artifact persistence).
  const meta: string[] = [];
  if (s.startedAt) meta.push(`startedAt:${s.startedAt}`);
  if (s.completedAt) meta.push(`completedAt:${s.completedAt}`);
  const metaLine = meta.length ? `\n  <!-- ${meta.join(" ")} -->` : "";
  const artifactLine = s.artifact
    ? `\n  <!-- artifact64:${Buffer.from(s.artifact, "utf-8").toString("base64")} -->`
    : "";
  // SS1: the full validated typed output, JSON-stringified then base64-encoded
  // (its own comment line, like the artifact digest, so it survives the parser).
  const outputLine =
    s.output !== undefined
      ? `\n  <!-- output64:${Buffer.from(JSON.stringify(s.output), "utf-8").toString("base64")} -->`
      : "";
  // SS5a: the step's ClassifiedError, JSON-stringified then base64-encoded
  // (its own comment line, exactly like output64, so it survives the parser).
  const errorLine =
    s.error !== undefined
      ? `\n  <!-- error64:${Buffer.from(JSON.stringify(s.error), "utf-8").toString("base64")} -->`
      : "";
  const note = s.note ? `\n  ${s.note.replace(/\n/g, "\n  ")}` : "";
  return `- ${marker} **${i}. ${s.title}**${metaLine}${artifactLine}${outputLine}${errorLine}${note}`;
}

export function parsePlanMd(text: string): Plan {
  const m = /^---\n([\s\S]+?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error("plan: missing frontmatter");
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z][\w]*):\s*(.+)$/.exec(line);
    if (kv) fm[kv[1]] = stripQuotes(kv[2].trim());
  }
  const steps: PlanStep[] = [];
  let lastStep: PlanStep | null = null;
  const noteBuf: string[] = [];
  const flushNote = () => {
    if (lastStep && noteBuf.length) {
      lastStep.note = noteBuf.join("\n").trim() || undefined;
      noteBuf.length = 0;
    }
  };
  for (const line of m[2].split("\n")) {
    const sm = /^- \[([ x▶!])\] \*\*(\d+)\. (.+?)\*\*(.*)$/.exec(line);
    if (sm) {
      flushNote();
      const status: PlanStep["status"] =
        sm[1] === "x"
          ? "done"
          : sm[1] === "▶"
            ? "in_progress"
            : sm[1] === "!"
              ? "error"
              : "pending";
      lastStep = { title: sm[3], status };
      steps.push(lastStep);
      continue;
    }
    // Artifact comment line (Upgrade 5): <!-- artifact64:<base64> --> — its own
    // line because the digest may contain spaces (the space-split metadata parser
    // below would mangle them).
    const am = /^\s+<!--\s+artifact64:(\S+)\s+-->$/.exec(line);
    if (am && lastStep) {
      try {
        lastStep.artifact = Buffer.from(am[1], "base64").toString("utf-8");
      } catch {
        // ignore an undecodable artifact line
      }
      continue;
    }
    // SS1: structured output line: <!-- output64:<base64-of-json> -->
    const om = /^\s+<!--\s+output64:(\S+)\s+-->$/.exec(line);
    if (om && lastStep) {
      try {
        lastStep.output = JSON.parse(Buffer.from(om[1], "base64").toString("utf-8"));
        lastStep.outputKind = "json";
      } catch {
        // ignore an undecodable output line
      }
      continue;
    }
    // SS5a: structured error line: <!-- error64:<base64-of-json> -->
    const em = /^\s+<!--\s+error64:(\S+)\s+-->$/.exec(line);
    if (em && lastStep) {
      try {
        lastStep.error = JSON.parse(Buffer.from(em[1], "base64").toString("utf-8"));
      } catch {
        // ignore an undecodable error line
      }
      continue;
    }
    // HTML-comment metadata line: <!-- startedAt:... completedAt:... artifact:... -->
    // (`artifact:` token kept for back-compat with plans written before Upgrade 5;
    // single-token values only — multi-word digests now use the artifact64 line.)
    const mm = /^\s+<!--\s+(.+?)\s+-->$/.exec(line);
    if (mm && lastStep) {
      for (const kv of mm[1].split(" ")) {
        const idx = kv.indexOf(":");
        if (idx < 0) continue;
        const k = kv.slice(0, idx);
        const v = kv.slice(idx + 1);
        if (k === "startedAt") lastStep.startedAt = v;
        else if (k === "completedAt") lastStep.completedAt = v;
        else if (k === "artifact") lastStep.artifact = v;
      }
      continue;
    }
    // Continuation note line (indented ≥2 spaces, non-empty)
    if (lastStep && line.trim().length > 0 && /^\s{2,}/.test(line)) {
      noteBuf.push(line.trimStart());
    }
  }
  flushNote();
  if (!steps.length) throw new Error("plan: no steps parsed");
  return {
    sessionKey: fm.sessionKey,
    runId: fm.runId,
    intent: fm.intent,
    recipe: fm.recipe,
    kitRef: fm.kitRef,
    started: fm.started,
    updated: fm.updated,
    status: fm.status as Plan["status"],
    currentStep: parseInt(fm.currentStep, 10),
    steps,
  };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
