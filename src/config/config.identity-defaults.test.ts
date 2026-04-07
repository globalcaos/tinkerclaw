import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_MAX_CONCURRENT, DEFAULT_SUBAGENT_MAX_CONCURRENT } from "./agent-limits.js";
import { validateConfigObject, validateConfigObjectRaw } from "./validation.js";
import { OpenClawSchema } from "./zod-schema.js";

const defaultIdentity = {
  name: "Samantha",
  theme: "helpful sloth",
  emoji: "🦥",
};

const configWithDefaultIdentity = (messages: Record<string, unknown>) => ({
  agents: {
    list: [
      {
        id: "main",
        identity: defaultIdentity,
      },
    ],
  },
  messages,
});

function expectValidConfig(raw: unknown) {
  const result = validateConfigObject(raw);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected config to validate: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

function expectValidRawConfig(raw: unknown) {
  const result = validateConfigObjectRaw(raw);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected raw config to validate: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

describe("config identity defaults", () => {
  it("does not derive mention defaults and only sets ackReactionScope when identity is present", () => {
    const cfg = expectValidConfig(configWithDefaultIdentity({}));

    expect(cfg.messages?.responsePrefix).toBeUndefined();
    expect(cfg.messages?.groupChat?.mentionPatterns).toBeUndefined();
    expect(cfg.messages?.ackReaction).toBeUndefined();
    expect(cfg.messages?.ackReactionScope).toBe("group-mentions");
  });

  it("keeps ackReaction unset and does not synthesize agent/session defaults when identity is missing", () => {
    const cfg = expectValidConfig({ messages: {} });

    expect(cfg.messages?.ackReaction).toBeUndefined();
    expect(cfg.messages?.ackReactionScope).toBe("group-mentions");
    expect(cfg.messages?.responsePrefix).toBeUndefined();
    expect(cfg.messages?.groupChat?.mentionPatterns).toBeUndefined();
    expect(cfg.agents?.list).toBeUndefined();
    expect(cfg.agents?.defaults?.maxConcurrent).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
    expect(cfg.agents?.defaults?.subagents?.maxConcurrent).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
    expect(cfg.session).toBeUndefined();
  });

  it("does not override explicit values", () => {
    const cfg = expectValidConfig({
      agents: {
        list: [
          {
            id: "main",
            identity: {
              name: "Samantha Sloth",
              theme: "space lobster",
              emoji: "🦞",
            },
            groupChat: { mentionPatterns: ["@openclaw"] },
          },
        ],
      },
      messages: {
        responsePrefix: "✅",
      },
    });

    expect(cfg.messages?.responsePrefix).toBe("✅");
    expect(cfg.agents?.list?.[0]?.groupChat?.mentionPatterns).toEqual(["@openclaw"]);
  });

  it("supports provider textChunkLimit config", () => {
    const result = OpenClawSchema.safeParse({
      messages: {
        messagePrefix: "[openclaw]",
        responsePrefix: "🦞",
      },
      channels: {
        whatsapp: { allowFrom: ["+15555550123"], textChunkLimit: 4444 },
        telegram: { enabled: true, textChunkLimit: 3333 },
        discord: {
          enabled: true,
          textChunkLimit: 1999,
          maxLinesPerMessage: 17,
        },
        signal: { enabled: true, textChunkLimit: 2222 },
        imessage: { enabled: true, textChunkLimit: 1111 },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`expected schema parse success: ${JSON.stringify(result.error.issues)}`);
    }
    const cfg = result.data;

    expect(cfg.channels?.whatsapp?.textChunkLimit).toBe(4444);
    expect(cfg.channels?.telegram?.textChunkLimit).toBe(3333);
    expect(cfg.channels?.discord?.textChunkLimit).toBe(1999);
    expect(cfg.channels?.discord?.maxLinesPerMessage).toBe(17);
    expect(cfg.channels?.signal?.textChunkLimit).toBe(2222);
    expect(cfg.channels?.imessage?.textChunkLimit).toBe(1111);

    const legacy = (cfg.messages as unknown as Record<string, unknown>).textChunkLimit;
    expect(legacy).toBeUndefined();
  });

  it("accepts blank model provider apiKey values", () => {
    const cfg = expectValidRawConfig({
      models: {
        mode: "merge",
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.io/anthropic",
            apiKey: "",
            api: "anthropic-messages",
            models: [
              {
                id: "MiniMax-M2.7",
                name: "MiniMax M2.7",
                reasoning: false,
                input: ["text"],
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    });

    expect(cfg.models?.providers?.minimax?.baseUrl).toBe("https://api.minimax.io/anthropic");
    expect(cfg.models?.providers?.minimax?.apiKey).toBe("");
  });

  it("accepts SecretRef values in model provider headers", () => {
    const cfg = expectValidRawConfig({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
            headers: {
              Authorization: {
                source: "env",
                provider: "default",
                id: "OPENAI_HEADER_TOKEN",
              },
            },
            models: [],
          },
        },
      },
    });

    expect(cfg.models?.providers?.openai?.headers?.Authorization).toEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_HEADER_TOKEN",
    });
  });

  it("respects empty responsePrefix to disable identity defaults", () => {
    const cfg = expectValidConfig(configWithDefaultIdentity({ responsePrefix: "" }));

    expect(cfg.messages?.responsePrefix).toBe("");
  });
});
