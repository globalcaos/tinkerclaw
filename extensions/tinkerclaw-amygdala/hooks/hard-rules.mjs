#!/usr/bin/env node
/**
 * AMYGDALA hard rules (AEGIS) — PreToolUse hook (the pre-execution enforcement seam).
 * Was tinkerclaw-learned-intuition/hook/amygdala-pretooluse.mjs (AMYGDALA v3.1) until 2026-10-15.
 *
 * Runs INSIDE claude-cli's hook sandbox (NOT the gateway process), so it must be
 * DEPENDENCY-FREE: only node builtins, no imports from the extension. tinker-bridge
 * passes `--settings <cc-hook-settings.json>` to every spawn; that settings file
 * registers this script as a PreToolUse hook. claude-cli honours a `deny`
 * permission decision here EVEN under `--permission-mode bypassPermissions`, so
 * this is a real synchronous block on the primary runner — retracting the old
 * "observe-only is a physics limit" claim.
 *
 * Contract:
 *   stdin  = PreToolUse JSON payload {tool_name, tool_input, session_id, ...}
 *   policy = $AMYGDALA_DATA_DIR/policy.json (compiled by policy-snapshot.ts)
 *   stdout = on an ENFORCED match: a hookSpecificOutput deny object; else nothing
 *   exit   = always 0 (fail-open: any internal error allows the action)
 *
 * Every meaningful decision is spooled to $AMYGDALA_DATA_DIR/hook-decisions.jsonl
 * (fire-and-forget) so the gateway extension can ingest real enforced denials —
 * the strongest feedback signal, previously invisible.
 */

import { createHash } from "node:crypto";
import {
  readFileSync,
  appendFileSync,
  openSync,
  readSync,
  fstatSync,
  closeSync,
  lstatSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = process.env.AMYGDALA_DATA_DIR || join(homedir(), ".openclaw", "data", "amygdala");
// One amygdala (2026-10-15, the architect): this is the AEGIS hard-rule layer of the digital amygdala (J11 v6.7 §6.1), moved
// here from tinkerclaw-learned-intuition. It reads the rules the amygdala compiles from src/rules.ts
// (AMYGDALA_POLICY_PATH); the decision spool and the owner grants keep their old place in DATA_DIR, so the chat's
// bubbles and the "allow <code>" history carry on.
const POLICY_PATH = process.env.AMYGDALA_POLICY_PATH || join(DATA_DIR, "policy.json");
const SPOOL_PATH = join(DATA_DIR, "hook-decisions.jsonl");
// The agent's own files (2026-11-16): the list the gateway keeps beside the policy (src/own-files.ts, OWN_FILES_NAME).
const OWN_FILES_PATH = join(dirname(POLICY_PATH), "own-files.jsonl");
const GRANTS_USED_PATH = join(DATA_DIR, "owner-grants-used.jsonl");

/**
 * Owner grant (the architect, 2026-10-12): an enforced deny can be lifted for ONE exact
 * command, only by the owner's own typed words. The deny carries a challenge code
 * derived from rule id + exact command text; if the owner's latest typed chat
 * message says "allow <code>" (within GRANT_MAX_AGE_MS), the identical command
 * passes once and the code is spent. The agent cannot write the owner's message
 * into the transcript, so it still cannot open the gate itself; a changed command
 * gets a different code. Task notifications, agent-sent (blue) prompts and
 * non-Tinker senders never count as the owner.
 */
const GRANT_MAX_AGE_MS = 30 * 60 * 1000;
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
const STAMP_RE = /\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} \d{2}:\d{2} GMT[+-]\d+\]/g;

function grantCode(ruleId, command) {
  const h = createHash("sha256").update(`${ruleId}\n${command}`).digest("hex");
  return `AEGIS-${parseInt(h.slice(0, 10), 16).toString(36).toUpperCase().padStart(6, "0").slice(-6)}`;
}

function readTail(path, bytes) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

/** The owner's own words in a user-turn text, or null when it is not an owner turn. */
function ownerWords(text) {
  if (text.includes("</turn_context>") || text.includes("Sender (untrusted metadata)")) {
    const labels = [...text.matchAll(/"label":\s*"([^"]*)"/g)];
    const label = labels.length ? labels[labels.length - 1][1] : "";
    if (!label.startsWith("Tinker UI")) return null; // agent / longjob / channel senders
    const stamps = [...text.matchAll(STAMP_RE)];
    if (!stamps.length) return null;
    const last = stamps[stamps.length - 1];
    let words = text.slice(last.index + last[0].length);
    const cut = words.indexOf("<!-- TINKERCLAW");
    if (cut >= 0) words = words.slice(0, cut);
    if (words.includes("⟦AGENT:")) return null;
    return words;
  }
  const t = text.trimStart();
  if (!t || t.startsWith("<")) return null; // task notifications, system reminders
  return text;
}

/**
 * The text of a transcript row that can carry the owner's typed words, or null: a `user` row that is
 * not meta and not a tool result, or (2026-11-14) his message sent while the turn was still running.
 * Claude Code writes that one as no `user` row at all: it absorbs it into the running turn and records
 * `{type:"attachment", attachment:{type:"queued_command", commandMode:"prompt", prompt}}`. Before this,
 * an Allow pressed while the agent worked never counted, and the "retry the identical command" the deny
 * text asks for was refused a second time. Job and task notifications arrive the same way with another
 * commandMode and stay out; ownerWords() then applies the same owner test to both kinds of row.
 */
function typedText(row) {
  if (!row || row.isMeta) {
    return null;
  }
  if (row.type === "attachment") {
    const a = row.attachment;
    if (a?.type !== "queued_command" || a.commandMode !== "prompt") {
      return null;
    }
    if (typeof a.prompt === "string") {
      return a.prompt;
    }
    if (Array.isArray(a.prompt)) {
      return a.prompt
        .filter((b) => b?.type === "text")
        .map((b) => b.text || "")
        .join("\n");
    }
    return null;
  }
  if (row.type !== "user") {
    return null;
  }
  const c = row.message?.content;
  if (typeof c === "string") {
    return c;
  }
  if (Array.isArray(c)) {
    if (c.some((b) => b?.type === "tool_result")) {
      return null;
    }
    return c
      .filter((b) => b?.type === "text")
      .map((b) => b.text || "")
      .join("\n");
  }
  return "";
}

