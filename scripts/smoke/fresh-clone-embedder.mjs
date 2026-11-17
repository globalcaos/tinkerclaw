#!/usr/bin/env node
/**
 * FRESH-CLONE EMBEDDER SMOKE: memory search on a fresh clone with no embedder, and with an embedder
 * that stops answering.
 *
 * Usage:
 *   node scripts/smoke/fresh-clone-embedder.mjs [--openclaw <path to openclaw.mjs>]
 *       [--scenario no-ollama|slow-ollama|all] [--window 60] [--idle-wait 240] [--keep] [--json]
 *   --window N     seconds to watch the breaker once it has opened (slow-ollama)
 *   --idle-wait N  seconds to wait for idle CPU before the indexing starts (slow-ollama)
 *
 * Exit 0 when every check holds, 1 when one fails, 2 when a scenario could not run (blocked, not
 * failed): the gateway never came up, or the host stayed too busy for background embedding. A
 * failed check outranks a blocked scenario.
 *
 * WHY: TINKER_UI_DESIGN_BIBLE/embedder-fit.md. With no embedder, a fresh clone searches memory by
 * its words, makes no embedding request and says so in one line (design principle 26). An
 * embedder that stops answering gets one request at a time, is cut off by the breaker after F
 * failures and probed at most once per cool-down, and word search answers meanwhile. This boots
 * the BUILT dist under a throwaway HOME and state dir, on random ports, against a mock Ollama in
 * this process that records every request, so nothing reaches a real embedder. Every check prints
 * what it saw.
 *
 * SCENARIOS
 *   no-ollama    models.providers.ollama.baseUrl points at a closed port, and the workspace holds
 *                one memory file. setup.sh step 4d runs first, as it does without a terminal
 *                (`embedder fit --installer`, no download). Then the gateway: one 'memory search:
 *                word index only' info line (its start check, scheduleEmbedderFitCheck),
 *                fork.memory.search finds the file by a word in it, and 0 embedding requests.
 *   slow-ollama  a mock Ollama lists granite-embedding:30m and answers /api/embed one request at a
 *                time, with Ollama's own timings. `embedder fit --background` must choose that
 *                model. The record is then armed (dormantUntilDemand false), the mock stops
 *                answering embeddings, and a search starts the indexing. Then: at most one
 *                request in flight, the breaker opens after F failures and probes at most once
 *                per cool-down, the gateway aborts every hung request, and fork.memory.search
 *                keeps finding the file by its words.
 */
