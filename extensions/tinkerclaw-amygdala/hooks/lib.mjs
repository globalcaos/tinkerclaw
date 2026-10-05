/**
 * Digital amygdala v2 - shared library for the hook scripts.
 *
 * Runs INSIDE claude-cli's hook sandbox, staged next to the hooks: node builtins only, no
 * package imports. Every function fails open (returns null / "" / does nothing) except
 * `evalFloor`, which never throws but returns the rule on a match - a matched hard rule denies
 * even when the gateway endpoint is unreachable.
 */

import { readFileSync, appendFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

/** Tool names whose input is execution-tool command text. */
const EXEC_TOOL_RE = /^(bash|shell|exec|command|run|sh|zsh)$/i;

export function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

export function dataDir() {
  return process.env.AMYGDALA2_DATA_DIR || join(homedir(), ".openclaw", "data", "amygdala-jev");
}

export function readEndpoint(dir) {
  try {
    const e = JSON.parse(readFileSync(join(dir, "endpoint.json"), "utf-8"));
    if (e && typeof e.port === "number" && typeof e.token === "string") {
      return { port: e.port, token: e.token };
    }
    return null;
  } catch {
    return null;
  }
}

/** The gateway's body limit (src/http.ts MAX_BODY_BYTES) less room for the envelope. */
const BODY_BUDGET = 240 * 1024;
const RESULT_CHARS = 16 * 1024;
const INPUT_CHARS = 64 * 1024;

function cutStrings(v, max, depth = 0) {
  if (typeof v === "string") {
    return v.length > max ? `${v.slice(0, max)}…[cut ${v.length - max} chars]` : v;
  }
  if (v === null || typeof v !== "object" || depth > 8) return v;
  if (Array.isArray(v)) return v.map((x) => cutStrings(x, max, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cutStrings(x, max, depth + 1)]));
}

/**
 * Keeps a hook payload under the gateway's body limit. 2026-10-02: 951 steps were refused with HTTP 413, mostly after
 * a large Read, so the gateway never saw them; it reduces file contents to a size count anyway. Long strings in the
 * tool result are cut to a head; the tool input is cut only if the payload is still too big. The local hard-rule
 * floor keeps reading the full payload.
 */
export function fitPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const out = { ...payload };
  if ("tool_response" in out) out.tool_response = cutStrings(out.tool_response, RESULT_CHARS);
  if (Buffer.byteLength(JSON.stringify(out)) > BODY_BUDGET && "tool_input" in out) {
    out.tool_input = cutStrings(out.tool_input, INPUT_CHARS);
  }
  return out;
}

export function postJson(endpoint, path, body, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    try {
      if (!endpoint) return finish(null);
      const data = JSON.stringify(body ?? {});
      const req = request(
        {
          host: "127.0.0.1",
          port: endpoint.port,
          path,
          method: "POST",
          timeout: timeoutMs,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(data),
            authorization: `Bearer ${endpoint.token}`,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            let json = null;
            try {
              json = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            } catch {
              /* non-JSON body */
            }
            finish({ status: res.statusCode ?? 0, json });
          });
          res.on("error", () => finish(null));
        },
      );
      req.on("timeout", () => {
        req.destroy();
        finish(null);
      });
      req.on("error", () => finish(null));
      req.end(data);
    } catch {
      finish(null);
    }
  });
}

export function loadPolicy(dir) {
  try {
    const p = JSON.parse(readFileSync(join(dir, "policy.json"), "utf-8"));
    if (!p || !Array.isArray(p.rules)) return null;
    return p;
  } catch {
    return null;
  }
}

function safeStringify(v) {
  try {
    return typeof v === "string" ? v : JSON.stringify(v) || "";
  } catch {
    return "";
  }
}

/**
 * Evaluate only the `enforce: true` rules. Same candidate texts as the v3.1 hook: EXEC text is
 * the command (Bash) or the serialized input (shell-like tools); ALL text is name + input.
 */
export function evalFloor(policy, toolName, toolInput) {
  try {
    if (!policy || policy.floorActive === false || !Array.isArray(policy.rules)) return null;
    const name = String(toolName || "");
    let execText = "";
    if (/^bash$/i.test(name) && typeof toolInput?.command === "string") {
      execText = toolInput.command;
    } else if (EXEC_TOOL_RE.test(name)) {
      execText = safeStringify(toolInput);
    }
    const allText = `${name} ${safeStringify(toolInput)}`;
    for (const r of policy.rules) {
      if (!r || !r.source || !r.enforce) continue;
      const text = r.scope === "all" ? allText : execText;
      if (!text) continue;
      let re;
      try {
        re = new RegExp(r.source, r.flags || "");
      } catch {
        continue;
      }
      if (re.test(text)) return { rule: r.id, explanation: r.explanation };
    }
    return null;
  } catch {
    return null;
  }
}

export function spool(dir, row) {
  try {
    appendFileSync(join(dir, "hook-spool.jsonl"), JSON.stringify(row) + "\n");
  } catch {
    /* best-effort */
  }
}

export function emitDeny(reason) {
  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }) + "\n",
    );
  } catch {
    /* nothing to do */
  }
}

export function emitBlock(reason) {
  try {
    process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
  } catch {
    /* nothing to do */
  }
}

