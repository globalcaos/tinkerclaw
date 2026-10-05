/**
 * FORK 2026-10-01 (TINKER_UI_DESIGN_BIBLE/bug-log.md [fanout-dies-with-its-worker]) — a fan-out
 * that outlives the worker that launched it, and a liveness check for whoever waits on it.
 *
 * `openclaw-orchestrate --detach` runs the fan-out as its own systemd user unit
 * (`tinkerclaw-fanout-<id>`), the way the longjob skill hosts shell jobs: the worker's process,
 * the pool's idle sweep and the 3-hour run limit no longer take it down. The unit writes its result
 * and a done marker under `~/.openclaw/fanout/<id>/` and wakes the owning chat with chat.send.
 * `openclaw-orchestrate --status <id>` says whether it is still alive: a unit that is gone with no
 * done marker is DEAD, the case that went unnoticed for 43 minutes on 2026-10-01.
 *
 * Files under the fan-out's directory:
 *   job.json     written at launch: id, unit, label, wake session, when
 *   plan.js      the plan it runs (a copy, so editing the original changes nothing)
 *   run.log      the unit's stdout and stderr
 *   result.json  the orchestrate RPC's answer, when it came
 *   done.json    { ok, exitCode, finishedAt, error? }: the run is over
 *   wake.log     one line per wake attempt
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function fanoutRoot(home = os.homedir()) {
  return path.join(home, ".openclaw", "fanout");
}

export function fanoutUnitName(id) {
  return `tinkerclaw-fanout-${id}`;
}

/** A unit-safe id: the label's slug and a time stamp. */
export function newFanoutId(label, now = Date.now()) {
  const slug = String(label ?? "fanout")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `${slug || "fanout"}-${now.toString(36)}`;
}

export function isValidFanoutId(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,80}$/.test(id);
}

/** Write JSON through a temp file and a rename, so a reader never sees half a file. */
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function systemctlIsActive(unit) {
  const r = spawnSync("systemctl", ["--user", "is-active", `${unit}.service`], {
    encoding: "utf8",
  });
  return (r.stdout || "").trim() || "unknown";
}

/**
 * The argv that runs this fan-out as its own unit. The child is the same script in "inner" mode
 * (`--result-dir`, `--wake-session`), launched with the absolute node binary: a user unit does not
 * see nvm's PATH.
 */
export function buildDetachedLaunch(p) {
  const unit = fanoutUnitName(p.id);
  const inner = [
    p.nodeBin,
    p.scriptPath,
    "--script-file",
    path.join(p.dir, "plan.js"),
    ...(p.argsJson != null ? ["--args", p.argsJson] : []),
    "--session",
    p.attributionSession,
    ...(p.label ? ["--label", p.label] : []),
    "--timeout",
    String(p.timeoutS),
    "--json",
    "--result-dir",
    p.dir,
    ...(p.wakeSession ? ["--wake-session", p.wakeSession] : []),
  ];
  const setenv = [];
  for (const name of ["HOME", "PATH", "OPENCLAW_GATEWAY_URL", "OPENCLAW_GATEWAY_TOKEN"]) {
    const value = p.env?.[name];
    if (value) {
      setenv.push(`--setenv=${name}=${value}`);
    }
  }
  return {
    unit,
    argv: [
      "systemd-run",
      "--user",
      `--unit=${unit}`,
      "--collect",
      "--quiet",
      `--property=WorkingDirectory=${p.cwd}`,
      `--property=StandardOutput=append:${path.join(p.dir, "run.log")}`,
      `--property=StandardError=append:${path.join(p.dir, "run.log")}`,
      ...setenv,
      ...inner,
    ],
  };
}

/**
 * Is the fan-out alive? `done` / `failed` once it wrote done.json; `running` while its unit is
 * active; `dead` when the unit is gone and it never wrote one (killed, crashed, the machine went
 * down); `unknown` for an id with no directory.
 */
