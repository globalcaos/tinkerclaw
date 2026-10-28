#!/usr/bin/env node
// RETIRED 2026-10-15: no longer installed. The live copy is extensions/tinkerclaw-amygdala/hooks/hard-rules.mjs.
/**
 * AMYGDALA v3.1 — PreToolUse hook (the pre-execution enforcement seam).
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
import { readFileSync, appendFileSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DATA_DIR = process.env.AMYGDALA_DATA_DIR || join(homedir(), ".openclaw", "data", "amygdala");
const POLICY_PATH = join(DATA_DIR, "policy.json");
const SPOOL_PATH = join(DATA_DIR, "hook-decisions.jsonl");
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
    if (row?.type !== "user" || row.isMeta) continue;
    const c = row.message?.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      if (c.some((b) => b?.type === "tool_result")) continue;
      text = c
        .filter((b) => b?.type === "text")
        .map((b) => b.text || "")
        .join("\n");
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
    if (row?.type !== "user" || row.isMeta) continue;
    const ts = Date.parse(row.timestamp || "");
    if (Number.isFinite(ts) && Date.now() - ts > maxAgeMs) break;
    const c = row.message?.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      if (c.some((b) => b?.type === "tool_result")) continue;
      text = c
        .filter((b) => b?.type === "text")
        .map((b) => b.text || "")
        .join("\n");
    }
    const words = ownerWords(text);
    if (words !== null) out.push({ words, ts });
  }
  return out;
}

/**
 * Storing a secret the architect pasted (the architect, 2026-10-15 12:19, after a pasted Jira token was refused:
 * "the cat is already out of the box ... now just store it properly"). An APPEND to
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
 * Deletion intent (2026-10-13): a request to free some disk space is a request for
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
 * Secret intent (2026-10-13): stored secrets get the same rule as deletion, allowed only when
 * the prompt asks for them explicitly. Reading or using a stored password
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
 * Jev check (2026-10-13): Jev is asked whether the prompt specifically requests a deletion.
 * The keyword filter alone misreads prompts;
 * Jev reads the owner's message against the exact command. Fails closed: no token, timeout or
 * any error → 0, and the deny's one-time code stays the way through.
 * Measured 2026-10-13 (jev-latest, 2 runs): an explicit delete request
 * 0.84–0.91, an explicit one in another language 0.96; a vague clean-up request 0.64–0.66,
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
  return String(text)
    .replace(/[A-Za-z0-9_\-+/=.]{24,}/g, "[redacted]")
    .slice(0, 2000);
}

async function jevScore(words, command, question, instructions) {
  const key = jevKey();
  if (!key) return 0;
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
    if (!r.ok) return 0;
    const p = (await r.json())?.answers?.[question]?.noul;
    return typeof p === "number" && Number.isFinite(p) ? p : 0;
  } catch {
    return 0;
  }
}

/**
 * A delete word counts only when its own sentence does not negate it shortly before:
 * an invented example, "never told you to delete those files", is a refusal,
 * and a bare keyword match had read it as permission on the first live test.
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
    // "Tell me what we can delete" (the architect, 2026-10-13 11:32) asks for a list; it is not consent.
    if (QUESTION_RE.test(sentence)) continue;
    return true;
  }
  return false;
}

/**
 * True when the command loads ~/.openclaw/.env only to call read-only Slack Web API methods
 * (2026-10-15: the safety hook must not block plainly harmless calls; the read-only Frontier token was blocked on conversations.replies). Every URL
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
 * True when every deletion in the command is a plain rm/shred/unlink of agent scratch under
 * /tmp/<name> (no "..", not /tmp itself or /tmp/*). Any other kind of deletion (cache purge,
 * prune, worktree removal) or any other target → false.
 */
