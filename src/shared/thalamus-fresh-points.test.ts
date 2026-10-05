import { describe, expect, it } from "vitest";
import {
  checkBrief,
  freshPointDecision,
  clipMiddle,
  finishBrief,
  guessLanguage,
  needsCheck,
  pickChecker,
  parseCheckVerdict,
  pickWriter,
  rewriteKeepsFacts,
  vendorFamilyOf,
} from "./thalamus-fresh-points.js";
import { routeCall } from "./thalamus-route-call.js";
import {
  answered,
  callParams,
  GROK,
  HAIKU,
  OPUS,
  R,
  SONNET,
  stepRead,
} from "./thalamus-v4.test-support.js";

const decision = (over = {}) =>
  freshPointDecision(callParams({ feedTokens: { thread: 50_000 }, ...over }), "check", 3_000)!;

describe("vendorFamilyOf", () => {
  it("maps lineage, not provider", () => {
    expect(vendorFamilyOf("claude-code/claude-opus-5")).toBe("anthropic");
    expect(vendorFamilyOf("anthropic/claude-sonnet-4-6")).toBe("anthropic");
    expect(vendorFamilyOf("openai-codex/gpt-5.6-sol")).toBe("openai");
    expect(vendorFamilyOf("github-copilot/gpt-5.5")).toBe("openai");
    expect(vendorFamilyOf("xai/grok-4.7")).toBe("xai");
    expect(vendorFamilyOf("google/gemini-3.8-flash")).toBe("google");
    expect(vendorFamilyOf("openrouter/moonshotai/kimi-k3")).toBe("moonshot");
    expect(vendorFamilyOf("openrouter/qwen/qwen3.8-max-0902")).toBe("alibaba");
  });
  it("falls back to the provider for an unknown model, and never to nothing", () => {
    expect(vendorFamilyOf("acme/widget-9")).toBe("acme");
    expect(vendorFamilyOf("widget-9")).toBe("widget-9");
  });
  it("Copilot serving a Claude model is Anthropic, whatever the provider says", () => {
    expect(vendorFamilyOf("github-copilot/claude-sonnet-4.6")).toBe("anthropic");
  });
});

describe("needsCheck", () => {
  it("a step that commits or claims needs one", () => {
    expect(needsCheck({ step: stepRead({ commitsOrClaims: answered(true) }) })).toEqual({
      check: true,
      why: "commits-or-claims",
    });
  });
  it("a plain step does not", () => {
    expect(needsCheck({ step: stepRead() })).toEqual({ check: false, why: "none" });
  });
  it("a check is not checked again, even if it also claims", () => {
    expect(
      needsCheck({
        step: stepRead({ kind: answered("check" as const), commitsOrClaims: answered(true) }),
      }).check,
    ).toBe(false);
  });
  it("an outcome read that sends the step to a check counts", () => {
    expect(needsCheck({ step: stepRead(), outcome: "check" })).toEqual({
      check: true,
      why: "outcome-check",
    });
  });
});

describe("pickChecker: another family, fed the brief", () => {
  it("never picks the builder's family, however cheap", () => {
    const d = decision({ rungs: [R.opus, R.sonnet, R.haiku, R.grok] });
    const pick = pickChecker({ builderKey: OPUS, options: d.options });
    expect(pick.reason).toBe("picked");
    expect(pick.family).not.toBe("anthropic");
    expect(pick.option!.rung.key).toBe(GROK);
    expect(pick.option!.feed).toBe("brief");
  });
  it("with only one family on the board there is no checker, and it says so", () => {
    const d = decision({ rungs: [R.opus, R.sonnet, R.haiku] });
    const pick = pickChecker({ builderKey: OPUS, options: d.options });
    expect(pick.option).toBeUndefined();
    expect(pick.reason).toBe("no-other-family");
    expect(pick.builderFamily).toBe("anthropic");
  });
  it("a checker of the other family is picked when the builder is that family instead", () => {
    const d = decision({ rungs: [R.opus, R.grok], incumbentKey: GROK, incumbentEffort: "high" });
    expect(pickChecker({ builderKey: GROK, options: d.options }).option!.rung.key).toBe(OPUS);
  });
  it("prefers one that clears the bar, and falls back to the strongest other-family option when none does", () => {
    const d = decision({ rungs: [R.opus, R.grok] });
    expect(
      pickChecker({ builderKey: OPUS, options: d.options, minQuality: 1 }).option!.rung.key,
    ).toBe(GROK);
    const weak = pickChecker({ builderKey: OPUS, options: d.options, minQuality: 999 });
    expect(weak.reason).toBe("picked");
    expect(weak.option!.rung.key).toBe(GROK);
  });
  it("options with no brief feed give no checker", () => {
    const d = routeCall(callParams({ feedTokens: { thread: 50_000 } }))!;
    expect(pickChecker({ builderKey: OPUS, options: d.options }).reason).toBe("no-brief-option");
  });
});

