import { definePluginEntry } from "./api.js";
import { registerWikiCli } from "./src/cli.js";
import { memoryWikiConfigSchema, resolveMemoryWikiConfig } from "./src/config.js";
import { createWikiGetTool, createWikiSearchTool, createWikiStatusTool } from "./src/tool.js";

export default definePluginEntry({
  id: "memory-wiki",
  name: "Memory Wiki",
  description: "Persistent wiki compiler and Obsidian-friendly knowledge vault for OpenClaw.",
  configSchema: memoryWikiConfigSchema,
  register(api) {
    const config = resolveMemoryWikiConfig(api.pluginConfig);

    api.registerTool(createWikiStatusTool(config), { name: "wiki_status" });
    api.registerTool(createWikiSearchTool(config), { name: "wiki_search" });
    api.registerTool(createWikiGetTool(config), { name: "wiki_get" });
    api.registerCli(
      ({ program }) => {
        registerWikiCli(program, config);
      },
      {
        descriptors: [
          {
            name: "wiki",
            description: "Inspect and initialize the memory wiki vault",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
