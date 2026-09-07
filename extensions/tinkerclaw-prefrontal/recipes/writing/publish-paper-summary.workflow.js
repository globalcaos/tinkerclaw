export const meta = {
  name: "publish-paper-summary",
  description:
    "Publish J-series paper summaries to thetinkerzone.com as DRAFT posts, replicating the proven J1 template (woody, Building Jarvis category, PDF via SFTP).",
  whenToUse:
    'Fan out the J1 post template to the other papers. args.folders = ["J2_instant_recall", ...]. All posts created as DRAFT for review.',
  phases: [
    {
      title: "Publish",
      detail: "one agent per paper: read → assets → SFTP pdf → REST images → draft post",
    },
  ],
};

const BASE = "~/Documents/AI_reports/Papers";
const A =
  typeof args === "string"
    ? (() => {
        try {
          return JSON.parse(args);
        } catch {
          return {};
        }
      })()
    : args || {};
const FOLDERS = Array.isArray(A.folders) && A.folders.length ? A.folders : [];

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["folder", "ok"],
  properties: {
    folder: { type: "string" },
    ok: { type: "boolean" },
    draftId: { type: "integer" },
    editLink: { type: "string" },
    previewLink: { type: "string" },
    pdfUrl: { type: "string" },
    featuredImageId: { type: "integer" },
    hasStatCards: { type: "boolean" },
    notes: { type: "string" },
  },
};

function pubPrompt(folder) {
  return `Publish ONE paper as a DRAFT summary post on thetinkerzone.com (a blog for AI-agent BUILDERS/tinkerers — write conversion copy, not academic prose). Folder: ${BASE}/${folder}.

Replicate the PROVEN J1 "Total Recall" template EXACTLY in structure + style. Create it as a DRAFT (status:"draft") — NEVER publish. Self-contained: do NOT write "J-series" or reference sibling papers by number/codename-as-citation.

== STEP 1 — read the paper ==
Open the latest \`${BASE}/${folder}/2026-06-02-*.md\` (the dated source). Extract: the TITLE (YAML frontmatter \`title:\`), the ABSTRACT (the \`## Abstract\` section), 2–3 of the STRONGEST concrete claims (prefer hard numbers), and the core idea in plain builder language.

== STEP 2 — assets ==
PDF = the latest \`${BASE}/${folder}/2026-06-02-*.pdf\`. Render its first page to a cover:
  pdftoppm -png -f 1 -l 1 -singlefile -r 150 "<pdf>" /tmp/${folder}-cover    (→ /tmp/${folder}-cover.png)
MAIN image = the most representative figure in \`${BASE}/${folder}/images/*.png\` (an architecture/flow diagram if present).

== STEP 3 — host the PDF via SFTP (REST PDF upload is WAF-blocked) ==
  scp -i ~/.ssh/sprintpaper -P 2222 -o StrictHostKeyChecking=accept-new "<pdf>" "msgqrrte@108.167.183.48:/home4/msgqrrte/public_html/website_b3f2b1a0/wp-content/uploads/2026/06/<pdf-basename>"
Then verify: curl -sI "https://thetinkerzone.com/wp-content/uploads/2026/06/<pdf-basename>" → expect HTTP 200, application/pdf. That URL is the pdfUrl.

== STEP 4 — upload images via REST (PNG works) ==
  For cover and main-figure: ~/.openclaw/workspace/skills/wordpress-ultimate/scripts/wp-upload.sh <file> "<alt text>" → prints {"id","url",...}; capture "id" and "url".
  Do NOT hand-roll plain \`curl\` here. thetinkerzone sits behind Cloudflare, which 403s
  plain curl's TLS/JA3 fingerprint ("Just a moment..."); wp-upload.sh routes through
  curl_cffi with Chrome impersonation (fixed 2026-09-02) and handles the alt-text call on
  the same transport. Note images >2560px on the long side are auto-scaled by WP — display
  the \`-scaled\` file but link the un-suffixed original.

== STEP 5 — compose post HTML (woody palette; do NOT set font-family) ==
Colors: headings/CTA/strong = #7A3921 ; borders/accents = #B97040 ; box backgrounds = #FDE5D0 ; body text = #404040 ; muted = #8a6a52.
Sections, in order (mirror J1):
  1. Hook callout — cream box (bg #FDE5D0, 1px #B97040, left-border 5px #7A3921): a punchy 1–2 sentence "why a builder should care", benefit-framed, naming the system, ending "Part of our open Building Jarvis series."
  2. Top CTA — centered rust button "📄 Read the full paper (PDF) →" → the pdfUrl.
  3. <h2>Abstract</h2> in a cream box — the paper's abstract.
  4. Stat cards — ONLY IF the paper has 2–3 punchy numbers: three tiles (big #7A3921 number + caption), then a muted italic line "Claims from the paper, stated here without the proofs — they're in the PDF." If the paper is conceptual with no hard numbers, SKIP this whole section (set hasStatCards=false).
  5. <h2>How it works, in one minute</h2> — 3–5 plain-language bullets of the core mechanics (claims, not proofs).
  6. PDF card — cream box, centered: the COVER image (clickable → pdfUrl) + a big rust "Read the full paper (PDF) →" button + a muted line "<N> pages · …". This is the conversion point; make it prominent.
  7. <h2>Was this useful?</h2> — invite 👍/👎 in the comments.
Do NOT place the main figure inline in the body — it is the FEATURED image (the theme renders it centered at the top). Keep the body clean.

== STEP 6 — create the DRAFT (use python+curl for safe JSON) ==
POST https://thetinkerzone.com/wp-json/wp/v2/posts with: title, status:"draft", content:<the HTML>, excerpt:<the hook, one sentence>, categories:[29] (Building Jarvis), featured_media:<main-figure id>, comment_status:"open".

== VERIFY before returning ==
GET the new draft (context=edit): confirm status=draft, the pdfUrl is in content, featured_media is the main-figure id, categories include 29. Return folder, ok, draftId, editLink (https://thetinkerzone.com/wp-admin/post.php?post=<id>&action=edit), previewLink (https://thetinkerzone.com/?p=<id>&preview=true), pdfUrl, featuredImageId, hasStatCards, notes.`;
}

phase("Publish");
if (!FOLDERS.length) {
  return { error: "no folders given in args.folders" };
}
log(
  `Publishing ${FOLDERS.length} paper(s) as drafts, throttled in batches of 3 (avoids API rate-limits).`,
);
const CHUNK = 3;
const results = [];
for (let i = 0; i < FOLDERS.length; i += CHUNK) {
  const batch = FOLDERS.slice(i, i + CHUNK);
  log(`batch ${Math.floor(i / CHUNK) + 1}: ${batch.join(", ")}`);
  const r = await parallel(
    batch.map(
      (f) => () => agent(pubPrompt(f), { label: `publish:${f}`, phase: "Publish", schema: SCHEMA }),
    ),
  );
  results.push(...r);
}
const done = results.filter(Boolean);
// agent returns the absolute folder path; FOLDERS are short names → match by endsWith
const failed = FOLDERS.filter(
  (f) => !done.some((d) => d && d.folder && d.folder.endsWith(f) && d.ok),
);
return { mode: "publish-drafts", results: done, failed };
