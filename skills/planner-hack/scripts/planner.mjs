#!/usr/bin/env node
/**
 * planner.mjs — Microsoft Planner (inside Teams) via a LIVE Graph access token.
 *
 * Why this exists: Teams now ENCRYPTS the MSAL refresh token in localStorage
 * (`msal.2|…|refreshtoken|…` → {id,nonce,data}), so the classic
 * refresh-token-store flow (teams-hack / outlook-hack) cannot mint Graph tokens
 * for Planner. BUT access tokens are still stored in plaintext and, while a
 * Teams tab is open, there is always a fresh one. This tool reads that live
 * access token straight from the shared tab's localStorage via the OpenClaw
 * browser relay, then calls Graph /planner directly.
 *
 * Requires: an open + shared Teams tab in the relay, and Playwright live in the
 * gateway browser build (GET /storage/local must work). Node 22+ (global
 * WebSocket + fetch). No npm deps.
 *
 * Commands:
 *   planner token-status                 — show the live Graph token (scopes, TTL); never prints the token
 *   planner groups                       — your group/team memberships (id + name)
 *   planner plans [--group <name|id>]    — Planner plans (all, or for one group)
 *   planner tasks <plan name|id>         — tasks of a plan, grouped by bucket
 *   planner buckets <plan name|id>       — buckets of a plan
 *   planner refresh                      — force re-read the token from the tab (ignore cache)
 *
 * Security: the localStorage dump contains ALL of the user's access tokens; it
 * is held in memory only, never written to disk. The chosen Graph token is
 * cached (chmod 600) at ~/.openclaw/credentials/planner-graph.json with its
 * expiry, and is NEVER printed. Reads only — this tool does not create/modify
 * Planner tasks (Graph token has Tasks.ReadWrite; writing to a shared company
 * Planner needs explicit per-action authorization).
 */

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const GRAPH = "https://graph.microsoft.com/v1.0";
const CREDS_DIR = join(homedir(), ".openclaw/credentials");
const CACHE = join(CREDS_DIR, "planner-graph.json");
const WS_URL = (process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789")
  .replace(/^http/, "ws")
  .replace(/\/$/, "");
const RELAY_TIMEOUT = 28000;

// ─── gateway auth token ───
function gwToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const c = JSON.parse(readFileSync(join(homedir(), ".openclaw", "openclaw.json"), "utf8"));
    return c?.gateway?.auth?.token ?? c?.gateway?.controlUi?.auth?.token ?? "";
  } catch {
    return "";
  }
}

// ─── browser relay request (gateway WS RPC `browser.request`) ───
function relay(method, path, { query, body } = {}) {
  return new Promise((resolve, reject) => {
    const TOK = gwToken();
    const ws = new WebSocket(WS_URL, {
      headers: { Origin: "http://127.0.0.1:18790", Authorization: `Bearer ${TOK}` },
    });
    const pending = new Map();
    const uuid = () => "planner-" + Math.random().toString(36).slice(2, 12);
    const send = (m, params) =>
      new Promise((res, rej) => {
        const id = uuid();
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ type: "req", id, method: m, params }));
      });
    const done = (err, val) => {
      try {
        ws.close();
      } catch {}
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => done(new Error("relay timeout")), RELAY_TIMEOUT);
    ws.addEventListener("message", (ev) => {
      let f;
      try {
        f = JSON.parse(ev.data.toString());
      } catch {
        return;
      }
      if (f.type === "event" && f.event === "connect.challenge") {
        send("connect", {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: "webchat-ui",
            displayName: "planner",
            version: "0.1",
            platform: "cli",
            mode: "webchat",
          },
          role: "operator",
          scopes: ["operator.admin"],
          caps: [],
          auth: { token: TOK },
        })
          .then(() => send("browser.request", { method, path, query, body, timeoutMs: 25000 }))
          .then((r) => {
            clearTimeout(timer);
            done(null, r);
          })
          .catch((e) => {
            clearTimeout(timer);
            done(e);
          });
        return;
      }
      if (f.type === "res") {
        const p = pending.get(f.id);
        if (!p) return;
        pending.delete(f.id);
        f.ok ? p.res(f.payload) : p.rej(new Error(f.error?.message ?? JSON.stringify(f.error)));
      }
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(timer);
      done(new Error("ws: " + (e?.message ?? e)));
    });
  });
}