import { execFile, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
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
const windowMs = Number(arg("window", 60)) * 1000;
const idleWaitMs = Number(arg("idle-wait", 240)) * 1000;
const keep = argv.includes("--keep");
const asJson = argv.includes("--json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(openclaw)) {
  console.error(`BLOCKED: ${openclaw} does not exist (build first, or pass --openclaw)`);
  process.exit(2);
}

const TOKEN = "smoke-token";
const MODEL = "granite-embedding:30m";
/** The gateway-start line of an install whose memory search runs on words only (#26b). */
const WORD_INDEX_LINE = "memory search: word index only";
/** A made-up word that appears in exactly one memory file, so a hit on it names that file. */
const PROBE_WORD = "quillfeather";
/**
 * The bounds of the breaker threshold F: BREAKER_MIN_FAILURES and BREAKER_MAX_FAILURES in
 * src/fork/embedder-fit.ts, declared twins. The governor derives F between them.
 */
const F_MIN = 2;
const F_MAX = 5;
/** The fit's 5-minute ceiling (FIT_CEILING_MS, which also bounds its idle waits) plus CLI start-up. */
const FIT_TIMEOUT_MS = 8 * 60_000;
/**
 * The mock Ollama's service model: 250 ms per request plus 4,000 tokens/s, 400 ms more when the
 * model is cold, and a 20 ms slot handoff for a request that queued behind another. One slot, so
 * requests are served one at a time. Objective: the fit takes about 15 s; the request deadline the
 * gateway derives from it stays near 300 ms, far above loopback latency, so every governed request
 * reaches the mock before it is aborted; and the handoff keeps the fit's two-in-flight probe from
 * reading a gain a one-slot server cannot give (a queued request's body arrives while the one
 * ahead is served, which makes a pair look a few ms faster than two singles). A fixture, not a
 * model of any host.
 */
const MOCK = { overheadMs: 250, tokensPerSec: 4000, coldMs: 400, handoffMs: 20, dims: 384 };

// ---- Memory files -------------------------------------------------------------------------------

/** Neutral filler. Every section holds all of these, rotated, so the sections share their words. */
const FILLER = [
  "The morning delivery arrived before the shop opened and the boxes went by the side door.",
  "A light rain started after lunch, so the outdoor tables were moved under the awning.",
  "Three overdue books came back to the library and two new atlases went to the reading room.",
  "A bicycle pump was left at the entrance and now waits on the shelf behind the counter.",
  "The bus timetable changed this week, and the last service now leaves ten minutes earlier.",
  "Tomato seedlings went into the raised bed and were watered twice before sunset.",
  "The kettle in the break room was descaled and its filter was replaced with a spare.",
  "The garden gate sticks when the weather turns damp, so its hinges need oil before winter.",
];
const PROBE_SENTENCE = `The spare key for the shed is kept in the ${PROBE_WORD} tin on the top shelf.`;

function paragraph(i, withProbe) {
  const k = i % FILLER.length;
  const text = [...FILLER.slice(k), ...FILLER.slice(0, k)].join(" ");
  return withProbe ? `${text} ${PROBE_SENTENCE}` : text;
}

/**
 * no-ollama's one memory file: ten sections, about nine index chunks, the probe word in one
 * section. Not a short note: on an index of one or two chunks every term gets FTS5's floor IDF
 * (1e-6), so no keyword hit reaches the default minScore of 0.35, and that tiny-corpus limit is
 * not what this scenario tests.
 */
function writeFieldNotes(workspace) {
  const sections = [];
  for (let i = 1; i <= 10; i++) {
    sections.push(`## Section ${i}\n\n${paragraph(i, i === 5)}`);
  }
  writeFileSync(
    join(workspace, "memory", "field-notes.md"),
    `# Field notes\n\n${sections.join("\n\n")}\n`,
  );
}

/** slow-ollama's notes: eight one-chunk files, more than F_MAX, so one sync can open the breaker. */
function writeNotes(workspace) {
  for (let i = 1; i <= 8; i++) {
    writeFileSync(
      join(workspace, "memory", `note-${i}.md`),
      `# Note ${i}\n\n${paragraph(i, i === 3)}\n`,
    );
  }
}

// ---- The throwaway install ----------------------------------------------------------------------

/**
 * A throwaway HOME and state dir. This shell's provider keys, embedder address and state redirects
 * are dropped, so the install sees what a fresh clone sees.
 */
function makeBox(scenario) {
  const root = mkdtempSync(join(os.tmpdir(), `embedder-smoke-${scenario}-`));
  const home = join(root, "home");
  const stateDir = join(home, ".openclaw");
  const workspace = join(stateDir, "workspace");
  mkdirSync(join(workspace, "memory"), { recursive: true });
  const env = { ...process.env, HOME: home, OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: stateDir };
  for (const key of Object.keys(env)) {
    if (key.endsWith("_API_KEY") || key.startsWith("OLLAMA_")) {
      delete env[key];
    }
  }
  for (const key of [
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_OAUTH_DIR",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_NIX_MODE",
    "PREFRONTAL_SEMANTIC_MATCH_ENABLED",
    "VITEST",
  ]) {
    delete env[key];
  }
  // Under a test runner the governor and the fit record sandbox themselves: no files, no load.
  if (env.NODE_ENV === "test") {
    delete env.NODE_ENV;
  }
  return { root, stateDir, workspace, env, logPath: join(root, "gateway.log") };
}

function writeConfig(box, port, ollamaBaseUrl) {
  const config = {
    gateway: { mode: "local", port, bind: "loopback", auth: { mode: "token", token: TOKEN } },
    agents: { defaults: { workspace: box.workspace } },
    // The only embedder memory search can reach: a closed port, or the mock in this process.
    models: { providers: { ollama: { baseUrl: ollamaBaseUrl, models: [] } } },
    // JSON console lines carry each line's level and time, which the checks read. The file log
    // stays in the throwaway root instead of the host's shared log directory.
    logging: { consoleStyle: "json", file: join(box.root, "openclaw-file.log") },
    // memory-core holds a fresh clone's memory slot. The other bundled plugins embed, if at all,
    // only during agent turns (embedder-fit.md, Consumer routing), and loading them would only
    // slow the boot: the same narrowing as fresh-clone-jev.mjs.
    plugins: { allow: ["memory-core"] },
  };
  writeFileSync(join(box.stateDir, "openclaw.json"), `${JSON.stringify(config, null, 2)}\n`);
}

const memoryDir = (box) => join(box.stateDir, "memory");

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const readRecord = (box) => readJson(join(memoryDir(box), "embedder-fit.json"));
const readGovernors = (box) =>
  readJson(join(memoryDir(box), "embedder-governor.json"))?.governors ?? {};

/** tmp file and rename, mode 0600, as the fit writes its record: a reader never sees half of it. */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.smoke-${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** One counter summed over a governor snapshot's day buckets. */
const daySum = (governor, key) =>
  (Array.isArray(governor?.days) ? governor.days : []).reduce(
    (n, day) => n + (Number(day?.[key]) || 0),
    0,
  );

/** Chunk rows by model key in each index database of the state dir ('fts-only' = words, no vector). */
async function chunkModels(box) {
  const byModel = {};
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (err) {
    return { byModel, error: `node:sqlite is unavailable (${String(err)})` };
  }
  const dir = memoryDir(box);
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    if (!name.endsWith(".sqlite")) {
      continue;
    }
    let db;
    try {
      db = new DatabaseSync(join(dir, name), { readOnly: true });
      for (const row of db
        .prepare("SELECT model, COUNT(*) AS n FROM chunks GROUP BY model")
        .all()) {
        byModel[row.model] = (byModel[row.model] ?? 0) + Number(row.n);
      }
    } catch {
      // not a memory index, or one still being created
    } finally {
      db?.close();
    }
  }
  return { byModel };
}

// ---- The mock Ollama ----------------------------------------------------------------------------

/** Words longer than 3 letters, hashed into 384 dimensions: texts that share content words point the same way. */
function vectorOf(text) {
  const vector = Array.from({ length: MOCK.dims }, () => 0);
  for (const word of String(text)
    .toLowerCase()
    .match(/[a-z]+/g) ?? []) {
    if (word.length <= 3) {
      continue;
    }
    let h = 0;
    for (const ch of word) {
      h = (h * 31 + ch.charCodeAt(0)) % MOCK.dims;
    }
    vector[h] += 1;
  }
  return vector;
}

/**
 * A mock Ollama with one slot. It answers /api/version, /api/tags and /api/ps, and /api/embed one
 * request at a time with prompt_eval_count, total_duration and load_duration, until hang() makes
 * every embedding request wait for ever while the rest still answers, as a stuck runner does.
 * Every embedding request is recorded: when it arrived, how many were open with it, whether it was
 * answered, and when its socket closed.
 */
function startMockOllama(models) {
  const installed = new Map(models.map((name, i) => [name, `sha256:smoke${i}`]));
  const loaded = new Set();
  const state = { hanging: false, embeds: [], other: [], open: new Set(), maxConcurrent: 0 };
  let queue = Promise.resolve();
  let pending = 0;

  const sendJson = (res, status, body) => {
    if (res.destroyed || res.writableEnded) {
      return;
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const serveEmbed = async (rec, body, res, queued) => {
    if (queued) {
      await sleep(MOCK.handoffMs);
    }
    if (res.destroyed) {
      return; // the client left while it waited
    }
    const model = String(body.model ?? "");
    const input = Array.isArray(body.input) ? body.input.map(String) : [];
    const tokens = input.reduce((n, text) => n + Math.max(1, Math.ceil(text.length / 4)), 0);
    const coldMs = loaded.has(model) ? 0 : MOCK.coldMs;
    const serviceMs = MOCK.overheadMs + (tokens / MOCK.tokensPerSec) * 1000;
    loaded.add(model);
    await sleep(coldMs + serviceMs);
    if (String(body.keep_alive) === "0") {
      loaded.delete(model);
    }
    rec.answered = true;
    sendJson(res, 200, {
      model,
      embeddings: input.map(vectorOf),
      prompt_eval_count: tokens,
      total_duration: Math.round((coldMs + serviceMs) * 1e6),
      load_duration: Math.round(coldMs * 1e6),
    });
  };

  const server = createServer((req, res) => {
    const arrivedAt = Date.now();
    const route = String(req.url ?? "").split("?")[0];
    const isEmbed =
      req.method === "POST" && (route === "/api/embed" || route === "/api/embeddings");
    let rec;
    if (isEmbed) {
      rec = {
        arrivedAt,
        route,
        answered: false,
        aborted: false,
        closedAt: undefined,
        concurrent: 1,
      };
      state.embeds.push(rec);
      state.open.add(rec);
      res.on("close", () => {
        rec.closedAt = Date.now();
        rec.aborted = !rec.answered;
        state.open.delete(rec);
      });
      // In flight as the server sees it: the requests still open once the event-loop turn this
      // one arrived in has run its close callbacks. A socket closed and a new request read in the
      // same turn are ordering, not overlap. libuv runs close callbacks after the check phase,
      // hence two setImmediate hops.
      setImmediate(() =>
        setImmediate(() => {
          rec.concurrent = 1 + [...state.open].filter((r) => r !== rec).length;
          state.maxConcurrent = Math.max(state.maxConcurrent, rec.concurrent);
        }),
      );
    } else {
      state.other.push({ arrivedAt, method: req.method, route });
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        body = {};
      }
      if (isEmbed) {
        if (state.hanging) {
          return; // a stuck runner: no answer, and the socket stays open until the client leaves
        }
        const model = String(body.model ?? "");
        if (route !== "/api/embed" || !installed.has(model)) {
          sendJson(res, 404, { error: `model "${model}" not found, try pulling it first` });
          return;
        }
        const queued = pending > 0;
        pending += 1;
        queue = queue
          .then(() => serveEmbed(rec, body, res, queued))
          .catch(() => undefined)
          .finally(() => {
            pending -= 1;
          });
        return;
      }
      if (req.method === "GET" && route === "/api/version") {
        sendJson(res, 200, { version: "0.0.0-smoke" });
      } else if (req.method === "GET" && route === "/api/tags") {
        sendJson(res, 200, {
          models: [...installed].map(([name, digest]) => ({
            name,
            model: name,
            digest,
            size: 62e6,
          })),
        });
      } else if (req.method === "GET" && route === "/api/ps") {
        sendJson(res, 200, {
          models: [...loaded].map((name) => ({
            name,
            model: name,
            size: 100 * 2 ** 20,
            size_vram: 0,
          })),
        });
      } else {
        sendJson(res, 404, { error: "not found" });
      }
    });
  });

  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      done({
        url: `http://127.0.0.1:${server.address().port}`,
        hang: () => {
          state.hanging = true;
        },
        reset: () => {
          state.embeds = [];
          state.other = [];
          state.maxConcurrent = 0;
        },
        stats: () => state,
        openEmbeds: () => state.open.size,
        close: () =>
          new Promise((closed) => {
            server.closeAllConnections();
            server.close(() => closed());
          }),
      });
    });
  });
}

