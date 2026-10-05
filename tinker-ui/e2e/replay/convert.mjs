#!/usr/bin/env node
/**
 * Capture → scenario. Reads a capture dir written by capture.mjs (frames.ndjson + history-NNN-<tag>.json)
 * and writes a scenario JSON that mock-gateway.mjs replays to a real browser (drive.mjs).
 *
 *   node convert.mjs --cap <capdir> --out <scenario.json>
 *        [--session agent:main:tinker:replaycap]   session key the capture's key is rewritten to
 *        [--send page|none]                        page (default): the page types the captured prompt at the
 *                                                  captured chat.send time and the run's id is bound to the
 *                                                  page's own idempotencyKey; none: the run is foreign (started
 *                                                  elsewhere, as in the capture itself)
 *        [--max-gap <ms>]                          shorten every idle gap longer than this (default: none =
 *                                                  the captured timing exactly); timestamps inside payloads
 *                                                  are mapped with the same function
 *        [--end-after <ms>]                        scenario end = last frame + this (default 15000)
 *        [--actions <file.json>]                   extra actions (array) merged into the timeline
 *        [--synth-sessions-changed]                add sessions.changed start/end pushes (the capture client did
 *                                                  not subscribe, so a real page got pushes the capture lacks)
 *        [--prior <N>]                             APPROXIMATION: N synthetic earlier local rows in front of every
 *                                                  snapshot, so the page holds served rows before the turn (the
 *                                                  capture is a brand-new session); see withPrior below
 *        [--name <name>]
 *
 * Timing rules (recorded in the scenario's `notes`):
 *   - a frame's `at` is its capture `t` (ms since the capture started);
 *   - a history snapshot read in the background (`mid`, `before`, `end`) is served from its RESPONSE time
 *     (the state existed no later than that); one read on a final (`after-final-N`) from the final's own
 *     `t` + 1 (the read was sent the moment the final arrived and came back already holding the rows);
 *   - consecutive snapshots with identical content are collapsed into the first.
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const CAP = flag("cap");
const OUT = flag("out");
if (!CAP || !OUT) {
  console.error(
    "usage: node convert.mjs --cap <capdir> --out <scenario.json> [--session K] [--send page|none] [--max-gap ms]",
  );
  process.exit(2);
}
const NEW_SESSION = flag("session", "agent:main:tinker:replaycap");
const SEND = flag("send", "page");
const MAX_GAP = flag("max-gap") ? Number(flag("max-gap")) : null;
const END_AFTER = Number(flag("end-after", 15000));
const EXTRA_ACTIONS = flag("actions") ? JSON.parse(fs.readFileSync(flag("actions"), "utf-8")) : [];
const SYNTH_CHANGED = flag("synth-sessions-changed", false) === true;
const NAME = flag("name", path.basename(OUT).replace(/\.json$/, ""));

const lines = fs
  .readFileSync(path.join(CAP, "frames.ndjson"), "utf-8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

// ── what the capture holds ────────────────────────────────────────────────────────────────────
const inFrames = lines.filter((r) => r.dir === "in");
const keyCount = new Map();
for (const r of inFrames) {
  const k = r.payload?.sessionKey ?? r.payload?.data?.sessionKey;
  if (typeof k === "string") keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
}
const OLD_SESSION = [...keyCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
if (!OLD_SESSION) throw new Error("no session key in the capture's frames");
const hello = lines.find((r) => r.dir === "res" && r.method === "connect")?.payload ?? {};
const sendRes = lines.find((r) => r.dir === "res" && r.method === "chat.send");
const sentNote = lines.find((r) => r.dir === "note" && r.note === "sent");
const connectedNote = lines.find((r) => r.dir === "note" && r.note === "connected");
const runKey = connectedNote?.runKey ?? sendRes?.payload?.runId ?? null;
const sendAt = sentNote?.t ?? sendRes?.t ?? 0;
const finals = inFrames.filter((r) => r.event === "chat" && r.payload?.state === "final");

// Scenario epoch: the capture's t=0 in epoch ms. A frame's payload.ts is stamped when the gateway
// emits it and t when the capture receives it, so ts - t = epoch0 - latency: the max is the closest.
let epoch0 = null;
for (const r of inFrames) {
  const ts = r.payload?.ts;
  if (typeof ts === "number" && ts > 1.5e12) {
    const e = ts - r.t;
    if (epoch0 === null || e > epoch0) epoch0 = e;
  }
}
if (epoch0 === null) {
  const m = /-(\d{13})$/.exec(String(runKey ?? ""));
  epoch0 = m ? Number(m[1]) : Date.now();
}

// ── time mapping (identity unless --max-gap) ─────────────────────────────────────────────────
const anchorsRaw = new Set([0, sendAt]);
for (const r of lines) anchorsRaw.add(r.t);
const anchors = [...anchorsRaw].filter((x) => typeof x === "number").sort((a, b) => a - b);
const mapped = new Map();
{
  let shift = 0;
  for (let i = 0; i < anchors.length; i++) {
    if (i > 0 && MAX_GAP !== null) {
      const gap = anchors[i] - anchors[i - 1];
      if (gap > MAX_GAP) shift += gap - MAX_GAP;
    }
    mapped.set(anchors[i], anchors[i] - shift);
  }
}
/** Map a capture-relative time (ms since t=0) through the gap compression. */
function mapT(r) {
  if (MAX_GAP === null) return r;
  if (mapped.has(r)) return mapped.get(r);
  if (r <= anchors[0]) return r;
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1];
    const b = anchors[i];
    if (r <= b) {
      const ma = mapped.get(a);
      const mb = mapped.get(b);
      return ma + ((r - a) * (mb - ma)) / (b - a || 1);
    }
  }
  return r - (anchors.at(-1) - mapped.get(anchors.at(-1)));
}
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
/** Epoch values inside payloads follow the same mapping (no-op without --max-gap). */
function mapEpochs(obj) {
  if (MAX_GAP === null) return obj;
  const walk = (v) => {
    if (typeof v === "number" && v > 1.5e12 && v < 2.5e12)
      return Math.round(epoch0 + mapT(v - epoch0));
    if (typeof v === "string" && ISO.test(v)) {
      return new Date(Math.round(epoch0 + mapT(Date.parse(v) - epoch0))).toISOString();
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  return walk(obj);
}

// ── rewrite the session key everywhere ───────────────────────────────────────────────────────
const rekey = (obj) => JSON.parse(JSON.stringify(obj).split(OLD_SESSION).join(NEW_SESSION));

// ── frames ───────────────────────────────────────────────────────────────────────────────────
const frames = inFrames.map((r) => ({
  at: Math.round(mapT(r.t)),
  event: r.event,
  seq: typeof r.seq === "number",
  payload: mapEpochs(rekey(r.payload)),
}));

// ── history timeline ─────────────────────────────────────────────────────────────────────────
const textOf = (m) => {
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b?.type === "text" ? (b.text ?? "") : "")).join("");
  return "";
};
const notes = lines.filter((r) => r.dir === "note" && typeof r.file === "string");
const snaps = [];
for (const n of notes) {
  const h = JSON.parse(fs.readFileSync(path.join(CAP, n.file), "utf-8"));
  const res = h.res ?? {};
  const tag = h.tag ?? n.note.split(" ").at(-1);
  const fm = /^after-final-(\d+)$/.exec(tag);
  const final = fm ? finals[Number(fm[1]) - 1] : null;
  const at = final ? final.t + 1 : (h.t ?? n.t);
  snaps.push({ at, tag, respT: h.t ?? n.t, file: n.file, res });
}
snaps.sort((a, b) => a.at - b.at);
const collapsed = [];
for (const s of snaps) {
  const body = JSON.stringify({ m: s.res.messages ?? [], c: s.res.cursor ?? null });
  const prev = collapsed.at(-1);
  if (prev && prev._body === body) {
    prev.reads.push({ at: s.at, tag: s.tag, respT: s.respT });
    continue;
  }
  collapsed.push({
    _body: body,
    at: s.at,
    tag: s.tag,
    respT: s.respT,
    file: s.file,
    res: s.res,
    reads: [{ at: s.at, tag: s.tag, respT: s.respT }],
  });
}
/** A local row the projection hides (an import covers it) still anchors an afterSeq cursor. Its time
 *  is not served, so it is estimated as the timestamp of the latest final at or before the snapshot. */
