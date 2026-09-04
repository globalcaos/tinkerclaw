---
title: TinkerClaw FOUNDATION — the apex of the pyramid
status: RATIFIED (architect sign-off 2026-06-02)
authority: OUTRANKS every bible optic. When an optic's detail contradicts this file, THIS file wins and the contradiction is flagged for repair — never silently followed.
last_verified: 2026-06-02
audience: AI (Claude Code, Jarvis) + architect. The base reference every layer below derives from.
verify:
  - name: FOUNDATION exists and INDEX points at it as the apex
    cmd: python3 -c 'import os; b=os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE"); assert os.path.exists(os.path.join(b,"FOUNDATION.md")); assert "FOUNDATION.md" in open(os.path.join(b,"INDEX.md")).read(), "INDEX must reference FOUNDATION as the apex"'
  # #9 is enforced by a SCRIPT, not by a program pasted into this file. The principle below is the
  # authority and carries deliberate ambiguity ("which axis is this protecting?"); a predicate
  # cannot hold ambiguity, so keeping them in one artefact lets the narrower one quietly become the
  # rule. The script also gets what YAML cannot give it: linting, review, and a test.
  - name: "#9 bounded — published artefacts resolve standalone (axis 1) and the fork is backed up (axis 2)"
    cmd: cd ~/src/tinkerclaw && node scripts/bible/check-foundation-bounded.mjs
---

# TinkerClaw FOUNDATION

This is the **base reference** of the whole system. Everything below — the optics, their derived principles, the diagrams, and ultimately the code — is a refinement of what is written here. If anything below contradicts this file, **this file is right and the contradiction is a bug to fix.**

It is intentionally short and high-altitude. Detail lives in the optics (single owner per fact); this file holds only the enduring intent.

---

## Mission

TinkerClaw is an agent harness whose purpose is to be **as performant, as smart, and as useful as possible** — built **capability- and autonomy-first, with safety adjusted as we go**. Usefulness is measured by exactly one thing: **how useful Jarvis is to the architect.** The UI and the backend are continuously adapted to serve him best. The harness is a living tool, never a frozen product.

---

## The pyramid (how knowledge and code are structured)

The system is a **fractal pyramid**, narrow and stable at the top, widening into detail below. Each level derives from the one above and must not contradict it:

```
L1  FOUNDATION (this file)          — base principles, the "why"
L2  optics (topology, probes, …)    — structural facts, single owner per fact
L3  derived principles & don't-regress rules within each optic
L4  diagrams, flows, lifecycles     — the concrete shapes
L5  code                            — cites the bible; the bible cites this
```

Code is written **properly** at every level of that pyramid: real exception handling, source-tagged logs, paired read/write observability, unit tests that cite the bible section they defend, and a regression test for every fixed bug before it is called done. "It compiles" and "tests are green" are necessary, never sufficient — see _Total observability_ and _No silent failure_.

### Three different jobs, three different homes _(clarified 2026-08-04)_

These get confused, and confusing them damages the bible:

| Job                                                     | Where it lives                                                                                                                          | Why                                                                                                                                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Explain** — intent, structure, the shape of a problem | **the bible** — prose and diagrams, in whatever form is clearest (mermaid, a table, an HTML page with code that _visualizes_ something) | comprehension is the whole product here; ambiguity is allowed and often necessary                                                                                                  |
| **Enforce a rule Jarvis must obey**                     | **the running code** — hooks, gates, validators on the execution path                                                                   | an LLM forgets documented rules. If a rule matters, it cannot depend on being remembered. This is the J9 posture: AEGIS blocks a tool call pre-execution, it does not ask politely |
| **Check that the bible still matches the code**         | **`scripts/bible/*.mjs`**, referenced by a one-line `verify:` `cmd:`                                                                    | this is CI. It wants linting, review and its own tests — none of which a program pasted into YAML frontmatter can have                                                             |

The failure mode to avoid: putting job 3 inside job 1. A `verify:` block is welcome — it is what keeps an optic honest — but as a **pointer**, not as an embedded program. On 2026-08-04 FOUNDATION.md had grown 86 lines of frontmatter before its first sentence of prose, and both bugs in that code arrived because it could only be tested by copying it out of the document and back.

Code inside a bible file is fine when the code **is** the explanation — a rendered diagram, a worked example, an HTML visualization. It is wrong when the code is the enforcement.

---

## First principles

1. **Capability & autonomy first, prudence as the brake — not a gate.**
   Default toward giving Jarvis more capability and more autonomy. Safety is layered on as we learn, not required up front. The brake is _prudence_: once we are reasonably sure a behavior won't bite us, we let it loose; until then it runs behind a kill-switch or a rollback path, not a permanent "off." Reversibility (never-delete archives, rollback, kill-switches) is what _earns_ aggressive autonomy.