describe("checkBrief: the work and its claim, not the thread", () => {
  it("carries both, and is bounded", () => {
    const b = checkBrief({ work: "w".repeat(50_000), claim: "the build passes", maxChars: 4_000 });
    expect(b).toContain("CLAIM:\nthe build passes");
    expect(b).toContain("WORK:\n");
    expect(b.length).toBeLessThan(4_600);
    expect(b).toContain("[... clipped ...]");
  });
  it("clipMiddle keeps the head and the tail", () => {
    const t = "HEAD" + "x".repeat(1000) + "TAIL";
    const c = clipMiddle(t, 100);
    expect(c.startsWith("HEAD")).toBe(true);
    expect(c.endsWith("TAIL")).toBe(true);
    expect(c.length).toBeLessThanOrEqual(100);
    expect(clipMiddle("short", 100)).toBe("short");
  });
});

describe("pickWriter: one writer per run", () => {
  it("keeps the run's writer while it is still an option, even when another is now better", () => {
    const d = decision();
    const w = pickWriter({ options: d.options, already: HAIKU, preferred: [OPUS] });
    expect(w.basis).toBe("already");
    expect(w.option!.rung.key).toBe(HAIKU);
  });
  it("otherwise the owner's preferred list, in order", () => {
    const d = decision();
    const w = pickWriter({ options: d.options, preferred: ["nope/none", SONNET, OPUS] });
    expect(w.basis).toBe("preferred");
    expect(w.option!.rung.key).toBe(SONNET);
  });
  it("otherwise the best quality", () => {
    const d = decision();
    const w = pickWriter({ options: d.options });
    expect(w.basis).toBe("best-quality");
    const best = Math.max(...d.options.filter((o) => o.feed === "brief").map((o) => o.quality));
    expect(w.option!.quality).toBe(best);
  });
  it("a writer that is no longer an option is replaced, not insisted on", () => {
    const d = decision({ rungs: [R.sonnet, R.haiku] });
    expect(pickWriter({ options: d.options, already: OPUS }).basis).toBe("best-quality");
  });
  it("no brief option, no writer", () => {
    expect(pickWriter({ options: [] })).toEqual({ basis: "none" });
  });
});

describe("guessLanguage and finishBrief", () => {
  it("tells English, Spanish and Catalan apart on ordinary sentences", () => {
    expect(
      guessLanguage(
        "The build is failing because the test is not using the right path for the file",
      ),
    ).toBe("en");
    expect(
      guessLanguage(
        "El proceso no funciona porque la ruta del archivo es incorrecta y no se encuentra",
      ),
    ).toBe("es");
    expect(
      guessLanguage("El procés no funciona perquè la ruta de l'arxiu és incorrecta i no es troba"),
    ).toBe("ca");
  });
  it("says unknown for a few words", () => {
    expect(guessLanguage("ok")).toBe("unknown");
  });
  it("the writer brief names the language, keeps the rules and carries the content", () => {
    const b = finishBrief({ content: "hello", language: "ca" });
    expect(b).toContain("Catalan");
    expect(b).toContain("code block");
    expect(b).toContain("CONTENT:\nhello");
    expect(finishBrief({ content: "x", language: "unknown" })).toContain("already in");
  });
});

describe("freshPointDecision: a check or a finish starts with a brief and no warm thread", () => {
  const params = () => callParams({ feedTokens: { thread: 200_000 } });

  it("prices the brief, not the thread", () => {
    const d = freshPointDecision(params(), "check", 3_000)!;
    expect(d.options.every((o) => o.inputTokens === 3_000)).toBe(true);
    expect(d.options.some((o) => o.feed === "brief")).toBe(true);
  });
  it("is a fresh point: nothing warm to lose, so the pick stands", () => {
    const d = freshPointDecision(params(), "write", 3_000)!;
    expect(["fresh", "keep"]).toContain(d.switch.kind);
    expect(d.switch.reason).not.toBe("cache-cold");
  });
  it("a hand-picked model gets no check and no rewrite", () => {
    expect(freshPointDecision({ ...params(), handPicked: true }, "check", 3_000)).toBeUndefined();
    expect(freshPointDecision({ ...params(), handPicked: true }, "write", 3_000)).toBeUndefined();
  });
  it("keeps the run's privacy: a private task only reaches the approved providers", () => {
    const d = freshPointDecision(
      { ...params(), task: { ...params().task, private: true } },
      "check",
      3_000,
    )!;
    expect(d.options.every((o) => o.rung.key.startsWith("claude-code/"))).toBe(true);
    expect(pickChecker({ builderKey: OPUS, options: d.options }).reason).toBe("no-other-family");
  });
  it("carries the run's ids so the record joins to the call it follows", () => {
    const d = freshPointDecision(params(), "check", 3_000)!;
    expect(d.runId).toBe("run-1");
    expect(d.id).toBe("d1:check");
  });
});

