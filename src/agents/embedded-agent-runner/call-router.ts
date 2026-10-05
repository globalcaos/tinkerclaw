import type { StreamFn } from "@mariozechner/pi-agent-core";
import { getCallRouter, type CallRouteMeta } from "../../infra/thalamus-call-router.js";

/**
 * FORK 2026-09-30 (THALAMUS v4, design doc section 6.2): tell a registered call router about every model call
 * before it goes out.
 *
 * INERT WHEN OFF. With no router registered when the run is wired, this returns the very function it was given:
 * no wrapper, no extra frame, nothing on the call path. With one registered, the wrapper observes and then calls
 * the original with the SAME `model`, `context` and `options` objects, untouched. The router can neither change
 * what is sent nor break the call: a throw is swallowed, and it is called synchronously, so a router that wants to
 * write anything defers it.
 */
export function wrapStreamFnWithCallRouter(streamFn: StreamFn, meta: CallRouteMeta): StreamFn {
  if (!getCallRouter()) return streamFn;
  let callIndex = 0;
  return ((model, context, options) => {
    const router = getCallRouter();
    if (router) {
      try {
        router.observe({ model, context, meta, callIndex });
      } catch {
        /* fail open: the router never breaks a call */
      }
      callIndex += 1;
    }
    return streamFn(model, context, options);
  }) as StreamFn;
}
