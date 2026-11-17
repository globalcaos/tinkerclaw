// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  headline,
  objectiveLabel,
  relTime,
  renderTokenBurner,
  renderTokenBurnerTab,
  type TbSettings,
  type TbState,
} from "./token-burner-tab.js";

const NOW = Date.parse("2026-11-03T12:00:00Z");

function settings(over: Partial<TbSettings> = {}): TbSettings {
  return {
    objective: "code",
    customName: "",
    strategy: "fix flaky tests first",
    promptPath: "/state/token-burner/prompt.md",
    dashboardUrl: "",
    updatedAt: "2026-11-03T11:00:00Z",
    ...over,
  };
}

function state(over: Partial<TbState> = {}): TbState {
  const s = over.settings ?? settings();
  return {
    settings: s,
    prompt: { path: s.promptPath, mtime: "2026-11-01T12:00:00Z" },
    pendingObjective: null,
    strategyDraft: s.strategy,
    notice: null,
    suggest: { phase: "idle" },
    ...over,
  };
}

function dom(html: string): HTMLElement {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d;
}

describe("renderTokenBurner", () => {
  it("states the chosen objective as a headline and marks exactly one card", () => {
    const el = dom(renderTokenBurner(state({ settings: settings({ objective: "revenue" }) }), NOW));
    expect(el.querySelector(".tb-headline-text")!.textContent).toBe(
      "Spare tokens go to: Maximize revenue",
    );
    const on = el.querySelectorAll(".tb-card.is-on");
    expect(on).toHaveLength(1);
    expect(on[0].textContent).toContain("Maximize revenue");
    expect(el.querySelectorAll('input[name="tb-objective"]:checked')).toHaveLength(1);
    expect(el.querySelectorAll(".tb-card")).toHaveLength(5);
  });

  it("shows a name field only on the chosen custom card, and uses the name in the headline", () => {
    expect(dom(renderTokenBurner(state(), NOW)).querySelector(".tb-custom-name")).toBeNull();
    const s = settings({ objective: "custom", customName: "Ship the app" });
    const el = dom(renderTokenBurner(state({ settings: s }), NOW));
    expect((el.querySelector(".tb-custom-name") as HTMLInputElement).value).toBe("Ship the app");
    expect(headline(s)).toBe("Spare tokens go to: Ship the app");
    expect(objectiveLabel("custom", "")).toBe("Custom");
  });

  it("links the governing prompt as a file link with its age", () => {
    const el = dom(renderTokenBurner(state(), NOW));
    const link = el.querySelector(".tb-prompt .fs-link") as HTMLElement;
    expect(link.dataset.path).toBe("/state/token-burner/prompt.md");
    expect(el.querySelector(".tb-prompt-time")!.textContent).toBe("changed 2 days ago");
  });

  it("shows the dashboard link only when a URL is set", () => {
    expect(dom(renderTokenBurner(state(), NOW)).querySelector(".tb-dash-link")).toBeNull();
    const el = dom(
      renderTokenBurner(
        state({ settings: settings({ dashboardUrl: "https://example.test/" }) }),
        NOW,
      ),
    );
    const a = el.querySelector(".tb-dash-link") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("https://example.test/");
    expect(a.textContent).toContain("Open the dashboard");
  });

  it("escapes stored text", () => {
    const el = dom(
      renderTokenBurner(
        state({
          settings: settings({ objective: "custom", customName: '<img src=x onerror="1">' }),
        }),
        NOW,
      ),
    );
    expect(el.querySelector("img")).toBeNull();
  });

  it("enables Save only when the strategy changed", () => {
    const clean = dom(renderTokenBurner(state(), NOW));
    expect((clean.querySelector('[data-tb="save-strategy"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    const dirty = dom(renderTokenBurner(state({ strategyDraft: "something else" }), NOW));
    expect((dirty.querySelector('[data-tb="save-strategy"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(dirty.querySelector(".tb-dirty")!.textContent).toBe("Unsaved changes");
  });

  it("draws progress, a draft card with Accept and Discard, and a failure reason", () => {
    const running = dom(
      renderTokenBurner(state({ suggest: { phase: "running", startedAt: NOW - 42_000 } }), NOW),
    );
    expect(running.querySelector(".tb-progress")!.textContent).toContain("42 s");
    expect((running.querySelector('[data-tb="suggest"]') as HTMLButtonElement).disabled).toBe(true);
    const draft = dom(
      renderTokenBurner(
        state({
          suggest: {
            phase: "draft",
            proposal: {
              objective: "research",
              customName: "",
              strategy: "read",
              why: "lots of papers",
            },
          },
        }),
        NOW,
      ),
    );
    expect(draft.querySelector(".tb-draft-headline")!.textContent).toBe(
      "Spare tokens go to: Research and learning",
    );
    expect(draft.querySelector('[data-tb="accept"]')).not.toBeNull();
    expect(draft.querySelector('[data-tb="discard"]')).not.toBeNull();
    const failed = dom(
      renderTokenBurner(state({ suggest: { phase: "failed", reason: "No model is set" } }), NOW),
    );
    expect(failed.querySelector(".tb-notice--error")!.textContent).toBe("No model is set");
  });

  it("formats ages", () => {
    expect(relTime(null, NOW)).toBe("never");
    expect(relTime("2026-11-03T11:59:30Z", NOW)).toBe("just now");
    expect(relTime("2026-11-03T11:30:00Z", NOW)).toBe("30 min ago");
  });
});

describe("renderTokenBurnerTab", () => {
  let body: HTMLElement;
  let sub: HTMLElement;
  let stored: TbSettings;

  beforeEach(() => {
    body = document.createElement("div");
    sub = document.createElement("p");
    document.body.append(body, sub);
    stored = settings();
  });
  afterEach(() => {
    body.remove();
    sub.remove();
  });

  function fakeReq(suggestReplies: unknown[] = []) {
    return vi.fn(async (method: string, params?: any) => {
      if (method === "tokenBurner.settings.get") {
        return { ok: true, settings: stored, prompt: { path: stored.promptPath, mtime: null } };
      }
      if (method === "tokenBurner.settings.set") {
        stored = { ...stored, ...params.patch, updatedAt: "2026-11-03T12:00:00Z" };
        return { ok: true, settings: stored };
      }
      if (method === "tokenBurner.suggest") return suggestReplies.shift();
      throw new Error(`unexpected ${method}`);
    });
  }

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("saves a new objective when a card is picked", async () => {
    const req = fakeReq();
    await renderTokenBurnerTab(body, sub, req, { now: () => NOW });
    const radio = body.querySelector('input[value="backlog"]') as HTMLInputElement;
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(req).toHaveBeenCalledWith("tokenBurner.settings.set", {
      patch: { objective: "backlog" },
    });
    expect(body.querySelector(".tb-headline-text")!.textContent).toBe(
      "Spare tokens go to: Clear my project backlog",
    );
  });

  it("asks for a name before saving a custom objective", async () => {
    const req = fakeReq();
    await renderTokenBurnerTab(body, sub, req, { now: () => NOW });
    const radio = body.querySelector('input[value="custom"]') as HTMLInputElement;
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(req).not.toHaveBeenCalledWith("tokenBurner.settings.set", expect.anything());
    const name = body.querySelector(".tb-custom-name") as HTMLInputElement;
    name.value = "Ship the app";
    name.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(req).toHaveBeenCalledWith("tokenBurner.settings.set", {
      patch: { objective: "custom", customName: "Ship the app" },
    });
  });

  it("saves the strategy with Save", async () => {
    const req = fakeReq();
    await renderTokenBurnerTab(body, sub, req, { now: () => NOW });
    const ta = body.querySelector(".tb-strategy") as HTMLTextAreaElement;
    ta.value = "new plan";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    (body.querySelector('[data-tb="save-strategy"]') as HTMLButtonElement).click();
    await flush();
    expect(req).toHaveBeenCalledWith("tokenBurner.settings.set", {
      patch: { strategy: "new plan" },
    });
    expect(body.querySelector(".tb-notice--ok")!.textContent).toBe("Strategy saved");
  });

  it("runs a suggestion to a draft and saves nothing until Accept", async () => {
    const proposal = {
      objective: "research",
      customName: "",
      strategy: "read more",
      why: "papers",
    };
    const req = fakeReq([
      { status: "running", runId: "r1" },
      { status: "running" },
      { status: "done", proposal },
    ]);
    await renderTokenBurnerTab(body, sub, req, { now: () => NOW, pollMs: 1 });
    (body.querySelector('[data-tb="suggest"]') as HTMLButtonElement).click();
    await flush();
    expect(body.querySelector(".tb-progress")).not.toBeNull();
    await vi.waitFor(() => expect(body.querySelector(".tb-draft")).not.toBeNull());
    expect(req).toHaveBeenCalledWith("tokenBurner.suggest", { runId: "r1" });
    expect(req).not.toHaveBeenCalledWith("tokenBurner.settings.set", expect.anything());
    (body.querySelector('[data-tb="accept"]') as HTMLButtonElement).click();
    await flush();
    expect(req).toHaveBeenCalledWith("tokenBurner.settings.set", {
      patch: { objective: "research", customName: "", strategy: "read more" },
    });
    expect(body.querySelector(".tb-draft")).toBeNull();
    expect((body.querySelector(".tb-strategy") as HTMLTextAreaElement).value).toBe("read more");
  });

  it("Discard drops the draft without saving", async () => {
    const proposal = { objective: "revenue", customName: "", strategy: "sell", why: "" };
    const req = fakeReq([
      { status: "running", runId: "r1" },
      { status: "done", proposal },
    ]);
    await renderTokenBurnerTab(body, sub, req, { now: () => NOW, pollMs: 1 });
    (body.querySelector('[data-tb="suggest"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(body.querySelector(".tb-draft")).not.toBeNull());
    (body.querySelector('[data-tb="discard"]') as HTMLButtonElement).click();
    expect(body.querySelector(".tb-draft")).toBeNull();
    expect(req).not.toHaveBeenCalledWith("tokenBurner.settings.set", expect.anything());
  });

  it("a refused start shows its reason", async () => {
    const req = fakeReq([
      { status: "failed", reason: "No model is set for agents on this gateway." },
    ]);
    await renderTokenBurnerTab(body, sub, req, { now: () => NOW });
    (body.querySelector('[data-tb="suggest"]') as HTMLButtonElement).click();
    await flush();
    expect(body.querySelector(".tb-notice--error")!.textContent).toMatch(/No model/);
  });

  it("fails loudly when the plugin does not answer", async () => {
    const req = vi.fn(async () => undefined);
    await expect(renderTokenBurnerTab(body, sub, req)).rejects.toThrow(/tinkerclaw-token-burner/);
  });
});