function hiddenLocalOf(s) {
  const c = s.res.cursor;
  if (!c || c.epoch == null || !(c.lastSeq > 0)) return [];
  const served = new Set();
  for (const m of s.res.messages ?? []) {
    const oc = m?.__openclaw;
    if (oc && oc.importedFrom == null && Number.isInteger(oc.seq)) served.add(oc.seq);
  }
  const lastFinal = [...finals].reverse().find((f) => f.t <= s.at);
  const est = lastFinal?.payload?.message?.timestamp ?? epoch0 + s.respT;
  const out = [];
  for (let q = Math.max(1, c.firstSeq ?? 1); q <= c.lastSeq; q++) {
    if (!served.has(q)) out.push({ seq: q, timestamp: est, estimated: true });
  }
  return out;
}
// --prior N (APPROXIMATION): the capture is a brand-new session, so its page never held served rows
// before the turn. N synthetic earlier local rows (seq 1..N, one minute apart, ending a minute before
// the capture began) are put in front of EVERY snapshot, the capture's own local seqs move up by N,
// and every snapshot gets one stable epoch: mid-run {lastSeq: N}, after the turn {lastSeq: N + the
// capture's lastSeq}. What the real gateway would also hold mid-run (a stranded prompt row, imported
// rows of earlier turns) is NOT synthesised.
const PRIOR = Number(flag("prior", 0));
const PRIOR_EPOCH = "prior-epoch-1";
function priorRows() {
  const rows = [];
  for (let i = 1; i <= PRIOR; i++) {
    const userRow = i % 2 === 1;
    rows.push({
      role: userRow ? "user" : "assistant",
      content: [
        {
          type: "text",
          text: userRow
            ? `Earlier question ${(i + 1) / 2}?`
            : `Earlier answer ${i / 2}. A short reply from a previous turn of this session, written before the replayed turn began.`,
        },
      ],
      timestamp: epoch0 - (PRIOR - i + 1) * 60_000,
      __openclaw: { id: `prior-${i}`, seq: i },
    });
  }
  return rows;
}
function withPrior(messages, cursor, hidden) {
  if (PRIOR <= 0) return { messages, cursor, hidden };
  const shifted = messages.map((m) => {
    const oc = m?.__openclaw;
    if (oc && oc.importedFrom == null && Number.isInteger(oc.seq)) {
      return { ...m, __openclaw: { ...oc, seq: oc.seq + PRIOR } };
    }
    return m;
  });
  const capLast = cursor && cursor.epoch != null ? Number(cursor.lastSeq ?? 0) : 0;
  return {
    messages: [...priorRows(), ...shifted],
    cursor: {
      epoch: PRIOR_EPOCH,
      firstSeq: 1,
      lastSeq: PRIOR + capLast,
      hasMoreBefore: false,
      reset: false,
      userRowsBefore: 0,
    },
    hidden: hidden.map((h) => ({ ...h, seq: h.seq + PRIOR })),
  };
}
const history = {
  [NEW_SESSION]: collapsed.map((s) => {
    const { messages: rawMessages = [], cursor: rawCursor, sessionKey: _sk, ...extra } = s.res;
    const { messages, cursor, hidden } = withPrior(rawMessages, rawCursor, hiddenLocalOf(s));
    return mapEpochs(
      rekey({
        at: Math.round(mapT(s.at)),
        tag: s.tag,
        file: s.file,
        reads: s.reads.map((r) => ({ ...r, at: Math.round(mapT(r.at)) })),
        messages,
        ...(cursor !== undefined ? { cursor } : {}),
        hiddenLocal: hidden,
        extra,
      }),
    );
  }),
};

