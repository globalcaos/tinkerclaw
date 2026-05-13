/**
 * FORK: Hippocampus plugin extension stub.
 *
 * The hippocampus memory system (importance scoring, deduplication, episodic buffer)
 * is wired into the gateway via src/memory/engram/. This extension exists solely to
 * register the plugin ID with the discovery system so the openclaw.json config entry
 * passes validation.
 */
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/channel-plugin-common";

const hippocampusPlugin = {
  id: "tinkerclaw-hippocampus",
  name: "Hippocampus",
  description:
    "Concept-index memory enhancement with importance scoring, deduplication, and episodic buffer",
  configSchema: emptyPluginConfigSchema(),
  register() {
    // Hippocampus hooks are registered via src/memory/engram/ at build time.
    // No runtime registration needed here.
  },
};

export default hippocampusPlugin;
