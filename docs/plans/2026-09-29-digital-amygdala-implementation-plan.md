# Digital amygdala — implementation plan (passes 1–2)

**What this is for.** Build the design of J11 _AMYGDALA_ v6.7 and replace AMYGDALA v3.1
(`extensions/tinkerclaw-learned-intuition`) completely. It records the implementation choices and why; the design
itself is in the paper and is pointed to by section, not repeated. **Derived from** the v6.7 paper, the v3.1 code
as it stands on 2026-09-29, and the Jev pilot in the J11 folder. **What would change it:** the principal's open
decisions (end of this file), Jev's latency in use, or a paper revision that moves a family. Pass 1 is the choices,
pass 2 the UI; no test plan yet. Recipe: `extensions/tinkerclaw-prefrontal/recipes/big-software-design-by-phases/recipe.md`.

## Shape

One new extension, `extensions/tinkerclaw-amygdala`, owns everything: the Jev client, the question book, the
situation record, the hard rules, the response logic, the record store and the learning loop. The model-facing
seams are thin: Claude Code hooks (cc-bridge) and the native runner's tool hooks both ask the gateway
`amygdala.decide` and apply its answer. The Tinker UI panel shows interventions, collects labels and approvals,
and turns red when the rule list or Jev goes silent (paper §9, panel acceptance).

## Choices

| #   | Choice                                                                                                                                                                                                                                                                                                                                                                                       | Why                                                                                                                                                      | Instead of                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | New extension; delete `learned-intuition` after cutover                                                                                                                                                                                                                                                                                                                                      | v3.1's core (embeddings, ONNX ensemble, PPO training) has nothing Jev-shaped; rewriting is smaller than migrating 5k lines of dead paths and their tests | refactoring v3.1 in place                                                         |
| 2   | All logic in the gateway; hooks call `amygdala.decide` over loopback                                                                                                                                                                                                                                                                                                                         | one process holds the key, the book, the record and the learning; hooks stay dependency-free, as today                                                   | calling Jev from each hook (key inside the CLI sandbox, no shared state)          |
| 3   | Hard rules also compiled into the hook (`policy.json`, as v3.1 does)                                                                                                                                                                                                                                                                                                                         | the floor must hold when the gateway or Jev is down: **fail closed on hard rules, fail open on judge checks**, logged, status line red                   | fail-open everywhere (v3.1) or fail-closed on a TypeSafe outage (blocks all work) |
| 4   | One Jev call per seam event, batching every question that point needs; cache on (question id@version, situation hash)                                                                                                                                                                                                                                                                        | latency and cost are per call; the same command recurs constantly                                                                                        | one call per question                                                             |
| 5   | Question book = seed files in the repo + learned overlays in the data dir; versions immutable; every verdict stores `id@version`                                                                                                                                                                                                                                                             | §5.5: the wording in use is the wording on record; one user's learning stays out of the public repo                                                      | editing seed files in place (the edited-copy-is-not-the-running-copy trap)        |
| 6   | One SQLite file (better-sqlite3, already a dependency), append-only tables: situations, verdicts, responses, labels, precedents, context counts, question versions                                                                                                                                                                                                                           | replay and re-fitting cut-offs are joins and queries                                                                                                     | JSONL spools (v3.1): fine to log, poor to replay                                  |
| 7   | Code maps answers to responses (`respond.ts`, the §7.2 order and the §6.1 proof table); Jev only answers                                                                                                                                                                                                                                                                                     | the paper's rule; responses become testable without Jev                                                                                                  | letting the judge choose the response                                             |
| 8   | Model-facing output only through hook channels (deny reason, `additionalContext`, Stop block) and native system notes                                                                                                                                                                                                                                                                        | the verified seams (J11 notes, "Efferent path"); never `worker.steer` (reads as the user), never `updatedInput` (the guard would author the action)      | a side channel into the transcript                                                |
| 9   | Questions for the user go through a Tinker UI card with options, not the hook's `ask`                                                                                                                                                                                                                                                                                                        | the headless bridge has no human at the CLI prompt                                                                                                       | hook `ask`                                                                        |
| 10  | Learning: labels online; tightening applied at once by code; rewording and re-cutting run in the nightly consolidation lane (J5) with a Claude model proposing and code replaying; loosening applies by itself when its replay loses no must-catch case (logged, one-click undo), and becomes an approval card only when exceptional (danger level 3, data leaving the machine, a hard rule) | reuses the nightly lane; the proposer never grades itself (§5.5, §6.6)                                                                                   | a separate scheduler, or self-approved changes                                    |
| 11  | Model choice and thinking effort stay with Thalamus; the amygdala emits refusal and futility events for it                                                                                                                                                                                                                                                                                   | ownership set by the principal on 2026-09-28                                                                                                             | the amygdala switching models                                                     |
| 12  | Config is staged for the next gateway start, never toggled live from a chat                                                                                                                                                                                                                                                                                                                  | a plugin toggle restarts the gateway about 15 min later and kills live turns                                                                             | editing `plugins.*` live                                                          |
| 13  | A situation leaves the machine only after redaction, behind `jev.sendRealSituations` (default off)                                                                                                                                                                                                                                                                                           | whether redacted real commands may go to TypeSafe is the principal's open decision                                                                       | sending by default                                                                |

