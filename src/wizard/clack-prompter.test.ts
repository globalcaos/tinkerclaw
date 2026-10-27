import { describe, expect, it, vi } from "vitest";

const clack = vi.hoisted(() => ({
  text: vi.fn(async () => "typed"),
  password: vi.fn(async () => "masked"),
}));
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  text: clack.text,
  password: clack.password,
}));

import { createClackPrompter, tokenizedOptionFilter } from "./clack-prompter.js";

describe("tokenizedOptionFilter", () => {
  it("matches tokens regardless of order", () => {
    const option = {
      value: "openai/gpt-5.4",
      label: "openai/gpt-5.4",
      hint: "ctx 400k",
    };

    expect(tokenizedOptionFilter("gpt-5.4 openai/", option)).toBe(true);
    expect(tokenizedOptionFilter("openai/ gpt-5.4", option)).toBe(true);
  });

  it("requires all tokens to match", () => {
    const option = {
      value: "openai/gpt-5.4",
      label: "openai/gpt-5.4",
    };

    expect(tokenizedOptionFilter("gpt-5.4 anthropic/", option)).toBe(false);
  });

  it("matches against label, hint, and value", () => {
    const option = {
      value: "openai/gpt-5.4",
      label: "GPT 5.4",
      hint: "provider openai",
    };

    expect(tokenizedOptionFilter("provider openai", option)).toBe(true);
    expect(tokenizedOptionFilter("openai gpt-5.4", option)).toBe(true);
  });
});

describe("createClackPrompter text", () => {
  it("masks a sensitive answer and shows an ordinary one", async () => {
    const p = createClackPrompter();
    expect(await p.text({ message: "Token", sensitive: true })).toBe("masked");
    expect(clack.password).toHaveBeenCalledTimes(1);
    expect(clack.text).not.toHaveBeenCalled();
    expect(await p.text({ message: "Name" })).toBe("typed");
    expect(clack.text).toHaveBeenCalledTimes(1);
  });
});
