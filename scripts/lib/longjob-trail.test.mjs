// node --test scripts/lib/longjob-trail.test.mjs
//
// The agents behind a long job and their work (lib/longjob-trail.mjs), on a fake tree: a cgroup with
// the job's processes, Claude Code's per-process session files, project transcripts and a Workflow
// journal. Nothing here touches the real ~/.claude or systemd.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  compactLine,
  createTrailReader,
  jobTrailBody,
  parseCursors,
  projectSlug,
  readTranscript,
} from "./longjob-trail.mjs";

let tmp;
const line = (o) => `${JSON.stringify(o)}\n`;
const ts = (s) => `2026-11-14T19:${s}.000Z`;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "longjob-trail-"));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("compactLine", () => {
  it("keeps thinking, narration and tool calls, with the model", () => {
    const out = compactLine({
      type: "assistant",
      timestamp: ts("47:43"),
      message: {
        model: "claude-opus-5-5",
        content: [
          { type: "thinking", thinking: "", signature: "x" },
          { type: "text", text: "Reading the brief." },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    assert.deepEqual(
      out.map((e) => [e.t, e.model]),
      [
        ["thinking", "claude-opus-5-5"],
        ["text", "claude-opus-5-5"],
        ["tool", "claude-opus-5-5"],
      ],
    );
    assert.equal(out[2].id, "t1");
    assert.deepEqual(out[2].input, { command: "ls" });
    assert.equal(out[0].ts, Date.parse(ts("47:43")));
  });

  it("reads the prompt, tool results and compactions; drops bookkeeping and meta lines", () => {
    assert.deepEqual(compactLine({ type: "user", message: { content: "Do the brief." } }), [
      { t: "prompt", text: "Do the brief.", ts: null },
    ]);
    const res = compactLine({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] },
        ],
      },
    });
    assert.deepEqual(res, [{ t: "result", id: "t1", content: "ok", isError: false, ts: null }]);
    assert.deepEqual(compactLine({ type: "user", isMeta: true, message: { content: "x" } }), []);
    assert.deepEqual(compactLine({ type: "api-request-blob", hash: "h" }), []);
    assert.deepEqual(compactLine({ type: "attachment" }), []);
    assert.deepEqual(compactLine({ type: "api-request", timestamp: ts("48:50") }), [
      { t: "req", ts: Date.parse(ts("48:50")) },
    ]);
    assert.equal(compactLine({ type: "system", subtype: "compact_boundary" })[0].t, "note");
  });

  it("shortens a huge tool input string instead of shipping it whole", () => {
    const [e] = compactLine({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "w", name: "Write", input: { content: "a".repeat(50_000) } },
        ],
      },
    });
    assert.ok(e.input.content.length < 5_000);
    assert.match(e.input.content, /more characters/);
  });
});

describe("readTranscript", () => {
  it("returns complete lines only, and resumes from the cursor", () => {
    const f = path.join(tmp, "partial.jsonl");
    const first = line({ type: "user", message: { content: "go" } });
    fs.writeFileSync(f, `${first}{"type":"assistant","message":{"content":[{"type":"te`);
    const a = readTranscript(f, 0);
    assert.deepEqual(
      a.entries.map((e) => e.t),
      ["prompt"],
    );
    assert.equal(a.next, Buffer.byteLength(first));
    fs.appendFileSync(f, 'xt","text":"done"}]}}\n');
    const b = readTranscript(f, a.next);
    assert.deepEqual(
      b.entries.map((e) => [e.t, e.text]),
      [["text", "done"]],
    );
    assert.equal(b.next, fs.statSync(f).size);
    assert.equal(readTranscript(f, b.next).entries.length, 0);
  });

  it("says reset when the file is now shorter than the cursor", () => {
    const f = path.join(tmp, "short.jsonl");
    fs.writeFileSync(f, line({ type: "user", message: { content: "again" } }));
    const r = readTranscript(f, 10_000);
    assert.equal(r.reset, true);
    assert.equal(r.entries.length, 1);
  });

  it("skips a single line longer than the read window", () => {
    const f = path.join(tmp, "long.jsonl");
    const big = line({ type: "api-request-blob", body: "b".repeat(5000) });
    const small = line({ type: "user", message: { content: "after" } });
    fs.writeFileSync(f, big + small);
    const a = readTranscript(f, 0, 1000);
    assert.equal(a.entries.length, 0);
    assert.equal(a.next, Buffer.byteLength(big));
    const b = readTranscript(f, a.next, 1000);
    assert.deepEqual(
      b.entries.map((e) => e.text),
      ["after"],
    );
  });
});

