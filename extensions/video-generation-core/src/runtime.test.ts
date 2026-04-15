import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateVideo, listRuntimeVideoGenerationProviders } from "./runtime.js";

const mocks = vi.hoisted(() => ({
  generateVideo: vi.fn(),
  listRuntimeVideoGenerationProviders: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/video-generation-runtime", () => ({
  generateVideo: mocks.generateVideo,
  listRuntimeVideoGenerationProviders: mocks.listRuntimeVideoGenerationProviders,
}));

describe("video-generation runtime wrapper", () => {
  beforeEach(() => {
    mocks.generateVideo.mockReset();
    mocks.listRuntimeVideoGenerationProviders.mockReset();
  });

  it("delegates video generation to the shared runtime surface", async () => {
    const result = {
      videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
      provider: "video-plugin",
      model: "vid-v1",
      attempts: [],
      ignoredOverrides: [],
    };
    mocks.generateVideo.mockResolvedValue(result);
    const params = {
      cfg: {},
      prompt: "animate a cat",
    };

    await expect(generateVideo(params as never)).resolves.toEqual(result);
    expect(mocks.generateVideo).toHaveBeenCalledWith(params);
  });

  it("delegates provider listing to the shared runtime surface", () => {
    const providers = [{ id: "video-plugin" }];
    mocks.listRuntimeVideoGenerationProviders.mockReturnValue(providers);

    expect(listRuntimeVideoGenerationProviders({ config: {} as never })).toEqual(providers);
    expect(mocks.listRuntimeVideoGenerationProviders).toHaveBeenCalledWith({
      config: {} as never,
    });
  });

  it("uses mode-specific capabilities for image-to-video requests", async () => {
    let seenRequest:
      | {
          size?: string;
          aspectRatio?: string;
          resolution?: string;
        }
      | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("runway/gen4.5");
    mocks.getVideoGenerationProvider.mockReturnValue({
      id: "runway",
      capabilities: {
        generate: {
          supportsSize: true,
          supportsAspectRatio: false,
        },
        imageToVideo: {
          enabled: true,
          maxInputImages: 1,
          supportsSize: false,
          supportsAspectRatio: true,
        },
      },
      generateVideo: async (req) => {
        seenRequest = {
          size: req.size,
          aspectRatio: req.aspectRatio,
          resolution: req.resolution,
        };
        return {
          videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
          model: "gen4.5",
        };
      },
    });

    const result = await generateVideo({
      cfg: {
        agents: {
          defaults: {
            videoGenerationModel: { primary: "runway/gen4.5" },
          },
        },
      } as OpenClawConfig,
      prompt: "animate a lobster",
      size: "1280x720",
      aspectRatio: "16:9",
      inputImages: [{ buffer: Buffer.from("png"), mimeType: "image/png" }],
    });

    expect(seenRequest).toEqual({
      size: undefined,
      aspectRatio: "16:9",
      resolution: undefined,
    });
    expect(result.ignoredOverrides).toEqual([{ key: "size", value: "1280x720" }]);
  });
});
