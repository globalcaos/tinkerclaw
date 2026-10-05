// FORK 2026-09-14 — `diagnostic.cpuProfile`: an in-process CPU profile of the gateway's MAIN
// thread, on demand, without restarting anything.
//
// WHY. On 2026-09-14 the gateway's event loop sat at p99 delays of 2–4 s (peaks near 8 s) and
// every chat looked frozen, and there was NO way to see where the main thread's time went:
// `perf_event_paranoid=4` blocks perf, `yama.ptrace_scope` blocks strace/gdb/eu-stack, and the
// gateway's own SIGUSR1 handler RESTARTS it (so Node's "send SIGUSR1 to open the inspector"
// trick would have killed every live turn — again). `node:inspector` works from inside the
// process with no flag at all: a Session connected to the current isolate can drive the V8
// sampling profiler on the very thread that is stalling. This RPC does exactly that and nothing
// else: run the profiler for N ms, write the raw `.cpuprofile` (loadable in Chrome DevTools →
// Performance → Load profile) under ~/.openclaw/logs/profiles/, and answer with a self-time
// summary so the caller can read the hot frames from the terminal.
//
// COST. Sampling at the default 1 ms interval adds a few percent CPU for the duration and is
// off again the moment `Profiler.stop` returns. One profile at a time; duration is clamped.
//
// SCOPE. ADMIN (method-scopes.ts): it reveals function names and file paths of the running
// code — inspection only, never credentials, never write capability.

import * as fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { emitEvent } from "../../infra/events/emit.js";
import type { GatewayRequestHandlers } from "./types.js";

export const CPU_PROFILE_DEFAULT_DURATION_MS = 5_000;
export const CPU_PROFILE_MIN_DURATION_MS = 100;
export const CPU_PROFILE_MAX_DURATION_MS = 60_000;
export const CPU_PROFILE_DEFAULT_SAMPLING_US = 1_000;
export const CPU_PROFILE_MIN_SAMPLING_US = 100;
export const CPU_PROFILE_MAX_SAMPLING_US = 10_000;
export const CPU_PROFILE_DEFAULT_TOP = 25;

export type CpuProfileCallFrame = {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
};
export type CpuProfileNode = {
  id: number;
  callFrame: CpuProfileCallFrame;
  hitCount?: number;
  children?: number[];
};
export type CpuProfile = {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
};

