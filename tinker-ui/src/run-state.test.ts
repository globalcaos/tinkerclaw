import { describe, expect, it } from "vitest";
import {
  bareModelTail,
  clientRunIsFresh,
  liveCountForModel,
  liveRunCountsByModel,
  modelCountKey,
  resolveSessionRunState,
  RUN_STALE_MS,
  sessionHasFreshClientRun,
  type ClientRun,
  type KeyMatcher,
  type SessionRow,
} from "./run-state.js";
import { subagentBelongsToViewedTab } from "./subagent-attribution.js";

const NOW = 1_785_316_000_000;
// The real predicate from app.ts, inlined so the tests exercise the same matching semantics.
const matches = (runKey: string, refKey: string): boolean =>
  runKey === refKey || runKey.endsWith(":" + refKey) || refKey.endsWith(":" + runKey);

const run = (over: Partial<ClientRun> = {}): ClientRun => ({
  sessionKey: "agent:main:tinker:abc",
  provider: "codex",
  model: "gpt-5.6-sol",
  lastEventAt: NOW - 1_000,
  ...over,
});

describe("clientRunIsFresh", () => {
  it("believes a recently-active run and disbelieves a silent one", () => {
    expect(clientRunIsFresh(run({ lastEventAt: NOW - 1_000 }), NOW)).toBe(true);
    expect(clientRunIsFresh(run({ lastEventAt: NOW - RUN_STALE_MS - 1 }), NOW)).toBe(false);
  });

  it("falls back to startedAt, and assumes alive when neither timestamp exists", () => {
    expect(clientRunIsFresh({ sessionKey: "k", startedAt: NOW - RUN_STALE_MS - 1 }, NOW)).toBe(
      false,
    );
    expect(clientRunIsFresh({ sessionKey: "k" }, NOW)).toBe(true);
  });
});

