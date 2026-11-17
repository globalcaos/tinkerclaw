/**
 * The "Token burner" tab (left nav, below Recipes). The token-burner skill spends a flat
 * subscription's spare weekly quota; this tab decides what that spare quota is FOR. Top to
 * bottom: the chosen objective as a headline, the five objective cards (exactly one chosen),
 * the strategy text, the governing prompt file, "Suggest from my chat history" with its draft
 * card, and the dashboard link when one is set.
 *
 * Data: the tinkerclaw-token-burner plugin's gateway methods tokenBurner.settings.get/set and
 * tokenBurner.suggest. The prompt link is a plain `.fs-link`, so the page-wide handler opens it
 * the same way as every other file link (config.openExternalFile, or in the browser when the
 * gateway runs on another machine).
 */

export type ObjectiveId = "revenue" | "code" | "research" | "backlog" | "custom";

export type TbSettings = {
  objective: ObjectiveId;
  customName: string;
  strategy: string;
  promptPath: string;
  dashboardUrl: string;
  updatedAt: string | null;
};

export type TbProposal = {
  objective: ObjectiveId;
  customName: string;
  strategy: string;
  why: string;
};

export type TbState = {
  settings: TbSettings;
  prompt: { path: string; mtime: string | null };
  /** Objective picked in the cards but not saved yet (custom without a name). */
  pendingObjective: ObjectiveId | null;
  strategyDraft: string;
  notice: { kind: "ok" | "error"; text: string } | null;
  suggest:
    | { phase: "idle" }
    | { phase: "running"; startedAt: number }
    | { phase: "draft"; proposal: TbProposal }
    | { phase: "failed"; reason: string };
  loadError?: string;
};

export const OBJECTIVE_CARDS: ReadonlyArray<{ id: ObjectiveId; label: string; hint: string }> = [
  {
    id: "revenue",
    label: "Maximize revenue",
    hint: "Jobs that move a paid product or offer forward.",
  },
  {
    id: "code",
    label: "Improve and harden my code",
    hint: "Tests, fixes and refactors in your repos.",
  },
  {
    id: "research",
    label: "Research and learning",
    hint: "Read, compare and sum up what you want to learn.",
  },
  {
    id: "backlog",
    label: "Clear my project backlog",
    hint: "Finish parked projects, one at a time.",
  },
  { id: "custom", label: "Custom", hint: "Name your own goal." },
];

export function objectiveLabel(objective: ObjectiveId, customName: string): string {
  if (objective === "custom") return customName.trim() || "Custom";
  return OBJECTIVE_CARDS.find((o) => o.id === objective)?.label ?? objective;
}

