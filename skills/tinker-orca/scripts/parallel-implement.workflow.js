export const meta = {
  name: 'orca',
  description: 'ORCA (ORChestrator for parallel multi-Agent coding; formerly parallel-implement) — lease-based parallel multi-agent coding: draft patches in parallel (no lease), apply them per-file-serialized with fast handoff, then COMMIT each applied unit as its own clean commit (fast committing — no orphan pile; committing is AUTOMATIC + unconditional — ORCA never asks whether to commit, and the orchestrator should not ask either; pushing is a SEPARATE, human-initiated step only). DEFAULT to ORCA whenever a task touches 2+ files that can be edited independently.',
  whenToUse: 'Reach for ORCA when a task decomposes into 2+ edit-units whose `writes` files are DISJOINT (independent) — that is where the parallel draft + per-file apply pays off. For a single file, or tightly-coupled edits that all touch one file, a direct edit or a single focused agent is simpler and faster; ORCA will serialize same-file units (correct, but little gain). Pass units with a `writes` file list. Invoke via the Workflow tool with scriptPath set to docs/superpowers/parallel-implement.workflow.js.',
  phases: [
    { title: 'Route', detail: 'Phase R — the Conductor routes each unit to the model measured strongest on that kind of work (FUGU-style), and composes a debate or a cross-provider critic where it pays' },
    { title: 'Draft', detail: 'Phase A — read + draft an exact patch per unit, fully parallel, NO lease held' },
    { title: 'Apply', detail: 'Phase B — apply patches per-file-serialized via a lease dispatcher (fast handoff); edits to files a live dev server watches are staged off-tree and landed in one burst, so an open UI reloads once on the finished state' },
    { title: 'Commit', detail: 'Phase C — commit each applied unit as its own commit (serialized; one unit = one commit), message per the ORCA commit-message rules' },
    { title: 'Ledger', detail: 'Phase L — record what each routed model actually achieved, so the expertise table shifts from published priors toward our own measured outcomes' },
  ],
}

// ───────────────────────────────────────────────────────────────────────────
// Lease-based parallel multi-agent coding orchestrator.
// Design notes: see the TinkerClaw fork — github.com/globalcaos/tinkerclaw
//
// CORE IDEA: the only contention points are shared files. Make them serialize via short-lived
// per-file leases while everything else runs concurrently — so "clean merge" is a non-event
// (writes against ONE tree never diverge). The decisive move is two-phase workers:
//   Phase A (NO lease, parallel): read + diagnose + draft the EXACT patch. ~95% of wall-clock.
//   Phase B (brief lease, serial-per-file): acquire the file leases → apply the prepared patch →
//           verify that file → release. Seconds. The file "passes hands" the instant the edit lands.
//   UI QUIESCENCE (cross-cutting): when a unit writes files a LIVE dev server watches, the edits are
//           assembled where the watcher cannot see them (the worktree, or /tmp in in-place mode) and
//           landed in ONE burst — so an open page reloads once, on the finished state, instead of once
//           per hunk on a half-applied file. See the UI QUIESCENCE block below.
//   Phase C (serial, after apply): commit each applied unit as its OWN commit. FAST COMMITTING —
//           don't leave an orphan pile. Commits are serialized (one git index/HEAD) and each stages
//           ONLY that unit's files, so a parallel session's unrelated WIP is never swept in.
//
// args = {
//   repoRoot: string,                       // absolute path of the repo to edit
//   units: [{ id, task, writes:[paths], reads?:[paths] }],   // edit-units; `writes` = the files this unit edits
//   wrapPath?: string,                      // absolute path to a cmd_display.py-style bash wrapper (if the dir is hook-gated).
//                                           //   The orchestrator injects the wrap rule into EVERY phase (preflight/draft/apply/
//                                           //   commit/verify) and tells Phase B to run verify wrapped. Do NOT hand-encode the
//                                           //   wrapper inside verifyHint — pass wrapPath and write verifyHint as the bare command.
//   verifyHint?: string,                    // how to typecheck/verify a changed file (passed to Phase-B agents) — BARE command
//   integrationVerify?: string,             // one whole-tree command run ONCE after Phase B (authoritative final gate, e.g. a bundle/typecheck)
//   commit?: boolean,                       // default TRUE — commit each applied unit (Phase C). Set false to leave staged-only.
//   handsOffPaths?: [paths],                // (pre-flight) paths the run must NOT touch/sweep; a write under any forces commit:false
//   allowForeignWip?: boolean,              // default false — override the pre-flight's "force commit:false on foreign WIP" safeguard
//   commitScope?: string,                   // optional conventional-commit scope hint for the subject, e.g. "tinker-ui"
//   coAuthor?: string,                      // co-author trailer line appended to every commit
//   hmrPaths?: [prefixes] | false,          // repo-relative path prefixes a live dev server WATCHES (default: the tinker-ui vite
//                                           //   roots). A unit writing under one of these gets the UI-QUIESCENCE directive:
//                                           //   assemble the edits where the watcher cannot see them, land them in ONE burst,
//                                           //   so the open page reloads once — from old coherent state to new. `false` disables.
//   worktreePerAgent?: boolean,             // DEFAULT TRUE. each disjoint unit applies+commits in its own worktree off clean HEAD,
//                                           //   overlap groups serialize onto one shared worktree, Phase C fast-forwards/cherry-picks
//                                           //   the branches back. SAME-FILE foreign WIP is STASH-PROTECTED across the merge-back
//                                           //   (snapshot the foreign-dirty file via `git stash create` → land the clean commit →
//                                           //    `git checkout <snap> -- <files>` to restore their WIP; NEVER refs/stash
//                                           //   on its disjoint lines), so a parallel session's uncommitted edits to a file you also
//                                           //   edit are neither swept nor reverted. Opt OUT with worktreePerAgent:false.
// }
//
// COMMIT-MESSAGE RULES (Phase C injects these into every commit agent):
//   1. Subject: `<type>(<scope>): <imperative summary>` ≤72 chars. Infer <type> from the change —
//      feat (new capability) | fix (bug) | docs | refactor | perf | test | chore. <scope> = commitScope
//      or the touched module/area.
//   2. Body (wrap ~72 cols): WHAT changed and WHY — derive the "why" from the unit's task/intent.
//      If the patch was re-derived (stale), say so. Note non-obvious files.
//   3. Quote any task IDs / issue refs / spec paths that appear in the unit task, verbatim.
//   4. Stage ONLY this unit's files: `git add -- <writes>`. NEVER `git add -A` / `git add .` —
//      a parallel agent or session may hold unrelated WIP in the same tree.
//   5. End with the co-author trailer (args.coAuthor).
//   6. Do NOT use --no-verify, --force, or --amend; let pre-commit hooks run.
//   7. No secrets/credentials/absolute host paths in the message (matters on public repos).
//   8. One commit per unit unless told otherwise.
// ───────────────────────────────────────────────────────────────────────────

// Defensive: the harness sometimes delivers `args` JSON-encoded as a string instead of an object.
let a = args || {}
if (typeof a === 'string') {
  try { a = JSON.parse(a) || {} } catch { a = {} }
}
const REPO = a.repoRoot
const UNITS = Array.isArray(a.units) ? a.units : []
const WRAP = a.wrapPath || ''
const VERIFY = a.verifyHint || 'typecheck only the file(s) you changed if a fast per-file check exists; otherwise skip and say UNVERIFIED'
// COMMITTING IS OPT-IN (changed for public release, 2026-09-08).
// Phase C rewrites git history, so it does not happen unless the caller asks for it
// TWICE: `commit: true` states the intent, `confirmedCommit: true` acknowledges that
// this run will create commits in the target repo. Anything less and ORCA applies and
// verifies the patches, then leaves them uncommitted for you to inspect.
let DO_COMMIT = a.commit === true && a.confirmedCommit === true
if (a.commit === true && a.confirmedCommit !== true) {
  console.warn(
    '[orca] commit:true was passed WITHOUT confirmedCommit:true — running in apply-only mode.\n' +
    '       Nothing will be committed. Pass confirmedCommit:true to enable Phase C.',
  )
}
const COMMIT_SCOPE = a.commitScope || ''
const CO_AUTHOR = a.coAuthor || 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>'
// Contention pre-flight (#2): paths the run must NOT touch / sweep, and an override for foreign WIP.
const HANDS_OFF = Array.isArray(a.handsOffPaths) ? a.handsOffPaths : []
const ALLOW_FOREIGN_WIP = a.allowForeignWip === true
// Single integration verify (#4): one whole-tree command run ONCE after Phase B (authoritative gate).
const INTEGRATION_VERIFY = a.integrationVerify || ''
// Worktree-per-agent hybrid (#1b) — DEFAULT ON (2026-06-07): each disjoint unit edits on its OWN
// branch (orca/<id>) in an isolated worktree off clean HEAD, then Phase C merges those branches back into
// the working branch — so a PARALLEL session's uncommitted WIP in the shared tree is never touched and
// every agent gets a clean base. SAME-FILE foreign WIP (a parallel session holds uncommitted edits to a
// file THIS run also writes) is handled in Phase C by STASH-PROTECTION (2026-06-10): git refuses to
// merge/cherry-pick into a dirty file, so the merge-back stashes exactly the foreign-dirty file(s) for the
// group, fast-forwards/cherry-picks the clean commit, then `git checkout <snap> -- <files>` restores the foreign WIP on its
// (disjoint) lines — landing your change AND preserving theirs, no sweep, no revert. Opt OUT with
// worktreePerAgent:false (reverts to the lighter in-tree Phase B/C, which still bails to commit:false on
// foreign WIP). Cost: ~200-500ms + disk per group — accepted as the default for the contended fork.
const WORKTREE = a.worktreePerAgent !== false

// ── FUGU routing (2026-07-25) — the Conductor. ──────────────────────────────────
// ORCA used to run every unit on the same model at the same effort. Sakana AI's Fugu
// (arXiv 2606.21228) showed that routing per DOMAIN to the model measured best at it beats
// every individual model in the pool (SWE-Bench Pro 73.7 vs Opus 69.2; Terminal-Bench 82.1
// vs GPT 78.2; GPQA 95.5 vs Gemini 94.3). We do the same with our four suppliers.
//
//   quality: 'ultra' (DEFAULT — the maintainer: "by default we go for the best")
//              contested domains convene a cross-provider debate with an ADAPTIVE
//              aggregator; coding units get a critic from a DIFFERENT provider.
//            'fugu'  the cheap tier — exactly one worker per unit, the domain leader.
//            'off'   legacy behaviour: no routing, every agent inherits the session model.
//   conductorPath: the orca-conductor.mjs that owns the expertise table + ledger.
//
// The routing table is NOT hand-tuned opinion: it is seeded from published per-benchmark
// leaders and then overridden by OUR measured outcomes as the ledger fills (Phase L).
const QUALITY = a.quality || 'ultra'
const CONDUCTOR =
  a.conductorPath || process.env.ORCA_CONDUCTOR || '' // OPTIONAL: per-domain model routing; unset = every unit runs on the default model
