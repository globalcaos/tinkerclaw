export const meta = {
  name: "revise-publish-jseries",
  description:
    "Triage J-series papers by improvement notes, then revise + compile each actionable one to a Serra PDF",
  whenToUse:
    'Bulk revise→compile over ~/Documents/AI_reports/Papers/J*. args.mode="triage" (read-only work-list) or "full" (rewrite + build).',
  phases: [
    {
      title: "Triage",
      detail: "one agent per paper classifies notes actionable/seed-only/cleared",
      model: "claude-sonnet-4-6",
    },
    {
      title: "Revise + Compile",
      detail: "pipeline: revise-paper then compile-paper per actionable paper",
    },
  ],
};

const BASE = "~/Documents/AI_reports/Papers";
const FOLDERS = [
  "J1_total_recall",
  "J2_instant_recall",
  "J3_fractal_reasoning",
  "J4_identity_persistence",
  "J5_sleep_consolidation",
  "J6_round_table",
  "J7_humor_embeddings",
  "J8_curiosity_motivation",
  "J9_agent_security",
  "J10_corporate_swarm",
  "J11_learned_intuition",
  "J12_budget_prompting",
  "J13_prefrontal",
  "J14_memory_enhancements",
  "J15_intermediate_abstractions",
  "J16_salience_pyramid",
];

const TRIAGE_SCHEMA = {
  type: "object",
  required: ["folder", "codename", "latestMd", "status", "summary"],
  properties: {
    folder: { type: "string" },
    codename: { type: "string", description: "system name e.g. ENGRAM, AEGIS" },
    latestMd: { type: "string", description: "absolute path to the latest dated YYYY-MM-DD-*.md" },
    latestVersion: { type: "string" },
    status: { type: "string", enum: ["actionable", "seed-only", "cleared"] },
    actionableCount: { type: "integer" },
    summary: {
      type: "string",
      description: "one line: what the pending notes are, or why skipped",
    },
    figuresReferenced: { type: "integer" },
    figuresOnDisk: { type: "integer" },
  },
};

const REVISE_SCHEMA = {
  type: "object",
  required: ["folder", "newMdPath", "changesSummary"],
  properties: {
    folder: { type: "string" },
    newMdPath: { type: "string" },
    newVersion: { type: "string" },
    changesSummary: { type: "string" },
    wordDelta: { type: "integer" },
  },
};

const COMPILE_SCHEMA = {
  type: "object",
  required: ["folder", "ok"],
  properties: {
    folder: { type: "string" },
    pdfPath: { type: "string" },
    pages: { type: "integer" },
    ok: { type: "boolean" },
    warnings: { type: "array", items: { type: "string" } },
    missingFigures: { type: "array", items: { type: "string" } },
  },
};

function triagePrompt(folder) {
  return `You are triaging ONE research paper to decide whether it needs revision. Folder: ${BASE}/${folder}.

1. List the folder and pick the GENUINELY latest version of the paper. WARNING: the newest content is NOT always the highest-dated filename — most folders also contain an UNDATED \`<topic>.md\` (e.g. curiosity-motivation.md, total-recall.md) that is frequently the real current version with a HIGHER vX.Y in its header than any dated file. Candidates = dated \`YYYY-MM-DD-codename-vX.Y.md\` files AND the undated \`<topic>.md\`. Open each candidate's header, compare version numbers, and pick the highest. IGNORE supporting files that are NOT the paper: \`sota-expansion-*\`, \`*-review-*\`, \`*-critique*\`, \`*-references*\`, \`*-synthesis*\`, \`*-brief*\`, \`*-revision-*\`, \`gemini-*\`, \`diagram-suggestions.md\`, \`improvement_notes.md\`. Record the chosen absolute path and version.
2. Read ${BASE}/${folder}/improvement_notes.md (if absent, look for a sibling *-improvement-notes.md or the J-series-status table).
3. Read the latest paper md. Also cross-check the newest ~/.openclaw/workspace/memory/projects/papers/J-series-status-*.md (highest date) — its status column says whether this paper's notes were already addressed in a prior batch.

Classify the improvement notes:
- "actionable": concrete pending improvement items NOT yet reflected in the latest paper version.
- "seed-only": placeholder/seed text with no real items (e.g. "none logged from a formal review pass yet").
- "cleared": notes exist but the latest version already incorporates them.

Also: codename = the system name (ENGRAM, HIPPOCAMPUS, AEGIS, ...). figuresReferenced = count of ![](...) image refs in the md. figuresOnDisk = count of fig-*.{png,jpg,pdf} at the folder root plus any in images/ or diagrams/.

Return the structured classification. Do NOT edit anything — this is read-only.`;
}

