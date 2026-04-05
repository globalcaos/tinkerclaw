import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";

function createApi() {
  const registerCli = vi.fn();
  const registerTool = vi.fn();
  const api = createTestPluginApi({
    id: "memory-wiki",
    name: "Memory Wiki",
    source: "test",
    config: {},
    runtime: {} as OpenClawPluginApi["runtime"],
    registerCli,
    registerTool,
  }) as OpenClawPluginApi;
  return { api, registerCli, registerTool };
}

describe("memory-wiki plugin", () => {
  it("registers the status tool and wiki cli surface", async () => {
    const { api, registerCli, registerTool } = createApi();

    await plugin.register(api);

    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerTool.mock.calls[0]?.[1]).toMatchObject({ name: "wiki_status" });
    expect(registerCli).toHaveBeenCalledTimes(1);
    expect(registerCli.mock.calls[0]?.[1]).toMatchObject({
      descriptors: [
        expect.objectContaining({
          name: "wiki",
          hasSubcommands: true,
        }),
      ],
    });
  });
});
