// Pure BROCA program render model for tinker-ui. No DOM deps; returns HTML strings.
export interface BrocaPort {
  name: string;
  from: string;
}
export interface BrocaStep {
  n: number;
  title: string;
  prose?: string;
  skillId?: string;
  usesKitRef?: string;
  ins?: BrocaPort[];
  out?: unknown;
  when?: string;
  returns?: boolean;
}
export interface BrocaRecipe {
  slug: string;
  title: string;
  summary?: string;
  category?: string;
  signature?: string;
  steps: BrocaStep[];
  lineage?: {
    composedFrom?: string;
    composedSkills?: string[];
    composedRecipes?: string[];
    sourceQuery?: string;
  };
}

function esc(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}
const skillSpan = (id: string) => `<span class="broca-skill">${esc(id)}</span>`;
const kw = (s: string) => `<span class="broca-kw">${esc(s)}</span>`;

/** Wrap a label in a skill span ONLY if it is exactly a known skill id (structured-only). */
export function colorSkillTokens(label: string, knownSkillIds: Set<string>): string {
  return knownSkillIds.has(label.trim()) ? skillSpan(label.trim()) : esc(label);
}

function renderStep(s: BrocaStep): string {
  const code: string[] = [];
  if (s.when) code.push(kw("when") + " " + esc(s.when));
  const head = s.skillId
    ? kw("invoke skill:") + " " + skillSpan(s.skillId)
    : s.usesKitRef
      ? kw("uses:") + " " + skillSpan(s.usesKitRef)
      : esc(s.title);
  const ins = s.ins?.length
    ? "  " + kw("in:") + " " + s.ins.map((p) => esc(p.name)).join(", ")
    : "";
  const out = s.out ? "  " + kw("out→") + " " + esc(s.title) : "";
  code.push(`${s.n}  ${head}${ins}${out}`);
  if (s.returns) code.push("⇒ " + kw("return:") + " " + esc(s.title));
  const prose = s.prose ? `<div class="broca-step__prose">${esc(s.prose)}</div>` : "";
  return `<div class="broca-step"><div class="broca-step__code">${code.join("<br>")}</div>${prose}</div>`;
}

export function renderBrocaProgram(
  recipe: BrocaRecipe,
  opts: { liveStep?: number; linkTitle?: boolean } = {},
): string {
  const linkTitle = opts.linkTitle !== false;
  const sig = recipe.signature ? esc(recipe.signature) : esc(recipe.title);
  const title = linkTitle
    ? `<a class="broca-recipe-link" data-recipe-ref="${esc(recipe.slug)}">▸ ${sig}</a>`
    : `<span>▸ ${sig}</span>`;
  const steps = recipe.steps
    .map((s) => {
      const html = renderStep(s);
      return opts.liveStep === s.n
        ? html.replace('class="broca-step"', 'class="broca-step broca-step--live"')
        : html;
    })
    .join("");
  return `<div class="broca-program">${title}${steps}</div>`;
}
