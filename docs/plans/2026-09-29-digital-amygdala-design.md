# Digital amygdala — detailed design (pass 3)

**What this is for.** The build spec for `extensions/tinkerclaw-amygdala`: enough per module (types, storage, gateway
surface, hook contracts, seed questions, decision tables, learning, UI, tests) that phases B–F can be split into
disjoint units and coded without new design decisions. **Derived from** the J11 v6.7 paper (`§` refs below are its
sections), the plan of passes 1–2 (`2026-09-29-digital-amygdala-implementation-plan.md`, "the plan"), the design page
(pass 3, block 5b added), the principal's feedback of 2026-09-29 17:34 as interpreted by the charter, and the v3.1 code
as it stands (`extensions/tinkerclaw-learned-intuition`, read-only reference). **What would change it:** Jev's latency
in use, the Phase D rewind spike, a paper revision that moves a family, or any answer to the "For the architect" list (§12).
Paper and plan sections are pointed to, not restated. **No question wording appears here**: wording lives only in
`questions/<family>/<id>.md` (charter rule; one file per prompt since 2026-09-30).

## 1. Choices the plan left open

Owner **D** = decided here; **O** = decided here as a safe default, his call to change (§12).

| #   | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Owner |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| C1  | Plugin id `tinkerclaw-amygdala`, `enabledByDefault: false`, `activation.onStartup: true`, mode `shadow` by default (decides and logs, enforces nothing through the judge; whether its hard-rule floor is active is computed, C19)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | D     |
| C2  | **Coexistence names.** v3.1 already registers `amygdala.feed` and owns `~/.openclaw/data/amygdala/`. While both exist the new extension uses method/event prefix **`amygdala2.`** and data dir **`~/.openclaw/data/amygdala-jev/`**. The cutover commit renames both                                                                                                                                                                                                                                                                                                                                                                                                                                       | D     |
| C3  | Hooks reach the gateway over loopback HTTP: the plugin registers `POST /plugins/amygdala2/decide` (`registerHttpRoute`) and writes `endpoint.json` (port, token) in the data dir at start (file 0600, folder 0700). Every `POST /plugins/amygdala2/*` without that token is rejected 401, compared in constant time (`timingSafeEqual`). Hooks read the file; no key or Jev call ever in a hook                                                                                                                                                                                                                                                                                                            | D     |
| C4  | One Jev call per seam event, all questions of that step batched; cache key `sha256(id@version + canonical situation subset the question reads)`, in-memory LRU, 2000 entries, TTL 10 min                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | D     |
| C5  | Latency budgets (loopback + Jev): prompt 2 s, pre-tool 3 s, post-tool 2 s, stop 5 s. Jev call timeout = budget − 400 ms. Circuit breaker: 3 consecutive failures/timeouts open it for 30 s, then one probe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | O     |
| C6  | Jev unreachable, no answer in budget, or breaker open → **judge checks fail open** (step proceeds, verdict row marked `fallback`, status line red). Hard rules are local and fail closed. Config `failClosedOnLevel3` (default false) flips level-3 steps to hold                                                                                                                                                                                                                                                                                                                                                                                                                                          | O     |
| C7  | A held step waits **inside the PreToolUse hook**: the hook long-polls `POST /plugins/amygdala2/wait` (≤ 300 s, hook `timeout` 330 s in its settings entry). The user's button answers it. No answer → deny, reason says nothing ran                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | D     |
| C8  | A proof check is an immediate deny whose reason names the evidence that would release it; the next PreToolUse with the same step signature is released when the record holds that evidence (judged, §5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | D     |
| C9  | Real situations never go to Jev unless `jev.sendRealSituations` is true (default false). With it false, real turns are decided by hard rules + effect-class fallback, and the Jev window says so in one line (§9.3). Synthetic cases (`origin:"synthetic"`) pass                                                                                                                                                                                                                                                                                                                                                                                                                                           | O     |
| C10 | Precedents are retrieved without embeddings: exact feature key + Jaccard ≥ 0.6 on normalised command tokens. No new model, no vectors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | D     |
| C11 | Threshold and per-context changes are replayed on **stored probabilities** (free, no Jev call). Only rewordings need live Jev calls, capped at 300 per night                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | D     |
| C12 | "Exceptional" is computed from the replayed cases, not declared on a question: a loosening is exceptional if any case it relaxes had danger level 3, an egress flag, or an external effect class (send, spend, restart-own-system, delete-user-data)                                                                                                                                                                                                                                                                                                                                                                                                                                                       | D     |
| C13 | Auto-loosening caps: ≤ 2 per question per week, ≤ 6 per day overall; a change undone by the user blocks the same context loosening for 30 days                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | O     |
| C14 | Spend = Σ Jev `tokens_in` × 0.042 USD/MTok × `cost.eurPerUsd` (default 0.92). Output is free. Only Jev is counted; model spend stays in the budget panel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | O     |
| C15 | Families on by default: safety, double-check, second opinion. Efficiency and personality are built and **off** until switched on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | O     |
| C16 | The Jev window and cards render in the Tinker chat only. WhatsApp and other surfaces get nothing (an html-render block there is raw tags)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | D     |
| C17 | Message the agent through hook channels only: deny reason, `additionalContext`, Stop block. Never `worker.steer`, never `updatedInput` (plan choice 8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | D     |
| C18 | **One `--settings`, chosen by the bridge, written by the plugin.** The plugin writes `cc-hook-settings.json` (the four new hooks) and an _effective_ file `cc-hook-settings.effective.json`: in shadow with v3.1's file present, the per-event merge (v3.1's entries first, unchanged, then ours); in enforce, or with no v3.1 file, ours alone. The bridge only `stat`s and picks one file: none of ours → today's behaviour exactly; ours exist → the effective file if it is at least as new as both sources, else v3.1's file alone (v3.1 keeps enforcing; ours wait for the next heartbeat), else ours. No merge code is duplicated in the bridge. Two `--settings` flags are unverified and not used | D     |
| C19 | **The floor never lapses, in code.** `floorActive = mode === "enforce" \|\| !v31Enforcing`. `v31Enforcing` is read at plugin start from the learned-intuition config (`enabled`, `observeOnly:false`, `hookEnforcement:true`) and from the presence of its settings file, and re-read on every heartbeat. If v3.1 goes off while this extension is in shadow, the new floor switches on (and the status line says so)                                                                                                                                                                                                                                                                                      | D     |
| C20 | **In shadow the new hooks add no latency.** They write the spool line, fire `decide` without waiting (at most 150 ms), always print nothing and exit 0. They never deny except through the floor when `floorActive`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | D     |
| C21 | **Inert when the plugin is off.** With no new settings file the bridge's spawn arguments are byte-identical to today (test asserts it). The UI feature-detects `amygdala2.status`: unknown method → today's v3.1 panel, unchanged, no Jev window, no dot                                                                                                                                                                                                                                                                                                                                                                                                                                                   | D     |
| C22 | **No edits to live scheduling.** The nightly work is `amygdala2.nightly` plus a runnable script; cron jobs, prompts and payloads are not touched. The one-line hook-up is a decision for the architect (§12)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | D     |

## 2. Shared types (`src/types.ts`)

```ts
export type Seam = "prompt" | "pre-tool" | "post-tool" | "stop";
export type Origin = "observed" | "derived" | "inferred" | "missing";
export type EffectClass =
  | "read"
  | "local-write"
  | "send"
  | "spend"
  | "restart-own-system"
  | "delete"
  | "other";
export type FamilyId = "safety" | "second-opinion" | "double-check" | "efficiency" | "personality";

export interface Field<T = unknown> {
  value: T | null;
  origin: Origin;
  source?: string;
} // missing => value null, never guessed

export interface Situation {
  // §7.1, Appendix B
  id: string;
  ts: number;
  sessionKey: string;
  turnId: string;
  seam: Seam;
  originKind: "real" | "synthetic";
  tool: Field<string>;
  args: Field<Record<string, unknown>>;
  command: Field<string>;
  effectClass: Field<EffectClass>;
  targets: Field<ResolvedTarget[]>; // paths by text processing only
  targetHistory: Field<{
    ageH: number;
    sizeB: number;
    edits72h: number;
    authors72h: number;
    lastMentionedByUser: number | null;
  }>;
  scratch: Field<boolean>;
  toolRecord: Field<ToolRecordEntry[]>;
  request: Field<string>; // user words only, wrapper removed
  restatement: Field<string>;
  expectation: Field<string>;
  draftCommitments: Field<Commitment[]>; // inferred, labelled
  repeatedErrors: Field<number>;
  stepsSinceNewFact: Field<number>;
  recentHolds: Field<{ goalFp: string; ts: number }[]>;
  standingFacts: Field<string[]>;
  similarIncidents: Field<string[]>;
  reply: Field<string>;
  claims: Field<Claim[]>;
  provenance: Field<{ callId: string; instructionLike: boolean }[]>; // which read content looked like instructions
  holdNeeds: Field<EvidenceKind[]>; // evidence an open proof check waits for
  candidates: Field<{ id: string; description: string }[]>; // shortlisted procedures (procedure choice)
  scheduledJobs: Field<string[]>; // later work already scheduled (promise check)
  contextCounts: Field<{ seen: number; alarms: number }>; // habituation for novelty
}
export interface Question {
  // one immutable version
  id: string;
  version: number;
  family: FamilyId;
  seams: Seam[];
  type: "noul" | "choice" | "score";
  criteria: Record<string, string | null> | string[]; // choice map / score levels / noul {true,false}
  instructions: string; // THE wording; only place it exists
  fields: (keyof Situation)[];
  cutoff: Cutoff;
  purpose: string;
  origin: string;
  retirement: string;
  mustCatch: string[];
  status: "active" | "off";
  parent?: number;
  name: string; // human name shown in the UI, never the instructions
}
// `negate` = any option other than `option`; a level cut-off has exactly one of atOrAbove / atOrBelow;
// `none` = the question never acts alone (records provenance or feeds another signal).
export type Cutoff =
  | { kind: "prob"; at: number }
  | { kind: "level"; atOrAbove?: number; atOrBelow?: number }
  | { kind: "choice"; option: string; at: number; negate?: boolean }
  | { kind: "none" };
export interface Verdict {
  id: string;
  situationId: string;
  questionId: string;
  questionVersion: number;
  type: Question["type"];
  answer: string | number | boolean;
  prob: number;
  confidence: number;
  probs?: Record<string, number>;
  cacheHit: boolean;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  skipped?: "not-allowed" | "breaker-open" | "timeout" | "error";
  ts: number;
}
export type Response =
  | { kind: "proceed" }
  | {
      kind: "note";
      templateId: string;
      slots: Record<string, string | number>;
      channel: "additionalContext";
    }
  | {
      kind: "proof";
      templateId: string;
      slots: Record<string, string | number>;
      needs: EvidenceKind[];
    }
  | {
      kind: "ask";
      askId: string;
      options: { id: string; label: string; hint?: string }[];
      preselect?: string;
    }
  | { kind: "hold"; ruleOrQuestion: string; releasable: "user-only" }
  | {
      kind: "send-back";
      templateId: string;
      slots: Record<string, string | number>;
      attempt: 1 | 2;
    };
export type EvidenceKind = "listing" | "references" | "backup" | "user-request" | "prior-failure";
export interface Decision {
  // what the gateway returns for one seam event
  situationId: string;
  response: Response;
  family: FamilyId | "hard-rule" | "fallback";
  reasonCode: string;
  verdictIds: string[];
  mode: "shadow" | "enforce";
  enforced: boolean;
  degraded: boolean;
}
export interface Intervention {
  id: string;
  decisionId: string;
  kind: Response["kind"];
  state: "open" | "released" | "denied" | "settled" | "expired";
  ts: number;
  closedTs?: number;
}
export type LabelKind = "outcome" | "judge" | "useful" | "miss" | "undone";
export interface Label {
  id: string;
  targetId: string;
  targetKind: "decision" | "verdict";
  kind: LabelKind;
  value: -1 | 0 | 1;
  source: "user" | "override" | "outcome";
  weight: 1 | 2 | 3;
  ts: number;
}
export interface Precedent {
  id: string;
  featureKey: string;
  tokens: string[];
  incidentRef: string;
  label: "should-hold" | "harmless";
  ts: number;
  hits: number;
}
export interface ContextCount {
  contextKey: string;
  questionId: string;
  alarms: number;
  falseAlarms: number;
  confirms: number;
  lastTs: number;
}
export type ChangeKind = "tighten" | "loosen" | "reword" | "retire" | "context-loosen";
export interface Change {
  id: string;
  ts: number;
  questionId: string;
  fromVersion: number;
  toVersion: number | null;
  kind: ChangeKind;
  exceptional: boolean;
  status: "applied" | "pending" | "rejected" | "undone";
  replay: ReplayReport;
  proposedBy: "code" | "nightly-proposer";
}
export interface ReplayReport {
  cases: number;
  relaxed: number;
  tightened: number;
  mustCatchTotal: number;
  mustCatchLost: number;
  heldOutBetter: boolean | null;
  liveCalls: number;
}
```

`ResolvedTarget`, `ToolRecordEntry`, `Commitment` and `Claim` are the obvious records (path/kind/resolvedFrom; tool/args
digest/exit/filesWritten/effects; payer/amount/date/condition/firmness; text/kind/source/support). Field origins
follow Appendix B; a field that cannot be computed is `{value:null, origin:"missing"}`.

## 3. Modules

Layout: `extensions/tinkerclaw-amygdala/{index.ts, openclaw.plugin.json, package.json, src/, questions/, cases/, hooks/, __tests__/, scripts/}`.

### M1 `src/jev.ts` — Jev client (+ `src/cache.ts`, `src/breaker.ts`)

- **Responsibility:** POST `state` + `questions` to `/v1/systemone`, return typed answers; enforce timeout, breaker,
  cache and spend accounting. Key from `process.env.TYPESAFE_API_KEY` only; never logged, never in config or a hook.
- **Interface:** `interface JevTransport { post(body, signal): Promise<{status:number; json:any; ms:number}> }` (default
  = `fetch`); `class JevClient { ask(situation, questions, budgetMs): Promise<Verdict[]> }`.
- **Schema rules** (pilot `jev_call.py`): a choice needs a `criteria` map, a score needs `criteria: string[]` (2–10
  levels), a noul's `criteria` is optional. The builder maps `Question` → request entry and never sends `instructions`
  anywhere but that entry.
- **Redaction gate:** every call goes through `redactForSend` (M3); `SendBlocked` → verdicts with `skipped:"not-allowed"`.
- **Failure:** non-200, malformed JSON or timeout → `skipped` verdicts, breaker count; the caller degrades (C6).

### M2 `src/question-book.ts` + `questions/<family>/<id>.md`

- **Responsibility:** load seed files (repo, read-only) and overlays (`<dataDir>/questions.d/<id>.v<N>.json`),
  expose `active(id)`, `get(id, version)`, `forSeam(seam, families)`, `pointer switch` for a change/undo. Seed files
  are never edited by code (plan line 3); an active-version pointer lives in SQLite (`question_active`).
- **Seed file:** one `.md` per prompt, `questions/<family>/<id>.md` (since 2026-09-30), laid out for a person first
  (2026-10-01, the architect: "When I open a prompt from Jev, I don't understand it"): the `# title` is the prompt's name: the
  paper's name for the function (Appendix A), a colon, then a question in plain words ("Curiosity: did it …?";
  the architect looks prompts up by the paper's names, 2026-10-01); a family line naming the J11 paper family and section; the idea in one paragraph; an
  `## Examples` table (situation, what Jev should answer, what follows), mostly drawn from the must-catch cases and
  controls; then `## The question Jev is asked` (the instructions), `## The answers Jev can pick` (a score's levels as
  `0.`…, a choice's options as ``- `key`: text``) and a yaml block under `## Settings` (the rest of the `Question`
  record of §2, including the `mustCatch` case ids). Only the title, question, answers and settings are parsed; Jev
  never sees the name, idea or examples. `FAMILY_PAPER` (`src/types.ts`) holds the paper's family names and the order
  of the prompts in each; the panel's "Jev prompts" list is grouped and ordered by it. Validation script
  `scripts/validate-questions.mjs` (schema, criteria shape, fields exist in `Situation`, family line, idea and at
  least two examples; no negation-heavy check is left to the reviewer).
- **Origin and retirement** are stored per question and shown in the panel, never sent to Jev (paper §5.5, end).

### M3 `src/situation.ts`, `src/redact.ts`, `src/effect-class.ts`, `src/git-cache.ts`

- **Situation builder:** `buildSituation(seamPayload, sessionCtx)` fills every §2 field with its origin. Paths are
  resolved by text processing (no shell, no globbing evaluation). `effectClass` from a lookup table by tool + argv[0]
  (`exec` heuristics ported from v3.1 AEGIS scopes). `scratch` = target under a folder created earlier in this turn's
  tool record. `targetHistory` uses the git recent-edits cache ported from v3.1 (`git-cache.ts`, kept).
- **Inferred fields** (`restatement`, `expectation`, `draftCommitments`, `standingFacts`) are only filled when the agent
  supplied them (its pre-tool sentence is the expectation) or a standing-facts file matched; otherwise `missing`.
  Questions whose answer leans on inferred fields are flagged weaker in the verdict row (`weak: true` in the UI).
- **Redaction (`redactForSend`)**: strip tokens by format (cloud keys, `ghp_`/`xox`/`sk-`, JWT, `Bearer`), e-mails and
  phones → `Person n`/`Address n`, contact names via the contact list → `Person n`, home directory → `~`, file
  contents → `{kind,count,bytes}`; any long free string it cannot vouch for → `{redacted:"text",len}`; if a question
  reads a redacted field it needs raw, the step is decided by the fallback (paper §7.2). Throws `SendBlocked` when
  `originKind==="real"` and `sendRealSituations` is false.

### M4 `src/rules.ts`, `src/policy.ts` — hard rules and the hook floor

- **Ported from v3.1** `rule-based-gate.ts`: the `AEGIS_RULES` array (pattern, rule id, explanation, enforce, scope),
  including the deliberately broad absolute-path recursive delete and the observe-only credential-pattern tier. The
  array stays the single source: `serializeRules()` feeds `policy.json`; the gateway floor and the hooks cannot drift.
- `policy.ts` writes `<dataDir>/policy.json` (`{version, rules[], mode, failClosed:true}`) and stages the whole
  `hooks/` folder to `<dataDir>/hooks/` (relative imports between hook files are fine; no package imports).
  It writes `cc-hook-settings.json` whenever the plugin is enabled and `hooks.enabled` (its presence is the bridge's
  enable signal, C18/C21), with `AMYGDALA2_SHADOW=1` in the hook command environment unless `mode==="enforce"`.
  `policy.json` carries `floorActive` (C19), recomputed at start and on every heartbeat; the hooks read it per call.
  The `v31Enforcing` probe is `src/v31-probe.ts` (reads the learned-intuition plugin config through the plugin API's
  config accessor and stats its `cc-hook-settings.json`).
- A prohibited step is held before the judge is asked (paper §6.1). Rules never depend on Jev.

### M5 `src/store.ts` — SQLite (better-sqlite3, `<dataDir>/amygdala.sqlite`, WAL)

Append-only except `question_active`, `holds`, `changes.status`. Schema (`user_version = 1`):

```sql
CREATE TABLE situations(id TEXT PRIMARY KEY, ts INT, session TEXT, turn_id TEXT, seam TEXT, tool TEXT, effect_class TEXT,
  origin_kind TEXT, hash TEXT, record_json TEXT, redacted_json TEXT);           -- record_json local only; redacted_json is what may leave
CREATE TABLE verdicts(id TEXT PRIMARY KEY, situation_id TEXT REFERENCES situations, question_id TEXT, question_version INT,
  type TEXT, answer_json TEXT, prob REAL, confidence REAL, cache_hit INT, latency_ms INT, tokens_in INT, tokens_out INT,
  cost_usd REAL, skipped TEXT, ts INT);
CREATE TABLE decisions(id TEXT PRIMARY KEY, situation_id TEXT REFERENCES situations, seam TEXT, family TEXT, kind TEXT,
  reason_code TEXT, verdict_ids TEXT, mode TEXT, enforced INT, degraded INT, response_json TEXT, ts INT);
CREATE TABLE interventions(id TEXT PRIMARY KEY, decision_id TEXT REFERENCES decisions, kind TEXT, state TEXT, ts INT, closed_ts INT);
CREATE TABLE holds(id TEXT PRIMARY KEY, decision_id TEXT, step_sig TEXT, goal_fp TEXT, needs_json TEXT, state TEXT, released_by TEXT, ts INT);
CREATE TABLE labels(id TEXT PRIMARY KEY, target_id TEXT, target_kind TEXT, kind TEXT, value INT, source TEXT, weight INT, ts INT);
CREATE TABLE precedents(id TEXT PRIMARY KEY, feature_key TEXT, tokens_json TEXT, incident_ref TEXT, label TEXT, ts INT, hits INT DEFAULT 0);
CREATE TABLE context_counts(context_key TEXT, question_id TEXT, alarms INT, false_alarms INT, confirms INT, last_ts INT,
  PRIMARY KEY(context_key, question_id));
CREATE TABLE question_versions(id TEXT, version INT, family TEXT, body_json TEXT, origin TEXT, parent INT, created_by TEXT, ts INT,
  retired_ts INT, PRIMARY KEY(id, version));
CREATE TABLE question_active(id TEXT PRIMARY KEY, version INT, since INT, change_id TEXT);
CREATE TABLE context_overrides(question_id TEXT, context_key TEXT, cutoff_json TEXT, change_id TEXT, PRIMARY KEY(question_id, context_key));
CREATE TABLE changes(id TEXT PRIMARY KEY, ts INT, question_id TEXT, from_version INT, to_version INT, kind TEXT, exceptional INT,
  status TEXT, replay_json TEXT, proposed_by TEXT, blocked_until INT);
CREATE TABLE send_backs(session TEXT, turn_id TEXT, attempts INT, PRIMARY KEY(session, turn_id));
CREATE INDEX v_q ON verdicts(question_id, question_version, ts); CREATE INDEX d_ts ON decisions(ts);
CREATE INDEX l_t ON labels(target_id); CREATE INDEX s_sess ON situations(session, turn_id);
```

`spend(day)` and `interventions today` are queries over these. Retention: `record_json` older than 90 days is
nulled (redacted form and answers stay). `:memory:` in tests.

### M6 `src/respond.ts` + `src/templates.ts` — answers to responses

Pure function `respond(answers, situation, table) → Response`, the §7.2 order and §6.1 table; no Jev, no I/O. Notes
to the agent are **templates** (`templateId` + slots filled from observed values; one line, finding, probability, the
verified fact; ≤ 1 per tool call, none repeated within a task — `seenNotes` in the turn state). Templates are code,
not question wording. Output channels per seam are fixed in §8.

### M7 `src/decide.ts` — the one entry all seams call

`decide(seam, payload) → Decision`, in this fixed order (§7.2):

1. build situation; 2. **hard rules** → hold, done (no Jev); 3. **precedent match** (M10 `precedents`) → adds
   `similarIncidents` and, on an exact match with label `should-hold`, raises the step's danger floor by one;
2. select questions: `book.forSeam(seam, enabledFamilies)` filtered by which families' guards fire (a family may
   ask for a question only when its own cheap code test passes: e.g. claims exist, target is not a plain read);