2. **Think fractally, not programmatically.**
   Fixed lists, fixed thresholds, and fixed limits are legacy artifacts of the programmatic era; in a fast-moving world they go stale and make us obsolete. Decisions are derived from the **actual situation at the moment of use** and adapt continuously. _Instances:_ model choice comes from a live, self-refreshing sense of what's best — never a hardcoded ranking. Budget decisions weigh real remaining allowance and time-to-reset — never a frozen "70%". Prompting follows the **latest** model standards — never pinned to one model version.

3. **Usefulness is measured by value to the architect — so personalize relentlessly.**
   Features earn their place by serving the architect's real workflows, and they are tuned to _him_, not to a generic user. _Instance (WhatsApp):_ tell automated messages apart from human ones; keep safety while preserving trust inside a small circle; show at a glance — a ⚡ marker — where Jarvis's answer ends. Generic is the enemy; fit-to-architect is the goal.

4. **Total observability — every LLM call is visible, live and forensically.**
   Every model call is observable as it happens (status, tool calls fully shown in the UI, cost) **and** afterward (a forensic timeline with round-level anatomy), at **whatever grain the situation needs** — today, at minimum the recipe/step level and the thinking/agent level. Observability is designed in with the feature, never bolted on; a correlated artifact chain threads everything; every write surface has a paired read surface returning the same state.

5. **No silent failure, no silent loss.**
   Errors surface through one canonical, classified envelope — never swallowed, never `[object Object]`. Conversation history is never silently truncated; compaction is a _visible_ event. A producer is only "wired" when it is verified firing at a real call site — a dead producer behind green tests is the failure class we most distrust (it has bitten us). Tool use is fully visible in the UI.

6. **Parallel by design, with arbitration.**
   The architect codes in parallel and multiple agents (Claude Code instances and Jarvis) may work the tree at the same time. Every agent must assume it is not alone: check working-tree and peers before acting, leave no orphan files, and follow a **shared arbitration protocol** for collisions that both Claude Code and Jarvis obey. Concurrency is a feature, not an accident — it must be made safe by protocol, not avoided.