// ---- Processes ----------------------------------------------------------------------------------

/** A port nothing listens on: this process binds it for a moment, then lets it go. */
function unusedPort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

/** One `openclaw` CLI run. Async on purpose: the mock lives in this process and must keep answering. */
function runCli(env, args, timeoutMs) {
  return new Promise((done) => {
    const started = Date.now();
    execFile(
      "node",
      [openclaw, ...args],
      { env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 2 ** 20 },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          code = err.killed
            ? "timeout"
            : typeof err.code === "number"
              ? err.code
              : String(err.signal ?? "error");
        }
        done({ code, ms: Date.now() - started, out: `${stdout ?? ""}${stderr ?? ""}` });
      },
    );
  });
}

function call(env, port, method, params = {}) {
  return new Promise((done) => {
    const started = Date.now();
    execFile(
      "node",
      [
        openclaw,
        "gateway",
        "call",
        method,
        "--params",
        JSON.stringify(params),
        "--url",
        `ws://127.0.0.1:${port}`,
        "--token",
        TOKEN,
        "--json",
        "--timeout",
        "20000",
      ],
      { env, encoding: "utf8", timeout: 40_000 },
      (_err, stdout, stderr) => {
        const text = (stdout || "").trim();
        let body;
        try {
          body = JSON.parse(text.slice(text.indexOf("{")));
        } catch {
          body = { _raw: (text || stderr || "").slice(0, 300) };
        }
        done({ body, ms: Date.now() - started });
      },
    );
  });
}

