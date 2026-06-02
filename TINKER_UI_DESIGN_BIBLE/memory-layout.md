---
file: memory-layout.md
purpose: Where memory lives under the workspace + the ENGRAM root, who writes it, retention policy
audience: AI
last_verified: 2026-06-02
last_verified_commit: 06f8647fdc
single_owner: yes — directory map + writer + retention live here (both workspace/memory/ AND ~/.openclaw/engram/)
see_also: topology.md (workspace symlinks), crons.md (engram-consolidate writer), subagents-and-recipes.md (recipe/skill BEHAVIOR — selection, fitness scoring, never-delete), pii-boundary.md (everything under workspace/memory is PRIVATE)
verify:
  - name: workspace memory dir exists
    cmd: test -d ~/.openclaw/workspace/memory
  - name: people/ has profile files (at least 100)
    cmd: '[ "$(ls ~/.openclaw/workspace/memory/people 2>/dev/null | wc -l)" -ge 100 ]'
  - name: consolidation-state.json exists
    cmd: test -f ~/.openclaw/workspace/memory/consolidation-state.json
  - name: U2 curiosity-gaps dir has at least one daily jsonl
    cmd: python3 -c 'import glob,os; assert len(glob.glob(os.path.expanduser("~/.openclaw/workspace/memory/curiosity-gaps/*.jsonl"))) >= 1'
  - name: U9 ENGRAM links dir exists (link-index store)
    cmd: test -d ~/.openclaw/engram/links
  - name: U6 ENGRAM skill-library dir exists
    cmd: test -d ~/.openclaw/engram/skill-library
---

# Memory layout — workspace directory map

All paths below are under `~/.openclaw/workspace/memory/` unless otherwise noted. This entire tree is PRIVATE (lives in jarvis-brain GitLab repo). It is NEVER symlinked into public tinkerclaw.

## Directory map

### `people/` — people-profile cards

- **Writer:** `tinkerclaw-people` plugin (via `people.update_consulted_at`) + the `people-profiles` cron (auto-generation from WhatsApp inbound).
- **Reader:** `tinkerclaw-people` plugin (`people.{resolve,read,list}` RPCs); auto-reply pipeline (sender-profile prefetch via `people-prefetch.ts`).
- **Layout:** `people/<slug>/profile.md` + aliases file.
- **Cardinality:** ~1014 aliases / ~1223 profile files (2026-05-04 snapshot).
- **Retention:** unbounded; consolidation cron removes stale alias mappings.

### `morning-briefings/`

- **Writer:** `morning-briefing` cron at 07:00; user `/new` flow may also append a user-pass.
- **Reader:** Tinker UI `/new` flow, user.
- **Layout:** `YYYY-MM-DD.md` (cumulative passes) + `YYYY-MM-DD-preflight.json` (preflight matrix).
- **Critical:** cron pass = audit; user `/new` = pass-1. See M8 in failures.md.

### `knowledge/`

- **Writer:** mostly hand (Jarvis adds knowledge files at user request).
- **Reader:** memorySearch retrieval, ad-hoc reads.
- **Notable files:** `INDEX.md`, `evolution-log.md`, `ripple-tracker.md`, `tinkerclaw-cc-bridge.md`, `tinkerclaw-people-plugin.md`, `tinkerclaw-whatsapp-plugin.md`, `wa-owner-prefix-invariant.md`, `whatsapp-strategy.md`, `cost-aware-model-routing.md`, `hermes-agent-analysis.md`, `operational-lessons.md`, `serra-projects-state.md`.

### `butler-log/`

- **Writer:** `life-butler` cron + user-facing butler interactions.
- **Reader:** morning-briefing cron (carryover), Jarvis context.
- **Layout:** `INDEX.md`, `butler-scope.md`, `dates-registry.md` (anniversaries / birthdays / flowers), `YYYY-MM-DD.md` per day.

### `online-presence/`

- **Writer:** `online-engagement` cron.
- **Reader:** morning-briefing (online income priority axis).
- **Layout:** `engagement-state.json` + `YYYY-MM-DD.md` daily.

### `security-reports/`