7. **Jarvis may propose _and apply_ improvements anywhere.**
   No zone — bible, hooks, scripts, UI, infra — is permanently off-limits to Jarvis. Autonomy-first applies to self-improvement too. The safety is the arbitration protocol (#6), reversibility (#1), and observability (#4), not a forbidden-zone list.

8. **Three repositories, three non-negotiable goals.**
   The split exists so the architect can simultaneously **(a) share TinkerClaw with the world**, **(b) guard his personal information**, and **(c) recover Jarvis fully after a machine crash**. Public fork (`tinkerclaw`), private runtime/workspace, and the recoverable Jarvis state are kept apart on purpose. The split is structural and never unified; the PII boundary and a pre-push leak check protect (b); the workspace/runtime separation protects (c).

9. **Bounded, replicable, recoverable — and this is the test that governs dependencies.** _(ratified 2026-08-04)_
   The whole system — TinkerClaw, Jarvis's runtime, and the `jarvis-icu` helper — must be **reconstructible on another computer from what is committed and pushed.** That is the invariant. It has two axes, and both are load-bearing:
   - **Bounded in space.** Every artefact carries or declares everything it needs. A dependency is legitimate when it is **declared and travels with the artefact that requires it** — not when it happens to resolve on this laptop.
   - **Bounded in time.** Work that exists only on one disk is not bounded. Unpushed commits and unbacked-up state are a single point of failure, and they fail this principle exactly as hard as an undeclared import does.

   **This is why import boundaries exist, and it is what they are FOR.** `no-extension-src-imports` is a _consequence_ of #9, never an axiom above it. Read it that way and each case answers itself:

   | Situation                                                             | Is it bounded?                                    | Verdict                                                                                 |
   | --------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
   | Extension bundled into the one build graph, importing `src/`          | Yes — the artefact that ships it contains it      | **Fine.** Declare the dependency and move on                                            |
   | Extension published to npm/ClawHub, importing `src/` relatively       | **No** — the tarball ships only its own directory | Must cross a declared surface (`plugin-sdk` subpath)                                    |
   | Extension with its own split build graph (`stageRuntimeDependencies`) | Bounded, but core is **inlined twice**            | Allowed only if that module is `globalThis`-hardened or stateless — check, don't assume |
   | A private vendored **copy** of the dependency                         | Bounded in space, **unbounded in time**           | **Worst option.** It cannot drift-check itself; this is what the ENGRAM twin cost us    |

   So: **importing across `src/` is not the sin.** Importing something we have not declared, or shipping an artefact that cannot resolve it elsewhere, is. When the dependency is understood and written into the specs, the import is the _correct_ answer and a copy never is.

   The corollary for judgement: when a rule blocks you, ask **which axis of boundedness it is protecting here** — and if the answer is "none, in this case", the rule is being misapplied and that is a bug in the rule, not a reason to duplicate code. See `design-principles.md` #19 for the hard-vs-soft classification and `canonical-derivations.md` for the crossing table.

---

## Foundational criteria (the bar a merge or a new feature must not regress)

High-altitude; the owning optic carries the detail.

**Observability & truth**

- Every LLM call visible live + forensically, at every grain the situation needs (today: recipe level and thinking level). _(tinker-ui, probes, flows)_
- **ALL call traffic is retained, permanently, by policy.** Every request/response pair lands in the forensic store and stays there; sessions are soft-deleted, never destroyed. **Disk is not a constraint we optimise against, and "it is growing" is never by itself a defect** — an unbounded store is the intended state, so the remedy for a store that has become unpleasant to look at is ORGANISATION (naming, grouping, nesting, collapsing it into the surface that owns it), never deletion or truncation. Anyone proposing a reaper, a TTL or a retention cap on call traffic is proposing to violate this line and must say so explicitly. _(probes, memory-layout, tinker-ui)_
- Tool use fully rendered in the UI. _(tool-loop, tinker-ui)_
- Complete traceability through a correlated artifact chain; paired read for every write; one canonical error classification; no silent swallow. _(design-principles, failures, probes)_
- History never silently truncated; compaction is a visible event with token diff. _(bible, tinker-ui)_
- **Background lanes nest, they do not colonise.** Machinery that runs on the architect's behalf without being asked (reflection, announce, title-suggest, probes) renders INSIDE the artifact it is about — never as a peer of a real conversation in the session list. A background lane that needs its own tab to be readable is a UI defect in that lane, not a reason to give it a tab. _(tinker-ui, panels, session-naming)_
- Producers verified firing at a real hot-path site, not just mocked. _(bug-log)_

**Autonomy & cognition**

- Prompts follow the **latest** model standards; system-prompt blocks in priority order. _(bible, tool-loop)_
- **Recipes evolve continuously and autonomously** — made safe by reversibility and observability, not by constraints on change. _(subagents-and-recipes)_
- **Recipes are matched to intent before every execution**, however trivial it seems; mismatches become signals that grow the catalog. _(subagents-and-recipes)_
- Decisions derive from the live situation, not frozen lists/thresholds — model choice, budget, effort, **and every quantity bound** (timeout, retry, loop/recursion cap, concurrency, cache/result size). A hard quantity threshold that can kill a near-done task or amputate a capability is a bug; a frozen number is at most a safety CEILING, never the working value, and the system applies adaptive pressure before it rather than a cliff. Categorical capability/permission boundaries (the PII split §8, security gates, tool whitelists) stay hard. _(design-principles #19, auth-routing, config-shape, subagents-and-recipes)_

**Reliability**

- Every turn ends in exactly one terminal broadcast with an RPC backstop; no silent close. _(done-signals, lifecycles)_
- The liveness check (heartbeat) never asserts doneness — it observes whether real work remains and lets the work itself signal completion. _(bible, tool-loop)_
- Boot recovery shows the restart envelope before resuming; never skipped. _(lifecycles)_
- Shared stores: atomic + append-only writes; never blind-overwrite. _(memory-layout)_

**Safety (prudence, not gates)**

- The two-repo/PII split is never unified; a leak-grep gate runs before every public push. _(pii-boundary, branch-policy)_
- Privacy precedes functionality: sanitize before `develop` push and before `main` advances. _(design-principles)_
- Risky autonomy runs behind kill-switches + rollback and is loosened as confidence grows — not held off forever. _(config-shape, crons)_
- Browser/relay per-tab consent; kit install sandboxed. _(bible, flows)_

**Usefulness to the architect**

- The UI surfaces the architect's pending work and live controls for real-time intervention (today: a tasks list + an Exec-mode control panel). _(panels, tinker-ui)_
- Fit affordances to the architect's real trust model and workflows, never generic (e.g. WhatsApp: automated-vs-human, small trust circle, ⚡ end-of-answer marker, owner `Jarvis …` prefix in any chat). _(wa-triggers)_
- UI shows the model fallback chain + per-profile auth/billing badges + in-chat re-auth. _(tinker-ui, auth-routing)_

**Memory & cognition**

- Knowledge stores append-only / never-delete; supersession marks `deprecated:true`, body stays readable. _(memory-layout)_
- MEMORY.md writer is suggest-only — proposes, never silently overwrites hand edits. _(memory-layout)_
- Turn-local prompt augmentations snapshotted and restored against the true base — no bleed into the next turn. _(flows, bug-log)_

**Identity**

- Exactly one session name everywhere, surviving restarts; persona prefix on every outbound message; fork identity (e.g. README) protected from upstream erasure. _(session-naming, wa-triggers, branch-policy)_

---

## Governance

- **Authority.** FOUNDATION outranks every optic. A contradiction between an optic and this file is a bug; flag it, fix the optic, do not follow the stale detail.
- **Budget doctrine.** There is a real token cap, because feeding the family comes first. But the cap is reasoned _fractally_ — actual remaining allowance, time to reset, value of the work — never a fixed threshold. We rarely exhaust the allowance by reset, so spending the surplus down in the day before a reset (when headroom is comfortable) is welcome.
- **Autonomy doctrine.** Autonomy-first _with prudence_: ship capability behind reversibility, watch it, and loosen as it proves safe.
- **Self-improvement.** Jarvis may propose and apply changes anywhere, under the arbitration protocol and observability.
- **No functionality without a bible entry.** Every new functionality — ours, not just the ones adopted from upstream — lands with an entry in the optic that owns its concern, stating the design criteria: what it is for, the invariant it holds, the choice made, the alternatives rejected and why. The entry ships in the same change, not afterwards. New design principles, features, and requirements are bible work by default — the architect does not have to ask. **Old entries that the change makes wrong are updated in the same run**; a stale optic is worse than a missing one, because it is read and believed. **The entry outlives the code**: if the implementation is reverted, abandoned, or never worked, the entry is NOT deleted — its `status` flips and a dated line records what failed, so the reasoning survives the diff that carried it. Code is perishable; the design record is the durable asset. _(design-principles #21, #16, ownership, INDEX)_
- **The bible is the gift list.** It records what the architect wants, regardless of how well a feature works or whether it stops working. Implementation status is observation, never a reason to drop the want. When the running code dies, the entry stays so we can go back to the drawing board. _(design-principles #21, #23)_
- **Code for consistency, prompt for plasticity.** Code does not beat prompt all the time. Code buys a behavior that fires the same way every turn; prompt buys a behavior the next model can retune. Prefer code whenever it is possible; keep prompt when plasticity is the point, or there is no structural producer. The distinction must be chosen, not defaulted. _(design-principles #22)_

## Merge / adoption gate (the reflection layer hooks here)

- **Convergence-first is the default bias (ratified 2026-06-02).** Every auto-merge minimizes FUTURE merge friction by making our fork look like upstream — doing the hard convergence work now beats carrying perpetual divergence debt. Resolve each upstream delta into exactly one bucket:
  - **ADOPT-LIVE** — adopt any upstream improvement that advances the mission (the capability-first test). Default bias; bite the hard work now.
  - **ABSORB-FOR-CONVERGENCE** — absorb harmless code with little/no capability delta _anyway_, to shrink the conflict surface. "Not strictly better" is no longer grounds to discard.
  - **KEEP-DORMANT (overlay, never delete)** — for upstream subsystems we don't use, keep them present-but-disabled and layer our variant alongside. Deletion is itself a high-friction divergence that re-conflicts every merge; never delete, and never re-claim an upstream package name for a forked variant.
  - **DIVERGE (keep ours)** — only where ours is genuinely higher-value AND that advantage is worth the PERPETUAL per-merge cost; each retained divergence is documented with its justification and the friction it accepts.
- **Re-introducing an avoidable structural divergence** (a fresh tree rename, a same-name package collision, a new in-place edit where an upstream hook exists) is itself a gate FAILURE. The merge actively shrinks divergence debt, not merely avoids regressing.
- **Hard constraints override convergence:** the two-repo / PII split (§8) is never unified, and genuine fit-to-architect product differences stay — but even there, prefer overlay-not-delete so the merge stays cheap.
- A merge is **done** only when **no foundational criterion above has regressed** — proven by behavioral diff + the optics' `verify[]` invariants, not by "it built" or "tests passed."
- Adopted upstream features follow the same discipline we use for our own: update the relevant J-series paper / optic first (the intent), then plan, then implement, then verify.

_(The mechanized reflection layer that enforces this gate over the daily auto-merge is specced separately, on top of this file.)_
