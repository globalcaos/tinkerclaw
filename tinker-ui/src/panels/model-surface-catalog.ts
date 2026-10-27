import { isRedundantResellerRoute } from "../../../src/shared/reseller-route-policy.js";

// One catalog boundary for every surface where the owner can see or select a model.
// Added 2026-09-22 after Opus 4.8 was present in config and SMART MODELS but absent
// from the picker: the picker still carried an old by-name exclusion and only admitted
// the Smart top-N, while the panel intentionally split the full catalog across Smart
// and More. A configured model now survives or is rejected here once, then both the
// picker and panel consume the same result. Change this predicate only when a route is
// genuinely unusable on BOTH surfaces (Copilot rows and redundant reseller routes).
export function modelCatalogIdsForPickerAndPanel(ids: Iterable<string>): string[] {
  return [...new Set(ids)].filter(
    (id) => !id.startsWith("github-copilot/") && !isRedundantResellerRoute(id),
  );
}

// One model, one row (the architect 2026-09-26: "there is an astra6, reasonable cost at 52.3 ...
// and another inside more models with 52.3 II and 366x Grok. Same model"). MORE MODELS
// unions the baked AA map into the catalog, and that map keeps a metered `openai/` twin for
// every `openai-codex/` seat model so the SMART × COST chart can plot the list price. Because
// `openai:default` sits in authOrder, the panel counted those twins as reachable and drew
// each model a second time at its API sticker (wallet empty, never routed). The twins also
// sorted to the top of MORE MODELS, above SMART's Copilot cut, so they looked misplaced.
// A baked id is dropped when a configured id already carries the same model under another
// provider prefix. Configured ids are never dropped: two configured routes is a choice.
function routeTail(id: string): string {
  const slash = id.indexOf("/");
  return (slash < 0 ? id : id.slice(slash + 1)).toLowerCase();
}

export function withoutRouteTwins(
  bakedIds: Iterable<string>,
  catalogIds: Iterable<string>,
): string[] {
  const catalog = new Set(catalogIds);
  const tails = new Set([...catalog].map(routeTail));
  return [...bakedIds].filter((id) => catalog.has(id) || !tails.has(routeTail(id)));
}

// The picker's length cut, as DISPLAY only (the architect 2026-09-24: "too many models in the model
// picker. Cut below the copilot one"; 2026-09-25: "we are missing more and more models ...
// inside the 'more models'. Recover them all and don't cut them in the future"). The 09-22 and
// 09-24 cuts deleted models from the allowlist, which also emptied MORE MODELS and made them
// unroutable. The allowlist now keeps everything, and only the picker stops at Copilot.
// SMART MODELS reads the same set (the architect 2026-09-25), so the picker and SMART MODELS always
// match — Sonnet and Haiku included, which fall below Copilot — and every other model sits in
// MORE MODELS.
// Input is sorted smartest first; everything up to and including the first `copilot/` id is
// kept. No Copilot in the catalog = no cut.
export function panelIdsDownToCopilot(idsSmartestFirst: string[]): string[] {
  const i = idsSmartestFirst.findIndex((id) => id.startsWith("copilot/"));
  return i < 0 ? idsSmartestFirst : idsSmartestFirst.slice(0, i + 1);
}