function revisePrompt(t) {
  const hint = t.latestMd ? `Current version (do NOT overwrite): ${t.latestMd}.` : "";
  return `Follow the revise-paper recipe to improve ONE paper. Folder: ${BASE}/${t.folder}. ${hint}
Improvement notes: ${BASE}/${t.folder}/improvement_notes.md.

If the current version path was not given, list the folder and pick the GENUINELY latest version yourself. WARNING: the newest content is often an UNDATED \`<topic>.md\` (e.g. corporate-swarm.md), NOT the highest-dated filename — compare the version headers of the dated \`YYYY-MM-DD-codename-vX.Y.md\` files AND the undated \`<topic>.md\`, and pick the highest vX.Y. IGNORE \`sota-expansion-*\`, \`*-review-*\`, \`*-critique*\`, \`*-references*\`, \`*-synthesis*\`, \`*-brief*\`, \`gemini-*\`, \`diagram-suggestions.md\`, \`improvement_notes.md\` — those are not the paper.

Apply revise-paper Steps 1–6: full read, structural audit, evidence check (verify cited claims against the actual tinkerclaw code/configs where referenced — soften any claim you cannot ground), prose tightening (kill hedges and AI-isms), fresh additions that incorporate the ACTIONABLE improvement notes, final pass.

CANONICAL STRUCTURE (required — the build renders the title + beige abstract box from this): the new .md MUST begin with YAML frontmatter holding \`title:\`, \`author:\`, and \`date:\`. The abstract MUST be a section headed exactly \`## Abstract\` — NOT a YAML \`abstract:\` field, NOT bold body text. Do NOT also put the title as a \`#\` H1 heading in the body. Top-level sections start at \`##\` (e.g. \`## 1. Introduction\`). Remove any raw-LaTeX color references to the deprecated names serraTitle/serraSection/serraAccent/serraSurface/serraBorder — use jsTitle/jsSection/jsAccent/jsSurface/jsBorder instead.

CITATIONS (the build does NOT run pandoc citeproc): pandoc \`[@key]\` / \`@key\` citation syntax renders as LITERAL "[@key]" text in the PDF — it is NOT processed. Convert every \`[@key]\` in-text marker to an inline prose citation "(Author, Year)" and keep a manual numbered "## References" list (the pattern every other paper uses). After editing, grep your output for \`[@\` — any remaining match is a hard failure.

DIAGRAMS (mandatory when the notes ask for them): if the improvement notes say "no diagrams"/"D2 required"/"add architecture diagram", you MUST add 1–3 high-value figures. For each: insert a Markdown image reference \`![Caption](images/<name>.png)\` at the right spot in the body, AND append a matching entry to \`${BASE}/${t.folder}/diagram-suggestions.md\` (create the file if absent) describing exactly what the diagram shows (boxes, arrows, labels) so the compile step can generate it. Do NOT leave ASCII box-art as the diagram. CRITICAL: if figures already exist as INLINE LaTeX/TikZ (\\begin{tikzpicture}, raw \\includegraphics of a hand-built .tex, etc.), you MUST CONVERT them to Markdown \`![Caption](images/<name>.png)\` refs + diagram-suggestions.md entries — inline TikZ bypasses the Napkin path entirely (the compile step only regenerates figures referenced as \`![]()\`). The goal is every figure rendered by Napkin, none inline.

SELF-CONTAINED, VERSION-INDEPENDENT (hard rule): the paper must read as a standalone first edition. NO changelog/version-history section or blockquote; NO reference to previous versions or to "improvements/changes in this version"; NO "previously we…/now we add…/this version introduces…". A reader sees one finished paper, never a diff against an earlier draft. The dated filename + version header are the only record of versioning.

INDEPENDENT OF THE OTHER PAPERS (hard rule): do NOT call papers a "J-series" or reference them by J-number (J1, J2, …) or by internal codename-as-citation. The paper must stand on its own. When you genuinely need an idea from another paper, treat it exactly like any external citation AND inline a 1–2 sentence summary of the borrowed concept in THIS paper — never assume the reader has read the other paper or ever will. If a "Companion Papers"/"cross-paper architecture" section exists that only makes sense within the series, fold its substance into the relevant sections as self-contained prose and drop the series framing.

SELF-CHECK BEFORE RETURNING (mandatory): grep YOUR OWN output file for \`Serra 202\`, \`J-series\`, \`J-number\` patterns (\`(J1)\`,\`(J8)\` etc.), and \`(CODENAME, Serra\` citations. If ANY match remains, you are NOT done — rewrite those passages to inline a 1–2 sentence summary of the borrowed idea with NO paper-name/author citation, then re-grep. A residual "(HIPPOCAMPUS, Serra 2026c)" or "Prior J-series papers (J1)" is a hard failure of this task.

Write the result to a NEW file in the same folder: bump the version (e.g. v4.0 → v4.1), prefix with today's date (run \`date +%F\` to get it). DO NOT overwrite the current version. Preserve the author's voice; never invent technical claims.

Return the new md path, a concise changes summary, and the word-count delta (before → after).`;
}

