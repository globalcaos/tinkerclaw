/**
 * Mock gateway + static server for the chat viewport checks (tinker-ui.md §5.20, chat-viewport.ts).
 *
 * Serves the built `tinker-ui/dist` under /tinker/ and speaks just enough of the gateway protocol on the same port:
 * the connect handshake, two sessions, and a chat history per session. Each transcript is long enough to scroll and
 * carries images that answer SLOWLY and are never cached, so every repaint that re-creates an <img> grows after the
 * pin — the late growth that left a switched-to tab short of its bottom. It binds to 127.0.0.1 only, never connects
 * to anything else, and serves no /api/ui-state, so the page keeps its UI state in the browser context alone.
 *
 * Control (HTTP, same port): POST /__mock/state {extra?: {[sessionKey]: number}, busy?: string[]}: `extra`
 * appends that many rows to a session's history from its next read on; `busy` streams a run in flight for
 * those sessions (a session that never goes quiet, like a parallel worker). GET /__mock/run: the scripted
 * run's id, how many of its finals went out, and its answer text.
 *
 * chat.send starts a scripted run on the sent session (checks 12 and 13), bound to the page's idempotencyKey as
 * the gateway binds it; every run's rows stay in that session's history. See the section above startRun.
 * POST /__mock/state {runStartDelayMs} starts the NEXT runs that long after the send (default 300 ms), and
 * {historyDelayMs} holds every chat.history reply for a session while a run of it is live, as a busy gateway
 * answers late, and {runHeartbeatMs} has a live run send an `effort` frame that often, as a run that is
 * thinking or calling a tool still tells the page it is live (check 13).
 * FORK 2026-10-06 (check 14): {historyAllDelayMs} holds EVERY chat.history reply that long, as a cold or
 * loaded gateway answers late, and {refuseHistoryMs} answers chat.history with the gateway's startup
 * refusal (UNAVAILABLE "chat.history unavailable during gateway startup") for that long from the POST.
 * {dropConnectionsMs} drops every open socket and refuses new ones for that long, as a gateway that
 * stops and starts again (check 14d).
 *
 * Session C (2026-10-03) has earlier transcripts of every kind the gateway pages: a COPY that overlaps its live rows
 * and holds older ones, an empty copy answered as the gateway does when its skip budget runs out, and a reset. The
 * archive reads follow the gateway's contract (server-methods/chat.ts respondWithResetArchive): copies only under an
 * `archiveFloor`, only rows strictly older than it, and the archive's `kind`.
 *
 * Usage: node mock-gateway.mjs --port 18997 --dist ../../dist
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []),
);
const PORT = Number(args.port ?? 18997);
const DIST = resolve(here, args.dist ?? "../../dist");
const SESSION_A = "agent:main:main";
const SESSION_B = "agent:main:tinker:mockb";
const SESSION_C = "agent:main:tinker:mockc";
// Session D (2026-10-03) is reset before every turn, like the parallel worker: POST /__mock/state
// {dResets: 2} runs two turns while its tab is away, archiving the turn it showed and one it never saw.
const SESSION_D = "agent:main:tinker:mockd";
// Session E (2026-10-03, a peer's review): every answer opens with narration the splitter folds into a
// closed "▸ Commentary" whose body is stamped with the row's data-oc-id.
const SESSION_E = "agent:main:tinker:mocke";
const ROWS = 120;
const IMAGE_DELAY_MS = 900;
/** Rows per archive reply: smaller than an archive, so the page must read one in several pages. */
const ARCHIVE_PAGE = 12;

// `busy`: session keys that have a run in flight. The page learns it from `agent` events (an
// `effort` frame admits the run to its run map), streamed to every page twice a second, as a
// session running turn after turn does.
const state = {
  extra: {},
  busy: [],
  emptyLive: [],
  dResets: 0,
  runStartDelayMs: 300,
  historyDelayMs: 0,
  runHeartbeatMs: 0,
  historyAllDelayMs: 0,
  refuseHistoryUntil: 0,
  refuseConnectUntil: 0,
};
const sockets = new Set();
/** Push one event frame to every open page, as the gateway broadcasts agent and chat events. */
function broadcast(event, payload) {
  const frame = JSON.stringify({ type: "event", event, payload });
  for (const ws of sockets) {
    if (ws.readyState === 1) {
      ws.send(frame);
    }
  }
}
setInterval(() => {
  for (const key of state.busy) {
    broadcast("agent", {
      runId: `busy-${key}`,
      sessionKey: key,
      stream: "effort",
      data: { model: "mock" },
    });
  }
}, 500);

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

