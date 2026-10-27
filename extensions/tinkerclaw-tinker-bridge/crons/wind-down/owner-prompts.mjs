#!/usr/bin/env node
/**
 * The owner's own words in a time window: the raw material of the nightly reflection (wind-down).
 *
 * FOR    wind-down reflects on what the owner asked for, why, and how the day went. It needs the
 *        prompts the owner typed, once each, without the wrappers the gateway puts around a turn and
 *        without the prompts that agents, jobs and the gateway itself put into a chat.
 * FROM   Where TinkerClaw keeps chat transcripts: the Claude Code transcripts of the chat workers
 *        (`$CLAUDE_CONFIG_DIR` or `~/.claude`, then `projects/<folder>/*.jsonl`) and the gateway's
 *        session files (`$OPENCLAW_STATE_DIR` or `~/.openclaw`, then `agents/<agent>/sessions/*.jsonl`).
 *        The gateway stamps each prompt a person sends from a chat with `[Tue 2026-10-27 21:04 GMT+1] `
 *        (src/gateway/server-methods/agent-timestamp.ts). A terminal session's prompts carry no stamp
 *        and are not read. Agent-written turns are recognised by the openings src/shared/prompt-envelope.ts
 *        lists, and the blocks appended after the owner's words are the ones
 *        src/shared/appended-prompt-blocks.ts lists. A forked or resumed chat copies its history, so a
 *        prompt is kept once (date, minute and first words).
 * CHANGE When the stamp format or those markers change, the count drops to zero. Zero prompts on a day
 *        the gateway served chats means this probe broke, not that the day was quiet. Keep the patterns
 *        below in step with the two files named above.
 *
 * The time zone label in the stamp is what the gateway printed for the owner's zone: `GMT+2`, `UTC`, or
 * an abbreviation such as `PDT`. An abbreviation is resolved in `--tz` (default: this machine's zone).
 *
 * Usage: node owner-prompts.mjs --since <ISO> [--until <ISO>] [--tz <IANA>] [--dir <folder>]... [--json]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

/** The delivery stamp at the start of a line: `[Tue 2026-10-27 21:04 GMT+1] `. */
const STAMP = /^\[(\w{3}) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) ([^\]\n]+)\] ?/gm;

/** Blocks the gateway appends after the owner's words (src/shared/appended-prompt-blocks.ts). */
const APPENDED_BLOCKS = [
  /\n\s*-{3,}\s*\n+\s*\*\*After your reply, append a 🌿 FRACTAL/,
  /\n\s*-{3,}\s*\n+\s*⟦FRACTAL-DOCTRINE⟧/,
  /\s*<!-- TINKERCLAW chat-row contract -->/,
];

/** Wrappers that can sit in front of the words (src/shared/prompt-envelope.ts). */
const HEAD_WRAPPERS = [
  /^\s*Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/,
  /^\s*(?:System: |System \(untrusted\): \[[^\]\n]*\d{4}-\d{2}-\d{2})[^\n]*(?:\nSystem(?: \(untrusted\))?: [^\n]*)*/,
  /^\s*Note: The previous agent run was aborted by the user\.[^\n]*/,
];