describe("resolveSessionRunState — precedence", () => {
  const key = "agent:main:tinker:abc";

  it("THE BUG: a terminal server status kills an orphaned client entry", () => {
    // Exactly the architect's case: tab + row + count glowed off a stale activeRuns entry while the
    // store already said done. Every surface must now go dark.
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, status: "done" },
      runs: [run()],
      matches,
      now: NOW,
    });
    expect(state.live).toBe(false);
    expect(state.source).toBe("server-terminal");
  });

  it("a server-reported run is live even when the client map is blind to it", () => {
    // The other direction: you open a tab that has been running in another lane. Previously the
    // chat indicator showed nothing because activeRuns is viewed-gated.
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, status: "running" },
      runs: [],
      matches,
      now: NOW,
    });
    expect(state.live).toBe(true);
    expect(state.source).toBe("server-running");
  });

  it("colours a server-reported run from the client map without letting it veto", () => {
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, status: "running" },
      runs: [run({ provider: "anthropic" })],
      matches,
      now: NOW,
    });
    expect(state).toMatchObject({ live: true, provider: "anthropic", source: "server-running" });
  });

  it("treats hasActiveSubagentRun as live", () => {
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, hasActiveSubagentRun: true },
      runs: [],
      matches,
      now: NOW,
    });
    expect(state.live).toBe(true);
  });

  it("falls back to a FRESH client run when the server row has no status (61/315 rows)", () => {
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key },
      runs: [run()],
      matches,
      now: NOW,
    });
    expect(state).toMatchObject({ live: true, source: "client" });
  });

  it("does NOT resurrect a stale client run when the server row has no status", () => {
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key },
      runs: [run({ lastEventAt: NOW - RUN_STALE_MS - 1 })],
      matches,
      now: NOW,
    });
    expect(state.live).toBe(false);
    expect(state.source).toBe("unknown");
  });

  it("THE BUG: a snapshot taken BEFORE the turn ended cannot keep the chat saying 'working'", () => {
    // the architect on Main: the answer finished and Fractal delivered, but a sessions[] row captured
    // mid-turn still said running, and the chat rendered the server-fallback row off it.
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, status: "running" },
      runs: [],
      matches,
      now: NOW,
      rowsFetchedAt: NOW - 30_000,
      endedAt: NOW - 5_000, // client saw it finish AFTER the snapshot was taken
    });
    expect(state.live).toBe(false);
    expect(state.source).toBe("server-terminal");
  });

  it("still believes a server claim from a snapshot taken AFTER the last end", () => {
    // A new turn started; the fresh snapshot outranks an older end stamp.
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, status: "running" },
      runs: [],
      matches,
      now: NOW,
      rowsFetchedAt: NOW - 1_000,
      endedAt: NOW - 20_000,
    });
    expect(state).toMatchObject({ live: true, source: "server-running" });
  });

  it("a fresh client run still wins over a stale-snapshot veto (next turn already started)", () => {
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, status: "running" },
      runs: [run()],
      matches,
      now: NOW,
      rowsFetchedAt: NOW - 30_000,
      endedAt: NOW - 5_000,
    });
    expect(state).toMatchObject({ live: true, source: "client" });
  });

  it("without the stamps, behaviour is unchanged (both optional)", () => {
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, status: "running" },
      runs: [],
      matches,
      now: NOW,
    });
    expect(state.live).toBe(true);
  });

  it("THE REGRESSION: a stale end stamp must not veto a NEWER turn", () => {
    // the architect: "chat thinking indicators but no tab nor sessions highlighting". The end stamp is
    // never cleared and rowsFetchedAt only moves on loadSessions(), so every later server claim
    // was vetoed and non-viewed tabs went dark. A row whose run began after that end stands.
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, status: "running", startedAt: NOW - 2_000 },
      runs: [],
      matches,
      now: NOW,
      rowsFetchedAt: NOW - 60_000,
      endedAt: NOW - 30_000, // previous turn ended after the last fetch...
    });
    // ...but this row's run started after it, so it is a new turn and must be believed.
    expect(state).toMatchObject({ live: true, source: "server-running" });
  });

  it("still vetoes when the row's run predates the end this client saw", () => {
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, status: "running", startedAt: NOW - 60_000 },
      runs: [],
      matches,
      now: NOW,
      rowsFetchedAt: NOW - 45_000,
      endedAt: NOW - 5_000,
    });
    expect(state.live).toBe(false);
  });

  it("is not live when nothing anywhere knows about the session", () => {
    expect(
      resolveSessionRunState({ sessionKey: key, row: undefined, runs: [], matches, now: NOW }).live,
    ).toBe(false);
  });

  it("ignores runs belonging to a different session", () => {
    const state = resolveSessionRunState({
      sessionKey: key,
      row: undefined,
      runs: [run({ sessionKey: "agent:main:tinker:zzz" })],
      matches,
      now: NOW,
    });
    expect(state.live).toBe(false);
  });
});