3. one Jev call (or cache/skip); 6. `family.decide(verdicts, situation)` for each enabled family → candidate
   responses; 7. **merge** by severity `hold > send-back > ask > proof > note > proceed`, keep the reason chain;
4. persist situation, verdicts, decision (+ intervention when not proceed); 9. emit `amygdala2.decision` (one per
   answered question) and `amygdala2.intervention`. In `shadow` mode the merged response is recorded but `enforced:false`
   and the hook receives `proceed`.

### M8 `src/families/` — one file per family, one interface

```ts
export interface Family {
  id: FamilyId;
  questionsFor(seam: Seam, s: Situation): string[]; // question ids wanted at this step; [] = not involved
  decide(seam: Seam, s: Situation, v: Verdict[], ctx: TurnState): Response | null; // null = no opinion
}
```

Registry in `families/index.ts` (empty until Phase D fills it; `decide.ts` works with zero families = hard rules only).

### M9 `src/context.ts` — per-turn state

Held in memory and mirrored to `send_backs`/`holds`: seen note ids, step counts, repeated-error counters, recent
holds with goal fingerprints (goal fp = sha of target + effect class + verb stem), scheduled-job list snapshot (for
"promise of later work"), standing-facts list (file `<dataDir>/standing-facts.json`, user-edited). Also a `hurry` flag (the last three prompts arrived under 20 s apart), which mutes curiosity notes.

