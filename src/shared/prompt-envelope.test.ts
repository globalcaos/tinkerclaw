import { describe, expect, it } from "vitest";
import {
  isAgentPrompt,
  isSlashCommandPrompt,
  ownerWords,
  stripPromptEnvelope,
} from "./prompt-envelope.js";

// Real prompt shapes from the claude-cli transcripts of 2026-09-30 … 10-09 (the owner's words replaced by neutral ones).
const SENDER =
  'Sender (untrusted metadata):\n```json\n{\n  "label": "Tinker UI (webchat-ui)",\n  "id": "webchat-ui",\n  "name": "Tinker UI",\n  "username": "Tinker UI"\n}\n```\n\n';
/** The doctrine the chat appended to the owner's prompts from 10-01 to 10-08, verbatim to its first trigger sentence. */
const DOCTRINE =
  "\n\n---\n\n**After your reply, append a 🌿 FRACTAL reflection section** on its own line (blank line before it). This is the doctrine that governs it:\n\n## Who Fractal is\n\nThe main turn is the fast thinker: it does the work. Fractal is the slow thinker in the shadows:\nafter the work is done, it asks what the work _meant_ — what it taught, what it broke, what should\nnever happen again — and it leaves **durable change on disk**, not commentary. ";
/** The bridge's chat-row contract, which only the CLI's copy of a prose turn carries. */
const CONTRACT =
  "\n\n<!-- TINKERCLAW chat-row contract -->\nBefore EVERY tool call in your response, emit one assistant text\nsentence stating (a) the artifact";

const AGENT_TURNS: Record<string, string> = {
  fractal: `[Fri 2026-10-09 13:10 GMT+2] ⟦AGENT:🌿 Fractal · prompt 174⟧ The turn above is finished. This is its Fractal reflection: a turn of its own, with every tool.${DOCTRINE}`,
  longjob: `${SENDER.replace(/Tinker UI/g, "longjob")}[Wed 2026-10-07 08:12 GMT+2] ⟦AGENT:⏳ Longjob · build finished⟧ [longjob] build finished, exit 0`,
  background:
    "[Thu 2026-10-01 20:10 GMT+2] ⟦AGENT:⏱ Background⟧ Background task: “tests” completed. The answer below is the one the worker gave on its own. [bg-turn bgt-1a2b]",
  overseer: `[Mon 2026-10-05 09:45 GMT+2] ⟦OVERSEER⟧ The task is complete, so I'm returning nothing.${CONTRACT}`,
  restart:
    "[Fri 2026-10-09 11:07 GMT+2] [System] The gateway restarted and interrupted your previous turn. Resume it, and make the resume legible to the user:\n1. ORIENT FIRST — post one short message (1-3 sentences) stating where you are picking up.",
  internal:
    "[Fri 2026-10-09 08:33 GMT+2] <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nOpenClaw runtime context (internal):\nThis context is runtime-generated, not user-authored. Keep internal details private.",
  subagent: `[Fri 2026-10-09 20:56 GMT+2] [Subagent Context] You are running as a subagent (depth 1/1).${CONTRACT}`,
  taskNotification:
    "<task-notification>\n<task-id>b6bc1guv9</task-id>\n<tool-use-id>toolu_01NSwR4N</tool-use-id>\n<status>completed</status>",
  selfWake:
    "[Wed 2026-09-30 06:30 GMT+2] 🤖 [longjob] second model-rank-refresh run ended (exit 0 = ok, 1 = error).",
};