// ─── find the shared Teams tab ───
async function teamsTargetId() {
  const r = await relay("GET", "/tabs");
  const tabs = r?.tabs ?? [];
  const hit = tabs.find(
    (t) =>
      /teams\.(cloud\.)?microsoft|teams\.office/.test(t.url || "") ||
      /teams|planner/i.test(t.title || ""),
  );
  if (!hit) {
    const seen = tabs.map((t) => t.title || t.url).join(", ") || "(none)";
    throw new Error(
      `No shared Teams tab found in the relay. Open Teams (Planner) in Chrome and share the tab. Tabs seen: ${seen}`,
    );
  }
  return hit.targetId;
}

// ─── pick a live Graph access token from the tab's localStorage ───
function decodeJwt(tok) {
  try {
    const p = tok.split(".")[1];
    return JSON.parse(
      Buffer.from(p + "=".repeat((4 - (p.length % 4)) % 4), "base64url").toString(),
    );
  } catch {
    return {};
  }
}

async function extractGraphToken() {
  const targetId = await teamsTargetId();
  const r = await relay("GET", "/storage/local", { query: { targetId } });
  if (r?.err || !r?.values) {
    throw new Error(
      "storage read failed: " +
        (r?.err || "no values — is Playwright live in the gateway browser build?"),
    );
  }
  const now = Math.floor(Date.now() / 1000);
  let best = null;
  for (const [k, v] of Object.entries(r.values)) {
    const parts = k.split("|");
    if (parts.length < 7 || parts[3] !== "accesstoken") continue;
    if (!/graph\.microsoft\.com/.test(parts[6] || "")) continue;
    let p;
    try {
      p = JSON.parse(v);
    } catch {
      continue;
    }
    const exp = Number(p.expiresOn || 0);
    if (exp <= now + 120) continue;
    const scp = decodeJwt(p.secret).scp || "";
    if (!/Tasks\.Read/i.test(scp)) continue; // need Planner read; Group.Read.All is bonus for group plans
    if (!best || exp > best.expiresOn) best = { secret: p.secret, expiresOn: exp, scopes: scp };
  }
  if (!best)
    throw new Error(
      "No live graph.microsoft.com access token with Tasks scope in the tab. Token may have just rotated — try again, or click around Planner to mint one.",
    );
  return best;
}

async function liveGraphToken({ force = false } = {}) {
  mkdirSync(CREDS_DIR, { recursive: true });
  if (!force && existsSync(CACHE)) {
    try {
      const c = JSON.parse(readFileSync(CACHE, "utf8"));
      if (c.expiresOn > Math.floor(Date.now() / 1000) + 120 && c.secret) return c;
    } catch {}
  }
  const tok = await extractGraphToken();
  writeFileSync(CACHE, JSON.stringify(tok), { mode: 0o600 });
  try {
    chmodSync(CACHE, 0o600);
  } catch {}
  return tok;
}

// ─── Graph helper ───
async function graph(path) {
  const { secret } = await liveGraphToken();
  const res = await fetch(GRAPH + path, { headers: { Authorization: "Bearer " + secret } });
  const j = await res.json().catch(() => ({}));
  if (j.error) throw new Error(`Graph ${path} → ${j.error.code}: ${j.error.message}`);
  return j;
}

// ─── plan resolution (name or id, across my plans + group plans) ───
async function allPlans() {
  const out = new Map();
  try {
    for (const p of (await graph("/me/planner/plans")).value || []) out.set(p.id, p);
  } catch {}
  let groups = [];
  try {
    groups = (await graph("/me/memberOf?$select=id,displayName&$top=200")).value || [];
  } catch {}
  for (const g of groups) {
    if (!g.id) continue;
    try {
      for (const p of (await graph(`/groups/${g.id}/planner/plans`)).value || []) {
        p.__group = g.displayName;
        out.set(p.id, p);
      }
    } catch {}
  }
  return [...out.values()];
}

