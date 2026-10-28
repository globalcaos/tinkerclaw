/**
 * FORK: Learned Intuition extension entry point -- AMYGDALA safety gate.
 *
 * Evaluates every tool call through the before_tool_call hook: deterministic
 * AEGIS rules, a k-NN novelty channel and a prompt incongruity check. The
 * legacy ONNX ensemble is off unless `legacyEnsemble` is set.
 *
 * Enforcement: `observeOnly` defaults to true, and while it is true NOTHING is
 * blocked in-process — AEGIS hard-block matches included. They are logged and
 * recorded as `enforced: false`. Set `observeOnly: false` to let AEGIS
 * hard-blocks abort the tool call (neural soft-blocks additionally need
 * phase >= 2). See `shouldEnforce` below.
 *
 * Hooks:
 *   - before_tool_call: evaluate action safety (observe-only unless observeOnly:false)
 *   - llm_output: write personality nudge to shared cognitive file (opt-in: personalityNudge)
 *
 * Gateway events: `amygdala.hook` — one per bubble-worthy row the PreToolUse hook spools
 * (deny / owner-intent / owner-pasted-secret / owner-allow), tailed live from
 * `~/.openclaw/data/amygdala/hook-decisions.jsonl` (FORK 2026-10-15).
 *
 * Cross-extension discovery: writes `~/.openclaw/cognitive/learned-intuition.json`
 * and `~/.openclaw/cognitive/personality-nudge.json`.
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
// FORK 2026-08-04 (FOUNDATION #9 — bounded, replicable) — the observability substrate is reached
// through DECLARED plugin-SDK surfaces, never through a relative `../../src/infra/*` path. Two
// independent reasons, either fatal on its own:
//   1. this extension is `publishToNpm: true` and its `files:` list ships only its own directory,
//      so a `../../src/**` specifier cannot resolve in the published tarball at all;
//   2. it sets `openclaw.bundle.stageRuntimeDependencies: true`, so it gets its OWN rolldown graph
//      (tsdown.config.ts:288-341), in which a relative src import INLINES A SECOND COPY of the
//      module. Measured: dist/extensions/tinkerclaw-learned-intuition/index.js was ~194 KB with
//      `emitAgentEvent`/`declareInstrument` duplicated and no edge back to core's copy.
//      `openclaw/plugin-sdk/*` is externalised by isPluginSdkSelfReference(), so exactly one copy
//      stays in the shared graph.
// Be precise about what the duplication did NOT do: it did not fork the liveness registry or the
// event bus. Both resolve their state through `resolveGlobalSingleton` specifically so bundle
// splits converge on one globalThis slot (src/infra/instrument-liveness.ts:96-114,
// src/infra/agent-events.ts:130), and algorithm-metrics is stateless. Deduplicating here is about
// publishability and weight, not about repairing broken state — the false reason would be read as
// an invariant by the next person, and it is the opposite of the real one.
import { onAgentEvent, emitAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  recordAlgorithmOutcome,
  declareInstrument,
  noteInstrumentFired,
} from "openclaw/plugin-sdk/fork-instrumentation";
import { decodePersonalityNudge } from "./src/personality-decoder.js";
import { generateTargetVector, DEFAULT_TARGET_DIMENSIONS } from "./src/personality-seed.js";
import { writePolicySnapshot, policyPaths } from "./src/policy-snapshot.js";
import { evaluateAegisEnforced } from "./src/rule-based-gate.js";
import { AmygdalaHook, type AegisChecker } from "./src/runtime-hook.js";
import type { AmygdalaConfig, PersonalityNudge } from "./src/types.js";

// -- Constants --

const COGNITIVE_DIR = join(homedir(), ".openclaw", "cognitive");
const LEARNED_INTUITION_STATE_PATH = join(COGNITIVE_DIR, "learned-intuition.json");
const PERSONALITY_NUDGE_PATH = join(COGNITIVE_DIR, "personality-nudge.json");
const DATA_DIR = join(homedir(), ".openclaw", "data");
const AMYGDALA_DATA_DIR = join(DATA_DIR, "amygdala");
const AMYGDALA_DECISIONS_PATH = join(DATA_DIR, "amygdala-decisions.jsonl");
// v3.1: the pre-execution PreToolUse hook spools its decisions here; the gateway
// ingests them so REAL enforced denials (the strongest feedback signal) appear
// in the feed instead of being invisible.
const HOOK_DECISIONS_PATH = join(AMYGDALA_DATA_DIR, "hook-decisions.jsonl");

// FORK 2026-10-15: show every action Jev performs at the tool call it judged, in context. The hook spool used to be read on request only (amygdala.feed), so a REAL enforced
// denial reached the chat late and nowhere near the tool call it judged. These helpers turn a
// spool row into the live `amygdala.hook` event the UI pins to the tool row by `toolUseId`.
// Pure and exported so the row → event mapping is tested without a gateway (hook-event.test.ts).

/** Hook decisions the chat shows as a bubble: the hook DID something. `allow` (a sampled benign
 * call) and `observe` (a rule matched, nothing done) are "the ones he skips". */
export const HOOK_BUBBLE_DECISIONS: ReadonlySet<string> = new Set([
  "deny",
  "owner-intent",
  "owner-pasted-secret",
  "owner-allow",
]);

/** Payload of the `amygdala.hook` gateway event (CONTRACT.md "Live hook event"). */
export interface AmygdalaHookEvent {
  id: string;
  ts: number;
  tool: string;
  target: string;
  decision: string;
  rule: string | null;
  toolUseId: string | null;
  sessionId: string | null;
  enforced: boolean;
}

/** Spool `ts` is ISO (the hook writes `new Date().toISOString()`); the event carries ms. 0 when
 * the row has no usable timestamp. */
