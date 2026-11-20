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

// One version per model NAME, the newest only, in every list the owner picks from.
// 2026-11-13 (the architect): one Fable, one Opus, one Astra and one Sol. That fix named four families in a
// pattern, so Terra, Luna, Sonnet, Haiku, Gemini Flash, Grok and every open model kept all their
// versions, and MORE MODELS and the greyed chips were never checked.
// 2026-11-18 (the owner's second ask): one version of EVERY model name, the newest, Terra and
// Opus as much as Sol. So the name is now derived, never listed: the id's last segment
// without its version numbers, snapshot dates and mode words. Every family is covered, including
// ones that ship tomorrow. Callers pass ONE pool (configured ids, baked ids, greyed "aa:" ids) so a
// newer greyed version hides an older configured one. Older versions stay in config: a job that
// names one still runs, it only leaves the lists.
// Stage and variant words do not make a new model: Gemini 2.0 Flash Experimental is Gemini Flash,
// Llama 2 Chat 70B and Llama 3.3 Instruct 70B are both Llama 70B (the census of 2026-11-18).
const MODE_WORDS = new Set([
  "preview",
  "beta",
  "latest",
  "thinking",
  "reasoning",
  "adaptive",
  "instant",
  "exp",
  "experimental",
  "chat",
  "instruct",
  "turbo",
]);
// A version with a one-letter suffix: 4.6v is GLM 4.6 Vision, 4o is GPT-4 omni. Not b/t (a size)
// or k/m (a context length).
const SUFFIXED = /^(\d+)([acdefghijlnopqrsuvwxyz])$/;
// A month name, with or without a year after it, is a release date: claude-35-sonnet-june-24.
const MONTH =
  /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)$/;
const NUM = /^\d+(?:\.\d+)*$/; // 5, 5.5, 6.1
const SNAPSHOT = /^\d{4}$/; // 0731, 1017, 2411
const SIZE = /^a?\d+(?:\.\d+)?[bt]$/; // 27b, 2.4t, a95b: a different model, part of the name
const GLUED = /^([a-z]+)(\d+(?:\.\d+)*)$/; // qwen3.8, k2.6, v4.1, hy4, pro4

export function modelNameAndVersion(id: string): { name: string; version: number[]; date: number } {
  const aa = id.startsWith("aa:");
  let tail = aa ? id.slice(3) : id;
  tail = tail.slice(tail.lastIndexOf("/") + 1).toLowerCase();
  const toks = tail.split("-").filter((tok) => tok && !MODE_WORDS.has(tok));
  let date = 0;
  // A trailing month-day pair is a snapshot date (grok-build-0-1-06-16). Single digits are a
  // version (claude-opus-4-5), so both halves must have two digits.
  const n = toks.length;
  if (n >= 2 && /^\d\d$/.test(toks[n - 1]) && /^\d\d$/.test(toks[n - 2])) {
    date = Number(toks[n - 2] + toks[n - 1]);
    toks.splice(n - 2);
  }
  const name: string[] = [];
  const version: number[] = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    // A month-year pair is a date too: gemini-2-5-flash-04-2025.
    if (/^\d\d$/.test(tok) && /^20\d\d$/.test(toks[i + 1] ?? "")) {
      date ||= Number(toks[++i]);
      continue;
    }
    if (MONTH.test(tok)) {
      if (/^\d\d(\d\d)?$/.test(toks[i + 1] ?? "")) i++;
      continue;
    }
    if (SNAPSHOT.test(tok)) {
      date ||= Number(tok);
      continue;
    }
    if (NUM.test(tok)) {
      // AA runs some old versions together: claude-35-sonnet is Claude 3.5, claude-21 is 2.1.
      // Read as 35, Claude 3.5 Sonnet out-ranked Sonnet 5.5 and hid it (2026-11-18).
      if (aa && version.length === 0 && /^\d\d$/.test(tok)) {
        version.push(Number(tok[0]), Number(tok[1]));
      } else {
        version.push(...tok.split(".").map(Number));
      }
      continue;
    }
    const suffixed = SUFFIXED.exec(tok);
    if (suffixed) {
      version.push(Number(suffixed[1]));
      name.push(suffixed[2]);
      continue;
    }
    const glued = SIZE.test(tok) ? null : GLUED.exec(tok);
    if (glued) {
      name.push(glued[1]);
      version.push(...glued[2].split(".").map(Number));
      continue;
    }
    name.push(tok);
  }
  return { name: name.join("-") || tail, version, date };
}

// A minor version compares as a decimal fraction: Grok 4.20 (March 2026) came before 4.5, 4.6 and
// 4.7, and as the integer 20 it hid Grok 4.7 (2026-11-18). Majors and later parts are integers.
const minorFraction = (x: number): number => x / 10 ** String(x).length;
function compareVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    const d = i === 1 ? minorFraction(x) - minorFraction(y) : x - y;
    if (d !== 0) return d;
  }
  return 0;
}

