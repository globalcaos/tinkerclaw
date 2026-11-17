/**
 * Effect cards (FORK 2026-11-08). When a turn ends, its steps go to the review ladder once, which names every change
 * that other people can see: what changed, where, how many people will see it in the next week and over its whole
 * lifetime, and a shell command that undoes it. Each such change is stored here and shown in the chat as a yellow
 * card with a Revert button; Revert runs the stored command on the gateway host. The card replaces asking for an Allow
 * before low-risk outbound steps: the owner judges them by their effect, after the fact.
 */
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunOnce } from "./explain.js";
import { redactText } from "./redact.js";
import type { StepAfter } from "./transcript.js";

export type EffectState = "live" | "reverting" | "reverted" | "revert-failed";

export interface Effect {
  id: string;
  sessionKey: string;
  turnId: string;
  ts: number;
  /** What changed, a few words. */
  what: string;
  /** Where it changed: a host, URL, recipient or file. */
  where: string;
  /** People likely to see it in the next 7 days. */
  week: number;
  /** People likely to see it over its whole lifetime, if it is never reverted. */
  lifetime: number;
  /** Shell command that undoes the change, or null when it cannot be undone (money spent, a delivered mail). */
  revert: string | null;
  state: EffectState;
  /** Tail of the revert command's output, after a revert ran. */
  output?: string;
}

export interface TurnForEffects {
  sessionKey: string;
  turnId: string;
  ts: number;
  steps: StepAfter[];
  reply: string;
}

const STEP_MAX = 600;
const STEPS_MAX = 40;
const REPLY_MAX = 2500;
const READ_ONLY_STEP = /^(Read|Grep|Glob|ToolSearch|WebSearch|WebFetch|TaskOutput|Skill)\b/;

/** The steps worth judging: a turn of reads alone changes nothing anyone else sees. */
export function changingSteps(steps: StepAfter[]): StepAfter[] {
  return steps.filter((s) => !s.failed && !READ_ONLY_STEP.test(s.ran));
}

export function buildEffectPrompt(
  t: TurnForEffects,
  homeDir: string,
  labels: Map<string, string> = new Map(),
): string {
  const red = (s: string, n: number): string => {
    const r = redactText(s, { homeDir }, labels);
    return r.length > n ? `${r.slice(0, n)}…` : r;
  };
  const steps = changingSteps(t.steps)
    .slice(-STEPS_MAX)
    .map((s, i) => `${i + 1}. ${red(s.ran, STEP_MAX)}`)
    .join("\n");
  return [
    "You audit what an AI agent changed in the world during one turn. The agent works for one owner.",
    "List ONLY the changes that a person other than the owner can see or be affected by: a public web page or",
    "server, a message or mail sent, a post, a shared file or document, a payment, a published package or repo,",
    "a customer-facing service. Ignore local files, scratch, tests, commits not pushed, reads, and anything only",
    "the owner sees. A test page on a public host counts: anyone can reach it.",
    "",
    "For each change give:",
    '- "what": at most 12 plain words, no jargon',
    '- "where": the host, URL, recipient or place, short',
    '- "week": your best whole-number estimate of distinct people who will see it in the next 7 days',
    '- "lifetime": the same over its whole lifetime if it is never undone (>= week)',
    '- "revert": ONE bash command that undoes it, run on the same machine the agent ran on, using the same hosts,',
    "  aliases and paths the steps used; null if it cannot be undone (money spent, a mail already delivered).",
    "  A WhatsApp message sent with `openclaw message send --channel whatsapp` CAN be undone: WhatsApp deletes it for",
    "  everyone and leaves a 'deleted message' note. Its id is in the history DB, so use this command, filling the",
    "  digits (no +) and the first words of the sent text:",
    "  python3 -I -c \"import sqlite3,os,subprocess,sys;c=sqlite3.connect(os.path.expanduser('~/.openclaw/data/whatsapp-history.db'));r=c.execute('select id from messages where from_me=1 and chat_jid like ? and text_content like ? order by timestamp desc limit 1',('<digits>@%','<first words>%')).fetchone();sys.exit(subprocess.call(['openclaw','message','delete','--channel','whatsapp','-t','+<digits>','--message-id',r[0]]) if r else 'message not found')\"",
    "",
    'Answer with JSON only: {"effects":[...]} and {"effects":[]} when nothing reached anyone else.',
    "",
    "Steps the agent ran, oldest first:",
    steps || "(none)",
    "",
    "The agent's final reply:",
    red(t.reply, REPLY_MAX),
  ].join("\n");
}

/** Puts the real phone numbers and addresses back where the prompt redaction replaced them with a label. */
export function restoreLabels(text: string, labels: Map<string, string>): string {
  let out = text;
  for (const [key, label] of labels) {
    const raw = key.slice(key.indexOf(":") + 1);
    out = out.split(label).join(key.startsWith("Phone:") ? `+${raw}` : raw);
  }
  return out;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
};
const txt = (v: unknown, n: number): string => (typeof v === "string" ? v.trim().slice(0, n) : "");