const LOREM =
  "The bench run finished and the numbers are in. Each line here is filler with enough words to wrap " +
  "across the bubble a few times, so the transcript is tall and a scroll offset means something. ";

/** The transcript of `key`: ROWS rows plus any extra appended through the control port. */
/** One turn of session D: 10 rows from `startMs`, 30 s apart, ids `<tag>-<n>`. */
function dTurn(tag, startMs) {
  return Array.from({ length: 10 }, (_, k) => ({
    role: k % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `${tag}${k + 1} — turn ${tag}, step ${k + 1}. ${LOREM}` }],
    timestamp: startMs + k * 30_000,
    __openclaw: { id: `${tag}-${k + 1}` },
  }));
}
const D_T0 = Date.parse("2026-10-02T08:00:00Z");

function history(key) {
  if (key === SESSION_E) {
    const t0 = Date.parse("2026-10-02T08:00:00Z");
    return Array.from({ length: 80 }, (_, k) => {
      const i = k + 1;
      const user = i % 2 === 1;
      return {
        role: user ? "user" : "assistant",
        content: [
          {
            type: "text",
            text: user
              ? `E${i} — question number ${i}?`
              : `Let me check the bench logs for E${i} first. E${i} answer. ${LOREM.repeat(2 + (i % 3))}`,
          },
        ],
        timestamp: t0 + i * 60_000,
        __openclaw: { id: `E-${i}` },
      };
    });
  }
  if (key === SESSION_D) {
    return state.dResets >= 2 ? dTurn("Dc", D_T0 + 50 * 60_000) : dTurn("Da", D_T0 + 10 * 60_000);
  }
  const tag = key === SESSION_A ? "A" : key === SESSION_B ? "B" : "C";
  const n = (key === SESSION_C ? 30 : ROWS) + (state.extra[key] ?? 0);
  const t0 = Date.parse("2026-10-02T08:00:00Z");
  const out = [];
  for (let i = 1; i <= n; i++) {
    const user = i % 2 === 1;
    const image =
      !user && i % 10 === 0 ? `\n\n![shot ${tag}${i}](/tinker/__img/${tag}${i}.svg)\n` : "";
    out.push({
      role: user ? "user" : "assistant",
      content: [
        {
          type: "text",
          text: user
            ? `${tag}${i} — question number ${i}?`
            : `${tag}${i} — ${LOREM.repeat(1 + (i % 3))}${image}`,
        },
      ],
      timestamp: t0 + i * 60_000,
      __openclaw: { id: `${tag}-${i}` },
    });
  }
  // The scripted runs of this session, once the gateway holds them: each one's prompt row, then (from
  // its first final on) its import rows.
  for (const r of runs) {
    if (r.key === key) {
      out.push(...r.rows);
    }
  }
  return out;
}

