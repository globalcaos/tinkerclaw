/**
 * FORK: secret-REFERENCE helpers, as a declared plugin-SDK surface.
 *
 * WHY THIS EXISTS
 * ---------------
 * The fork's browser-relay auth path stores a *reference* to a secret rather than the
 * secret, and needs two things to do it: the canonical key for a reference
 * (`secretRefKey`) and the resolver that turns a config-shaped input into one
 * (`resolveSecretInputRef`). It reached both by relative path from inside
 * `extensions/browser`.
 *
 * REFERENCES, NOT SECRETS. Nothing here returns secret material. `secretRefKey` computes
 * a stable identifier and `resolveSecretInputRef` normalises a declaration; resolving a
 * reference to an actual value stays behind `openclaw/plugin-sdk/runtime-secret-resolution`,
 * which is upstream-governed. That split is the point — a plugin can name and pass along
 * a secret it is not allowed to read, which is what lets the relay hold a reference
 * without ever holding the credential.
 *
 * `normalizeSecretInputString` is NOT re-exported here: it is already published via
 * `openclaw/plugin-sdk/secret-input`, and a second door onto one function is how two
 * definitions of the same rule start.
 */

export { secretRefKey } from "../secrets/ref-contract.js";
export { resolveSecretInputRef } from "../config/types.secrets.js";