function deletesOnlyTmpScratch(command, ruleRe) {
  let sawDelete = false;
  for (const seg of String(command).split(/&&|\|\||[;&|\n]/)) {
    if (!ruleRe.test(` ${seg} `)) continue; // this segment deletes nothing
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    const i = toks.findIndex((t) => /^(?:rm|shred|unlink)$/.test(t));
    if (i < 0) return false; // cache purge, prune, worktree removal, find -delete …
    const targets = toks
      .slice(i + 1)
      .filter((t) => !t.startsWith("-"))
      .map((t) => t.replace(/^["']|["']$/g, ""));
    if (!targets.length) return false;
    for (const t of targets) {
      if (!/^\/tmp\/[^/\s*?]+/.test(t) || t.includes("..")) return false;
    }
    sawDelete = true;
  }
  return sawDelete;
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
 * FORK 2026-10-15 (each of Jev's actions is shown in place, inside its own context): every spooled row names the tool call (toolUseId == the Claude tool_use id the
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
  const allText = `${toolName} ${safeStringify(toolInput)}`;

  const enforcement = policy.hookEnforcement !== false;
  let sampledAllow = false;

  for (const r of policy.rules) {
    if (!r || !r.source) continue;
    const text = r.scope === "all" ? allText : execText;
    if (!text) continue;
    let re;
    try {
      re = new RegExp(r.source, r.flags || "");
    } catch {
      continue;
    }
    if (!re.test(text)) continue;

    // Redact BEFORE the 200-char cut: a token split by the cut would leave its prefix behind.
    const target = (isSecretRow({ rule: r.id }) ? redactTarget(text) : String(text)).slice(0, 200);
    if (r.enforce && enforcement && r.ownerIntent === "delete") {
      // Deletion needs the owner's words (2026-10-13). Agent scratch under /tmp is fine.
      const nonGlobal = new RegExp(r.source, (r.flags || "").replace("g", ""));
      if (deletesOnlyTmpScratch(execText, nonGlobal)) continue;
      if (await ownerAskedToDelete(payload.transcript_path, execText)) {
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
        `AMYGDALA AEGIS [${r.id}]: ${r.explanation}. Blocked. ${r.ownerIntent === "delete" ? 'Asking for help ("free some space", "clean up") is not an instruction to delete. Do this instead: (1) ask the owner ONE specific question that names exactly what would be deleted and its size, e.g. "Delete the 12 Timeshift snapshots from 2022-08-18 to 2026-10-06 (about 195 GB), keeping today\'s?"; (2) give them the exact reply that unblocks it, as a plain sentence starting with the word Delete and naming the same items, e.g. Delete the 12 old Timeshift snapshots. It must be their own message, unquoted and with no negation (not, never, don\'t) in that sentence; it then opens deletions for 30 minutes. Agent scratch under /tmp/<name> is always allowed. ' : r.ownerIntent === "secret" ? 'Using a stored password needs the owner\'s express words. Do this instead: ask the owner ONE specific question naming the secret and what it is for, e.g. "Use the MIC password to add mic-710aix to the docker group?", and give them the exact reply that unblocks it, a plain sentence in their own words such as: Use the MIC password to add my user to the docker group. It must be their own message, unquoted and with no negation; it then opens that kind of access for 30 minutes. ' : ""}${r.id === "FS_DESTRUCTIVE_ROOT" && /\s\/tmp\/[^/\s]+/.test(execText) ? "For your own scratch under /tmp, do not ask the owner for a code: remove its files by absolute path without -r, then rmdir the folder; that passes. " : ""}If the owner wants this exact command run, ask them to type "allow ${code}" in the chat, then retry the identical command; the grant works once, for this command only, within 30 minutes. A general "go ahead" does not count, and you must not type or relay the code as if it were theirs. The rule matches any text in the command, comments and heredocs included.`,
      );
      spool({
        ts: new Date().toISOString(),
        tool: toolName,
        target,
        decision: "deny",
        rule: r.id,
        enforced: true,
        src: "cc-hook",
      });
      return;
    }
    // Matched but observe-only (enforce:false or enforcement globally off).
    spool({
      ts: new Date().toISOString(),
      tool: toolName,
      target,
      decision: "observe",
      rule: r.id,
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
const SCRIPT_RUN_RE =
  /(?:^|[\s;&|(])(?:(?:bash|sh|zsh|dash|source|\.)\s+(?:-\w+\s+)*([^\s;&|()]+)|((?:\.{1,2}|~|\/)[^\s;&|()]*\.(?:sh|bash|zsh)))/g;
const SCRIPT_MAX_BYTES = 256 * 1024;

function scriptBodies(command) {
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

try {
  await main();
} catch {
  /* fail-open: never block the agent on a hook error */
}
process.exit(0);