/** Earlier transcripts of a session, newest first: B's two resets (20 rows each), C's three kinds. */
function archivesOf(key) {
  const t0 = Date.parse("2026-10-02T08:00:00Z");
  const rows = (tag, startMs, n) =>
    Array.from({ length: n }, (_, k) => ({
      role: k % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `${tag}${k + 1} — archived turn ${k + 1}. ${LOREM}` }],
      timestamp: startMs + k * 30_000,
      __openclaw: { id: `${tag}-${k + 1}` },
    }));
  const archive = (tag, startMs, resetAt) => ({
    resetAt,
    kind: "reset",
    rows: rows(tag, startMs, 20),
  });
  if (key === SESSION_B) {
    return [
      archive("Bx2", t0 - 40 * 60_000, t0 - 10 * 60_000),
      archive("Bx1", t0 - 90 * 60_000, t0 - 60 * 60_000),
    ];
  }
  if (key === SESSION_D) {
    const dx = { resetAt: D_T0 + 5 * 60_000, kind: "reset", rows: dTurn("Dx", D_T0 - 20 * 60_000) };
    if (state.dResets < 2) return [dx];
    return [
      { resetAt: D_T0 + 45 * 60_000, kind: "reset", rows: dTurn("Db", D_T0 + 30 * 60_000) },
      { resetAt: D_T0 + 25 * 60_000, kind: "reset", rows: dTurn("Da", D_T0 + 10 * 60_000) },
      dx,
    ];
  }
  if (key !== SESSION_C) return [];
  return [
    // A repair backup: 10 rows older than the live transcript, then 10 that the live one also holds
    // (under other ids, as a coalesced answer and its segments are). Only the older ones may show.
    {
      resetAt: t0 + 40 * 60_000,
      kind: "copy",
      rows: [...rows("Co", t0 - 30 * 60_000, 10), ...rows("Cd", t0 + 2 * 60_000, 10)],
    },
    // A copy the gateway gave up skipping (its 30 s budget): an empty reply, no divider.
    { resetAt: t0 - 20 * 60_000, kind: "copy", rows: [], budgetOut: true },
    { resetAt: t0 - 35 * 60_000, kind: "reset", rows: rows("Cr", t0 - 60 * 60_000, 20) },
  ];
}

// ── Check 12: the run the page's own chat.send starts ──────────────────────────────────────────
// Synthetic text in the frame shapes of a captured cc-bridge turn (2026-10-03). Every text step is
// an agent `assistant` frame followed by a `chat` delta, both carrying the run's CUMULATIVE text.
// Each agent `thinking` frame carries the run's TRIMMED CUMULATIVE reasoning, so the second thought
// opens its bubble at the first thought's length: an offset into the thinking buffer, not the
// text. One narration block, one tool call, a block break, then an answer that streams for 17.6 s,
// and then the gateway's TWO finals with the same body. From the first final on, chat.history
// serves the run as claude-cli import rows (`__openclaw.externalId`), each stamped when its block
// FINISHED: the answer at the end of its stream, more than the page's 15 s watched slack after its
// bubble opened (history-reconcile.ts WATCHED_WINDOW_SLACK_MS).
const THOUGHT_1 =
  "The owner wants the bench run summed up in one paragraph. I will say what I am about to read, " +
  "read the numbers with one command, think once more about the order, and then write the " +
  "paragraph in plain sentences, with no lists and no markup, so the page shows it as it streams.";
const NARRATION = "Reading the bench numbers first.";
const THOUGHT_2 =
  "The numbers are in. One paragraph, in the order the passes ran, then what needs doing.";
// Letters, commas and full stops only: cut anywhere, it still renders as the same plain text.
const ANSWER = [
  "The bench run finished cleanly and every pass wrote its numbers to the log.",
  "The first pass warmed the caches and set a steady pace for the rest of the run.",
  "The second pass held that pace while the disk queue stayed short and quiet.",
  "The third pass was the slowest, because it rebuilt the index from nothing.",
  "The fourth pass made up the time by reading the fresh index instead of the old one.",
  "The fifth pass ran the long queries, and none of them timed out.",
  "The sixth pass repeated the short queries and matched the first pass almost exactly.",
  "The seventh pass doubled the load, and the latency rose by a little over a third.",
  "The eighth pass brought the load back down, and the latency followed it.",
  "The ninth pass compared the results with yesterday and found no drift at all.",
  "The tenth pass cleaned up, and the machine went back to idle on its own.",
  "In short, the run is healthy, the rebuild is the only slow step, and nothing needs fixing today.",
].join(" ");
const TOOL_CALL = {
  id: "toolu_check9",
  name: "Bash",
  args: { command: "cat bench.log", description: "Read the bench numbers" },
};
/** From the send to the run's first thought: the page leaves the tab and comes back in here. */
const RUN_QUIET_MS = 6000;
const ANSWER_STEPS = 45;
const ANSWER_STEP_MS = 400;
/** The newest scripted run: {key, runId, finals, phase, rows}, or null before the page sends. */
let run = null;
/** Every scripted run, oldest first: each one's rows stay in its session's history. */
const runs = [];