describe("terminal status vs a client that is still streaming", () => {
  const key = "agent:main:tinker:abc";

  it("THE REGRESSION: a stale 'done' snapshot must not silence a live stream", () => {
    // the architect: "no thinking indicator in the chat but yet the llm is spitting out responses".
    // The snapshot says done, but this client received a delta AFTER that snapshot was taken.
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, status: "done" },
      runs: [run({ lastEventAt: NOW - 1_000 })],
      matches,
      now: NOW,
      rowsFetchedAt: NOW - 20_000,
    });
    expect(state).toMatchObject({ live: true, source: "client" });
  });

  it("but an ORPHANED ghost still dies — it went silent before the snapshot", () => {
    // The original bug must stay fixed: a stale activeRuns entry whose last event predates the
    // fetch is not evidence of anything.
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, status: "done" },
      runs: [run({ lastEventAt: NOW - 40_000 })],
      matches,
      now: NOW,
      rowsFetchedAt: NOW - 20_000,
    });
    expect(state.live).toBe(false);
    expect(state.source).toBe("server-terminal");
  });

  it("without a fetch stamp, a terminal status still wins (unchanged default)", () => {
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, status: "done" },
      runs: [run()],
      matches,
      now: NOW,
    });
    expect(state.live).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE INVARIANT. Three regressions in a row (ghost glow, stale snapshot, veto with
// no expiry) each passed their own unit tests and still shipped a contradiction,
// because nothing asserted that the surfaces AGREE. The models-panel count and the
// per-session resolver — which drives the tab glow, the row glow and the chat
// fallback — must reach the same verdict for the same input, always.
// ─────────────────────────────────────────────────────────────────────────────
describe("cross-surface agreement", () => {
  const key = "agent:main:tinker:abc";
  // FORK 2026-08-04: a catalog id is PROVIDER-QUALIFIED and counts are keyed that way now, so the
  // agreement check goes through the same public lookup the models panel uses instead of reaching
  // into the map with a bare tail. `run()` declares provider "codex", so BOTH lanes resolve to this
  // id — which is the point of the matrix: the two surfaces must still agree cell by cell.
  const MODEL = "codex/gpt-5.6-sol";

  const STATUSES = [undefined, "running", "done", "failed", "killed", "timeout"];
  const CLIENT = [
    { label: "no client run", runs: [] as ClientRun[] },
    {
      label: "fresh client run",
      runs: [run({ sessionKey: key, model: MODEL, lastEventAt: NOW - 500 })],
    },
    {
      label: "silent client run",
      runs: [run({ sessionKey: key, model: MODEL, lastEventAt: NOW - 200_000 })],
    },
  ];
  const STAMPS = [
    { label: "no stamps", rowsFetchedAt: undefined, endedAt: undefined },
    { label: "fetch newer than end", rowsFetchedAt: NOW - 1_000, endedAt: NOW - 10_000 },
    { label: "end newer than fetch", rowsFetchedAt: NOW - 10_000, endedAt: NOW - 1_000 },
  ];
  const STARTED = [undefined, NOW - 500, NOW - 100_000];
  // THE RUN SET is now part of the matrix: absent (legacy gateway), idle, and live.
  const RUNSET = [undefined, { live: false }, { live: true }];

  for (const status of STATUSES) {
    for (const client of CLIENT) {
      for (const stamp of STAMPS) {
        for (const startedAt of STARTED) {
          for (const run of RUNSET) {
            const name = `status=${status ?? "none"} · ${client.label} · ${stamp.label} · startedAt=${startedAt ?? "none"} · run=${run ? (run.live ? "live" : "idle") : "absent"}`;
            it(`agrees: ${name}`, () => {
              const row = { key, status, model: MODEL, startedAt, run };
              const perSession = resolveSessionRunState({
                sessionKey: key,
                row,
                runs: client.runs,
                matches,
                now: NOW,
                rowsFetchedAt: stamp.rowsFetchedAt,
                endedAt: stamp.endedAt,
              });
              const counts = liveRunCountsByModel({
                rows: [row],
                runs: client.runs,
                matches,
                now: NOW,
                rowsFetchedAt: stamp.rowsFetchedAt,
                endedAt: stamp.endedAt === undefined ? undefined : new Map([[key, stamp.endedAt]]),
              });
              const countedLive = liveCountForModel(counts, MODEL) > 0;
              expect(
                countedLive,
                `models panel says ${countedLive}, tab/row/chat say ${perSession.live} (source=${perSession.source})`,
              ).toBe(perSession.live);
            });
          }
        }
      }
    }
  }
});

describe("THE RUN SET decides", () => {
  const key = "agent:main:tinker:abc";

  it("a latched status=running is overruled by an idle run set — the ghost dies", () => {
    // Verified live on 2026-07-29: agent:main:tinker:mqqfw691 carried status="running" with
    // startedAt and no endedAt on disk, while the gateway process held no open run for it.
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, status: "running", startedAt: NOW - 300_000, run: { live: false } },
      runs: [],
      matches,
      now: NOW,
      rowsFetchedAt: NOW - 1_000,
    });
    expect(state.live).toBe(false);
    expect(state.source).toBe("run-set-idle");
  });

  it("a live run set overrules a stale status=done — the silenced-stream bug dies", () => {
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, status: "done", run: { live: true } },
      runs: [],
      matches,
      now: NOW,
      rowsFetchedAt: NOW - 1_000,
    });
    expect(state).toMatchObject({ live: true, source: "run-set" });
  });

  it("answers TOTALLY for a row with no status at all (the 61/348 case)", () => {
    // These rows used to fall through to the viewed-gated client map. Now they are decided.
    expect(
      resolveSessionRunState({
        sessionKey: key,
        row: { key, run: { live: false } },
        runs: [run()],
        matches,
        now: NOW,
        rowsFetchedAt: NOW - 1_000,
      }),
    ).toMatchObject({ live: false, source: "run-set-idle" });
  });

  it("still yields to a client run that is NEWER than the snapshot (turn began after the fetch)", () => {
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, run: { live: false } },
      runs: [run({ lastEventAt: NOW - 500 })],
      matches,
      now: NOW,
      rowsFetchedAt: NOW - 10_000,
    });
    expect(state).toMatchObject({ live: true, source: "client" });
  });

  it("ignores the legacy stamps entirely when the run set is present", () => {
    // The end-stamp veto and the started-after-end guard are not consulted; no combination of
    // them can flip a run-set verdict. This is the property that ends the inversions.
    for (const endedAt of [undefined, NOW - 1, NOW - 99_999]) {
      for (const startedAt of [undefined, NOW - 1, NOW - 99_999]) {
        expect(
          resolveSessionRunState({
            sessionKey: key,
            row: { key, status: "running", startedAt, run: { live: false } },
            runs: [],
            matches,
            now: NOW,
            rowsFetchedAt: NOW - 5_000,
            endedAt,
          }).live,
        ).toBe(false);
      }
    }
  });
});

