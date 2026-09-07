/**
 * FORK: the canonical error envelope, as a declared plugin-SDK surface.
 *
 * FOUNDATION #5 requires that errors surface through ONE canonical, classified
 * envelope — never swallowed, never `[object Object]`. A provider extension that
 * cannot build that envelope has to invent its own error shape, which is exactly
 * the divergence #5 exists to prevent.
 *
 * `tinkerclaw-tinker-bridge` reached `src/fork/error-envelope.js` relatively. It
 * is `publishToClawHub: true`, so under FOUNDATION #9 the dependency must be
 * declared and travel with the artefact rather than resolve by luck on this disk.
 *
 * Narrow on purpose: the builder and its input/output types, nothing else. The
 * classification tables stay internal so they can change without breaking plugins.
 */

export { buildErrorEnvelope } from "../fork/error-envelope.js";
