---
purpose: AI entry point for the tinkerclaw bible (J15 RSC discipline)
audience: AI (Claude, etc). Human readability is incidental, not the design goal.
codename: RSC (after retrosplenial cortex, per paper J15)
last_verified: 2026-05-13
last_verified_commit: HEAD
verify:
  # Enforced by a SCRIPT, not by a program pasted into this file (FOUNDATION.md, "Three different
  # jobs, three different homes": the bible EXPLAINS, running code ENFORCES, scripts/bible/ CHECKS —
  # and only the third one wants linting, review and its own tests, none of which YAML frontmatter
  # can give it). Derived, not frozen: the script compares the Files table against the optics on
  # disk in BOTH directions, replacing a `>= 18` floor that reality had outgrown — 29 files existed,
  # so eleven optics could have been deleted and it would still have passed (design-principles.md
  # #19, #20). The script header carries the rest.
  - name: every optic on disk has a row in the Files table, and every row names a real optic
    cmd: cd ~/src/tinkerclaw && node scripts/bible/index-files-table.mjs
  # NOTE: the previous "gateway is reachable" check was removed 2026-08-02. The validity of a
  # documentation index must not depend on a daemon being up, and it shelled out to
  # `openclaw gateway call`, measured at 4-18 s — a large share of the whole suite's runtime for a
  # fact that says nothing about the bible. Gateway liveness belongs in probes.md, not here.
---

# Bible INDEX — tinkerclaw

This directory IS the bible. The monolithic `TINKER_UI_DESIGN_BIBLE.md` was split on 2026-05-11 into thirteen files (one narrative plus twelve structural intermediate-abstraction files, per the J15 paper) and has grown since; the Files table below is the live inventory and its `verify:` keeps it honest in both directions. Together they remain "the bible" colloquially. References from code or memory that point at the old `.md` should be updated to point at this `INDEX.md`.

> **Counts are not written down here on purpose.** An earlier version of this file stated a file count in prose and asserted `>= 18` in its `verify:`, and both were stale within weeks. Anything countable is derived at check time — see the frontmatter.

## How an AI should read this directory

0. **Read `FOUNDATION.md` first.** It is the apex — the base principles every optic derives from, and it **OUTRANKS every optic**. When an optic's detail contradicts FOUNDATION, FOUNDATION wins and the contradiction is a bug to fix. This INDEX is the map; FOUNDATION is the constitution.
1. **Then read THIS file.** It is the map. When the question is structural rather than about one subsystem, read `architecture.md` next: it is the BLUEPRINT — one diagram of the whole harness plus the registry of central mechanisms, one per recurring problem class.
2. **Pick the right optic for the question:**
   - "what is the overall shape of the system / which central mechanism owns this problem class?" → `architecture.md`
   - "in what order do these components communicate?" → `flows.md`
   - "what transitions are legal for X?" → `lifecycles.md`
   - "where does this run / what talks to what?" → `topology.md`
   - "what is this config key, who reads it, who can override?" → `config-shape.md`
   - "when X breaks, where does the symptom appear?" → `failures.md`
   - "what probes exist for inspecting Y?" → `probes.md`
   - "would anything tell me if X broke / what can we prove is working?" → `observability.md`
   - "why is tinker-bridge's tool loop different?" → `tool-loop.md`
   - "which model gets picked, in what order?" → `auth-routing.md`
   - "which crons run, when, last status?" → `crons.md`
   - "is this string safe to publish?" → `pii-boundary.md`
   - "where does memory dir X live, who writes it?" → `memory-layout.md`
   - "how do subagents, kits, and plans work?" → `subagents-and-recipes.md`
   - "how do concurrent agents serialize edits on one tree (cross-session file leases)?" → `orca-leases.md`
   - "how should fork-side unit tests be scoped and named?" → `unit-tests.md`
   - "what's the WhatsApp trigger contract / LID rescue rules / chat-rhythm format?" → `wa-triggers.md`
   - "what's the public-fork branch model / push authority / merge gate?" → `branch-policy.md`
   - "who owns this folder / which agent can safely change this file?" → `ownership.md`
   - "what design rule do I follow when adding new code?" → `design-principles.md`
   - "does this concept already have an implementation / may I write another one?" → `canonical-derivations.md`
   - "what service-level objectives are we tracking and how do I read the burn?" → `slos.md`
   - "why is a turn slow / where do the seconds before the model go / is this stage worth its wall-clock?" → `turn-latency.md`
   - "what's the intent / decision / don't-regress for §X.Y?" → `bible.md`
   - "how does this UI panel work / what's the visual convention?" → `tinker-ui.md`
   - "which panel is visible when / how do tabs and Dev↔Exec interact / what hides what?" → `panels.md`
   - "how does a panel/tab/button remember its collapsed or pressed state across a reload?" → `ui-persistence.md`
   - "why does this right-rail panel show the wrong tab's data / which state is per-session vs global / what does Session-All actually mean / how do the model+effort sliders apply?" → `right-rail-interaction.md`
   - "how do we know a turn/task is done / why does the thinking indicator do that / which signal wins when they disagree?" → `done-signals.md`
   - "where does a session's visible name come from / who mints tab.title vs cookiePhrase / why does the side-panel name change when I close a tab?" → `session-naming.md`
   - "has this bug class been seen before?" → `bug-log.md`
