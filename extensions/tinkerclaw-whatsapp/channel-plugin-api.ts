// Flat re-export entry point so tsdown emits a dedicated bundle
// (dist/extensions/tinkerclaw-whatsapp/channel-plugin-api.js) that the
// bundled channel entry can reference via `specifier: "./channel-plugin-api.js"`.
// This mirrors the upstream extensions/whatsapp/channel-plugin-api.ts pattern.
export { whatsappPlugin } from "./src/channel.js";