const isAnswer = (body) => Boolean(body) && typeof body === "object" && !("_raw" in body);

/** fork.memory.search for the probe word as a real RPC caller: counted as demand, and it may start a sync. */
async function search(box, port, file) {
  const startedAt = Date.now();
  const { body, ms } = await call(box.env, port, "fork.memory.search", {
    query: PROBE_WORD,
    caller: "rpc",
  });
  const results = Array.isArray(body?.results) ? body.results : [];
  return {
    startedAt,
    ms,
    ok: body?.ok === true,
    n: results.length,
    found: results.some((r) => typeof r?.path === "string" && r.path.endsWith(file)),
    error: body?._raw,
  };
}

/** `gateway run` on the throwaway HOME, ready once `health` answers; its console goes to box.logPath. */
async function startGateway(box, port) {
  const fd = openSync(box.logPath, "w");
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
      TOKEN,
    ],
    { env: box.env, stdio: ["ignore", fd, fd] },
  );
  closeSync(fd);
  const proc = { exited: false };
  gw.on("exit", () => {
    proc.exited = true;
  });
  const log = () => (existsSync(box.logPath) ? readFileSync(box.logPath, "utf8") : "");
  const handle = {
    ready: false,
    bootMs: 0,
    log,
    exited: () => proc.exited,
    tail: () => log().split("\n").slice(-25).join("\n"),
    stop: async () => {
      if (proc.exited) {
        return;
      }
      gw.kill("SIGTERM");
      for (let i = 0; i < 40 && !proc.exited; i++) {
        await sleep(250);
      }
      if (!proc.exited) {
        gw.kill("SIGKILL");
      }
    },
  };
  const started = Date.now();
  for (let i = 0; i < 90 && !proc.exited && !handle.ready; i++) {
    handle.ready = isAnswer((await call(box.env, port, "health")).body);
    if (!handle.ready) {
      await sleep(2000);
    }
  }
  handle.bootMs = Date.now() - started;
  return handle;
}

// ---- Reading the gateway ------------------------------------------------------------------------