- **Writer:** `security-updates-check` cron.
- **Layout:** `META.md` + `YYYY-MM-DD-report.md` daily.

### `self-evolution/`

- **Writer:** `self-evolution` cron.
- **Layout:** `index.md`, `model-intelligence-state.json`, `YYYY-MM-DD.md` daily.

### `spiritual-tech/`

- **Writer:** `spiritual-tech` cron.
- **Layout:** `interests.md`, `ethics-codex.md`, `YYYY-MM-DD.md` daily.

### `whatsapp-summaries/`

- **Writer:** wind-down or related cron (TBD; confirm).
- **Layout:** `YYYY-MM-DD.md` per day.

### `consolidation-logs/`

- **Writer:** `cleaning-lady` (memory consolidation) cron.
- **Layout:** `YYYY-MM-DD.md` daily.

### `maintenance-reports/`

- **Writer:** `fork-scanner` cron + ad-hoc.
- **Layout:** `YYYY-MM-DD.md` + `YYYY-MM-DD-fork-sync.md` + `YYYY-MM-DD-wind-down.md`.

### `cron-receipts/`

- **Writer:** cron scheduler itself.
- **Layout:** `YYYY-MM-DD-<jobId>.json` per run.
- **Note:** this is a flat archive of run outcomes; the rolling `~/.openclaw/cron/runs/<jobId>.jsonl` is the live tail.

### `bugs/`

- **Writer:** Jarvis when documenting unresolved bug reports.
- **Layout:** `INDEX.md` + `BNNN-<slug>.md` files.

### `ai-research/`

- **Writer:** Jarvis tracking external AI development.
- **Layout:** `agent-oss-tracklist.json`, `fork-watchlist.json`, `fork-survey/YYYY-MM-DD.md`.

### `chat-profiles/`

- **Writer:** auto-reply pipeline writing per-chat config (chat-rhythm settings, response policy overrides).
- **Layout:** per chat-jid subdirectories.

### `shopping/`

- **Writer:** marketplace-watcher cron, ad-hoc.
- **Layout:** `watchlist-state.json`.

### `curiosity-gaps/` — U2 intrinsic-motivation episodic buffer (J8 THALAMUS)

- **Writer:** `appendGap()` in `src/fork/curiosity-store.ts`. PRODUCERS: the `2a` hedging/uncertainty detector wired into `attempt-hooks.ts` `onTurnComplete` (`source:"lcm-entropy"`), a prefrontal NO-MATCH (`2e`, `source:"no-match"`), retrieval miss, or user correction. RPC surface: `fork.curiosity.logGap/topGaps/resolveGap` (`curiosity-rpc.ts`).
- **Reader:** `readGaps()`/`topGaps()`; auto-indexed by `memorySearch` (any new dir under workspace/memory/ is picked up — see "Writer ↔ reader summary").
- **Layout:** `YYYY-MM-DD.jsonl` — one append-only JSONL of `Gap` records per day.
- **Atomic-write:** JSONL append is naturally append-safe (single `O_APPEND` write); any future daily-index summary must go read-modify-write-rename (`feedback_atomic_store_writes`).
- **Invariant — no self-output-as-truth:** `source:"lcm-entropy"` gaps are _questions_, not facts; resolution must come from an EXTERNAL channel (`resolutionSource` recorded here; "external-only" enforced in the active-learning cron body).
- **Dedupe:** NO-MATCH spam collapses by `(recipe|tool|reason)`; other sources by `(source|topic)` — frequency counted, never duplicated.
- **Note:** the ONLY OSS-harness (U1–U12) store under `workspace/memory/`; the rest live under the ENGRAM root — see below.

## Engram + compaction state

- `consolidation-state.json` — top-level pointer for the memory consolidation engine (engram pointer-mode, ENGRAM_POINTER_COMPACTION=1). (Lives under `workspace/memory/`; a per-session copy also lives at the ENGRAM root — see next section.)
- See J1 (ENGRAM) and J14 (MNEMOSYNE) for the full memory-engine theory.

## ENGRAM root — `~/.openclaw/engram/` (OSS-harness stores)