// The Workflow tool spawns CLAUDE subagents, so only Anthropic models are reachable by
// agent({model}). Non-Anthropic workers in a plan are dispatched by the lead agent through
// openclaw-spawn-subagent.mjs (the gateway path, which reaches all four providers).
// REQUIRED. Path to your OpenClaw subagent-spawn CLI. Pass `spawnCliPath` in args, or set
// ORCA_SPAWN_CLI. There is deliberately no machine-specific default here.
const SPAWN_CLI =
  a.spawnCliPath ||
  process.env.ORCA_SPAWN_CLI ||
  `${process.env.HOME}/src/tinkerclaw/scripts/openclaw-spawn-subagent.mjs`
const CROSS_PROVIDER = a.crossProvider !== false

// The commit-message ruleset, injected verbatim into every Phase-C commit agent.
const COMMIT_RULES = [
  'COMMIT-MESSAGE RULES (follow ALL):',
  '1. Subject: `<type>(<scope>): <imperative summary>` ≤72 chars. Infer <type>: feat (new capability) | fix (bug) | docs | refactor | perf | test | chore.' + (COMMIT_SCOPE ? ` Use scope "${COMMIT_SCOPE}".` : ' <scope> = the touched module/area.'),
  '2. Body (wrap ~72 cols): WHAT changed and WHY — take the "why" from the unit task/intent below. If the patch was re-derived from stale context, note it. Mention non-obvious files.',
  '3. Quote any task IDs / issue refs / spec paths from the unit task verbatim.',
  '4. Stage ONLY this unit\'s files with `git add -- <files>`. NEVER `git add -A` / `git add .` — a parallel session may hold unrelated WIP in the same tree. If you are unsure whether a dirty file is yours, do not reason about it from mtimes or from what the diff looks like: run `scripts/session-guard/whose-file.sh` (no arguments) and read the answer. Nothing under ANOTHER SESSION\'S or NO RECORD belongs in your commit.',
  `5. End the message with this trailer line exactly: ${CO_AUTHOR}`,
  '6. Do NOT pass --no-verify, --force, or --amend; let pre-commit hooks run.',
  '7. No secrets/credentials/absolute host paths in the message.',
  '8. Exactly ONE commit for this unit.',
  // Added 2026-08-06 after a session where four features were found dead behind green signals.
  '9. FINISH THE COMMIT. Do not stop with the work applied but uncommitted — an uncommitted change is invisible to every other session, is swept up or clobbered by the next `git add`, and does not exist after a restart. If you cannot commit, say so loudly in your summary rather than leaving the tree dirty and reporting success.',
  '10. VERIFY BEFORE YOU COMMIT, and put the evidence in the body — the command you ran and what it printed, not "verified". "Tests pass" with no numbers is not a claim anyone can check later.',
  '11. If the change is a FIX, the commit should also carry the test that proves it. A verification you ran once and did not commit is an anecdote: it protects nothing and the next person cannot tell it ever happened. Where a safety property is asserted, include the CONTROL — first show the old behaviour really fails, then that the new one does not; an assertion with no control passes equally against a broken fixture.',
  '12. Never write a commit message that describes intent the code does not implement. If the message and the diff disagree, the message is the bug — fix one of them before committing, because the message is what the next reader will trust.',
].join('\n')

// Standing documentation requirement (2026-06-07; widened 2026-09-01 after a chat-visible
// feature shipped with only a bug-log aside). New design principles, features, and requirements are
// not "done" until the bible carries them, and old entries that the change makes wrong are updated
// in the same run. Injected into every Phase-A draft prompt.
const DOC_REQUIREMENT = [
  'DOCUMENTATION REQUIREMENT (standing, 2026-06-07; widened 2026-09-01): new design principles, features, and requirements are not complete until the bible carries them. The architect does not have to ask. A chat-visible feature with no optic is unfinished work, same as uncommitted code.',
  '  NEW — annotate in the SAME change:',
  '    (a) the owning TINKER_UI_DESIGN_BIBLE optic, stating purpose, invariant, choice made, alternatives rejected and why, PLUS a `verify:` gate that fails if the thing stops existing (design-principles #21). Design principles go in design-principles.md AND are anchored in FOUNDATION + INDEX. Features go in the optic that owns the concern (tinker-ui.md for chat/UI, etc.). Requirements that bind future agents go in the optic AND in whatever prompt/workflow will actually fire them.',
  '    (b) a concise dated note on the relevant J-series paper improvement_notes.md (~/Documents/AI_reports/Papers/J*/improvement_notes.md) so the next paper revision captures the new functionality.',
  '  OLD — promptly UPDATE every existing entry this change makes wrong or incomplete. A stale optic is worse than a missing one, because it is read and believed. Correcting a now-false claim outranks documenting the new one. Do it in this run, not as a follow-up you hope someone files. This is a DUTY, not an "also consider".',
  'If the bible optic or the J-series improvement_notes file is NOT in THIS unit\'s allowed `writes`, do NOT edit it — instead FLAG in your `notes`/`summary` that a follow-up bible-gate unit and/or a J-series improvement_notes unit is required (name the exact optic + the J-paper). The caller then includes those as their own edit-units. Callers composing an ORCA run MUST include that bible unit up front when they already know the change is a new principle/feature/requirement — do not discover the gap after Phase A.',
  'ALSO, and say which applies in your notes even when the answer is "none":',
  '  - Does it deserve a `verify:` gate that would have CAUGHT the bug? Prefer a gate that fails on the defect over prose describing it. Prose decays into being ignored; a failing check does not.',
  '  - Does it belong in `bug-log.md`? Anything that cost real time to diagnose does, with its failure class — the log is how the next agent answers "has this shape been seen before?".',
  '  - Does it invalidate a NUMBER written anywhere (a cap, a ratchet, a measured count)? Move the number in the SAME commit. A ratchet left above the measured value is slack that silently absorbs the next regression.',
].join('\n')

// Standing mechanism evaluation (2026-09-01): programmatic rules beat prompting in
// consistency, every time — and consistency is what we want in the chat. Injected into every
// Phase-A draft prompt so a unit has to CHOOSE code vs md, not default to a prompt because it is
// cheaper to write. The shippability comment below is the same fact applied to plugin imports;
// this is that fact applied to product behavior.
const MECHANISM_REQUIREMENT = [
  'MECHANISM EVALUATION (standing, 2026-09-01; corrected same day): code and prompt are two different goods. Code buys CONSISTENCY (fires the same way every turn; the next model cannot skip it). Prompt buys PLASTICITY (the next model can adapt, retune, exercise judgment). Code does NOT beat prompt all the time. Prefer code whenever it is possible. Keep prompt when plasticity is the point, or there is no structural producer.',
  'Before implementing a user-visible behavior, evaluate both, then choose:',
  '  - PREFER CODE whenever possible — there is a structural producer to hang it on, and the want is "this should happen the same way every time." A matcher, a trail event, a CSS class, a `verify:` that greps the renderer: that is a framework. Chat-visible reminders of this kind belong here.',
  '  - PROMPT / SKILL.md / AGENTS.md when plasticity is the point (tone, what to say, judgment, a behavior you want retuned as the situation changes) OR there is no structural producer. Name that reason in the bible entry. Forgettability is the cost of plasticity; that is a trade, not a defect.',
  '  - Worked split (2026-08-28/29): the recipe chip in chat is CODE (matched/merged trail → `_recipeTitle`/`_recipePath` → `renderRecipeNotice`) because the matcher already fires and the want is consistency. The skill line is PROMPT (no matcher fires for a skill; AGENTS.md) because which skill applies is judgment. Mixing them — a UI chip with no producer, or a chat-visible recipe left only as an instruction — is the failure this rule exists to stop.',
  'Say in your notes which you chose and why. Silence has not evaluated; prefer code in that case, and say so.',
].join('\n')

// Hard-won verification rules (2026-08-06). Injected into every Phase-A draft prompt. Each one is
// here because it cost this project real time in a single session — not because it sounds prudent.
const VERIFICATION_DISCIPLINE = [
  'VERIFICATION DISCIPLINE (standing — each of these was learned the expensive way):',
  '  1. VERIFY THE ARTEFACT, NOT THE SOURCE. Editing a file is not shipping it. A fix that is correct in `src/` and absent from `dist/` is not deployed, and it will read as done in every review. Where a build step exists, check the BUILT output — a command-injection fix this project shipped was confirmed by finding the vulnerable string present in dist beforehand and absent after, which is the only check that could have distinguished "fixed" from "believed fixed".',
  '  2. A GREEN STATUS LINE IS NOT EVIDENCE; THE ARTEFACT IS. "exit 0", "deploy complete" and "tests pass" are all compatible with the feature doing nothing. Go and look at the row, the file, the count.',
  '  3. NEVER GUESS A PREDICATE WHEN A CHECKABLE ONE EXISTS. If you need "is this file ours / is this plugin published / does this exist upstream", find the command that answers it. A guessed name-prefix rule shipped in this repo would have covered the wrong 3 of 5 targets while looking green.',
  '  4. AN OPTIONAL CALL TO A MISSING METHOD IS SILENT. `x.foo?.()` where `foo` does not exist is indistinguishable from a working call with nothing to say. If a call must happen, make it unguarded and let the type system or the crash tell you.',
  '  5. WHEN A COMMENT AND THE CODE DISAGREE, ONE OF THEM IS A BUG — decide which, and fix it. Do not leave a docstring describing behaviour the function does not have.',
  '  6. IF YOU CANNOT VERIFY, SAY "UNVERIFIED" IN YOUR SUMMARY. An honest gap is actionable; a confident claim that turns out false costs far more than the work it saved.',
].join('\n')