/** The gateway's console: JSON lines from its loggers (time, level, message), plain lines from console.* calls. */
function parseLog(text) {
  const entries = [];
  const plain = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    if (line.startsWith("{")) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.message === "string") {
          entry = {
            time: Date.parse(String(parsed.time ?? "")),
            level: String(parsed.level ?? ""),
            message: parsed.message,
          };
        }
      } catch {
        // a plain line that happens to start with a brace
      }
    }
    if (entry) {
      entries.push(entry);
    } else {
      plain.push(line);
    }
  }
  return { entries, plain };
}

/**
 * The governor's breaker transitions for one endpoint, in log order. Their wording is the
 * governor's (src/fork/embedder-governor.ts, noteFailure and enterBreaker): an open line says how
 * many failures tripped it, or that the probe failed, and the cool-down in seconds.
 */
function breakerTransitions(entries, endpoint) {
  const out = [];
  for (const e of entries) {
    const m = e.message;
    if (!m.startsWith("embedder breaker ") || !m.includes(`(${endpoint})`)) {
      continue;
    }
    if (m.startsWith("embedder breaker half-open")) {
      out.push({ kind: "half-open", time: e.time });
    } else if (m.startsWith("embedder breaker closed")) {
      out.push({ kind: "closed", time: e.time });
    } else if (m.startsWith("embedder breaker open")) {
      const failures = /: (\d+) consecutive failures/.exec(m);
      const cool = /(?:fail fast for|next probe in) ([\d.]+) s\b/.exec(m);
      out.push({
        kind: failures ? "open" : "reopen",
        time: e.time,
        failures: failures ? Number(failures[1]) : undefined,
        coolS: cool ? Number(cool[1]) : Number.NaN,
      });
    }
  }
  return out;
}

/** Half a unit of the last digit the governor's fmt() prints a number of seconds with, in ms. */
function printedRoundingMs(seconds) {
  const abs = Math.abs(seconds);
  if (abs >= 100) {
    return 500;
  }
  if (abs >= 1) {
    return 50;
  }
  return abs > 0 ? 0.5 * 10 ** (Math.floor(Math.log10(abs)) - 1) * 1000 : 0;
}

/** Logical cores, counted as the governor counts them. */
const cores = () =>
  os.cpus().length ||
  (typeof os.availableParallelism === "function" ? os.availableParallelism() : 1);

/**
 * Waits until the governor's idle gate would open for a first background call: idleGateOpen in
 * src/fork/embedder-fit.ts with no duty of its own yet (u = 0), so load1 + s <= logical cores, s
 * being the embedder cores the fit measured (1 when it measured none). A declared twin.
 */
async function waitForIdleGate(embedCores, maxMs) {
  const s = Number.isFinite(embedCores) ? Math.max(0, embedCores) : 1;
  const n = cores();
  const started = Date.now();
  let load1 = os.loadavg()[0] ?? 0;
  while (load1 + s > n && Date.now() - started < maxMs) {
    await sleep(5000);
    load1 = os.loadavg()[0] ?? 0;
  }
  return { open: load1 + s <= n, load1, s, cores: n, waitedMs: Date.now() - started };
}

function median(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length > 0 ? Math.round(sorted[Math.floor((sorted.length - 1) / 2)]) : undefined;
}

const lastLines = (text, n = 3) =>
  text.trim().split("\n").filter(Boolean).slice(-n).join(" | ").slice(0, 400);

/** The fit's own one-line result, `memory search: ...`. */
const summaryLine = (text) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("memory search: "))
    .at(-1) ?? lastLines(text, 1);

// ---- Scenarios ----------------------------------------------------------------------------------