// The same version on several routes is still one model: the native route first, then DeepInfra
// (paid, with credit), then OpenRouter, then a greyed chip nothing routes to.
function routeRank(id: string): number {
  if (id.startsWith("aa:")) return 3;
  if (id.startsWith("openrouter/")) return 2;
  if (id.startsWith("deepinfra/")) return 1;
  return 0;
}

/** Keeps one id per model name: the newest version, then the best route, then the newest snapshot. */
export function latestOfFamily(ids: string[]): string[] {
  const best = new Map<string, { id: string; version: number[]; rank: number; date: number }>();
  for (const id of ids) {
    const { name, version, date } = modelNameAndVersion(id);
    const rank = routeRank(id);
    const cur = best.get(name);
    const byVersion = cur ? compareVersion(version, cur.version) : 1;
    const wins =
      byVersion > 0 ||
      (byVersion === 0 &&
        cur !== undefined &&
        (rank < cur.rank || (rank === cur.rank && date > cur.date)));
    if (wins) best.set(name, { id, version, rank, date });
  }
  const keep = new Set([...best.values()].map((b) => b.id));
  return ids.filter((id) => keep.has(id));
}

/** OpenRouter and DeepInfra carry only the open-weight models we configured (the architect 2026-11-18). */
export function isResellerRoute(id: string): boolean {
  return id.startsWith("openrouter/") || id.startsWith("deepinfra/");
}

// 2026-11-18 (the owner): a chip shows the model's nickname, no version — Terra, Sol, Astra, Fable,
// Opus, Sonnet — and the same for every model, as long as no two chips read the same. The hover card
// keeps the exact version. Words come from the version-free name (modelNameAndVersion): the brand word
// goes when a nickname follows it (claude-opus → Opus, gpt-terra → Terra, gemini-carbon → Carbon), and so
// does the single letter of a glued version (Kimi K3 → Kimi). Each chip starts from its first word and
// takes the next one only while two chips would read the same (Kimi / Kimi Pro, Qwen 2.4T / Qwen Max).
// The brand words are the lines that name their models by codename; the chip colour shows the family.
const BRAND_WORDS = new Set(["claude", "gpt", "gemini", "muse"]);
const WORD_CASE: Record<string, string> = {
  gpt: "GPT",
  glm: "GLM",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  mimo: "MiMo",
  nvidia: "NVIDIA",
  qwen: "Qwen",
};
function labelWords(id: string): string[] {
  const all = modelNameAndVersion(id).name.split("-").filter(Boolean);
  const long = all.filter((w) => w.length > 1);
  const words = long.length ? long : all;
  // The brand word goes only when a real word follows: gpt-o (GPT-4o) stays "GPT", not "O".
  return words.length > 1 && BRAND_WORDS.has(words[0]) ? words.slice(1) : words;
}
function labelWord(w: string): string {
  if (WORD_CASE[w]) return WORD_CASE[w];
  if (SIZE.test(w)) return w.toUpperCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
}

// 2026-11-18: a one-word nickname wider than its chip (Hydrogen, Copilot) split wherever the line
// ended, "Hydrog / en". One soft hyphen near the middle, after a vowel and before a consonant, gives
// the line a better place: "Hydro- / gen", "Copi- / lot". The browser draws the hyphen only when the
// word does not fit; words of six letters or fewer, and words with digits, are left alone.
const VOWEL = /[aeiouy]/i;
const CONSONANT = /[b-df-hj-np-tv-xz]/i;
export function softHyphenate(label: string): string {
  return label
    .split(" ")
    .map((w) => {
      if (w.length <= 6 || !/^[a-z]+$/i.test(w)) {
        return w;
      }
      let at = -1;
      for (let i = 2; i <= w.length - 2; i++) {
        if (!VOWEL.test(w[i - 1]) || !CONSONANT.test(w[i])) {
          continue;
        }
        if (at < 0 || Math.abs(i - w.length / 2) < Math.abs(at - w.length / 2)) {
          at = i;
        }
      }
      return at < 0 ? w : `${w.slice(0, at)}­${w.slice(at)}`;
    })
    .join(" ");
}

/** Nickname per chip, unique within `ids`; `fallback` labels any two that still read the same. */
export function pickerChipLabels(
  ids: string[],
  fallback: (id: string) => string = (id) => id,
): Map<string, string> {
  const words = new Map(ids.map((id) => [id, labelWords(id)]));
  const take = new Map(ids.map((id) => [id, 1]));
  const label = (id: string): string =>
    words.get(id)!.slice(0, take.get(id)).map(labelWord).join(" ");
  const groups = (): string[][] => {
    const by = new Map<string, string[]>();
    for (const id of ids) {
      const key = label(id).toLowerCase();
      by.set(key, [...(by.get(key) ?? []), id]);
    }
    return [...by.values()].filter((g) => g.length > 1);
  };
  for (let round = 0; round < 8; round++) {
    let grew = false;
    for (const group of groups()) {
      for (const id of group) {
        if (take.get(id)! < words.get(id)!.length) {
          take.set(id, take.get(id)! + 1);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }
  const out = new Map(ids.map((id) => [id, label(id)]));
  for (const group of groups()) for (const id of group) out.set(id, fallback(id));
  return out;
}
