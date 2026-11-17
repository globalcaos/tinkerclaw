/**
 * Fact check (FORK 2026-11-14). The owner asked for an amygdala guard that tells apart what the agent knows for certain
 * from what it only thinks it knows, and asks it to reevaluate a hypothesis stated as fact. When a turn in one of his
 * chats ends, the reply's candidate statements (hypotheses.ts: an absence or inability, a cause that names something)
 * go once, in the background, to a Claude model with that turn's own evidence. A statement the evidence does not carry
 * (it shows less than that, or the opposite) wakes the same chat with one request: check it, or say it as a hypothesis.
 *
 * Claude only: the evidence is tool output, which never goes to Jev or any other outside judge, and Claude already saw
 * all of it in the chat. In the background: one Claude call took 4 to 7 s on the Pi before any evidence (2026-11-14),
 * and the stop seam has 5 s.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { runLadder, type RunOnce } from "./explain.js";
import {
  ACTING_LABELS,
  evidenceDigest,
  judgePrompt,
  parseJudgeVerdicts,
  statedAsFact,
  type JudgeLabel,
  type StatedFact,
} from "./hypotheses.js";
import { redactText } from "./redact.js";
import { renderTemplate } from "./templates.js";
import { lastTurnCalls } from "./transcript.js";

export type FactCheckMode = "off" | "shadow" | "wake";

/** Paints the wake as the amygdala's own agent bubble, and lets the next check skip the turn it starts. */
export const FACT_CHECK_MARKER = "⟦AGENT:🧠 Amygdala · fact check⟧";
/** The wake's first words, which survive the prompt envelope (the marker does not). */
export const FACT_CHECK_OPENING = "Your last reply stated as fact";

export interface FactCheckDeps {
  mode: FactCheckMode;
  ladder: readonly string[];
  timeoutMs: number;
  dailyCap: number;
  runOnce: RunOnce;
  /** Sends the message into the chat as a job's prompt (chat.send). */
  deliver: (sessionKey: string, message: string) => void;
  log: (line: string) => void;
  homeDir: string;
  /** Local file that keeps each judged statement for review. Absent = not kept. */
  recordPath?: string;
  now?: () => number;
}

export interface FactCheckTurn {
  sessionKey: string;
  turnId: string;
  reply: string;
  transcriptPath: string;
  /** False once a newer turn has started in the chat: a late wake would land in the middle of it. */
  stillCurrent?: () => boolean;
}

export interface FactCheck {
  observe(turn: FactCheckTurn): void;
  /** Resolves when every queued check has finished (tests). */
  idle(): Promise<void>;
}

/** Only Claude rungs: the evidence is tool output. */
export function claudeOnly(ladder: readonly string[]): string[] {
  return ladder.filter((r) => r.startsWith("claude-code/"));
}

const WHY: Partial<Record<JudgeLabel, string>> = {
  beyond: "the evidence shows less than that",
  contradicted: "the evidence shows the opposite",
};

/** The request the agent reads. Code wording: the judge gives labels only. */
export function factCheckMessage(
  acting: readonly { fact: StatedFact; label: JudgeLabel }[],
): string {
  const first = acting[0];
  if (!first) return "";
  const what =
    `"${first.fact.text.replace(/\s+/g, " ").slice(0, 220)}" (${WHY[first.label] ?? first.label})` +
    (acting.length > 1 ? `, and ${acting.length - 1} more like it` : "");
  return `${FACT_CHECK_MARKER} ${renderTemplate("fact-check-wake", { what })}`;
}