A SECOND private memory tree, distinct from `workspace/memory/`. Root resolves to `join(process.env.HOME ?? OPENCLAW_HOME, ".openclaw", "engram")` (see `src/agents/pi-embedded-runner/extensions.ts:159` for the inline-runtime branch; `engramRoot(baseDir?)` in `src/fork/skill-rpc.ts` + `src/cron/jobs/engram-consolidate.ts` use the same default with an `OPENCLAW_HOME` override for tests). Pre-existing contents: `events/`, `embeddings/`, `engram-fts.db`, `artifacts/`, `reflections/`, daily `YYYY-MM-DD.jsonl` event logs, and a per-session `consolidation-state.json`. The OSS-harness upgrades (commit 06f8647fdc, on top of 70ad58e45d) add the stores below. This tree is PRIVATE — never symlinked into the public fork.

Convention shared by these stores: **atomic write = write-temp-then-rename** (`feedback_atomic_store_writes`) for whole-file JSON; **append-only JSONL** for per-event logs; **defensive read** (missing/corrupt → empty, never throw); **never-delete** for the versioned knowledge stores (supersession marks `deprecated`, body stays readable + recoverable). The single highest-leverage WRITER here is the `engram-consolidate` cron (04:00 daily, code-only descriptor — see crons.md); RPC handlers (`fork.skill.*`, `fork.curiosity.*`) are the live read/write surface.

### `recipe-archive/` — U1 recipe-evolution versioned store (J5 + J13)

- **Writer:** `createRecipeArchive()` in `src/memory/engram/recipe-archive.ts`. PRODUCER chain: `recipe-runner.ts` stamps `recipe:<owner/slug>` attribution tags via `onTag` (threaded by `prefrontal.recipe.run`); the `engram-consolidate` cron runs `proposeMutations()` (`recipe-evolution.ts`) and writes new variants. Gated by `RECIPE_AUTOAPPLY_ENABLED` (already "true").
- **Reader:** `loadRecipeFitness(baseDir, slug)` / `makeFitnessLookup()` (`recipe-fitness.ts`) — a SYNC reader threaded as a `FitnessLookup` feedback into `matchRecipesDetailed` (turn-start seed + `recipe.match`). `rank()` returns variants best-fitness-first with an epsilon-greedy explorer slot.
- **Layout:** `index.json` (`{ recipeId -> { recipeId, versions: number[] } }`) + `<recipeId-slug>/v<n>.json` (`{ body, fitness, deprecated }`). `recipeId` is the canonical `owner/slug`; dir-name slugify escapes non-`[A-Za-z0-9._-]`.
- **No separate fitness store:** `recipe-fitness.ts` has NO file of its own — each variant's Laplace-smoothed `successRate` lives INSIDE its `v<n>.json` under `.fitness`. Default for an unmeasured recipe is the neutral `laplace(0,0)` = 0.5 (never penalised).
- **Retention:** NEVER deletes — supersession sets `deprecated:true`; the body stays readable for rollback (self-reinforcing-error-spiral mitigation). On-disk dir is created lazily on first promoted mutation (absent until then).
- **Behavior owner:** selection/scoring precedence (base → U1 fitness feedback → U12 rating tie-break) lives in subagents-and-recipes.md; this optic owns only the on-disk shape.

### `skill-library/` — U6 Voyager skill-library-as-code (J5 + J2)

- **Writer:** `createSkillLibrary()` in `src/memory/engram/skill-library.ts`. PRODUCER: `skill-extraction.ts` (structured-procedure `Skill`, optional `verifiedCode`) injected into the `engram-consolidate` cron; `skill-invocation.ts` records outcomes back. RPC: `fork.skill.search` / `fork.skill.recordOutcome` (`src/fork/skill-rpc.ts`).
- **Reader:** embed-ranked search (an injected `EmbedFn` embeds the query + all live skill texts in ONE batch, cosine-ranked) with a token-overlap keyword fallback when no `EmbedFn` is wired.
- **Layout:** `library.json` (`{ skillId -> SkillLibraryIndexEntry }`) + `skill-<skillId>/v<n>.json` (full `Skill` body per version). Whole-file writes go temp-then-`renameSync` (atomic).
- **Retention:** NEVER deletes — `deprecate()` marks obsolete while `read()` still returns the body. Re-extraction of a same-named skill bumps `version`; a near-identical skill (Jaccard > 0.8, `SKILL_DEDUP_JACCARD`) merges `sourceEpisodeIds` rather than duplicating (library-bloat mitigation).
- **On-disk now:** the `skill-library/` dir EXISTS (empty until the consolidation cron extracts a skill).

