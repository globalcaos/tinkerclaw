import type { StreamFn } from "@mariozechner/pi-agent-core";
/**
 * FORK 2026-09-29 (TINKER_UI_DESIGN_BIBLE/lifecycles.md L4b; spec jarvis-icu
 * docs/superpowers/specs/2026-09-29-seamless-gateway-restart-design.md) — pause an embedded run
 * at the MODEL-CALL BOUNDARY, so a restart wastes no tokens.
 *
 * The gate is the outermost `agent.streamFn` wrapper, and pi-agent-core calls `streamFn` once per
 * model call. Once a pause is requested:
 *   - the call already streaming finishes untouched (its output is paid for, so it is kept);
 *   - that call's tool calls run to completion (pi runs them before the next model call);
 *   - the NEXT call is held: it never reaches the provider, and nothing is appended, so the
 *     transcript ends in the tool results (or the user prompt) and `Agent.continue()` resumes it
 *     after the restart without a new prompt.
 * A held call is released (the restart was called off: it goes to the provider as if nothing
 * happened) or aborted (it ends as a plain aborted call, like `createYieldAbortedResponse`).
 */
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";

export type BoundaryPauseState = "running" | "pause-requested" | "paused";

export type BoundaryPauseGate = {
  readonly state: BoundaryPauseState;
  /** Hold the next model call. A call already streaming is not affected. */
  requestPause(): void;
  /** Cancel a request, or let a held call go to the provider. */
  release(): void;
  wrap(inner: StreamFn): StreamFn;
};

type ModelLike = { api?: string; provider?: string; id?: string };

function abortedMessage(model: ModelLike) {
  return {
    role: "assistant" as const,
    content: [] as Array<{ type: "text"; text: string }>,
    stopReason: "aborted" as const,
    errorMessage: "held at a model-call boundary for a gateway restart, then aborted",
    api: model.api ?? "unknown",
    provider: model.provider ?? "unknown",
    model: model.id ?? "unknown",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  };
}

export function createBoundaryPauseGate(opts: { onPaused?: () => void } = {}): BoundaryPauseGate {
  let state: BoundaryPauseState = "running";
  let releaseHeld: (() => void) | undefined;

  return {
    get state() {
      return state;
    },
    requestPause() {
      if (state === "running") {
        state = "pause-requested";
      }
    },
    release() {
      if (state === "paused") {
        state = "running";
        const go = releaseHeld;
        releaseHeld = undefined;
        go?.();
      } else if (state === "pause-requested") {
        state = "running";
      }
    },
    wrap(inner) {
      return (model, context, options) => {
        if (state !== "pause-requested") {
          return inner(model, context, options);
        }
        state = "paused";
        const held = createAssistantMessageEventStream();
        const signal = options?.signal;
        let finished = false;
        const onAbort = () => {
          if (finished) {
            return;
          }
          finished = true;
          releaseHeld = undefined;
          state = "running";
          const error = abortedMessage(model as ModelLike);
          held.push({ type: "error", reason: "aborted", error } as never);
          held.end();
        };
        if (signal?.aborted) {
          queueMicrotask(onAbort);
          return held;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        releaseHeld = () => {
          if (finished) {
            return;
          }
          finished = true;
          signal?.removeEventListener("abort", onAbort);
          void (async () => {
            try {
              const out = await inner(model, context, options);
              for await (const event of out) {
                held.push(event);
              }
              held.end(await out.result());
            } catch (err) {
              const error = {
                ...abortedMessage(model as ModelLike),
                stopReason: "error" as const,
                errorMessage: String(err),
              };
              held.push({ type: "error", reason: "error", error } as never);
              held.end();
            }
          })();
        };
        opts.onPaused?.();
        return held;
      };
    },
  };
}
