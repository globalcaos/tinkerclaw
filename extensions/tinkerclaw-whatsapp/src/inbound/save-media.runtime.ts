/**
 * FORK: tinkerclaw-whatsapp media save runtime re-export.
 *
 * Re-exports `saveMediaBuffer` from the plugin SDK so downstream
 * inbound modules in this plugin can import from a local path.
 */
export { saveMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