/** chat.send: ack the page's prompt and play the run on the sent session, keyed by its idempotencyKey. */
function startRun(params) {
  const key = String(params?.sessionKey ?? SESSION_A);
  const runId = String(params?.idempotencyKey ?? `check9-${Date.now()}`);
  if (runs.some((x) => x.runId === runId)) {
    // The same prompt replayed (the page's outbox): the gateway's dedupe answers, nothing reruns.
    return { runId, status: "in_flight" };
  }
  // `phase`: queued → started → answering → final1 → final2.
  const r = { key, runId, finals: 0, phase: "queued", rows: [] };
  run = r;
  runs.push(r);
  const done = {}; // when each block finished: the import rows' timestamps
  // One counter for the run's agent events; a chat frame reuses the seq of the event before it.
  let seq = 0;
  const agent = (stream, data) =>
    broadcast("agent", { runId, sessionKey: key, stream, data, seq: ++seq, ts: Date.now() });
  const chat = (chatState, message, s = seq) =>
    broadcast("chat", { runId, sessionKey: key, seq: s, state: chatState, message });
  const say = (text, delta) => {
    agent("assistant", { text, delta });
    chat("delta", { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() });
  };
  // The script below starts the turn at 300 ms; `runStartDelayMs` moves all of it later (check 13).
  const shift = Math.max(0, Number(state.runStartDelayMs ?? 300) - 300);
  const at = (ms, fn) => setTimeout(fn, ms + shift);
  const model = { model: "mock", modelProvider: "mock" };

  at(300, () => {
    r.phase = "started";
    const beatMs = Number(state.runHeartbeatMs ?? 0);
    if (beatMs > 0) {
      const beat = setInterval(() => {
        if (r.phase === "started" || r.phase === "answering") {
          agent("effort", { phase: "live", model: "mock" });
        } else {
          clearInterval(beat);
        }
      }, beatMs);
    }
    agent("lifecycle", { phase: "start", startedAt: Date.now(), ...model, sessionKey: key });
    agent("effort", { phase: "live", model: "mock" });
    // The gateway writes the prompt row as the turn starts.
    r.rows.push({
      role: "user",
      content: [{ type: "text", text: String(params?.message ?? "") }],
      timestamp: Date.now(),
      idempotencyKey: runId,
      __openclaw: { id: `${runId}-prompt` },
    });
  });
  at(RUN_QUIET_MS, () => {
    agent("thinking", { text: THOUGHT_1, delta: THOUGHT_1 });
    done.thought1 = Date.now();
  });
  at(RUN_QUIET_MS + 400, () => say(NARRATION.slice(0, 16), NARRATION.slice(0, 16)));
  at(RUN_QUIET_MS + 600, () => {
    say(NARRATION, NARRATION.slice(16));
    done.narration = Date.now();
  });
  at(RUN_QUIET_MS + 1000, () =>
    agent("tool", {
      phase: "start",
      name: TOOL_CALL.name,
      toolCallId: TOOL_CALL.id,
      args: TOOL_CALL.args,
    }),
  );
  at(RUN_QUIET_MS + 1600, () => {
    agent("tool", { phase: "result", toolCallId: TOOL_CALL.id, result: "ok", isError: false });
    done.tool = Date.now();
  });
  at(RUN_QUIET_MS + 2200, () => {
    // (THOUGHT_1 + "\n\n" + THOUGHT_2 + "\n\n").trim(): the thinking buffer so far, trimmed.
    agent("thinking", { text: `${THOUGHT_1}\n\n${THOUGHT_2}`, delta: `\n\n${THOUGHT_2}` });
    done.thought2 = Date.now();
  });
  at(RUN_QUIET_MS + 2600, () =>
    agent("lifecycle", {
      phase: "text-block-break",
      fromIndex: "msg_1:text:0",
      toIndex: "msg_2:text:0",
      ...model,
    }),
  );
  const answerAt = RUN_QUIET_MS + 2800;
  const shown = (i) => ANSWER.slice(0, Math.round((ANSWER.length * i) / ANSWER_STEPS));
  for (let i = 1; i <= ANSWER_STEPS; i++) {
    at(answerAt + (i - 1) * ANSWER_STEP_MS, () => {
      r.phase = "answering";
      say(NARRATION + shown(i), shown(i).slice(shown(i - 1).length));
      done.answer = Date.now();
    });
  }
  const body = NARRATION + ANSWER;
  const endAt = answerAt + (ANSWER_STEPS - 1) * ANSWER_STEP_MS + 300;
  at(endAt, () => {
    const imported = (part, timestamp, content) => ({
      role: "assistant",
      content,
      timestamp,
      __openclaw: { importedFrom: "claude-cli", externalId: `${runId}-${part}` },
    });
    r.rows.push(
      imported("thought-1", done.thought1, [{ type: "thinking", thinking: THOUGHT_1 }]),
      imported("narration", done.narration, [{ type: "text", text: NARRATION }]),
      imported("tool", done.tool, [
        { type: "toolcall", id: TOOL_CALL.id, name: TOOL_CALL.name, arguments: TOOL_CALL.args },
        {
          type: "tool_result",
          tool_use_id: TOOL_CALL.id,
          content: "ok",
          is_error: false,
          name: TOOL_CALL.name,
        },
      ]),
      imported("thought-2", done.thought2, [{ type: "thinking", thinking: THOUGHT_2 }]),
      imported("answer", done.answer, [{ type: "text", text: ANSWER }]),
    );
    agent("effort", { phase: "final", model: "mock" });
    agent("lifecycle", { phase: "end", endedAt: Date.now(), ...model, sessionKey: key });
    // Final #1: the streamed buffer.
    chat("final", {
      role: "assistant",
      content: [{ type: "text", text: body }],
      timestamp: Date.now(),
    });
    r.finals = 1;
    r.phase = "final1";
  });
  at(endAt + 900, () => {
    // Final #2: the delivered replies, same body, in the backstop's message shape and seq.
    chat(
      "final",
      {
        role: "assistant",
        text: body,
        timestamp: Date.now(),
        stopReason: "stop",
        usage: { input: 0, output: 0, totalTokens: 0 },
        content: [{ type: "text", text: body }],
      },
      2,
    );
    r.finals = 2;
    r.phase = "final2";
  });
  return { runId, status: "started" };
}

