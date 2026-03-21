import { describe, expect, it } from "vitest";
import {
  detectAddressing,
  parseAgentOrigin,
  routeInboundMessage,
  shouldAgentRespond,
} from "./router.js";
import type { AgentConfig } from "./types.js";

const agents: AgentConfig[] = [
  { id: "mia", name: "Mia", icon: "🦊" },
  { id: "luna", name: "Luna", icon: "🌙" },
  { id: "rex", name: "Rex", icon: "🦖" },
];

describe("parseAgentOrigin", () => {
  it("detects agent by icon prefix", () => {
    const result = parseAgentOrigin("🦊 Here's my take", agents);
    expect(result.agentId).toBe("mia");
    expect(result.strippedText).toBe("Here's my take");
  });

  it("returns null for human messages", () => {
    const result = parseAgentOrigin("What do you all think?", agents);
    expect(result.agentId).toBeNull();
    expect(result.strippedText).toBe("What do you all think?");
  });

  it("handles icon with no space after", () => {
    const result = parseAgentOrigin("🌙Analysis complete", agents);
    expect(result.agentId).toBe("luna");
    expect(result.strippedText).toBe("Analysis complete");
  });
});

describe("detectAddressing", () => {
  it("detects direct addressing with comma", () => {
    expect(detectAddressing("Luna, what do you think?", agents)).toBe("luna");
  });

  it("detects addressing with hey prefix", () => {
    expect(detectAddressing("Hey Rex, disagree with that", agents)).toBe("rex");
  });

  it("detects addressing with colon", () => {
    expect(detectAddressing("Mia: your thoughts?", agents)).toBe("mia");
  });

  it("returns null when no agent addressed", () => {
    expect(detectAddressing("What does everyone think?", agents)).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(detectAddressing("LUNA, respond please", agents)).toBe("luna");
  });
});

describe("shouldAgentRespond", () => {
  it("blocks self-messages", () => {
    const result = shouldAgentRespond({
      myAgentId: "mia",
      originAgentId: "mia",
      addressedAgentId: null,
      chatMode: "broadcast",
      congestionDelayMs: 1000,
    });
    expect(result.respond).toBe(false);
    expect(result.reason).toBe("self-message");
  });

  it("allows directly addressed agent", () => {
    const result = shouldAgentRespond({
      myAgentId: "luna",
      originAgentId: "mia",
      addressedAgentId: "luna",
      chatMode: "broadcast",
      congestionDelayMs: 1000,
    });
    expect(result.respond).toBe(true);
    expect(result.delayMs).toBe(0); // No delay for direct address
  });

  it("blocks non-addressed agent when someone else is addressed", () => {
    const result = shouldAgentRespond({
      myAgentId: "rex",
      originAgentId: "mia",
      addressedAgentId: "luna",
      chatMode: "broadcast",
      congestionDelayMs: 1000,
    });
    expect(result.respond).toBe(false);
  });

  it("allows all agents in broadcast mode with congestion delay", () => {
    const result = shouldAgentRespond({
      myAgentId: "rex",
      originAgentId: "mia",
      addressedAgentId: null,
      chatMode: "broadcast",
      congestionDelayMs: 2500,
    });
    expect(result.respond).toBe(true);
    expect(result.delayMs).toBe(2500);
  });

  it("addressed mode: allows response to human messages", () => {
    const result = shouldAgentRespond({
      myAgentId: "luna",
      originAgentId: null, // from human
      addressedAgentId: null,
      chatMode: "addressed",
      congestionDelayMs: 1000,
    });
    expect(result.respond).toBe(true);
  });

  it("addressed mode: blocks response to agent messages without mention", () => {
    const result = shouldAgentRespond({
      myAgentId: "luna",
      originAgentId: "mia",
      addressedAgentId: null,
      chatMode: "addressed",
      congestionDelayMs: 1000,
    });
    expect(result.respond).toBe(false);
  });
});

describe("routeInboundMessage", () => {
  it("full pipeline: agent message with addressing", () => {
    const result = routeInboundMessage({
      messageText: "🦊 Luna, can you verify this?",
      myAgentId: "luna",
      agents,
      chatMode: "broadcast",
      congestionDelayMs: 3000,
    });
    expect(result.originAgentId).toBe("mia");
    expect(result.addressedAgentId).toBe("luna");
    expect(result.respond).toBe(true);
    expect(result.delayMs).toBe(0); // Directly addressed
  });

  it("full pipeline: human broadcast", () => {
    const result = routeInboundMessage({
      messageText: "Discuss the pros and cons of moving to Valencia",
      myAgentId: "rex",
      agents,
      chatMode: "broadcast",
      congestionDelayMs: 5000,
    });
    expect(result.originAgentId).toBeNull();
    expect(result.addressedAgentId).toBeNull();
    expect(result.respond).toBe(true);
    expect(result.delayMs).toBe(5000);
  });

  it("full pipeline: self-message blocked", () => {
    const result = routeInboundMessage({
      messageText: "🦖 Here's my counterpoint",
      myAgentId: "rex",
      agents,
      chatMode: "broadcast",
      congestionDelayMs: 3000,
    });
    expect(result.respond).toBe(false);
    expect(result.reason).toBe("self-message");
  });
});
