import { describe, expect, it } from "vitest";
import { getProviderLogoSvg, getRoutedLogoSvg, PROVIDER_LOGO_SVG } from "./provider-logos";
import { VENDOR_MARKS } from "./vendor-marks";

/**
 * THE BUG, and why prose would not have caught it.
 *
 * the user, on a Claude turn: what looked like an OpenRouter icon in the thinking
 * indicator. It was not OpenRouter's — it was UNKNOWN_MARK_SVG, this file's neutral
 * "reached through a router, vendor unidentified" glyph, which is a wordless
 * node-and-branch mark and therefore looks exactly like a router logo.
 *
 * A live browser probe pinned the RESOLVER rather than the artwork:
 *
 *   getRoutedLogoSvg("claude-opus-5", "")              -> router glyph
 *   getRoutedLogoSvg("claude-opus-5", "claude-opus-5") -> router glyph
 *   getRoutedLogoSvg("claude-code/claude-opus-5", "")  -> router glyph
 *   getRoutedLogoSvg("claude-opus-5", "claude-code")   -> Anthropic sparkle
 *
 * Only the last one carries a provider. app.ts builds it as
 * `(synthetic ? viewedSessionRowProvider() : primary.provider) || ""` at ~14542 and
 * ~14584, so an empty provider is a normal runtime value — and the model id said
 * "claude" in plain English the whole time. The four probes are the first block below,
 * verbatim.
 *
 * The rest of this file guards the things that keep the fix a fix instead of a new lie
 * generator: a vendor the id STATES beats one inferred from it; an open-weight
 * ARCHITECTURE name is never a vendor claim; and a provider we already resolve
 * correctly is left alone.
 *
 * RUN IT WITH THE PROJECT CONFIG:  pnpm test:tinker-ui
 * `vitest run tinker-ui/src/panels/provider-logos` from the repo root matches no
 * project, prints "No test files found" and exits 1 — which under a quiet reporter
 * reads as a pass. See the header of test/vitest/vitest.tinker-ui.config.ts.
 */

/** The neutral glyph, identified by the thing that makes it unmistakable. */
const UNKNOWN = /<title>provider unknown<\/title>/;

describe("getRoutedLogoSvg — the four live probes", () => {
  it("an empty provider on a Claude model is Anthropic, not the router glyph", () => {
    expect(getRoutedLogoSvg("claude-opus-5", "")).toBe(PROVIDER_LOGO_SVG.anthropic);
  });

  it("a provider that merely echoes the model id resolves the same way", () => {
    expect(getRoutedLogoSvg("claude-opus-5", "claude-opus-5")).toBe(PROVIDER_LOGO_SVG.anthropic);
  });

  it("a 2-segment cc-bridge id with no provider still resolves", () => {
    expect(getRoutedLogoSvg("claude-code/claude-opus-5", "")).toBe(PROVIDER_LOGO_SVG.anthropic);
  });

  it("the one probe that already worked keeps working", () => {
    expect(getRoutedLogoSvg("claude-opus-5", "claude-code")).toBe(PROVIDER_LOGO_SVG.anthropic);
  });

  it("no Claude turn shows the neutral glyph, whatever the provider field holds", () => {
    for (const p of ["", "claude-opus-5", "claude-code", "openrouter", "not-a-provider"]) {
      expect(getRoutedLogoSvg("claude-opus-5", p)).not.toMatch(UNKNOWN);
    }
  });
});

describe("getRoutedLogoSvg — a vendor the id STATES outranks one inferred from it", () => {
  it("reads the middle segment of a 3-segment routed id", () => {
    expect(getRoutedLogoSvg("openrouter/anthropic/claude-fable-5.1", "openrouter")).toBe(
      PROVIDER_LOGO_SVG.anthropic,
    );
  });

  it("reads the LEADING segment of the 2-segment ids openclaw.json actually stores", () => {
    // Every routed id in the live catalog is 2-segment, so the `>= 3` gate never fired
    // for any of them and they all drew the glyph.
    expect(getRoutedLogoSvg("tencent/hy3", "")).toBe(PROVIDER_LOGO_SVG.hunyuan);
    expect(getRoutedLogoSvg("minimax/minimax-m3", "")).toBe(PROVIDER_LOGO_SVG.minimax);
  });

  it("credits the fine-tuner named in the id, not the architecture in the name", () => {
    // NVIDIA's Nemotron is built ON Llama and is NOT Meta's model. The id says nvidia.
    const nemotron = "nvidia/llama-3.3-nemotron-super-49b";
    expect(getRoutedLogoSvg(nemotron, "")).toBe(PROVIDER_LOGO_SVG.nvidia);
  });

  it("still lets vendorOfModel win at step 1, distill ordering intact", () => {
    expect(getRoutedLogoSvg("deepseek/deepseek-r1-distill-qwen-32b", "openrouter")).toBe(
      VENDOR_MARKS.deepseek.svg,
    );
    expect(getRoutedLogoSvg("moonshotai/kimi-k3", "")).toBe(VENDOR_MARKS.kimi.svg);
  });
});