/** A turn no person wrote, by its opening (prompt-envelope.ts AGENT_OPENING). */
const AGENT_OPENING =
  /^(?:⟦(?:AGENT|OVERSEER)\b|\[System\b|\[inject(?:ed)?\b|<cross-session-message\b|<task-notification\b|<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>|\[Subagent Context\]|🤖)/i;
/** A worker's own background turn (prompt-envelope.ts BG_TURN). */
const BG_TURN = /\[bg-turn bgt-[a-z0-9-]+\]/;

/** Minutes east of UTC for `GMT+2`, `UTC-5:30`, `UTC`; undefined for an abbreviation like `PDT`. */
export function labelOffsetMinutes(label) {
  const t = String(label).trim();
  if (t === "UTC" || t === "GMT" || t === "Z") {
    return 0;
  }
  const m = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(t);
  if (!m) {
    return undefined;
  }
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

function zoneOffsetMinutes(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(new Date(epochMs));
  return labelOffsetMinutes(parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT") ?? 0;
}

/** The instant a stamp names, and the offset it was printed in. */
export function stampInstant(day, hm, label, timeZone) {
  const wall = Date.parse(`${day}T${hm}:00Z`);
  let offset = labelOffsetMinutes(label);
  if (offset === undefined) {
    // An abbreviation: take the zone's offset at that wall time (twice, so a DST edge settles).
    offset = zoneOffsetMinutes(wall, timeZone);
    offset = zoneOffsetMinutes(wall - offset * 60_000, timeZone);
  }
  return { epochMs: wall - offset * 60_000, offset };
}

function formatOffset(minutes) {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function textOf(content) {
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === "object" && (c.type ?? "text") === "text")
      .map((c) => String(c.text ?? ""))
      .join(" ");
  }
  return String(content ?? "");
}

function dropHead(text) {
  let s = text;
  for (;;) {
    let next = s;
    for (const re of HEAD_WRAPPERS) {
      next = next.replace(re, "");
    }
    if (next === s) {
      return s.trimStart();
    }
    s = next;
  }
}

/**
 * The owner's words in one user message, or null when the message is not a stamped prompt a person
 * typed. Returns the stamp's date, minute and zone label with the words.
 */
export function ownerWords(messageText) {
  const found = [...messageText.matchAll(STAMP)];
  if (found.length === 0 || BG_TURN.test(messageText)) {
    return null;
  }
  // The last stamp: the bridge's per-turn context can sit in front of it.
  const m = found[found.length - 1];
  let body = messageText.slice(m.index + m[0].length);
  for (const re of APPENDED_BLOCKS) {
    const cut = re.exec(body);
    if (cut) {
      body = body.slice(0, cut.index);
    }
  }
  body = dropHead(body).trim();
  if (!body || AGENT_OPENING.test(body)) {
    return null;
  }
  return { day: m[2], hm: m[3], label: m[4], text: body };
}

/** Transcript folders on this machine, from the environment or the default homes. */
export function defaultSourceDirs(env = process.env, home = os.homedir()) {
  const claudeHome = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || path.join(home, ".openclaw");
  const subdirs = (dir) => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(dir, e.name));
    } catch {
      return [];
    }
  };
  return [
    ...subdirs(path.join(claudeHome, "projects")),
    ...subdirs(path.join(stateDir, "agents")).map((d) => path.join(d, "sessions")),
  ];
}

/** Every owner prompt in [sinceMs, untilMs], oldest first, each once. */
export async function collectOwnerPrompts({ dirs, sinceMs, untilMs, timeZone }) {
  const seen = new Set();
  const out = [];
  // A file last written before the window holds no prompt from inside it (one hour of slack).
  const fileCutoff = sinceMs - 3_600_000;
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      if (/\.trajectory\.|\.deleted|checkpoint/.test(name)) {
        continue;
      }
      const file = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.mtimeMs < fileCutoff) {
        continue;
      }
      const lines = readline.createInterface({
        input: fs.createReadStream(file, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (!line.includes('"role":"user"')) {
          continue;
        }
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        const message = record?.message;
        if (!message || message.role !== "user") {
          continue;
        }
        const words = ownerWords(textOf(message.content));
        if (!words) {
          continue;
        }
        const { epochMs, offset } = stampInstant(words.day, words.hm, words.label, timeZone);
        if (epochMs < sinceMs || epochMs > untilMs) {
          continue;
        }
        const key = `${words.day} ${words.hm} ${words.text.slice(0, 120)}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        out.push({
          when: `${words.day}T${words.hm}${formatOffset(offset)}`,
          epochMs,
          chat: path.basename(name, ".jsonl").slice(0, 8),
          text: words.text,
        });
      }
    }
  }
  out.sort((a, b) => a.epochMs - b.epochMs);
  return out;
}

function parseWhen(value) {
  const s = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00` : value; // a bare date is local midnight
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    throw new Error(`not a date or ISO time: ${value}`);
  }
  return ms;
}

function parseArgs(argv) {
  const args = { dirs: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      args.json = true;
    } else if (a === "--since" || a === "--until" || a === "--tz" || a === "--dir") {
      const v = argv[++i];
      if (v === undefined) {
        throw new Error(`${a} needs a value`);
      }
      if (a === "--dir") {
        args.dirs.push(v);
      } else {
        args[a.slice(2)] = v;
      }
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!args.since) {
    throw new Error("--since is required");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const timeZone = args.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sinceMs = parseWhen(args.since);
  const untilMs = args.until ? parseWhen(args.until) : Date.now();
  const dirs = args.dirs.length > 0 ? args.dirs : defaultSourceDirs();
  const prompts = await collectOwnerPrompts({ dirs, sinceMs, untilMs, timeZone });
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        prompts.map(({ when, chat, text }) => ({ when, chat, text })),
        null,
        1,
      )}\n`,
    );
  } else {
    for (const p of prompts) {
      process.stdout.write(
        `${p.when.slice(0, 10)} ${p.when.slice(11, 16)} [${p.chat}] ${p.text.replace(/\s+/g, " ").slice(0, 400)}\n`,
      );
    }
  }
  process.stderr.write(
    `-- ${prompts.length} owner prompts between ${new Date(sinceMs).toISOString()} and ${new Date(untilMs).toISOString()} from ${dirs.length} folders\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`owner-prompts: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
