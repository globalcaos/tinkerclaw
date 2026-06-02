---
title: TinkerClaw FOUNDATION — the apex of the pyramid
status: RATIFIED (architect sign-off 2026-06-02)
authority: OUTRANKS every bible optic. When an optic's detail contradicts this file, THIS file wins and the contradiction is flagged for repair — never silently followed.
last_verified: 2026-06-02
audience: AI (Claude Code, Jarvis) + architect. The base reference every layer below derives from.
verify:
  - name: FOUNDATION exists and INDEX points at it as the apex
    cmd: python3 -c 'import os; b=os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE"); assert os.path.exists(os.path.join(b,"FOUNDATION.md")); assert "FOUNDATION.md" in open(os.path.join(b,"INDEX.md")).read(), "INDEX must reference FOUNDATION as the apex"'
---

# TinkerClaw FOUNDATION

This is the **base reference** of the whole system. Everything below — the optics, their derived principles, the diagrams, and ultimately the code — is a refinement of what is written here. If anything below contradicts this file, **this file is right and the contradiction is a bug to fix.**

It is intentionally short and high-altitude. Detail lives in the optics (single owner per fact); this file holds only the enduring intent.

---

## Mission

TinkerClaw is an agent harness whose purpose is to be **as performant, as smart, and as useful as possible** — built **capability- and autonomy-first, with safety adjusted as we go**. Usefulness is measured by exactly one thing: **how useful Jarvis is to Oscar.** The UI and the backend are continuously adapted to serve him best. The harness is a living tool, never a frozen product.

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

---

## First principles

1. **Capability & autonomy first, prudence as the brake — not a gate.**
   Default toward giving Jarvis more capability and more autonomy. Safety is layered on as we learn, not required up front. The brake is _prudence_: once we are reasonably sure a behavior won't bite us, we let it loose; until then it runs behind a kill-switch or a rollback path, not a permanent "off." Reversibility (never-delete archives, rollback, kill-switches) is what _earns_ aggressive autonomy.

2. **Think fractally, not programmatically.**
   Fixed lists, fixed thresholds, and fixed limits are legacy artifacts of the programmatic era; in a fast-moving world they go stale and make us obsolete. Decisions are derived from the **actual situation at the moment of use** and adapt continuously. _Instances:_ model choice comes from a live, self-refreshing sense of what's best — never a hardcoded ranking. Budget decisions weigh real remaining allowance and time-to-reset — never a frozen "70%". Prompting follows the **latest** model standards — never pinned to one model version.

3. **Usefulness is measured by value to Oscar — so personalize relentlessly.**
   Features earn their place by serving Oscar's real workflows, and they are tuned to _him_, not to a generic user. _Instance (WhatsApp):_ tell automated messages apart from human ones; keep safety while preserving trust inside a small circle; show at a glance — a ⚡ marker — where Jarvis's answer ends. Generic is the enemy; fit-to-Oscar is the goal.

4. **Total observability — every LLM call is visible, live and forensically.**
   Every model call is observable as it happens (status, tool calls fully shown in the UI, cost) **and** afterward (a forensic timeline with round-level anatomy), at **whatever grain the situation needs** — today, at minimum the recipe/step level and the thinking/agent level. Observability is designed in with the feature, never bolted on; a correlated artifact chain threads everything; every write surface has a paired read surface returning the same state.

5. **No silent failure, no silent loss.**
   Errors surface through one canonical, classified envelope — never swallowed, never `[object Object]`. Conversation history is never silently truncated; compaction is a _visible_ event. A producer is only "wired" when it is verified firing at a real call site — a dead producer behind green tests is the failure class we most distrust (it has bitten us). Tool use is fully visible in the UI.

6. **Parallel by design, with arbitration.**
   Oscar codes in parallel and multiple agents (Claude Code instances and Jarvis) may work the tree at the same time. Every agent must assume it is not alone: check working-tree and peers before acting, leave no orphan files, and follow a **shared arbitration protocol** for collisions that both Claude Code and Jarvis obey. Concurrency is a feature, not an accident — it must be made safe by protocol, not avoided.