// ── VANILLA-OPENCLAW SHIPPABILITY (2026-08-05— SET IN STONE) ────────────────────────────
// WHY THIS OUTRANKS ALMOST EVERYTHING ELSE HERE. ClawHub is the #1 traffic source into the whole
// funnel (ClawHub/Moltbook → tinkerclaw repo → thetinkerzone + sprintpaper), ~20 skills and ~20K
// downloads today, and that funnel is step one of a plan to replace employment income. Every plugin
// we build is meant to ship there.
//
// A ClawHub install lands the plugin in a VANILLA OpenClaw — not in this fork. So a plugin that
// reaches into fork core by relative path (`../../src/**`) is not "slightly non-idiomatic": on a
// user's machine that import target DOES NOT EXIST, and the plugin fails at load with
// ERR_MODULE_NOT_FOUND. It cannot be caught here, because in this tree the path resolves perfectly.
// The bug is invisible until it is in a stranger's hands, which is the worst place to find it and
// the fastest way to burn the adoption ladder the funnel depends on.
//
// This is the same shape as the total-recall incident: the fix that "worked locally" would have
// shipped a broken module. It is also why the upstream boundary rule — which looks like inherited
// ceremony for an independent fork — is in fact load-bearing HERE, for a reason upstream never had.
//
// Read as EXPLAIN. The ENFORCE half is EXT_SHIPPABILITY_VERIFY below: an extension unit's verify
// command gets the boundary check appended, so a unit that breaks this FAILS rather than being
// advised. A rule that lives only in a prompt is a rule the next model forgets.
const SHIPPABILITY_REQUIREMENT = [
  'VANILLA-OPENCLAW SHIPPABILITY (standing, non-negotiable): plugins/extensions are published to ClawHub and install into a VANILLA OpenClaw, never into this fork.',
  '  - NEVER import fork core by relative path from inside extensions/** (no `../../src/**`, no `../../../src/**`). It resolves in this tree and DOES NOT EXIST on a user machine.',
  '  - Cross into core ONLY through a published SDK subpath: `openclaw/plugin-sdk/<name>`.',
  '  - PUBLISHING A SUBPATH IS EXACTLY THREE EDITS, VERIFIED 2026-08-07, and two of them are SHARED FILES:',
  '      1. `src/plugin-sdk/<name>.ts` — a thin re-export, e.g. `export { foo } from "../infra/foo.js";` (own file, safe to parallelise)',
  '      2. `scripts/lib/plugin-sdk-entrypoints.json` — append "<name>" to the array  ***SHARED***',
  '      3. root `package.json` — add `"./plugin-sdk/<name>": {"types":"./dist/plugin-sdk/<name>.d.ts","default":"./dist/plugin-sdk/<name>.js"}`  ***SHARED***',
  '      `pnpm lint:plugins:plugin-sdk-subpaths-exported` checks 2 and 3 agree with 1; it is GREEN today, so a half-done subpath turns it RED.',
  '  - BECAUSE 2 AND 3 ARE SHARED, never split subpath publication across parallel units. ONE unit owns all subpath creation for the run (the contract owner) and every consuming unit is drafted AFTER it applies. Two units appending to the same JSON array will each drop the other\'s entry, and the gate that catches it runs after both have "succeeded".',
  '  - The subpath must carry the SYMBOL, not just the module. A subpath can re-export a module partially — `src/plugin-sdk/provider-auth.ts` re-exports some of `agents/auth-profiles/store` and not the rest — so rewriting an import against a subpath that lacks your symbol builds a broken plugin. Check the symbol, not the path.',
  '  - Prefer a NEW fork-named subpath (`fork-<area>`) over editing an upstream-owned `src/plugin-sdk/*.ts`: same result, no cherry-pick friction against upstream.',
  '  - If the surface you need has no subpath yet and you are NOT the contract owner, do not reach around it: set blocked=true and name the subpath you need.',
  '  - Never import `src/plugin-sdk-internal/**` from an extension: it is private to the SDK and not part of the published contract.',
  '  - Keep the plugin self-contained: assets it needs at runtime must ship with it (manifest/STATIC_EXTENSION_ASSETS), not be read from the fork tree.',
  'If a unit cannot satisfy this, set blocked=true and explain — shipping a plugin that only works inside this fork is worse than not shipping it.',
].join('\n')

/** Files under extensions/** are ClawHub-shippable surface and get the boundary gate appended. */
const touchesExtensions = (u) =>
  (u.writes || []).some((p) => String(p).replaceAll('\\', '/').includes('extensions/'))

// ── UI QUIESCENCE (2026-08-16) — minimise the perturbation of a LIVE UI ──────────────────
// The Tinker UI is served by a vite dev server that WATCHES its source tree: every write to a
// watched file rebuilds the bundle and RELOADS whatever page the architect currently has open.
//
// So an edit-unit applied hunk-by-hunk does not perturb his UI once — it perturbs it once PER
// HUNK, and every intermediate state is a half-applied file. What he watches for the duration of
// the run is a UI built from source that was never valid: a screen that blanks, throws, and
// re-renders several times before settling. Two units editing two watched files interleave that
// twice over. The change is fine; the WAY it lands is the damage.
//
// THE RULE: never edit a watched file in place. Assemble the finished content where the watcher
// cannot see it, verify it there, then land every file of the unit in ONE burst — so the watcher
// observes exactly one transition, old coherent state → new coherent state.
//
// Note the shape this already has in worktree mode (the DEFAULT): the isolated worktree IS the
// off-tree staging area, so Phase B is invisible to vite and the Phase-C merge-back is the single
// write. The directive below is what gives IN-PLACE mode (worktreePerAgent:false) the same
// property, and what stops the merge-back from interleaving builds between group merges.
const DEFAULT_HMR_PATHS = ['tinker-ui/src/', 'tinker-ui/index.html', 'tinker-ui/public/', 'ui/src/']
const HMR_PATHS = a.hmrPaths === false ? [] : (Array.isArray(a.hmrPaths) ? a.hmrPaths : DEFAULT_HMR_PATHS)
const normPath = (p) => String(p).replaceAll('\\', '/').replace(/^\.\//, '')
/** The subset of a unit's writes that a live dev server watches (empty ⇒ nothing to quiesce). */
const hmrFilesOf = (u) =>
  (u.writes || []).filter((p) => HMR_PATHS.some((h) => normPath(p).startsWith(normPath(h))))
const touchesHmr = (u) => hmrFilesOf(u).length > 0

/** Where a unit assembles its watched files, OUTSIDE the repo so no watcher and no `git status` sees it. */
const stageDirFor = (u) => `/tmp/orca-ui-stage-${u.id}`

/**
 * ENFORCE half of the rule, for IN-PLACE mode (worktreePerAgent:false), where the apply agent is
 * editing the very tree vite is watching. Injected into that unit's Phase-B prompt only.
 */
const uiQuiescenceApply = (u) => {
  const files = hmrFilesOf(u)
  const stage = stageDirFor(u)
  return [
    `UI QUIESCENCE (this unit writes files a LIVE dev server watches: ${JSON.stringify(files)}) — the architect may be looking at that page right now.`,
    `Every write to those files rebuilds and RELOADS his page. Applying your hunks in place means one reload per hunk, each showing a UI built from a half-applied file. Do NOT edit them in place. Instead:`,
    `  1. STAGE off-tree: \`rm -rf ${stage} && mkdir -p ${stage} && cd ${REPO} && cp --parents -- ${files.join(' ')} ${stage}/\` — this copies the CURRENT files, keeping their relative paths, somewhere the watcher cannot see.`,
    `  2. EDIT THE COPIES ONLY, at \`${stage}/<relative path>\`. Apply EVERY hunk of this unit there. Read them back from ${stage} too — the repo copy is still the old version, on purpose.`,
    `  3. VERIFY on the staged copies wherever the check allows it (a typecheck/lint usually takes a path). If the check only works in place, run it AFTER step 4 and be ready to fix forward.`,
    `  4. LAND IN ONE BURST — a single command that copies every file back with nothing in between:`,
    `       ${files.map((f) => `cp -- ${stage}/${normPath(f)} ${REPO}/${normPath(f)}`).join(' && ')}`,
    `     Copy the CONTENT (\`cp\`); do not \`mv\`, rename, or symlink — swapping the inode can make a watcher drop the file and stop reloading at all. This is the ONLY moment the UI changes.`,
    `  5. After step 4, do not start a UI build, restart the dev server, or touch those files again. One transition, and it is the final state.`,
    `If you genuinely cannot stage (no write access to /tmp), apply in place rather than stalling — but say "UI perturbed per-hunk" in \`notes\` so it is not mistaken for a quiet landing.`,
  ].join('\n')
}

/**
 * ENFORCE half of SHIPPABILITY_REQUIREMENT. Appended to the per-unit verify for any unit that
 * writes under extensions/**. These are the two upstream modes that catch a fork-core reach; they
 * are cheap and they fail loudly, which is the entire point — see §2.4 of J20 on why a rule that
 * exists only as prose gets obeyed until it is inconvenient and then quietly dropped.
 */
const EXT_SHIPPABILITY_VERIFY =
  'pnpm run lint:extensions:no-relative-outside-package && pnpm run lint:extensions:no-plugin-sdk-internal'

if (!REPO || UNITS.length === 0) {
  log('parallel-implement: need args.repoRoot and a non-empty args.units[] — nothing to do')
  return { error: 'missing repoRoot or units', units: UNITS.length }
}

const bashRule = WRAP
  ? `For ANY shell command you MUST wrap it EXACTLY as: ${WRAP} <safe|low|medium> "<cmd>" "<why>" "$(<cmd>)" (an enforce hook blocks unwrapped bash). Prefer Read/Edit/Write/Grep (native, no wrapper needed).`
  : 'Prefer Read/Edit/Write/Grep. Wrap shell commands per the repo conventions.'

// ── Phase 0 — inter-session contention pre-flight (#2). DEFAULT-ON. ──
// Spawns ONE read-only agent to inspect the tree (the runtime has no fs/child_process, so all git
// must run inside an agent). If any file this run will write already has UNCOMMITTED foreign WIP
// (or is under handsOffPaths), we WARN — and, unless allowForeignWip, force commit:false so the run
// applies but never sweeps another session's work into a commit.
const PREFLIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dirtyForeign', 'recentForeignCommits', 'branch'],
  properties: {
    dirtyForeign: { type: 'array', items: { type: 'string' }, description: 'which of the queried paths have UNCOMMITTED changes belonging to SOMEONE ELSE (not this session)' },
    dirtyOwn: { type: 'array', items: { type: 'string' }, description: 'queried paths dirty with THIS session\'s own recorded edits — contention with nobody, do not treat as a hazard' },
    ownershipSource: { type: 'string', description: 'ledger | porcelain — whether the split above came from the ownership ledger or from a bare dirty-check that cannot tell sessions apart' },
    recentForeignCommits: { type: 'array', items: { type: 'string' }, description: 'up to the last 5 commit subjects (to spot a parallel session)' },
    branch: { type: 'string', description: 'current branch name' },
  },
}

// The one shared implementation of "is this dirty file another session's" (see its module docstring).
// Optional; when unset the pre-flight falls back to a bare dirty-worktree check
// and says so via ownershipSource, so the degradation is visible rather than silent.
// OPTIONAL. A session-ownership pre-flight script. If absent, ORCA falls back to a plain
// dirty-worktree check (see below). Set ORCA_OWNERSHIP_SCRIPT to enable your own.
const OWNERSHIP = a.ownershipScript || process.env.ORCA_OWNERSHIP_SCRIPT || ''

