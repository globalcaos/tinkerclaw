/**
 * FORK 2026-05-31 — J5 CEREBELLUM: recipe SELF-APPLY loop (Darwin-Gödel, the apply half).
 *
 * recipe-evolution.ts (engram) PROPOSES autoPromotable mutations for a low-success recipe
 * but never applies them — the proposal's `payload` is an opaque INTENT note ("add a
 * verification/guard step before the failing action"), not a concrete edit. This module is
 * the apply half: given an autoPromotable proposal, it (1) loads the recipe, (2) SNAPSHOTS
 * the current content to an append-only archive (the rollback net — there was none before),
 * (3) has an LLM rewrite the recipe into a new KitSpec applying the op+intent, (4) VALIDATES
 * the rewrite, and (5) writes it ONLY if valid, through the authorship-guarded author path.
 *
 * AUTONOMY, BOUNDED BY FIVE RAILS:
 *   1. STRICT PROMOTE GATE — only `autoPromotable` proposals reach here (recipe-evolution:
 *      success FAR below floor, runs >> the proposal minimum); the clearest correctives only.
 *   2. AUTHORSHIP GUARD — only Jarvis-authored kits (`authoredBy: jarvis-*`) are mutated.
 *      Hand-curated recipes are NEVER touched (checked here AND in the author write path).
 *   3. SNAPSHOT-BEFORE-WRITE — the prior content is archived (never-delete) before any write,
 *      so every auto-mutation is one-command reversible.
 *   4. VALIDATE-OR-SKIP — a rewrite that fails validateKitSpec (or fails to parse) is DROPPED;
 *      the original recipe is kept untouched. A bad rewrite is a no-op, never a corruption.
 *   5. KILL-SWITCH — the whole loop is gated by RECIPE_AUTOAPPLY_ENABLED (see isApplyEnabled).
 *
 * Pure helpers (buildRewritePrompt / extractKitSpec / isJarvisAuthored) are unit-testable; the
 * I/O (load/snapshot/rewrite/author) is injected via ApplyDeps so the orchestration tests run
 * with no gateway, no fs, and no LLM.
 */

import { validateKitSpec, type KitSpec } from "./kit-author.js";

/** The mutation directive this loop applies (the autoPromotable subset of MutationProposal). */
export interface ApplyProposalInput {
  recipeId: string;
  op: string;
  /** Opaque intent note from the Cerebellum (payload.note), e.g. "add a guard step". */
  intent: string;
  rationale: string;
}

export interface ApplyDeps {
  /** Load a recipe's current kit.md text + path by slug; null if it does not exist. */
  loadKitText: (slug: string) => Promise<{ path: string; text: string } | null>;
  /** Snapshot the current text to the append-only archive; returns the archive path. */
  snapshot: (slug: string, text: string) => Promise<string>;
  /** LLM rewrite: produce the improved recipe as raw text (expected to contain a KitSpec JSON). */
  rewrite: (currentText: string, op: string, intent: string) => Promise<string | undefined>;
  /** Write the validated spec through the authorship-guarded author path (overwrite:true). */
  authorKit: (spec: KitSpec) => Promise<{ ok: boolean; note?: string }>;
  log?: { info?: (m: string) => void; warn?: (m: string) => void };
}

export interface ApplyResult {
  recipeId: string;
  applied: boolean;
  reason:
    | "applied"
    | "recipe-missing"
    | "curated-skip"
    | "rewrite-empty"
    | "rewrite-invalid"
    | "author-rejected";
  archivePath?: string;
  /** validateKitSpec errors when reason === "rewrite-invalid". */
  errors?: string[];
}

/** Master gate. Explicit opt-in (RECIPE_AUTOAPPLY_ENABLED="true") so it is OFF in tests/clones
 *  and ON only where openclaw.json sets it — matching the supersede/semantic flags. */
export function isApplyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RECIPE_AUTOAPPLY_ENABLED === "true";
}

/**
 * Authorship guard, mirrored from the author RPC (kit-rpcs.ts): only kits this fork itself
 * authored (`authoredBy: jarvis-*`) may be auto-mutated. Hand-curated kits have no such field
 * and are protected. Pure + testable.
 */