describe("createTrailReader", () => {
  it("finds the claude process in the job's unit, then remembers it after it exits", async () => {
    const home = path.join(tmp, "home1");
    const cg = "/user.slice/app.slice/longjob-weave.service";
    const cgroupRoot = path.join(tmp, "cg1");
    const procRoot = path.join(tmp, "proc1");
    fs.mkdirSync(path.join(cgroupRoot, cg), { recursive: true });
    fs.writeFileSync(path.join(cgroupRoot, cg, "cgroup.procs"), "100\n101\n");
    fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
    const sid = "9c65f49a-de21-47e7-8e08-738658ada356";
    const cwd = "/home/x/work/run1";
    fs.writeFileSync(
      path.join(home, ".claude", "sessions", "101.json"),
      JSON.stringify({ pid: 101, sessionId: sid, cwd, startedAt: 1000, name: "run1-6b" }),
    );
    const proj = path.join(home, ".claude", "projects", projectSlug(cwd));
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(
      path.join(proj, `${sid}.jsonl`),
      line({ type: "user", message: { content: "Read the brief." } }) +
        line({ type: "assistant", message: { content: [{ type: "text", text: "On it." }] } }),
    );
    const units = [];
    const reader = createTrailReader({
      home,
      cgroupRoot,
      procRoot,
      controlGroup: async (unit) => {
        units.push(unit);
        return cg;
      },
    });
    const job = { id: "weave", status: "running" };
    const [a] = await reader.trail(job, new Map(), true);
    assert.deepEqual(units, ["longjob-weave.service"]);
    assert.equal(a.key, sid);
    assert.equal(a.label, "run1-6b");
    assert.equal(a.running, true);
    assert.deepEqual(
      a.entries.map((e) => e.t),
      ["prompt", "text"],
    );
    // The process left the unit: the agent stays on the trail, no longer running, read from its cursor.
    fs.writeFileSync(path.join(cgroupRoot, cg, "cgroup.procs"), "100\n");
    const [b] = await reader.trail(job, new Map([[sid, a.next]]), true);
    assert.equal(b.key, sid);
    assert.equal(b.running, false);
    assert.equal(b.entries.length, 0);
  });

  it("reads a Workflow journal named on the worker's command line", async () => {
    const home = path.join(tmp, "home2");
    fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
    const cg = "/app.slice/longjob-fan.service";
    const cgroupRoot = path.join(tmp, "cg2");
    const procRoot = path.join(tmp, "proc2");
    fs.mkdirSync(path.join(cgroupRoot, cg), { recursive: true });
    fs.writeFileSync(path.join(cgroupRoot, cg, "cgroup.procs"), "200\n");
    const wf = path.join(tmp, "wf_abc");
    fs.mkdirSync(wf, { recursive: true });
    const journal = path.join(wf, "journal.jsonl");
    fs.writeFileSync(
      journal,
      line({ type: "launched" }) +
        line({ type: "started", agentId: "a1", label: "hunt:one" }) +
        line({ type: "started", agentId: "a2", label: "hunt:two" }) +
        line({ type: "result", agentId: "a1" }),
    );
    for (const id of ["a1", "a2"]) {
      fs.writeFileSync(
        path.join(wf, `agent-${id}.jsonl`),
        line({
          type: "assistant",
          isSidechain: true,
          message: { content: [{ type: "text", text: `I am ${id}` }] },
        }),
      );
    }
    fs.mkdirSync(path.join(procRoot, "200"), { recursive: true });
    fs.writeFileSync(
      path.join(procRoot, "200", "cmdline"),
      ["node", "longjob.mjs", "run-worker", "--id", "fan", "--journal", journal].join("\0"),
    );
    const reader = createTrailReader({ home, cgroupRoot, procRoot, controlGroup: async () => cg });
    const agents = await reader.trail({ id: "fan", status: "running" }, new Map(), true);
    assert.deepEqual(
      agents.map((a) => [a.key, a.label, a.running, a.entries[0]?.text]),
      [
        ["a1", "hunt:one", false, "I am a1"],
        ["a2", "hunt:two", true, "I am a2"],
      ],
    );
  });

  it("uses what the worker recorded in state.json when nothing runs any more", async () => {
    const home = path.join(tmp, "home3");
    const sid = "11111111-2222-3333-4444-555555555555";
    const proj = path.join(home, ".claude", "projects", projectSlug("/tmp/unit1"));
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(
      path.join(proj, `${sid}.jsonl`),
      line({ type: "user", message: { content: "unit 1" } }),
    );
    let asked = 0;
    const reader = createTrailReader({
      home,
      controlGroup: async () => {
        asked++;
        return "";
      },
    });
    const agents = await reader.trail(
      {
        id: "batch",
        status: "done",
        agentSessions: [{ sessionId: sid, cwd: "/tmp/unit1", startedAt: 5 }],
      },
      new Map(),
      false,
    );
    assert.equal(asked, 0, "a job that is not running is not looked up in systemd");
    assert.deepEqual(
      agents.map((a) => [a.key, a.running, a.entries[0]?.text]),
      [[sid, false, "unit 1"]],
    );
  });
});