async function runNoOllama() {
  const box = makeBox("no-ollama");
  const out = { scenario: "no-ollama", checks: [], root: keep ? box.root : undefined };
  const check = (name, ok, saw) => out.checks.push({ name, ok: Boolean(ok), saw });
  let gw;
  try {
    writeFieldNotes(box.workspace);
    const closed = await unusedPort();
    const port = await unusedPort();
    writeConfig(box, port, `http://127.0.0.1:${closed}`);

    // setup.sh step 4d with no terminal: the question defaults to no, so the fit runs without --pull.
    const fit = await runCli(box.env, ["embedder", "fit", "--installer"], 3 * 60_000);
    const rec = readRecord(box);
    check(
      "setup.sh's fit finds no embedder and records word search",
      fit.code === 0 &&
        rec?.decision?.mode === "off" &&
        rec?.inventory?.ollama?.reachable === false,
      `exit ${fit.code} in ${fit.ms} ms, "${summaryLine(fit.out)}"; record mode=${rec?.decision?.mode} reachable=${rec?.inventory?.ollama?.reachable}`,
    );

    gw = await startGateway(box, port);
    if (!gw.ready) {
      out.blocked = `gateway never answered health (exited=${gw.exited()})\n${gw.tail()}`;
      return out;
    }
    out.bootMs = gw.bootMs;

    // The first search opens the index and starts its sync; a later one finds the words.
    const searches = [];
    for (let i = 0; i < 30 && !searches.some((s) => s.found); i++) {
      if (i > 0) {
        await sleep(2000);
      }
      searches.push(await search(box, port, "field-notes.md"));
    }
    const hit = searches.find((s) => s.found);
    const last = searches.at(-1);
    check(
      "fork.memory.search finds the file by a word in it (word index, no embedder)",
      hit,
      hit
        ? `search ${searches.indexOf(hit) + 1}: ${hit.n} result(s)`
        : `${searches.length} searches, the last ok=${last?.ok} with ${last?.n} result(s)${last?.error ? `: ${last.error}` : ""}`,
    );

    await sleep(2000);
    const { entries, plain } = parseLog(gw.log());
    const said = [
      ...entries
        .filter((e) => e.message.includes(WORD_INDEX_LINE))
        .map((e) => `${e.level}: ${e.message}`),
      ...plain.filter((line) => line.includes(WORD_INDEX_LINE)),
    ];
    const atInfo =
      entries.filter((e) => e.level === "info" && e.message.includes(WORD_INDEX_LINE)).length +
      plain.filter((line) => line.includes(WORD_INDEX_LINE)).length;
    check(
      `exactly one '${WORD_INDEX_LINE}' info line`,
      said.length === 1 && atInfo === 1,
      said.join(" | ").slice(0, 300) || `none in ${entries.length + plain.length} log lines`,
    );

    // A closed port records nothing, so the evidence is what a request leaves behind: the governor
    // counts every call it sends, and a vector is a chunk row under the model's key.
    const governors = readGovernors(box);
    const calls = Object.values(governors).reduce((n, g) => n + daySum(g, "calls"), 0);
    const index = await chunkModels(box);
    const words = index.byModel["fts-only"] ?? 0;
    const embedded = Object.entries(index.byModel).reduce(
      (n, [model, count]) => (model === "fts-only" ? n : n + count),
      0,
    );
    check(
      "0 embedding requests: no governed call, and the index holds word rows only",
      calls === 0 && embedded === 0 && words > 0,
      `governor calls ${calls} over ${Object.keys(governors).length} endpoint(s); index chunks by model ${JSON.stringify(index.byModel)}${index.error ? `; ${index.error}` : ""}`,
    );
    const bad = [
      ...entries
        .filter((e) => /^(warn|error|fatal)$/.test(e.level) && /embedd|breaker/i.test(e.message))
        .map((e) => `${e.level}: ${e.message}`),
      ...plain.filter(
        (line) =>
          /embedd|breaker/i.test(line) &&
          /error|fail|ECONN|unavailable|cannot|unreadable/i.test(line),
      ),
    ];
    check(
      "no warn or error line about embedding",
      bad.length === 0,
      bad.slice(0, 3).join(" | ").slice(0, 400) || "none",
    );
    return out;
  } finally {
    await gw?.stop();
    if (!keep) {
      rmSync(box.root, { recursive: true, force: true });
    }
  }
}

