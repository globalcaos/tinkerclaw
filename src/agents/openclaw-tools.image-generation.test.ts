import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import {
  fastOpenClawToolFactoryMocks,
  stubOpenClawCoreTool,
} from "./test-helpers/fast-openclaw-tools-shell.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("openclaw tools image generation registration", () => {
  afterEach(() => {
    fastOpenClawToolFactoryMocks.createImageGenerateTool.mockReset();
    fastOpenClawToolFactoryMocks.createVideoGenerateTool.mockReset();
  });

  it("registers image_generate when the image tool factory returns a tool", () => {
    const imageGenerateTool = stubOpenClawCoreTool("image_generate");
    fastOpenClawToolFactoryMocks.createImageGenerateTool.mockReturnValue(imageGenerateTool);

    const config = asConfig({
      agents: {
        defaults: {
          imageGenerationModel: {
            primary: "openai/gpt-image-1",
          },
        },
      },
    });
    const tools = createOpenClawTools({
      config,
      agentDir: "/tmp/openclaw-agent-main",
    });

    expect(tools).toContain(imageGenerateTool);
    expect(fastOpenClawToolFactoryMocks.createImageGenerateTool).toHaveBeenCalledWith({
      config,
      agentDir: "/tmp/openclaw-agent-main",
      workspaceDir: expect.any(String),
      sandbox: undefined,
      fsPolicy: undefined,
    });
  });

  it("omits image_generate when the image tool factory returns null", () => {
    fastOpenClawToolFactoryMocks.createImageGenerateTool.mockReturnValue(null);

    const tools = createOpenClawTools({
      config: asConfig({}),
      agentDir: "/tmp/openclaw-agent-main",
    });

    expect(tools.map((tool) => tool.name)).not.toContain("image_generate");
  });
});