async function resolvePlan(arg) {
  if (/^[A-Za-z0-9_\-]{20,}$/.test(arg)) {
    try {
      const p = await graph(`/planner/plans/${arg}`);
      if (p.id) return p;
    } catch {}
  }
  const plans = await allPlans();
  const lc = arg.toLowerCase();
  const exact = plans.find((p) => (p.title || "").toLowerCase() === lc);
  if (exact) return exact;
  const sub = plans.filter((p) => (p.title || "").toLowerCase().includes(lc));
  if (sub.length === 1) return sub[0];
  if (sub.length > 1)
    throw new Error(`Ambiguous "${arg}" — matches: ${sub.map((p) => p.title).join(", ")}`);
  throw new Error(`No plan named/with id "${arg}". Run \`planner plans\` to list them.`);
}

const PCT = { 0: "⬜ No iniciada", 50: "🔵 En curs", 100: "✅ Completada" };

const stripHtml = (s) =>
  (s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// Fetch a task's BODY: description, checklist items (with checked state),
// reference aliases, and conversation-thread comments. Returns rendered lines
// (indented) or [] when the task is empty. `groupId` is the plan's owner group
// (needed to read the comment thread).
async function taskBody(task, groupId) {
  const det = await graph(`/planner/tasks/${task.id}/details`);
  const lines = [];
  const desc = (det.description || "").trim();
  if (desc) lines.push("    descripció: " + desc.replace(/\s+/g, " "));
  const checklist = Object.values(det.checklist || {}).sort((a, b) =>
    (a.orderHint || "").localeCompare(b.orderHint || ""),
  );
  for (const c of checklist) lines.push(`    [${c.isChecked ? "x" : " "}] ${c.title}`);
  const refs = Object.values(det.references || {})
    .map((r) => r.alias)
    .filter(Boolean);
  if (refs.length) lines.push("    adjunts: " + refs.join(", "));
  if (task.conversationThreadId && groupId) {
    try {
      const posts =
        (await graph(`/groups/${groupId}/threads/${task.conversationThreadId}/posts`)).value || [];
      for (const p of posts) {
        const b = stripHtml(p.body?.content);
        if (b) lines.push("    💬 " + b);
      }
    } catch {
      /* thread unreadable — skip silently */
    }
  }
  return lines;
}

// ─── commands ───
async function cmdTokenStatus() {
  const t = await liveGraphToken();
  const left = Math.round((t.expiresOn - Date.now() / 1000) / 60);
  console.log(`Live Graph token: valid ${left} min`);
  const rel = (t.scopes || "").split(" ").filter((s) => /task|group/i.test(s));
  console.log("Planner-relevant scopes:", rel.join(", ") || "(none — Planner may fail)");
}

async function cmdGroups() {
  const gs = (await graph("/me/memberOf?$select=id,displayName&$top=200")).value || [];
  for (const g of gs) if (g.displayName) console.log(g.id, "|", g.displayName);
  console.log(`\n${gs.length} groups`);
}

async function cmdPlans(group) {
  let plans;
  if (group) {
    let gid = group;
    if (!/^[0-9a-f-]{36}$/i.test(group)) {
      const gs = (await graph("/me/memberOf?$select=id,displayName&$top=200")).value || [];
      const g = gs.find((x) => (x.displayName || "").toLowerCase().includes(group.toLowerCase()));
      if (!g) throw new Error(`No group matching "${group}"`);
      gid = g.id;
    }
    plans = ((await graph(`/groups/${gid}/planner/plans`)).value || []).map((p) => ({
      ...p,
      __group: group,
    }));
  } else {
    plans = await allPlans();
  }
  for (const p of plans)
    console.log(p.id, "|", p.title, p.__group ? `  (group: ${p.__group})` : "");
  console.log(`\n${plans.length} plans`);
}

async function cmdBuckets(arg) {
  const plan = await resolvePlan(arg);
  const bks = (await graph(`/planner/plans/${plan.id}/buckets`)).value || [];
  console.log(`Plan "${plan.title}" (${plan.id}) — ${bks.length} buckets:`);
  for (const b of bks) console.log("  •", b.name);
}

async function cmdTasks(arg, { full = false } = {}) {
  const plan = await resolvePlan(arg);
  const groupId = plan.container?.containerId ?? plan.owner;
  const [tasksR, bucketsR] = await Promise.all([
    graph(`/planner/plans/${plan.id}/tasks`),
    graph(`/planner/plans/${plan.id}/buckets`),
  ]);
  const bk = Object.fromEntries((bucketsR.value || []).map((b) => [b.id, b.name]));
  const tasks = tasksR.value || [];
  // group by bucket
  const byBucket = new Map();
  for (const t of tasks) {
    const name = bk[t.bucketId] || "(sense bucket)";
    if (!byBucket.has(name)) byBucket.set(name, []);
    byBucket.get(name).push(t);
  }
  console.log(
    `# Plan "${plan.title}" — ${tasks.length} tasques${full ? " (amb contingut)" : ""}\n`,
  );
  for (const [bucket, items] of byBucket) {
    console.log(`## ${bucket}`);
    items.sort(
      (a, b) =>
        a.percentComplete - b.percentComplete ||
        (a.orderHint || "").localeCompare(b.orderHint || ""),
    );
    for (const t of items) {
      const st = PCT[t.percentComplete] ?? `${t.percentComplete}%`;
      const due = (t.dueDateTime || "").slice(0, 10);
      let line = `  - [${st}] ${t.title}`;
      if (due) line += ` · venç ${due}`;
      if (t.checklistItemCount)
        line += ` · checklist ${t.activeChecklistItemCount}/${t.checklistItemCount}`;
      console.log(line);
      if (full) for (const l of await taskBody(t, groupId)) console.log("  " + l);
    }
    console.log("");
  }
}

async function cmdDetails(planArg, taskArg) {
  const plan = await resolvePlan(planArg);
  const groupId = plan.container?.containerId ?? plan.owner;
  const tasks = (await graph(`/planner/plans/${plan.id}/tasks`)).value || [];
  const lc = (taskArg || "").toLowerCase();
  const t =
    tasks.find((x) => x.id === taskArg) ||
    tasks.find((x) => (x.title || "").toLowerCase() === lc) ||
    tasks.find((x) => (x.title || "").toLowerCase().includes(lc));
  if (!t) throw new Error(`No task "${taskArg}" in plan "${plan.title}".`);
  const st = PCT[t.percentComplete] ?? `${t.percentComplete}%`;
  console.log(`# ${t.title}  [${st}]`);
  if (t.dueDateTime) console.log("venç:", t.dueDateTime.slice(0, 10));
  const body = await taskBody(t, groupId);
  console.log(
    body.length
      ? body.map((l) => l.replace(/^ {4}/, "")).join("\n")
      : "(sense contingut — només títol al Planner)",
  );
}

// ─── dispatch ───
const [cmd, ...rest] = process.argv.slice(2);
function argOf(flag) {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
}

try {
  switch (cmd) {
    case "token-status":
      await cmdTokenStatus();
      break;
    case "groups":
      await cmdGroups();
      break;
    case "plans":
      await cmdPlans(argOf("--group"));
      break;
    case "buckets":
      await cmdBuckets(rest[0]);
      break;
    case "tasks": {
      const positional = rest.filter((a) => !a.startsWith("--"));
      if (!positional[0]) throw new Error("usage: planner tasks <plan name|id> [--full]");
      await cmdTasks(positional[0], { full: rest.includes("--full") });
      break;
    }
    case "details": {
      const positional = rest.filter((a) => !a.startsWith("--"));
      if (positional.length < 2)
        throw new Error("usage: planner details <plan name|id> <task name|id>");
      await cmdDetails(positional[0], positional.slice(1).join(" "));
      break;
    }
    case "refresh": {
      const t = await liveGraphToken({ force: true });
      console.log(
        "Re-read OK, token valid",
        Math.round((t.expiresOn - Date.now() / 1000) / 60),
        "min",
      );
      break;
    }
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(
        "planner <token-status|groups|plans [--group X]|buckets <plan>|tasks <plan> [--full]|details <plan> <task>|refresh>",
      );
      break;
    default:
      console.error(`Unknown command: ${cmd}. Try \`planner help\`.`);
      process.exit(2);
  }
} catch (e) {
  console.error("✖ " + (e?.message ?? String(e)));
  // a stale cache (rotated token) is the usual culprit — drop it so next run re-reads
  try {
    if (existsSync(CACHE) && /Graph|token|401|InvalidAuth/i.test(e?.message || ""))
      unlinkSync(CACHE);
  } catch {}
  process.exit(1);
}