## Modules

`extensions/tinkerclaw-amygdala/`:

- `src/jev.ts`: client for TypeSafe `systemone` (`state` + `questions` → typed answers), key from the gateway
  environment, timeout budget, cache.
- `questions/<family>/<id>.md` (one file per prompt since 2026-09-30) + `src/question-book.ts`: seed questions (type, options or criteria, fields read, cut-off,
  purpose, origin, retirement condition, must-catch cases) and overlay loading. Wording habits: paper §5.5.
- `src/situation.ts` + `src/redact.ts`: the record of §7.1 (observed / derived / inferred), missing fields marked,
  never guessed; secrets and names removed before any send.
- `src/rules.ts`: hard rules, ported from v3.1 AEGIS (`src/rule-based-gate.ts`); `src/policy.ts` compiles them
  for the hook.
- `src/respond.ts`: answers → proceed / note / proof check / ask / hold / stop.
- `src/families/`: `safety.ts`, `double-check.ts`, `second-opinion.ts`, `efficiency.ts`, `personality.ts`; each
  declares its seams, the questions it needs there, and its response rules.
- `src/store.ts`: the SQLite record. `src/learn/`: `labels.ts`, `precedents.ts`, `contexts.ts`, `retune.ts`.
- `hooks/`: `prompt.mjs` (UserPromptSubmit), `pre-tool.mjs` (PreToolUse), `post-tool.mjs` (PostToolUse), `stop.mjs`
  (Stop), each a thin client with the local hard-rule floor.
- `index.ts`: gateway methods `amygdala.decide`, `amygdala.feed`, `amygdala.label`, `amygdala.approve`; native
  `before_tool_call` / `after_tool_call` / end-of-turn handlers.

Elsewhere: `extensions/tinkerclaw-tinker-bridge/src/{defaults,worker}.ts` (register four hooks instead of one);
`tinker-ui` panel (feed, label buttons, approval card, status line); Thalamus consumes the refusal events.

## Build order

1. **Foundations, in parallel:** Jev client + question book; store; situation + redaction; hard rules + policy
   compile.
2. **Seams:** `amygdala.decide`, `respond.ts`, the four hook clients, the native handlers, the bridge
   registration.
3. **Families**, one unit each: safety, double-check (claims at Stop; refusals → rewind offer in the UI + a
   Thalamus event), second opinion; then efficiency and personality, the least specified (paper §8.2).
4. **Learning:** labels from outcomes, overrides and the panel; precedents; per-context counts; the retune job in
   the nightly lane; approval cards.
5. **Panel.**
6. **Cutover:** the new extension runs in shadow (decides and logs, enforces nothing) beside v3.1, which keeps
   enforcing; compare their decisions; then stage the switch (v3.1 off, new enforcement on) for a gateway start;
   then delete v3.1.

**Kept from v3.1:** the AEGIS rule set, the policy-compile-for-the-hook pattern, the git recent-edits cache (the
"heavily edited recently" field), the decision spool idea, the panel slot. **Deleted:** the ONNX ensemble and its
model directory, embeddings and k-NN novelty, the incongruity check, the personality decoder and seed,
distribution shift, `training/amygdala/` (PPO, distillation, nightly trainer), `TRAINING.md`, and the v3.1 config
keys.

## Lines not to cross

- The hard-rule floor never lapses: v3.1 enforces until the new enforcement is staged; the hook's local rules
  fail closed, judge checks fail open and turn the status red.