/** A run of `key` is live: started, no final yet (check 13 holds history replies while it is). */
function runLive(key) {
  return runs.some((r) => r.key === key && (r.phase === "started" || r.phase === "answering"));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/__mock/")) return control(req, res, url);
  if (url.pathname.startsWith("/tinker/__img/")) {
    // A 600×400 picture that answers late and is never cached: it lays out at zero height first.
    setTimeout(() => {
      res
        .writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" })
        .end(
          `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#7a9"/></svg>`,
        );
    }, IMAGE_DELAY_MS);
    return;
  }
  let rel = url.pathname.replace(/^\/tinker\/?/, "");
  if (rel === "" || rel === "login" || !extname(rel)) rel = "index.html";
  const file = join(DIST, rel);
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  if (rel === "index.html") {
    const html = readFileSync(file, "utf-8").replace(
      "<head>",
      `<head><script>window.__TINKER_CONFIG={token:"mock"};</script>`,
    );
    res.writeHead(200, { "content-type": "text/html" }).end(html);
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});

function control(req, res, url) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = body ? JSON.parse(body) : {};
    if (url.pathname === "/__mock/state") {
      Object.assign(state, j);
      if (typeof j.refuseHistoryMs === "number") {
        state.refuseHistoryUntil = Date.now() + j.refuseHistoryMs;
      }
      if (typeof j.dropConnectionsMs === "number") {
        state.refuseConnectUntil = Date.now() + j.dropConnectionsMs;
        for (const s of sockets) s.terminate();
      }
    }
    // GET /__mock/log: every request the page sent since the last read ({at, method, key, afterSeq}),
    // then cleared (2026-10-06, check 14d: what a reconnect reads and in which order).
    const reply =
      url.pathname === "/__mock/run"
        ? {
            runId: run?.runId ?? null,
            finals: run?.finals ?? 0,
            phase: run?.phase ?? null,
            answer: ANSWER,
          }
        : url.pathname === "/__mock/log"
          ? { log: requestLog.splice(0) }
          : {};
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
  });
}

const session = (key, title) => ({
  key,
  sessionKey: key,
  label: title,
  title,
  updatedAt: Date.now(),
  kind: "direct",
  model: "mock",
});

