import type { JevTransport } from "openclaw/plugin-sdk/fork-jev";
import { describe, expect, it, vi } from "vitest";
import { createJokeJudge, JOKE_QUESTION, verdictIsJoke } from "../src/joke-judge.js";

/** 2026-10-10 (J7 gap #4): each recorded line is judged joke or plain; with no consent or no token, nothing is sent. */
describe("the joke judge", () => {
  const verdict = (answer: unknown, skipped?: string) => [{ answer, skipped } as never];

  function judge(o: { allowed?: boolean; armed?: boolean; answer?: unknown; skipped?: string }) {
    const ask = vi.fn(async () => verdict(o.answer, o.skipped));
    const j = createJokeJudge({
      allowed: () => o.allowed ?? true,
      armed: () => o.armed ?? true,
      baseUrl: "https://jev.invalid",
      model: "jev-test",
      ask,
    });
    return { j, ask };
  }

  it("asks one yes/no question with the line as its only field", async () => {
    const { j, ask } = judge({ answer: true });
    expect(await j("I find the ratio instructive.")).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    const [situation, questions] = ask.mock.calls[0] as unknown as [
      { line: { value: string } },
      unknown[],
    ];
    expect(situation.line.value).toBe("I find the ratio instructive.");
    expect(questions).toEqual([JOKE_QUESTION]);
    expect(JOKE_QUESTION.fields).toEqual(["line"]);
  });

  it("reads a no as plain, and a skipped verdict as not judged", async () => {
    expect(await judge({ answer: false }).j("Merged, three tests green.")).toBe(false);
    expect(await judge({ answer: "false" }).j("Merged.")).toBe(false);
    expect(await judge({ answer: 0, skipped: "timeout" }).j("Merged.")).toBeUndefined();
  });

  // 2026-10-25: Jev answers a yes/no with its probability. The stubs above answered `true`, so the tests passed while
  // every live verdict (a number) was read as "not judged" and no spoken line was ever marked.
  it("reads Jev's real answer, a probability, through the real client", async () => {
    const answering = (noul: number): JevTransport => ({
      post: async () => ({
        status: 200,
        json: { answers: { [JOKE_QUESTION.id]: { noul } } },
        ms: 3,
      }),
    });
    const real = (noul: number) =>
      createJokeJudge({
        allowed: () => true,
        armed: () => true,
        baseUrl: "https://jev.invalid",
        model: "jev-test",
        transport: answering(noul),
        apiKey: () => "test-token",
      });
    expect(await real(0.86)("I find the ratio instructive.")).toBe(true);
    expect(await real(0.12)("Merged, three tests green.")).toBe(false);
    expect(verdictIsJoke({ answer: Number.NaN } as never)).toBeUndefined();
  });

  it("sends nothing without the owner's consent for real text, or without an armed token", async () => {
    const noConsent = judge({ allowed: false, answer: true });
    expect(await noConsent.j("A line.")).toBeUndefined();
    expect(noConsent.ask).not.toHaveBeenCalled();
    const dormant = judge({ armed: false, answer: true });
    expect(await dormant.j("A line.")).toBeUndefined();
    expect(dormant.ask).not.toHaveBeenCalled();
  });
});