export function headline(s: TbSettings): string {
  return `Spare tokens go to: ${objectiveLabel(s.objective, s.customName)}`;
}

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function relTime(iso: string | null, now: number): string {
  if (!iso) return "never";
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / 86_400_000)} days ago`;
}

const FLAME =
  '<svg class="tb-flame" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>';

export function renderTokenBurner(st: TbState, now: number): string {
  const s = st.settings;
  const chosen = st.pendingObjective ?? s.objective;
  const cards = OBJECTIVE_CARDS.map((o) => {
    const on = o.id === chosen;
    const name =
      o.id === "custom" && on
        ? `<input class="tb-custom-name" type="text" maxlength="60" placeholder="Short name, e.g. Ship the phone app" value="${esc(s.customName)}" data-tb="custom-name">`
        : "";
    return `<label class="tb-card${on ? " is-on" : ""}"><input type="radio" name="tb-objective" value="${o.id}"${on ? " checked" : ""} data-tb="objective"><span class="tb-card-label">${esc(o.label)}</span><span class="tb-card-hint">${esc(o.hint)}</span>${name}</label>`;
  }).join("");

  const dirty = st.strategyDraft !== s.strategy;
  const notice = st.notice
    ? `<div class="tb-notice tb-notice--${st.notice.kind}" role="status">${esc(st.notice.text)}</div>`
    : "";

  let suggest = "";
  const sg = st.suggest;
  if (sg.phase === "running") {
    const secs = Math.max(0, Math.round((now - sg.startedAt) / 1000));
    suggest = `<div class="tb-progress" role="status"><span class="tb-spinner"></span><span>Reading your recent chats and memory… <span class="tb-secs">${secs}</span> s. This can take a minute or two.</span></div>`;
  } else if (sg.phase === "failed") {
    suggest = `<div class="tb-notice tb-notice--error" role="status">${esc(sg.reason)}</div>`;
  } else if (sg.phase === "draft") {
    const p = sg.proposal;
    suggest = `<div class="tb-draft"><div class="tb-draft-title">Draft, not saved</div><div class="tb-draft-headline">Spare tokens go to: <b>${esc(objectiveLabel(p.objective, p.customName))}</b></div>${p.why ? `<div class="tb-draft-why">${esc(p.why)}</div>` : ""}<pre class="tb-draft-strategy">${esc(p.strategy)}</pre><div class="tb-actions"><button class="tb-btn tb-btn--primary" data-tb="accept">Accept</button><button class="tb-btn" data-tb="discard">Discard</button></div></div>`;
  }

  const dash = s.dashboardUrl
    ? `<section class="tb-section tb-dash"><a class="tb-dash-link" href="${esc(s.dashboardUrl)}" target="_blank" rel="noopener">Open the dashboard ↗</a></section>`
    : "";

  return `<div class="tb-view">
  ${st.loadError ? `<div class="tb-notice tb-notice--error">${esc(st.loadError)}</div>` : ""}
  <div class="tb-headline">${FLAME}<div><div class="tb-headline-text">${esc(headline(s))}</div><div class="tb-headline-sub">Saved ${esc(relTime(s.updatedAt, now))}</div></div></div>
  ${notice}
  <section class="tb-section">
    <h3>Objective</h3>
    <p class="tb-help">Pick one. Every job the burner plans carries it.</p>
    <div class="tb-cards" role="radiogroup" aria-label="Objective">${cards}</div>
  </section>
  <section class="tb-section">
    <h3>Strategy</h3>
    <p class="tb-help">How the objective is pursued: which jobs, how each result is checked, what is off limits.</p>
    <textarea class="tb-strategy" rows="7" maxlength="4000" data-tb="strategy" placeholder="A few short lines.">${esc(st.strategyDraft)}</textarea>
    <div class="tb-actions"><button class="tb-btn tb-btn--primary" data-tb="save-strategy"${dirty ? "" : " disabled"}>Save</button><span class="tb-dirty">${dirty ? "Unsaved changes" : ""}</span></div>
  </section>
  <section class="tb-section">
    <h3>Governing prompt</h3>
    <p class="tb-help">The full instructions every job follows. Open it to read or edit the detail.</p>
    <div class="tb-prompt"><code class="fs-link" data-path="${esc(st.prompt.path)}" title="Open the file">${esc(st.prompt.path)}</code><span class="tb-prompt-time">changed ${esc(relTime(st.prompt.mtime, now))}</span></div>
  </section>
  <section class="tb-section">
    <h3>Suggest</h3>
    <p class="tb-help">An agent reads your recent chats and memory and proposes an objective and a strategy. Nothing changes until you accept.</p>
    <div class="tb-actions"><button class="tb-btn" data-tb="suggest"${sg.phase === "running" ? " disabled" : ""}>Suggest from my chat history</button></div>
    ${suggest}
  </section>
  ${dash}