/** Run a hook body; whatever happens inside, the process exits 0 (a hook never fails the agent). */
export function hookMain(fn) {
  Promise.resolve()
    .then(fn)
    .catch(() => {})
    .finally(() => process.exit(0));
}

const EVENT_NAME = {
  prompt: "UserPromptSubmit",
  "pre-tool": "PreToolUse",
  "post-tool": "PostToolUse",
};
const BUDGET_MS = { prompt: 2000, "pre-tool": 3000, "post-tool": 2000, stop: 5000 };
/** Shadow hooks hang up after this long; the gateway keeps processing the request it already received. */
const SHADOW_WAIT_MS = 150;

/**
 * The whole body of one hook script (design doc section 6, C19, C20). Floor first (pre-tool only, local, no gateway),
 * then the decide POST: shadow = fire it, wait at most 150 ms, print nothing; enforce = print what the gateway's
 * HookAction says. Every failure path prints nothing (fail open) - except a floor match, which denies.
 */
export async function runSeam(seam) {
  const t0 = Date.now();
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") return;
  const dir = dataDir();
  const shadow = process.env.AMYGDALA2_SHADOW === "1";
  const row = (action, extra) => {
    const r = { ts: t0, seam, session: payload.session_id, action, ms: Date.now() - t0, shadow };
    if (payload.tool_name) r.tool = payload.tool_name;
    spool(dir, { ...r, ...extra });
  };

  if (seam === "pre-tool") {
    const policy = loadPolicy(dir);
    if (!policy) {
      row("floor-missing");
    } else {
      const hit = evalFloor(policy, payload.tool_name, payload.tool_input);
      if (hit) {
        row("floor-deny", { floor: true, rule: hit.rule });
        emitDeny(`Blocked by hard rule ${hit.rule}: ${hit.explanation ?? ""}`.trim());
        return;
      }
    }
  }

  const endpoint = readEndpoint(dir);
  if (!endpoint) {
    row("no-endpoint");
    return;
  }
  const call = postJson(
    endpoint,
    "/plugins/amygdala2/decide",
    // The bridge exports the chat tab's key to the Claude subprocess; the gateway keys everything by it.
    {
      seam,
      hook: fitPayload(payload),
      ...(process.env.TC_SESSION_KEY ? { tabKey: process.env.TC_SESSION_KEY } : {}),
    },
    BUDGET_MS[seam],
  );

  if (shadow) {
    // A family the gateway enforces while the rest is shadow (personality, 2026-10-03) leaves its notes for the next
    // hook call: this one would hang up before the judge answers. The notes route answers at once.
    const key = process.env.TC_SESSION_KEY
      ? { tabKey: process.env.TC_SESSION_KEY }
      : typeof payload?.session_id === "string"
        ? { session_id: payload.session_id }
        : null;
    const notesCall =
      EVENT_NAME[seam] && key
        ? postJson(endpoint, "/plugins/amygdala2/notes", key, SHADOW_WAIT_MS)
        : Promise.resolve(null);
    const wait = () => new Promise((r) => setTimeout(r, SHADOW_WAIT_MS));
    const [res, notes] = await Promise.all([
      Promise.race([call, wait()]),
      Promise.race([notesCall, wait()]),
    ]);
    const texts =
      notes && notes.status === 200 && Array.isArray(notes.json?.notes) ? notes.json.notes : [];
    if (texts.length > 0) emitContext(EVENT_NAME[seam], texts.join("\n\n"));
    // An answer other than 200 means the gateway turned the call away (401 = token mismatch): say so, or the status
    // counts a dead seam as firing (2026-09-30, two hours of 401 spooled as "shadow").
    if (res && res.status !== 200) row("refused", { status: res.status });
    else
      row(
        texts.length > 0 ? "note" : "shadow",
        texts.length > 0 ? { notes: texts.length } : undefined,
      );
    return;
  }

  const res = await call;
  if (res && res.status !== 200) {
    row("refused", { status: res.status });
    return;
  }
  const action = res && res.status === 200 && res.json && res.json.hook;
  if (!action || typeof action !== "object") {
    row("none");
    return;
  }
  row(String(action.kind));
  switch (action.kind) {
    case "context":
      if (EVENT_NAME[seam] && typeof action.text === "string")
        emitContext(EVENT_NAME[seam], action.text);
      return;
    case "deny":
      if (seam === "pre-tool") emitDeny(String(action.reason ?? ""));
      return;
    case "block":
      if (seam === "stop") emitBlock(String(action.reason ?? ""));
      return;
    case "wait": {
      if (seam !== "pre-tool") return;
      const w = await postJson(
        endpoint,
        "/plugins/amygdala2/wait",
        { interventionId: action.interventionId, timeoutMs: action.timeoutMs },
        Number(action.timeoutMs) + 5000,
      );
      const answer = w && w.status === 200 && w.json ? w.json.answer : "timeout";
      if (answer === "allow-once") return;
      if (answer === "keep-held") return emitDeny(action.onKeep);
      if (typeof answer === "string" && answer.startsWith("option:")) {
        return emitDeny(w.json.text || action.onKeep);
      }
      return emitDeny(action.onTimeout);
    }
    default:
      return;
  }
}

export function emitContext(eventName, text) {
  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
      }) + "\n",
    );
  } catch {
    /* nothing to do */
  }
}