### `links/<sessionKey>.jsonl` — U9 A-MEM Zettelkasten link index (J3)

- **Writer:** `createLinkIndex()` in `src/memory/engram/link-index.ts` (same JSONL-append + in-memory-cache pattern as `event-store.ts`). PRODUCER: `setLinkBuilderRuntime` registered at the session-setup site `src/agents/pi-embedded-runner/extensions.ts:179` (beside `setIngestionRuntime`); `extractAndIndex()` fires fire-and-forget in `attempt-hooks.ts` `onTurnComplete`, parsing `[[wikilink]]` + entity refs via `mention-parser.ts`.
- **Reader:** `getBacklinks(targetKey)` — 1-hop backlink expansion folded into `retrieval-runtime.ts`. `resolveTargets(eventStore)` late-binds normalized mention keys to concrete event ids (a target may be mentioned before the note it names exists).
- **Layout:** `links/<sessionKey>.jsonl` — append-only `LinkRecord` rows (`{ id, sourceId, targetKey, mentionText, kind, createdAt }`); two in-memory `Map`s (`forward` / `backward`) rebuilt from the JSONL on first read.
- **Atomic-write:** `appendFileSync` (single append); never a blind whole-file overwrite.
- **On-disk now:** the `links/` dir EXISTS (per-session files appear once a turn writes a mention).

### `failure-state.json` — U4 failure→strategy-switch durable store (J5)

- **Writer:** `updateFailureStateMap()` / `saveFailureState()` in `src/memory/engram/failure-tracking-store.ts`, driven by the `engram-consolidate` cron. RPC: `fork.strategy.switch.list/apply/review` (`src/gateway/server-methods/engram-strategy.ts`); proposals come from `strategy-switch.ts`.
- **Layout:** single JSON file `~/.openclaw/engram/failure-state.json` holding the per-strategy `FailureStateMap`.
- **Atomic-write:** write-temp-then-`renameSync`; `updateFailureStateMap` is a read-modify-write under that helper so a concurrent writer's fields are never clobbered (always re-reads the FRESH on-disk copy, not a stale snapshot). Defensive read → empty map on missing/corrupt (torn write degrades to "start fresh").
- **On-disk now:** absent until the cron proposes the first switch (`fork.strategy.switch.list` → `{ok:true,decisions:[]}` verified live).

### `reconciliation-ledger.json` — U8 Mem0 write-reconciliation ledger (J1)

