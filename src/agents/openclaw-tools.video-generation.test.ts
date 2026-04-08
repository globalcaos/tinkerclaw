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

describe("openclaw tools video generation registration", () => {
  afterEach(() => {
    fastOpenClawToolFactoryMocks.createImageGenerateTool.mockReset();
    fastOpenClawToolFactoryMocks.createVideoGenerateTool.mockReset();
  });

  it("registers video_generate when the video tool factory returns a tool", () => {
    const videoGenerateTool = stubOpenClawCoreTool("video_generate");
    fastOpenClawToolFactoryMocks.createVideoGenerateTool.mockReturnValue(videoGenerateTool);

    const config = asConfig({
      agents: {
        defaults: {
          videoGenerationModel: {
            primary: "qwen/wan2.6-t2v",
          },
        },
      },
    });
    const tools = createOpenClawTools({
      config,
      agentDir: "/tmp/openclaw-agent-main",
      agentSessionKey: "agent:main:main",
    });

    expect(tools).toContain(videoGenerateTool);
    expect(fastOpenClawToolFactoryMocks.createVideoGenerateTool).toHaveBeenCalledWith({
      config,
      agentDir: "/tmp/openclaw-agent-main",
      agentSessionKey: "agent:main:main",
      requesterOrigin: undefined,
      workspaceDir: expect.any(String),
      sandbox: undefined,
      fsPolicy: undefined,
    });
  });

  it("omits video_generate when the video tool factory returns null", () => {
    fastOpenClawToolFactoryMocks.createVideoGenerateTool.mockReturnValue(null);

    const tools = createOpenClawTools({
      config: asConfig({}),
      agentDir: "/tmp/openclaw-agent-main",
    });

    expect(tools.map((tool) => tool.name)).not.toContain("video_generate");
  });
});
