/**
 * FORK: tinkerclaw-whatsapp runtime-api shim.
 *
 * The plugin loader resolves this file from `defineBundledChannelEntry`'s
 * `runtime.specifier` to find `setWhatsAppRuntime`. We re-export from the
 * upstream runtime store until Task 10 localizes the runtime into this
 * plugin. Sharing the upstream store keeps outbound helpers, action
 * runtime, and the upstream-channel.ts re-export all pointing at the
 * same state.
 */
export { setWhatsAppRuntime, getWhatsAppRuntime } from "../whatsapp/src/runtime.js";