- **Writer:** `createReconciliationLedger({ filePath })` in `src/memory/engram/reconciliation-ledger.ts`; the `engram-consolidate` cron passes `filePath: join(baseDir, "reconciliation-ledger.json")`. `reconciler.decide()` (`reconciliation.ts`, ADD/UPDATE/DELETE/NONE) runs in the ingestion append hot-path; `reconcileWindow` runs in consolidation.
- **Layout:** `{ entries: Record<eventId, LedgerEntry>, tail: LedgerEntry[] }` — UPDATE/DELETE take effect as _logical_ supersede/tombstone rows (one per fact-key, latest wins) + a bounded rolling tail of raw decisions. The underlying event JSONL is NEVER physically mutated (append-only audit plane).
- **Atomic-write:** whole-file `writeFileSync(JSON.stringify(...))` (a future hot path should move to temp-then-rename if it leaves consolidation-only writes); `filePath` absent ⇒ in-memory only.
- **DARK-LAUNCHED:** gated behind `ENGRAM_RECONCILE` (default OFF → default reconciler is always-ADD = today's behavior, no ledger written). On-disk absent until the flag is set and the cron runs.

### MEMORY.md writer (U8) — bounded, idempotent, **suggest-only**

- **Writer:** `src/memory/engram/memory-md-writer.ts` — a PURE function `facts + summaries + {maxLines} → { content, demotions, ... }`. It NEVER touches disk and NEVER decides to overwrite `MEMORY.md`. The Wire phase (behind `ENGRAM_RECONCILE`, default OFF) decides whether to persist the content and how to act on demotion suggestions.
- **Output target (when wired):** the user's `MEMORY.md` digest. Bounding mirrors MEMORY.md's own "one-line index entry; move detail to a topic file" discipline — when facts + summaries exceed `maxLines`, the LOWEST-importance facts are DEMOTED to a linked detail-file reference (never dropped). Deterministic/idempotent: facts sorted by (importance desc, key asc) → byte-identical output; re-serializing the bounded survivor set is a fixpoint.
- **Retention/authorship:** suggest-only by default PRESERVES MEMORY.md's hand-edited authorship — reconciliation can only _suggest_ prunes, never silently rewrite.

## Retention

- **Daily dirs** (`butler-log/YYYY-MM-DD.md`, `self-evolution/YYYY-MM-DD.md`, etc.) — retained indefinitely; cleaning-lady cron consolidates rather than deletes.
- **Cron receipts** — retained indefinitely as audit trail.
- **People profiles** — retained until explicitly archived. Stale aliases (no inbound > 90 days) flagged but not auto-deleted.
- **Knowledge files** — manual lifecycle.
- **ENGRAM versioned stores** (`recipe-archive/`, `skill-library/`) — NEVER deleted; supersession sets `deprecated:true` and old `v<n>.json` bodies stay on disk for rollback/audit. Bloat is bounded by dedup (Jaccard merge), not deletion.
- **`links/<sessionKey>.jsonl`** — append-only, retained indefinitely (rebuilt into memory on read).
- **`curiosity-gaps/YYYY-MM-DD.jsonl`** — daily JSONL, retained indefinitely; resolved gaps stay (audit), dedupe collapses frequency rather than dropping rows.
- **`failure-state.json` / `reconciliation-ledger.json`** — single bounded JSON files (latest-wins per key + a rolling tail); not append-growing.

## Writer ↔ reader summary

Writers are mostly crons + the auto-reply pipeline. Readers are mostly Jarvis context-injection at session start and memorySearch retrieval.

The single highest-leverage Reader is `agents.defaults.memorySearch` (Ollama embeddings + FTS hybrid). It indexes EVERYTHING under workspace/memory/ + sessions. Any new directory added under workspace/memory/ will be picked up automatically.

## Don't regress

- Never symlink workspace/memory/ OR ~/.openclaw/engram/ subdirs into the public fork — both trees are PRIVATE.
- Cron receipts MUST stay as flat JSON (parseable by `cron.lastRun` probe when wired).
- The consolidation-state.json schema is owned by ENGRAM (J1); changes must coordinate.
- `recipe-archive/` + `skill-library/` are NEVER-DELETE: a "cleanup" that physically removes a `v<n>.json` breaks rollback and the never-delete invariant. Mark `deprecated`, don't unlink.
- The reconciliation ledger is the logical-supersede/tombstone plane: never mutate the underlying event JSONL in place to "apply" a reconciliation — the append-only audit plane is load-bearing.
- The MEMORY.md writer is suggest-only by default (gated by `ENGRAM_RECONCILE`); do not let consolidation silently overwrite the hand-edited `MEMORY.md`.
- Whole-file JSON stores here (`failure-state.json`, `reconciliation-ledger.json`, `skill-library/library.json`, `recipe-archive/index.json`) must use temp-then-rename and re-read-before-write — never blind `writeFileSync` of an in-memory snapshot onto a shared file (`feedback_atomic_store_writes`).

## Verify

```yaml
verify:
  - cmd: ls ~/.openclaw/workspace/memory/people | head -1 | wc -l
    expect: "integer > 0"
  - cmd: stat -c '%Y' ~/.openclaw/workspace/memory/morning-briefings/$(date +%Y-%m-%d).md 2>/dev/null
    expect: "recent (after today 07:00)" # confirms briefing cron ran
```