let preflight = { dirtyForeign: [], dirtyOwn: [], ownershipSource: 'porcelain', recentForeignCommits: [], branch: '' }
let contention = { detected: false, foreignWipFiles: [], handsOffHits: [], forcedNoCommit: false, recentForeignCommits: [] }
const allWrites = [...new Set(UNITS.flatMap((u) => u.writes || []))]
phase('Preflight')
log(`Phase 0: read-only contention pre-flight over ${allWrites.length} write path(s)`)
// agent() returns NULL (it does not throw) when the subagent dies on a terminal API error such as
// "529 Overloaded" — so the catch below never fired and the null was dereferenced at
// `preflight.dirtyForeign`, killing the whole run before a single unit was drafted (2026-09-03,
// twice in a row). Retry the pre-flight up to 3× (each attempt already carries the harness's own
// backoff), and if it still returns nothing fall through to the no-contention-info default — the
// same degradation the catch branch already chose — loudly, never silently.
try {
  let preflightResult = null
  for (let attempt = 1; attempt <= 3 && !preflightResult; attempt++) {
    preflightResult = await agent([
    `Read-only git pre-flight in repo ${REPO}. Do NOT edit, write, or build ANYTHING.`,
    bashRule,
    `Run \`git -C ${REPO} log --oneline -5\` for the recent commits.`,
    // OWNERSHIP, NOT DIRTINESS. A bare porcelain check answers "is this file dirty?", but the
    // question is "is someone ELSE working on it?" — and the caller's own uncommitted edits from
    // earlier in the same session answer the first yes and the second no. Treating those as
    // contention forced commit:false on runs that had nothing to collide with.
    // The ledger (PostToolUse hook, ~/.openclaw/data/session-file-ownership.jsonl) records which
    // session touched which file, so the split is a lookup. ownership.py is the ONE implementation
    // of that rule — the same one guard-blanket-stage.sh and whose-file.sh use.
    `Ownership split, in this order:`,
    `  (a) FIRST TRY: \`python3 ${OWNERSHIP} foreign ${REPO} <each path>\` with all of these paths as arguments: ${JSON.stringify(allWrites)}`,
    `      It prints one TSV line per path that is NOT this session's: "<path>\\t<reason>", where reason is "session <id>" or "no record". Paths it does not print are this session's own.`,
    `      If that runs (exit 0, even with empty output): dirtyForeign = the printed paths; dirtyOwn = the queried paths that are dirty but NOT printed; ownershipSource = "ledger".`,
    `  (b) FALLBACK, only if that script is missing or errors: \`git -C ${REPO} status --porcelain -uall\`, dirtyForeign = the queried paths that appear dirty, dirtyOwn = [], ownershipSource = "porcelain".`,
    `Report as the StructuredOutput: dirtyForeign, dirtyOwn, ownershipSource, branch = the current branch name, and recentForeignCommits = the last up-to-5 commit subject lines (so the caller can spot a parallel session).`,
    `Do not guess ownership from mtimes, filenames, or what the changes look like. If you could not run (a), say so via ownershipSource rather than inferring.`,
    ].join('\n'), { label: attempt === 1 ? 'preflight' : `preflight-retry-${attempt}`, phase: 'Preflight', schema: PREFLIGHT_SCHEMA })
    if (!preflightResult) {
      log(`⚠️  Phase 0 pre-flight agent returned nothing (attempt ${attempt}/3 — API overloaded or the agent died); ${attempt < 3 ? 'retrying' : 'continuing WITHOUT contention info'}`)
    }
  }
  if (preflightResult && typeof preflightResult === 'object') preflight = preflightResult
} catch (e) {
  log(`Phase 0 pre-flight agent failed (continuing without contention info): ${String(e)}`)
}

// Pure-JS decision: foreign WIP on a path we will write, or any write under handsOffPaths.
const underHandsOff = (p) => HANDS_OFF.some((h) => p === h || p.startsWith(h.endsWith('/') ? h : h + '/'))
const foreignWipFiles = (preflight.dirtyForeign || []).filter((p) => allWrites.includes(p))
const handsOffHits = allWrites.filter(underHandsOff)
contention.recentForeignCommits = preflight.recentForeignCommits || []
if (foreignWipFiles.length || handsOffHits.length) {
  contention.detected = true
  contention.foreignWipFiles = foreignWipFiles
  contention.handsOffHits = handsOffHits
  log(`⚠️  CONTENTION on branch "${preflight.branch}": ` +
      (foreignWipFiles.length ? `foreign UNCOMMITTED WIP in files this run writes: [${foreignWipFiles.join(', ')}]. ` : '') +
      (handsOffHits.length ? `writes under handsOffPaths: [${handsOffHits.join(', ')}]. ` : ''))
  if (contention.recentForeignCommits.length) log(`⚠️  recent commits (watch for a parallel session): ${contention.recentForeignCommits.map((s) => '"' + s + '"').join(' | ')}`)
  if (DO_COMMIT && !ALLOW_FOREIGN_WIP) {
    if (WORKTREE) {
      // Worktree mode builds each commit off CLEAN HEAD and merges it back on commits only, with
      // STASH-PROTECTION for same-file foreign WIP (Phase C stashes exactly contention.foreignWipFiles
      // for the group, lands the clean commit, then restores their WIP from that snapshot commit.
      // NEVER refs/stash: it is ONE repo-wide stack, and parallel groups pop each other's entries.
      // So it can LAND the change without sweeping or reverting — no need to bail.
      log('ℹ️  worktree mode: same-file foreign WIP will be STASH-PROTECTED across merge-back (land clean commit, restore their WIP). Not bailing.')
    } else {
      DO_COMMIT = false
      contention.forcedNoCommit = true
      log('⚠️  FORCING commit:false (in-place mode would sweep foreign WIP). Re-run with worktreePerAgent:true (the default) to land it via snapshot-protected merge-back, or allowForeignWip:true to override.')
    }
  }
} else {
  const own = (preflight.dirtyOwn || []).filter((p) => allWrites.includes(p))
  log(`Phase 0 clear: no foreign WIP / handsOff hits on the ${allWrites.length} write path(s) (branch "${preflight.branch}", ownership from ${preflight.ownershipSource || 'porcelain'})` +
      (own.length ? ` — ${own.length} path(s) dirty with THIS session's own edits, which is not contention: [${own.join(', ')}]` : ''))
}
if ((preflight.ownershipSource || 'porcelain') !== 'ledger') {
  // Say it out loud. A pre-flight that cannot tell sessions apart still reports a clean-looking
  // verdict, and a clean-looking verdict from a blind check is exactly how a guard stops meaning
  // anything — the failure this whole mechanism exists to make impossible.
  log(`ℹ️  ownership ledger unavailable — contention was judged by dirtiness alone, which cannot tell YOUR uncommitted work from a parallel session's. Install the PostToolUse hook (scripts/session-guard/) to make this a lookup.`)
}

// ── Phase R — the CONDUCTOR: route each unit to the model measured best at its domain ──
// The runtime sandbox has no fs/child_process, so (like the pre-flight) this runs inside ONE
// agent that shells out to orca-conductor.mjs and hands the plan back as StructuredOutput.
// Fail-open by construction: any error leaves `routes` empty and every unit runs exactly as
// it did before routing existed. Routing must make ORCA smarter, never make it fragile.
const ROUTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'error', 'plans'],
  properties: {
    ok: { type: 'boolean', description: 'true iff the conductor produced a plan for every unit' },
    error: { type: 'string', description: 'why routing failed, or empty' },
    plans: {
      type: 'array',
      description: 'one entry per unit, copied VERBATIM from the conductor output. Empty when ok=false.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['unitId', 'domain', 'mode', 'model', 'why'],
        properties: {
          unitId: { type: 'string' },
          domain: { type: 'string' },
          mode: { type: 'string', description: 'solo | debate | build-debug' },
          model: { type: 'string', description: 'the LEAD worker id, e.g. claude-code/claude-opus-5' },
          critic: { type: 'string', description: 'build-debug reviewer id, or empty' },
          panel: { type: 'array', items: { type: 'string' }, description: 'debate panelist ids, or empty' },
          aggregator: { type: 'string', description: 'debate synthesiser id, or empty' },
          why: { type: 'string', description: 'the one-line justification, copied verbatim' },
        },
      },
    },
  },
}

const routes = new Map()
let routePlan = null
if (QUALITY !== 'off') {
  phase('Route')
  log(`Phase R: routing ${UNITS.length} units through the conductor (tier: ${QUALITY})`)
  try {
    routePlan = await agent([
      `You are PHASE R (the CONDUCTOR) of an ORCA run. You do NOT read or edit repo code in this phase.`,
      bashRule,
      `Do EXACTLY this:`,
      `1. Write this JSON to /tmp/orca-units.json VERBATIM (it is the unit list to route):`,
      JSON.stringify(UNITS.map((u) => ({ id: u.id, task: u.task, domain: u.domain || undefined }))),
      `2. Run: node ${CONDUCTOR} plan --units /tmp/orca-units.json --quality ${QUALITY}${CROSS_PROVIDER ? '' : ' --anthropic-only'} --run "orca-$(date +%s)"`,
      `   (the --run id groups this turn's routing calls so the Tinker ORCA panel can narrate them; the workflow runtime has no clock, which is why YOU stamp it)`,
      `3. Return its \`plans\` array VERBATIM as the StructuredOutput (ok=true). Copy each field exactly — do NOT re-decide the routing, re-word the \`why\`, or substitute models you prefer. You are a transport, not a judge.`,
      `If the conductor script is missing or errors, return ok=false with the error text and plans=[] — the run will fall back to un-routed defaults. Do NOT invent a plan.`,
    ].join('\n'), { label: 'conductor', phase: 'Route', schema: ROUTE_SCHEMA })
  } catch (e) {
    routePlan = { ok: false, error: String(e), plans: [] }
  }
  if (routePlan && routePlan.ok && Array.isArray(routePlan.plans)) {
    for (const p of routePlan.plans) routes.set(p.unitId, p)
    const modes = {}
    for (const p of routePlan.plans) modes[p.mode] = (modes[p.mode] || 0) + 1
    log(`Phase R: ${routes.size}/${UNITS.length} units routed — ${Object.entries(modes).map(([m, n]) => `${n} ${m}`).join(', ')}`)
    for (const p of routePlan.plans) log(`  · ${p.unitId} [${p.domain}] → ${p.mode}: ${p.why}`)
  } else {
    log(`Phase R: routing unavailable (${routePlan ? routePlan.error : 'no result'}) — every unit falls back to the session default`)
  }
}

/** The Workflow tool spawns CLAUDE subagents, so agent({model}) only accepts Anthropic ids.
 *  Strip the provider namespace for those; return null for anyone else (they are reached via
 *  the gateway spawn CLI from inside the agent instead). */