export function isJarvisAuthored(kitText: string): boolean {
  return /authoredBy:\s*["']?jarvis/i.test(kitText);
}

/** Compose the rewrite prompt. The subagent must return ONLY a KitSpec JSON object. Pure. */
export function buildRewritePrompt(currentText: string, op: string, intent: string): string {
  return `You are a RECIPE-EVOLUTION editor. A recipe (an OpenClaw "kit/1.0" markdown file) has a
low success rate, and the Cerebellum proposed this corrective mutation:

  op:     ${op}
  intent: ${intent}

Apply the SMALLEST change that addresses the intent — do not rewrite wholesale, do not change the
slug, and keep the recipe's purpose intact. Output ONLY a single JSON object (no prose, no code
fences) for the improved recipe, with this shape:

{
  "slug": "<unchanged slug>",
  "title": "<string>",
  "summary": "<string, <=400 chars>",
  "tags": ["<string>", ...],
  "steps": [ { "title": "<string>", "body": "<string>", "tools": ["..."]?, "doneWhen": "<string>"? }, ... ],
  "goal": "<optional string>",
  "constraints": ["<optional>"],
  "safetyNotes": ["<optional>"]
}

There MUST be at least one step. For op "add_step", add the verification/guard step the intent
describes (do not remove existing steps). For op "tighten_criteria", make the relevant step's
doneWhen / a constraint stricter. Here is the CURRENT recipe:

--- BEGIN RECIPE ---
${currentText}
--- END RECIPE ---`;
}

/**
 * Extract a KitSpec object from an LLM reply. Tolerates code fences + leading/trailing prose by
 * taking the first balanced top-level JSON object. Returns undefined if none parses. Pure.
 */
export function extractKitSpec(reply: string | undefined): unknown | undefined {
  if (!reply || !reply.trim()) return undefined;
  // Strip ```json fences if present.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply);
  const candidate = fenced ? fenced[1] : reply;
  const start = candidate.indexOf("{");
  if (start < 0) return undefined;
  // Walk to the matching closing brace (string-aware) so trailing prose does not break parse.
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * Apply one autoPromotable mutation proposal. Orchestrates the five rails. Never throws — every
 * failure mode returns a typed ApplyResult and leaves the recipe untouched (except a successful
 * apply, which is preceded by a snapshot). I/O is injected for testability.
 */
export async function applyMutationProposal(
  input: ApplyProposalInput,
  deps: ApplyDeps,
): Promise<ApplyResult> {
  const { recipeId } = input;
  const loaded = await deps.loadKitText(recipeId);
  if (!loaded) {
    deps.log?.warn?.(`[recipe-apply] ${recipeId}: recipe not found — skip`);
    return { recipeId, applied: false, reason: "recipe-missing" };
  }
  // Rail 2: never auto-mutate a hand-curated recipe.
  if (!isJarvisAuthored(loaded.text)) {
    deps.log?.info?.(
      `[recipe-apply] ${recipeId}: curated (not jarvis-authored) — skip, needs human`,
    );
    return { recipeId, applied: false, reason: "curated-skip" };
  }
  // Rail 3: snapshot BEFORE any write (rollback net).
  const archivePath = await deps.snapshot(recipeId, loaded.text);
  // LLM rewrite.
  const reply = await deps.rewrite(loaded.text, input.op, input.intent);
  const spec = extractKitSpec(reply) as KitSpec | undefined;
  if (!spec) {
    deps.log?.warn?.(`[recipe-apply] ${recipeId}: rewrite empty/unparseable — keep original`);
    return { recipeId, applied: false, reason: "rewrite-empty", archivePath };
  }
  // Preserve the slug — a rewrite must not fork the recipe identity.
  spec.slug = recipeId;
  // Rail 4: validate-or-skip.
  const v = validateKitSpec(spec);
  if (!v.ok) {
    deps.log?.warn?.(
      `[recipe-apply] ${recipeId}: rewrite invalid (${v.errors.join("; ")}) — keep original`,
    );
    return { recipeId, applied: false, reason: "rewrite-invalid", archivePath, errors: v.errors };
  }
  // Write through the authorship-guarded author path.
  const res = await deps.authorKit(spec);
  if (!res.ok) {
    deps.log?.warn?.(
      `[recipe-apply] ${recipeId}: author rejected (${res.note ?? "?"}) — kept original`,
    );
    return { recipeId, applied: false, reason: "author-rejected", archivePath };
  }
  deps.log?.info?.(
    `[recipe-apply] ${recipeId}: APPLIED op=${input.op} (snapshot ${archivePath}); ${res.note ?? ""}`,
  );
  return { recipeId, applied: true, reason: "applied", archivePath };
}
