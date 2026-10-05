/**
 * FORK 2026-09-30: the Jev client as a declared plugin-SDK surface (design doc section 13A.8, C5).
 *
 * The client, its circuit breaker and its verdict cache used to live in the amygdala extension. THALAMUS
 * v4 asks Jev too, and an extension cannot import another extension, so they moved to
 * `src/infra/jev/` and are published here. The amygdala keeps one-line re-export files at its old paths.
 * WHAT IS PUBLISHED: the client, the transport type, the breaker, the cache and their shapes, and the text and value redaction (moved from the amygdala in phase H2). Nothing here
 * holds a key: the caller passes `apiKey: () => string | undefined`.
 */
export * from "../infra/jev/jev.js";
export * from "../infra/jev/breaker.js";
export * from "../infra/jev/cache.js";
export * from "../infra/jev/redact.js";
export type * from "../infra/jev/types.js";
