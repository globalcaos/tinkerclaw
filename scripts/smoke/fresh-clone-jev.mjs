#!/usr/bin/env node
/**
 * FRESH-CLONE JEV SMOKE: what a clone with no Jev token gets, and that a token arms it with no restart.
 *
 * Usage:
 *   node scripts/smoke/fresh-clone-jev.mjs [--openclaw <path to openclaw.mjs>] [--scenario defaults|thalamus-only|all]
 *                                          [--steps 20] [--hook-latency N] [--port 18955] [--keep] [--json]
 *   --hook-latency N  also time the real PreToolUse hook process N times (defaults scenario, keyless)
 *
 * Exit 0 when every check holds, 1 when one fails, 2 when the gateway never came up (blocked, not failed).
 *
 * WHY: design principle 26 (bible `design-principles.md`): a capability that needs an outside service ships bundled and
 * dormant, and arms itself. This boots the BUILT dist under a throwaway HOME with no token and no plugin enabled by hand
 * (only the two plugin ids are allow-listed, which is how a fresh install would pick them from the bundled set), against
 * a mock Jev that counts every request, so nothing leaves the machine. Every check prints what it saw.
 *
 * SCENARIOS
 *   defaults       both plugins as shipped. Keyless: 0 Jev requests, 0 verdict rows, 0 error lines, 1 dormant line. Then
 *                  the key file is written mid-run: armed, with the same gateway process.
 *   thalamus-only  the amygdala disabled by hand. Same keyless checks; then the key file is written and the run says
 *                  whether Jev arms on its own with no amygdala (the amygdala registers the synthetic probe).
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : (argv[i + 1] ?? true);
};
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const openclaw = resolve(String(arg("openclaw", join(repoRoot, "openclaw.mjs"))));
const scenarioArg = String(arg("scenario", "all"));
const steps = Number(arg("steps", 20));
const basePort = Number(arg("port", 18955));
const hookRuns = Number(arg("hook-latency", 0));
const keep = argv.includes("--keep");
const asJson = argv.includes("--json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(openclaw)) {
  console.error(`BLOCKED: ${openclaw} does not exist (build first, or pass --openclaw)`);
  process.exit(2);
}

/** A Jev stand-in that counts every request and answers every question validly, so a token can arm. */
function startMockJev() {
  const hits = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ url: req.url, auth: req.headers.authorization ? "present" : "absent" });
      const answers = {};
      try {
        for (const [id, q] of Object.entries(JSON.parse(body).questions ?? {})) {
          if (q.type === "choice") {
            const keys = Object.keys(q.criteria ?? {});
            answers[id] = {
              choice: keys[0] ?? "",
              confidence: 0.9,
              probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 1 : 0])),
            };
          } else if (q.type === "score") {
            answers[id] = { score: 0, confidence: 0.9 };
          } else {
            answers[id] = { noul: 0.1, confidence: 0.9 };
          }
        }
      } catch {
        /* an unparsable body gets no answers */
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers, usage: { input_tokens: 10, output_tokens: 1 } }));
    });
  });
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () =>
      r({ hits, server, url: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}

function configFor(scenario, port, mockUrl) {
  const jev = { baseUrl: mockUrl };
  return {
    gateway: {
      mode: "local",
      port,
      bind: "loopback",
      auth: { mode: "token", token: "smoke-token" },
    },
    plugins: {
      allow: ["tinkerclaw-amygdala", "tinkerclaw-thalamus"],
      entries: {
        // No `enabled`, no `mode`: those are the shipped defaults under test. Only the endpoint is pointed at the mock.
        "tinkerclaw-amygdala":
          scenario === "thalamus-only" ? { enabled: false } : { config: { jev } },
        "tinkerclaw-thalamus": { config: { jev } },
      },
    },
  };
}

const quantile = (xs, q) => {
  const s = [...xs].toSorted((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
};

async function runScenario(scenario, port) {
  const root = mkdtempSync(join(tmpdir(), `jev-smoke-${scenario}-`));
  const home = join(root, "home");
  mkdirSync(join(home, ".openclaw"), { recursive: true });
  const mock = await startMockJev();
  writeFileSync(
    join(home, ".openclaw", "openclaw.json"),
    JSON.stringify(configFor(scenario, port, mock.url), null, 2),
  );
  const env = { ...process.env, HOME: home, OPENCLAW_HOME: home };
  delete env.TYPESAFE_API_KEY;
  delete env.OPENCLAW_GATEWAY_TOKEN;
  delete env.OPENCLAW_STATE_DIR;

  const logPath = join(root, "gateway.log");
  const fd = openSync(logPath, "w");
  const gw = spawn(
    "node",
    [
      openclaw,
      "gateway",
      "run",
      "--port",
      String(port),
      "--allow-unconfigured",
      "--auth",
      "token",
      "--token",
      "smoke-token",
    ],
    { env, stdio: ["ignore", fd, fd] },
  );
  const proc = { exited: false };
  gw.on("exit", () => {
    proc.exited = true;
  });
  const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
  const stop = async () => {
    if (!proc.exited) {
      gw.kill("SIGTERM");
      for (let i = 0; i < 40 && !proc.exited; i++) {
        await sleep(250);
      }
      if (!proc.exited) {
        gw.kill("SIGKILL");
      }
    }
    mock.server.close();
    if (!keep) {
      rmSync(root, { recursive: true, force: true });
    }
  };
  // Async on purpose: the mock Jev lives in this process, and a blocking spawn would stop it answering the gateway.
  const call = (method) =>
    new Promise((resolveCall) => {
      execFile(
        "node",
        [
          openclaw,
          "gateway",
          "call",
          method,
          "--url",
          `ws://127.0.0.1:${port}`,
          "--token",
          "smoke-token",
          "--json",
          "--timeout",
          "20000",
        ],
        { env, encoding: "utf8", timeout: 40_000 },
        (_err, stdout, stderr) => {
          const text = (stdout || "").trim();
          try {
            resolveCall(JSON.parse(text.slice(text.indexOf("{"))));
          } catch {
            resolveCall({ _raw: (text || stderr || "").slice(0, 300) });
          }
        },
      );
    });

  const out = { scenario, checks: [], root: keep ? root : undefined };
  const check = (name, ok, saw) => out.checks.push({ name, ok: Boolean(ok), saw });

  // Ready: the gateway answers jev.status (the shared source exists in every scenario).
  const t0 = Date.now();
  let status;
  for (let i = 0; i < 60 && !proc.exited; i++) {
    status = await call("jev.status");
    if (status?.state) {
      break;
    }
    await sleep(2000);
  }
  if (!status?.state) {
    const tail = log().split("\n").slice(-25).join("\n");
    await stop();
    return {
      scenario,
      blocked: `gateway never answered jev.status (exited=${proc.exited})\n${tail}`,
    };
  }
  out.bootMs = Date.now() - t0;
  await sleep(3000); // both plugins finish their start

  // Keyless: drive pre-tool steps through the amygdala's real route when it is loaded.
  const epPath = join(home, ".openclaw", "data", "amygdala-jev", "endpoint.json");
  let latencies = [];
  if (scenario === "defaults") {
    let ep;
    for (let i = 0; i < 20 && !ep; i++) {
      try {
        ep = JSON.parse(readFileSync(epPath, "utf8"));
      } catch {
        await sleep(500);
      }
    }
    check(
      "the amygdala loads with no config switch (enabledByDefault)",
      ep,
      ep ? `endpoint on port ${ep.port}` : "no endpoint.json",
    );
    if (ep) {
      const decide = (i) => {
        const t = Date.now();
        return fetch(`http://127.0.0.1:${ep.port}/plugins/amygdala2/decide`, {
          method: "POST",
          headers: { authorization: `Bearer ${ep.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            seam: "pre-tool",
            tabKey: "agent:main:tinker:fresh-clone-smoke",
            hook: {
              session_id: "fresh-clone-smoke",
              tool_name: "Write",
              tool_use_id: `toolu_${i}`,
              tool_input: { file_path: `/tmp/jev-smoke-${i}.txt`, content: `step ${i}` },
              cwd: "/tmp",
            },
          }),
        })
          .then((r) => ({ ok: r.ok, ms: Date.now() - t }))
          .catch(() => ({ ok: false, ms: Date.now() - t }));
      };
      let accepted = 0;
      for (let i = 0; i < steps; i++) {
        const r = await decide(i);
        if (r.ok) {
          accepted += 1;
        }
        latencies.push(r.ms);
      }
      check(
        `${steps} pre-tool steps answered`,
        accepted === steps,
        `${accepted}/${steps} accepted`,
      );
      out.keylessStepMs = {
        median: quantile(latencies, 0.5),
        p95: quantile(latencies, 0.95),
        n: latencies.length,
      };
    }
  }
  if (scenario === "defaults" && hookRuns > 0) {
    const hookPath = join(
      dirname(openclaw),
      "dist",
      "extensions",
      "tinkerclaw-amygdala",
      "hooks",
      "pre-tool.mjs",
    );
    if (!existsSync(hookPath)) {
      check("the PreToolUse hook script is in the build", false, hookPath);
    } else {
      const payload = JSON.stringify({
        session_id: "fresh-clone-smoke",
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "/tmp/jev-smoke-hook.txt", content: "x" },
        cwd: "/tmp",
      });
      const time = (cmd, args, extraEnv) => {
        const t = performance.now();
        const r = spawnSync(cmd, args, {
          env: { ...env, ...extraEnv },
          input: payload,
          encoding: "utf8",
          timeout: 20_000,
        });
        return {
          ms: performance.now() - t,
          code: r.status,
          out: (r.stdout || "").length,
        };
      };
      const dataDir = join(home, ".openclaw", "data", "amygdala-jev");
      const hookEnv = { AMYGDALA2_DATA_DIR: dataDir };
      time("node", [hookPath], hookEnv); // first run warms the disk cache
      const runs = [];
      const base = [];
      for (let i = 0; i < hookRuns; i++) {
        runs.push(time("node", [hookPath], hookEnv));
        base.push(time("node", ["-e", "0"], {}));
      }
      const ms = runs.map((r) => r.ms);
      const bms = base.map((r) => r.ms);
      out.keylessHookMs = {
        median: Math.round(quantile(ms, 0.5)),
        p95: Math.round(quantile(ms, 0.95)),
        n: ms.length,
        bareNodeMedian: Math.round(quantile(bms, 0.5)),
        exitCodes: [...new Set(runs.map((r) => r.code))],
        stdoutBytes: [...new Set(runs.map((r) => r.out))],
      };
      check(
        "the PreToolUse hook exits 0 and prints nothing while keyless",
        runs.every((r) => r.code === 0 && r.out === 0),
        `exit ${out.keylessHookMs.exitCodes.join(",")}, stdout bytes ${out.keylessHookMs.stdoutBytes.join(",")}`,
      );
    }
  }
  await sleep(1500);

  const textNow = log();
  const jevLines = textNow.split("\n").filter((l) => /\[jev\]/.test(l));
  const bad = textNow
    .split("\n")
    .filter(
      (l) =>
        /jev|judge|amygdala|thalamus/i.test(l) &&
        /error|ECONN|unavailable|judge-down|failed/i.test(l),
    );
  check("no Jev request while keyless", mock.hits.length === 0, `${mock.hits.length} requests`);
  check(
    "exactly one dormant line at start",
    jevLines.filter((l) => /\[jev\] dormant/.test(l)).length === 1,
    jevLines.join(" | ").slice(0, 400),
  );
  check(
    "no error line about Jev, the judge or either plugin",
    bad.length === 0,
    bad.slice(0, 3).join(" | ") || "none",
  );
  const st0 = await call("jev.status");
  check(
    "jev.status says dormant, no token",
    st0.state === "dormant" && st0.on === false,
    `state=${st0.state} on=${st0.on} line="${st0.line}"`,
  );
  if (scenario === "defaults") {
    const rows = await verdictRows(home);
    check("0 verdict rows while keyless", rows === 0, `${rows} rows`);
  }
  // `thalamus.status` needs a paired operator scope a fresh HOME does not have, so the start line is the evidence.
  const started = log()
    .split("\n")
    .filter((l) => /\[thalamus\] started \(mode=/.test(l));
  check(
    "Thalamus loads by default, in shadow",
    started.length === 1 && /mode=shadow/.test(started[0]),
    started[0]?.slice(-150) ?? "no start line",
  );

  // Arm with no restart: write the key file, same process.
  const pidBefore = gw.pid;
  mkdirSync(join(home, ".openclaw", "jev"), { recursive: true });
  writeFileSync(join(home, ".openclaw", "jev", "token"), "mock-key\n", { mode: 0o600 });
  let armed = false;
  let st1 = {};
  for (let i = 0; i < 12 && !armed; i++) {
    await sleep(5000);
    st1 = await call("jev.status");
    armed = st1.state === "armed";
  }
  out.armedAfterKeyFile = armed;
  out.stateAfterKeyFile = st1.state;
  const after = log();
  check(
    "the key file is noticed with no restart",
    /\[jev\] token found \(file\)/.test(after) && !proc.exited && gw.pid === pidBefore,
    `state=${st1.state}`,
  );
  if (scenario === "defaults") {
    check(
      "it arms: Jev answered the one synthetic probe",
      armed && mock.hits.length >= 1,
      `state=${st1.state} requests=${mock.hits.length}`,
    );
  } else {
    // The question this scenario exists to answer. Reported either way; it fails the run only if it stays half-armed.
    check(
      "with no amygdala, a token still arms Jev by itself",
      armed,
      `state=${st1.state} requests=${mock.hits.length} line="${st1.line}"`,
    );
  }
  out.jevLogLines = after
    .split("\n")
    .filter((l) => /\[jev\]/.test(l))
    .slice(0, 12);
  await stop();
  return out;
}

async function verdictRows(home) {
  const db = join(home, ".openclaw", "data", "amygdala-jev", "amygdala.sqlite");
  if (!existsSync(db)) {
    return 0;
  }
  const { DatabaseSync } = await import("node:sqlite");
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return d.prepare("SELECT COUNT(*) n FROM verdicts").get().n;
  } finally {
    d.close();
  }
}

const scenarios = scenarioArg === "all" ? ["defaults", "thalamus-only"] : [scenarioArg];
const results = [];
for (const [i, s] of scenarios.entries()) {
  results.push(await runScenario(s, basePort + i));
}

let failed = 0;
let blocked = 0;
for (const r of results) {
  if (r.blocked) {
    blocked += 1;
    console.error(`BLOCKED (${r.scenario}): ${r.blocked}`);
    continue;
  }
  if (!asJson) {
    console.log(
      `\n== ${r.scenario} (boot ${r.bootMs} ms${r.keylessStepMs ? `, keyless step median ${r.keylessStepMs.median} ms, p95 ${r.keylessStepMs.p95} ms over ${r.keylessStepMs.n}` : ""})`,
    );
  }
  if (!asJson && r.keylessHookMs) {
    const h = r.keylessHookMs;
    console.log(
      `   PreToolUse hook process: median ${h.median} ms, p95 ${h.p95} ms over ${h.n} runs (a bare node start: ${h.bareNodeMedian} ms)`,
    );
  }
  for (const c of r.checks) {
    if (!c.ok) {
      failed += 1;
    }
    if (!asJson) {
      console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  [saw: ${c.saw}]`);
    }
  }
}
if (asJson) {
  console.log(JSON.stringify(results, null, 2));
}
process.exit(blocked ? 2 : failed ? 1 : 0);