function compilePrompt(r, t) {
  return `Follow the compile-paper recipe to build ONE paper into a Serra-styled PDF. Revised markdown: ${r.newMdPath}. Folder: ${BASE}/${t.folder}.

Steps:
1. Grep the md for ![](...) refs. REGENERATE every referenced figure with Napkin — do NOT reuse a pre-existing image just because it is on disk. Stale TikZ/PNGs from earlier passes routinely embed exactly what the self-containment rule forbids (sibling-paper names, "this paper", "Serra 202X" labels baked INTO the figure — invisible to a markdown text grep). Delete the old images/<name>.{png,pdf,tex} for each referenced figure before regenerating.
2. Generate each figure with NAPKIN (the architect's chosen diagram tool — beautiful conceptual PNGs):
   bash ~/.openclaw/jarvis-workspace/.claude/skills/napkin-diagrams/scripts/napkin-generate.sh --file <section.md> ${BASE}/${t.folder}/images/<name>.png --variations 4 --style formal-balanced
   Feed it the FULL relevant paper section (200+ words), not a summary — Napkin's layout engine needs rich context. It emits up to 4 variations; pick the best. The figure's OWN CONTENT must be self-contained: NO sibling-paper names/codenames, NO "this paper", NO "Serra 202X" labels inside the diagram — describe adjacent mechanisms generically ("an external indexing layer", "a nightly consolidation process"). Requires NAPKIN_API_TOKEN in ~/.openclaw/credentials/napkin.env — if ABSENT, report figure as "napkin-token-missing" and fall back to a clean self-contained TikZ figure. Convert any ASCII box-art to a real figure either way. One figure failing does not abort.
2b. COHESION PASS (the architect's standing preference, 2026-08-02 — so all figures share one look): route each CONCEPTUAL figure Napkin produced through Nano Banana Pro edit mode, verbatim house-style prompt:
   uv run ~/.openclaw/jarvis-workspace/.claude/skills/nano-banana-pro/scripts/generate_image.py --prompt "Restyle this diagram in a calm academic print aesthetic: parchment #faf7f1 background, umber #5A3E28 primary strokes and text, olive #4A5D1A and muted purple #6B5090 accents, thin even line weights, generous whitespace, one clean sans-serif label font. Preserve EVERY label, box, and arrow exactly as-is — restyle only, never re-author, never add or remove elements." --filename <out>.png -i <in>.png --resolution 2K
   Smoke-test ONE call first: the model is paid-tier-only and a free-tier GEMINI_API_KEY fails with 429 limit:0 on the real call while auth endpoints return 200. If it fails, report "nano-banana-unavailable" and ship the Napkin originals — do not retry N times. Compare before/after and KEEP THE BETTER ONE; a restyle that drops a label or re-authors an arrow is a regression. NEVER route a numeric chart (real data, axes, ticks) through this — the model silently rewrites the values; numeric plots get their cohesion from matplotlib rcParams instead.
   SCALING: a tall portrait diagram overflows the text block ("Float too large for page by Npt", caption collides with the footer). Constrain every embedded figure to the page: \\includegraphics[width=\\linewidth,height=0.85\\textheight,keepaspectratio]{...} (or \\resizebox), so it never exceeds the text height.
3. Run ${BASE}/md-to-tex.sh on the md to produce the dated .tex (YYYY-MM-DD-codename-vX.Y.tex).
4. Enrich refs.bib: every entry needs url= (doi.org from doi=, arxiv.org from eprint/arxivId, else arXiv/crossref title lookup with single-confident-match rule). List lookup-failures.
5. Run ${BASE}/build-paper.sh on the .tex.
6. Verify the .pdf exists; if build-paper.sh exits non-zero, dump the last 50 lines of the .log.
7. ARCHIVE THE NOTES (only if the build succeeded AND every required figure is present): the improvement items are now incorporated, so they must not re-flag next triage. Move ${BASE}/${t.folder}/improvement_notes.md → ${BASE}/${t.folder}/improvement_notes.incorporated-$(date +%F).md, and write a fresh improvement_notes.md stub: a one-line header + "Incorporated into <new version> on <date>. Prior notes archived in improvement_notes.incorporated-<date>.md." This is reversible (a file move), never a delete. If the build FAILED or figures are missing, do NOT archive — the work isn't done.

In any generated TikZ, use the jseries-paper.sty colors (jsTitle/jsSection/jsAccent/jsSurface/jsBorder) or standard xcolor names — NEVER serraXxx (deprecated, undefined now → build fails).

Toolchain (do NOT modify): build-paper.sh, jseries-paper.sty, md-to-tex.sh, all at ${BASE}.

Return pdf path, page count, ok=true/false, warnings (grep the .log for "! ", "Warning:", "Undefined"), and any figures you could not generate.`;
}

