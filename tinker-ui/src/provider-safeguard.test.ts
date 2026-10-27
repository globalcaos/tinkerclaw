import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildChatUnits } from "./chat-units.js";
import { assistantTextOfPayloadMessage } from "./error-bubble.js";
import { providerSafeguardOutcome, renderProviderSafeguard } from "./provider-safeguard.js";

const detail = "API Error: Provider safeguards flagged this message";
const blocked = (extra = {}) => ({
  role: "assistant",
  content: [{ type: "text", text: detail }],
  turnId: "shared",
  ...extra,
});
const user = (text: string) => ({ role: "user", content: text, turnId: "shared" });

function fragment(html: string) {
  return document.createRange().createContextualFragment(html);
}

describe("provider safeguard notice", () => {
  it("retains the shadow-mode notice without the removed Edit prompt button", () => {
    const html = renderProviderSafeguard(
      blocked({ enforced: false, state: "settled", mode: "shadow" }),
    )!;
    expect(html).toContain('data-outcome-kind="refusal"');
    expect(fragment(html).querySelector("button")).toBeNull();
    expect(html).not.toMatch(/Edit prompt|data-safeguard-edit|Rewind|retry-provider|data-amy-act/);
  });

  it("the actual run builder keeps sequential block notices without adding prompt controls", () => {
    const view = [user("First"), blocked(), user("Second"), blocked()];
    const html = buildChatUnits(view, {
      renderMsg: (msg) => renderProviderSafeguard(msg) ?? "",
      extractUserText: (m) =>
        (m as { role: string }).role === "user" ? assistantTextOfPayloadMessage(m) : null,
      expandedTools: new Set(),
      streamRunId: null,
      streamMsgUid: null,
      esc: (s) => s,
      skillNoticesHtmlAfter: () => "",
      renderThinkingIndicator: () => "",
      queuedRows: () => [],
    })
      .map((u) => u.html)
      .join("");
    const dom = fragment(html);
    expect(dom.querySelectorAll('[data-outcome-kind="refusal"]')).toHaveLength(2);
    expect(dom.querySelectorAll("button")).toHaveLength(0);
    expect(html).not.toMatch(/data-amy-act|rewind|data-safeguard-edit/);
  });

  it("handles typed and contentless outcomes without exposing controls", () => {
    const m = blocked({
      content: [],
      outcome: { kind: "refusal", recoverable: false, headline: "Blocked", detail, source: "cli" },
    });
    const html = renderProviderSafeguard(m)!;
    expect(html).toContain('data-outcome-kind="refusal"');
    expect(fragment(html).querySelector("button")).toBeNull();
  });

  it("handles safeguard envelopes and preserves real partial answers", () => {
    const m = blocked({
      content: `Partial answer\n__ERR_ENV__:${JSON.stringify({ category: "safeguard", raw: detail })}`,
    });
    const html = renderProviderSafeguard(m)!;
    expect(html).toContain("Partial answer");
    expect(html).toContain('data-outcome-kind="refusal"');
  });

  it("keeps the partial answer preceding a raw error on a structurally failed message", () => {
    const m = blocked({ stopReason: "error", content: `Partial answer\n${detail}` });
    const html = renderProviderSafeguard(m)!;
    expect(html).toContain('<div class="msg assistant">Partial answer</div>');
    expect(html).toContain('data-outcome-kind="refusal"');
  });

  it("does not classify ordinary prose, quoted errors, provider overloads or malformed envelopes", () => {
    for (const content of [
      "I cannot answer",
      "We discussed safeguards flagged in the logs",
      "API Error: 529 overloaded",
      `Here is a quoted error:\n${detail}`,
      "__ERR_ENV__:null",
      "__ERR_ENV__:{bad",
    ]) {
      expect(providerSafeguardOutcome(blocked({ content }))).toBeNull();
    }
    expect(providerSafeguardOutcome(user(detail))).toBeNull();
  });

  it("has no prompt-edit handler or network/model-selection capability", () => {
    const src = readFileSync(new NodeURL("./provider-safeguard.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(
      /editSafeguardPrompt|originalPromptBefore|data-safeguard-edit|thalamus\.retryPick|sendOneTurn|sessions\.rewind|amygdala2\.rewind|fetch\(|\.req\(/,
    );
    const app = readFileSync(new NodeURL("./app.ts", import.meta.url), "utf8");
    expect(app).not.toMatch(/editSafeguardPrompt|originalPromptBefore|data-safeguard-edit/);
    expect(app).toContain("amyUi.afterRun(userMsg, nextUserMsg, safeguard)");
  });
});
