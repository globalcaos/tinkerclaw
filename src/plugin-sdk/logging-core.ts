export { createSubsystemLogger } from "../logging/subsystem.js";
// FORK 2026-08-04: `getChildLogger` for extensions that want a named child of the
// host logger rather than their own subsystem (tinkerclaw-whatsapp/src/backfill).
export { getChildLogger } from "../logging/logger.js";
export { redactIdentifier } from "../logging/redact-identifier.js";
export { redactSensitiveText } from "../logging/redact.js";
