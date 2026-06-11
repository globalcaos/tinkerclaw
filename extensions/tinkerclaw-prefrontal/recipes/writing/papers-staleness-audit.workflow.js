export const meta = {
  name: "papers-staleness-audit",
  description:
    "Read-only audit: detect NEW papers without a thetinkerzone.com post, and LIVE posts gone stale because their source paper advanced past the version the post references. Emits a triage table + per-row recommended action. Writes nothing.",
  whenToUse:
    'Run before any publish/refresh sweep, or when asked "check for new papers / are our posts stale". Pairs with publish-paper-summary (new) and revise-publish-batch (refresh source first). No args needed.',
  phases: [
    {
      title: "Audit",
      detail: "scan paper folders for latest version + query live Building Jarvis posts, then diff",
    },
  ],
};

const BASE = "~/Documents/AI_reports/Papers";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rows", "summary"],
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["folder", "paperVersion", "verdict", "action"],
        properties: {
          folder: { type: "string" },
          paperVersion: {
            type: "string",
            description: "genuinely-latest version header in the folder",
          },
          paperDate: { type: "string" },
          hasPdf: { type: "boolean" },
          pendingNotes: {
            type: "boolean",
            description: "improvement_notes.md newer than latest version / not yet incorporated",
          },
          postId: { type: "integer", description: "live post id, 0 if none" },
          postStatus: { type: "string" },
          postVersion: {
            type: "string",
            description: "version the post's PDF references, empty if no post",
          },
          verdict: { type: "string", enum: ["current", "stale", "new", "not-ready"] },
          action: { type: "string", description: "concrete recommended next step" },
        },
      },
    },
    summary: { type: "string" },
  },
};

const PROMPT = `Audit J-series papers vs their live thetinkerzone.com posts. READ-ONLY — do NOT write files, do NOT touch WordPress. Return the triage only.

== STEP 1 — latest version per paper folder ==
List every folder \`${BASE}/J*_*\`. For each, find the GENUINELY-latest version (NOT just the highest-dated filename — an undated \`<topic>.md\` can carry a higher \`vX.Y\` header than a dated file; compare version headers in the YAML/title across dated + undated candidates, ignoring \`*-review-*\`, \`*-critique*\`, \`sota-*\`, \`*-references*\`, \`diagram-*\`, \`improvement_notes*\`). Record: folder, paperVersion (e.g. v3.0), paperDate (from the filename date prefix), hasPdf (is there a built .pdf at that same version?), pendingNotes (is \`improvement_notes.md\` mtime NEWER than the latest version file, i.e. notes not yet incorporated — distinct from an \`improvement_notes.incorporated-*.md\`).

== STEP 2 — live Building Jarvis posts ==
  PW=\$(grep '^WP_APP_PASSWORD=' ~/.openclaw/workspace/skills/wordpress-ultimate/.env | cut -d= -f2-)
  curl -s -u "oserra:\$PW" "https://thetinkerzone.com/wp-json/wp/v2/posts?categories=29&per_page=50&status=publish,draft&context=edit&_fields=id,status,slug,content"
For each post, extract the PDF version it references (regex \`/uploads/2026/\\d\\d/(.+?\\.pdf)\` in the content; the version token is the \`vX.Y\` in that filename). Map each post to its paper folder by codename/topic in the slug+filename.

== STEP 3 — diff + verdict (per folder) ==
  - **new**: folder has NO matching post. action = "publish via publish-paper-summary" IF hasPdf AND NOT pendingNotes; else "revise+compile first (pending notes / no PDF), then publish".
  - **stale**: post exists but postVersion < paperVersion (source advanced past what the post shows). action = "rebuild PDF at <paperVersion> (compile-paper), SFTP-replace it, then UPDATE existing post <id> (do not create a new post)".
  - **not-ready**: folder is a sketch/seed (version < v1.0 or filename contains 'sketch', no PDF). action = "hold — not publishable yet".
  - **current**: postVersion == paperVersion. action = "none".

Return rows (one per folder) + a one-paragraph summary: counts of new / stale / not-ready / current, and the highest-priority action.`;

phase("Audit");
const result = await agent(PROMPT, {
  label: "papers-staleness-audit",
  phase: "Audit",
  schema: SCHEMA,
});
return result;
