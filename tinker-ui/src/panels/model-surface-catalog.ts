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

// One model, one row (2026-09-26: the same astra6 model showed twice,
// once at a reasonable cost and again under MORE MODELS at 366x Grok). MORE MODELS
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

// The picker's length cut, as DISPLAY only (2026-09-24: too many models in the picker,
// cut below Copilot; 2026-09-25: models kept vanishing from MORE MODELS, so recover them all
// and never cut them again). The 09-22 and
// 09-24 cuts deleted models from the allowlist, which also emptied MORE MODELS and made them
// unroutable. The allowlist now keeps everything, and only the picker stops at Copilot.
// SMART MODELS reads the same set (2026-09-25), so the picker and SMART MODELS always
// match — Sonnet and Haiku included, which fall below Copilot — and every other model sits in
// MORE MODELS.
// Input is sorted smartest first; everything up to and including the first `copilot/` id is
// kept. No Copilot in the catalog = no cut.
// 2026-11-12: DeepInfra is the one metered seller with credit, so its two best models are
// always kept, also when they score under Copilot. Kept in rank order, so the list stays
// sorted.
const PAID_OPEN_PREFIX = "deepinfra/";
const PAID_OPEN_KEPT = 2;

export function panelIdsDownToCopilot(idsSmartestFirst: string[]): string[] {
  const i = idsSmartestFirst.findIndex((id) => id.startsWith("copilot/"));
  if (i < 0) {
    return idsSmartestFirst;
  }
  const paidOpen = new Set(
    idsSmartestFirst.filter((id) => id.startsWith(PAID_OPEN_PREFIX)).slice(0, PAID_OPEN_KEPT),
  );
  return idsSmartestFirst.filter((id, at) => at <= i || paidOpen.has(id));
}

// 2026-11-13 (the architect): the picker shows one Fable, one Opus, one Astra and one Sol, the newest of each.
// Older versions stay in config and in MORE MODELS; only the picker drops them. Twins of the newest
// version (the same model on two routes) all stay.
const PICKER_ONE_PER_FAMILY =
  /claude-(fable|opus)-(\d+(?:[-.]\d+)*)|gpt-(\d+(?:\.\d+)*)-(astra|sol)\b/i;
function familyVersion(id: string): { family: string; version: number[] } | null {
  const m = PICKER_ONE_PER_FAMILY.exec(id);
  if (!m) return null;
  const family = (m[1] ?? m[4]).toLowerCase();
  const raw = m[2] ?? m[3];
  return { family, version: raw.split(/[-.]/).map(Number) };
}
function compareVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
export function latestOfFamily(ids: string[]): string[] {
  const newest = new Map<string, number[]>();
  for (const id of ids) {
    const fv = familyVersion(id);
    if (!fv) continue;
    const cur = newest.get(fv.family);
    if (!cur || compareVersion(fv.version, cur) > 0) newest.set(fv.family, fv.version);
  }
  return ids.filter((id) => {
    const fv = familyVersion(id);
    return !fv || compareVersion(fv.version, newest.get(fv.family)!) === 0;
  });
}
