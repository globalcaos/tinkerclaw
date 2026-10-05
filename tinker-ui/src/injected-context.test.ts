import { describe, expect, it } from "vitest";
import { detectInjectedContext } from "./injected-context.ts";

describe("detectInjectedContext", () => {
  it("the moral code prefixed to a prompt is a card, not the human's bubble (work tab, 2026-09-23)", () => {
    const pack = `<moral_code source="tinkerclaw">\n\n# Ethical rules\n${"x".repeat(40_000)}\n</moral_code>`;
    const r = detectInjectedContext(`${pack}\n\n[Wed 2026-09-23 08:56 GMT+2] Ok, I understand`);
    expect(r?.kind).toBe("moral-code");
    expect(r?.headline).toContain("40k chars");
    expect(r?.headline).toContain("ahead of the prompt above");
    expect(r?.body).toContain("Ok, I understand");
  });

  it("recognises each producer by its fixed opening", () => {
    const cases: Array<[string, string]> = [
      [
        "This session is being continued from a previous conversation that ran out",
        "compaction-summary",
      ],
      ["# FRACTAL TRIAGE — read-only judge of a finished turn\nYou are…", "fractal-triage"],
      ["A scheduled reminder has been triggered. The reminder content is:", "scheduled-reminder"],
      ["[reply-mode] mode: owner-management recipient: the owner", "reply-mode"],
      [
        "<task-notification>\n<task-id>w1</task-id>\n<status>completed</status>",
        "task-notification",
      ],
    ];
    for (const [text, kind] of cases) {
      expect(detectInjectedContext(text)?.kind).toBe(kind);
    }
  });

  it("a task notification headline is its summary, else its status", () => {
    expect(
      detectInjectedContext(
        "<task-notification><summary>Build finished</summary></task-notification>",
      )?.headline,
    ).toBe("Build finished");
    expect(
      detectInjectedContext("<task-notification><status>failed</status></task-notification>")
        ?.headline,
    ).toBe("Task failed");
  });

  it("a person quoting one of these mid-message is still a person", () => {
    expect(
      detectInjectedContext('Why did you get <moral_code source="tinkerclaw"> twice?'),
    ).toBeNull();
    expect(detectInjectedContext("Explain what # FRACTAL TRIAGE does")).toBeNull();
    expect(detectInjectedContext("hello")).toBeNull();
    expect(detectInjectedContext(undefined)).toBeNull();
  });
});