describe("getRoutedLogoSvg — the closed-weight family read", () => {
  it("names OpenAI from gpt-, codex and chatgpt- ids", () => {
    expect(getRoutedLogoSvg("gpt-5.6-sol", "")).toBe(PROVIDER_LOGO_SVG.openai);
    expect(getRoutedLogoSvg("gpt-oss-120b", "")).toBe(PROVIDER_LOGO_SVG.openai);
    expect(getRoutedLogoSvg("chatgpt-4o-latest", "")).toBe(PROVIDER_LOGO_SVG.openai);
  });

  it("names OpenAI from the o-series, which is matched LAST because it is generic", () => {
    expect(getRoutedLogoSvg("o1-preview", "")).toBe(PROVIDER_LOGO_SVG.openai);
    expect(getRoutedLogoSvg("openai/o3-mini", "")).toBe(PROVIDER_LOGO_SVG.openai);
    // …and a brand token beats it: `-code-` is not `-codex`, and /grok/ is tested first
    expect(getRoutedLogoSvg("grok-code-fast-1", "")).toBe(PROVIDER_LOGO_SVG.xai);
  });

  it("names xAI and Google", () => {
    expect(getRoutedLogoSvg("grok-4.6", "")).toBe(PROVIDER_LOGO_SVG.xai);
    expect(getRoutedLogoSvg("gemini-3.1-pro-preview", "")).toBe(PROVIDER_LOGO_SVG.google);
  });
});

describe("getRoutedLogoSvg — what it must NEVER do", () => {
  it("treats an open-weight ARCHITECTURE name as no vendor claim at all", () => {
    // llama / mistral / qwen / gemma name architectures dozens of orgs republish.
    // Hermes is Nous Research's, Sonar is Perplexity's, and `gemma` under Ollama is
    // Google's architecture on someone else's runtime. Painting Meta or Google on any
    // of them is the exact lie the 2026-08-30 fork removed, so they keep the glyph.
    const hermes = "openrouter/nousresearch/hermes-3-llama-3.1-405b";
    expect(getRoutedLogoSvg(hermes, "")).toMatch(UNKNOWN);
    expect(getRoutedLogoSvg("perplexity/llama-3.1-sonar-large", "")).toMatch(UNKNOWN);
    expect(getRoutedLogoSvg("ollama/gemma4:26b", "")).toMatch(UNKNOWN);
    expect(getRoutedLogoSvg("mistral-large-2411", "")).toMatch(UNKNOWN);
  });

  it("never lets the substring in 'ollama' read as Meta", () => {
    // /llama/ matches inside "ollama". An unanchored entry would have branded every
    // local Ollama row with Meta's trademark on the empty-provider path.
    for (const id of ["ollama", "ollama/phi4", "ollama/mistral:7b"]) {
      expect(getRoutedLogoSvg(id, "")).toMatch(UNKNOWN);
    }
  });

  it("leaves a provider it already resolves correctly untouched", () => {
    expect(getRoutedLogoSvg("gpt-4o", "github-copilot")).toBe(PROVIDER_LOGO_SVG["github-copilot"]);
    // a mark no family read can produce, so this can only have come from the provider
    // step — which is what proves that step is still alive and still runs first
    expect(getRoutedLogoSvg("some-unlabelled-model", "ollama")).toBe(PROVIDER_LOGO_SVG.ollama);
  });

  it("says 'provider unknown' rather than borrowing a brand", () => {
    for (const id of ["nex-n2-pro", "inkling-small", "ling-3.0-flash", "command-r7b"]) {
      const svg = getRoutedLogoSvg(id, "");
      expect(svg).toMatch(UNKNOWN);
      expect(svg).not.toBe(PROVIDER_LOGO_SVG.anthropic);
    }
  });

  it("does not answer an Object.prototype key with something off the prototype", () => {
    // A bare `TABLE[key]` returns a truthy FUNCTION for these, and callers inject the
    // result straight into innerHTML.
    expect(getProviderLogoSvg("constructor")).toMatch(UNKNOWN);
    expect(getProviderLogoSvg("toString")).toMatch(UNKNOWN);
    expect(getRoutedLogoSvg("unlabelled-thing", "constructor")).toMatch(UNKNOWN);
  });
});