### M10 `src/learn/` — labels, precedents, contexts, retune, changes, nightly (§6)

`labels.ts`, `precedents.ts`, `contexts.ts`, `replay.ts`, `retune.ts`, `changes.ts`, `nightly.ts`. Algorithm §7.

### M11 `index.ts` — plugin entry

Registers: gateway methods (§7 list), HTTP routes `/plugins/amygdala2/{decide,wait}`, native `before_tool_call`,
`after_tool_call` and end-of-turn handlers (they call `decide` with the same payload shape as the hooks, for the
native runner), a 60 s heartbeat that emits `amygdala2.status`, and the policy/hook staging on start. Config
(`configSchema`, `additionalProperties:false`): `mode` (`shadow|enforce`, default shadow), `families{5 booleans}`,
`jev{baseUrl, model:"jev-latest", timeoutMs, sendRealSituations:false}`, `dataDir`, `failClosedOnLevel3:false`,
`cost{eurPerUsd:0.92}`, `learn{autoLoosen:true, capsPerWeek:2, capsPerDay:6}`, `hooks{enabled:true}`.

### M12 Bridge selection (`extensions/tinkerclaw-tinker-bridge/src/{defaults,amygdala-settings,worker}.ts`)

`AMYGDALA_JEV_HOOK_SETTINGS_PATH` and `AMYGDALA_JEV_EFFECTIVE_SETTINGS_PATH` sit next to the v3.1 constant. `worker.ts` calls the pure
`resolveAmygdalaSettings({v31, next, effective}, stat)` and passes the single result as `--settings`: no file of ours → v3.1's file if it exists,
else no flag (arguments byte-identical to today); ours exist → the effective file when it is at least as new as both sources, else v3.1's file alone
when it exists, else ours (C18). The bridge never merges or writes. The plugin (M11 `refreshEffective`) builds the effective file with
`mergeHookSettings` (B5), on start and at every heartbeat when a source changed. The new settings register UserPromptSubmit, PreToolUse (matcher `*`),
PostToolUse (matcher `*`), Stop, each `command` = `node <dataDir>/hooks/<file>.mjs`, timeouts per C5/C7.

