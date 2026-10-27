import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeLedgerBlob,
  driverForGatewayClient,
  noteSessionDriver,
  openLedger,
  resetLedgerForTest,
  resolveDriver,
  withLedgerCompletion,
  wrapStreamFnWithLedger,
} from "./llm-ledger.js";

const flush = () => new Promise((r) => setImmediate(() => setImmediate(r)));

let dir: string;
let dbPath: string;
const saved = { ...process.env };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-ledger-"));
  dbPath = path.join(dir, "ledger.sqlite");
  process.env.OPENCLAW_LLM_LEDGER_PATH = dbPath;
  delete process.env.OPENCLAW_LLM_LEDGER;
  delete process.env.OPENCLAW_LLM_LEDGER_DEFAULT_DRIVER;
  resetLedgerForTest();
});

afterEach(() => {
  resetLedgerForTest();
  process.env = { ...saved };
  fs.rmSync(dir, { recursive: true, force: true });
});

function rows() {
  const db = openLedger(dbPath);
  try {
    return db.prepare("SELECT * FROM calls ORDER BY id").all() as Array<Record<string, any>>;
  } finally {
    db.close();
  }
}

const model = { id: "grok-4.6", provider: "xai", api: "openai-completions" } as any;
const context = {
  systemPrompt: "be brief",
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
  tools: [],
};
const reply = {
  role: "assistant",
  content: [{ type: "text", text: "hi" }],
  stopReason: "stop",
  usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0 },
};

describe("wrapStreamFnWithLedger", () => {
  it("records the request, the response and the seat driver without touching the stream", async () => {
    noteSessionDriver("agent:main:main", { id: "ada", source: "seat" });
    const stream = createAssistantMessageEventStream();
    const wrapped = wrapStreamFnWithLedger((() => stream) as any, {
      source: "agent",
      runId: "r1",
      sessionKey: "agent:main:main",
    });
    const out = wrapped(model, context as any, {} as any);
    expect(out).toBe(stream);
    stream.push({ type: "done", reason: "stop", message: reply } as any);
    const seen: string[] = [];
    for await (const ev of stream) seen.push(ev.type);
    expect(seen).toEqual(["done"]);
    await flush();

    const [row] = rows();
    expect(row).toMatchObject({
      driver: "ada",
      driver_source: "seat",
      model: "grok-4.6",
      provider: "xai",
      outcome: "ok",
      input_tokens: 12,
      output_tokens: 3,
      origin_kind: "main",
    });
    expect(decodeLedgerBlob(row.request_gz)).toMatchObject({ systemPrompt: "be brief" });
    expect(decodeLedgerBlob(row.response_gz)).toMatchObject({ content: [{ text: "hi" }] });
  });

  it("records a thrown call as an error and rethrows it", async () => {
    const wrapped = wrapStreamFnWithLedger(
      (() => {
        throw new Error("boom");
      }) as any,
      { source: "agent", sessionKey: "agent:main:cron:nightly:run:1" },
    );
    expect(() => wrapped(model, context as any, {} as any)).toThrow("boom");
    await flush();
    expect(rows()[0]).toMatchObject({ outcome: "error", driver: "cron:nightly" });
  });

  it("does nothing when disabled", async () => {
    process.env.OPENCLAW_LLM_LEDGER = "off";
    const fn = (() => createAssistantMessageEventStream()) as any;
    expect(wrapStreamFnWithLedger(fn, { source: "agent" })).toBe(fn);
    await withLedgerCompletion({ source: "completion" }, context, async () => reply);
    await flush();
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});

describe("drivers", () => {
  it("inherits the parent's driver, names crons and channel peers, then falls back", () => {
    noteSessionDriver("agent:main:main", { id: "ada", source: "seat" });
    expect(
      resolveDriver({ sessionKey: "agent:main:subagent:abc", spawnedBy: "agent:main:main" }),
    ).toEqual({
      id: "ada",
      source: "inherited:seat",
    });
    expect(resolveDriver({ sessionKey: "agent:main:cron:backup:run:9" }).id).toBe("cron:backup");
    expect(resolveDriver({ sessionKey: "agent:main:whatsapp:direct:+3460" })).toEqual({
      id: "whatsapp:direct:+3460",
      source: "channel",
    });
    expect(resolveDriver({ sessionKey: "agent:main:fractal-reflection:x" }).source).toBe("unknown");
    process.env.OPENCLAW_LLM_LEDGER_DEFAULT_DRIVER = "grace";
    expect(resolveDriver({ sessionKey: "agent:main:fractal-reflection:x" })).toEqual({
      id: "grace",
      source: "default",
    });
  });

  it("carries a session's last human driver across a restart via the ledger itself", async () => {
    noteSessionDriver("agent:main:tinker:t1", { id: "ada", source: "seat" });
    await withLedgerCompletion(
      { source: "completion", sessionKey: "agent:main:tinker:t1" },
      context,
      async () => reply,
    );
    await flush();
    resetLedgerForTest(); // forget the in-memory map, as a gateway restart would
    const db = openLedger(dbPath);
    try {
      expect(resolveDriver({ sessionKey: "agent:main:tinker:t1" }, db)).toEqual({
        id: "ada",
        source: "seat:carried",
      });
    } finally {
      db.close();
    }
  });

  it("maps a gateway client's seat to its operator", () => {
    const home = path.join(dir, "home");
    fs.mkdirSync(path.join(home, ".openclaw", "data", "seats"), { recursive: true });
    const seatsFile = path.join(home, ".openclaw", "data", "seats", "operators.json");
    fs.writeFileSync(
      seatsFile,
      JSON.stringify([{ deviceId: "seat-7", operatorId: "ada", displayName: "Ada" }]),
    );
    expect(driverForGatewayClient({ seatId: "seat-7" }, {}, home)).toEqual({
      id: "ada",
      source: "seat",
    });
    expect(driverForGatewayClient({ seatId: "stranger" }, {}, home)).toEqual({
      id: "stranger",
      source: "seat",
    });
    expect(driverForGatewayClient({ connect: { client: { id: "cli" } } }, {}, home)).toEqual({
      id: "client:cli",
      source: "client",
    });
  });
});