7. **Jarvis may propose _and apply_ improvements anywhere.**
   No zone — bible, hooks, scripts, UI, infra — is permanently off-limits to Jarvis. Autonomy-first applies to self-improvement too. The safety is the arbitration protocol (#6), reversibility (#1), and observability (#4), not a forbidden-zone list.

8. **Three repositories, three non-negotiable goals.**
   The split exists so Oscar can simultaneously **(a) share TinkerClaw with the world**, **(b) guard his personal information**, and **(c) recover Jarvis fully after a machine crash**. Public fork (`tinkerclaw`), private runtime/workspace, and the recoverable Jarvis state are kept apart on purpose. The split is structural and never unified; the PII boundary and a pre-push leak check protect (b); the workspace/runtime separation protects (c).

---

## Foundational criteria (the bar a merge or a new feature must not regress)

High-altitude; the owning optic carries the detail.

**Observability & truth**

- Every LLM call visible live + forensically, at every grain the situation needs (today: recipe level and thinking level). _(tinker-ui, probes, flows)_
- Tool use fully rendered in the UI. _(tool-loop, tinker-ui)_
- Complete traceability through a correlated artifact chain; paired read for every write; one canonical error classification; no silent swallow. _(design-principles, failures, probes)_
- History never silently truncated; compaction is a visible event with token diff. _(bible, tinker-ui)_
- Producers verified firing at a real hot-path site, not just mocked. _(bug-log)_

**Autonomy & cognition**

- Prompts follow the **latest** model standards; system-prompt blocks in priority order. _(bible, tool-loop)_
- **Recipes evolve continuously and autonomously** — made safe by reversibility and observability, not by constraints on change. _(subagents-and-recipes)_
- **Recipes are matched to intent before every execution**, however trivial it seems; mismatches become signals that grow the catalog. _(subagents-and-recipes)_
- Decisions derive from the live situation, not frozen lists/thresholds (model choice, budget, effort). _(auth-routing, config-shape)_

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

**Usefulness to Oscar**

- The UI surfaces Oscar's pending work and live controls for real-time intervention (today: a tasks list + an Exec-mode control panel). _(panels, tinker-ui)_
- Fit affordances to Oscar's real trust model and workflows, never generic (e.g. WhatsApp: automated-vs-human, small trust circle, ⚡ end-of-answer marker, owner `Jarvis …` prefix in any chat). _(wa-triggers)_
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

## Merge / adoption gate (the reflection layer hooks here)

- **Convergence-first is the default bias (ratified 2026-06-02).** Every auto-merge minimizes FUTURE merge friction by making our fork look like upstream — doing the hard convergence work now beats carrying perpetual divergence debt. Resolve each upstream delta into exactly one bucket:
  - **ADOPT-LIVE** — adopt any upstream improvement that advances the mission (the capability-first test). Default bias; bite the hard work now.
  - **ABSORB-FOR-CONVERGENCE** — absorb harmless code with little/no capability delta _anyway_, to shrink the conflict surface. "Not strictly better" is no longer grounds to discard.
  - **KEEP-DORMANT (overlay, never delete)** — for upstream subsystems we don't use, keep them present-but-disabled and layer our variant alongside. Deletion is itself a high-friction divergence that re-conflicts every merge; never delete, and never re-claim an upstream package name for a forked variant.
  - **DIVERGE (keep ours)** — only where ours is genuinely higher-value AND that advantage is worth the PERPETUAL per-merge cost; each retained divergence is documented with its justification and the friction it accepts.
- **Re-introducing an avoidable structural divergence** (a fresh tree rename, a same-name package collision, a new in-place edit where an upstream hook exists) is itself a gate FAILURE. The merge actively shrinks divergence debt, not merely avoids regressing.
- **Hard constraints override convergence:** the two-repo / PII split (§8) is never unified, and genuine fit-to-Oscar product differences stay — but even there, prefer overlay-not-delete so the merge stays cheap.
- A merge is **done** only when **no foundational criterion above has regressed** — proven by behavioral diff + the optics' `verify[]` invariants, not by "it built" or "tests passed."
- Adopted upstream features follow the same discipline we use for our own: update the relevant J-series paper / optic first (the intent), then plan, then implement, then verify.

_(The mechanized reflection layer that enforces this gate over the daily auto-merge is specced separately, on top of this file.)_