async function runSlowOllama() {
  const box = makeBox("slow-ollama");
  const out = { scenario: "slow-ollama", checks: [], root: keep ? box.root : undefined };
  const check = (name, ok, saw) => out.checks.push({ name, ok: Boolean(ok), saw });
  const mock = await startMockOllama([MODEL]);
  const endpoint = `ollama|${mock.url}`;
  const target = "note-3.md";
  let gw;
  try {
    writeNotes(box.workspace);
    const port = await unusedPort();
    writeConfig(box, port, mock.url);

    // 1. The fit the gateway starts on a new machine: lowest priority, idle CPU only, no download.
    const fit = await runCli(box.env, ["embedder", "fit", "--background"], FIT_TIMEOUT_MS);
    const fitStats = mock.stats();
    out.fit = {
      exit: fit.code,
      ms: fit.ms,
      embedRequests: fitStats.embeds.length,
      maxInFlight: fitStats.maxConcurrent,
    };
    if (fit.code === 75) {
      out.blocked = `the background fit found no idle CPU (exit 75): ${lastLines(fit.out)}`;
      return out;
    }
    const rec = readRecord(box);
    const decision = rec?.decision ?? {};
    const cand = (rec?.candidates ?? []).find(
      (c) => c?.provider === "ollama" && c?.model === MODEL,
    );
    check(
      "embedder fit --background chooses granite-embedding:30m",
      fit.code === 0 &&
        decision.mode !== "off" &&
        decision.provider === "ollama" &&
        decision.model === MODEL,
      `exit ${fit.code} in ${fit.ms} ms; ${decision.mode} ${decision.provider ?? "-"}/${decision.model ?? "-"}, dormantUntilDemand ${decision.dormantUntilDemand}; ${out.fit.embedRequests} embed requests, at most ${out.fit.maxInFlight} in flight (2 is the fit's own probe); ${decision.reasons?.[0] ?? lastLines(fit.out)}`,
    );
    const gain = cand?.parallelGain;
    check(
      "the fit reads no gain from 2 requests in flight on a one-slot server",
      cand && !(gain && gain.sigma >= 0 && gain.delta > 2 * gain.sigma),
      gain
        ? `gain ${gain.delta} tokens/s against 2 sigma ${2 * gain.sigma}`
        : cand
          ? "the probe recorded no gain"
          : "no candidate measured",
    );
    if (!cand || decision.model !== MODEL || fit.code !== 0) {
      return out;
    }

    // 2. Armed. Dormancy is the fit's own decision; this scenario tests what follows once embedding runs.
    rec.decision.dormantUntilDemand = false;
    writeJsonAtomic(join(memoryDir(box), "embedder-fit.json"), rec);

    // 3. The runner stops answering embeddings. /api/tags, /api/version and /api/ps still answer.
    mock.reset();
    mock.hang();

    // 4. The gateway, idle CPU, then searches: the first one opens the index and starts its sync.
    gw = await startGateway(box, port);
    if (!gw.ready) {
      out.blocked = `gateway never answered health (exited=${gw.exited()})\n${gw.tail()}`;
      return out;
    }
    out.bootMs = gw.bootMs;
    const gate = await waitForIdleGate(cand.embedCores, idleWaitMs);
    if (!gate.open) {
      out.blocked = `the host stayed busy for ${Math.round(gate.waitedMs / 1000)} s: load ${gate.load1.toFixed(2)} + ${gate.s} embedder cores > ${gate.cores} cores, so the governor refuses background embedding`;
      return out;
    }
    const transitionsNow = () => breakerTransitions(parseLog(gw.log()).entries, endpoint);
    const searches = [];
    const watchStart = Date.now();
    let openSeenAt;
    for (;;) {
      searches.push(await search(box, port, target));
      const seen = transitionsNow();
      if (openSeenAt === undefined && seen.some((t) => t.kind === "open")) {
        openSeenAt = Date.now();
      }
      const probesSoFar = seen.filter((t) => t.kind === "half-open").length;
      const done =
        openSeenAt === undefined
          ? Date.now() - watchStart >= 2 * windowMs
          : probesSoFar >= 2 || Date.now() - openSeenAt >= windowMs;
      if (done) {
        break;
      }
      await sleep(1000);
    }
    // A probe still in flight ends at its deadline, which writes its transition and the snapshot.
    for (let i = 0; i < 40 && mock.openEmbeds() > 0; i++) {
      await sleep(250);
    }
    await sleep(500);

    const { embeds, maxConcurrent, other } = mock.stats();
    const transitions = transitionsNow();
    const g = readGovernors(box)[endpoint];
    const calls = daySum(g, "calls");
    const busy = daySum(g, "refusedBusy");
    if (embeds.length === 0 && busy > 0) {
      out.blocked = `the idle gate closed: the governor refused ${busy} background call(s) as busy and sent none (load ${(os.loadavg()[0] ?? 0).toFixed(2)} on ${cores()} cores)`;
      return out;
    }
    check(
      "at most 1 embedding request in flight",
      embeds.length >= 2 && maxConcurrent <= 1,
      `${embeds.length} requests, at most ${maxConcurrent} open at once`,
    );
    const opened = transitions.find((t) => t.kind === "open");
    const beforeOpen = opened
      ? embeds.filter((r) => r.arrivedAt <= opened.time).length
      : embeds.length;
    check(
      `the breaker opens after F failures (F from ${F_MIN} to ${F_MAX}), each one a request the mock saw`,
      opened &&
        opened.failures >= F_MIN &&
        opened.failures <= F_MAX &&
        beforeOpen === opened.failures,
      opened
        ? `opened after ${opened.failures} consecutive failures, with ${beforeOpen} requests at the mock before it; first cool-down ${opened.coolS} s`
        : `no breaker-open line; ${embeds.length} requests at the mock; governor ${calls} calls, ${daySum(g, "failures")} failures, ${busy} refused busy`,
    );
    const issues = [];
    const coolDowns = [];
    let probes = 0;
    for (let i = 0; i < transitions.length; i++) {
      const t = transitions[i];
      const next = transitions[i + 1];
      const until = next ? next.time : Number.POSITIVE_INFINITY;
      if (t.kind === "open" || t.kind === "reopen") {
        coolDowns.push(t.coolS);
        const during = embeds.filter((r) => r.arrivedAt > t.time && r.arrivedAt < until).length;
        if (during > 0) {
          issues.push(`${during} request(s) during a ${t.coolS} s cool-down`);
        }
        if (!Number.isFinite(t.coolS)) {
          issues.push("a cool-down the log line does not state");
        } else if (next && next.time - t.time < t.coolS * 1000 - printedRoundingMs(t.coolS) - 5) {
          issues.push(`a probe ${next.time - t.time} ms into a ${t.coolS} s cool-down`);
        }
        if (next && next.kind !== "half-open") {
          issues.push(`${t.kind} followed by ${next.kind}`);
        }
      } else if (t.kind === "half-open") {
        probes += 1;
        const sent = embeds.filter((r) => r.arrivedAt >= t.time && r.arrivedAt <= until).length;
        if (sent !== 1) {
          issues.push(`${sent} requests in one half-open window`);
        }
      }
    }
    check(
      "at most one half-open probe per cool-down",
      opened && probes >= 1 && issues.length === 0,
      `${probes} probe(s) over ${coolDowns.length} cool-down(s) of ${coolDowns.join(", ") || "-"} s${issues.length > 0 ? `; ${issues.join("; ")}` : ""}`,
    );
    check(
      "every request the mock saw was one governed call, and none passed an open breaker",
      opened && calls === embeds.length && embeds.length === opened.failures + probes,
      `mock ${embeds.length} embedding requests (and ${other.length} others); governor ${calls} calls, ${daySum(g, "deadlines")} deadlines, ${daySum(g, "refusedBreaker")} refused by the breaker, ${busy} refused busy; F ${opened?.failures ?? "-"} + ${probes} probe(s); breaker now ${g?.breaker?.state ?? "-"} after ${g?.breaker?.consecutiveTrips ?? "-"} trip(s)`,
    );
    const holds = embeds
      .filter((r) => r.closedAt !== undefined)
      .map((r) => r.closedAt - r.arrivedAt);
    check(
      "the gateway aborts every hung request (the mock sees its socket close)",
      embeds.length > 0 && embeds.every((r) => r.aborted),
      `${embeds.filter((r) => r.aborted).length} of ${embeds.length} closed by the gateway unanswered; held ${median(holds) ?? "-"} ms median, ${holds.length > 0 ? Math.max(...holds) : "-"} ms max`,
    );
    const firstHit = searches.findIndex((s) => s.found);
    const afterOpen = opened ? searches.filter((s) => s.startedAt >= opened.time) : [];
    const failedSearch = searches.find((s) => !s.ok);
    check(
      "fork.memory.search keeps answering with keyword hits while the embedder hangs",
      !failedSearch &&
        firstHit >= 0 &&
        searches.slice(firstHit).every((s) => s.found) &&
        afterOpen.some((s) => s.found),
      `${searches.length} searches: ${searches.filter((s) => !s.ok).length} failed, ${searches.filter((s) => s.found).length} found ${target} (from search ${firstHit + 1}), ${afterOpen.filter((s) => s.found).length} of ${afterOpen.length} after the breaker opened; ${median(searches.map((s) => s.ms))} ms median per call, CLI start-up included${failedSearch?.error ? `; ${failedSearch.error}` : ""}`,
    );
    return out;
  } finally {
    await gw?.stop();
    await mock.close();
    if (!keep) {
      rmSync(box.root, { recursive: true, force: true });
    }
  }
}