</div>`;
}

export type TbReq = (method: string, params?: unknown) => Promise<any>;

/** Load the settings and run the tab inside `body`. Re-renders in place after every action. */
export async function renderTokenBurnerTab(
  body: HTMLElement,
  sub: HTMLElement,
  req: TbReq,
  opts: { now?: () => number; pollMs?: number } = {},
): Promise<void> {
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 3_000;
  sub.textContent = "Decide what the spare weekly tokens are for.";
  const got = await req("tokenBurner.settings.get", {});
  if (!got?.settings) {
    throw new Error("the token burner plugin did not answer (is tinkerclaw-token-burner enabled?)");
  }
  const st: TbState = {
    settings: got.settings,
    prompt: got.prompt ?? { path: got.settings.promptPath, mtime: null },
    pendingObjective: null,
    strategyDraft: got.settings.strategy,
    notice: null,
    suggest: { phase: "idle" },
    loadError: got.error,
  };
  const paint = () => {
    const focused = document.activeElement as HTMLElement | null;
    const keep = focused?.dataset?.tb;
    const caret =
      focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement
        ? focused.selectionStart
        : null;
    body.innerHTML = renderTokenBurner(st, now());
    if (keep === "strategy" || keep === "custom-name") {
      const el = body.querySelector<HTMLTextAreaElement | HTMLInputElement>(`[data-tb="${keep}"]`);
      el?.focus();
      if (el && caret != null) el.setSelectionRange(caret, caret);
    }
  };

  const save = async (patch: Partial<TbSettings>, okText: string): Promise<boolean> => {
    try {
      const r = await req("tokenBurner.settings.set", { patch });
      if (!r?.ok) {
        st.notice = { kind: "error", text: `Not saved: ${r?.error ?? "no answer"}` };
        return false;
      }
      const draftWasClean = st.strategyDraft === st.settings.strategy;
      st.settings = r.settings;
      if (r.prompt) st.prompt = r.prompt;
      if (draftWasClean || "strategy" in patch) st.strategyDraft = r.settings.strategy;
      st.pendingObjective = null;
      st.notice = { kind: "ok", text: okText };
      return true;
    } catch (err) {
      console.error("[token-burner] settings.set failed", err);
      st.notice = { kind: "error", text: `Not saved: ${(err as Error).message}` };
      return false;
    } finally {
      paint();
    }
  };

  const poll = (runId: string) => {
    setTimeout(async () => {
      if (!body.isConnected || st.suggest.phase !== "running") return;
      try {
        const r = await req("tokenBurner.suggest", { runId });
        if (r?.status === "done") st.suggest = { phase: "draft", proposal: r.proposal };
        else if (r?.status === "failed") st.suggest = { phase: "failed", reason: r.reason };
        else poll(runId);
      } catch (err) {
        console.error("[token-burner] suggest poll failed", err);
        st.suggest = { phase: "failed", reason: `Lost the suggestion: ${(err as Error).message}` };
      }
      paint();
    }, pollMs);
  };

  body.addEventListener("change", (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.dataset.tb === "objective") {
      const id = t.value as ObjectiveId;
      if (id === "custom" && !st.settings.customName) {
        st.pendingObjective = "custom";
        st.notice = null;
        paint();
        body.querySelector<HTMLInputElement>('[data-tb="custom-name"]')?.focus();
        return;
      }
      void save({ objective: id }, `Saved: ${objectiveLabel(id, st.settings.customName)}`);
    } else if (t.dataset.tb === "custom-name") {
      const name = t.value.trim();
      if (name) void save({ objective: "custom", customName: name }, `Saved: ${name}`);
    }
  });
  body.addEventListener("keydown", (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.dataset.tb === "custom-name" && ev.key === "Enter") {
      ev.preventDefault();
      t.blur();
    }
  });
  body.addEventListener("input", (ev) => {
    const t = ev.target as HTMLTextAreaElement;
    if (t.dataset.tb !== "strategy") return;
    const was = st.strategyDraft !== st.settings.strategy;
    st.strategyDraft = t.value;
    const dirty = st.strategyDraft !== st.settings.strategy;
    if (was !== dirty) {
      const btn = body.querySelector<HTMLButtonElement>('[data-tb="save-strategy"]');
      const label = body.querySelector<HTMLElement>(".tb-dirty");
      if (btn) btn.disabled = !dirty;
      if (label) label.textContent = dirty ? "Unsaved changes" : "";
    }
  });
  body.addEventListener("click", async (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("button[data-tb]");
    if (!b) return;
    const action = b.dataset.tb;
    if (action === "save-strategy") {
      await save({ strategy: st.strategyDraft }, "Strategy saved");
    } else if (action === "suggest") {
      st.notice = null;
      st.suggest = { phase: "running", startedAt: now() };
      paint();
      try {
        const r = await req("tokenBurner.suggest", {});
        if (r?.status === "running" && r.runId) {
          poll(r.runId);
          // Only the seconds counter moves, so typing in the strategy box is never interrupted.
          const tick = () => {
            const sg = st.suggest;
            if (!body.isConnected || sg.phase !== "running") return;
            const el = body.querySelector(".tb-secs");
            if (el) el.textContent = String(Math.round((now() - sg.startedAt) / 1000));
            setTimeout(tick, 1_000);
          };
          setTimeout(tick, 1_000);
          return;
        }
        st.suggest = { phase: "failed", reason: r?.reason ?? "The suggestion did not start." };
      } catch (err) {
        console.error("[token-burner] suggest failed", err);
        st.suggest = {
          phase: "failed",
          reason: `The suggestion did not start: ${(err as Error).message}`,
        };
      }
      paint();
    } else if (action === "accept" && st.suggest.phase === "draft") {
      const p = st.suggest.proposal;
      const ok = await save(
        { objective: p.objective, customName: p.customName, strategy: p.strategy },
        `Saved: ${objectiveLabel(p.objective, p.customName)}`,
      );
      if (ok) {
        st.suggest = { phase: "idle" };
        paint();
      }
    } else if (action === "discard") {
      st.suggest = { phase: "idle" };
      paint();
    }
  });

  paint();
}