// ── the prompt the page sends ────────────────────────────────────────────────────────────────
let promptText = null;
for (const s of [...snaps].reverse()) {
  const row = (s.res.messages ?? []).find(
    (m) => m.role === "user" && (m.idempotencyKey === runKey || m.__openclaw?.importedFrom == null),
  );
  if (row) {
    promptText = textOf(row);
    break;
  }
}
const runIds = [
  ...new Set(
    inFrames
      .filter((r) => r.event === "chat")
      .map((r) => r.payload?.runId)
      .filter(Boolean),
  ),
];
const runs = runIds.map((id) => ({
  id,
  bind: SEND === "page" && id === runKey ? "page-send" : "none",
}));
const actions = [];
if (SEND === "page" && promptText) {
  actions.push({ at: Math.round(mapT(sendAt)), do: "send", text: promptText, binds: runKey });
}
for (const a of EXTRA_ACTIONS) actions.push(a);
actions.sort((a, b) => a.at - b.at);

// ── optional: sessions.changed pushes a subscribed page would also have received ────────────
if (SYNTH_CHANGED) {
  const lc = frames.filter((f) => f.event === "agent" && f.payload?.stream === "lifecycle");
  const start = lc.find((f) => f.payload?.data?.phase === "start");
  const end = [...lc].reverse().find((f) => f.payload?.data?.phase === "end");
  const row = (live, status, since) => ({
    key: NEW_SESSION,
    sessionKey: NEW_SESSION,
    label: "Replay",
    kind: "direct",
    status,
    run: live ? { live: true, count: 1, since } : { live: false, count: 0 },
  });
  if (start) {
    frames.push({
      at: start.at,
      event: "sessions.changed",
      seq: true,
      synthetic: true,
      payload: {
        sessionKey: NEW_SESSION,
        reason: "start",
        session: row(true, "running", epoch0 + start.at),
      },
    });
  }
  if (end) {
    frames.push({
      at: end.at + 1,
      event: "sessions.changed",
      seq: true,
      synthetic: true,
      payload: { sessionKey: NEW_SESSION, reason: "end", session: row(false, "done") },
    });
  }
  frames.sort((a, b) => a.at - b.at);
}