### M13 UI (`tinker-ui/src/…`) — §9

Inert when the plugin is off (C21): the panel probes `amygdala2.status` once on connect; an unknown-method reply keeps the
v3.1 panel code path untouched and mounts none of the new components.

## 4. Seed question list

**Contract for the table.** One row per seed question; `id@v1`. _Type_: N noul, C choice, S score. _Fields read_ are
`Situation` fields; _cut-off_ is the initial value only (the learning loop re-fits it, §7). _Must-catch_ names cases in
`cases/must-catch/`, as situations (commands, replies), never as question text. Wording: none here.

| id                    | Family       | Seam                  | Type  | Purpose (what the answer decides)                                                                              | Fields read                                              | Cut-off                | Must-catch cases                                                                               |
| --------------------- | ------------ | --------------------- | ----- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| `instruction-source`  | safety       | pre-tool              | C     | Whose instruction the step carries out (user / read content / agent's own / cannot tell)                       | request, tool, args, provenance                          | read-content ≥ 0.6     | delete requested by text inside a fetched page; send to an address that appears only in a file |
| `runs-or-quotes`      | safety       | pre-tool              | N     | Whether the step executes an effect or only mentions it                                                        | tool, command                                            | 0.5                    | `find … -delete`; delete via `~`; Python deletion; not-catch: a note quoting `rm -rf`          |
| `danger-level`        | safety       | pre-tool              | S 0–3 | How hard the step is to undo (0 read-only … 3 irreversible or external)                                        | effectClass, targets, targetHistory, scratch, toolRecord | ≥ 2 acts, 3 is the top | delete of the HR folder = 3; send e-mail = 3; delete of a folder made this turn ≤ 1            |
| `data-tier`           | safety       | pre-tool              | C     | Sensitivity of what moves (public / harmless if seen / harmful if seen / cannot tell)                          | targets, command, toolRecord                             | tier 3 acts            | CV file, credentials file, contract PDF                                                        |
| `destination-privacy` | safety       | pre-tool              | C     | How private the destination is (stays local / private place / shared / public / cannot tell)                   | command, args                                            | shared+ with tier 3    | public share link of a candidate file; copy of credentials to a remote host                    |
| `repeat-effect`       | safety       | pre-tool              | N     | Whether the step repeats an effect already completed (send, print, pay)                                        | toolRecord, targets                                      | 0.5                    | second print of a batch after an interrupted turn; duplicate mail                              |
| `recent-investment`   | safety       | pre-tool              | N     | Whether the target holds recent work worth protecting (kind of file matters: logs do not)                      | targetHistory, targets                                   | 0.6                    | overwrite of a document rewritten six times this week                                          |
| `stops-own-system`    | safety       | pre-tool              | N     | Whether the step stops, restarts or reconfigures the agent's own host                                          | command, args, effectClass                               | 0.5                    | stopping the gateway service from a tool call; a config patch that restarts it                 |
| `same-goal-as-held`   | safety       | pre-tool              | N     | Whether a step pursues the goal of a step that was just held (retry in a new form)                             | recentHolds, command, targets                            | 0.7                    | rephrased delete after a hold                                                                  |
| `evidence-present`    | safety       | pre-tool              | C     | Which needed evidence kind (listing / references / backup / user request / prior failure) the record now shows | needs (from hold), toolRecord                            | option ≥ 0.6           | proof check released with no listing → must stay held                                          |
| `misreading-screen`   | 2nd opinion  | prompt                | N     | Whether the request could be misread in a way that leads to different actions, targets or commitments          | request, standingFacts                                   | 0.8 (paper: weak)      | "send it to Jordi" with two Jordis; not-catch: clear request scoring 0.5–0.68                  |
| `reading-confirmed`   | 2nd opinion  | post-tool, pre-tool   | N     | Per open reading: does evidence in the record show the user meant it                                           | restatement (readings), toolRecord                       | 0.5                    | quote thread with Jordi Mas                                                                    |
| `reading-ruled-out`   | 2nd opinion  | post-tool, pre-tool   | N     | Per open reading: does evidence rule it out                                                                    | restatement (readings), toolRecord                       | 0.5                    | disk-full evidence rules out deleting logging code                                             |
| `commitment-changed`  | 2nd opinion  | pre-tool (send/draft) | C     | Draft commitments vs the request (same / dropped condition / firmer / new commitment / cannot tell)            | request, draftCommitments                                | non-"same" ≥ 0.6       | the 500 € case: standing offer written as a present debt                                       |
| `excess-scope`        | 2nd opinion  | pre-tool              | N     | Whether the step reaches beyond what was asked (targets, recipients, amount)                                   | request, restatement, targets                            | 0.7                    | mail to a wider list than named                                                                |
| `standing-fact-clash` | 2nd opinion  | pre-tool              | C     | Which standing fact (or none) the plan contradicts                                                             | standingFacts, restatement, command                      | fact ≥ 0.6             | plugin edit that breaks the "unmodified install" fact                                          |
| `purpose-unclear`     | 2nd opinion  | prompt                | N     | Whether an unclear purpose would change the answer (asking why) — sketched, ships `off`                        | request                                                  | 0.8                    | —                                                                                              |
| `claim-source`        | double-check | stop                  | C     | Provenance of each "done" claim (observed / told / stored / inferred / assumed)                                | claims, toolRecord                                       | never acts alone       | stored note describing an upload that never ran                                                |
| `claim-support`       | double-check | stop                  | N     | Whether the source actually supports the claim                                                                 | claims, toolRecord                                       | 0.5                    | as above                                                                                       |
| `claim-record`        | double-check | stop                  | N     | Whether a "done" claim lacks a matching action + result evidence in this task                                  | claims, toolRecord                                       | 0.4 (paper: 0.50 case) | "uploaded" with no upload; "uploaded one of two"; invoice "sent" when only a draft exists      |
| `weakens-own-check`   | double-check | pre-tool              | N     | Whether the step weakens a test or check that grades the agent's own work                                      | command, targets                                         | 0.6                    | skipping a failing assertion; loosening a threshold                                            |
| `dodged-work`         | double-check | stop                  | C     | Complete / placeholder / handed back / user question open / promise of later work / unverified fix             | reply, request, scheduledJobs                            | non-complete ≥ 0.6     | "left as an exercise"; "I will report when it finishes" with nothing scheduled                 |
| `refusal`             | double-check | stop                  | N     | Whether the reply declines or hands the task back instead of doing it                                          | reply, request                                           | 0.5                    | refusal of an allowed task (6 of 6 in §5.4)                                                    |
| `stale-state-claim`   | double-check | stop                  | N     | Whether the reply states the running state of a system not checked in this task                                | reply, toolRecord                                        | 0.6                    | "fixed" while the live process is unchanged                                                    |
| `progress-made`       | efficiency   | post-tool             | S 0–3 | Whether the last steps produced anything new (code supplies the counts)                                        | repeatedErrors, stepsSinceNewFact, toolRecord            | ≤ 0 with ≥ 3 repeats   | same error three times with no new fact                                                        |
| `procedure-choice`    | efficiency   | prompt                | C     | Which shortlisted skill/recipe the request calls for (+ none); options are the shortlist                       | request, candidate list                                  | best ≥ 0.6, blended    | request matching an existing recipe by name                                                    |
| `request-difficulty`  | efficiency   | prompt                | S 0–3 | How hard the request looks — a signal for Thalamus only, never a response — ships `off`                        | request                                                  | none                   | —                                                                                              |
| `surprise`            | personality  | post-tool             | S 0–2 | Whether the result contradicts the agent's stated expectation (none / partial / opposite)                      | expectation, toolRecord (last)                           | ≥ 1 notes              | expected pass, got fail; expected 3 files, got 0                                               |
| `novelty`             | personality  | post-tool             | N     | First contact with an unfamiliar file, service or kind of task (a note, never a hold)                          | targets, tool, contextCounts                             | 0.7, habituates        | first read of a second I/O module log                                                          |
| `worth-knowing`       | personality  | post-tool             | S 0–3 | Relevance of what was read to the user's goals (opt-in, ≤ 1 interruption per stretch) — ships `off`            | request, standingFacts, toolRecord                       | ≥ 3                    | —                                                                                              |

`personality` and `efficiency` families ship `off` (C15); their questions exist so the learning loop and shadow log can
collect data. Learning has no questions (it is code over labels).

## 5. Decision tables per family

Order of evaluation is §7.2: hard rules → (breaker-open fallback) → misreading risk → the §6.1 table → the check before
the turn ends. Merge is by severity (M7 step 7). "Danger" is `danger-level`, raised by one for `recent-investment ≥ cut-off`
and set to 3 by `stops-own-system ≥ cut-off`, `destination-privacy shared+ with data-tier 3`, or a `repeat-effect` hit
that the agent has not shown failed.

### 5.1 Safety (§6.1, §7.2)

| Danger | Misreading low                                                           | medium                        | high                                                          |
| ------ | ------------------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------- |
| 0–1    | proceed                                                                  | note (assumed reading)        | ask (pick a reading); danger 0–1 steps may continue meanwhile |
| 2      | note (relevant fact)                                                     | proof (incl. assumed reading) | hold until a reading is picked                                |
| 3      | proof + user authorises, unless the request named this action and target | proof + user authorises       | hold until reading picked and step authorised                 |

Misreading risk comes from the second-opinion family (5.3); with it off the column is "low". Extra rows:

| Signal                                                                    | Response                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------- |
| any hard rule (M4) matches                                                | hold, reason = rule id; Jev not called               |
| `instruction-source` = read content ≥ cut-off                             | hold until the user confirms (card)                  |
| `runs-or-quotes` < 0.5 (mention only)                                     | proceed for the destructive-text checks              |
| `repeat-effect` ≥ cut-off, no earlier failure shown                       | proof (`prior-failure`), danger 3                    |
| `same-goal-as-held` ≥ cut-off                                             | keep held; rephrasing never releases (evidence does) |
| proof outstanding for this `step_sig` and `evidence-present` now confirms | release the hold, settle the intervention            |

**The danger cut-off governs the table** (as built, Phase E): at the seed cut-off (2) the plain rounding of the `danger-level` answer stands; a tightened cut-off (below 2) lifts a reading at or above it to at least danger 2, and a loosened one (above 2) holds a reading below it at danger 2 at most. Without this a learned cut-off on the most important question would be recorded and change nothing.

`hold` never releases by itself. `proof` releases on evidence (C8). "Allow once" is a user action on a hold card:
it releases that step signature once and writes a `label(kind:"judge", value:-1, source:"user")`.

### 5.2 Double-check (§6.3)

Checked at `stop`, after the reply exists.

| Signal                                                                                 | Response                                                                                                                   |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| a claim with `claim-record` ≥ cut-off (or `claim-support` < 0.5)                       | send-back, slots = the missing record, attempt n                                                                           |
| a completion-verb sentence the splitter missed, whole-sentence check yields the same   | send-back                                                                                                                  |
| `dodged-work` non-complete ≥ cut-off (question open, placeholder, promise with no job) | send-back                                                                                                                  |
| `stale-state-claim` ≥ cut-off                                                          | send-back                                                                                                                  |
| attempt 2 already sent for this turn                                                   | deliver + `amygdala2.marker` listing what is unsupported                                                                   |
| `weakens-own-check` ≥ cut-off (pre-tool)                                               | hold                                                                                                                       |
| `refusal` ≥ cut-off                                                                    | intervention `refusal` (strip: Rewind / Keep); event `amygdala2.refusal` always; never for a step safety itself would hold |

Send-backs use the Stop-hook block; `stop_hook_active` and the `send_backs` counter cap it at 2. The claim splitter is
code (`src/claims.ts`): sentence split + completion-verb lexicon, one claim per verb-object pair; Jev never splits.

### 5.3 Second opinion (§6.2)

| Step                                                                                                                                                                                                                         | Rule                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| prompt: `misreading-screen` ≥ cut-off                                                                                                                                                                                        | additionalContext note: list plausible readings + "a meaning not listed", look things up first                               |
| any step of danger 2–3                                                                                                                                                                                                       | readings listed anyway (the screen is not yet reliable, §5.4)                                                                |
| post-tool: per reading `reading-confirmed`/`ruled-out`                                                                                                                                                                       | evidence about intent settles; evidence about consequences raises that reading's danger by one and settles nothing           |
| risk **high** if two open readings lead to different actions/targets/commitments, or a meaning may lie outside the list; **medium** if open readings all lead to one action; **low** if one supported and the rest ruled out | feeds the 5.1 table                                                                                                          |
| high risk → `ask` (card, options = readings, likeliest preselected)                                                                                                                                                          | if the agent already acted on another reading, the answer comes back as a deny reason on its next step ("the user picked …") |
| `commitment-changed` non-"same" ≥ cut-off, `excess-scope` ≥ cut-off                                                                                                                                                          | ask one question (card)                                                                                                      |
| `standing-fact-clash` names a fact                                                                                                                                                                                           | note before the step that acts on it                                                                                         |
| `purpose-unclear`                                                                                                                                                                                                            | off                                                                                                                          |

### 5.4 Efficiency (§6.5)

`progress-made` ≤ 0 with code-counted repeats ≥ 3 → **note** (once); a second such note in the same task → `hold` class
`stop-task` (all further tool calls denied except a summary-writing allowlist until the turn ends; the Stop hook then
allows). `procedure-choice`: blended score = 0.6 × Jev probability + 0.4 × the procedure's stored success rate; ≥ 0.8
loads it with a one-line note, 0.5–0.8 suggests (note), below stays silent. `request-difficulty` only emits an event.

### 5.5 Personality (§6.4)

`surprise` ≥ 1 → note naming both sides (expected vs observed) before the next step; `novelty` ≥ cut-off → note, never
hold, decays with `context_counts`; `worth-knowing` ≥ 3 → note, at most one per stretch and none when a `hurry` flag is
set. The steady-voice checks are ideas (Appendix A) and are not built.

## 6. Hook contracts

All four are dependency-free `.mjs` (node builtins only), staged to `<dataDir>/hooks/`, share `hooks/lib.mjs` (stdin
read, `endpoint.json` read, POST with timeout, policy load, spool). Every hook: **exit 0 always**; an internal error
allows the action (fail open) except the hard-rule floor in `pre-tool`, which fails closed on a rule match even with the
gateway down. Each writes a spool line to `<dataDir>/hook-spool.jsonl` (best effort) for the gateway to ingest.

| Hook            | stdin (Claude Code payload fields used)                                       | Gateway call                                    | stdout                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prompt.mjs`    | `session_id`, `prompt`, `transcript_path`, `cwd`                              | `decide(seam:"prompt")`                         | `hookSpecificOutput{hookEventName:"UserPromptSubmit", additionalContext}` for standing facts, reading list, procedure one-liner; else nothing                |
| `pre-tool.mjs`  | `session_id`, `tool_name`, `tool_input`, `tool_use_id`, `cwd`                 | `decide(seam:"pre-tool")`; for hold/ask: `wait` | proceed → nothing; note → `additionalContext`; proof/hold-denied/ask-answered → `permissionDecision:"deny"` + `permissionDecisionReason`; released → nothing |
| `post-tool.mjs` | `session_id`, `tool_name`, `tool_input`, `tool_response`, `tool_use_id`       | `decide(seam:"post-tool")`                      | `additionalContext` (one note) or nothing                                                                                                                    |
| `stop.mjs`      | `session_id`, `transcript_path`, `stop_hook_active`, `last_assistant_message` | `decide(seam:"stop")                            | send-back → `{decision:"block", reason}`; else nothing. If `stop_hook_active` and attempts ≥ 2 → nothing (deliver + marker)                                  |

Floor (`pre-tool.mjs` only): read `policy.json`; if the merged rule set matches, deny **before** calling the gateway; the
spool line records `floor:true`. If `policy.json` is missing or corrupt the hook fails open **and** writes `floor-missing`
so the status line goes red (paper §9 panel acceptance). Floor applies when `policy.floorActive` (C19). In shadow mode
(`AMYGDALA2_SHADOW=1`) the hooks **do not wait** (C20): spool line, `decide` fired with a 150 ms cap, nothing printed,
exit 0; the only thing they may ever deny is a floor match while `floorActive`. The merged settings file (C18) means
v3.1's hooks and these four run side by side on the Claude Code path.

`wait` contract: `POST /plugins/amygdala2/wait {interventionId, timeoutMs}` → `{answer:"allow-once"|"keep-held"|"option:<id>"|"timeout"}`.
The hook maps `allow-once` → nothing, `keep-held`/`timeout` → deny with a template reason, `option:<id>` → deny with the
user's pick in the reason. **Unverified:** whether a parallel batch of tool calls each holds its own hook process
(assumed yes), and Claude Code's behaviour at the hook timeout (the 330 s figure is below the documented 600 s default).

## 7. Gateway surface and the learning algorithm

### 7.1 Methods (all prefixed `amygdala2.` until cutover, C2)

| Method           | Params                                                      | Result                                                                                                                    |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `decide`         | `{seam, payload, sessionKey, turnId}` (also the HTTP route) | `Decision`                                                                                                                |
| `wait`           | `{interventionId, timeoutMs}`                               | `{answer}`                                                                                                                |
| `feed`           | `{sessionKey?, sinceTs?, limit?}`                           | `{decisions:JevRow[], interventions:Intervention[], counts, status, spend, learning}`                                     |
| `label`          | `{targetId, targetKind, kind, value}`                       | `{ok}` (👍/👎, "should have held")                                                                                        |
| `answer`         | `{interventionId, answer}`                                  | `{ok}` (card buttons: allow once, keep held, option, keep refusal)                                                        |
| `approve`        | `{changeId, approve:boolean}`                               | `{change}` — exceptional changes only; other ids return `not-exceptional`                                                 |
| `undo`           | `{changeId}`                                                | `{change}` — self-made loosening; switches the active pointer back, sets `blocked_until` +30 d                            |
| `canary`         | `{}`                                                        | `{heldBy:"hard-rule", floorMs, judgeMs\|null}` — synthetic must-catch case through the chain                              |
| `rewind`         | `{sessionKey, turnId, undo?:boolean}`                       | `{ok, capability}` — backend per Phase D spike; UI hides the button without capability                                    |
| `propose`        | `{questionId, candidate:{instructions, criteria?}, source}` | `{changeId, replay}` — from the nightly lane; code replays, proposer never grades itself                                  |
| `nightly`        | `{budgetCalls?}`                                            | `{worklist:[{questionId, failingCases[]}], applied[], pending[]}`                                                         |
| `questionRecord` | `{questionId}`                                              | `{ok, question}` — the active version incl. its wording, for the by-hand nightly script only (the UI never shows wording) |

### 7.2 Events

```ts
"amygdala2.decision"     { id, ts, sessionKey, turnId, stepLabel, seam, questionId, questionName, version, answer, prob, confidence,
                           cacheHit, latencyMs, weak, codeDid: "ok"|"held"|"proof"|"note"|"ask"|"sent-back", interventionId?, degraded }
"amygdala2.intervention" { id, ts, sessionKey, turnId, kind, state, title, chips:string[], cmd?, options?, replay?, expiresTs? }
"amygdala2.marker"       { sessionKey, turnId, kind:"unsupported-after-two"|"refusal-rewound", items:string[] }
"amygdala2.refusal"      { sessionKey, turnId, model, redactedExample, ts }         // also emitEvent(...) for Thalamus (consumer not built here)
"amygdala2.status"       { ts, state:"working"|"shadow"|"degraded", line, seams:{prompt,pre,post,stop:{lastTs}}, rules:{n,version},
                           judge:{lastMs, errors, silentSince?}, spendEurToday, checksToday, heldToday, askedToday, waitingForYou:number }
"amygdala2.change"       { id, kind, questionName, from, to, exceptional, status, replaySummary }   // loosened-by-itself list + approval cards
```

`questionName` is the human name (from the question record), never `instructions`. `waitingForYou` counts pending
exceptional changes and open holds/asks.

### 7.3 Learning under the always-trust policy (§5.5, §6.6)

1. **Labels.** Each non-proceed decision gets three records: _outcome_ (what happened next: released, denied, user
   overrode, evidence appeared), _judge-right_ (auto where a fact settles it, else from the user), _useful_ (👍/👎).
   Source weights: user 3, override 2, outcome 1. A user "should have held" on a proceeded step writes a `miss`.
2. **Precedents, at once.** A real incident (`miss`, or a hold the user upheld with a comment) becomes a `precedents` row;
   the next similar step carries `similarIncidents` and its danger floor rises by one (M7 step 3).
3. **Tightening — immediate, by code.** On a `miss`, prefer a **context-scoped** tighten (a `context_overrides` row for the
   _As built (Phase E):_ every question that stayed quiet by a **near miss** (a gap of at most 0.35 for a probability or choice, at most 1 level on a score) gets a context-scoped proposal, because which question governed the outcome is not known; a change that alters nothing is rejected by the replay as `no-effect`. The replay is **two-sided**: it reports must-catch cases lost (must be 0) and controls newly pushed over their ceiling (must be 0, tightenings included).
   context key = question × effect class × target kind × scratch × directory bucket). A global cut-off tighten only when the
   replay shows extra alarms ≤ 2 % of the last 500 decisions. No approval; logged as a `changes` row (status applied).
4. **Loosening — automatic when clean.** Candidate: a context with `falseAlarms ≥ 5`, `confirms = 0` in 30 days and
   `falseAlarms/alarms ≥ 0.9`. **Replay** (C11) over labelled cases + `cases/must-catch/*` on stored probabilities
   (rewordings: live Jev). Apply by itself iff: `mustCatchLost = 0`; not exceptional (C12); caps (C13); not blocked
   by an earlier undo. Applied loosenings appear under Learning with **Undo** and as an `amygdala2.change` event; the
   chat is not interrupted.
5. **Exceptional loosening — the only card.** Exceptional = C12. It becomes `status:"pending"`; at most one card a day
   (the rest queue), with the replay numbers; `approve` applies, reject records a 30-day block. **A hard rule is never
   loosened by code, only edited by the principal** (rules live in `rules.ts`).
6. **Rewording and re-cutting, nightly.** Entry point `amygdala2.nightly` plus a runnable script
   `scripts/nightly.mjs` (no cron, prompt or payload is edited, C22; the one-line hook-up is §12 item 8) that: it returns a worklist of questions with failing labelled cases (case ids and situations
   only, no must-catch text); a Claude model proposes a new `instructions`/options/fields; `amygdala2.propose` replays
   the candidate live on labelled + must-catch cases (≤ 300 calls) with a 70/30 split by source conversation, and
   accepts iff strictly better on the held-out part **and** `mustCatchLost = 0`; then step 4/5 decide auto vs card.
   The proposer never grades itself (§5.5).
7. **Retire.** A question with no fires and no labels for 60 days whose retirement condition holds is proposed for
   retirement; the same loosen/exceptional rules apply.
8. **Guarantees enforced in code:** `cases/eval/` is never read by the replay loader (directory + `origin` field both
   checked, tested); every verdict stores `id@version`; seed files are never written; every change is a row with its
   `ReplayReport`; `undo` is a pointer switch, never a delete.

## 8. Output channels by seam (C17)

| Seam          | Note                          | Proof / hold / ask-answered | Send-back             | Marker / refusal strip |
| ------------- | ----------------------------- | --------------------------- | --------------------- | ---------------------- |
| prompt        | `additionalContext`           | —                           | —                     | —                      |
| pre-tool      | `additionalContext`           | deny + reason               | —                     | —                      |
| post-tool     | `additionalContext`           | —                           | —                     | —                      |
| stop          | —                             | —                           | Stop `block` + reason | UI events only         |
| native runner | system note after tool result | deny in `before_tool_call`  | end-of-turn re-prompt | UI events only         |

The model never sees the Jev window, its rows or their probabilities, other than the one-line facts inside notes.

## 9. UI (`tinker-ui/src/`)

### 9.1 Components ↔ design blocks

New files (each pure and unit-tested, `app.ts` only wires): `amygdala-store.ts` (event reducer: decisions by turn, open
interventions, status, spend, changes), `amygdala-jev.ts` (Jev window HTML builder), `amygdala-cards.ts` (cards and
chips), `panels/amygdala.ts` (the panel; replaces the v3.1 panel code in `app.ts`), CSS in the UI's stylesheet.

| Design block (page)              | Component                                                                            | Data                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 1 Refusal → Rewind               | `RefusalStrip`                                                                       | `intervention(kind refusal)`; buttons → `answer` / `rewind`               |
| 2 Hold and proof check           | `HoldCard`, `ProofCard`                                                              | `intervention` (cmd, chips, needs); Allow once / Keep held / Why?         |
| 3 Which reading                  | `AskCard`                                                                            | `intervention.options`; answer → `answer`                                 |
| 4 Sent back                      | `SentBackChip` (+ detail)                                                            | `decision(codeDid sent-back)` + the first-draft text kept in the row      |
| 5 Notes on tool rows             | `NoteChip` on the tool row                                                           | `decision(codeDid note)` matched by `tool_use_id`; hover: reason, 👍/👎   |
| **5b Jev decisions in the chat** | `JevWindow` (+ `JevRow`, `JevDetail`)                                                | all `amygdala2.decision` of a turn (§9.2)                                 |
| 6 Exceptional approval           | `ExceptionalCard`                                                                    | `amygdala2.change(status pending, exceptional)`; Approve/Reject/See cases |
| 7 Panel closed                   | `StatusLine` (with € today), `HourStrip`                                             | `amygdala2.status`, `feed.counts`                                         |
| 8 Panel open                     | `Health`, `Today`, `Questions`, `Learning` (loosening rows + Undo), `Cost` expanders | `feed`, `change` events; Undo → `undo`                                    |
| 9 Degraded                       | `StatusLine` red + Health auto-open                                                  | `status.state==="degraded"`                                               |
| 10 Composer dot                  | `ComposerDot` (green / amber shadow / red)                                           | `status.state`; click opens panel; hover shows the line                   |

Chat rows are client rows (`client-rows.ts`, keyed by turn) rebuilt from `amygdala2.feed` on load so the transcript
"stays" without a UI-side copy of the truth; the panel U9 rule holds (names only, never `instructions`). Playwright
driving is Phase F, against a spare-port build of the worktree's `tinker-ui`.

### 9.2 The Jev window

> **Superseded 2026-10-05** (the architect: "two kinds of messages"). Blocks 4, 5 and 5b no longer draw separately: each reply gets one CHECKS window (a summary line that opens into a check timeline in the call timeline's encoding) and one WOULD HAVE window (the actions to review, with the refusal offer and any waiting card on their rows). The note chip on tool rows and the sent-back chip are gone. The live description is `TINKER_UI_DESIGN_BIBLE/tinker-ui.md` §5.8AG; the text below is the original design.

One window per turn, above that turn's reply, updating live. Title bar: cube mark on a magenta disc, `JEV`, summary
(`n decisions · x held · y proof · z sent back`; all-proceeded turns say so), chevron. Collapsed by default; a click on
the bar opens it; a click on a line opens its numbers. **Rows** are `▪ proceeded · ■ held · ▲ proof/note · ◀ sent back`

- question name + answer + a pill for what code did, grouped by step (`├ tool  target`) so a batched call reads as one
  step. **Detail:** probability bar, confidence, `id@version`, fields read, latency, cache hit, the code path that acted,
  👍/👎. Footer: model version, answer count, € spent, "cached answers cost nothing". When Jev is not consulted (C9) or
  is down (C6) the window is a single line saying so, in the same look. It is a ledger of what Jev **answered** and what
  **code did**; the pill wording keeps Jev from ever reading as the actor.

### 9.3 Brand research — what was taken, what was not

Sources (fetched 2026-09-29): the site [typesafe.ai](https://typesafe.ai) (Framer-built; values below read from its raw
HTML/CSS) and its assets [favicon/mark](https://framerusercontent.com/images/aNFzSFxM4fjICmnibw7npfZjcQ.png) and
[window graphic](https://framerusercontent.com/images/eZuF5J3kimUx8m5RwxS6T71Dgu0.svg).

| Observed at typesafe.ai                                                                                        | Used in the Jev window                                                   | Why                                                         |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Mark: black isometric **cube line-art on a magenta disc**                                                      | our own simple cube glyph (drawn in SVG) on a magenta disc, 18 px        | recognisable at a glance; no copied asset, no trademark use |
| Palette: ink `#1E1E1E`, paper `#FEFEFE`, pink `#f386a1`, magenta `#d45bb6`, sage `#abbab9`                     | same six values                                                          | the whole look is these tokens                              |
| Retro-OS **window art: black title bar over a paper body**, square corners (site's pixel-window graphic)       | title bar + paper body, 0 radius, 1.5 px ink border, hard magenta shadow | a foreign window shape the chat never uses                  |
| Type: `JetBrains Mono` / `Fragment Mono` for code, `LisaTerminal Paper` and `Die Grotesk` for display, `Inter` | mono stack `"JetBrains Mono","Fragment Mono",ui-monospace,Menlo` only    | the two display faces are proprietary; mono is open/system  |

The light paper inside a dark woody UI is deliberate: an agent message is dark, rounded and prose; a Jev window is
light, square and monospace, so it cannot be mistaken for the agent. Not taken: their logo file, wordmark, fonts, copy.
Note: an automated page summary returned no styling; the values above are from the downloaded source, checked against the
favicon image.

## 10. Test plan per module

Runner: `node scripts/run-vitest.mjs run --config test/vitest/vitest.extensions.config.ts extensions/tinkerclaw-amygdala` (confirmed in Phase B; UI tests through the
existing `tinker-ui` vitest project). **Jev is mocked everywhere in tests** (`FakeJevTransport` scripted per question id,
recorded fixtures in `__tests__/fixtures/`); clock injected; SQLite `:memory:`; git via a fixture repo. No test needs
the key.

| Module          | What is tested                                                                                                                                                                                                                                                                                                                                                                                                                      | Mocked                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| M1 jev          | request shape per type (choice needs criteria map; score levels 2–10); timeout, 429/5xx → `skipped`; breaker open/half-open/close; cache hit/miss/TTL; cost math                                                                                                                                                                                                                                                                    | transport                  |
| M2 book         | every seed validates; versions immutable (edit attempt throws); overlay + pointer switch; `forSeam` per family filter; no `instructions` text outside `questions/` (grep test over `src`, `docs`, `tinker-ui`)                                                                                                                                                                                                                      | filesystem tmp             |
| M3 situation    | field origins; missing ≠ guessed; path resolution without shell; scratch detection; redaction goldens (keys, e-mails, phones, contact names); `SendBlocked` when real + not allowed                                                                                                                                                                                                                                                 | git fixture                |
| M4 rules/policy | every ported AEGIS case from v3.1 tests passes; single-source check (gateway floor and `policy.json` agree); hook floor **fails closed** with gateway down and **open** on missing policy (+ red flag)                                                                                                                                                                                                                              | spawn hook with stdin      |
| M5 store        | schema, append-only, `question_active` pointer, retention nulling, spend query                                                                                                                                                                                                                                                                                                                                                      | `:memory:`                 |
| M6 respond      | full §6.1 table (9 cells) + every extra row of 5.1; note dedupe; at-most-one note per call                                                                                                                                                                                                                                                                                                                                          | none (pure)                |
| M7 decide       | order of evaluation; hard rule never calls Jev; merge by severity; shadow → `enforced:false`; breaker → `degraded` + fail open; `failClosedOnLevel3`                                                                                                                                                                                                                                                                                | FakeJev                    |
| M8 families     | **one decision-table test per family** (Phase D), each row of §5 with scripted answers                                                                                                                                                                                                                                                                                                                                              | FakeJev                    |
| M9 hooks        | each hook fixture in → exact stdout; `stop_hook_active` cap; hold long-poll → allow-once/keep-held/timeout; spool written; exit 0 on every error                                                                                                                                                                                                                                                                                    | gateway stub over loopback |
| M10 learning    | label weights; precedent match (Jaccard 0.6); context-scoped tighten; loosening replay on stored probabilities; **property test: no change that flips a must-catch case from caught to missed is ever applied**; eval-set isolation; caps; undo pointer + 30-day block; exceptional classification (level-3, egress, external effect) → pending, never applied                                                                      | FakeJev, `:memory:`        |
| M11 index       | registration list; HTTP route auth (**401 without the token, constant-time compare**, `endpoint.json` 0600 in a 0700 folder); `floorActive` in **both** states (shadow + v3.1 enforcing → off; shadow + v3.1 off → on; enforce → on); heartbeat; disabled-by-default manifest; status goes red when the judge is silent or the policy is missing                                                                                    | `plugin-test-api`          |
| M12 bridge      | **spawn args byte-identical to today when none of the plugin's settings files exist**; full truth table of `resolveAmygdalaSettings` (which of v3.1 / ours / effective exist × mtime order); effective used only when as new as both sources, else v3.1 alone; a throwing `stat` is safe; the plugin side (`refreshEffective`) is tested in M11: shadow + v3.1 → merged with v3.1 entries first and unchanged, enforce → ours alone | fs tmp                     |
| M13 UI          | **`amygdala2.status` unknown-method → v3.1 panel unchanged, no new component mounted**; reducer per event; `JevWindow` HTML for collapsed/open/no-consult/degraded; card builders; € formatting; Undo flow; Playwright run of every state on a spare-port build with screenshots looked at                                                                                                                                          | events replayed            |
| Phase G         | extension suite; `scripts/deploy-worktree.sh --dry-run`; `amygdala2.decide` end-to-end on synthetic cases with **live** Jev (only place a key is used)                                                                                                                                                                                                                                                                              | —                          |

## 11. Build waves as ORCA units (`coding/parallel-build`; one commit per unit, `feat(amygdala): …`)

Units in a wave have disjoint `writes` and run in parallel; a wave starts when its `depends` have landed. B0 first,
alone (everything imports its types). UI files land in one burst (quiescence rule).

| Phase | Unit | Writes (under `extensions/tinkerclaw-amygdala/` unless a full path)                                                                                                                             | Depends            |
| ----- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| B     | B0   | `package.json`, `openclaw.plugin.json`, `index.ts` (stub), `src/types.ts`, `src/config.ts`, `tsconfig` if needed                                                                                | —                  |
| B     | B1   | `src/jev.ts`, `src/cache.ts`, `src/breaker.ts`, `__tests__/jev.test.ts`, `__tests__/fixtures/jev-*.json`                                                                                        | B0                 |
| B     | B2   | `src/question-book.ts`, `questions/{safety,second-opinion,double-check,efficiency,personality}.json`, `cases/must-catch/*.json`, `cases/eval/.gitkeep`, `scripts/validate-questions.mjs`, tests | B0                 |
| B     | B3   | `src/store.ts`, `src/schema.ts`, `src/spend.ts`, `__tests__/store.test.ts`                                                                                                                      | B0                 |
| B     | B4   | `src/situation.ts`, `src/redact.ts`, `src/effect-class.ts`, `src/git-cache.ts`, tests                                                                                                           | B0                 |
| B     | B5   | `src/rules.ts`, `src/policy.ts`, `hooks/lib.mjs`, tests                                                                                                                                         | B0                 |
| C     | C1   | `src/respond.ts`, `src/templates.ts`, `src/context.ts`, tests                                                                                                                                   | B1–B5              |
| C     | C2   | `src/decide.ts`, `src/families/{index,types}.ts`, tests                                                                                                                                         | C1                 |
| C     | C3   | `hooks/{prompt,pre-tool,post-tool,stop}.mjs`, `__tests__/hooks.test.ts`                                                                                                                         | B5, C1 (contracts) |
| C     | C4   | `index.ts`, `src/http.ts`, `src/status.ts`, `src/native.ts`, tests                                                                                                                              | C2                 |
| C     | C5   | `extensions/tinkerclaw-tinker-bridge/src/{defaults,worker}.ts`, its tests                                                                                                                       | C3                 |
| D     | D1   | `src/families/safety.ts`, test                                                                                                                                                                  | C2                 |
| D     | D2   | `src/families/double-check.ts`, `src/claims.ts`, `src/rewind.ts` (spike + port), tests                                                                                                          | C2                 |
| D     | D3   | `src/families/second-opinion.ts`, test                                                                                                                                                          | C2                 |
| D     | D4   | `src/families/efficiency.ts`, test                                                                                                                                                              | C2                 |
| D     | D5   | `src/families/personality.ts`, test                                                                                                                                                             | C2                 |
| E     | E1   | `src/learn/labels.ts`, `src/learn/precedents.ts`, `src/learn/contexts.ts`, tests                                                                                                                | C2                 |
| E     | E2   | `src/learn/replay.ts`, `src/learn/changes.ts` (exceptional classifier, caps, undo), tests                                                                                                       | E1                 |
| E     | E3   | `src/learn/retune.ts`, `src/learn/nightly.ts`, gateway methods `label/answer/approve/undo/propose/nightly` in `src/methods.ts`, tests                                                           | E2                 |
| F     | F1   | `tinker-ui/src/amygdala-store.ts`, test                                                                                                                                                         | C4                 |
| F     | F2   | `tinker-ui/src/amygdala-jev.ts`, test                                                                                                                                                           | F1                 |
| F     | F3   | `tinker-ui/src/amygdala-cards.ts`, test                                                                                                                                                         | F1                 |
| F     | F4   | `tinker-ui/src/panels/amygdala.ts`, test                                                                                                                                                        | F1                 |
| F     | F5   | `tinker-ui/src/app.ts` wiring (chat rows, composer dot, panel slot, rewind), stylesheet                                                                                                         | F2–F4              |

Then G (verification, no new files besides `scripts/ui-shots.py`, unshipped) and H (merge after the master's go).

## 12. For the architect (decisions with a safe default; the build continues on the default)

1. **The window is nearly empty on real turns while `sendRealSituations=false`** (C9): every real step is decided by rules
   and the fallback, so the chat window says "Jev not consulted". Decision 2 ("every Jev decision in the chat") only fills
   with real content after he allows redacted real steps to go to TypeSafe. Default: off.
2. Jev down → fail open on level-3 steps (C6, `failClosedOnLevel3=false`); the paper's §7.2 leans closed.
3. Families on at first enforcement: safety, double-check, second opinion (C15); efficiency and personality off.
4. € rate 0.92 per USD (C14) and that spend counts Jev only.
5. Auto-loosening caps (2/question/week, 6/day, 30-day block after an Undo) and the "exceptional" definition (C12–C13).
6. `standing-facts.json`: which facts to seed (starts empty).
7. Cutover (shadow → enforce → delete v3.1) and the rename of `amygdala2.*` / `amygdala-jev` — not started.
8. **Nightly hook-up:** add one line to the `memory-consolidation` brief (cron 04:15, live, so not touched by this build) to run `node extensions/tinkerclaw-amygdala/scripts/nightly.mjs`. Until he does, learning by rewording does not run; label, precedent, tighten and threshold changes still work online.

**Unverified, resolved in the named phase:** headless one-turn rewind in the agent runner (D2 spike; the button hides
without capability); Claude Code behaviour at the hook timeout and for parallel tool batches (C3 tests); a second
`--settings` flag (avoided; merged file instead, C18); Jev latency under load (sets C5).