export function hookRowTs(ts: unknown): number {
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "string") {
    const n = Date.parse(ts);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

/** `hook-` + sha1(ts+toolUseId+rule)[0:12] — the same id on the live event and on the feed row,
 * so the UI dedupes a row it saw live when it later seeds from `amygdala.feed`. */
export function hookRowId(ts: number, toolUseId: string | null, rule: string | null): string {
  const h = createHash("sha1")
    .update(`${ts}${toolUseId ?? ""}${rule ?? ""}`)
    .digest("hex");
  return `hook-${h.slice(0, 12)}`;
}

function optString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** A spool row → the live event, or null when the row is not bubble-worthy (or not a row). */
export function hookEventFromRow(raw: unknown): AmygdalaHookEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const h = raw as Record<string, unknown>;
  const decision = typeof h.decision === "string" ? h.decision : "";
  if (!HOOK_BUBBLE_DECISIONS.has(decision)) return null;
  const ts = hookRowTs(h.ts);
  const rule = optString(h.rule);
  const toolUseId = optString(h.toolUseId);
  return {
    id: hookRowId(ts, toolUseId, rule),
    ts,
    tool: String(h.tool ?? "?"),
    target: String(h.target ?? "").slice(0, 200),
    decision,
    rule,
    toolUseId,
    sessionId: optString(h.sessionId),
    enforced: Boolean(h.enforced),
  };
}

export interface HookSpoolTail {
  start(): void;
  stop(): void;
  /** Read whatever was appended since the last read (the watcher and the poll both call it). */
  pump(): void;
}

/**
 * Tail a JSONL spool from its CURRENT end: `fs.watch` on the parent directory (the file may not
 * exist yet, and a rewrite would orphan a watch on the file itself) plus a slow poll, because
 * inotify is best-effort. The offset resets when the inode changes (rotation) or the size drops
 * below the offset (amygdala.feed truncates the file in place to its last 400 lines); the
 * caller's dedupe decides what is new after a reset. Reads are synchronous, so two triggers can
 * never interleave, and bounded per pump (MAX_PUMP_BYTES, the rest on the next tick) so a
 * runaway spool cannot freeze the gateway.
 */
export function createHookSpoolTail(opts: {
  file: string;
  onRow: (row: Record<string, unknown>) => void;
  /** Poll interval; the directory watch usually fires first. */
  pollMs?: number;
  /** Start at offset 0 and replay existing rows; default: start at the current end. */
  replay?: boolean;
  onError?: (message: string) => void;
}): HookSpoolTail {
  const { file, onRow } = opts;
  const pollMs = opts.pollMs ?? 1500;
  const CHUNK = 64 * 1024;
  const MAX_PUMP_BYTES = 1024 * 1024;
  let running = false;
  let offset = 0;
  let ino = 0;
  let carry: Buffer = Buffer.alloc(0);
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  function statOf(): { size: number; ino: number } | null {
    try {
      const st = statSync(file);
      return { size: st.size, ino: Number(st.ino) };
    } catch {
      return null;
    }
  }

  function emitLines(chunk: Buffer): void {
    const joined = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const nl = joined.lastIndexOf(0x0a);
    if (nl < 0) {
      carry = joined;
      return;
    }
    carry = Buffer.from(joined.subarray(nl + 1));
    for (const line of joined.subarray(0, nl).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // a torn line is not ours to fix
      }
      if (row && typeof row === "object") {
        try {
          onRow(row as Record<string, unknown>);
        } catch (err) {
          opts.onError?.(`row handler failed: ${(err as Error).message}`);
        }
      }
    }
  }

  function ensureWatcher(): void {
    if (watcher) return;
    const name = basename(file);
    try {
      watcher = watch(dirname(file), (_event, changed) => {
        if (!changed || String(changed) === name) pump();
      });
      watcher.on("error", () => undefined);
    } catch {
      watcher = null; // directory not there yet: the poll still pumps and retries the watch
    }
  }

  function pump(): void {
    if (!running) return;
    const st = statOf();
    if (st === null) {
      offset = 0;
      carry = Buffer.alloc(0);
      return;
    }
    if (st.ino !== ino || st.size < offset) {
      ino = st.ino;
      offset = 0;
      carry = Buffer.alloc(0);
    }
    if (st.size === offset) return;
    const stopAt = Math.min(st.size, offset + MAX_PUMP_BYTES);
    let fd: number;
    try {
      fd = openSync(file, "r");
    } catch (err) {
      opts.onError?.(`open failed: ${(err as Error).message}`);
      return;
    }
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      while (offset < stopAt) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, stopAt - offset), offset);
        if (n <= 0) break;
        offset += n;
        emitLines(Buffer.from(buf.subarray(0, n)));
      }
    } catch (err) {
      opts.onError?.(`read failed: ${(err as Error).message}`);
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    if (stopAt < st.size) setImmediate(pump); // backlog: yield, then keep going
  }

  return {
    start() {
      if (running) return;
      running = true;
      const st = statOf();
      ino = st?.ino ?? 0;
      offset = opts.replay ? 0 : (st?.size ?? 0);
      carry = Buffer.alloc(0);
      ensureWatcher();
      timer = setInterval(() => {
        ensureWatcher();
        pump();
      }, pollMs);
      timer.unref?.();
      pump();
    },
    stop() {
      running = false;
      watcher?.close();
      watcher = null;
      if (timer) clearInterval(timer);
      timer = null;
    },
    pump,
  };
}

/**
 * Resolve the amygdala data dir at CALL time rather than at module load.
 *
 * The policy snapshot is the one write here that can DELETE something
 * (cc-hook-settings.json, when enforcement is off), so it must land under the
 * HOME in effect when register() runs. With the module-level constant it did
 * not: a test that redirects HOME still resolved the developer's real
 * ~/.openclaw and disarmed their live enforcement hook. Same value in
 * production, isolatable in tests.
 */
function amygdalaDataDir(): string {
  // $HOME first, homedir() as the fallback: os.homedir() resolves the passwd
  // entry and ignores a redirected HOME, which is precisely what makes it
  // unisolatable in tests. Same value in production.
  return join(process.env.HOME ?? homedir(), ".openclaw", "data", "amygdala");
}
// FORK 2026-06-07: register() runs ~5×/gateway boot; attach the tinker-bridge prudence
// listener ONCE per process or every tool call gets evaluated (and recorded) N times.
let tinkerBridgePrudenceListenerAttached = false;