3. **Trust the frontmatter `last_verified` + `last_verified_commit` anchors.** Anything older than the most recent file in `git log src/` referenced by the section should be re-verified before relying on it.
4. **Do NOT re-narrate facts that live in another file.** Cross-reference them with `see also:` annotations. Single owner per fact.

## Files

| File                        | Compresses                                                                                                                                                                                                                                                                                                                           | Generation                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `FOUNDATION.md`             | **APEX.** Mission + first principles + foundational criteria + governance. Outranks every optic. The base reference the whole pyramid derives from.                                                                                                                                                                                  | hand                              |
| `INDEX.md`                  | This map                                                                                                                                                                                                                                                                                                                             | hand                              |
| `architecture.md`           | **BLUEPRINT.** The unified view one level above the optics — one diagram of the whole harness (process vs in-process module boundaries), the central-mechanism registry (one mechanism per recurring problem class + its canonical module), where a second mechanism exists today, and the allowed dependency direction (2026-08-03) | hand                              |
| `bible.md`                  | Narrative, intent, decisions, don't-regress rules. Slimmed 2026-05-11 from 3,085 lines to ~1,730 after extracting tinker-ui.md and bug-log.md. Continues to slim as structural files absorb facts.                                                                                                                                   | hand                              |
| `tinker-ui.md`              | Layout, visual language, UI feature registry (former bible §3, §4, §5.1-§5.65, migrated 2026-05-11)                                                                                                                                                                                                                                  | hand                              |
| `bug-log.md`                | Historical bug-fix log — root causes, fixes, lessons (former bible §7). New fixes are appended here, not to bible.md.                                                                                                                                                                                                                | hand                              |
| `flows.md`                  | Sequence diagrams (Mermaid) for the top pipelines                                                                                                                                                                                                                                                                                    | hand + auto-validatable           |
| `lifecycles.md`             | State machines for sessions, workers, messages, recovery                                                                                                                                                                                                                                                                             | hand + auto-validatable           |
| `topology.md`               | Components, ports, plugins, channels, workspace symlinks                                                                                                                                                                                                                                                                             | mixed                             |
| `config-shape.md`           | Settings flow from openclaw.json to runtime; override chains; dead-code traps                                                                                                                                                                                                                                                        | mixed                             |
| `failures.md`               | Failure-mode propagation maps                                                                                                                                                                                                                                                                                                        | hand                              |
| `probes.md`                 | Inspection primitives registry (live + proposed)                                                                                                                                                                                                                                                                                     | auto from gateway methods + hand  |
| `observability.md`          | What the fork can PROVE it is doing — the DERIVED capability registry (plugins/hooks/RPCs), the measured OBSERVED/DECLARED/BLIND split, a ratchet on BLIND, and the instrument-placement rules each bought with an incident. Written after fractal-reflection failed 2,466/2,466 runs for eight weeks in silence (2026-08-04)        | auto-derived + executable ratchet |
| `tool-loop.md`              | Why tinker-bridge tool calls don't round-trip through OpenClaw exec                                                                                                                                                                                                                                                                  | hand                              |
| `auth-routing.md`           | Cost-aware model routing, failover, billing tiers                                                                                                                                                                                                                                                                                    | mixed                             |
| `crons.md`                  | Cron registry + auto-merge policy                                                                                                                                                                                                                                                                                                    | auto from jobs.json + hand        |
| `pii-boundary.md`           | Public-OK vs private-only, leak-grep regex, sanitization workflow                                                                                                                                                                                                                                                                    | hand                              |
| `memory-layout.md`          | Workspace memory directory layout, writers, retention                                                                                                                                                                                                                                                                                | mixed                             |
| `subagents-and-recipes.md`  | Subagent spawn, kit catalog, plan RPCs, plan persistence, Prefrontal observability                                                                                                                                                                                                                                                   | hand                              |
| `unit-tests.md`             | Fork-side unit-test scoping, naming, bible-coherence rules, priority backfill order                                                                                                                                                                                                                                                  | hand                              |
| `wa-triggers.md`            | WhatsApp trigger contract — owner+prefix, noPrefixChats, LID rescue, prelude shape, chat-rhythm (former bible §11.6a, migrated 2026-05-11)                                                                                                                                                                                           | hand                              |
| `branch-policy.md`          | Public-fork branch model — develop vs main, push authority, README protection, PII pre-push hook (former bible §5.78, migrated 2026-05-11)                                                                                                                                                                                           | hand                              |
| `ownership.md`              | Folder-level ownership map — Architect vs Jarvis vs Upstream zones, concurrency rules, upstream-merge protocol (2026-05-12)                                                                                                                                                                                                          | hand                              |
| `design-principles.md`      | Codified design rules — 20 numbered principles spanning code organization, concurrency, observability, process. Every other bible file's "don't regress" clauses point back here (2026-05-12)                                                                                                                                        | hand                              |
| `canonical-derivations.md`  | The LEDGER for design-principles #18 — every concept that must have exactly one implementation, its measured count, and a RATCHET that fails the build when one gains another. Plus the collapses already done and the incident each paid for (2026-08-03)                                                                           | hand + executable ratchet         |
| `turn-latency.md`           | Where the 21-36s before the model goes, measured — the per-stage budget, the speed/smarter/cheaper table per mechanism, and what each stage actually buys                                                                                                                                                                            |
| `slos.md`                   | Service-level objectives + burn-rate computation — three starter SLOs (cron-success-7d, cron-freshness, morning-briefing-latency) backed by `gateway.slo.burnRate` (2026-05-12)                                                                                                                                                      | hand                              |
| `done-signals.md`           | Cross-signal precedence methodology for "is the turn/task done?" — master map of every input to the thinking indicator, authority tiers, fixed analysis procedure (2026-05-17)                                                                                                                                                       | hand + auto-validatable           |
| `ui-persistence.md`         | Unified UI-chrome persistence — the absent-means-default contract, ui-state.ts single-writer ownership, three namespaces + id registry, legacy-key migration, the Chrome SESSION_ONLY wipe trap (2026-08-02)                                                                                                                         | hand + auto-validatable           |
| `orca-leases.md`            | Cross-session file leases — how concurrent agents serialize edits on one tree (ORCA)                                                                                                                                                                                                                                                 | hand                              |
| `panels.md`                 | Panel visibility matrix — which panel shows when, tab vs Dev/Exec interaction, what hides what                                                                                                                                                                                                                                       | hand                              |
| `right-rail-interaction.md` | Right-rail state scoping — per-session vs global, Session-All semantics, model+effort slider application                                                                                                                                                                                                                             | hand                              |
| `session-naming.md`         | Where a session's visible name comes from — tab.title vs cookiePhrase minting, rename propagation                                                                                                                                                                                                                                    | hand                              |