export type CpuProfileHotFrame = {
  functionName: string;
  url: string;
  line: number;
  selfMs: number;
  selfPct: number;
};
export type CpuProfileHotFile = { url: string; selfMs: number; selfPct: number };
export type CpuProfileSummary = {
  totalMs: number;
  sampledMs: number;
  samples: number;
  /** Self time attributed to `(program)`/`(idle)`/`(garbage collector)` pseudo-frames, by name. */
  pseudo: Record<string, number>;
  topFrames: CpuProfileHotFrame[];
  topFiles: CpuProfileHotFile[];
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function resolveDefaultProfileDir(): string {
  return path.join(os.homedir(), ".openclaw", "logs", "profiles");
}

/**
 * Drive V8's sampling profiler on the CURRENT isolate (the thread this runs on) for
 * `durationMs`, then return the raw profile. Never leaves the profiler enabled.
 */
export async function captureMainThreadCpuProfile(opts: {
  durationMs: number;
  samplingIntervalUs: number;
}): Promise<CpuProfile> {
  const session = new Session();
  session.connect();
  try {
    await session.post("Profiler.enable");
    await session.post("Profiler.setSamplingInterval", { interval: opts.samplingIntervalUs });
    await session.post("Profiler.start");
    await new Promise<void>((resolve) => setTimeout(resolve, opts.durationMs));
    const { profile } = (await session.post("Profiler.stop")) as { profile: CpuProfile };
    return profile;
  } finally {
    try {
      await session.post("Profiler.disable");
    } catch {
      // Already disabled or the session is gone — nothing left to release.
    }
    session.disconnect();
  }
}

function frameLabel(frame: CpuProfileCallFrame): string {
  return frame.functionName || "(anonymous)";
}

/** Self time per frame and per file from `samples`/`timeDeltas` (µs), largest first. */
export function summarizeCpuProfile(
  profile: CpuProfile,
  top = CPU_PROFILE_DEFAULT_TOP,
): CpuProfileSummary {
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const selfUsByNode = new Map<number, number>();
  let sampledUs = 0;
  for (let i = 0; i < samples.length; i += 1) {
    // timeDeltas[i] is the gap BEFORE sample i; attribute it to the sample that closed it.
    const delta = Math.max(0, deltas[i] ?? 0);
    sampledUs += delta;
    selfUsByNode.set(samples[i], (selfUsByNode.get(samples[i]) ?? 0) + delta);
  }
  const totalUs = Math.max(sampledUs, profile.endTime - profile.startTime, 1);

  const byFrame = new Map<string, CpuProfileHotFrame & { selfUs: number }>();
  const byFile = new Map<string, number>();
  const pseudo: Record<string, number> = {};
  for (const node of profile.nodes) {
    const selfUs = selfUsByNode.get(node.id) ?? 0;
    if (selfUs <= 0) {
      continue;
    }
    const name = frameLabel(node.callFrame);
    if (!node.callFrame.url && name.startsWith("(") && name.endsWith(")")) {
      pseudo[name] = (pseudo[name] ?? 0) + selfUs / 1000;
      continue;
    }
    const key = `${name}|${node.callFrame.url}|${node.callFrame.lineNumber}`;
    const existing = byFrame.get(key);
    if (existing) {
      existing.selfUs += selfUs;
    } else {
      byFrame.set(key, {
        functionName: name,
        url: node.callFrame.url,
        line: node.callFrame.lineNumber + 1,
        selfUs,
        selfMs: 0,
        selfPct: 0,
      });
    }
    const fileKey = node.callFrame.url || "(native)";
    byFile.set(fileKey, (byFile.get(fileKey) ?? 0) + selfUs);
  }

  const topFrames: CpuProfileHotFrame[] = [...byFrame.values()]
    .toSorted((a, b) => b.selfUs - a.selfUs)
    .slice(0, top)
    .map((frame) => ({
      functionName: frame.functionName,
      url: frame.url,
      line: frame.line,
      selfMs: Math.round(frame.selfUs / 100) / 10,
      selfPct: Math.round((frame.selfUs / totalUs) * 1000) / 10,
    }));
  const topFiles = [...byFile.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([url, selfUs]) => ({
      url,
      selfMs: Math.round(selfUs / 100) / 10,
      selfPct: Math.round((selfUs / totalUs) * 1000) / 10,
    }));
  for (const key of Object.keys(pseudo)) {
    pseudo[key] = Math.round(pseudo[key] * 10) / 10;
  }
  return {
    totalMs: Math.round(totalUs / 100) / 10,
    sampledMs: Math.round(sampledUs / 100) / 10,
    samples: samples.length,
    pseudo,
    topFrames,
    topFiles,
  };
}

let inFlightProfile: Promise<unknown> | null = null;

export const diagnosticCpuProfileHandlers: GatewayRequestHandlers = {
  "diagnostic.cpuProfile": async ({ params, respond }) => {
    const p = (params ?? {}) as {
      durationMs?: unknown;
      samplingIntervalUs?: unknown;
      top?: unknown;
      outDir?: unknown;
    };
    const durationMs = clampInt(
      p.durationMs,
      CPU_PROFILE_DEFAULT_DURATION_MS,
      CPU_PROFILE_MIN_DURATION_MS,
      CPU_PROFILE_MAX_DURATION_MS,
    );
    const samplingIntervalUs = clampInt(
      p.samplingIntervalUs,
      CPU_PROFILE_DEFAULT_SAMPLING_US,
      CPU_PROFILE_MIN_SAMPLING_US,
      CPU_PROFILE_MAX_SAMPLING_US,
    );
    const top = clampInt(p.top, CPU_PROFILE_DEFAULT_TOP, 1, 200);
    const outDir = typeof p.outDir === "string" && p.outDir ? p.outDir : resolveDefaultProfileDir();

    if (inFlightProfile) {
      respond(true, { ok: false, reason: "a cpu profile is already running" }, undefined);
      return;
    }
    const startedAt = new Date();
    const run = (async () => {
      const profile = await captureMainThreadCpuProfile({ durationMs, samplingIntervalUs });
      await fs.mkdir(outDir, { recursive: true });
      const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
      const file = path.join(outDir, `cpu-${stamp}-${process.pid}.cpuprofile`);
      await fs.writeFile(file, JSON.stringify(profile), "utf-8");
      const summary = summarizeCpuProfile(profile, top);
      // TINKER_UI_DESIGN_BIBLE/logging.md §4.1 `gw.profile.captured`: "was a CPU profile taken
      // during this incident, and which one?". Written only AFTER the file exists, so every row has
      // a profile behind it — a refused or failed capture records nothing. `profile_id` is the
      // BASENAME, never the path (L4: it would carry a home directory), and it stays inside the
      // writer's `id` rule. Unguarded on purpose: an emit that stopped existing must fail loudly
      // here, not read as a working call with nothing to say. It is a counted no-op when the events
      // writer is disabled.
      emitEvent("gw.profile.captured", {
        n1: durationMs,
        n2: summary.samples,
        fields: { profile_id: path.basename(file) },
      });
      return { file, summary };
    })();
    inFlightProfile = run;
    try {
      const result = await run;
      respond(
        true,
        {
          ok: true,
          pid: process.pid,
          startedAt: startedAt.toISOString(),
          durationMs,
          samplingIntervalUs,
          ...result,
        },
        undefined,
      );
    } catch (err) {
      respond(true, { ok: false, reason: (err as Error).message }, undefined);
    } finally {
      inFlightProfile = null;
    }
  },
};