describe("liveRunCountsByModel", () => {
  it("counts one per live session and agrees with the per-session resolver", () => {
    const rows: SessionRow[] = [
      { key: "s1", status: "running", model: "gpt-5.6-sol" },
      { key: "s2", status: "running", model: "gpt-5.6-sol" },
      { key: "s3", status: "running", model: "claude-opus-5" },
      { key: "s4", status: "done", model: "gpt-5.6-sol" },
    ];
    const counts = liveRunCountsByModel({ rows, runs: [], matches, now: NOW });
    expect(counts.get("gpt-5.6-sol")).toBe(2);
    expect(counts.get("claude-opus-5")).toBe(1);
  });

  it("THE BUG: a stale client run no longer pins a model at 1 once the server says done", () => {
    const rows: SessionRow[] = [
      { key: "agent:main:tinker:abc", status: "done", model: "gpt-5.6-sol" },
    ];
    const counts = liveRunCountsByModel({ rows, runs: [run()], matches, now: NOW });
    expect(counts.size).toBe(0);
  });

  it("still counts a fresh run the server has not described yet", () => {
    const counts = liveRunCountsByModel({ rows: [], runs: [run()], matches, now: NOW });
    // FORK 2026-08-04: the client lane carries provider "codex", so it qualifies its own key.
    expect(liveCountForModel(counts, "codex/gpt-5.6-sol")).toBe(1);
  });

  it("does not double-count a run whose session the server already described", () => {
    const rows: SessionRow[] = [
      { key: "agent:main:tinker:abc", status: "running", model: "gpt-5.6-sol" },
    ];
    const counts = liveRunCountsByModel({ rows, runs: [run()], matches, now: NOW });
    expect(liveCountForModel(counts, "codex/gpt-5.6-sol")).toBe(1);
    expect(counts.size).toBe(1);
  });

  it("drops a stale unknown-to-server run instead of counting it forever", () => {
    const counts = liveRunCountsByModel({
      rows: [],
      runs: [run({ lastEventAt: NOW - RUN_STALE_MS - 1 })],
      matches,
      now: NOW,
    });
    expect(counts.size).toBe(0);
  });

  it("tolerates missing/malformed input", () => {
    expect(liveRunCountsByModel({ rows: null, runs: [], matches, now: NOW }).size).toBe(0);
    expect(liveRunCountsByModel({ rows: undefined, runs: [], matches, now: NOW }).size).toBe(0);
  });
});

