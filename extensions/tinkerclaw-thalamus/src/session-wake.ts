// The harness wakes the past chat that matches a prompt (2026-10-25, memory post § "Ask the expert agent").
//
// WHAT THIS IS FOR. The anticipation note can point at a past chat ("the ask-session skill can ask it"), but whether
// that chat is ever asked was the agent's choice, and in a week it chose to 3 times. With `anticipate.wake` on, a
// strong match is asked by the harness itself: it runs the skill's own `sessions.py ask <id> "<prompt>" --wake-id`, so
// the wake keeps every guard the skill has (read-only tools, the dated wake-up note, the per-session lock, the refusal
// when a live tab holds the session, the disk check of the files the answer names). The agent gets one line saying the
// answer is on its way and the exact command that prints it; if it never runs it, the finished answer is put on the
// desk at the start of that chat's next turn, once.
//
// NEVER ON THE PROMPT'S CLOCK. The gateway gives a prompt hook 15 s in all, and a wake takes 15 to 110 s, so the wake
// is started and never awaited. Nothing here blocks a prompt.
//
// WHAT IT COSTS. A cold wake writes the woken session's whole context to the cache once (about 1.25x its tokens), on
// the owner's own subscription. Hence the stricter bar than a pointer (`minCover`, `minTerms`), a daily cap counted on
// disk (so a restart does not reset it), and never the same past chat twice for one chat within `REPEAT_MS`.
//
// `watch` (the default) decides exactly as `on` would and records the decision in the ledger's pointer row; it starts
// nothing. `on` starts a wake only when the pointer is actually shown (enforce, `enforce.shortlist`, `anticipate.mode`
// inject): an answer nobody would see is not worth its tokens.

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { setPriority } from "node:os";
import { dirname, join } from "node:path";
import type { PointerHit } from "openclaw/plugin-sdk/fork-thalamus";
import type { WakeConfig } from "./config.js";

export const ASK_SESSION_SCRIPT = join("ask-session", "scripts", "sessions.py");
/** The same past chat is not woken again for one chat within this long: its answer is already there. */
export const REPEAT_MS = 12 * 3_600_000;
/** A finished answer the agent never collected is handed over at most this long after it was started. */
export const PENDING_MS = 3_600_000;
/** The owner's prompt as the question, cut to this many characters. */
export const QUESTION_CHARS = 1500;
/** The handed-over testimony, cut to this many characters (a few paragraphs, never a document). */
export const TESTIMONY_CHARS = 2400;

/**
 * The ask-session script: `$OPENCLAW_BUNDLED_SKILLS_DIR/ask-session/…` when that is set, else the first
 * `skills/ask-session/scripts/sessions.py` found walking up from `fromDir` (the plugin's folder, in a checkout or in
 * `dist/`). Undefined when there is none: the wake leg then stays silent.
 */
export function resolveAskSessionScript(
  fromDir: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  const override = env.OPENCLAW_BUNDLED_SKILLS_DIR?.trim();
  if (override) {
    const p = join(override, ASK_SESSION_SCRIPT);
    return exists(p) ? p : undefined;
  }
  let dir = fromDir;
  for (let i = 0; i < 6; i++) {
    const p = join(dir, "skills", ASK_SESSION_SCRIPT);
    if (exists(p)) {
      return p;
    }
    const up = dirname(dir);
    if (up === dir) {
      break;
    }
    dir = up;
  }
  return undefined;
}

/** What the wake leg did with a prompt's best past-chat match; recorded on that pointer in the ledger. */
export type WakeOutcome =
  | "watched"
  | "started"
  | "capped"
  | "repeat"
  | "busy"
  | "follow-up"
  | "no-script";

export type WakeConsider = {
  /** The chat pointer it was about; absent when no hit cleared the bar. */
  id?: string;
  outcome?: WakeOutcome;
  /** For the note: the line saying the answer is on its way. Only when a wake was started. */
  line?: string;
};

type Pending = { wakeId: string; target: string; startedAt: number };

