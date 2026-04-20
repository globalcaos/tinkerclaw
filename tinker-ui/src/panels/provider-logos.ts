// tinker-ui/src/panels/provider-logos.ts
// FORK: Provider logo SVGs and color constants for Tinker UI panels.

const ANTHROPIC_LOGO_SVG = `<svg width="14" height="14" viewBox="0 0 24 24"><polygon points="12,1 13.5,8.3 19.8,4.2 15.7,10.5 23,12 15.7,13.5 19.8,19.8 13.5,15.7 12,23 10.5,15.7 4.2,19.8 8.3,13.5 1,12 8.3,10.5 4.2,4.2 10.5,8.3" fill="#D97757"/></svg>`;

export const PROVIDER_LOGO_SVG: Record<string, string> = {
  anthropic: ANTHROPIC_LOGO_SVG,
  // FORK: cc-bridge = claude CLI; keep Anthropic branding in timeline/treemap.
  "claude-code": ANTHROPIC_LOGO_SVG,
  google: `<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="none" stroke-width="2"><animate attributeName="stroke" values="#4285f4;#ea4335;#fbbc04;#34a853;#4285f4" dur="4s" repeatCount="indefinite"/></circle><circle cx="7" cy="7" r="3" fill="url(#gg)"/><defs><radialGradient id="gg"><stop offset="0%" stop-color="#4285f4"/><stop offset="100%" stop-color="#34a853"/></radialGradient></defs></svg>`,
  openai: `<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="#fff"/><text x="7" y="10" text-anchor="middle" font-size="7" font-weight="900" fill="#000">AI</text></svg>`,
  ollama: `<svg width="14" height="14" viewBox="0 0 14 14"><rect width="14" height="14" rx="3" fill="#ff6b35"/><text x="7" y="11" text-anchor="middle" font-size="9">🦙</text></svg>`,
};

export const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "#D97757",
  "claude-code": "#D97757",
  google: "#8ab4f8",
  openai: "#ccc",
  ollama: "#ff9b6b",
  unknown: "#8b949e",
};

export const PROVIDER_BORDER_COLORS: Record<string, string> = {
  anthropic: "#6e40c9",
  "claude-code": "#6e40c9",
  google: "#1a73e8",
  openai: "#444",
  ollama: "#ff6b35",
  unknown: "#30363d",
};

export function getProviderColor(provider: string): string {
  return PROVIDER_COLORS[provider] ?? PROVIDER_COLORS.unknown;
}

export function getProviderBorderColor(provider: string): string {
  return PROVIDER_BORDER_COLORS[provider] ?? PROVIDER_BORDER_COLORS.unknown;
}

export function getProviderLogoSvg(provider: string): string {
  return PROVIDER_LOGO_SVG[provider] ?? PROVIDER_LOGO_SVG.anthropic;
}