describe("stripPromptEnvelope", () => {
  it("takes off the stamp in front and the doctrine behind (10-01 … 10-08 owner prompts)", () => {
    expect(
      stripPromptEnvelope(`[Thu 2026-10-01 05:21 GMT+2] Keep improving Jev's prompts${DOCTRINE}`),
    ).toBe("Keep improving Jev's prompts");
  });

  it("takes off the web chat's sender block, the abort note and the contract, in any order", () => {
    expect(
      stripPromptEnvelope(
        `${SENDER}[Wed 2026-10-07 16:59 GMT+2] did the build pass?${DOCTRINE}${CONTRACT}`,
      ),
    ).toBe("did the build pass?");
    expect(
      stripPromptEnvelope(
        "Note: The previous agent run was aborted by the user. Resume carefully or ask for clarification.\n\n[Fri 2026-10-09 10:00 GMT+2] stop and list the drafts",
      ),
    ).toBe("stop and list the drafts");
    expect(stripPromptEnvelope(`do X${CONTRACT}`)).toBe("do X");
  });

  // The gateway's queued system events ride in front of the body, one prefixed line each (session-system-events.ts).
  // In 1,500 gateway sessions, 195 of 195 prompts that opened with them carried the owner's words after.
  it("takes off the system-event lines in front of his words", () => {
    expect(
      stripPromptEnvelope(
        `System (untrusted): [2026-10-08 10:00:00 GMT+2] Exec completed (job 12, code 0)\nSystem: [2026-10-08 10:00:02 GMT+2] Model switched\n\n${SENDER}[Wed 2026-10-08 10:01 GMT+2] did the build pass?`,
      ),
    ).toBe("did the build pass?");
  });

  it("keeps an agent's words but drops its label", () => {
    expect(stripPromptEnvelope(AGENT_TURNS.longjob)).toBe("[longjob] build finished, exit 0");
    expect(stripPromptEnvelope(AGENT_TURNS.fractal)).toBe(
      "The turn above is finished. This is its Fractal reflection: a turn of its own, with every tool.",
    );
  });

  it("leaves a bracket the owner typed alone: only a dated envelope is a stamp", () => {
    expect(stripPromptEnvelope("[draft] reply to Marc about the quote")).toBe(
      "[draft] reply to Marc about the quote",
    );
    expect(stripPromptEnvelope("fix the [System] chip colour")).toBe(
      "fix the [System] chip colour",
    );
    // A line he typed as `System:` reaches the hook rewritten, undated (inbound-text.ts); it stays his.
    expect(stripPromptEnvelope("System (untrusted): reboot the Pi tonight")).toBe(
      "System (untrusted): reboot the Pi tonight",
    );
  });
});

describe("isAgentPrompt / ownerWords", () => {
  it.each(Object.entries(AGENT_TURNS))("%s is a turn no person wrote", (_name, prompt) => {
    expect(isAgentPrompt(prompt)).toBe(true);
    expect(ownerWords(prompt)).toBeUndefined();
  });

  it("an owner's prompt is his, with the envelope gone", () => {
    const prompt = `${SENDER}[Thu 2026-10-01 05:21 GMT+2] it's still not working!!${DOCTRINE}`;
    expect(isAgentPrompt(prompt)).toBe(false);
    expect(ownerWords(prompt)).toBe("it's still not working!!");
  });

  it("a marker in the middle of his words does not make the prompt an agent's", () => {
    expect(
      isAgentPrompt("[Fri 2026-10-09 10:00 GMT+2] why did ⟦AGENT:longjob⟧ wake me twice?"),
    ).toBe(false);
    expect(isAgentPrompt("the 🤖 prefix is missing on Teams")).toBe(false);
  });

  it("nothing left is nothing written", () => {
    expect(ownerWords(undefined)).toBeUndefined();
    expect(ownerWords("[Fri 2026-10-09 10:00 GMT+2] ")).toBeUndefined();
    expect(isAgentPrompt(undefined)).toBe(false);
  });
});

describe("isSlashCommandPrompt", () => {
  it("a stamped /compact, with or without instructions, is a command", () => {
    expect(isSlashCommandPrompt("[Sat 2026-10-10 11:31 GMT+2] /compact")).toBe(true);
    expect(isSlashCommandPrompt("[Sat 2026-10-10 11:31 GMT+2] /compact: keep the plan")).toBe(true);
  });

  it("prose, a path and an empty prompt are not", () => {
    expect(isSlashCommandPrompt("[Sat 2026-10-10 11:31 GMT+2] compact it please")).toBe(false);
    expect(isSlashCommandPrompt("/home/user/notes.md is the file")).toBe(false);
    expect(isSlashCommandPrompt(undefined)).toBe(false);
  });
});
