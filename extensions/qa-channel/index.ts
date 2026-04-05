import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { qaChannelPlugin } from "./src/channel.js";
import { setQaChannelRuntime } from "./src/runtime.js";

export { qaChannelPlugin } from "./src/channel.js";
export { setQaChannelRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "qa-channel",
  name: "QA Channel",
  description: "Synthetic QA channel plugin",
  plugin: qaChannelPlugin as ChannelPlugin,
  setRuntime: setQaChannelRuntime,
});