describe("the digest reader's decision", () => {
  it("a read is routine work, priced on the brief, and picks the cheapest that clears the lower bar", () => {
    const base = callParams({ feedTokens: { thread: 200_000 }, dialBar: 60 });
    const read = freshPointDecision(base, "read", 20_000)!;
    const check = freshPointDecision(base, "check", 20_000)!;
    expect(read.options.every((o) => o.inputTokens === 20_000)).toBe(true);
    expect(read.chosen.price).toBeLessThanOrEqual(check.chosen.price);
  });
  it("a hand-picked model gets no reader either", () => {
    expect(freshPointDecision(callParams({ handPicked: true }), "read", 20_000)).toBeUndefined();
  });
});

describe("parseCheckVerdict", () => {
  it("reads HOLDS and PROBLEMS, with the detail", () => {
    expect(parseCheckVerdict("HOLDS")).toEqual({ verdict: "holds", detail: "" });
    expect(parseCheckVerdict("holds. the numbers match")).toEqual({
      verdict: "holds",
      detail: "the numbers match",
    });
    expect(parseCheckVerdict("PROBLEMS: the table sums to 41, not 42")).toEqual({
      verdict: "problems",
      detail: "the table sums to 41, not 42",
    });
  });
  it("anything else is unclear and carries the text", () => {
    expect(parseCheckVerdict("It seems fine to me")).toEqual({
      verdict: "unclear",
      detail: "It seems fine to me",
    });
    expect(parseCheckVerdict("")).toEqual({ verdict: "unclear", detail: "" });
  });
  it("the brief asks for exactly those words", () => {
    const b = checkBrief({ work: "w", claim: "c" });
    expect(b).toContain("HOLDS");
    expect(b).toContain("PROBLEMS:");
  });
});

describe("rewriteKeepsFacts: one writer is a voice, not a licence to lose a fact", () => {
  const original =
    "Deployed build 20260930 to https://example.com/x. Run `pnpm test` (1,204 passed).\n```sh\nnpm i\n```";
  it("accepts a rewrite that keeps everything", () => {
    const rewrite =
      "The build 20260930 is live at https://example.com/x. Running `pnpm test` gave 1,204 passed.\n```sh\nnpm i\n```";
    expect(rewriteKeepsFacts(original, rewrite)).toEqual({ ok: true });
  });
  it("rejects a lost number, URL, code span or fence", () => {
    expect(
      rewriteKeepsFacts(
        original,
        "Deployed build 20260930 to https://example.com/x. Run `pnpm test`.\n```sh\nnpm i\n```",
      ).reason,
    ).toMatch(/^lost:/);
    expect(
      rewriteKeepsFacts(
        original,
        "Deployed build 20260930. Run `pnpm test` (1,204 passed).\n```sh\nnpm i\n```",
      ).reason,
    ).toMatch(/^lost:/);
    expect(
      rewriteKeepsFacts(
        original,
        "Deployed build 20260930 to https://example.com/x, 1,204 passed.\n```sh\nnpm i\n```",
      ).reason,
    ).toMatch(/^lost:/);
    expect(
      rewriteKeepsFacts(
        original,
        "Deployed build 20260930 to https://example.com/x. Run `pnpm test` (1,204 passed).",
      ).reason,
    ).toBe("code-fences-differ");
  });
  it("a number written another way is still the same number, and a changed one is not", () => {
    const o = "Total 1,204 items, build 20260930, ratio 3.14159.";
    expect(
      rewriteKeepsFacts(o, "There are 1204 items in build 20260930 with ratio 3.14159 overall."),
    ).toEqual({ ok: true });
    expect(
      rewriteKeepsFacts(o, "There are 1,205 items in build 20260930 with ratio 3.14159 overall.")
        .reason,
    ).toBe("lost:number:1204");
    // one- and two-digit numbers are not treated as facts worth failing a rewrite over
    expect(
      rewriteKeepsFacts(
        "Step 2 of 10 done for 1,204 items.",
        "Two of ten steps done for 1,204 items.",
      ),
    ).toEqual({ ok: true });
  });
  it("rejects an empty rewrite and one far shorter or longer", () => {
    expect(rewriteKeepsFacts(original, "  ").reason).toBe("empty");
    expect(rewriteKeepsFacts("x".repeat(1000), "y").reason).toBe("length-out-of-range");
    expect(rewriteKeepsFacts("x", "y".repeat(100)).reason).toBe("length-out-of-range");
  });
});