/** Latest owner-typed message from the transcript tail: { words, ts } or null. */
function latestOwnerMessage(transcriptPath) {
  if (!transcriptPath) return null;
  let tail;
  try {
    tail = readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES);
  } catch {
    return null;
  }
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue; // first line of the tail may be cut
    }
    const text = typedText(row);
    if (text === null) {
      continue;
    }
    const words = ownerWords(text);
    if (words === null) continue;
    return { words, ts: Date.parse(row.timestamp || "") };
  }
  return null;
}

/** Every owner-typed message newer than maxAgeMs, newest first. */
function recentOwnerMessages(transcriptPath, maxAgeMs) {
  const out = [];
  if (!transcriptPath) return out;
  let tail;
  try {
    tail = readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES);
  } catch {
    return out;
  }
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const text = typedText(row);
    if (text === null) {
      continue;
    }
    const ts = Date.parse(row.timestamp || "");
    if (Number.isFinite(ts) && Date.now() - ts > maxAgeMs) break;
    const words = ownerWords(text);
    if (words !== null) out.push({ words, ts });
  }
  return out;
}

/**
 * Storing a secret the owner pasted (2026-10-15, after a pasted token was refused: once it is in
 * the chat, storing it properly is the safer path). An APPEND to
 * ~/.openclaw/.env passes when every long value it writes was typed by the owner himself in the
 * last 30 minutes. Nothing stored is read, and the value is already his and in the chat. Any read
 * of .env in the same command, or any value he did not paste, keeps the normal gate.
 */
const ENV_APPEND_RE = />>\s*(?:~|\$HOME|\/home\/[\w.-]+)\/\.openclaw\/\.env\b/;
const ENV_READ_RE =
  /\b(?:cat|less|more|head|tail|grep|rg|sed|awk|strings|xxd|base64|source|cp|mv|scp|curl)\b[^|;&\n]*\.env\b|<\s*\S*\.env\b|\bsource\s|\.\s+\S*\.env\b/;