function answer(method, params) {
  if (method === "connect")
    return {
      type: "hello-ok",
      protocol: 3,
      server: { version: "mock" },
      features: { methods: [], events: [] },
      snapshot: { sessionDefaults: { mainSessionKey: SESSION_A } },
      policy: {},
    };
  if (method === "sessions.list")
    return {
      sessions: [
        session(SESSION_A, "Main"),
        session(SESSION_B, "Second"),
        session(SESSION_C, "Third"),
        session(SESSION_D, "Worker"),
        session(SESSION_E, "Folds"),
      ],
      count: 5,
    };
  if (method === "chat.history") {
    const key = String(params?.sessionKey ?? SESSION_A);
    if (params?.resetArchiveBefore !== undefined) {
      // Tab B's session was reset twice before its live transcript began (2026-10-02, the worker).
      // Pages of ARCHIVE_PAGE rows from the end, as the gateway pages an archive past `limit`.
      const floor = typeof params.archiveFloor === "number" ? params.archiveFloor : undefined;
      const offset = params.archiveOffset ?? 0;
      const older = archivesOf(key).filter(
        (a) => a.resetAt < params.resetArchiveBefore && (floor !== undefined || a.kind === "reset"),
      );
      for (let i = 0; i < older.length; i++) {
        const hit = older[i];
        const continuing = i === 0 && offset > 0;
        // The floor cuts copies only; a reset archive is served whole (2026-10-03).
        const cut = hit.kind === "reset" ? undefined : floor;
        const kept = cut === undefined ? hit.rows : hit.rows.filter((r) => r.timestamp < cut);
        if (kept.length === 0 && !continuing && !hit.budgetOut && i < older.length - 1) continue;
        const end = Math.max(0, kept.length - (continuing ? offset : 0));
        const start = Math.max(0, end - ARCHIVE_PAGE);
        return {
          sessionKey: key,
          messages: kept.slice(start, end),
          archive: {
            resetAt: hit.resetAt,
            olderCount: older.length - 1 - i,
            rowsBefore: start,
            kind: hit.kind,
          },
        };
      }
      return {
        sessionKey: key,
        messages: [],
        archive: { resetAt: null, olderCount: 0, rowsBefore: 0 },
      };
    }
    // `emptyLive`: the session was just reset, its live transcript holds nothing yet.
    return { sessionKey: key, messages: state.emptyLive.includes(key) ? [] : history(key) };
  }
  if (method === "sessions.subscribe") return {};
  if (method === "chat.send") return startRun(params);
  throw new Error(`unknown method: ${method}`);
}

const requestLog = [];
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  if (Date.now() < state.refuseConnectUntil) {
    ws.terminate();
    return;
  }
  sockets.add(ws);
  ws.on("close", () => sockets.delete(ws));
  ws.send(
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "n", ts: Date.now() },
    }),
  );
  ws.on("message", (raw) => {
    let f;
    try {
      f = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (f.type !== "req") return;
    requestLog.push({
      at: Date.now(),
      method: f.method,
      key: f.params?.sessionKey ?? null,
      afterSeq: f.params?.afterSeq ?? null,
    });
    const reply = () => {
      try {
        ws.send(
          JSON.stringify({ type: "res", id: f.id, ok: true, payload: answer(f.method, f.params) }),
        );
      } catch (e) {
        ws.send(
          JSON.stringify({
            type: "res",
            id: f.id,
            ok: false,
            error: { code: "UNAVAILABLE", message: String(e.message ?? e) },
          }),
        );
      }
    };
    if (f.method === "chat.history" && Date.now() < state.refuseHistoryUntil) {
      // The gateway's own refusal while its sidecars start (server-startup-unavailable-methods.ts).
      ws.send(
        JSON.stringify({
          type: "res",
          id: f.id,
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: "chat.history unavailable during gateway startup",
          },
        }),
      );
      return;
    }
    const late =
      f.method === "chat.history" &&
      state.historyDelayMs > 0 &&
      runLive(String(f.params?.sessionKey ?? SESSION_A));
    const allLate = f.method === "chat.history" ? state.historyAllDelayMs : 0;
    if (late || allLate > 0) {
      setTimeout(reply, Math.max(late ? state.historyDelayMs : 0, allLate));
    } else {
      reply();
    }
  });
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`mock gateway on http://127.0.0.1:${PORT}/tinker/`),
);