// FORK 2026-07-28 (instrument-liveness) — the WRITE half of the AMYGDALA personality thermostat.
// Its pair is `amygdala:nudge-injection` in src/agents/system-prompt.ts, and the PAIR is the whole
// point: a nudge that is written but never injected is exactly the inert-component failure the
// liveness registry exists to catch, and NEITHER instrument alone can separate "the thermostat had
// nothing to say" from "it spoke and the prompt discarded it".
//
// Declared at module scope rather than inside register() for two reasons: register() runs
// ~5x/gateway boot (see the note above), and merely LOADING this extension is what should make its
// silence visible — registration is the static property, firing is the dynamic one, and only the
// second is worth anything.
//
// Tolerance is 6h rather than the 30-minute default: the writer only fires when the decoder finds a
// dimension drifted past DRIFT_THRESHOLD, so a quiet stretch is legitimate, not a defect.
const NUDGE_WRITE_INSTRUMENT = {
  id: "amygdala:nudge-write",
  kind: "producer" as const,
  description: "AMYGDALA thermostat writing a personality nudge",
  expectFireWithinMs: 6 * 60 * 60 * 1000,
};
declareInstrument(NUDGE_WRITE_INSTRUMENT);

// -- Helpers --

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function writeSharedState(mode: string, onnxAvailable: boolean): void {
  ensureDir(COGNITIVE_DIR);
  writeFileSync(
    LEARNED_INTUITION_STATE_PATH,
    JSON.stringify(
      {
        active: true,
        mode,
        onnxAvailable,
        version: "1.0.0",
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function writePersonalityNudge(nudge: PersonalityNudge): void {
  ensureDir(COGNITIVE_DIR);
  writeFileSync(
    PERSONALITY_NUDGE_PATH,
    JSON.stringify(
      {
        adjustments: nudge.adjustments,
        strength: nudge.strength,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );
}

/**
 * The git cache counts recent commits per target; its filesystem watcher is OFF (FORK 2026-10-18,
 * TINKER_UI_DESIGN_BIBLE/bug-log.md `freeze-stuck-freezing`). It used to watch every file under
 * ~/src (342,100 entries that day, mostly ~/src/tinkerclaw-wt worktrees) in every process that loads
 * this plugin, and its error handler swallowed the ENOSPC, so it took inotify watches until none
 * were left: gateway 291,747 + one terminal `openclaw` 226,771 of 524,288. systemd could then not
 * watch new units, and a restart froze a chat's worker that nothing thawed. All it bought was
 * marking cached counts stale sooner than the TTL does.
 */
export const GIT_CACHE_DEFAULTS: AmygdalaConfig["git_cache"] = {
  enabled: false,
  watch_paths: [],
  ttl_seconds: 300,
};

function loadAmygdalaConfig(modelsDir: string): AmygdalaConfig {
  // Load config from amygdala.config.json if it exists alongside models
  const configPath = join(modelsDir, "..", "amygdala", "amygdala.config.json");
  let fileConfig: Record<string, unknown> = {};
  try {
    if (existsSync(configPath)) {
      fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    }
  } catch {
    // Use defaults
  }

  // Also try the source-tree config
  const srcConfigPath = join(modelsDir, "..", "..", "src", "amygdala", "amygdala.config.json");
  try {
    if (!Object.keys(fileConfig).length && existsSync(srcConfigPath)) {
      fileConfig = JSON.parse(readFileSync(srcConfigPath, "utf-8"));
    }
  } catch {
    // Use defaults
  }

  const targetVector =
    (fileConfig.target_vector as number[]) || generateTargetVector(DEFAULT_TARGET_DIMENSIONS);

  return {
    enabled: true,
    trust: {
      // FORK 2026-05-30 ("Amygdala" task): crank the LLM personality-nudge
      // influence so we can actually SEE its effect. Both alphas were 0.0 — the
      // nudge had literally zero weight. This is the nudge (LLM tone), NOT the
      // AEGIS tool-gate (that stays observe-only via cfg.observeOnly).
      // FORK 2026-06-04: bumped personality 0.15 → 0.5 for the narration-canary
      // experiment — narration_discipline nudge is the visible tell that the
      // whole personality pipeline is live (the architect's instrument). Prudence stays
      // 0.15 (observe-only safety gate).
      alpha_prudence: 0.15,
      alpha_personality: 0.5,
      alpha_max: 0.5,
      alpha_min: 0.0,
      phase: 4,
      ramp_eta: 0.01,
      reward_threshold: 0.7,
    },
    embedding: {
      encoder_model_path: join(modelsDir, "encoder.onnx"),
      projection_model_path: join(modelsDir, "projection.onnx"),
      internal_dim: 512,
      input_dim: 384,
      window_size: 32,
    },
    prudence: {
      // FORK 2026-06-04: all 5 prudence nets retrained and exported full-weight
      // to top-level hyphenated prudence-{a..e}.onnx (dynamo=False, verified
      // matching PyTorch <1e-4). Full 5/5 ensemble — d/e no longer fall back.
      model_paths: {
        a: join(modelsDir, "prudence-a.onnx"),
        b: join(modelsDir, "prudence-b.onnx"),
        c: join(modelsDir, "prudence-c.onnx"),
        d: join(modelsDir, "prudence-d.onnx"),
        e: join(modelsDir, "prudence-e.onnx"),
      },
      meta_weights: [0.2, 0.2, 0.2, 0.2, 0.2],
      conservative_override_threshold: 0.9,
      disagreement_threshold: 0.3,
    },
    personality: {
      // FORK 2026-06-04: all 5 personality nets retrained and exported to ONNX
      // (export_onnx.py writes top-level hyphenated personality-{a..e}.onnx with
      // dynamo=False so GRU/dual-encoder match PyTorch <1e-4). Full 5/5 ensemble.
      model_paths: {
        a: join(modelsDir, "personality-a.onnx"),
        b: join(modelsDir, "personality-b.onnx"),
        c: join(modelsDir, "personality-c.onnx"),
        d: join(modelsDir, "personality-d.onnx"),
        e: join(modelsDir, "personality-e.onnx"),
      },
      meta_weights: [0.2, 0.2, 0.2, 0.2, 0.2],
      target_vector: targetVector,
      embedding_dim: 64,
    },
    conformal: {
      epsilon: 0.05,
      calibration_window_days: 30,
      calibration_db_path: join(DATA_DIR, "amygdala", "calibration.sqlite"),
    },
    git_cache: { ...GIT_CACHE_DEFAULTS, watch_paths: [...GIT_CACHE_DEFAULTS.watch_paths] },
    training_log: {
      db_path: join(DATA_DIR, "amygdala", "training.sqlite"),
      max_entries: 100000,
      rolling_window_days: 90,
    },
    action_type_map: {},
    target_type_map: {},
    reversibility_map: {},
    blast_radius_map: {} as Record<string, never>,
  };
}

/**
 * Whether a gate result actually aborts the tool call.
 *
 * - `observeOnly: true` (the default) never blocks anything, AEGIS included.
 * - `observeOnly: false`: a `hard_block` (AEGIS floor) blocks at any phase; a
 *   neural `soft_block` blocks only from phase 2 upward.
 */
export function shouldEnforce(
  result: { blocked: boolean; decision: string },
  observeOnly: boolean,
  phase: number,
): boolean {
  if (!result.blocked || observeOnly) {
    return false;
  }
  return result.decision === "hard_block" || phase !== 1;
}

// -- Plugin definition --

export default definePluginEntry({
  id: "tinkerclaw-learned-intuition",
  name: "Learned Intuition",
  description:
    "AMYGDALA safety gate — deterministic AEGIS rules, k-NN novelty and incongruity checks " +
    "on tool calls. Observe-only by default; blocking needs observeOnly:false.",
  register(api: OpenClawPluginApi) {
    const cfg = api.pluginConfig as {
      phase?: number;
      alphaPrudence?: number;
      aegisEnabled?: boolean;
      observeOnly?: boolean;
      modelsDir?: string;
      legacyEnsemble?: boolean;
      personalityNudge?: boolean;
      hookEnforcement?: boolean;
    };
    const log = api.logger;

    // Defaults are the CONSERVATIVE ones the manifest documents. They used to
    // read `phase ?? 4` / `alphaPrudence ?? 0.15` — cranking the nudge to its
    // top phase — while openclaw.plugin.json advertised 1 and 0.0, so the
    // documented default was not the shipped one. Code and manifest now agree,
    // and the strong setting is something an owner asks for.
    // observeOnly stays true by default so the whole in-process gate, AEGIS
    // hard-blocks included, only OBSERVES (no surprise tool aborts) — set
    // observeOnly:false in plugin config to enable active blocking.
    const phase = cfg.phase ?? 1;
    const observeOnly = cfg.observeOnly ?? true;
    const modelsDir = cfg.modelsDir ?? join(homedir(), "src", "tinkerclaw", "models", "amygdala");
    // v3.1: the 5-net ONNX ensemble is retired from the decision path (default
    // off). Pre-execution enforcement is OPT-IN: writing cc-hook-settings.json
    // registers a PreToolUse hook with matcher "*" that tinker-bridge passes to
    // every spawn, where it can synchronously deny any tool call. A plugin
    // should not install a deny-hook across a whole machine merely by being
    // loaded — that is the owner's call, made explicitly.
    const legacyEnsemble = cfg.legacyEnsemble === true;
    const hookEnforcement = cfg.hookEnforcement === true;
    // The nudge is text written to steer the model on later turns (Identity
    // Persistence injects it), so it is a prompt mutation with an extra step.
    const personalityNudge = cfg.personalityNudge === true;

    // Ensure data directory exists
    const dataDir = amygdalaDataDir();
    ensureDir(dataDir);

    // Build full config
    const amygdalaConfig = loadAmygdalaConfig(modelsDir);
    amygdalaConfig.trust.alpha_prudence = cfg.alphaPrudence ?? 0.0; // manifest-documented default
    amygdalaConfig.trust.phase = Math.min(4, Math.max(1, phase)) as 1 | 2 | 3 | 4;
    amygdalaConfig.legacyEnsemble = legacyEnsemble;
    amygdalaConfig.hookEnforcement = hookEnforcement;
    amygdalaConfig.novelty = {
      enabled: true,
      k: 10,
      cap: 5000,
      minRef: 100,
      recalibrateEvery: 200,
    };

    // v3.1: compile the AEGIS rule snapshot + (when enforcement is on) the
    // claude-cli settings file that wires the pre-execution PreToolUse hook into
    // every tinker-bridge spawn. Done at register() so the artifacts exist before the
    // next worker spawns. Best-effort: a write failure must not break the gate.
    try {
      // One amygdala (2026-10-15, the architect): the pre-execution hook now ships with tinkerclaw-amygdala
      // (hooks/hard-rules.mjs, registered first in its hook settings). This plugin no longer installs one: two
      // copies would run the hard rules twice. The snapshot still writes policy.json and drops the old settings.
      const snap = writePolicySnapshot(dataDir, { hookEnforcement: false });
      log.info(
        `[learned-intuition] policy snapshot written (hookEnforcement=${hookEnforcement}, ` +
          `settings=${snap.settingsWritten}, hook=${snap.staged ?? "none"})`,
      );
    } catch (err) {
      log.warn(`[learned-intuition] policy snapshot failed: ${(err as Error).message}`);
    }

    // FORK 2026-05-30: wire the AEGIS absolute-veto checker. It was previously
    // unwired (`new AmygdalaHook(config)` with no checker) → the paper's §4.11
    // "absolute block" tier was dead code. This deterministic checker (backed by
    // the rule-based destructive-pattern gate) runs as the AEGIS pre-check on
    // EVERY tool call AND the post-check even when the ONNX gate allows — so the
    // hard veto holds in both ONNX and rule-based-fallback modes. Disable only by
    // explicit config `aegisEnabled:false`.
    // v3.1: use the enforce-aware checker so only `enforce:true` destructive
    // rules hard-block in-process now that the native block is wired through the
    // host (credential-PATTERN rules stay observe-only — anti-cry-wolf).
    const aegisChecker: AegisChecker = {
      async check(action) {
        const argsStr = action.metadata ? JSON.stringify(action.metadata) : action.target;
        const r = evaluateAegisEnforced(action.type, argsStr);
        return {
          blocked: r.decision === "hard_block",
          rule_id: r.rule ?? undefined,
          reason: r.explanation,
        };
      },
    };
    const hook = new AmygdalaHook(
      amygdalaConfig,
      cfg.aegisEnabled === false ? undefined : aegisChecker,
    );

    // Initialize asynchronously (non-blocking)
    let initPromise: Promise<void> | null = null;
    let hookReady = false;

    function ensureInit(): Promise<void> {
      if (!initPromise) {
        initPromise = hook
          .initialize()
          .then(() => {
            hookReady = true;
            // v3.1 default mode is "novelty" (AEGIS floor + k-NN ask channel);
            // "onnx"/"rule-based" only when the legacy ensemble is re-enabled.
            const mode = legacyEnsemble
              ? hook.useRuleBasedFallback
                ? "rule-based"
                : "onnx"
              : "novelty";
            writeSharedState(mode, !hook.useRuleBasedFallback);
            // FORK 2026-07-28 (instrument-liveness) — in rule-based fallback the llm_output nudge
            // writer returns BEFORE it can write, so `amygdala:nudge-write` cannot fire and would be
            // reported BROKEN forever: that is the false alarm `conditional` exists for. Re-declare
            // here, once init has resolved and `useRuleBasedFallback` is finally known.
            // declareInstrument merges (Object.assign), so the accumulated counters survive, and
            // passing `undefined` explicitly CLEARS a previously-set reason instead of letting it go
            // stale — silence must stop being excused the moment the models do load.
            declareInstrument({
              ...NUDGE_WRITE_INSTRUMENT,
              conditional: !personalityNudge
                ? "personalityNudge is off (opt-in) — the nudge writer returns before writing"
                : hook.useRuleBasedFallback
                  ? "ONNX personality models unavailable — the nudge writer returns before writing"
                  : undefined,
            });
            const nov = hook.noveltyStatus;
            log.info(
              `[learned-intuition] ready — mode=${mode}, phase=${phase}, observeOnly=${observeOnly}, ` +
                `hookEnforcement=${hookEnforcement}, personalityNudge=${personalityNudge}, novelty=${nov.enabled ? `ref=${nov.size},thr=${nov.threshold?.toFixed(3)}` : "warming"}`,
            );
            if (hook.useRuleBasedFallback) {
              log.warn(
                `[learned-intuition] ONNX models not available at ${modelsDir}. Using rule-based fallback.`,
              );
              // FORK 2026-05-30: surface the REAL load failure via the structured
              // logger (raw console.error inside the gate is not captured).
              const diags = hook.gateLoadErrors;
              log.warn(
                `[learned-intuition] onnx load diagnostics: ${diags.length ? diags.join(" || ") : "no errors collected — model loop did not run (loadOrt returned null without a captured import error)"}`,
              );
            }
          })
          .catch((err) => {
            log.error(`[learned-intuition] initialization failed: ${err}`);
            hookReady = false;
          });
      }
      return initPromise;
    }

    // Kick off init immediately
    ensureInit();

    // FORK 2026-06-04: cache the Personality net's REAL situational embedding
    // from the most recent tool-call evaluation, so the llm_output nudge writer
    // can decode against it instead of a neutral 0.5 stub (which discarded the
    // net entirely). Null until the first tool call of the session.
    let lastPersonalityEmbedding: Float32Array | null = null;

    // FORK 2026-06-07 (Amygdala feedback loop / M−1.A): keep a ring buffer of the
    // most recent gate decisions so the Tinker UI can SHOW exactly what AMYGDALA
    // does, and broadcast each one live. The gate previously only logged them.
    interface AmygdalaDecisionRecord {
      ts: string;
      tool: string;
      target: string;
      decision: string; // allow | soft_block | hard_block
      blocked: boolean;
      enforced: boolean; // actually aborted (vs observe-only)
      reason?: string;
      mode: "onnx" | "rules" | "novelty" | "hook";
      prudence?: number;
      disagreement?: number;
      // v3.1 fields
      novelty?: number;
      disposition?: string; // proceed | ask | block
      signal?: string; // aegis | novelty | incongruity | none
    }
    const recentDecisions: AmygdalaDecisionRecord[] = [];
    const MAX_DECISIONS = 200;

    // -- Hook: before_tool_call --
    api.on(
      "before_tool_call",
      async (event: { toolName: string; args: Record<string, unknown> }) => {
        await ensureInit();
        if (!hookReady) {
          return; // Initialization failed -- allow everything
        }

        try {
          const argsStr = JSON.stringify(event.args ?? {});
          const target =
            (event.args?.path as string) ||
            (event.args?.file_path as string) ||
            (event.args?.command as string) ||
            (event.args?.target as string) ||
            event.toolName;

          const result = await hook.evaluate(
            { type: event.toolName, target, metadata: event.args },
            {
              topic: "active-session",
              emotionalState: "calm",
              effortHoursEstimate: 0.5,
              correctionCount24h: 0,
              automationDepth: 1,
              confirmationEnabled: false,
              confirmationLevel: "none",
              sessionDuration: 0,
              actionCount: 0,
              topicCentroid: null,
              recentTranscripts: [],
            },
          );

          const modeTag = result.ruleBasedFallback ? "[rules]" : "[onnx]";

          // FORK 2026-06-04: capture the net's real read of this situation so the
          // personality nudge reflects what the net actually saw, not neutral 0.5.
          const personEmb = result.evaluation?.personality?.combined_embedding;
          if (personEmb && personEmb.length > 0) {
            lastPersonalityEmbedding = personEmb;
          }

          // FORK 2026-06-07 (Amygdala feedback loop): record + broadcast this decision
          // so the Tinker UI can show exactly what the gate just did.
          const evAny = result.evaluation as unknown as {
            prudence?: { combined?: { confidence?: number }; ensemble_disagreement?: number };
          } | null;
          const enforced = shouldEnforce(result, observeOnly, phase);
          const record: AmygdalaDecisionRecord = {
            ts: new Date().toISOString(),
            tool: event.toolName,
            target: String(target).slice(0, 200),
            decision: result.decision,
            blocked: result.blocked,
            enforced,
            reason: result.response?.reason,
            mode: legacyEnsemble ? (result.ruleBasedFallback ? "rules" : "onnx") : "novelty",
            prudence:
              typeof evAny?.prudence?.combined?.confidence === "number"
                ? evAny.prudence.combined.confidence
                : undefined,
            disagreement:
              typeof evAny?.prudence?.ensemble_disagreement === "number"
                ? evAny.prudence.ensemble_disagreement
                : undefined,
            novelty: typeof result.novelty === "number" ? result.novelty : undefined,
            disposition: result.disposition,
            signal: result.signal,
          };
          recentDecisions.push(record);
          if (recentDecisions.length > MAX_DECISIONS) recentDecisions.shift();
          try {
            (api as unknown as { broadcast?: (e: string, p: unknown) => void }).broadcast?.(
              "amygdala-decision",
              record,
            );
          } catch {
            /* broadcast is best-effort */
          }

          if (result.blocked) {
            // AEGIS `hard_block`s abort independent of the trust ramp, but only
            // once the owner has turned observe-only off (observeOnly:false).
            // Under the default observeOnly:true every block — AEGIS included —
            // is logged as WOULD-block and the call proceeds, as documented.
            const isAegisHardBlock = result.decision === "hard_block";
            if (enforced) {
              log.warn(
                `[learned-intuition] ${modeTag} ${isAegisHardBlock ? "AEGIS BLOCKED" : "BLOCKED"} ${event.toolName}(${target}): ${result.response?.reason ?? "unknown"}`,
              );
              // FORK 2026-06-11 (v3.1): the host's before_tool_call dispatcher
              // honors `{block, blockReason}` (src/plugins/hooks.ts → pi-tools.
              // before-tool-call.ts: `if (hookResult?.block)`), NOT the
              // `{abort, message}` shape this returned before — so the native gate
              // never actually blocked. Return the shape the host reads.
              return {
                block: true,
                blockReason: result.response?.reason ?? "Action blocked by safety gate.",
              };
            }
            // Observe-only (default) or a neural soft-block during the trust ramp.
            log.info(
              `[learned-intuition] ${modeTag} WOULD block ${event.toolName}(${target}): ${result.response?.reason ?? "unknown"} (observe-only, not blocking)`,
            );
          } else {
            log.debug(`[learned-intuition] ${modeTag} allowed ${event.toolName}(${target})`);
          }
        } catch (err) {
          // Safety gate failures must never block the agent
          log.error(`[learned-intuition] evaluation error (allowing action): ${err}`);
        }
      },
      { priority: 10 }, // High priority -- safety should evaluate early
    );

    // -- Hook: llm_output (personality nudge writer; opt-in) --
    api.on("llm_output", async (_event: { text: string }) => {
      if (!personalityNudge) {
        return; // Opt-in: see cfg.personalityNudge
      }
      await ensureInit();
      if (!hookReady || hook.useRuleBasedFallback) {
        return; // No personality nudge without ONNX models
      }

      try {
        // Generate personality nudge from target vector
        const targetVector = amygdalaConfig.personality.target_vector;
        if (targetVector.length > 0) {
          // FORK 2026-06-04: decode against the net's REAL combined_embedding from
          // the last tool-call evaluation (cached above). Falls back to neutral 0.5
          // only before any tool call has run this session. This is what makes the
          // Personality NET actually steer the nudge, not just the static target.
          const baselineEmbedding =
            lastPersonalityEmbedding ??
            new Float32Array(amygdalaConfig.personality.embedding_dim).fill(0.5);
          const nudge = decodePersonalityNudge(
            baselineEmbedding,
            targetVector,
            amygdalaConfig.trust.alpha_personality,
          );

          if (nudge.adjustments.length > 0) {
            writePersonalityNudge(nudge);
            // FORK 2026-07-28 — fire AFTER the file is on disk, never before. writePersonalityNudge
            // is synchronous and can throw (writeFileSync), so reaching this line is the proof that
            // the nudge is persisted at PERSONALITY_NUDGE_PATH; claiming "written" any earlier would
            // make the ledger lie in precisely the direction that hides the bug.
            noteInstrumentFired(
              "amygdala:nudge-write",
              `${nudge.adjustments.length} adjustments, strength=${nudge.strength}`,
            );
            // Parts only, never a ratio (algorithm-metrics rule 2): `adjustments` is the COUNT of
            // nudge lines actually persisted, not the strings. `embeddingSource` segments rows
            // decoded from the Personality net's REAL combined_embedding from rows decoded against
            // the neutral 0.5 stub — without it a paper cannot tell a measured nudge from a
            // placeholder one, which is the same measured-vs-estimated contamination rule 3 forbids.
            recordAlgorithmOutcome({
              algorithm: "persona-nudge",
              variant: "amygdala-thermostat",
              outcome: "written",
              metrics: {
                adjustments: nudge.adjustments.length,
                strength: nudge.strength,
              },
              provenance: {
                adjustments: "local-measured",
                strength: "local-measured",
              },
              config: {
                embeddingSource: lastPersonalityEmbedding ? "personality-net" : "neutral-stub",
              },
            });
            log.debug(
              `[learned-intuition] personality nudge written: ${nudge.adjustments.length} adjustments`,
            );
          }
        }
      } catch (err) {
        log.error(`[learned-intuition] personality nudge error: ${err}`);
      }
    });

    // -- Hook: llm_input (v3.1 incongruity gut-check, observe-only) --
    // FORK 2026-06-11 (v3.1): on every user prompt, run the validated clause-cosine
    // incongruity check (AUROC 0.896). If a request's action clause and purpose
    // clause don't cohere ("build a chess game so I can water my plants"), surface
    // an ASK signal in the Amygdala feed. Observe-only — it never blocks or alters
    // the turn; it just shows the gut-feeling that something doesn't add up. Fires
    // for tinker-bridge too (llm_input runs in attempt.ts, which wraps the provider).
    api.on("llm_input", async (event: { prompt?: string; runId?: string; sessionId?: string }) => {
      await ensureInit();
      if (!hookReady || !event.prompt) return;
      try {
        const inc = await hook.checkIncongruity(event.prompt);
        if (!inc) return;
        const record: AmygdalaDecisionRecord = {
          ts: new Date().toISOString(),
          tool: "user-prompt",
          target: `${inc.head} ⇏ ${inc.tail}`.slice(0, 200),
          decision: "soft_block",
          blocked: false,
          enforced: false,
          reason: `Incongruous request (clause coherence ${inc.similarity.toFixed(3)}): the action and its stated purpose don't add up — would ask before acting.`,
          mode: "novelty",
          disposition: "ask",
          signal: "incongruity",
        };
        recentDecisions.push(record);
        if (recentDecisions.length > MAX_DECISIONS) recentDecisions.shift();
        try {
          mkdirSync(DATA_DIR, { recursive: true });
          appendFileSync(AMYGDALA_DECISIONS_PATH, JSON.stringify(record) + "\n");
        } catch {
          /* persistence is best-effort */
        }
        try {
          (api as unknown as { broadcast?: (e: string, p: unknown) => void }).broadcast?.(
            "amygdala-decision",
            record,
          );
        } catch {
          /* broadcast is best-effort */
        }
        if (event.runId) {
          emitAgentEvent({
            runId: event.runId,
            sessionKey: event.sessionId ?? "",
            stream: "lifecycle",
            data: { phase: "amygdala-decision", ...record },
          });
        }
        log.info(
          `[learned-intuition] incongruity flagged (sim=${inc.similarity.toFixed(3)}): "${inc.head}" ⇏ "${inc.tail}" — would ask`,
        );
      } catch (err) {
        log.warn(`[learned-intuition] incongruity check failed: ${(err as Error).message}`);
      }
    });

    // FORK 2026-06-07 (Phase 1a): tinker-bridge tools bypass the native before_tool_call
    // gate (Claude Code owns its tool loop), so the prudence nets never saw them. Here
    // we subscribe to tinker-bridge tool-start events (marked `tinkerBridge`) and run the SAME
    // hook.evaluate the native gate uses — so the REAL ONNX prudence verdict appears in
    // the feed for the way Jarvis actually runs. Observe-only: the tool already executed
    // by the time we see the event, so we report (enforced:false), never abort.
    if (!tinkerBridgePrudenceListenerAttached) {
      tinkerBridgePrudenceListenerAttached = true;
      onAgentEvent((evt) => {
        const d = evt.data as Record<string, unknown> | undefined;
        if (!d || evt.stream !== "tool" || d.phase !== "start" || d.tinkerBridge !== true) {
          return;
        }
        void (async () => {
          try {
            await ensureInit();
            if (!hookReady) {
              return;
            }
            const toolName = String(d.name ?? "?");
            const args = (d.args ?? {}) as Record<string, unknown>;
            const target =
              (args.path as string) ||
              (args.file_path as string) ||
              (args.command as string) ||
              (args.target as string) ||
              toolName;
            const result = await hook.evaluate(
              { type: toolName, target, metadata: args },
              {
                topic: "active-session",
                emotionalState: "calm",
                effortHoursEstimate: 0.5,
                correctionCount24h: 0,
                automationDepth: 1,
                confirmationEnabled: false,
                confirmationLevel: "none",
                sessionDuration: 0,
                actionCount: 0,
                topicCentroid: null,
                recentTranscripts: [],
              },
            );
            const personEmb = result.evaluation?.personality?.combined_embedding;
            if (personEmb && personEmb.length > 0) {
              lastPersonalityEmbedding = personEmb;
            }
            // FORK 2026-06-11 (v3.1): fix the null-field bug — `prudence.combined`
            // is an OBJECT (read `.confidence`), and the disagreement field is
            // `ensemble_disagreement`, not `disagreement`. In the default novelty
            // path these are absent; novelty/disposition/signal carry the read.
            const evAny = result.evaluation as unknown as {
              prudence?: { combined?: { confidence?: number }; ensemble_disagreement?: number };
            } | null;
            const record: AmygdalaDecisionRecord = {
              ts: new Date().toISOString(),
              tool: toolName,
              target: String(target).slice(0, 200),
              decision: result.decision,
              blocked: result.blocked,
              enforced: false, // tinker-bridge observe path: the tool already ran (real enforcement is the PreToolUse hook)
              reason: result.response?.reason,
              mode: legacyEnsemble ? (result.ruleBasedFallback ? "rules" : "onnx") : "novelty",
              prudence:
                typeof evAny?.prudence?.combined?.confidence === "number"
                  ? evAny.prudence.combined.confidence
                  : undefined,
              disagreement:
                typeof evAny?.prudence?.ensemble_disagreement === "number"
                  ? evAny.prudence.ensemble_disagreement
                  : undefined,
              novelty: typeof result.novelty === "number" ? result.novelty : undefined,
              disposition: result.disposition,
              signal: result.signal,
            };
            recentDecisions.push(record);
            if (recentDecisions.length > MAX_DECISIONS) recentDecisions.shift();
            try {
              mkdirSync(DATA_DIR, { recursive: true });
              appendFileSync(AMYGDALA_DECISIONS_PATH, JSON.stringify(record) + "\n");
            } catch {
              /* persistence is best-effort */
            }
            emitAgentEvent({
              runId: evt.runId,
              sessionKey: evt.sessionKey,
              stream: "lifecycle",
              data: { phase: "amygdala-decision", ...record },
            });
          } catch (err) {
            log.warn(
              `[learned-intuition] tinker-bridge prudence eval failed: ${(err as Error).message}`,
            );
          }
        })();
      });
    }

    // FORK 2026-10-15: show each performed action where it happened. Tail the hook
    // spool and broadcast each bubble-worthy row as `amygdala.hook` the moment the hook writes
    // it. Owned by a plugin service so the gateway's stop closes the watcher and the poll (no
    // leaked fd/timer across reloads). Dedupe by id (an insertion-ordered Set, oldest evicted),
    // plus an age floor at service start: after the feed trims the file the tail re-reads its
    // tail end, and rows from before this service started are history the UI already seeds
    // from `amygdala.feed`. Same data dir as the policy snapshot (HOME-aware), which is the
    // dir the hook spools into.
    const broadcast = (name: string, payload: unknown): void => {
      try {
        (api as unknown as { broadcast?: (e: string, p: unknown) => void }).broadcast?.(
          name,
          payload,
        );
      } catch {
        /* broadcast is best-effort */
      }
    };
    const hookSpoolFile = join(dataDir, "hook-decisions.jsonl");
    const seenHookIds = new Set<string>();
    const MAX_SEEN_HOOK_IDS = 2000;
    let hookTailStartedAt = 0;
    const hookTail = createHookSpoolTail({
      file: hookSpoolFile,
      onRow: (row) => {
        const ev = hookEventFromRow(row);
        if (!ev) return; // allow / observe: the ones he skips
        // ts 0 = no usable timestamp: it cannot sit on the timeline, so it is skipped too.
        if (ev.ts < hookTailStartedAt - 5_000) return;
        if (seenHookIds.has(ev.id)) return;
        seenHookIds.add(ev.id);
        if (seenHookIds.size > MAX_SEEN_HOOK_IDS) {
          const oldest = seenHookIds.keys().next().value;
          if (oldest !== undefined) seenHookIds.delete(oldest);
        }
        broadcast("amygdala.hook", ev);
      },
      onError: (message) => log.debug(`[learned-intuition] hook tail: ${message}`),
    });
    api.registerService({
      id: "tinkerclaw-learned-intuition-hook-tail",
      start() {
        hookTailStartedAt = Date.now();
        hookTail.start();
        log.info(`[learned-intuition] hook spool tail started (${hookSpoolFile})`);
      },
      stop() {
        hookTail.stop();
      },
    });

    // FORK 2026-06-07 (Amygdala feedback loop / M−1.A): expose the live feed to the
    // Tinker UI — recent gate decisions (most recent first), the current personality
    // nudge, mode/alphas, and rollup counts.
    api.registerGatewayMethod("amygdala.feed", async ({ respond }) => {
      let nudge: unknown = null;
      try {
        if (existsSync(PERSONALITY_NUDGE_PATH)) {
          nudge = JSON.parse(readFileSync(PERSONALITY_NUDGE_PATH, "utf-8"));
        }
      } catch {
        /* ignore */
      }
      let state: unknown = null;
      try {
        if (existsSync(LEARNED_INTUITION_STATE_PATH)) {
          state = JSON.parse(readFileSync(LEARNED_INTUITION_STATE_PATH, "utf-8"));
        }
      } catch {
        /* ignore */
      }
      // FORK 2026-06-07: merge the durable tinker-bridge decision log (JSONL) with the
      // in-memory native ring, newest-first. tinker-bridge tools bypass the native gate,
      // so this file is the only durable source for Claude-Code runs; merging it here
      // makes the feed survive a UI refresh and a gateway restart.
      type FeedDecision = Record<string, unknown> & { ts?: number | string };
      let persisted: FeedDecision[] = [];
      try {
        if (existsSync(AMYGDALA_DECISIONS_PATH)) {
          let lines = readFileSync(AMYGDALA_DECISIONS_PATH, "utf-8").split("\n").filter(Boolean);
          if (lines.length > 1200) {
            lines = lines.slice(-400);
            try {
              writeFileSync(AMYGDALA_DECISIONS_PATH, lines.join("\n") + "\n");
            } catch {
              /* ignore trim failure */
            }
          }
          persisted = lines
            .map((l) => {
              try {
                return JSON.parse(l) as FeedDecision;
              } catch {
                return null;
              }
            })
            .filter((d): d is FeedDecision => d !== null);
        }
      } catch {
        /* ignore */
      }
      // v3.1: ingest the pre-execution hook spool (REAL enforced denials from the
      // tinker-bridge / claude-cli path). Map its rows into the feed's decision shape.
      let hookRows: FeedDecision[] = [];
      try {
        if (existsSync(HOOK_DECISIONS_PATH)) {
          let lines = readFileSync(HOOK_DECISIONS_PATH, "utf-8").split("\n").filter(Boolean);
          if (lines.length > 1200) {
            lines = lines.slice(-400);
            try {
              writeFileSync(HOOK_DECISIONS_PATH, lines.join("\n") + "\n");
            } catch {
              /* ignore trim failure */
            }
          }
          hookRows = lines
            .map((l) => {
              try {
                const h = JSON.parse(l) as Record<string, unknown>;
                const dcn = String(h.decision ?? "allow");
                const mapped =
                  dcn === "deny" ? "hard_block" : dcn === "observe" ? "soft_block" : "allow";
                // FORK 2026-10-15: carry the raw hook decision, the tool call it judged and the
                // same id the live `amygdala.hook` event uses, so the chat can pin the row to
                // its tool row and dedupe against what it already saw live. `decision` stays
                // the mapped value the feed panel reads (hard_block / soft_block / allow).
                const rule = optString(h.rule);
                const toolUseId = optString(h.toolUseId);
                return {
                  id: hookRowId(hookRowTs(h.ts), toolUseId, rule),
                  ts: h.ts,
                  tool: h.tool,
                  target: h.target,
                  decision: mapped,
                  hookDecision: dcn,
                  rule,
                  toolUseId,
                  sessionId: optString(h.sessionId),
                  blocked: dcn !== "allow",
                  enforced: Boolean(h.enforced),
                  mode: "hook",
                  signal: "aegis",
                  reason: h.rule ? `AEGIS [${h.rule}]` : undefined,
                } as FeedDecision;
              } catch {
                return null;
              }
            })
            .filter((d): d is FeedDecision => d !== null);
        }
      } catch {
        /* ignore */
      }
      const tms = (d: FeedDecision): number =>
        typeof d.ts === "number" ? d.ts : d.ts ? Date.parse(String(d.ts)) || 0 : 0;
      const merged = [...persisted, ...hookRows, ...(recentDecisions as unknown as FeedDecision[])]
        .sort((a, b) => tms(b) - tms(a))
        .slice(0, 300);
      respond(true, {
        ready: hookReady,
        mode: hook.useRuleBasedFallback ? "rules" : "onnx",
        onnxAvailable: !hook.useRuleBasedFallback,
        observeOnly,
        phase,
        alphas: {
          prudence: amygdalaConfig.trust.alpha_prudence,
          personality: amygdalaConfig.trust.alpha_personality,
        },
        nudge,
        state,
        decisions: merged,
        counts: {
          total: merged.length,
          flagged: merged.filter((d) => Boolean(d.blocked)).length,
          enforced: merged.filter((d) => Boolean(d.enforced)).length,
        },
      });
    });

    log.info(
      `[learned-intuition] registered — phase=${phase}, observeOnly=${observeOnly}, modelsDir=${modelsDir}`,
    );
  },
});