function claudeModelFor(unitId) {
  const p = routes.get(unitId)
  if (!p || !p.model || !p.model.startsWith('claude-code/')) return null
  return p.model.replace(/^claude-code\//, '')
}

/** The routing directive injected into a unit's draft prompt. For solo units this is just
 *  context. For debate / build-debug it is the actual instruction to convene other providers
 *  — the composition Fugu found to be worth more than raw single-model strength. */
function routingDirective(u) {
  const p = routes.get(u.id)
  if (!p) return ''
  const head = `ROUTING (conductor): domain=${p.domain}, mode=${p.mode}. ${p.why}`
  if (p.mode === 'solo' || !CROSS_PROVIDER) return head
  const spawn = (model, task, label) =>
    `node ${SPAWN_CLI} --task ${JSON.stringify(task)} --label ${JSON.stringify(label)} --model ${model} --json`

  if (p.mode === 'build-debug' && p.critic) {
    return [
      head,
      `You are the BUILDER. After you have drafted the patch — and BEFORE you return it — get it reviewed by a DIFFERENT provider, which is the whole point: a model is a poor judge of its own blind spots.`,
      `Run: ${spawn(p.critic, `Review this proposed patch for correctness bugs, missed edge cases and wrong assumptions. Be adversarial and specific — quote the exact line you object to. Do NOT rewrite it; list defects only. Write your review to /tmp/orca-review-${u.id}.md and finish.`, `critic:${u.id}`)}`,
      `Then poll for the review (it is a separate process): \`for i in $(seq 1 60); do [ -s /tmp/orca-review-${u.id}.md ] && break; sleep 5; done\`, read it, and REVISE your patch for every defect you agree is real. In \`summary\`, say what the critic caught and what you rejected and why.`,
      `If the spawn or the wait fails, return your own patch and note the review was UNAVAILABLE — never block the run on it.`,
    ].join('\n')
  }

  if (p.mode === 'debate' && Array.isArray(p.panel) && p.panel.length) {
    const others = p.panel.filter((m) => !m.startsWith('claude-code/'))
    if (!others.length) return head
    return [
      head,
      `This unit is CONTESTED — no single provider is measurably ahead — so it gets independent answers from other houses before you commit to one.`,
      `Draft YOUR OWN patch first, unaided. Then convene the panel (they must NOT see each other's work, or the debate collapses into the first answer):`,
      ...others.map((m, i) => `  ${spawn(m, `Independently propose the exact edit for this task, then stop. Task: ${u.task}. Repo root: ${REPO}. Files you may propose edits to: ${JSON.stringify(u.writes || [])}. Read what you need, quote the exact before/after text. Write your proposal to /tmp/orca-panel-${u.id}-${i}.md and finish.`, `panel:${u.id}:${i}`)}`),
      `Wait for them: \`for i in $(seq 1 72); do ls /tmp/orca-panel-${u.id}-*.md >/dev/null 2>&1 && break; sleep 5; done\`, then read every proposal.`,
      `YOU are the aggregator (the conductor picked ${p.aggregator || p.model} for this domain). Do NOT average the answers and do NOT defer to the majority — take the strongest reasoning wherever it appears, and where they disagree, go back to the code and settle it. In \`summary\`, name what each panelist contributed and what you discarded.`,
      `If panelists fail to report, proceed with your own patch and note the panel was UNAVAILABLE.`,
    ].join('\n')
  }
  return head
}


// ── Phase A — draft an exact patch per unit, in parallel, holding NO lease ──
const PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['unitId', 'blocked', 'blockReason', 'summary', 'patches'],
  properties: {
    unitId: { type: 'string' },
    blocked: { type: 'boolean', description: 'true if you cannot safely draft a patch (missing context, ambiguous, file not found)' },
    blockReason: { type: 'string', description: 'why blocked, or empty' },
    summary: { type: 'string', description: 'one line: what the patch does' },
    patches: {
      type: 'array',
      description: 'the exact edits, one per hunk. Empty if blocked.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'isNewFile', 'find', 'replace'],
        properties: {
          file: { type: 'string', description: 'path relative to repoRoot' },
          isNewFile: { type: 'boolean' },
          find: { type: 'string', description: 'EXACT existing text to replace (unique in the file). Empty when isNewFile.' },
          replace: { type: 'string', description: 'replacement text (the FULL file content when isNewFile)' },
        },
      },
    },
  },
}

const draftPrompt = (u) => [
  `You are PHASE A of a lease-based parallel coding run. Repo root: ${REPO}.`,
  `READ-ONLY in this phase — do NOT edit/write/build. Use ONLY Read / Grep / Glob (native tools).`,
  bashRule,
  `Your job: read enough to draft the EXACT patch for this edit-unit, then return it as the StructuredOutput. Do NOT apply it.`,
  `Each patch hunk is an Edit: a UNIQUE \`find\` string that exists verbatim in the file + its \`replace\`. For a brand-new file set isNewFile=true, find="", replace=FULL content.`,
  `The \`find\` MUST be copied verbatim from the current file (include enough surrounding lines to be unique). If you cannot make it unique/safe, set blocked=true with a reason.`,
  `Only touch the files this unit is allowed to write: ${JSON.stringify(u.writes || [])}.`,
  `If this unit adds a function/module with a fast, self-contained test harness available, include a minimal behavioral test in your patch (an extra hunk in this unit's allowed files). Doc nudge, not required.`,
  DOC_REQUIREMENT,
  ``,
  MECHANISM_REQUIREMENT,
  ``,
  VERIFICATION_DISCIPLINE,
  ...(touchesExtensions(u) ? [``, SHIPPABILITY_REQUIREMENT] : []),
  ...(touchesHmr(u)
    ? [
        ``,
        `UI QUIESCENCE (draft side): ${JSON.stringify(hmrFilesOf(u))} are watched by a LIVE dev server that reloads the architect's open page on every write. The apply phase will land ALL of your hunks as a single burst, from a staging copy — so draft accordingly: the file must be COHERENT once your hunks are applied TOGETHER. Do not lean on an intermediate state being valid, do not split one file's change across two units, and do not leave a symbol that only a LATER unit defines. A patch that only compiles halfway through is a patch that cannot be landed quietly.`,
      ]
    : []),
  ``,
  routingDirective(u),
  ``,
  `UNIT ${u.id}: ${u.task}`,
].join('\n')

// Say it out loud: a run that quietly reloads someone's UI 40 times looks identical in the log to
// one that reloads it once. Name the units and the mechanism so the difference is visible.
const hmrUnits = UNITS.filter(touchesHmr)
if (hmrUnits.length) {
  log(`ℹ️  UI QUIESCENCE: ${hmrUnits.length}/${UNITS.length} unit(s) write dev-server-WATCHED files ` +
      `[${[...new Set(hmrUnits.flatMap(hmrFilesOf))].join(', ')}] — ` +
      (WORKTREE
        ? `worktree mode: edits are invisible to the watcher, the UI changes ONCE at merge-back.`
        : `in-place mode: apply agents will stage under /tmp/orca-ui-stage-<unit> and land each unit in one burst.`))
}

phase('Draft')
log(`Phase A: drafting ${UNITS.length} patches in parallel (no leases held)`)
const drafts = await parallel(UNITS.map((u) => () =>
  agent(draftPrompt(u), {
    label: `draft:${u.id}`,
    phase: 'Draft',
    schema: PATCH_SCHEMA,
    // The conductor's lead worker, when it is an Anthropic model this runtime can spawn.
    // Non-Anthropic leads keep the default model here and reach their provider through the
    // gateway spawn CLI in routingDirective().
    ...(claudeModelFor(u.id) ? { model: claudeModelFor(u.id) } : {}),
  })
    .then((r) => ({ unit: u, patch: r }))
    .catch((e) => ({ unit: u, patch: { unitId: u.id, blocked: true, blockReason: String(e), summary: '', patches: [] } }))
))

const ready = drafts.filter((d) => d && d.patch && !d.patch.blocked && (d.patch.patches || []).length > 0)
const blocked = drafts.filter((d) => d && (!d.patch || d.patch.blocked || (d.patch.patches || []).length === 0))
for (const b of blocked) log(`Phase A blocked: ${b.unit.id} — ${b.patch ? b.patch.blockReason || 'no patch produced' : 'agent failed'}`)
log(`Phase A done: ${ready.length} ready, ${blocked.length} blocked`)

// ── Phase B — apply patches, per-file lease-serialized, with fast handoff ──
const APPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['unitId', 'applied', 'filesChanged', 'reDerived', 'verify', 'notes'],
  properties: {
    unitId: { type: 'string' },
    applied: { type: 'boolean' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    reDerived: { type: 'boolean', description: 'true if the prepared patch was stale and you re-derived it from the task' },
    verify: { type: 'string', description: 'verify result for the changed file(s), or UNVERIFIED' },
    notes: { type: 'string' },
  },
}

// ── Worktree-per-agent hybrid (#1b) — file-overlap grouping. PURE function (Task 6). ──
// Two units are in the same group iff their `writes` sets intersect (union-find over file overlap).
// A 1-unit group whose files no other unit touches is a "disjoint" group (own worktree off clean
// HEAD); a multi-unit group shares ≥1 file and serializes onto one shared worktree/branch.
function groupByOverlap(units) {
  const n = units.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  const union = (x, y) => { const rx = find(x), ry = find(y); if (rx !== ry) parent[rx] = ry }
  // Map each file to the first unit index that writes it; union on collision.
  const firstWriter = new Map()
  for (let i = 0; i < n; i++) {
    for (const f of (units[i].writes || [])) {
      if (firstWriter.has(f)) union(i, firstWriter.get(f))
      else firstWriter.set(f, i)
    }
  }
  const byRoot = new Map()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    if (!byRoot.has(r)) byRoot.set(r, [])
    byRoot.get(r).push(units[i])
  }
  return [...byRoot.values()].map((groupUnits, gi) => {
    const files = [...new Set(groupUnits.flatMap((u) => u.writes || []))]
    return { id: `g${gi}`, units: groupUnits, files, disjoint: groupUnits.length === 1 }
  })
}

// Worktree apply agent returns each unit's apply result + (when committing) the branch/SHA it left
// inside the worktree, so Phase C can fast-forward / cherry-pick it back.
const WT_APPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['groupId', 'worktreePath', 'branch', 'units', 'notes'],
  properties: {
    groupId: { type: 'string' },
    worktreePath: { type: 'string', description: 'absolute path of the worktree you created (or empty if you could not)' },
    branch: { type: 'string', description: 'the branch name you committed onto inside the worktree (empty if commit:false or nothing committed)' },
    units: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['unitId', 'applied', 'filesChanged', 'reDerived', 'committed', 'sha', 'subject', 'verify', 'notes'],
        properties: {
          unitId: { type: 'string' },
          applied: { type: 'boolean' },
          filesChanged: { type: 'array', items: { type: 'string' } },
          reDerived: { type: 'boolean' },
          committed: { type: 'boolean' },
          sha: { type: 'string', description: 'short SHA of this unit\'s commit inside the worktree, or empty' },
          subject: { type: 'string' },
          verify: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
    notes: { type: 'string' },
  },
}

