// Models Artificial Analysis scores in its top 50 that nothing we can call sells at a price we
// can plot (the architect, 2026-10-13: "no model should be left out ... even if we had no api, I want to
// know there is a new model in town"). They are NOT in AA_INTELLIGENCE_INDEX on purpose: that
// table is a dot source, and a dot with no cost row draws at DEFAULT_REL_COST (2.58), a price
// nobody published. They are NOT in openclaw.json either, so the picker cannot offer a model
// that would fail on first use. The dossier lists them as rows; the chart names them in its
// "not plotted" note. Delete an entry the day a seller exists and the model is onboarded.
export interface AaUnroutedModel {
  /** Dossier id. `openrouter/<vendor>/<slug>` where the vendor is confirmed, `unlisted/<slug>` otherwise. */
  id: string;
  name: string;
  /** AA Intelligence Index, base row, read 2026-10-13. */
  index: number;
  /** Why it has no price, in one clause. */
  why: string;
}

export const AA_UNROUTED_MODELS: AaUnroutedModel[] = [
  {
    id: "openrouter/meta/muse-wonder-full",
    name: "Muse Wonder Full",
    index: 55.8021,
    why: "no seller lists the Full variant; OpenRouter sells only Muse Wonder",
  },
  {
    id: "openrouter/stepfun/step-5",
    name: "Step 5",
    index: 43.7343,
    why: "OpenRouter lists only Step 5 Preview ($1/$2.70); not matched to AA's step-5 without proof",
  },
  {
    id: "openrouter/qwen/qwen3.8-flash-next",
    name: "Qwen3.8-Flash-Next",
    index: 39.8223,
    why: "no catalog lists it; Qwen3.8 Flash is a different model",
  },
  {
    id: "openrouter/mistralai/mistral-large-4",
    name: "Mistral Large 4 Preview",
    index: 38.377,
    why: "OpenRouter lists Mistral Large 4 ($0.68/$2.09), not the Preview AA scored; not matched without proof",
  },
  {
    id: "unlisted/agnes-2.5-pro-beta",
    name: "Agnes 2.5 Pro Beta",
    index: 35.2413,
    why: "no seller found on OpenRouter or any catalog we read; vendor not confirmed",
  },
  {
    id: "unlisted/jt-4.1-flash-236b-a21b",
    name: "JT-4.1 Flash 236B A21B",
    index: 33.9173,
    why: "no seller found; vendor reported as China Mobile by a third-party site only",
  },
  {
    id: "unlisted/motif-3",
    name: "Motif 3",
    index: 33.5666,
    why: "no seller found; vendor not confirmed",
  },
];

/** Routed-elsewhere models that need a dossier row but no config entry (OpenAI list price, Google preview). */
export const AA_DOSSIER_ONLY_IDS: string[] = ["openai/gpt-5.4", "google/gemini-4-argon"];