## Discipline

- **No functionality without an entry** (`design-principles.md` #21, ratified 2026-08-17). New functionality is not done when it runs — it is done when the optic that owns its concern carries an entry stating the DESIGN CRITERIA (purpose, invariant, choice made, alternatives rejected and why), written in the same change rather than afterwards. If no optic owns the concern, open one and add its row to the Files table above. **The entry outlives the code**: an implementation that is reverted, abandoned, or never worked keeps its entry — `status` flips, a dated line records what failed, the criteria stand. That way a failed build still leaves a lasting document behind.
- **Single owner per fact.** If a fact appears in two files, one of them is wrong. The structural files (everything except `bible.md`) are authoritative for their domain; `bible.md` is authoritative for narrative and decision history.
- **Frontmatter on every section that claims `DEPLOYED`.** Use the J15 schema: `status`, `last_verified`, `last_verified_commit`, `verify[]`, `invariants[]`.
- **Mermaid diagrams in text form.** Renderable by humans through a markdown previewer, but the AI consumes them as text directly.
- **Cross-references over duplication.** Use `see also: lifecycles.md#session-state` rather than copy-pasting a state diagram.
- **TBD is a real status.** A section marked `status: TBD` is honest. A section marked `DEPLOYED` without a `verify` command is dishonest.

## Migration status (2026-05-11)

- [x] Move `TINKER_UI_DESIGN_BIBLE.md` (3,085 lines) → `bible.md` verbatim
- [x] Create `INDEX.md` (this file)
- [x] Scaffold 12 structural files with frontmatter + section structure + content I have today
- [ ] Slim `bible.md` by moving structural facts to their owning files (incremental, future work)
- [ ] Add `verify` commands to every `DEPLOYED` section (incremental)
- [ ] Wire `pnpm test:invariants` to run all `verify` commands at merge time (future, requires the gate of J15 §5)

## Naming

The folder is `TINKER_UI_DESIGN_BIBLE` to preserve external references that grep for the old token. The original `TINKER_UI_DESIGN_BIBLE.md` stub at the parent path redirects here.

We still call this "the bible." The plural inside the folder is the implementation; the singular outside is the artifact.