// Phase C merge-back (worktree mode): fast-forward / cherry-pick a group's branch onto the working branch.
const WT_MERGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['groupId', 'merged', 'shas', 'conflict', 'stashedForeign', 'stashSnapshot', 'notes'],
  properties: {
    groupId: { type: 'string' },
    merged: { type: 'boolean', description: 'true iff the branch was fast-forwarded / cherry-picked onto the working branch cleanly' },
    shas: { type: 'array', items: { type: 'string' }, description: 'the commit SHAs now on the working branch from this group' },
    conflict: { type: 'boolean', description: 'true if a real conflict forced an abort (never force)' },
    stashedForeign: { type: 'array', items: { type: 'string' }, description: 'foreign-WIP files snapshotted across the merge-back and restored from the snapshot commit after (empty if none)' },
    stashSnapshot: { type: 'string', description: 'sha from `git stash create` protecting this group\'s foreign WIP, or "" — recover with `git checkout <sha> -- <files>`. NEVER refs/stash: that stack is repo-wide and races across parallel groups.' },
    notes: { type: 'string' },
  },
}

const applyPrompt = (u, patch) => [
  `You are PHASE B of a lease-based parallel coding run. Repo root: ${REPO}. You hold the file lease for: ${JSON.stringify(u.writes || [])} — apply FAST, then this releases.`,
  bashRule,
  `Apply this PREPARED patch (drafted in Phase A). Each hunk: Edit with old_string=find, new_string=replace (or Write the full content when isNewFile).`,
  ...(touchesHmr(u) ? [``, uiQuiescenceApply(u), ``] : []),
  `STALENESS GUARD: before each hunk, confirm \`find\` still exists verbatim in the file${touchesHmr(u) ? ' (in your STAGED copy — which you copied from the repo moments ago, so it reflects the current file)' : ''}. If it does NOT (the file changed since drafting), DO NOT force it — RE-READ the file and re-apply the SAME INTENT (the unit task below) correctly, and set reDerived=true.`,
  `After applying, VERIFY: ${VERIFY}.${WRAP ? ' Run the verify command via the wrapper form shown above (NEVER emit it unwrapped — the enforce hook will block it).' : ''}`,
  ...(touchesExtensions(u)
    ? [
        `SHIPPABILITY GATE (this unit writes under extensions/**, which is ClawHub-shippable surface) — ALSO run: ${EXT_SHIPPABILITY_VERIFY}`,
        `If it fails on a file THIS unit touched, the patch is not shippable: a relative reach into fork core resolves here and breaks on a vanilla OpenClaw install. Fix it to import via \`openclaw/plugin-sdk/<name>\`, or set verified=false and say the subpath is missing. Pre-existing failures in files this unit did NOT touch are NOT yours — report them in notes and move on.`,
      ]
    : []),
  `Do NOT commit or run any git command — a separate serialized step (Phase C) commits this unit. Just apply + verify.`,
  `PREPARED PATCH (JSON): ${JSON.stringify(patch.patches)}`,
  `UNIT ${u.id} INTENT: ${u.task}`,
  `Return the StructuredOutput (applied / filesChanged / reDerived / verify / notes).`,
].join('\n')

// Worktree-mode apply prompt (Tasks 7-8): the agent runs in an ISOLATED worktree off clean HEAD.
// It applies every unit in this group (serialized within the group if they share files) and — when
// committing — commits each unit on a per-unit branch INSIDE the worktree, off clean HEAD, so the
// commit can later be fast-forwarded / cherry-picked back without touching the base tree's foreign WIP.
const wtApplyPrompt = (g, ds, wtPath) => [
  `You are PHASE B of a WORKTREE-PER-AGENT parallel coding run, group ${g.id}.`,
  bashRule,
  `STEP 1 — create your OWN git worktree of the TARGET repo (${REPO}), on a fresh branch at the repo's CURRENT committed HEAD (clean — no foreign WIP):`,
  `  \`git -C ${REPO} worktree add ${wtPath} -B orca/${g.id} HEAD\``,
  `If ${wtPath} or branch orca/${g.id} already exists from a stale run, remove it first (\`git -C ${REPO} worktree remove --force ${wtPath}\`; \`git -C ${REPO} branch -D orca/${g.id}\`) then retry. This worktree is YOURS alone.`,
  `STEP 2 — ALL of this group's file edits AND git commands happen INSIDE ${wtPath}: edit files at \`${wtPath}/<relpath>\` and run git as \`git -C ${wtPath} ...\`. Do NOT edit anything under ${REPO} directly (it may hold another session's uncommitted WIP).`,
  `Apply the prepared patch(es) for ${ds.length} unit(s). ${g.disjoint ? 'DISJOINT group (one unit, files no other group touches).' : 'OVERLAP group (units share ≥1 file) — apply the units in the listed order, SERIALLY, re-reading between units.'}`,
  `Each hunk: Edit with old_string=find, new_string=replace (or Write the full content when isNewFile) — on the file UNDER ${wtPath}.`,
  `STALENESS GUARD: before each hunk, confirm \`find\` still exists verbatim. If not, RE-READ and re-apply the SAME INTENT correctly, set reDerived=true for that unit.`,
  `After applying a unit, VERIFY: ${VERIFY}.${WRAP ? ' Run verify via the wrapper form shown above.' : ''}`,
  ...(ds.some((d) => touchesExtensions(d.unit))
    ? [
        `SHIPPABILITY GATE (a unit in this group writes under extensions/**, ClawHub-shippable surface) — ALSO run inside the worktree: ${EXT_SHIPPABILITY_VERIFY}`,
        `A relative reach into fork core resolves in this tree and breaks on a vanilla OpenClaw install, so it cannot be caught later. Fix to \`openclaw/plugin-sdk/<name>\` or report verified=false. Pre-existing failures in untouched files are not yours.`,
      ]
    : []),
  ...(ds.some((d) => touchesHmr(d.unit))
    ? [
        `UI QUIESCENCE — already satisfied by construction here, and it is YOUR job not to break it. This group writes files a LIVE dev server watches (${JSON.stringify([...new Set(ds.flatMap((d) => hmrFilesOf(d.unit)))])}) and would reload the architect's open page on every write — but you are editing them at ${wtPath}/<relpath>, which no watcher is looking at. So:`,
        `  • NEVER touch ${REPO}/<relpath> for those files — not to peek, not to "just fix one thing", not to copy something over early. Every edit and every verify stays inside ${wtPath}.`,
        `  • Do NOT run a UI build, \`vite build\`, or a dev-server restart against ${REPO}. If a build is needed, build inside ${wtPath}.`,
        `  The architect's UI must stay on the OLD coherent state for this whole phase and change exactly ONCE, at the Phase-C merge-back.`,
      ]
    : []),
  DO_COMMIT
    ? [`COMMIT each unit on the worktree's branch orca/${g.id} (already checked out in ${wtPath}), one commit per unit, in order:`,
       `  • Stage ONLY that unit's files: \`git -C ${wtPath} add -- <that unit's writes>\`. NEVER \`git add -A\`/\`git add .\`.`,
       `  • Commit in the worktree: \`git -C ${wtPath} commit\` per the rules below.`,
       `  • Report branch="orca/${g.id}", worktreePath="${wtPath}", and each unit's short SHA in its \`sha\`.`,
       ``, COMMIT_RULES].join('\n')
    : `Do NOT commit (commit:false) — just apply + verify inside ${wtPath}, leave it dirty, set committed=false / sha="" / branch="" for each unit.`,
  ``,
  `GROUP UNITS (apply in this order):`,
  ...ds.map((d, i) => `  [${i + 1}] UNIT ${d.unit.id} — writes ${JSON.stringify(d.unit.writes || [])} — INTENT: ${d.unit.task}\n      PREPARED PATCH (JSON): ${JSON.stringify(d.patch.patches)}`),
  ``,
  `Return the StructuredOutput: groupId="${g.id}", worktreePath="${wtPath}", branch ("orca/${g.id}" if you committed, else ""), and a units[] entry per unit (unitId/applied/filesChanged/reDerived/committed/sha/subject/verify/notes).`,
].join('\n')

// Both execution models converge on the same `applied` / `failed` arrays of {d, result} so the
// integration verify, Phase C, and the return value below are shared. `worktreeGroups` is only
// populated in worktree mode and drives the Phase-C merge-back.
let applied = []
let failed = []
let worktreeGroups = []     // [{ id, branch, units, disjoint, files }] — worktree mode only