export function readFanoutStatus(id, { root = fanoutRoot(), isActive = systemctlIsActive } = {}) {
  const dir = path.join(root, id);
  const unit = fanoutUnitName(id);
  const job = readJson(path.join(dir, "job.json"));
  if (!job) {
    return { id, unit, dir, state: "unknown" };
  }
  const done = readJson(path.join(dir, "done.json"));
  const active = isActive(unit);
  const base = {
    id,
    unit,
    dir,
    label: job.label ?? null,
    startedAt: job.startedAt ?? null,
    active,
    resultFile: path.join(dir, "result.json"),
  };
  if (done) {
    return {
      ...base,
      state: done.ok ? "done" : "failed",
      finishedAt: done.finishedAt ?? null,
      ...(done.error ? { error: done.error } : {}),
    };
  }
  if (active === "active" || active === "activating" || active === "reloading") {
    return { ...base, state: "running" };
  }
  return { ...base, state: "dead" };
}

/** Exit code of `--status`: 0 running or done, 1 failed, 3 dead, 2 unknown id. */
export function statusExitCode(state) {
  return { running: 0, done: 0, failed: 1, dead: 3 }[state] ?? 2;
}

export function buildFanoutWakeMessage({
  id,
  label,
  ok,
  startedAt,
  finishedAt,
  resultFile,
  error,
}) {
  const name = label || id;
  const minutes =
    typeof startedAt === "number" && typeof finishedAt === "number"
      ? Math.max(0, Math.round((finishedAt - startedAt) / 60_000))
      : null;
  const took = minutes === null ? "" : ` after ${minutes} min`;
  const head = ok
    ? `Fan-out “${name}” finished${took}.`
    : `Fan-out “${name}” failed${took}: ${String(error ?? "unknown error").slice(0, 300)}`;
  return `⟦AGENT:🧩 Fan-out⟧ ${head} Result: ${resultFile} (status: openclaw-orchestrate --status ${id})`;
}

/** One gateway request over a fresh connection: connect handshake, the method, close. */
export function gatewayCall({ WebSocket, url, token, origin, method, params, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { Origin: origin, Authorization: `Bearer ${token}` },
    });
    const pending = new Map();
    let n = 0;
    const timer = setTimeout(() => finish(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
    function finish(err, value) {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      if (err) {
        reject(err);
      } else {
        resolve(value);
      }
    }
    function send(m, p) {
      return new Promise((res, rej) => {
        const id = `fanout-${Date.now()}-${n++}`;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ type: "req", id, method: m, params: p }));
      });
    }
    ws.on("message", (buf) => {
      let frame;
      try {
        frame = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (frame.type === "event" && frame.event === "connect.challenge") {
        send("connect", {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: "webchat-ui",
            displayName: "openclaw-orchestrate",
            version: "0.1",
            platform: "cli",
            mode: "webchat",
          },
          role: "operator",
          scopes: ["operator.admin"],
          caps: [],
          auth: { token },
        })
          .then(() => send(method, params))
          .then((payload) => finish(null, payload))
          .catch((err) => finish(err instanceof Error ? err : new Error(JSON.stringify(err))));
        return;
      }
      if (frame.type === "res") {
        const p = pending.get(frame.id);
        if (p) {
          pending.delete(frame.id);
          if (frame.ok) {
            p.res(frame.payload);
          } else {
            p.rej(frame.error);
          }
        }
      }
    });
    ws.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
  });
}

/**
 * Wake the owning chat: chat.send, the lane every working wake uses. Retried, because the fan-out
 * may end while the gateway restarts; the idempotency key keeps a retry from waking twice.
 */
export async function deliverFanoutWake({
  call,
  sessionKey,
  message,
  idempotencyKey,
  wakeLog,
  attempts = 8,
  retryMs = 15_000,
}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await call("chat.send", { sessionKey, message, idempotencyKey });
      fs.appendFileSync(wakeLog, `${new Date().toISOString()} wake sent (attempt ${attempt})\n`);
      return true;
    } catch (err) {
      const why = err instanceof Error ? err.message : JSON.stringify(err);
      fs.appendFileSync(
        wakeLog,
        `${new Date().toISOString()} wake attempt ${attempt} failed: ${why}\n`,
      );
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, retryMs));
      }
    }
  }
  return false;
}
