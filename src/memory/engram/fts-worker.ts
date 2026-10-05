/**
 * FORK 2026-09-23 (plan task 16) — the engram FTS worker thread's entry point.
 *
 * Spawned by fts-worker-client.ts; everything it does is in fts-worker-core.ts. Requests are
 * answered one at a time, in arrival order: each is one synchronous `ftsSearch` over this
 * thread's own parsed copy of the event file.
 *
 * FORK 2026-09-25 (TINKER_UI_DESIGN_BIBLE/logging.md §4.9, §9 step 5): it also answers a `stats`
 * probe with its OWN isolate's heap statistics. The thread shares the gateway's RSS, so its heap is
 * the only memory attributably its own, and only this thread can read it: v8.getHeapStatistics()
 * reports the CALLING isolate. The probe queues behind a running search like any request. The
 * protocol types are imported type-only, so no main-thread code loads into this thread.
 */

import { performance } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { parentPort } from "node:worker_threads";
import type {
  FtsWorkerIsolateStats,
  FtsWorkerStatsRequest,
  FtsWorkerStatsResponse,
} from "./fts-worker-client.js";
import { createFtsWorkerHandler, type FtsWorkerRequest } from "./fts-worker-core.js";

if (!parentPort) {
  throw new Error("fts-worker must run in a worker thread");
}
const port = parentPort;
const handle = createFtsWorkerHandler();

function isStatsRequest(
  message: FtsWorkerRequest | FtsWorkerStatsRequest,
): message is FtsWorkerStatsRequest {
  return (message as { type?: unknown }).type === "stats";
}

function isolateStats(): FtsWorkerIsolateStats {
  const heap = getHeapStatistics();
  // This thread's own CPU. A Node without threadCpuUsage answers null — never the process's CPU
  // under the thread's name, which would count the gateway's work as the thread's.
  const cpu = typeof process.threadCpuUsage === "function" ? process.threadCpuUsage() : null;
  return {
    usedHeapBytes: heap.used_heap_size,
    totalHeapBytes: heap.total_heap_size,
    heapLimitBytes: heap.heap_size_limit,
    externalBytes: heap.external_memory,
    cpuUsec: cpu === null ? null : cpu.user + cpu.system,
    uptimeMs: performance.now(),
  };
}

port.on("message", (message: FtsWorkerRequest | FtsWorkerStatsRequest) => {
  if (isStatsRequest(message)) {
    const response: FtsWorkerStatsResponse = {
      id: message.id,
      ok: true,
      type: "stats",
      isolate: isolateStats(),
    };
    port.postMessage(response);
    return;
  }
  port.postMessage(handle(message));
});