if (!WORKTREE) {
  // ════════ DEFAULT: in-place lease-based Phase B (UNCHANGED behavior) ════════
  phase('Apply')
  log('Phase B: applying patches with per-file lease dispatch (disjoint files concurrent, shared files serialized)')

  const held = new Set()                 // files currently leased
  const state = ready.map((d) => ({ d, done: false, result: null }))
  const fileOf = (s) => (s.d.unit.writes || [])

  async function runOne(s) {
    // Lease-acquire runs SYNCHRONOUSLY (before the first await), so a same-file unit checked later
    // in the same dispatch pass already sees these files as held → it can't double-dispatch.
    fileOf(s).forEach((f) => held.add(f))
    log(`lease ACQUIRE ${s.d.unit.id} → [${fileOf(s).join(', ')}]`)
    try {
      s.result = await agent(applyPrompt(s.d.unit, s.d.patch), { label: `apply:${s.d.unit.id}`, phase: 'Apply', schema: APPLY_SCHEMA })
    } catch (e) {
      s.result = { unitId: s.d.unit.id, applied: false, filesChanged: [], reDerived: false, verify: 'ERROR', notes: String(e) }
    } finally {
      fileOf(s).forEach((f) => held.delete(f))
      s.done = true
      log(`lease RELEASE ${s.d.unit.id} (${s.result && s.result.applied ? 'applied' : 'failed'})`)
    }
  }

  // Greedy async lease dispatcher: dispatch every unit whose files are all free; when one finishes
  // and releases its lease, newly-unblocked units dispatch on the next loop turn (fast handoff).
  const inflight = new Map() // state → promise
  while (state.some((s) => !s.done) || inflight.size > 0) {
    for (const s of state) {
      if (s.done || inflight.has(s)) continue
      if (fileOf(s).some((f) => held.has(f))) continue      // blocked: a file is leased
      const p = runOne(s).finally(() => inflight.delete(s))
      inflight.set(s, p)
    }
    if (inflight.size === 0) {
      // Nothing dispatchable and nothing running → would deadlock (shouldn't happen — leases always release).
      const stuck = state.filter((s) => !s.done).map((s) => s.d.unit.id)
      if (stuck.length) log(`dispatcher stuck (no free units, none inflight): ${stuck.join(', ')}`)
      break
    }
    await Promise.race(inflight.values())
  }

  applied = state.filter((s) => s.result && s.result.applied)
  failed = state.filter((s) => !s.result || !s.result.applied)
  log(`Phase B done: ${applied.length} applied, ${failed.length} failed, ${blocked.length} never-drafted`)
} else {
  // ════════ OPT-IN: worktree-per-agent hybrid Phase B (Tasks 6-8) ════════
  // Group by file overlap; run each group's apply agent in an isolated worktree off clean HEAD;
  // commit each unit on a per-unit branch INSIDE the worktree (so `git add -- <writes>` is clean).
  phase('Apply')
  const readyUnits = ready.map((d) => d.unit)
  const groups = groupByOverlap(readyUnits)
  const draftByUnit = new Map(ready.map((d) => [d.unit.id, d]))           // unitId → {unit, patch}
  const disjoint = groups.filter((g) => g.disjoint)
  const overlap = groups.filter((g) => !g.disjoint)
  log(`Phase B (worktree mode): ${groups.length} group(s) → ${disjoint.length} disjoint, ${overlap.length} overlap; ` +
      groups.map((g) => `${g.id}{${g.units.map((u) => u.id).join('+')}}`).join(' '))

  // One agent per group. The agent itself creates a worktree OF THE TARGET REPO at a deterministic
  // path (NOT the Agent-tool `isolation:'worktree'`, which worktrees the SESSION repo, not repoRoot).
  const wtPathFor = (g) => `${REPO}__orca_wt__${g.id}`
  const runGroup = (g) => agent(
    wtApplyPrompt(g, g.units.map((u) => draftByUnit.get(u.id)), wtPathFor(g)),
    { label: `worktree:${g.id}`, phase: 'Apply', schema: WT_APPLY_SCHEMA },
  ).catch((e) => ({
    groupId: g.id, worktreePath: '', branch: '',
    units: g.units.map((u) => ({ unitId: u.id, applied: false, filesChanged: [], reDerived: false, committed: false, sha: '', subject: '', verify: 'ERROR', notes: String(e) })),
    notes: 'worktree apply agent failed: ' + String(e),
  }))

  // Disjoint groups run concurrently (separate worktrees never collide); overlap groups also each
  // get their OWN worktree but serialize the units WITHIN the group (the agent does that in-tree).
  const groupResults = await parallel(groups.map((g) => () => runGroup(g).then((r) => ({ g, r }))))

  for (const { g, r } of groupResults) {
    worktreeGroups.push({ id: g.id, branch: r.branch || '', worktreePath: wtPathFor(g), disjoint: g.disjoint, files: g.files, units: r.units || [] })
    for (const ur of (r.units || [])) {
      const unit = g.units.find((u) => u.id === ur.unitId) || g.units[0]
      const d = draftByUnit.get(ur.unitId) || { unit, patch: { summary: '' } }
      // Map the worktree unit result onto the shared {d, result} shape (carry the in-worktree commit).
      const slot = { d, result: { unitId: ur.unitId, applied: ur.applied, filesChanged: ur.filesChanged || [], reDerived: ur.reDerived, verify: ur.verify, notes: ur.notes, committed: ur.committed, sha: ur.sha, subject: ur.subject } }
      if (ur.applied) applied.push(slot); else failed.push(slot)
    }
  }
  log(`Phase B (worktree mode) done: ${applied.length} applied across ${groups.length} group(s), ${failed.length} failed, ${blocked.length} never-drafted`)
}

// ── Integration verify (#4) — run the authoritative whole-tree check ONCE, after all applies. ──
// Phase-B per-file verify gives fast per-unit feedback; this is the single final gate (e.g. a full
// typecheck/bundle) instead of every Phase-B agent re-running a whole-project check.
const INTEGRATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['passed', 'output', 'notes'],
  properties: {
    passed: { type: 'boolean', description: 'true iff the integration command exited 0 / reported success' },
    output: { type: 'string', description: 'the tail of the command output (errors first if it failed)' },
    notes: { type: 'string' },
  },
}
let integration = null
async function runIntegrationVerify() {
  log(`Integration verify: running once across the changed tree → ${INTEGRATION_VERIFY}`)
  try {
    integration = await agent([
      `You are the INTEGRATION VERIFY step of a parallel coding run. Repo root: ${REPO}.`,
      bashRule,
      `Run this command ONCE across the whole changed tree and report whether it passed: ${INTEGRATION_VERIFY}`,
      `Do NOT edit, fix, or commit anything — just run it and report. Return the StructuredOutput (passed / output / notes); put the tail of the output (errors first if it failed) in \`output\`.`,
    ].join('\n'), { label: 'integration-verify', phase: 'Verify', schema: INTEGRATION_SCHEMA })
    log(`Integration verify: ${integration.passed ? 'PASS' : 'FAIL'}${integration.passed ? '' : ' — ' + (integration.notes || integration.output || '').slice(0, 200)}`)
  } catch (e) {
    integration = { passed: false, output: '', notes: 'integration-verify agent failed: ' + String(e) }
    log(`Integration verify agent failed: ${String(e)}`)
  }
}
// In-place mode: verify now (the changes are already in the base tree). Worktree mode: defer the
// integration verify until AFTER merge-back (the base tree has no changes yet), see Phase C below.
if (INTEGRATION_VERIFY && applied.length && !WORKTREE) {
  phase('Verify')
  await runIntegrationVerify()
}

// ── Phase C — commit each applied unit as its OWN commit, SERIALIZED ──
// Apply ran in parallel, but git's index/HEAD is a single shared resource: concurrent commits
// would race (index.lock, interleaved staging). So Phase C runs one commit at a time, and each
// commit stages ONLY its unit's files — never `git add -A` — so a parallel session's WIP is safe.
const COMMIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['unitId', 'committed', 'sha', 'subject', 'notes'],
  properties: {
    unitId: { type: 'string' },
    committed: { type: 'boolean' },
    sha: { type: 'string', description: 'short SHA of the new commit, or empty' },
    subject: { type: 'string', description: 'the commit subject line you used' },
    notes: { type: 'string' },
  },
}
const commitPrompt = (u, result) => [
  `You are PHASE C of a lease-based parallel coding run. Repo root: ${REPO}. Commit EXACTLY ONE unit, then stop.`,
  bashRule,
  `The unit's files are already edited + verified in the working tree. Stage ONLY this unit's files and make ONE commit.`,
  `Files this unit changed: ${JSON.stringify(result.filesChanged && result.filesChanged.length ? result.filesChanged : (u.writes || []))}.`,
  result.reDerived ? `NOTE: this unit's patch was re-derived from stale context during apply — reflect the ACTUAL change in the message.` : ``,
  ``,
  COMMIT_RULES,
  ``,
  `UNIT ${u.id} INTENT (use for the WHY): ${u.task}`,
  `Return the StructuredOutput (unitId / committed / sha / subject / notes).`,
].filter(Boolean).join('\n')

