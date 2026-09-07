import { describe, expect, it } from "vitest";
import { GOOGLE_G_LOGO_SVG, getProviderLogoSvg, getRoutedLogoSvg } from "./provider-logos.js";

/**
 * FORK 2026-09-03 (the user: "The logo in the models panel next to the gemini
 * models is flashing… Use the one we had before, the G from google, the
 * colorful one").
 *
 * The class is every Google/Gemini mark the UI paints — models panel, smart x
 * cost chart, prefrontal tree, dossier — because they all resolve through
 * getRoutedLogoSvg → PROVIDER_LOGO_SVG.google. One animated source was one
 * flashing class. These specs pin the SOURCE, not a downstream freeze.
 */
describe("Google mark is the still colourful G", () => {
  const googleIds = [
    ["google/gemini-3.8-flash", "google"],
    ["google/gemini-3.1-pro-preview", "google"],
    ["openrouter/google/gemini-3.7-flash", "openrouter"],
  ] as const;

  it("ships no SMIL animation on the Google mark itself", () => {
    expect(GOOGLE_G_LOGO_SVG).not.toMatch(/<animate/);
    expect(getProviderLogoSvg("google")).not.toMatch(/<animate/);
  });

  it("is the four-colour G, not a cycling ring", () => {
    const mark = getProviderLogoSvg("google");
    expect(mark).toBe(GOOGLE_G_LOGO_SVG);
    expect(mark).toContain('fill="#FFC107"');
    expect(mark).toContain('fill="#FF3D00"');
    expect(mark).toContain('fill="#4CAF50"');
    expect(mark).toContain('fill="#1976D2"');
  });

  it.each(googleIds)("%s resolves to the same still G", (id, provider) => {
    const mark = getRoutedLogoSvg(id, provider);
    expect(mark).toBe(GOOGLE_G_LOGO_SVG);
    expect(mark).not.toMatch(/<animate/);
  });
});
