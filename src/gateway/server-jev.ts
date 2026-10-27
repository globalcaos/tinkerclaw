/**
 * The gateway's Jev status feed: one `jev.status` event to every open page when the availability changes (a token found,
 * Jev answered, the token refused, the token gone), and the poll that notices a key file appearing, so Jev arms without a
 * restart even when no plugin has started it. The snapshot never carries the token.
 */
import { onJevChange, startJevWatch } from "../infra/jev/availability.js";

export function startJevStatusFeed(
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void,
): () => void {
  const stopWatch = startJevWatch();
  const offChange = onJevChange((s) => broadcast("jev.status", s, { dropIfSlow: true }));
  return () => {
    offChange();
    stopWatch();
  };
}