// Defensive: `args` can arrive as a real object OR a JSON string (harness footgun).
let A = args;
if (typeof A === "string") {
  try {
    A = JSON.parse(A);
  } catch (_) {
    A = {};
  }
}
A = A && typeof A === "object" ? A : {};
const mode = A.mode || "triage";
const argFolders = Array.isArray(A.folders) ? A.folders : [];
log(`args received: mode=${mode}, folders=${argFolders.length ? argFolders.join(",") : "(none)"}`);

phase("Triage");
let triaged;
if (mode === "full" && argFolders.length) {
  triaged = argFolders.map((f) => ({
    folder: f,
    status: "actionable",
    latestMd: null,
    codename: f,
    summary: "provided by caller",
  }));
  log(`Full mode: ${triaged.length} folders provided — skipping triage`);
} else {
  triaged = (
    await parallel(
      FOLDERS.map(
        (f) => () =>
          agent(triagePrompt(f), {
            label: `triage:${f}`,
            phase: "Triage",
            schema: TRIAGE_SCHEMA,
            model: "claude-sonnet-4-6",
          }),
      ),
    )
  ).filter(Boolean);
}

const actionable = triaged.filter((t) => t.status === "actionable");
log(`${actionable.length}/${FOLDERS.length} papers actionable`);

if (mode === "triage") {
  return { mode: "triage", triaged, actionableFolders: actionable.map((t) => t.folder) };
}

phase("Revise + Compile");
const results = await pipeline(
  actionable,
  (t) =>
    agent(revisePrompt(t), {
      label: `revise:${t.folder}`,
      phase: "Revise + Compile",
      schema: REVISE_SCHEMA,
    }),
  (r, t) =>
    agent(compilePrompt(r, t), {
      label: `compile:${t.folder}`,
      phase: "Revise + Compile",
      schema: COMPILE_SCHEMA,
    }).then((c) => ({ ...c, revise: r })),
);

return { mode: "full", results: results.filter(Boolean) };
