/**
 * FORK: Type-only ambient stub for @whatsmeow-node/whatsmeow-node.
 *
 * whatsmeow-node is an optional Go-native addon that may or may not be
 * installed at build time (it's excluded from default pnpm install on
 * machines without the Go toolchain). The fork's live-capture.ts only
 * needs the WhatsmeowClient type at type-check time; the runtime
 * instance arrives via session.ts at bind-time, so we don't need the
 * real module's shape here — `unknown` is enough to keep tsc happy
 * without introducing `any`.
 */
declare module "@whatsmeow-node/whatsmeow-node" {
  export type WhatsmeowClient = {
    on?: (event: string, handler: (...args: unknown[]) => void) => void;
    off?: (event: string, handler: (...args: unknown[]) => void) => void;
  } & Record<string, unknown>;
}