describe("bareModelTail / liveCountForModel", () => {
  it("strips a provider prefix and matches a prefixed catalog id", () => {
    expect(bareModelTail("claude-code/claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(bareModelTail("a/b/c")).toBe("b/c");
    expect(bareModelTail("")).toBeUndefined();
    expect(bareModelTail(null)).toBeUndefined();

    const counts = liveRunCountsByModel({
      rows: [{ key: "s1", status: "running", model: "claude-opus-4-8" }],
      runs: [],
      matches,
      now: NOW,
    });
    expect(liveCountForModel(counts, "claude-code/claude-opus-4-8")).toBe(1);
    expect(liveCountForModel(counts, undefined)).toBe(0);
  });

  it("keeps a synthetic id under its own key so it cannot invent a catalog row", () => {
    const counts = liveRunCountsByModel({
      rows: [{ key: "s1", status: "running", model: "gateway-injected" }],
      runs: [],
      matches,
      now: NOW,
    });
    expect(liveCountForModel(counts, "gpt-5.6-sol")).toBe(0);
    expect(counts.get("gateway-injected")).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FORK 2026-08-04 (the architect: "one model running lights up the same model under another provider").
// The models panel renders one row PER PROVIDER, so a bare-tail count key is not a model — it is a
// column of twins. These pin the qualification down, INCLUDING the residue it deliberately keeps:
// the provider-less case is asserted so the day someone deletes the fallback they see exactly what
// they are breaking (every glow, since cc-bridge effort events carry no provider at all).
// ─────────────────────────────────────────────────────────────────────────────
describe("modelCountKey — provider-qualified live counts", () => {
  it("THE BUG: a google run does not light the github-copilot twin", () => {
    const counts = liveRunCountsByModel({
      rows: [
        { key: "s1", status: "running", model: "gemini-3.1-pro-preview", modelProvider: "google" },
      ],
      runs: [],
      matches,
      now: NOW,
    });
    expect(liveCountForModel(counts, "google/gemini-3.1-pro-preview")).toBe(1);
    expect(liveCountForModel(counts, "github-copilot/gemini-3.1-pro-preview")).toBe(0);
  });

  it("qualifies an already-prefixed row model without doubling the prefix", () => {
    const counts = liveRunCountsByModel({
      rows: [
        {
          key: "s1",
          status: "running",
          model: "openai-codex/gpt-5.5",
          modelProvider: "openai-codex",
        },
      ],
      runs: [],
      matches,
      now: NOW,
    });
    expect([...counts.keys()]).toEqual(["openai-codex/gpt-5.5"]);
    expect(liveCountForModel(counts, "openai-codex/gpt-5.5")).toBe(1);
    expect(liveCountForModel(counts, "github-copilot/gpt-5.5")).toBe(0);
  });

  it("re-joins a three-segment openrouter id instead of dropping a segment", () => {
    // The gateway splits a ref at the FIRST slash only, so this provider's model half is itself
    // `moonshotai/kimi-k3`. Both shapes have to land on the one catalog id.
    expect(modelCountKey("openrouter/moonshotai/kimi-k3", "openrouter")).toBe(
      "openrouter/moonshotai/kimi-k3",
    );
    expect(modelCountKey("moonshotai/kimi-k3", "openrouter")).toBe("openrouter/moonshotai/kimi-k3");

    const counts = liveRunCountsByModel({
      rows: [],
      runs: [
        run({
          sessionKey: "agent:main:tinker:kimi",
          provider: "openrouter",
          model: "openrouter/moonshotai/kimi-k3",
        }),
      ],
      matches,
      now: NOW,
    });
    expect(liveCountForModel(counts, "openrouter/moonshotai/kimi-k3")).toBe(1);
  });

  it("a provider-less event still lights by tail — the residue we could not close", () => {
    // cc-bridge effort events report a BARE model id and no provider. Nothing inside such an event
    // can tell two twins apart, so it lights every candidate row. NARROWED, not CLOSED.
    const counts = liveRunCountsByModel({
      rows: [{ key: "s1", status: "running", model: "claude-opus-4-8" }],
      runs: [],
      matches,
      now: NOW,
    });
    expect(counts.get("claude-opus-4-8")).toBe(1);
    expect(liveCountForModel(counts, "claude-code/claude-opus-4-8")).toBe(1);
    expect(liveCountForModel(counts, "anthropic/claude-opus-4-8")).toBe(1);
  });

  it("an exact provider-qualified count wins outright over the bare fallback", () => {
    const counts = liveRunCountsByModel({
      rows: [
        { key: "s1", status: "running", model: "gemini-2.5-pro", modelProvider: "google" },
        { key: "s2", status: "running", model: "gemini-2.5-pro", modelProvider: "google" },
        { key: "s3", status: "running", model: "gemini-2.5-pro" }, // provider-less
      ],
      runs: [],
      matches,
      now: NOW,
    });
    expect(liveCountForModel(counts, "google/gemini-2.5-pro")).toBe(2);
    // The twin sees ONLY the provider-less residue — never the two google runs.
    expect(liveCountForModel(counts, "github-copilot/gemini-2.5-pro")).toBe(1);
  });

  it("keeps the bare tail with no provider, and stays undefined on junk", () => {
    expect(modelCountKey("gpt-4o")).toBe("gpt-4o");
    expect(modelCountKey("openai-codex/gpt-4o", "")).toBe("gpt-4o");
    expect(modelCountKey("gpt-4o", null)).toBe("gpt-4o");
    expect(modelCountKey(undefined, "google")).toBeUndefined();
    expect(modelCountKey("", "google")).toBeUndefined();
    expect(liveCountForModel(new Map(), undefined)).toBe(0);
    expect(liveCountForModel(new Map(), "")).toBe(0);
  });
});

describe("resolveSessionRunState — run-set branch honours the Stop stamp (2026-08-06)", () => {
  // the architect: "qwen 3.8 is thinking and no matter how many times I click on stop, it keeps showing
  // the thinking progress bar". Recurrence of the 2026-08-05 Grok report — that fix only covered
  // the legacy branches; the run-set branch returned before any end-stamp was consulted.
  const key = "agent:main:tinker:abc";
  const FETCH = NOW - 5_000;
  const STOP = NOW - 1_000;

  it("a Stop pressed after the snapshot outranks a run-set still claiming live", () => {
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, run: { live: true } },
      runs: [],
      matches,
      now: NOW,
      rowsFetchedAt: FETCH,
      endedAt: STOP,
    });
    expect(state.live).toBe(false);
    expect(state.source).toBe("run-set-idle");
  });

  it("a genuinely newer client run defeats the Stop veto", () => {
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, run: { live: true } },
      runs: [run({ lastEventAt: FETCH + 2_000 })],
      matches,
      now: NOW,
      rowsFetchedAt: FETCH,
      endedAt: STOP,
    });
    expect(state.live).toBe(true);
    expect(state.source).toBe("run-set");
  });

  it("without a Stop stamp the run set stays authoritative (regression)", () => {
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, run: { live: true } },
      runs: [],
      matches,
      now: NOW,
      rowsFetchedAt: FETCH,
    });
    expect(state.live).toBe(true);
    expect(state.source).toBe("run-set");
  });

  it("a Stop stamp OLDER than the snapshot does not veto (the veto must not outlive its turn)", () => {
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, run: { live: true } },
      runs: [],
      matches,
      now: NOW,
      rowsFetchedAt: NOW - 500,
      endedAt: FETCH, // stop from the PREVIOUS turn; snapshot taken after it
    });
    expect(state.live).toBe(true);
    expect(state.source).toBe("run-set");
  });

  it("a later snapshot of the SAME dying run still loses to Stop", () => {
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, run: { live: true, since: FETCH - 10_000 } },
      runs: [],
      matches,
      now: NOW,
      rowsFetchedAt: NOW - 200,
      endedAt: STOP,
    });
    expect(state.live).toBe(false);
    expect(state.source).toBe("run-set-idle");
  });

  it("a run that began after Stop is a new turn and stays live", () => {
    const state = resolveSessionRunState({
      sessionKey: key,
      row: { key, run: { live: true, since: STOP + 100 } },
      runs: [],
      matches,
      now: NOW,
      rowsFetchedAt: NOW - 200,
      endedAt: STOP,
    });
    expect(state.live).toBe(true);
    expect(state.source).toBe("run-set");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FORK 2026-08-26 — THE CLIENT-LANE PREDICATE. The send path answered "is this session
// busy?" with its own walk of the raw `activeRuns` map and NO freshness bound, so a run
// whose lifecycle:end was dropped queued every later prompt behind a turn that had already
// finished. `sessionHasFreshClientRun` is that question asked ONCE: the same membership
// walk and the same 90s bound the resolver uses, with ownership INJECTED — which is what
// the two matchers below exist to pin down.
// ─────────────────────────────────────────────────────────────────────────────
describe("sessionHasFreshClientRun", () => {
  const REF = "agent:main:tinker:abc";
  const SUB = "agent:main:subagent:9f2c";

  // app.ts composes ownership as `sessionKeyMatches(...) || isSubagentOfViewedSession(...)`
  // (runBelongsToViewedSession). The subagent half is built here from the CANONICAL rule module
  // app.ts itself delegates to, NOT from a prefix re-derived in this test — a re-derived prefix is
  // the exact mistake subagent-attribution.ts was extracted to record (one version counted every
  // tab's subagents on Main and none anywhere else; its repair admitted every tab's subagents into
  // every tab). These deps model the unknown-ownership path (d): the spawn event has not been seen
  // and this is the lone tab attached to the agent.
  const matchesWithSubagents: KeyMatcher = (runKey, refKey) =>
    matches(runKey, refKey) ||
    subagentBelongsToViewedTab(runKey, refKey, {
      ownerOf: () => undefined,
      attachedTabCount: () => 1,
      keyMatches: matches,
      isTab: () => false,
    });

  const mapOf = (...rs: ClientRun[]): Map<string, ClientRun> =>
    new Map(rs.map((r, i): [string, ClientRun] => [`run-${i}`, r]));

  it("(a) believes a run that spoke 30s ago", () => {
    expect(
      sessionHasFreshClientRun({
        runs: mapOf(run({ lastEventAt: NOW - 30_000 })),
        refKey: REF,
        matches,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("(b) THE GHOST: the SAME run gone silent for 120s is not evidence of anything", () => {
    // The module's own reason for existing: "a turn whose end event was dropped goes silent
    // immediately". A raw `runs.size > 0` at a call site cannot tell this apart from case (a).
    expect(
      sessionHasFreshClientRun({
        runs: mapOf(run({ lastEventAt: NOW - 120_000 })),
        refKey: REF,
        matches,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("uses THE bound — RUN_STALE_MS, inclusive — not a second copy of it", () => {
    const busyAtAge = (age: number): boolean =>
      sessionHasFreshClientRun({
        runs: mapOf(run({ lastEventAt: NOW - age })),
        refKey: REF,
        matches,
        now: NOW,
      });
    expect(busyAtAge(RUN_STALE_MS)).toBe(true);
    expect(busyAtAge(RUN_STALE_MS + 1)).toBe(false);
  });

  it("(c) a fresh run for a DIFFERENT session is not this session's evidence", () => {
    expect(
      sessionHasFreshClientRun({
        runs: mapOf(run({ sessionKey: "agent:main:tinker:zzz" })),
        refKey: REF,
        matches,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("(d) a fresh SUBAGENT of the ref session counts — through the caller's matcher", () => {
    const runs = mapOf(run({ sessionKey: SUB }));
    // BOTH directions, so a regression in either half is visible: the STRICT matcher refuses the
    // very same run (subagent keys are minted FLAT under the agent root, so no key-suffix rule can
    // see them), and the canonical ownership rule admits it. run-state.ts contributes the freshness
    // bound and nothing else — if this file ever has to derive the subagent rule to make this pass,
    // the predicate has grown the second derivation it was written to prevent.
    expect(sessionHasFreshClientRun({ runs, refKey: REF, matches, now: NOW })).toBe(false);
    expect(
      sessionHasFreshClientRun({ runs, refKey: REF, matches: matchesWithSubagents, now: NOW }),
    ).toBe(true);
  });

  it("(e) an entry with neither lastEventAt nor startedAt is assumed alive (older build)", () => {
    // Written as a literal rather than `run({ lastEventAt: undefined })` so "neither timestamp
    // exists" is visible in the test text instead of implied by a spread of undefined.
    expect(
      sessionHasFreshClientRun({
        runs: mapOf({ sessionKey: REF }),
        refKey: REF,
        matches,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("(f) empty map, missing refKey and EMPTY refKey are all false — never match-all", () => {
    expect(sessionHasFreshClientRun({ runs: mapOf(), refKey: REF, matches, now: NOW })).toBe(false);
    expect(
      sessionHasFreshClientRun({ runs: mapOf(run()), refKey: undefined, matches, now: NOW }),
    ).toBe(false);
    expect(sessionHasFreshClientRun({ runs: mapOf(run()), refKey: "", matches, now: NOW })).toBe(
      false,
    );
  });

  it("accepts a bare entries iterable as well as a Map (both arms of the union)", () => {
    const entries: Array<[string, ClientRun]> = [["run-0", run()]];
    expect(sessionHasFreshClientRun({ runs: entries, refKey: REF, matches, now: NOW })).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // FORK 2026-08-28 — THE SHAPE THAT COST A PROMPT. Both app.ts call sites pass
  // `activeRuns.values()`: bare run OBJECTS, not `[runId, run]` entries. The original body did
  // `for (const [, clientRun] of runs)`, and array-destructuring an object throws
  // `TypeError: … is not iterable` — at the TOP of send(), before the bubble was pushed and before
  // chat.send fired, while the keydown handler had already blanked the textarea (it does not await
  // send()). The prompt was neither drawn nor delivered until the 5s outbox backstop found it on
  // disk. Every test above passes a Map or bare entries, so the whole suite stayed green.
  //
  // The empty case is half the reason it read as intermittent: zero iterations never destructure, so
  // a first prompt into an idle tab worked and a mid-turn one did not.
  // ───────────────────────────────────────────────────────────────────────────
  it("accepts .values() — the shape app.ts actually passes — instead of throwing", () => {
    const live = mapOf(run());
    expect(sessionHasFreshClientRun({ runs: live.values(), refKey: REF, matches, now: NOW })).toBe(
      true,
    );

    const ghost = mapOf(run({ lastEventAt: NOW - 120_000 }));
    expect(sessionHasFreshClientRun({ runs: ghost.values(), refKey: REF, matches, now: NOW })).toBe(
      false,
    );
  });

  it("agrees with itself across all three shapes — Map, entries and values", () => {
    // The bug was a DISAGREEMENT between shapes (two answered, one threw), so pin that the three
    // spellings of one run set are interchangeable rather than merely non-throwing.
    const m = mapOf(
      run({ lastEventAt: NOW - 30_000 }),
      run({ sessionKey: "agent:main:tinker:zzz" }),
    );
    const ask = (runs: Parameters<typeof sessionHasFreshClientRun>[0]["runs"]): boolean =>
      sessionHasFreshClientRun({ runs, refKey: REF, matches, now: NOW });
    expect(ask(m)).toBe(true);
    expect(ask([...m.entries()])).toBe(true);
    expect(ask([...m.values()])).toBe(true);
  });

  it("an EMPTY values() iterable is false, not a throw (the idle-tab case that masked the bug)", () => {
    expect(
      sessionHasFreshClientRun({ runs: mapOf().values(), refKey: REF, matches, now: NOW }),
    ).toBe(false);
  });

  it("does not attribute an entry with no sessionKey to the session in view", () => {
    expect(
      sessionHasFreshClientRun({ runs: mapOf({ model: "x" }), refKey: REF, matches, now: NOW }),
    ).toBe(false);
  });

  // THE INVARIANT, client lane. Two derivations of one question is the failure this whole module
  // exists to prevent, so the predicate must never disagree with the resolver's own client
  // fallback — the branch a row the server has not described yet falls into.
  it("agrees with resolveSessionRunState's client fallback, run for run", () => {
    for (const lastEventAt of [NOW - 500, NOW - 30_000, NOW - 120_000]) {
      const runs = [run({ lastEventAt })];
      const resolver = resolveSessionRunState({
        sessionKey: REF,
        row: { key: REF },
        runs,
        matches,
        now: NOW,
      }).live;
      const predicate = sessionHasFreshClientRun({
        runs: mapOf(...runs),
        refKey: REF,
        matches,
        now: NOW,
      });
      expect(predicate, `age=${NOW - lastEventAt}ms: resolver says ${resolver}`).toBe(resolver);
    }
  });
});