function storesOwnerPastedSecret(transcriptPath, cmd) {
  if (!ENV_APPEND_RE.test(cmd) || ENV_READ_RE.test(cmd)) return false;
  if (/[\w.-]+\.secret\b|\.config\/(?:orbisvision|jarvis)\/|\.openclaw\/credentials\//.test(cmd))
    return false;
  const values = [...cmd.matchAll(/[A-Za-z0-9_\-+/=.]{24,}/g)]
    // `KEY=value` glues the key onto the value; match the value alone (2026-10-26, a pasted Slack token).
    .map((m) => m[0].replace(/^[A-Z][A-Z0-9_]*=/, ""))
    .filter((v) => v.length >= 24 && !/\.openclaw|\/home\//.test(v));
  if (!values.length) return false;
  const typed = recentOwnerMessages(transcriptPath, GRANT_MAX_AGE_MS).map((m) => m.words);
  return values.every((v) => typed.some((w) => w.includes(v)));
}

function grantAlreadyUsed(code) {
  try {
    return readFileSync(GRANTS_USED_PATH, "utf-8").includes(`"${code}"`);
  } catch {
    return false;
  }
}

/** True when the owner granted exactly this command once; records the use. */
/**
 * Deletion intent (2026-10-13): a request to free disk space is a request for
 * help, not an instruction to delete. A delete rule passes only when the owner's latest typed
 * message (same owner-only reading as the grant) asks for deletion in his own words.
 */
const DELETE_INTENT_RE =
  /\b(?:delete|deleting|remove|removing|erase|wipe|purge|trash|get rid of|rm|borra|borrar|esborra|esborrar|elimina|eliminar|suprimeix|suprimir)\b/i;

async function ownerAskedToDelete(transcriptPath, command) {
  const msg = latestOwnerMessage(transcriptPath);
  if (!msg || !Number.isFinite(msg.ts) || Date.now() - msg.ts > GRANT_MAX_AGE_MS) return false;
  if (!hasUnnegatedIntent(msg.words, DELETE_INTENT_RE)) return false; // cheap filter, no network
  return (await jevScore(msg.words, command, "asks_deletion", JEV_QUESTION)) >= JEV_DELETE_MIN;
}

/**
 * Secret intent (2026-10-13): stored secrets get the same rule as deletion, allowed only by
 * explicit phrasing. Reading or using a stored password
 * passes only when the owner's latest typed message asks for it in his own words and Jev agrees;
 * otherwise the one-time code. Same negation and question filters as deletion.
 */
const SECRET_INTENT_RE =
  /\b(?:password|passwords|passwd|passphrase|secret|credentials?|sudo|token|contrasenya|contrasenyes|contraseña|contraseñas|clau|clave)\b/i;
const JEV_SECRET_QUESTION =
  "Verify if this prompt specifically authorizes the assistant to use a password or secret: owner_message is the prompt, command is what would run. Answer true only if owner_message explicitly tells the assistant to use, read or enter the stored password, secret or credential that command accesses. Discussion about passwords, questions, quoted or mentioned words, hypotheticals and negated statements are false.";

async function ownerAskedForSecret(transcriptPath, command) {
  const msg = latestOwnerMessage(transcriptPath);
  if (!msg || !Number.isFinite(msg.ts) || Date.now() - msg.ts > GRANT_MAX_AGE_MS) return false;
  if (!hasUnnegatedIntent(msg.words, SECRET_INTENT_RE)) return false; // cheap filter, no network
  return (await jevScore(msg.words, command, "asks_secret", JEV_SECRET_QUESTION)) >= JEV_DELETE_MIN;
}

/**
 * Jev check (2026-10-13): Jev verifies whether the prompt specifically asks for the deletion
 * to be performed. The keyword filter alone misreads prompts;
 * Jev reads the owner's message against the exact command. Fails closed: no token, timeout or
 * any error → 0, and the deny's one-time code stays the way through.
 * Measured 2026-10-13 (jev-latest, 2 runs): explicit "Delete the 12 old Timeshift snapshots."
 * 0.84–0.91, Catalan "Esborra la cache de pip" 0.96; "clean timeshift enough (old files)" 0.64–0.66,
 * the quoted word 'delete' 0.30–0.51, negated 0.06–0.08, same message with another command 0.06–0.09.
 * Jev does NOT bind the target reliably (a broader worktree removal still scored 0.97), so this
 * gates the intent only.
 */
const JEV_DELETE_MIN = 0.8;
const JEV_URL = process.env.AMYGDALA_JEV_URL || "https://api.typesafe.ai/v1/systemone";
// The owner's rule (2026-10-15): no Jev answer within 1 s = failed. Same ceiling as src/infra/jev/jev.ts
// JEV_MAX_WAIT_MS; this hook runs before every guarded tool call of every worker, so its wait is paid per call.
const JEV_TIMEOUT_MS = 1000;
const JEV_QUESTION =
  "Verify if this prompt specifically asks for a deletion to be performed: owner_message is the prompt, command is what would run. Answer true only if owner_message explicitly instructs the assistant to delete, remove or erase the specific items that command would delete. Requests for help, cleanup or space, questions, quoted or mentioned words, hypotheticals and negated statements are false.";

function jevKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    // The gateway's drop-in holds the key; chat workers do not inherit it.
    const conf = readFileSync(
      join(homedir(), ".config", "systemd", "user", "openclaw-gateway.service.d", "typesafe.conf"),
      "utf-8",
    );
    return (conf.match(/TYPESAFE_API_KEY=["']?([^"'\s]+)/) || [])[1] || "";
  } catch {
    return "";
  }
}

/** Long token-like runs (keys, passwords pasted in chat) never leave the machine. */
function redact(text) {
  // Paths stay (2026-11-04): Jev must see WHAT a delete targets to judge it against the task;
  // a long absolute path had been cut to [redacted]. Token-like runs still go.
  return String(text)
    .replace(/[A-Za-z0-9_\-+/=.]{24,}/g, (m) =>
      m.includes("/") && PATH_RUN_RE.test(m) ? m : "[redacted]",
    )
    .slice(0, 2000);
}

async function jevScore(words, command, question, instructions) {
  return (await jevScoreOrNull(words, command, question, instructions)) ?? 0;
}

/** Jev's score, or null when Jev gave no answer (no key, timeout, error). */
async function jevScoreOrNull(words, command, question, instructions) {
  const key = jevKey();
  if (!key) return null;
  try {
    const r = await fetch(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "jev-latest",
        state: { owner_message: redact(words), command: redact(command) },
        questions: { [question]: { type: "noul", instructions } },
      }),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const p = (await r.json())?.answers?.[question]?.noul;
    return typeof p === "number" && Number.isFinite(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Side-agenda check (2026-11-04): a deletion no longer needs the owner's words. It passes when it
 * plausibly serves the task he gave, and is held only when its target is far from that task, the
 * sign of an assistant pursuing something nobody asked for. Jev reads the last few prompts against
 * the command; only a clear "unrelated" (below AGENDA_MAX) holds it. No Jev answer → it passes
 * (the hold exists to catch a side agenda, not to fail closed on an outage).
 * Returns "serves", "agenda", or "no-task" when there is no prompt to compare against.
 */
const AGENDA_MAX = 0.25;
const TASK_WINDOW_MS = 6 * 60 * 60 * 1000;
const JEV_TASK_QUESTION =
  "Verify if the deletion in command serves the task in owner_message: owner_message holds the owner's recent prompts (newest first), command is what the assistant would run. Answer true if deleting those items is part of that task or a reasonable step toward it (cleaning up files the task created or touched, replacing, rebuilding, freeing space when asked). Answer false only if the deleted items are unrelated to anything the owner asked, as if the assistant were pursuing an agenda of its own.";

async function deletionServesTask(transcriptPath, command) {
  const prompts = recentOwnerMessages(transcriptPath, TASK_WINDOW_MS)
    .slice(0, 3)
    .map((m) => m.words.trim())
    .filter(Boolean);
  if (!prompts.length) return "no-task";
  const p = await jevScoreOrNull(
    prompts.join("\n---\n"),
    command,
    "serves_task",
    JEV_TASK_QUESTION,
  );
  return p !== null && p < AGENDA_MAX ? "agenda" : "serves";
}

/**
 * Send serves the task (2026-11-05): a step that sends data to an outside service no longer
 * needs the owner's words when it is part of what he asked for in his last few prompts (setting
 * up the server he asked to be set up calls that host's API). Jev reads the prompts against the
 * command; it is held only on a clear "unrelated" or when there is no prompt to compare against.
 * Hard rules on credentials and exfiltration stay as they are.
 */
const JEV_SEND_TASK_QUESTION =
  "Verify if the data the command sends serves the task in owner_message: owner_message holds the owner's recent prompts (newest first), command is what the assistant would run. Answer true if sending this request to that destination is part of that task or a reasonable step toward it. Answer false if the destination or the data are unrelated to anything the owner asked, as if the assistant were pursuing an agenda of its own.";

export async function sendServesTask(transcriptPath, command) {
  const prompts = recentOwnerMessages(transcriptPath, TASK_WINDOW_MS)
    .slice(0, 3)
    .map((m) => m.words.trim())
    .filter(Boolean);
  if (!prompts.length || !command) return false;
  const p = await jevScoreOrNull(
    prompts.join("\n---\n"),
    command,
    "serves_task",
    JEV_SEND_TASK_QUESTION,
  );
  return p !== null && p >= AGENDA_MAX;
}

/**
 * Secret serves the task (2026-11-05): using a stored key no longer needs the owner to name it.
 * It passes when Jev reads it as a step in the task from his last few prompts (editing his Slack
 * message with the Slack token he asked us to use for Slack). Unlike deletion it fails closed:
 * no Jev answer, or no prompt to compare against, keeps the hold, since a leaked key cannot be
 * taken back. Sending a secret over the web stays with CREDENTIAL_EXFIL.
 */
const JEV_SECRET_TASK_QUESTION =
  "Verify if using the stored secret in command serves the task in owner_message: owner_message holds the owner's recent prompts (newest first), command is what the assistant would run. Answer true if the secret is the credential for the very service or machine the owner asked the assistant to act on, and the command performs that requested action. Answer false if the secret belongs to a different service, or the command does something the owner did not ask for.";

async function secretServesTask(transcriptPath, command) {
  const prompts = recentOwnerMessages(transcriptPath, TASK_WINDOW_MS)
    .slice(0, 3)
    .map((m) => m.words.trim())
    .filter(Boolean);
  if (!prompts.length) return false;
  const p = await jevScoreOrNull(
    prompts.join("\n---\n"),
    command,
    "serves_task",
    JEV_SECRET_TASK_QUESTION,
  );
  return p !== null && p >= JEV_DELETE_MIN;
}

/**
 * Deletions that stay held whatever the task (2026-11-04): the two memory databases. A recursive
 * delete of an absolute path outside /tmp keeps its own floor (FS_DESTRUCTIVE_ROOT).
 */
const PROTECTED_DELETE_RE = /\bmain\.sqlite\b|\bwhatsapp-history\.db\b/;
function deletesProtected(command) {
  return PROTECTED_DELETE_RE.test(command);
}

/**
 * A delete word counts only when its own sentence does not negate it shortly before:
 * a sentence like "I did not ask you to delete those files" (invented example) is a refusal,
 * and a bare keyword match had read a live sentence of that shape (2026-10-13) as permission
 * on the first live test.
 */
const NEGATION_RE =
  /\b(?:never|not|no|without|nothing|don't|didn't|doesn't|won't|shouldn't|do not|did not|sin|no|nunca|mai|cap|ni)\b|n't\b/i;

const QUESTION_RE =
  /\b(?:what|which|whether|can we|could we|should we|could i|can i|tell me|show me|is it safe|qu[eè]|quins?|quines|cu[aá]l(?:es)?|podem|podemos|puc|puedo)\b/i;

function hasUnnegatedIntent(words, intentRe) {
  const re = new RegExp(intentRe.source, "gi");
  for (const m of String(words).matchAll(re)) {
    const before = words.slice(Math.max(0, m.index - 60), m.index);
    const sentence = before.split(/[.!?;\n]/).pop() || "";
    if (NEGATION_RE.test(sentence)) continue;
    // A question like "what could we delete?" (seen 2026-10-13) asks for a list; it is not consent.
    if (QUESTION_RE.test(sentence)) continue;
    return true;
  }
  return false;
}

/**
 * True when the command loads ~/.openclaw/.env only to call read-only Slack Web API methods
 * (2026-10-15: the safety hook should not block obviously harmless interactions; the read-only Frontier token was blocked on conversations.replies). Every URL
 * must be a listed read method; anything that posts, sends data, or prints the key or the file
 * is still blocked. Only .env counts: *.secret files and ~/.config/jarvis stay gated.
 */
const READ_ONLY_API_RE =
  /^https:\/\/slack\.com\/api\/(?:conversations\.(?:list|history|replies|info|members)|search\.messages|users\.(?:info|list)|auth\.test|reactions\.get|team\.info)(?:[?"'\s]|$)/;
function usesKeyOnlyForReadOnlyApi(command) {
  const cmd = String(command || "");
  if (!cmd || !/\.openclaw\/\.env\b/.test(cmd)) return false;
  if (/[\w.-]+\.secret\b|\.config\/(?:orbisvision|jarvis)\/|\.openclaw\/credentials\//.test(cmd))
    return false;
  const urls = cmd.match(/https?:\/\/[^\s"'<>)]+/g) || [];
  if (urls.length === 0) return false;
  if (!urls.every((u) => READ_ONLY_API_RE.test(u))) return false;
  // No body, no non-GET method, no other network tool, no echoing the key or the file.
  if (
    /\s(?:-d|--data(?:-\w+)?|-F|--form|-T|--upload-file)\b|-X\s*(?!GET\b)\w+|--request\s+(?!GET\b)\w+/.test(
      cmd,
    )
  )
    return false;
  if (/\b(?:wget|nc|ncat|scp|rsync|ssh|sftp)\b/.test(cmd)) return false;
  if (
    /\b(?:cat|less|more|head|tail|strings|xxd|base64|printenv|env)\b[^|;&\n]*\.env\b|\bprintenv\b|\becho\s+[^|;&\n]*\$\{?\w*(?:TOKEN|KEY|SECRET|PASS)/i.test(
      cmd,
    )
  )
    return false;
  return true;
}

/**
 * The shell joins a line that ends in a backslash with the next one, and so must a check that
 * splits a command into lines (2026-11-19). Unjoined, the backslash was read as a delete target
 * outside /tmp, own scratch was held, and the targets on the continued line were never checked.
 */
function joinContinuations(command) {
  return String(command).replace(/\\\r?\n/g, " ");
}

/**
 * True when every deletion in the command is a plain rm/shred/unlink of agent scratch under
 * /tmp/<name> (no "..", not /tmp itself or /tmp/*). Any other kind of deletion (cache purge,
 * prune, worktree removal) or any other target → false.
 */
function deletesOnlyTmpScratch(command, ruleRe) {
  let sawDelete = false;
  for (const seg of joinContinuations(command).split(/&&|\|\||[;&|\n]/)) {
    if (!ruleRe.test(` ${seg} `)) continue; // this segment deletes nothing
    // Quotes come off every word, the command word too. Inside `ssh host 'rm -r… /tmp/x'` or
    // `bash -c "rm …"` that word was 'rm, so own scratch on another machine was held as a recursive
    // delete of an absolute path (2026-11-17; the owner asked for own scratch to pass).
    const toks = seg
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/^["']+|["']+$/g, ""))
      .filter(Boolean);
    const i = toks.findIndex((t) => /^(?:rm|rmdir|shred|unlink)$/.test(t));
    if (i < 0) return false; // cache purge, prune, worktree removal, find -delete …
    const targets = toks.slice(i + 1).filter((t) => !t.startsWith("-"));
    if (!targets.length) return false;
    for (const t of targets) {
      if (!/^\/tmp\/[^/\s*?]+/.test(t) || t.includes("..")) return false;
    }
    sawDelete = true;
  }
  return sawDelete;
}

// Fresh files (2026-10-16): the delete guard lets the agent delete files it created in the last 5 minutes.
// A delete passes when EVERY target is named one by one (no wildcard, no $variable, no ".."), is a plain
// file or an empty folder owned by this user, and was born less than FRESH_MS ago by the filesystem's own birth time.
// No recursive delete, no find -delete, no cache purge: anything older, shared or bulk still needs his words.
const FRESH_MS = 5 * 60 * 1000;

function shellWords(seg) {
  const out = [];
  let cur = "",
    q = null,
    any = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < seg.length) cur += seg[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
      any = true;
    } else if (c === "\\" && i + 1 < seg.length) {
      cur += seg[++i];
      any = true;
    } else if (/\s/.test(c)) {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
    } else cur += c;
  }
  if (q) return null; // unbalanced quote: not something to reason about
  if (cur || any) out.push(cur);
  return out;
}

function isFresh(path) {
  try {
    const st = lstatSync(path);
    if (st.uid !== process.getuid()) return false;
    if (st.isDirectory()) {
      if (readdirSync(path).length > 0) return false;
    } else if (!st.isFile()) return false;
    const born = st.birthtimeMs;
    return born > 0 && Date.now() - born <= FRESH_MS && born <= Date.now() + 1000;
  } catch {
    return false;
  }
}

// The agent's own files (2026-11-16, the owner's order: the agent can always delete what it created). The gateway
// records every path a tool call gave birth to (src/own-files.ts: not there before the call, born during it). A
// listed path is the agent's own while the file on disk is the same one (inode and birth time) and nobody changed
// it since the agent's last write (same change time); a folder must be the listed one and hold nothing but paths
// the same command names (the usual clean-up removes the files, then the folder). Same reading as OwnFiles.isOwn in
// the gateway: keep the two equal. The delete must still name each target one by one.
let ownFiles = null;
function isOwnFile(path, named) {
  if (!ownFiles) {
    ownFiles = new Map();
    try {
      for (const line of readFileSync(OWN_FILES_PATH, "utf-8").split("\n")) {
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          if (r && typeof r.p === "string") ownFiles.set(r.p, r);
        } catch {}
      }
    } catch {}
  }
  const rec = ownFiles.get(path);
  if (!rec) return false;
  try {
    const st = lstatSync(path);
    if (st.uid !== process.getuid()) return false;
    if (st.ino !== rec.ino || st.birthtimeMs !== rec.born) return false;
    if (st.isDirectory()) {
      return rec.dir === true && readdirSync(path).every((n) => named.has(join(path, n)));
    }
    return st.isFile() && rec.dir !== true && st.mtimeMs === rec.mtime;
  } catch {
    return false;
  }
}

/** "fresh" when every target is under five minutes old, "own" when some passed by the own-files list, else false. */
function deletesOnlyFreshFiles(command, ruleRe) {
  let sawDelete = false;
  let usedOwn = false;
  const named = new Set(); // every absolute path the command spells, for the folder check of isOwnFile
  const text = joinContinuations(command);
  for (const w of shellWords(text.replace(/&&|\|\||[;&|\n]/g, " ")) ?? []) {
    if (w.startsWith("/")) named.add(w.replace(/\/+$/, ""));
    else if (w.startsWith("~/")) named.add(join(homedir(), w.slice(2)).replace(/\/+$/, ""));
  }
  for (const seg of text.split(/&&|\|\||[;&|\n]/)) {
    if (!ruleRe.test(` ${seg} `)) continue;
    if (/[$`*?[\]{}]/.test(seg)) return false; // expansions and wildcards hide what is deleted
    const toks = shellWords(seg.trim());
    if (!toks) return false;
    const i = toks.findIndex((t) => /^(?:rm|unlink|rmdir)$/.test(t));
    if (i < 0) return false;
    const flags = toks.slice(i + 1).filter((t) => t.startsWith("-"));
    if (flags.some((f) => /^-[a-zA-Z]*[rR]|^--recursive/.test(f))) return false;
    const targets = toks.slice(i + 1).filter((t) => !t.startsWith("-"));
    if (!targets.length) return false;
    for (let t of targets) {
      if (t.startsWith("~/")) t = join(homedir(), t.slice(2));
      if (!t.startsWith("/") || t.includes("..")) return false;
      if (isFresh(t)) continue;
      if (!isOwnFile(t.replace(/\/+$/, "") || "/", named)) return false;
      usedOwn = true;
    }
    sawDelete = true;
  }
  return sawDelete ? (usedOwn ? "own" : "fresh") : false;
}

function ownerGranted(code, transcriptPath) {
  const msg = latestOwnerMessage(transcriptPath);
  if (!msg || !Number.isFinite(msg.ts) || Date.now() - msg.ts > GRANT_MAX_AGE_MS) return false;
  if (!new RegExp(`\\ballow\\s+${code}\\b`, "i").test(msg.words)) return false;
  if (grantAlreadyUsed(code)) return false;
  try {
    appendFileSync(GRANTS_USED_PATH, JSON.stringify({ code, ts: new Date().toISOString() }) + "\n");
  } catch {
    return false; // cannot record the spend → do not allow
  }
  return true;
}

/**
 * His Allow press covers this layer too (2026-11-13). The judge layer holds a step with a question
 * and an Allow button under the reply; the press sends "allow JEV-…" as his prompt, and that layer
 * then lets the step run (src/families/common.ts, ownerAllowTurn). This hook knew only its own
 * AEGIS codes, so a clean-up he had just allowed was refused again as a side agenda and one step
 * needed two Allows. A deletion now passes when his latest typed message is that press, less than
 * GRANT_MAX_AGE_MS old, and the identical command was tried and refused by a guard hook since his
 * message before it. One retry per press. The memory databases and the recursive-delete floor are
 * checked apart from this and stay.
 */
const ALLOW_PRESS_RE = /\ballow\s+JEV-[0-9A-Z]{6}\b/i;
const HOOK_REFUSAL_RE = /^PreToolUse:\S+ hook error:/;

function allowPressCoversRetry(transcriptPath, command) {
  if (!transcriptPath || typeof command !== "string" || !command) return false;
  let tail;
  try {
    tail = readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES);
  } catch {
    return false;
  }
  const lines = tail.split("\n");
  let pressTs = null; // set once his latest message turns out to be an Allow press
  const refused = new Set(); // tool calls a guard hook refused before the press
  const commands = new Map(); // tool call id → command text
  for (let i = lines.length - 1; i >= 0; i--) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (row?.isMeta) continue;
    const c = row?.message?.content;
    if (row?.type === "assistant") {
      if (pressTs === null || !Array.isArray(c)) continue; // steps after the press are the retry itself
      for (const b of c) {
        if (b?.type === "tool_use" && typeof b.input?.command === "string") {
          commands.set(b.id, b.input.command);
        }
      }
      continue;
    }
    if (row?.type === "user" && Array.isArray(c) && c.some((b) => b?.type === "tool_result")) {
      if (pressTs === null) continue;
      for (const b of c) {
        if (b?.type !== "tool_result" || b.is_error !== true) continue;
        const said =
          typeof b.content === "string"
            ? b.content
            : Array.isArray(b.content)
              ? b.content.map((x) => x?.text || "").join("\n")
              : "";
        if (HOOK_REFUSAL_RE.test(said)) refused.add(b.tool_use_id);
      }
      continue;
    }
    const text = typedText(row); // a typed prompt, or one he sent while the turn ran (queued_command)
    if (text === null) {
      continue;
    }
    const words = ownerWords(text);
    if (words === null) continue;
    if (pressTs !== null) break; // his message before the press: older steps are not what he allowed
    const ts = Date.parse(row.timestamp || "");
    if (!ALLOW_PRESS_RE.test(words)) return false;
    if (!Number.isFinite(ts) || Date.now() - ts > GRANT_MAX_AGE_MS) return false;
    pressTs = ts;
  }
  if (pressTs === null) return false;
  if (![...refused].some((id) => commands.get(id) === command)) return false;
  const h = createHash("sha256").update(`${pressTs}\n${command}`).digest("hex");
  const spent = `RETRY-${h.slice(0, 12)}`;
  if (grantAlreadyUsed(spent)) return false;
  try {
    appendFileSync(
      GRANTS_USED_PATH,
      JSON.stringify({ code: spent, ts: new Date().toISOString() }) + "\n",
    );
  } catch {
    return false; // cannot record the spend → do not allow
  }
  return true;
}

/** Tool names whose input is execution-tool command text. */
const EXEC_TOOL_RE = /^(bash|shell|exec|command|run|sh|zsh)$/i;

function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

/**
 * FORK 2026-10-15: show every performed action at the tool call it judged, in context.
 * Every spooled row names the tool call (toolUseId == the Claude tool_use id the
 * chat's tool row carries) and the session, so the UI can hang a bubble on the exact call.
 * Set once per run from the hook payload (this script is one process per call, see the
 * process.exit at the end); null when claude-cli did not send them.
 */
let payloadIds = { toolUseId: null, sessionId: null };

/**
 * A secret row never keeps the secret (2026-10-15: a pasted Jira token prefix sat in the
 * spool). Long token-like runs go. A run is kept only when it reads as a filesystem path
 * (starts with "/", "./", "../", or one of those right after "=", as in --file=/x); a
 * base64 secret that merely contains a "/" is not a path and goes too.
 */
const PATH_RUN_RE = /(?:^|=)\.{0,2}\//;
function isSecretRow(row) {
  const rule = String(row.rule || "");
  return (
    row.decision === "owner-pasted-secret" || rule === "SECRET_UNREQUESTED" || /CREDENTI/.test(rule)
  );
}

function redactTarget(target) {
  return String(target).replace(/[A-Za-z0-9_\-+/=.]{24,}/g, (m) =>
    m.includes("/") && PATH_RUN_RE.test(m) ? m : "‹redacted›",
  );
}

function spool(row) {
  try {
    const out = { ...row, ...payloadIds };
    if (isSecretRow(out) && typeof out.target === "string") out.target = redactTarget(out.target);
    appendFileSync(SPOOL_PATH, JSON.stringify(out) + "\n");
  } catch {
    /* best-effort */
  }
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n",
  );
}

async function main() {
  let policy;
  try {
    policy = JSON.parse(readFileSync(POLICY_PATH, "utf-8"));
  } catch {
    return; // no policy / corrupt → fail-open
  }
  if (!policy || !Array.isArray(policy.rules)) return;

  let payload;
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    return; // unparseable payload → fail-open
  }
  payloadIds = {
    toolUseId: payload.tool_use_id ?? payload.toolUseId ?? null,
    sessionId: payload.session_id ?? payload.sessionId ?? null,
  };

  const toolName = String(payload.tool_name || payload.toolName || "");
  const toolInput = payload.tool_input ?? payload.toolInput ?? {};

  // Build the two candidate texts. EXEC text is only the command (or the
  // serialized input for shell-like tools); ALL text is name + serialized input.
  let execText = "";
  if (/^bash$/i.test(toolName) && typeof toolInput?.command === "string") {
    execText = toolInput.command + scriptBodies(toolInput.command);
  } else if (EXEC_TOOL_RE.test(toolName)) {
    execText = safeStringify(toolInput);
  }
  // 2026-11-12: the delete rule reads the body of a script the command runs only when that script
  // changed in the last 24 hours. A script body is appended so a delete the agent hides in a file
  // it just wrote is still seen; a program installed weeks ago is not that. A run of the two-week
  // old speaker script was blocked for the temp-file clean-up inside it, on a command that deleted
  // nothing. A command that touches the memory databases keeps the full text, and so does every
  // other hard rule (disk formatting, raw device write, recursive delete of an absolute path).
  const deleteText =
    /^bash$/i.test(toolName) &&
    typeof toolInput?.command === "string" &&
    !deletesProtected(execText)
      ? toolInput.command + scriptBodies(toolInput.command, DELETE_SCRIPT_MAX_AGE_MS)
      : execText;
  const allText = `${toolName} ${safeStringify(toolInput)}`;

  const enforcement = policy.hookEnforcement !== false;
  let sampledAllow = false;
  let observed = null;

  for (const r of policy.rules) {
    if (!r || !r.source) continue;
    const text = r.scope === "all" ? allText : r.ownerIntent === "delete" ? deleteText : execText;
    if (!text) continue;
    let re;
    try {
      re = new RegExp(r.source, r.flags || "");
    } catch {
      continue;
    }
    if (!re.test(text)) continue;

    // Everything under /tmp is scratch, recursive deletes included.
    if (
      r.id === "FS_DESTRUCTIVE_ROOT" &&
      deletesOnlyTmpScratch(execText, new RegExp(r.source, (r.flags || "").replace("g", "")))
    ) {
      continue;
    }

    // Redact BEFORE the 200-char cut: a token split by the cut would leave its prefix behind.
    const target = (isSecretRow({ rule: r.id }) ? redactTarget(text) : String(text)).slice(0, 200);
    let agenda = false;
    if (r.enforce && enforcement && r.ownerIntent === "delete") {
      // Deletion needs the owner's words (2026-10-13). Agent scratch under /tmp is fine.
      const nonGlobal = new RegExp(r.source, (r.flags || "").replace("g", ""));
      if (deletesOnlyTmpScratch(deleteText, nonGlobal)) continue;
      const mine = deletesOnlyFreshFiles(deleteText, nonGlobal);
      if (mine) {
        spool({
          ts: new Date().toISOString(),
          tool: toolName,
          target,
          decision: mine === "own" ? "own-files" : "fresh-files",
          rule: r.id,
          enforced: true,
          src: "cc-hook",
        });
        continue;
      }
      // 2026-11-13: his Allow press on the held step releases its identical retry here too.
      if (
        /^bash$/i.test(toolName) &&
        !deletesProtected(deleteText) &&
        allowPressCoversRetry(payload.transcript_path, toolInput?.command)
      ) {
        spool({
          ts: new Date().toISOString(),
          tool: toolName,
          target,
          decision: "owner-allow-retry",
          rule: r.id,
          enforced: true,
          src: "cc-hook",
        });
        continue;
      }
      if (await ownerAskedToDelete(payload.transcript_path, deleteText)) {
        spool({
          ts: new Date().toISOString(),
          tool: toolName,
          target,
          decision: "owner-intent",
          rule: r.id,
          enforced: true,
          src: "cc-hook",
        });
        continue;
      }
      // 2026-11-04: past those, a deletion that serves the task passes; only a side agenda is held.
      if (!deletesProtected(deleteText)) {
        const verdict = await deletionServesTask(payload.transcript_path, deleteText);
        if (verdict === "serves") {
          spool({
            ts: new Date().toISOString(),
            tool: toolName,
            target,
            decision: "serves-task",
            rule: r.id,
            enforced: true,
            src: "cc-hook",
          });
          continue;
        }
        agenda = verdict === "agenda";
      }
    }
    if (r.enforce && enforcement && r.ownerIntent === "secret") {
      // A stored password needs the owner's words (2026-10-13). Only reads count: Edit/Write of
      // a doc that merely names the path is not access.
      if (!/^(?:bash|read|grep|glob)$/i.test(toolName) && !EXEC_TOOL_RE.test(toolName)) continue;
      if (usesKeyOnlyForReadOnlyApi(execText)) continue;
      if (execText && storesOwnerPastedSecret(payload.transcript_path, execText)) {
        spool({
          ts: new Date().toISOString(),
          tool: toolName,
          target,
          decision: "owner-pasted-secret",
          rule: r.id,
          enforced: true,
          src: "cc-hook",
        });
        continue;
      }
      if (await ownerAskedForSecret(payload.transcript_path, execText || allText)) {
        spool({
          ts: new Date().toISOString(),
          tool: toolName,
          target,
          decision: "owner-intent",
          rule: r.id,
          enforced: true,
          src: "cc-hook",
        });
        continue;
      }
      if (await secretServesTask(payload.transcript_path, execText || allText)) {
        spool({
          ts: new Date().toISOString(),
          tool: toolName,
          target,
          decision: "serves-task",
          rule: r.id,
          enforced: true,
          src: "cc-hook",
        });
        continue;
      }
    }
    if (r.enforce && enforcement) {
      const code = grantCode(r.id, execText || allText);
      if (ownerGranted(code, payload.transcript_path)) {
        spool({
          ts: new Date().toISOString(),
          tool: toolName,
          target,
          decision: "owner-allow",
          rule: r.id,
          grant: code,
          enforced: true,
          src: "cc-hook",
        });
        return; // the owner allowed this exact command once
      }
      deny(
        // A general "yes, do it" in chat does not clear this deny (2026-10-12, a Pi SSD
        // format refused three times after the owner's go). Only the owner's own typed
        // "allow <code>" for this exact command does, once (owner grant, see above).
        `AMYGDALA hard rule (AEGIS) [${r.id}]: ${r.explanation}. Blocked. ${agenda ? "This deletion does not match anything the owner asked for in his recent prompts, which is how a side agenda looks. Do not delete it on your own initiative: either drop it, or tell the owner in one sentence what it is and why the task needs it gone. " : r.ownerIntent === "delete" ? 'Asking for help ("free some space", "clean up") is not an instruction to delete. Do this instead: (1) ask the owner ONE specific question that names exactly what would be deleted and its size, e.g. "Delete the 12 Timeshift snapshots from 2022-08-18 to 2026-10-06 (about 195 GB), keeping today\'s?"; (2) give them the exact reply that unblocks it, as a plain sentence starting with the word Delete and naming the same items, e.g. Delete the 12 old Timeshift snapshots. It must be their own message, unquoted and with no negation (not, never, don\'t) in that sentence; it then opens deletions for 30 minutes. Agent scratch under /tmp/<name> is always allowed. ' : r.ownerIntent === "secret" ? 'Using a stored password needs the owner\'s express words. Do this instead: ask the owner ONE specific question naming the secret and what it is for, e.g. "Use the MIC password to add mic-710aix to the docker group?", and give them the exact reply that unblocks it, a plain sentence in their own words such as: Use the MIC password to add my user to the docker group. It must be their own message, unquoted and with no negation; it then opens that kind of access for 30 minutes. ' : ""}${r.id === "FS_DESTRUCTIVE_ROOT" && /\s\/tmp\/[^/\s]+/.test(execText) ? "For your own scratch under /tmp, do not ask the owner for a code: remove its files by absolute path without -r, then rmdir the folder; that passes. " : ""}If the owner wants this exact command run, stop and say what was blocked: an Allow button under your reply sends "allow ${code}" for them (they can also type it), then retry the identical command; the grant works once, for this command only, within 30 minutes. A general "go ahead" does not count, and you must not type or relay the code as if it were theirs. The rule matches any text in the command, comments and heredocs included.`,
      );
      spool({
        ts: new Date().toISOString(),
        tool: toolName,
        target,
        decision: "deny",
        rule: r.id,
        // 2026-10-29: the page draws an Allow button under the reply that sends "allow <grant>" as the owner's prompt.
        grant: code,
        enforced: true,
        src: "cc-hook",
      });
      return;
    }
    // Matched but observe-only (enforce:false or enforcement globally off). Keep looking (2026-11-09):
    // stopping here let CREDENTIAL_CONTENT, which matches every text CREDENTIAL_EXFIL matches, keep that
    // deny from ever firing, and any observe-only rule hid the enforced rules after it. The first
    // observe-only match is logged once, below, only when no enforced rule denies.
    observed ??= { rule: r.id, target };
  }

  if (observed) {
    spool({
      ts: new Date().toISOString(),
      tool: toolName,
      target: observed.target,
      decision: "observe",
      rule: observed.rule,
      enforced: false,
      src: "cc-hook",
    });
    return;
  }

  // No rule matched: spool a sampled "allow" so the feed shows the gate is alive
  // without writing a row for every benign tool call (latency + file growth).
  sampledAllow = pickSample(toolName, allText);
  if (sampledAllow) {
    spool({
      ts: new Date().toISOString(),
      tool: toolName,
      target: String(allText).slice(0, 200),
      decision: "allow",
      rule: null,
      enforced: false,
      src: "cc-hook",
    });
  }
}

/**
 * Bodies of local script files the command runs (`bash x.sh`, `sh`, `zsh`, `source`,
 * `. x.sh`, `./x.sh`, `~/x.sh`, `/abs/x.sh`), so a blocked command written into a file
 * is still seen. 2026-10-12: a format script left in ~ would have run unseen because
 * the gate read only the command text `bash ~/pi-format-ssd.sh`.
 */
// A bare path counts only in COMMAND position (line start or after ; & | ( , optionally behind
// sudo/nohup/exec/env/time). 2026-10-19: `grep -n "coverage" ~/.openclaw/scripts/nightly-backup.sh`
// matched as a run, the script's prune `rm` lines were appended, and a read-only search was
// blocked as DELETE_UNREQUESTED twice. Reading a script is not running it.
const SCRIPT_RUN_RE =
  /(?:^|[\s;&|(])(?:bash|sh|zsh|dash|source|\.)\s+(?:-\w+\s+)*([^\s;&|()]+)|(?:^|[;&|(])\s*(?:(?:sudo|nohup|exec|env|time)\s+(?:-\S+\s+)*)*((?:\.{1,2}|~|\/)[^\s;&|()]*\.(?:sh|bash|zsh))/g;
const SCRIPT_MAX_BYTES = 256 * 1024;
const DELETE_SCRIPT_MAX_AGE_MS = 24 * 3600_000;

/** `maxAgeMs`: leave out a script whose file last changed longer ago than this. */
function scriptBodies(command, maxAgeMs = Infinity) {
  let out = "";
  for (const m of String(command).matchAll(SCRIPT_RUN_RE)) {
    let p = (m[1] || m[2] || "").replace(/^['"]|['"]$/g, "");
    if (!p || p.startsWith("-")) continue;
    if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
    try {
      const fd = openSync(p, "r");
      try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.size > SCRIPT_MAX_BYTES) continue;
        if (Date.now() - st.mtimeMs > maxAgeMs) continue;
        const buf = Buffer.alloc(st.size);
        readSync(fd, buf, 0, st.size, 0);
        out += `\n${buf.toString("utf-8")}`;
      } finally {
        closeSync(fd);
      }
    } catch {
      /* not a readable local file */
    }
  }
  return out;
}

function safeStringify(v) {
  try {
    return typeof v === "string" ? v : JSON.stringify(v) || "";
  } catch {
    return "";
  }
}

/** Deterministic 1-in-50 sampler keyed on the payload (no Math.random in a hook). */
function pickSample(toolName, text) {
  let h = 0;
  const s = toolName + text;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 50 === 0;
}

// Run only as the hook itself. lib.mjs imports sendServesTask from here (2026-11-05); an
// unguarded main() + process.exit(0) ended that process before the send check ran, so every
// held send passed with no check at all.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    /* fail-open: never block the agent on a hook error */
  }
  process.exit(0);
}
