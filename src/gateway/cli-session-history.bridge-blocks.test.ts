// FORK 2026-10-10 (bug-log turn-context-green-bubble) — the history import must cut whatever the
// tinker-bridge puts in front of the owner's words, built by the bridge's OWN formatter, so a change
// to that block's shape fails here instead of drawing a 12 KB green "prompt" bubble (the owner, 19:36:
// "Fractal keeps spitting these big green nonsense").
import { describe, expect, it } from "vitest";
import { formatTurnContext } from "../../extensions/tinkerclaw-tinker-bridge/src/turn-context.js";
import { withoutChatRowContract } from "./cli-session-history.js";

describe("history import vs the bridge's real per-turn block", () => {
  it("an imported CLI prompt built by formatTurnContext comes back as what he typed", () => {
    const typed = "[Sat 2026-10-10 19:36 GMT+2] Try again";
    const cliCopy =
      formatTurnContext("## Runtime\nRuntime: agent=main | model=x | thinking=low") +
      typed +
      "\n\n<!-- TINKERCLAW chat-row contract -->\nBefore EVERY tool call…";
    const [row] = withoutChatRowContract([{ role: "user", content: cliCopy }]) as Array<{
      content: string;
    }>;
    expect(row.content).toBe(typed);
  });
});
