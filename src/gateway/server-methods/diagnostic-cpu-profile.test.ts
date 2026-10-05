import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureMainThreadCpuProfile,
  CPU_PROFILE_MAX_DURATION_MS,
  CPU_PROFILE_MIN_DURATION_MS,
  CPU_PROFILE_MIN_SAMPLING_US,
  diagnosticCpuProfileHandlers,
  summarizeCpuProfile,
} from "./diagnostic-cpu-profile.js";

// FORK 2026-09-14 — the only profiler this host allows: perf and ptrace are locked down and
// SIGUSR1 restarts the gateway, so the profile has to come from inside the process.

function burnCpuForMs(ms: number): number {
  const end = performance.now() + ms;
  let x = 0;
  while (performance.now() < end) {
    x += Math.sqrt(x + 1);
  }
  return x;
}

type Handler = (args: {
  params: unknown;
  respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
}) => Promise<void>;

async function callHandler(params: unknown): Promise<Record<string, unknown>> {
  let payload: unknown;
  const handler = diagnosticCpuProfileHandlers["diagnostic.cpuProfile"] as unknown as Handler;
  await handler({
    params,
    respond: (_ok, p) => {
      payload = p;
    },
  });
  return payload as Record<string, unknown>;
}

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("diagnostic.cpuProfile", () => {
  it("profiles the main thread and names the hot function in the summary", async () => {
    setTimeout(() => {
      burnCpuForMs(150);
    }, 5);
    const profile = await captureMainThreadCpuProfile({ durationMs: 350, samplingIntervalUs: 200 });
    expect(Array.isArray(profile.nodes)).toBe(true);
    expect(profile.nodes.length).toBeGreaterThan(0);

    const summary = summarizeCpuProfile(profile, 15);
    expect(summary.totalMs).toBeGreaterThan(0);
    expect(summary.samples).toBeGreaterThan(0);
    const hot = summary.topFrames.find((f) => f.functionName === "burnCpuForMs");
    expect(hot, JSON.stringify(summary.topFrames.slice(0, 5))).toBeDefined();
    expect(hot?.selfMs).toBeGreaterThan(50);
    expect(hot?.selfPct).toBeGreaterThan(10);
    expect(summary.topFiles.some((f) => f.url.includes("diagnostic-cpu-profile.test"))).toBe(true);
  });

  it("summarizes a synthetic profile deterministically", () => {
    const summary = summarizeCpuProfile(
      {
        startTime: 0,
        endTime: 10_000,
        nodes: [
          {
            id: 1,
            callFrame: { functionName: "(root)", url: "", lineNumber: -1, columnNumber: -1 },
          },
          {
            id: 2,
            callFrame: { functionName: "hot", url: "file:///a.js", lineNumber: 9, columnNumber: 0 },
          },
          {
            id: 3,
            callFrame: {
              functionName: "warm",
              url: "file:///b.js",
              lineNumber: 0,
              columnNumber: 0,
            },
          },
          {
            id: 4,
            callFrame: {
              functionName: "(garbage collector)",
              url: "",
              lineNumber: -1,
              columnNumber: -1,
            },
          },
        ],
        samples: [2, 2, 3, 4, 2],
        timeDeltas: [2_000, 2_000, 2_000, 2_000, 2_000],
      },
      10,
    );
    expect(summary.totalMs).toBe(10);
    expect(summary.sampledMs).toBe(10);
    expect(summary.pseudo["(garbage collector)"]).toBe(2);
    expect(summary.topFrames[0]).toEqual({
      functionName: "hot",
      url: "file:///a.js",
      line: 10,
      selfMs: 6,
      selfPct: 60,
    });
    expect(summary.topFrames[1].functionName).toBe("warm");
    expect(summary.topFiles[0]).toEqual({ url: "file:///a.js", selfMs: 6, selfPct: 60 });
  });

  it("the handler writes a .cpuprofile file and answers with the summary", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cpuprofile-"));
    tmpDirs.push(dir);
    const payload = await callHandler({ durationMs: 150, samplingIntervalUs: 500, outDir: dir });
    expect(payload.ok).toBe(true);
    expect(payload.durationMs).toBe(150);
    expect(payload.samplingIntervalUs).toBe(500);
    expect(payload.pid).toBe(process.pid);
    const file = payload.file as string;
    expect(file.startsWith(dir)).toBe(true);
    expect(file.endsWith(".cpuprofile")).toBe(true);
    const raw = JSON.parse(await fs.readFile(file, "utf-8")) as { nodes: unknown[] };
    expect(Array.isArray(raw.nodes)).toBe(true);
    const summary = payload.summary as { topFrames: unknown[]; totalMs: number };
    expect(Array.isArray(summary.topFrames)).toBe(true);
    expect(summary.totalMs).toBeGreaterThan(0);
  });

  it("clamps the duration and refuses a second concurrent profile", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cpuprofile-"));
    tmpDirs.push(dir);
    const first = callHandler({ durationMs: 400, outDir: dir });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await callHandler({ durationMs: 10, outDir: dir });
    expect(second.ok).toBe(false);
    expect(String(second.reason)).toMatch(/already running/);
    const done = await first;
    expect(done.ok).toBe(true);

    // Clamps: a 1 ms request runs for the minimum; a 1 µs sampling interval becomes the minimum.
    const clamped = await callHandler({ durationMs: 1, samplingIntervalUs: 1, outDir: dir });
    expect(clamped.ok).toBe(true);
    expect(clamped.durationMs).toBe(CPU_PROFILE_MIN_DURATION_MS);
    expect(clamped.samplingIntervalUs).toBe(CPU_PROFILE_MIN_SAMPLING_US);
    expect(CPU_PROFILE_MAX_DURATION_MS).toBeGreaterThan(CPU_PROFILE_MIN_DURATION_MS);
  }, 20_000);
});