export function createFactCheck(d: FactCheckDeps): FactCheck {
  const ladder = claudeOnly(d.ladder);
  const now = d.now ?? Date.now;
  const done = new Set<string>();
  let day = "";
  let spent = 0;
  let queue: Promise<void> = Promise.resolve();

  async function check(t: FactCheckTurn, cands: StatedFact[]): Promise<void> {
    const { owner, agent, calls } = lastTurnCalls(t.transcriptPath);
    // The turn a fact-check wake started: its reply answers the check and is never checked again.
    if (agent && owner.trimStart().startsWith(FACT_CHECK_OPENING)) return;
    const prompt = redactText(
      judgePrompt(cands, evidenceDigest(cands, calls, owner, { ownerMax: agent ? 6000 : 1500 })),
      {
        homeDir: d.homeDir,
      },
    );
    const started = now();
    const got = await runLadder<Map<number, JudgeLabel>>(
      prompt,
      ladder,
      d.runOnce,
      d.timeoutMs,
      (text) => {
        const m = parseJudgeVerdicts(String(text ?? ""), cands.length);
        return m.size > 0 ? m : null;
      },
    );
    const head = `[amygdala] fact-check session=${t.sessionKey} turn=${t.turnId} candidates=${cands.length}`;
    if ("error" in got) {
      d.log(`${head} error=${got.error.replace(/\s+/g, " ").slice(0, 160)}`);
      return;
    }
    const labels = got.explanation;
    const acting = cands.flatMap((fact, i) => {
      const label = labels.get(i + 1);
      return label && ACTING_LABELS.has(label) ? [{ fact, label }] : [];
    });
    const tally: Record<string, number> = {};
    for (const l of labels.values()) tally[l] = (tally[l] ?? 0) + 1;
    d.log(
      `${head} model=${got.model} ms=${now() - started} labels=${JSON.stringify(tally)} acted=${acting.length} mode=${d.mode}`,
    );
    if (d.recordPath) {
      try {
        appendFileSync(
          d.recordPath,
          JSON.stringify({
            ts: now(),
            sessionKey: t.sessionKey,
            turnId: t.turnId,
            model: got.model,
            mode: d.mode,
            statements: cands.map((c, i) => ({
              text: c.text,
              kind: c.kind,
              label: labels.get(i + 1) ?? null,
            })),
          }) + "\n",
        );
      } catch (err) {
        console.error("[amygdala] fact-check record failed", err);
      }
    }
    if (acting.length === 0 || d.mode !== "wake") return;
    if (t.stillCurrent && !t.stillCurrent()) {
      d.log(`${head} superseded: a newer turn started, no wake`);
      return;
    }
    d.deliver(t.sessionKey, factCheckMessage(acting));
  }

  return {
    observe(t) {
      if (d.mode === "off" || ladder.length === 0 || !t.reply.trim() || done.has(t.turnId)) return;
      done.add(t.turnId);
      if (done.size > 2000) done.delete(done.values().next().value as string);
      const cands = statedAsFact(t.reply);
      if (cands.length === 0) return;
      const today = new Date(now()).toISOString().slice(0, 10);
      if (today !== day) {
        day = today;
        spent = 0;
      }
      if (spent >= d.dailyCap) return;
      spent++;
      queue = queue
        .then(() => check(t, cands))
        .catch((err) => console.error("[amygdala] fact-check failed", err));
    },
    idle: () => queue,
  };
}

/** chat.send through the gateway's own CLI as a short-lived child: a plugin has no in-process way to start a turn. */
export function chatSendViaCli(
  log: (line: string) => void,
): (sessionKey: string, message: string) => void {
  return (sessionKey, message) => {
    const entry = process.argv[1];
    if (!entry) {
      log(`[amygdala] fact-check wake session=${sessionKey} skipped: no CLI entry`);
      return;
    }
    const params = JSON.stringify({
      sessionKey,
      message,
      idempotencyKey: `amygdala-fact-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    });
    const child = spawn(
      process.execPath,
      [entry, "gateway", "call", "chat.send", "--params", params, "--timeout", "60000"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let err = "";
    child.stderr?.on("data", (b) => {
      err = (err + String(b)).slice(-400);
    });
    child.on("close", (code) =>
      log(
        `[amygdala] fact-check wake session=${sessionKey} exit=${code}${code ? ` ${err.replace(/\s+/g, " ").trim()}` : ""}`,
      ),
    );
    child.on("error", (e) =>
      log(`[amygdala] fact-check wake session=${sessionKey} failed: ${e.message}`),
    );
  };
}
