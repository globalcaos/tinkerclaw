// tinker-ui/src/panels/prefrontal-graph.ts
// Prefrontal panel — horizontal pill visualization of the model/auth-profile fleet.
// Each pill = one auth-key row (mirrors the Models section).

// ─── Types ───
export interface PrefrontalItem {
  id: string; // unique key (authProfileId or modelId)
  provider: string; // anthropic, google, openai, ollama, etc.
  modelName: string; // short model name (e.g., "opus-4-6")
  authLabel: string; // auth profile suffix (sv, gm, api, etc.)
  badge: string; // fallback chain badge (crown, ②, etc.)
  count: number; // number of active agents using this
  error?: { reason: string; error: string };
  sessionTag?: string;
}

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "#7c3aed",
  google: "#16a34a",
  openai: "#6b7280",
  ollama: "#ca8a04",
  meta: "#0668E1",
  mistral: "#f97316",
  deepseek: "#4f8ff7",
};

// ─── Mount ───
export function mountPrefrontalGraph(
  container: HTMLElement,
  opts: { providerIcons?: Record<string, string> },
): {
  update(items: PrefrontalItem[]): void;
  destroy(): void;
} {
  const icons = opts.providerIcons ?? {};

  const wrap = document.createElement("div");
  wrap.className = "prefrontal-pills";
  container.appendChild(wrap);

  const empty = document.createElement("div");
  empty.className = "prefrontal-empty-state";
  empty.innerHTML = [
    '<div class="prefrontal-empty-icon">\uD83D\uDD2D</div>',
    '<div class="prefrontal-empty-text">Prefrontal watching \u2014 waiting for config</div>',
  ].join("");
  container.appendChild(empty);

  function update(items: PrefrontalItem[]): void {
    if (!items.length) {
      wrap.style.display = "none";
      empty.style.display = "";
      return;
    }
    wrap.style.display = "";
    empty.style.display = "none";

    let html = "";
    for (const item of items) {
      const color = PROVIDER_COLORS[item.provider] || "#6b7280";
      const active = item.count > 0;
      const cls = [
        "prefrontal-pill",
        active ? "prefrontal-pill--active" : "",
        item.error ? "prefrontal-pill--error" : "",
      ]
        .filter(Boolean)
        .join(" ");

      // Inline glow styles for active pills (same pattern as model-live rows)
      const style = active
        ? `--pill-color:${color};--pill-bg:${color}18;--pill-bg2:${color}30;--pill-border:${color}60`
        : `--pill-color:${color}`;

      const icon = icons[item.provider] || "";

      html += `<div class="${cls}" style="${style}" data-hint="${esc(item.id)}">`;
      if (icon) {html += `<span class="prefrontal-pill-icon">${icon}</span>`;}
      html += `<span class="prefrontal-pill-model">${esc(item.modelName)}</span>`;
      if (item.authLabel) {
        html += `<span class="prefrontal-pill-sep">\u00b7</span>`;
        html += `<span class="prefrontal-pill-auth">${esc(item.authLabel)}</span>`;
      }
      if (item.badge) {
        html += `<span class="prefrontal-pill-badge">${item.badge}</span>`;
      }
      if (item.error) {
        html += `<span class="prefrontal-pill-error">${esc(shortErr(item.error.reason))}</span>`;
      }
      if (item.sessionTag) {
        html += `<span class="prefrontal-pill-tag">${esc(item.sessionTag)}</span>`;
      }
      html += "</div>";
    }
    wrap.innerHTML = html;
  }

  function destroy(): void {
    container.removeChild(wrap);
    container.removeChild(empty);
  }

  return { update, destroy };
}

// ─── Helpers ───
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortErr(reason: string): string {
  switch (reason) {
    case "billing":
      return "billing";
    case "rate_limit":
      return "rate-lim";
    case "overloaded":
      return "overload";
    case "auth":
    case "auth_permanent":
      return "auth";
    case "timeout":
      return "timeout";
    default:
      return "err";
  }
}