/** The model's answer as effect drafts; anything malformed is dropped, never thrown. */
export function parseEffects(
  answer: string | null,
): Pick<Effect, "what" | "where" | "week" | "lifetime" | "revert">[] {
  if (!answer) return [];
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = (raw as { effects?: unknown } | null)?.effects;
  if (!Array.isArray(list)) return [];
  return list.flatMap((e) => {
    const o = (e ?? {}) as Record<string, unknown>;
    const what = txt(o.what, 160);
    if (!what) return [];
    const week = num(o.week);
    const revert = typeof o.revert === "string" && o.revert.trim() ? o.revert.trim() : null;
    return [
      { what, where: txt(o.where, 160), week, lifetime: Math.max(week, num(o.lifetime)), revert },
    ];
  });
}

export interface EffectsDeps {
  dataDir: string;
  run: RunOnce;
  ladder: string[];
  timeoutMs: number;
  homeDir: string;
  emit: (name: string, payload: unknown) => void;
  now: () => number;
  logger: { info(m: string): void; warn(m: string): void };
  /** Tests replace the shell. */
  exec?: (cmd: string) => Promise<{ code: number; output: string }>;
}

export interface EffectsBook {
  /** Judge one finished turn in the background; returns when it is stored (tests await it). */
  observe(t: TurnForEffects): Promise<Effect[]>;
  list(sessionKey?: string, sinceTs?: number): Effect[];
  revert(id: string): Promise<Effect>;
}

const REVERT_TIMEOUT_MS = 120_000;
const OUTPUT_KEEP = 1500;

function shell(cmd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const p = spawn("bash", ["-lc", cmd], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const add = (b: Buffer): void => {
      out = (out + b.toString()).slice(-OUTPUT_KEEP * 2);
    };
    p.stdout.on("data", add);
    p.stderr.on("data", add);
    const timer = setTimeout(() => p.kill("SIGKILL"), REVERT_TIMEOUT_MS);
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: out.slice(-OUTPUT_KEEP) });
    });
    p.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, output: String(err) });
    });
  });
}

export function createEffects(d: EffectsDeps): EffectsBook {
  const file = join(d.dataDir, "effects.jsonl");
  const byId = new Map<string, Effect>();
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Effect;
        if (e?.id) byId.set(e.id, e);
      } catch {
        /* a torn line is skipped */
      }
    }
  } catch {
    /* no file yet */
  }
  const save = (e: Effect): Effect => {
    byId.set(e.id, e);
    try {
      appendFileSync(file, `${JSON.stringify(e)}\n`, { mode: 0o600 });
    } catch (err) {
      console.error("[amygdala] effects write failed", err);
    }
    d.emit("amygdala2.effect", e);
    return e;
  };
  const exec = d.exec ?? shell;

  return {
    async observe(t) {
      if (changingSteps(t.steps).length === 0) return [];
      const labels = new Map<string, string>();
      const prompt = buildEffectPrompt(t, d.homeDir, labels);
      let answer: string | null = null;
      for (const rung of d.ladder) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), d.timeoutMs);
        try {
          answer = await d.run(prompt, rung, ac.signal);
          if (answer) break;
        } catch (err) {
          d.logger.warn(`[amygdala] effects: ${rung} failed: ${String(err)}`);
        } finally {
          clearTimeout(timer);
        }
      }
      const drafts = parseEffects(answer);
      if (answer === null) d.logger.warn(`[amygdala] effects: no answer for turn ${t.turnId}`);
      return drafts.map((x, i) =>
        save({
          ...x,
          revert: x.revert ? restoreLabels(x.revert, labels) : null,
          id: `eff-${t.turnId}-${i}`,
          sessionKey: t.sessionKey,
          turnId: t.turnId,
          ts: t.ts,
          state: "live",
        }),
      );
    },

    list(sessionKey, sinceTs) {
      return [...byId.values()]
        .filter((e) => (!sessionKey || e.sessionKey === sessionKey) && e.ts >= (sinceTs ?? 0))
        .toSorted((a, b) => a.ts - b.ts);
    },

    async revert(id) {
      const e = byId.get(id);
      if (!e) throw new Error("unknown effect");
      if (!e.revert) throw new Error("this change cannot be undone");
      if (e.state === "reverting" || e.state === "reverted") return e;
      save({ ...e, state: "reverting" });
      d.logger.info(`[amygdala] effects: reverting ${id}`);
      const r = await exec(e.revert);
      return save({
        ...e,
        state: r.code === 0 ? "reverted" : "revert-failed",
        output: r.output,
      });
    },
  };
}