- The Jev key stays in the gateway; hooks never call Jev.
- Seed questions are never edited in place; tightening is automatic; loosening is automatic only when its replay
  loses no must-catch case and it is not exceptional (level 3, data leaving, a hard rule: those need approval, and
  hard rules never loosen by themselves); evaluation cases never enter the replay set.
- The removal of v3.1 is its own commit, after the new extension is proven to enforce.

## Pass 2: UI

Design page (pass 3, adds block 5b) with a feedback box per mock-up: <http://127.0.0.1:18797/>, served from
`~/Documents/AI_reports/Papers/J11_learned_intuition/ui-design/` (service `amygdala-ui-design`; feedback saves
in `feedback/`).

| #   | Choice                                                                                                                                                                                                                                                                            | Why                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | The panel stays quiet: steps that proceed are counted, never listed there. **The chat shows every Jev decision**, one small line per answered question, grouped per turn in one window, collapsed by default (design block 5b)                                                    | v3.1's panel lists every tool call so nobody reads it; the principal wants the chat to be honest about every decision, in a look that cannot pass for the agent (2026-09-29 17:34) |
| U2  | Interventions appear in the chat where the step happened (hold, proof check, ask, sent-back chip, notes on tool rows)                                                                                                                                                             | the context is right there; the panel is for health and history                                                                                                                    |
| U3  | A refusal gets a strip with **Rewind** and **Keep**. Rewind drops the prompt and the reply from the model's context, leaves a marker with Undo in the display, and puts the prompt back in the composer; the refusal event goes to Thalamus either way                            | rewinding is the user's choice (principal, 13:22); the display keeps an honest trace                                                                                               |
| U4  | Panel: one status line (**with € spent today**) plus a 24-hour strip; five expanders (Health, Today, Jev prompts, Learning, Cost), each with a one-line summary                                                                                                                   | "not too verbose, otherwise I will never look at it"; "it would also be useful to know how much we are spending"                                                                   |
| U5  | **Run canary** pushes a known must-catch case through the whole chain and shows it held                                                                                                                                                                                           | direct proof that it works, on demand                                                                                                                                              |
| U6  | When a part goes silent, the line turns red and names what still protects; Health opens on the broken part; the composer dot turns red                                                                                                                                            | a guard that fails silently is the worst case                                                                                                                                      |
| U7  | 👍 / 👎 on each intervention (panel, and on hover in the chat)                                                                                                                                                                                                                    | these are the labels the questions learn from (paper §5.5)                                                                                                                         |
| U8  | **Approval cards only for exceptional changes**: anything touching danger level 3, data leaving the machine, or a hard rule; at most one a day. Any other loosening applies by itself once its replay loses no must-catch case, is logged under Learning, and one click undoes it | the principal runs an always-trust policy and does not know what to expect later, so human-in-the-loop must show only in exceptional situations (2026-09-29 17:34)                 |
| U9  | The UI names questions; it never shows their wording (each name opens its `.md` for editing, 2026-09-30)                                                                                                                                                                          | no literal prompts outside the question files                                                                                                                                      |
| U10 | The Jev window borrows TypeSafe's look (paper-light, square, monospace, magenta shadow, black title bar, cube mark drawn by us, no copied asset); its rows say what code did with each answer                                                                                     | Jev only answers, so the ledger must never read as Jev acting; the look tells "not the agent" at a glance                                                                          |

Gateway surface the UI needs: events `amygdala.status` (heartbeat each minute and on change, now with today's
spend), `amygdala.intervention` and `amygdala.decision` (every answered question, for the chat window); methods
`amygdala.feed` (interventions plus counts), `amygdala.label`, `amygdala.approve` (exceptional cases only),
`amygdala.undo` (a self-made loosening), `amygdala.canary`, `amygdala.rewind`. Payloads and components:
`docs/plans/2026-09-29-digital-amygdala-design.md`. The panel moves out of `app.ts` into
`tinker-ui/src/panels/amygdala.ts`.

## Open

- **Principal:** which families ship first (default above: safety, double-check, second opinion); whether
  redacted real situations may go to TypeSafe (without it, Jev sees only synthetic cases and shadow mode is
  rule-only); when enforcement flips.
- **Unverified:** the headless one-turn rewind in the agent runner; what the CLI does with a hook `ask` under
  `bypassPermissions`; Jev's latency under load (sets the timeout budget of choice 4).
