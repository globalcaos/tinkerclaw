import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOW, R, supplies } from "../../../src/shared/thalamus-v4.test-support.js";
import { parseConfig } from "../src/config.js";
import { createRuntime } from "../src/runtime.js";
import { ThalamusStore, type UseRow } from "../src/store.js";

// Phase 1.3 through the real wiring: a typed prompt reaches the short-list seam exactly as the gateway builds it (stamp in
// front, Fractal doctrine behind), and the owner's correction lands as an `enh_pins` row and a `j.correction` row.
//
// CONTROL: on develop 3404572c0a8 nothing read the owner's words for a correction. `enh_pins` held 0 rows in the live
// store (1,171 task rows, 2026-10-10) and no `j.correction` event existed; these cases were red there.

type Emitted = { name: string; record: Record<string, unknown> };
const emitted = vi.hoisted(() => ({ rows: [] as Emitted[] }));
vi.mock("openclaw/plugin-sdk/fork-telemetry", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitEvent: (name: string, record: Record<string, unknown> = {}) => {
    emitted.rows.push({ name, record });
  },
}));

const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops.splice(0)) {
    s();
  }
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
  emitted.rows.length = 0;
});

const SKILLS: Record<string, string> = {
  "/s/youtube-ultimate/SKILL.md":
    "---\nname: youtube-ultimate\ndescription: Download YouTube videos and transcripts.\n---\n",
  "/s/gog/SKILL.md":
    "---\nname: gog\ndescription: Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Sheets, and Docs.\n---\n",
};

async function make() {
  const root = mkdtempSync(join(tmpdir(), "thalamus-correction-"));
  dirs.push(root);
  const store = new ThalamusStore(":memory:");
  const rt = createRuntime({
    config: parseConfig({ dataDir: join(root, "data"), mode: "shadow" }),
    extensionRoot,
    gatewayPort: 18789,
    gatewayCfg: () => ({}),
    onAgentEvent: () => () => {},
    broadcast: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => NOW,
    readBoard: () => ({
      rungs: [R.opus, R.haiku],
      supplies: supplies(),
      contextWindowFor: () => 1_000_000,
      dialIdx: 1,
      builtAtMs: NOW,
    }),
    handPicked: () => false,
    listing: () => [
      { kind: "skill", name: "youtube-ultimate", path: "/s/youtube-ultimate/SKILL.md" },
      { kind: "skill", name: "gog", path: "/s/gog/SKILL.md" },
    ],
    attribute: () => [],
    readText: (p: string) => SKILLS[p] ?? "",
    defer: (fn: () => void) => fn(),
    store,
  });
  stops.push(() => rt.stop());
  await rt.start();
  return { rt, store };
}

const TAB = "agent:main:tinker:mv21z0g0";
const DOCTRINE =
  "\n\n---\n\n**After your reply, append a 🌿 FRACTAL reflection section** on its own line (blank line before it). " +
  "This is the doctrine that governs it:\n\n## Who Fractal is\n\nIt asks what the work meant, again and again.";

function earlierTask(store: ThalamusStore, taskId: string, ts: number, session = TAB): void {
  const row: UseRow = {
    taskId,
    ts,
    session,
    source: "tinker",
    private: false,
    shuffled: false,
    shown: [],
    noneFits: 1,
    listShown: false,
    listReason: "not-asked",
    listSource: "local",
    used: [],
    outcome: "done",
    cardVersions: {},
    questionVersion: 0,
    mode: "shadow",
  };
  store.upsertUse(row);
}

const prompt = (runId: string, text: string, sessionKey = TAB) => ({
  id: runId,
  runId,
  ts: NOW,
  sessionKey,
  text,
  source: "tinker",
  trigger: "user",
});

const corrections = () => emitted.rows.filter((r) => r.name === "j.correction");

describe("the owner's correction, through the runtime", () => {
  it("'Wait, you forgot that we have a youtube skill.' pins the skill on the task before it, and rows use_existing", async () => {
    const t = await make();
    earlierTask(t.store, "run-older", NOW - 600_000);
    earlierTask(t.store, "run-download", NOW - 60_000);
    earlierTask(t.store, "run-other-tab", NOW - 30_000, "agent:main:tinker:other");

    await t.rt
      .shortlist()!
      .prepare(
        prompt(
          "run-now",
          `[Thu 2026-09-03 09:57 GMT+2] Wait, you forgot that we have a youtube skill.${DOCTRINE}`,
        ),
      );

    expect(t.store.listPins()).toMatchObject([
      { taskId: "run-download", cardId: "skill:youtube-ultimate", by: "correction" },
    ]);
    expect(corrections()).toMatchObject([
      { record: { label: "use_existing", n1: 1, fields: { via: "rule" }, runId: "run-now" } },
    ]);
  });

  it("'you have a gmail skill' finds `gog` by its purpose", async () => {
    const t = await make();
    earlierTask(t.store, "run-draft", NOW - 60_000);
    await t.rt
      .shortlist()!
      .prepare(
        prompt(
          "run-now",
          "[Sun 2026-08-30 16:16 GMT+2] No need for the browser, you have a gmail skill",
        ),
      );
    expect(t.store.listPins()).toMatchObject([{ taskId: "run-draft", cardId: "skill:gog" }]);
  });

  it("'ok, do it yourself, you have access' rows dont_ask and pins nothing", async () => {
    const t = await make();
    earlierTask(t.store, "run-ask", NOW - 60_000);
    await t.rt
      .shortlist()!
      .prepare(
        prompt("run-now", "[Sat 2026-10-10 09:21 GMT+2] ok, do it yourself, you have access"),
      );
    expect(t.store.listPins()).toEqual([]);
    expect(corrections().map((r) => r.record.label)).toEqual(["dont_ask"]);
  });

  it("reads nothing from a prompt an agent wrote, even when it quotes him", async () => {
    const t = await make();
    earlierTask(t.store, "run-x", NOW - 60_000);
    await t.rt
      .shortlist()!
      .prepare(
        prompt(
          "run-now",
          "[Sat 2026-10-10 11:31 GMT+2] [Subagent Context] He said: Wait, you forgot that we have a youtube skill. keep going",
        ),
      );
    expect(t.store.listPins()).toEqual([]);
    expect(corrections()).toEqual([]);
  });
});
