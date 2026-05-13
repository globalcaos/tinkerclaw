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
   * Task 1.3 will add a full step() method; this is the extension point.
   */
  async step(params: {
    sessionKey: string;
    stepIndex: number;
    status: PlanStep["status"];
    note?: string;
    artifact?: string;
  }): Promise<Plan> {
    const plan = await this.get(params.sessionKey);
    if (!plan) throw new Error(`plan-store: no plan for sessionKey=${params.sessionKey}`);

    const step = plan.steps[params.stepIndex];
    if (!step) throw new Error(`plan-store: step ${params.stepIndex} out of range`);

    step.status = params.status;
    if (params.note !== undefined) step.note = params.note;
    if (params.artifact !== undefined) step.artifact = params.artifact;
    if (params.status === "in_progress" && !step.startedAt) {
      step.startedAt = new Date().toISOString();
    }
    if (params.status === "done" || params.status === "error") {
      step.completedAt = new Date().toISOString();
    }

    // Advance currentStep to next pending step
    if (params.status === "done") {
      const next = plan.steps.findIndex((s, i) => i > params.stepIndex && s.status === "pending");
      plan.currentStep = next === -1 ? params.stepIndex : next;
    }

    plan.updated = new Date().toISOString();
    await this.writeLocked(params.sessionKey, plan);
    this.opts.onMutation?.(params.sessionKey, plan);
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
   * Close a plan (done | aborted) and optionally archive it.
   * Task 1.4 will extend with archive write; the method signature is stable.
   */
  async close(params: { sessionKey: string; status: "done" | "aborted" }): Promise<Plan | null> {
    const plan = await this.get(params.sessionKey);
    if (!plan) return null;

    plan.status = params.status;
    plan.updated = new Date().toISOString();
    await this.writeLocked(params.sessionKey, plan);
    this.opts.onMutation?.(params.sessionKey, plan);
    return plan;
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
  const note = s.note ? `\n  ${s.note.replace(/\n/g, "\n  ")}` : "";
  return `- ${marker} **${i}. ${s.title}**${note}`;
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
  for (const line of m[2].split("\n")) {
    const sm = /^- \[([ x▶!])\] \*\*(\d+)\. (.+?)\*\*(.*)$/.exec(line);
    if (!sm) continue;
    const status: PlanStep["status"] =
      sm[1] === "x" ? "done" : sm[1] === "▶" ? "in_progress" : sm[1] === "!" ? "error" : "pending";
    steps.push({ title: sm[3], status });
  }
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