const committed = []
const mergedGroups = []     // worktree mode: [{ groupId, branch, merged, shas, conflict, notes }]
if (!WORKTREE) {
  // ════════ DEFAULT in-place Phase C — commit each applied unit, serialized (UNCHANGED) ════════
  if (DO_COMMIT && applied.length) {
    phase('Commit')
    log(`Phase C: committing ${applied.length} applied unit(s) — serialized, one commit each (fast committing)`)
    for (const s of applied) {                 // serial: one git commit at a time, no index race
      let r
      try {
        r = await agent(commitPrompt(s.d.unit, s.result), { label: `commit:${s.d.unit.id}`, phase: 'Commit', schema: COMMIT_SCHEMA })
      } catch (e) {
        r = { unitId: s.d.unit.id, committed: false, sha: '', subject: '', notes: String(e) }
      }
      committed.push(r)
      log(`commit ${s.d.unit.id}: ${r.committed ? r.sha + ' ' + r.subject : 'FAILED — ' + (r.notes || 'no result')}`)
    }
  } else if (!DO_COMMIT) {
    log(`Phase C skipped (commit:false${contention.forcedNoCommit ? ' — FORCED by contention pre-flight' : ''}) — applied changes left staged/unstaged in the working tree`)
  }
} else {
  // ════════ WORKTREE mode Phase C — merge each group's branch back onto the working branch (Task 8) ════════
  // Units were already committed INSIDE their worktrees off clean HEAD. Here we fast-forward /
  // cherry-pick each group's branch onto the working branch, SERIALLY (one HEAD update at a time).
  // The base tree's uncommitted foreign WIP is left alone (git operates on commits); a real conflict
  // ABORTS that group's merge and is reported — never force. Then prune the worktrees.
  const branchGroups = worktreeGroups.filter((g) => g.branch)
  if (DO_COMMIT && branchGroups.length) {
    phase('Commit')
    log(`Phase C (worktree mode): merging ${branchGroups.length} group branch(es) back onto the working branch — serialized`)
    for (const g of branchGroups) {            // serial: one HEAD update at a time, no ref race
      // Same-file foreign WIP among THIS group's files → git refuses to merge/cherry-pick into them,
      // so the agent stashes exactly these, lands the commit, then pops to restore the foreign WIP.
      const gForeign = (contention.foreignWipFiles || []).filter((f) => (g.files || []).includes(f))
      // The watched files in this group: merging them IS the moment the architect's open UI reloads.
      const gHmr = (g.files || []).filter((f) => HMR_PATHS.some((h) => normPath(f).startsWith(normPath(h))))
      let r
      try {
        r = await agent([
          `You are PHASE C (merge-back) of a worktree-per-agent run. Operate ONLY on the TARGET repo ${REPO} (its MAIN working tree) — ALWAYS use \`git -C ${REPO} ...\`. Do NOT run git in your current directory (that is a different repo).`,
          bashRule,
          `Group ${g.id} committed its unit(s) on branch \`${g.branch}\` (in a worktree at ${g.worktreePath}) off ${REPO}'s clean HEAD; files touched: ${JSON.stringify(g.files)}.`,
          gForeign.length
            ? `⚠️ SAME-FILE FOREIGN WIP: a parallel session holds UNCOMMITTED changes in these of this group's files: ${JSON.stringify(gForeign)}. git REFUSES to merge/cherry-pick into a file with local changes, so you MUST stash-protect them (their edits are on disjoint lines and auto-restore on pop).`
            : `No same-file foreign WIP for this group's files.`,
          ...(gHmr.length
            ? [`UI QUIESCENCE: this merge lands files a LIVE dev server watches (${JSON.stringify(gHmr)}). Until now the architect's open page has been showing the OLD coherent state; this merge is the ONE moment it reloads, and it must arrive complete. So run the integration below back-to-back and STOP: no build, no verification pass, no extra checkout, no second thought that touches those files between the merge landing and the end of your turn. Nothing that lands the change in two visible steps. If a stash-pop conflict leaves markers in a watched file, say so LOUDLY in \`notes\` — those markers get served to his browser, so a quiet report is worse than a failure.`]
            : []),
          `Integrate branch \`${g.branch}\` onto ${REPO}'s CURRENT working branch, SAFELY:`,
          gForeign.length
            ? `  0. SNAPSHOT the foreign WIP — NEVER \`git stash push\`/\`pop\`. \`refs/stash\` is ONE repository-wide stack shared by every worktree and every parallel group, and a bare \`git stash pop\` takes stash@{0} = whichever group pushed LAST. On 2026-08-29 that race made groups pop each other's entries and stranded ~5,700 lines of peer work uncommitted (two surviving stashes literally read "wrongly popped ... by a shared-stash-stack race"). Instead: \`SNAP=$(git -C ${REPO} stash create "orca-protect ${g.id}")\` — \`stash create\` writes a DANGLING COMMIT and does NOT touch refs/stash, so groups cannot collide. Echo SNAP and put it in \`stashSnapshot\`. If SNAP is EMPTY nothing needed saving → set stashedForeign=[] and skip step 4. Then clear ONLY this group's files so the merge can apply: \`git -C ${REPO} checkout -- ${gForeign.join(' ')}\`.`
            : `  0. (no same-file foreign WIP → no snapshot needed; set stashedForeign=[] and stashSnapshot="")`,
          `  1. Try fast-forward: \`git -C ${REPO} merge --ff-only ${g.branch}\`.`,
          `  2. If ff is rejected (HEAD already advanced from an earlier group), cherry-pick exactly this branch's commits: \`git -C ${REPO} cherry-pick "$(git -C ${REPO} merge-base HEAD ${g.branch})..${g.branch}"\` (they touch only ${JSON.stringify(g.files)}, so disjoint groups apply cleanly even with unrelated foreign WIP in the tree).`,
          `  3. NEVER use --force. On a REAL merge/cherry-pick conflict: abort (\`git -C ${REPO} cherry-pick --abort\` or \`git -C ${REPO} merge --abort\`); THEN if you stashed in step 0, restore it from the snapshot (\`git -C ${REPO} checkout $SNAP -- ${gForeign.join(' ')}\`, NEVER \`git stash pop\`); set merged=false / conflict=true, report — do NOT force-resolve.`,
          gForeign.length
            ? `  4. RESTORE the foreign WIP from YOUR OWN snapshot (only if step 0 produced a SNAP): \`git -C ${REPO} checkout $SNAP -- ${gForeign.join(' ')}\`. This is targeted and race-free — it names the exact commit and the exact paths, so a sibling group finishing at the same moment cannot be affected. NEVER \`git stash pop\`. If the checkout reports a conflict or fails: your unit's commit ALREADY landed — do NOT revert it; report the SNAP sha LOUDLY in \`notes\` so the owner can recover with \`git checkout <SNAP> -- <files>\`, and still report merged=true. Put the restored files in stashedForeign.`
            : `  4. (nothing stashed) set stashedForeign=[].`,
          `  5. Leave ${REPO}'s OTHER uncommitted foreign WIP (files NOT in this group) untouched — operate on commits only.`,
          `  6. AFTER a successful integration, remove this group's worktree (non-fatal if it errors): \`git -C ${REPO} worktree remove --force ${g.worktreePath}\`.`,
          `Report the resulting SHAs now on ${REPO}'s working branch in \`shas\`, and the files you stashed+restored in \`stashedForeign\`. Return the StructuredOutput (groupId="${g.id}" / merged / shas / conflict / stashedForeign / notes).`,
        ].join('\n'), { label: `merge:${g.id}`, phase: 'Commit', schema: WT_MERGE_SCHEMA })
      } catch (e) {
        r = { groupId: g.id, merged: false, shas: [], conflict: false, stashedForeign: [], notes: String(e) }
      }
      mergedGroups.push(r)
      log(`merge ${g.id} (${g.branch}): ${r.merged ? 'OK ' + (r.shas || []).join(',') : (r.conflict ? 'CONFLICT — aborted' : 'FAILED') + ' — ' + (r.notes || '')}`)
      // Reflect the merge result onto each unit's committed/sha for the shared `committed` return.
      for (const ur of (g.units || [])) committed.push({ unitId: ur.unitId, committed: !!r.merged && !!ur.committed, sha: ur.sha, subject: ur.subject })
    }
    // Worktree cleanup: the Agent tool auto-removes an UNCHANGED worktree; explicitly prune the rest.
    try {
      await agent([
        `You are the worktree-prune step of a worktree-per-agent run. Repo root: ${REPO}.`,
        bashRule,
        `Run \`git -C ${REPO} worktree prune\` and \`git -C ${REPO} worktree list\` to clean up any leftover worktrees from this run, then report what remains. Do NOT delete the main working tree. Do NOT delete the orca/* branches (Phase C already merged them).`,
        `Return nothing structured — just do it.`,
      ].join('\n'), { label: 'worktree-prune', phase: 'Commit' }).catch((e) => log(`worktree prune failed (non-fatal): ${String(e)}`))
    } catch (e) { log(`worktree prune failed (non-fatal): ${String(e)}`) }
    // Deferred integration verify: now that merge-back put the changes on the base tree, verify once.
    if (INTEGRATION_VERIFY && applied.length) { phase('Verify'); await runIntegrationVerify() }
  } else if (!DO_COMMIT) {
    log('Phase C skipped (commit:false) — worktree-mode changes left UNCOMMITTED inside their worktrees (not merged back)')
  } else {
    log('Phase C (worktree mode): no group branches to merge')
  }
}

// ── Phase L — LEDGER: write back what actually happened, so routing learns ──────────────
// This is the half that makes the expertise table OURS rather than a frozen copy of someone
// else's benchmark. Fugu measures each worker's real performance and folds it into the
// routing distribution (§3.1.2); we cannot train, but we can accumulate outcomes and let
// them progressively outvote the seeded prior (PRIOR_STRENGTH pseudo-trials in the
// conductor). Without this phase the whole thing is just a hardcoded opinion with citations.
//
// "Won" = the unit's patch APPLIED and its verify did not fail. Deliberately strict and
// deliberately crude: a per-unit pass/fail is the only signal we can collect for free.
if (routes.size > 0) {
  // FORK 2026-07-26 (J19 audit): the old rule was `applied && integration.passed`, which
  // threw away the PER-UNIT verify Phase B already collects and leaned on a whole-tree gate
  // that is often absent. Two consequences, both bad for a learning table: a unit whose own
  // verify failed still counted as a WIN if the tree happened to build, and with no
  // integrationVerify configured every applied unit scored 1.0 — which is how the live
  // ledger ended up 8-for-8 and therefore carrying no signal at all.
  //
  // Now: a unit wins only if it applied AND its own verify did not fail AND (when there is
  // one) the integration gate passed. Crucially, a unit we could NOT actually measure —
  // applied but UNVERIFIED, with no integration gate — is SKIPPED rather than recorded as a
  // win. Never record a measurement you did not make; a fabricated 1.0 is worse than no row.
  const verdictByUnit = new Map(
    [...applied, ...failed].filter((s) => s && s.d).map((s) => [s.d.unit.id, s.result || {}]),
  )
  const appliedIds = new Set(applied.map((s) => s.d.unit.id))
  const outcomes = []
  let unmeasured = 0
  for (const u of UNITS) {
    const p = routes.get(u.id)
    if (!p || !p.model) continue
    const v = String((verdictByUnit.get(u.id) || {}).verify || '')
    const verifyFailed = /\b(fail|failed|error)\b/i.test(v)
    const verifyPassed = /\b(pass|passed|ok|green)\b/i.test(v)
    const didApply = appliedIds.has(u.id)
    if (didApply && !verifyFailed && !verifyPassed && !integration) {
      unmeasured++   // applied but UNVERIFIED and no tree-level gate ⇒ we learned nothing
      continue
    }
    const ok = didApply && !verifyFailed && (!integration || integration.passed)
    outcomes.push({ domain: p.domain, model: p.model, mode: p.mode, unit: u.id, ok })
  }
  if (unmeasured) log(`Phase L: ${unmeasured} unit(s) applied but UNVERIFIED with no integration gate — not recorded (no signal)`)
  if (outcomes.length) {
    phase('Ledger')
    log(`Phase L: recording ${outcomes.length} routing outcomes (${outcomes.filter((o) => o.ok).length} won)`)
    try {
      await agent([
        `You are PHASE L of an ORCA run — you record measured routing outcomes. You do NOT read or edit repo code.`,
        bashRule,
        `For EACH row below, run the conductor's record command exactly once. Convert the model id to its short key by matching the conductor's POOL (claude-code/claude-fable-5→fable, claude-code/claude-opus-5→opus, claude-code/claude-sonnet-5→sonnet, codex/gpt-5.6-sol→gpt, xai/grok-4.5→grok, google/gemini-3.1-pro-preview→gemini):`,
        `  node ${CONDUCTOR} record --domain <domain> --model <key> --ok <true|false> --mode <mode> --unit <unit>`,
        `ROWS: ${JSON.stringify(outcomes)}`,
        `Report one line: how many rows you recorded. Do NOT edit the ledger file by hand and do NOT invent rows that are not listed.`,
      ].join('\n'), { label: 'ledger', phase: 'Ledger' })
    } catch (e) {
      // A lost data point must never fail a coding run that already landed.
      log(`Phase L: ledger write failed (non-fatal): ${String(e)}`)
    }
  }
}

return {
  repoRoot: REPO,
  total: UNITS.length,
  routing: routePlan && routePlan.ok
    ? { tier: QUALITY, routed: routes.size, plans: [...routes.values()].map((p) => ({ unitId: p.unitId, domain: p.domain, mode: p.mode, model: p.model, why: p.why })) }
    : { tier: QUALITY, routed: 0, error: routePlan ? routePlan.error : 'routing disabled' },
  applied: applied.map((s) => ({ id: s.d.unit.id, files: s.result.filesChanged, reDerived: s.result.reDerived, verify: s.result.verify, summary: s.d.patch.summary })),
  committed: committed.map((c) => ({ id: c.unitId, committed: c.committed, sha: c.sha, subject: c.subject })),
  failed: failed.map((s) => ({ id: s.d.unit.id, notes: s.result ? s.result.notes : 'no result' })),
  blockedInDraft: blocked.map((b) => ({ id: b.unit.id, reason: b.patch ? b.patch.blockReason : 'agent failed' })),
  contention: {
    branch: preflight.branch || '',
    detected: contention.detected,
    foreignWipFiles: contention.foreignWipFiles,
    handsOffHits: contention.handsOffHits,
    forcedNoCommit: contention.forcedNoCommit,
    recentForeignCommits: contention.recentForeignCommits,
  },
  integrationVerify: integration ? { ran: true, passed: integration.passed, notes: integration.notes } : { ran: false },
  worktree: WORKTREE
    ? {
        enabled: true,
        groups: worktreeGroups.map((g) => {
          const m = mergedGroups.find((x) => x.groupId === g.id)
          return {
            id: g.id,
            branch: g.branch,
            disjoint: g.disjoint,
            files: g.files,
            units: (g.units || []).map((u) => u.unitId),
            merged: m ? !!m.merged : false,
            shas: m ? (m.shas || []) : (g.units || []).map((u) => u.sha).filter(Boolean),
            conflict: m ? !!m.conflict : false,
          }
        }),
      }
    : { enabled: false },
}