type OutStream = { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;

/** The part of a child process the waker uses; a real `ChildProcess` is one. */
export type WakeChild = {
  pid?: number;
  stdout?: OutStream;
  stderr?: OutStream;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
};

type SpawnFn = (cmd: string, args: readonly string[]) => WakeChild;

export type WakeResultFile = {
  state?: "running" | "done" | "failed" | "refused";
  text?: string | null;
  read_at?: string;
  refused?: string;
  duration_s?: number;
};

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** `YYYYMMDD-HHMMSS-<id8>`, local time: the day prefix is what the daily cap counts. */
export function wakeIdFor(target: string, t: number): string {
  const d = new Date(t);
  const day = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${day}-${time}-${target.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`;
}

/** The question the woken chat gets: the owner's prompt, and what kind of answer helps. */
export function wakeQuestion(prompt: string): string {
  const p = prompt.trim();
  const cut = p.length > QUESTION_CHARS ? `${p.slice(0, QUESTION_CHARS - 1).trimEnd()}…` : p;
  return (
    `The owner just asked this in a new chat: «${cut}» ` +
    "If the work in this session holds the answer or part of it, give it exactly (links, paths, commands, values, " +
    "and the reason behind a decision). If it does not, say so in one line."
  );
}

const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;

export function createSessionWaker(d: {
  config: () => WakeConfig;
  /** The ask-session script; undefined: no wake is ever started. */
  script: () => string | undefined;
  /** `$OPENCLAW_STATE_DIR/ask-session/wakes`, where `sessions.py --wake-id` writes its results. */
  wakesDir: () => string;
  now: () => number;
  python?: string;
  /** Injectable so tests start nothing. */
  spawn?: SpawnFn;
  listWakes?: (dir: string) => string[];
  readResult?: (path: string) => WakeResultFile | undefined;
  onExit?: (info: { wakeId: string; target: string; code: number | null; out: string }) => void;
}) {
  const spawn: SpawnFn =
    d.spawn ?? ((cmd, args) => nodeSpawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"] }));
  const listWakes =
    d.listWakes ??
    ((dir: string) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    });
  const readResult =
    d.readResult ??
    ((path: string) => {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as WakeResultFile;
      } catch {
        return undefined;
      }
    });

  const pending = new Map<string, Pending>();
  const woken = new Map<string, number>();
  const children = new Set<WakeChild>();

  const startedToday = (t: number): number => {
    const day = wakeIdFor("x", t).slice(0, 8);
    return listWakes(d.wakesDir()).filter((n) => n.startsWith(`${day}-`) && n.endsWith(".json"))
      .length;
  };

  /** The best chat hit that clears the wake bar, or undefined. */
  const candidate = (hits: readonly PointerHit[]): PointerHit | undefined => {
    const c = d.config();
    return hits
      .filter((h) => h.kind === "chat" && h.cover >= c.minCover && h.terms >= c.minTerms)
      .toSorted((a, b) => b.cover - a.cover || b.terms - a.terms)[0];
  };

  const start = (sessionKey: string, target: string, question: string): string | undefined => {
    const script = d.script();
    if (!script) {
      return undefined;
    }
    const t = d.now();
    const wakeId = wakeIdFor(target, t);
    const c = d.config();
    const args = [
      "-I",
      script,
      "ask",
      target,
      question,
      "--json",
      "--wake-id",
      wakeId,
      "--timeout",
      String(c.timeoutS),
    ];
    let child: WakeChild;
    try {
      child = spawn(d.python ?? "python3", args);
    } catch {
      return undefined;
    }
    children.add(child);
    if (child.pid) {
      try {
        setPriority(child.pid, 10);
      } catch {
        /* lower priority is a courtesy */
      }
    }
    let out = "";
    child.stdout?.on("data", (b: Buffer) => {
      if (out.length < 65_536) {
        out += b.toString("utf8");
      }
    });
    child.stderr?.on("data", (b: Buffer) => {
      if (out.length < 65_536) {
        out += b.toString("utf8");
      }
    });
    // The script stops its own wake at `timeoutS`; this is the backstop if the script itself hangs.
    const guard = setTimeout(() => child.kill("SIGKILL"), (c.timeoutS + 30) * 1000);
    guard.unref?.();
    child.on("error", () => {
      clearTimeout(guard);
      children.delete(child);
    });
    child.on("close", (code: number | null) => {
      clearTimeout(guard);
      children.delete(child);
      d.onExit?.({ wakeId, target, code, out });
    });
    pending.set(sessionKey, { wakeId, target, startedAt: t });
    woken.set(`${sessionKey}\n${target}`, t);
    return wakeId;
  };

  return {
    /**
     * Decide for one prompt. `canStart` is true only when the pointer is shown to the agent and `wake` is `on`; without
     * it the decision is recorded and nothing starts. `ownText` is the prompt's own words, or undefined when the match
     * was made on the previous turn's (a follow-up has no question of its own to ask).
     */
    consider(o: {
      sessionKey: string;
      hits: readonly PointerHit[];
      ownText: string | undefined;
      canStart: boolean;
    }): WakeConsider {
      const c = d.config();
      if (c.mode === "off") {
        return {};
      }
      const hit = candidate(o.hits);
      if (!hit) {
        return {};
      }
      const t = d.now();
      const decide = (): WakeOutcome | "go" => {
        if (o.ownText === undefined) {
          return "follow-up";
        }
        const last = woken.get(`${o.sessionKey}\n${hit.id}`);
        if (last !== undefined && t - last < REPEAT_MS) {
          return "repeat";
        }
        const p = pending.get(o.sessionKey);
        if (p && t - p.startedAt < PENDING_MS) {
          return "busy";
        }
        if (!d.script()) {
          return "no-script";
        }
        if (startedToday(t) >= c.dailyCap) {
          return "capped";
        }
        return "go";
      };
      const verdict = decide();
      if (verdict !== "go") {
        return { id: hit.id, outcome: verdict };
      }
      if (c.mode !== "on" || !o.canStart) {
        return { id: hit.id, outcome: "watched" };
      }
      const wakeId = start(o.sessionKey, hit.id, wakeQuestion(o.ownText ?? ""));
      if (!wakeId) {
        return { id: hit.id, outcome: "no-script" };
      }
      return {
        id: hit.id,
        outcome: "started",
        line:
          `The harness is already asking that past chat (session ${hit.id.slice(0, 8)}) your prompt; its answer ` +
          `comes back as testimony from its date, with the files it names checked against the disk. Read it before ` +
          `you search: python3 -I ${d.script()} answer ${wakeId}`,
      };
    },

    /**
     * The answer of a wake started for this chat that finished and was never read with `answer`: the block for the
     * desk, handed over once. A wake still running stays pending; one refused, failed, read or too old is dropped.
     */
    collect(sessionKey: string): string | undefined {
      const p = pending.get(sessionKey);
      if (!p) {
        return undefined;
      }
      if (d.now() - p.startedAt > PENDING_MS) {
        pending.delete(sessionKey);
        return undefined;
      }
      const r = readResult(join(d.wakesDir(), `${p.wakeId}.json`));
      if (!r || r.state === "running") {
        return undefined;
      }
      pending.delete(sessionKey);
      if (r.state !== "done" || !r.text || r.read_at) {
        return undefined;
      }
      return [
        "A past chat the harness woke for your previous prompt has answered. It is testimony: what that session knew " +
          "on its date. Check what matters against the code or the file before acting on it.",
        clip(r.text, TESTIMONY_CHARS),
      ].join("\n");
    },

    /** Wakes started today (from disk) and wakes still pending in this process. */
    stats: () => ({ today: startedToday(d.now()), pending: pending.size }),

    /** Stop every wake still running (the gateway is stopping). */
    stop(): void {
      for (const c of children) {
        try {
          c.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
      children.clear();
    },
  };
}

export type SessionWaker = ReturnType<typeof createSessionWaker>;