describe("parseCursors", () => {
  it("keeps well-formed key:byte pairs only", () => {
    assert.deepEqual(
      [...parseCursors("abc-1:120,bad,../x:3,a2:0").entries()],
      [
        ["abc-1", 120],
        ["a2", 0],
      ],
    );
    assert.equal(parseCursors(null).size, 0);
  });
});

describe("jobTrailBody", () => {
  const reader = {
    calls: [],
    async trail(job, cursors, running) {
      this.calls.push({ id: job.id, cursors: [...cursors.entries()], running });
      return job.id === "plain" ? [] : [{ key: "k", entries: [] }];
    },
  };
  const root = () => path.join(tmp, "jobs");
  const writeJob = (id, state, done) => {
    const dir = path.join(root(), `lj-${id}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ id, ...state }));
    if (done) {
      fs.writeFileSync(path.join(dir, "done.json"), JSON.stringify(done));
    }
    return dir;
  };

  it("answers a running job with its agents, read from the page's cursors", async () => {
    writeJob("live", { status: "running", label: "Weave", session: "s1", startedAt: 7 });
    const r = await jobTrailBody(reader, root(), "live", "k:42");
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "running");
    assert.equal(r.body.endedAt, null);
    assert.equal(r.body.label, "Weave");
    assert.deepEqual(reader.calls.at(-1), { id: "live", cursors: [["k", 42]], running: true });
  });

  it("reports an ended job by its done.json, and a worker that stopped writing as ended", async () => {
    writeJob("fin", { status: "running" }, { status: "ok", finishedAt: 99 });
    const fin = await jobTrailBody(reader, root(), "fin", "");
    assert.equal(fin.body.status, "ok");
    assert.equal(fin.body.endedAt, 99);
    assert.equal(reader.calls.at(-1).running, false);
    const dir = writeJob("dead", { status: "running", intervalMs: 5000 });
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(path.join(dir, "state.json"), old, old);
    const dead = await jobTrailBody(reader, root(), "dead", "");
    assert.equal(dead.body.status, "ended");
    assert.equal(reader.calls.at(-1).running, false);
  });

  it("gives a job with no agent the tail of its own output, colour and redrawn lines removed", async () => {
    const dir = writeJob("plain", { status: "running" });
    fs.writeFileSync(path.join(dir, "job.log"), "start\n\x1b[32m10%\r50%\r90%\x1b[0m\n");
    const r = await jobTrailBody(reader, root(), "plain", "");
    assert.deepEqual(r.body.agents, []);
    assert.equal(r.body.log, "start\n90%\n");
  });

  it("refuses a bad id and answers 404 for an unknown job", async () => {
    assert.equal((await jobTrailBody(reader, root(), "../etc", "")).status, 400);
    assert.equal((await jobTrailBody(reader, root(), "nope", "")).status, 404);
  });
});