// ---- Main ---------------------------------------------------------------------------------------

const runners = { "no-ollama": runNoOllama, "slow-ollama": runSlowOllama };
const scenarios = scenarioArg === "all" ? Object.keys(runners) : [scenarioArg];
const results = [];
for (const name of scenarios) {
  const run = Object.hasOwn(runners, name) ? runners[name] : undefined;
  if (!run) {
    console.error(`unknown scenario "${name}" (no-ollama, slow-ollama or all)`);
    process.exit(2);
  }
  try {
    results.push(await run());
  } catch (err) {
    results.push({
      scenario: name,
      checks: [
        {
          name: "the scenario ran to its end",
          ok: false,
          saw: String(err instanceof Error ? (err.stack ?? err.message) : err).slice(0, 400),
        },
      ],
    });
  }
}

let failed = 0;
let blocked = 0;
for (const r of results) {
  failed += r.checks.filter((c) => !c.ok).length;
  if (r.blocked) {
    blocked += 1;
  }
  if (asJson) {
    continue;
  }
  const boot = r.bootMs !== undefined ? ` (boot ${r.bootMs} ms)` : "";
  console.log(`\n== ${r.scenario}${boot}${r.root ? `  [kept: ${r.root}]` : ""}`);
  for (const c of r.checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  [saw: ${c.saw}]`);
  }
  if (r.blocked) {
    console.error(`BLOCKED (${r.scenario}): ${r.blocked}`);
  }
}
if (asJson) {
  console.log(JSON.stringify(results, null, 2));
}
process.exit(failed ? 1 : blocked ? 2 : 0);