const lastAt = Math.max(...frames.map((f) => f.at), ...actions.map((a) => a.at ?? 0));
const leftover = JSON.stringify({ frames, history }).split(OLD_SESSION.split(":").pop()).length - 1;
const scenario = {
  name: NAME,
  source: {
    capture: path.resolve(CAP),
    session: OLD_SESSION,
    runKey,
    sendAt,
    finals: finals.map((f) => ({ t: f.t, frameSeq: f.seq, payloadSeq: f.payload?.seq })),
    convertedAt: new Date().toISOString(),
    maxGap: MAX_GAP,
    prior: PRIOR,
  },
  session: NEW_SESSION,
  mainSession: hello?.snapshot?.sessionDefaults?.mainSessionKey ?? "agent:main:main",
  sessionDefaults: hello?.snapshot?.sessionDefaults ?? { mainSessionKey: "agent:main:main" },
  epoch0,
  prerollMs: 15000,
  end: lastAt + END_AFTER,
  runs,
  sessions: [
    {
      key: "agent:main:main",
      sessionKey: "agent:main:main",
      label: "Main",
      title: "Main",
      kind: "direct",
      model: "mock",
    },
    {
      key: NEW_SESSION,
      sessionKey: NEW_SESSION,
      label: "Replay",
      title: "Replay",
      kind: "direct",
      model: "mock",
    },
  ],
  history: {
    "agent:main:main": [
      {
        at: -1,
        tag: "static",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Main tab question." }],
            timestamp: epoch0 - 3_600_000,
            __openclaw: { id: "main-1", seq: 1 },
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Main tab answer, a quiet tab to switch to and back from." },
            ],
            timestamp: epoch0 - 3_590_000,
            __openclaw: { id: "main-2", seq: 2 },
          },
        ],
        cursor: {
          epoch: "mock-main",
          firstSeq: 1,
          lastSeq: 2,
          hasMoreBefore: false,
          reset: false,
          userRowsBefore: 0,
        },
        hiddenLocal: [],
      },
    ],
    ...history,
  },
  frames,
  actions,
  notes: [
    "frames: every gateway frame the capture client received for its session, at the capture's own relative times; frame seq is renumbered per connection by the mock, payload seq is kept",
    "history: served = the latest snapshot whose `at` <= scenario time (before the clock starts: the first one); `before`/`mid`/`end` reads are placed at their response time, `after-final-N` at the final's t+1",
    "history afterSeq/beforeSeq requests are emulated over the snapshot (chat-history-cursor.ts planAfter/planBefore/filterImportsToWindow); a local row the projection hides is listed in hiddenLocal with an ESTIMATED timestamp (the latest final's message.timestamp)",
    "the capture client never called sessions.subscribe, so no sessions.changed pushes are in the frames" +
      (SYNTH_CHANGED ? " (two synthetic ones were added: start/end, marked synthetic:true)" : ""),
    "the capture client is not a Tinker page: presence/health/tick and other sessions' frames are absent",
    `session key ${OLD_SESSION} rewritten to ${NEW_SESSION}; leftover mentions of the old slug: ${leftover}`,
    ...(PRIOR > 0
      ? [
          `--prior ${PRIOR}: SYNTHETIC earlier rows prior-1..prior-${PRIOR} in every snapshot, capture local seqs shifted by ${PRIOR}, one epoch ${PRIOR_EPOCH}; mid-run stranded prompt rows and earlier imports are not synthesised`,
        ]
      : []),
  ],
};
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(scenario, null, 1));
console.log(
  JSON.stringify({
    out: path.resolve(OUT),
    frames: frames.length,
    snapshots: history[NEW_SESSION].length,
    actions: actions.length,
    end: scenario.end,
    epoch0,
    runs,
    oldSession: OLD_SESSION,
    newSession: NEW_SESSION,
    leftoverOldSlug: leftover,
  }),
);
