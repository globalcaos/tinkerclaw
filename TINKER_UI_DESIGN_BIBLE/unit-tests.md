---
file: unit-tests.md
purpose: How fork-side unit tests are scoped, named, and kept coherent with the bible as it evolves
audience: AI
last_verified: 2026-05-11
last_verified_commit: HEAD
single_owner: yes — test scoping, naming, and bible-coherence rules live here
see_also: probes.md (the bible:invariants suite is the merge gate, this is the layer below), failures.md (each test should map to a failure mode it would have caught), bug-log.md (each fixed bug is a regression-test candidate), design-principles.md (#13 round-trip-test the symmetry, #16 the bible audits itself)
verify:
  - name: vitest config exists in tinkerclaw
    cmd: python3 -c 'import os,glob; assert any(os.path.exists(p) for p in glob.glob(os.path.expanduser("~/src/tinkerclaw/test/vitest/vitest*.config.ts")))'
  - name: pnpm test chains the bible:invariants runner (catches upstream-merge wipe of the chain)
    cmd: python3 -c 'import json,os; p = json.load(open(os.path.expanduser("~/src/tinkerclaw/package.json"))); t = p["scripts"]["test"]; assert "test-invariants" in t or "bible:invariants" in t, f"upstream merge wiped the bible:invariants chain from the test script — current value: {t!r}. Restore it so every pnpm test run gates the bible contracts."'
  - name: git-hooks/pre-push runs the bible:invariants gate (catches hook-removal regression)
    cmd: python3 -c 'import os; p = os.path.expanduser("~/src/tinkerclaw/git-hooks/pre-push"); assert os.path.isfile(p), "pre-push hook missing"; t = open(p).read(); assert "bible:invariants" in t, "pre-push hook no longer runs bible:invariants"'
  - name: no production module imports a relative path that does not exist (ratchet)
    cmd: cd ~/src/tinkerclaw && node scripts/check-broken-relative-imports.mjs
  - name: the broken-import guard is wired into check:architecture (not merely present on disk)
    cmd: python3 -c 'import json,os; p=json.load(open(os.path.expanduser("~/src/tinkerclaw/package.json"))); a=p["scripts"]["check:architecture"]; assert "lint:no-broken-relative-imports" in a, f"guard exists but nothing runs it — check:architecture is {a!r}"'
---

# Unit tests — fork-side strategy

The bible:invariants suite (`scripts/test-invariants.mjs`) is the **integration** layer: it exercises probes through a running gateway and asserts on observable RPC output. Unit tests are the **finer** layer: they exercise fork-touched modules in isolation, run in milliseconds, and catch the class of regression that lives _inside_ a single function.

Together: bible:invariants catches "the feature is broken end-to-end"; unit tests catch "the implementation drifted in a way that hasn't surfaced yet."

## Scope: what the fork owns

We DO NOT test upstream's code. Upstream has its own tests; running them here is duplicate work that breaks when upstream refactors. The fork tests **fork-touched** code, which today is:

- `src/agents/plugin-provider-config-overlay.ts` (FORK 2026-05-10)
- `src/agents/main-session-restart-recovery.ts` (FORK 2026-05-09/10)
- `extensions/tinkerclaw-tinker-bridge/` (all)
- `extensions/tinkerclaw-whatsapp/` (fork-owned)
- `extensions/tinkerclaw-people/` (fork-owned)
- `extensions/tinkerclaw-prefrontal/` (fork-owned)
- `src/gateway/server-methods/{briefing,files-resolve-bare,debug-probes,cron-probes,debug-ui-snapshot,config-open-external}.ts` (fork-added RPCs)
- `src/gateway/server-methods/chat.ts` only inside the `chat.send` backstop block (FORK 2026-05-10)
- `src/fork/error-envelope.ts` and other `src/fork/*` modules
- `tinker-ui/src/app.ts` for fork-added UI behaviors

Tests for any path outside this list need an explicit reason in the test file's header.

## A test is only a gate if something collects it

`src/**/*.test.ts` is the unit project's include pattern and `src/memory/**` is **not** in
`unitTestAdditionalExcludePatterns` — so `src/memory/integration.test.ts` was collected on every
run, and it failed on import with `Cannot find module './cortex/behavioral-probes.js'`. Its module,
a 517-line "Cognitive Orchestrator", imported seven files from `src/memory/{cortex,limbic,synapse}/`
— directories deleted when those subsystems were extracted into `extensions/tinkerclaw-*`. Nothing
had constructed it outside its own test, ever.

Three separate gates each had a reason not to see it:

- **`tsdown`** bundles only what a declared entry point reaches, so an orphan never breaks a build;
- **`tsgo`** ran against tsconfigs that did not include the path;
- the **unit suite** did fail — but as one red file among others, in a tail nobody read.

Two rules follow, and they generalise past this incident:

1. **A red test that has been red for a while has stopped being a gate.** It has become noise that
   trains people to skip the tail of the output. Fix it or delete it the day it goes red; there is
   no third state.
2. **Check that a test is COLLECTED, not merely that it exists.** The repo exports its own
   predicate — `isUnitConfigTestFile()` in `test/vitest/vitest.unit-paths.mjs`. Ask it. The same
   file already records the last time this bit: ten tinker-bridge specs "existed and passed only
   when named explicitly on the command line — never in a full-suite run."

`scripts/check-broken-relative-imports.mjs` now gates the underlying defect directly, because an
unresolvable relative import is the one form of dead code needing no judgement — no plugin
manifest, tsconfig alias, string dispatch or host convention can rescue a path that is not there.
It is a **ratchet** at 28, not a wall: the remaining offenders are upstream-derived
(`src/line/index.ts` imports fifteen modules that do not exist; `src/media-understanding/providers/*`
import a `../image.js` and `../shared.js` never brought across a merge), and deleting upstream files
is the architect's call, not a gate's. See `canonical-derivations.md` for the same ratchet
discipline applied to duplicate implementations.

## Framework

Vitest, matching upstream. Test files live next to their source as `*.test.ts` (vitest auto-discovery). The repo already has `scripts/run-vitest.mjs`; reuse it.

A typical fork-side test file:

```ts
/**
 * Test target: src/agents/plugin-provider-config-overlay.ts
 * Bible anchor: config-shape.md §4.1 ("Plugin runtime overlay")
 * Bug history:  failures.md M1 (tinker-bridge SIGTERM), bug-log.md 2026-05-10
 * Catches:      regression of the overlay-merge-into-cfg behavior shipped 2026-05-10
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerPluginProviderConfigOverlay,
  getPluginProviderConfigOverlay,
  clearPluginProviderConfigOverlayForTests,
} from "../plugin-provider-config-overlay.js";

describe("plugin-provider-config-overlay", () => {
  beforeEach(() => clearPluginProviderConfigOverlayForTests());

  it("merges later registrations with earlier ones for the same provider", () => {
    registerPluginProviderConfigOverlay("claude-code", { timeoutSeconds: 600 });
    registerPluginProviderConfigOverlay("claude-code", { baseUrl: "local://x" });
    const merged = getPluginProviderConfigOverlay("claude-code");
    expect(merged).toEqual({ timeoutSeconds: 600, baseUrl: "local://x" });
  });

  it("returns undefined for unregistered providers", () => {
    expect(getPluginProviderConfigOverlay("nope")).toBeUndefined();
  });

  it("trims providerId whitespace", () => {
    registerPluginProviderConfigOverlay("  claude-code  ", { timeoutSeconds: 600 });
    expect(getPluginProviderConfigOverlay("claude-code")).toEqual({ timeoutSeconds: 600 });
  });

  it("ignores empty providerId", () => {
    registerPluginProviderConfigOverlay("", { timeoutSeconds: 600 });
    registerPluginProviderConfigOverlay("   ", { timeoutSeconds: 600 });
    expect(getPluginProviderConfigOverlay("")).toBeUndefined();
  });
});
```

Header has four anchors: target file, bible section, bug history, what the test catches. The first time a reader opens the test, those four anchors tell them whether this test is load-bearing (yes — failures.md M1 is the canonical regression) or whether it can be deleted (e.g., if its bible anchor has been removed).

## Bible coherence — three rules

**Rule 1: every fork-owned module has at least one test, and the test header cites at least one bible section.**

If a module has no bible section, the test header is the place to add one. The discipline is _bidirectional_: writing a test that doesn't fit any bible section is a signal that either the module is undocumented or the test is testing the wrong thing.

**Rule 2: every bug in `bug-log.md` gets a regression test before the bug-log entry is "DEPLOYED."**

A bug-log entry that says "FIXED" without a paired test is not actually fixed; it's _paused_. The same upstream merge that introduced the bug can reintroduce it on the next merge. The regression test is the load-bearing piece that prevents recurrence.

For today's bibles bug-log.md, the highest-priority regression-test backfill is:

- 2026-04-03 ratelimit headers (test the parser pulls the right values from the headers)
- 2026-03-05 `onlyBuiltDependencies` wiped by merge (test the package.json invariant via a Node script)
- 2026-03-03 ESM `__filename` crash (test the grep-of-dist invariant)
- 2026-03-21 OAuth re-auth content-type (test the form-urlencoded request shape)

Each test is ~20 lines and runs in milliseconds. The cost is bounded.

**Rule 3: a test that fails after an upstream merge gets investigated before the merge ships, even if `pnpm build` passes.**

This is the unit-test analogue of the bible:invariants merge gate. The wiring is the same: after `pnpm build`, run `pnpm test --filter @fork`. A failing fork-test blocks the merge.

## Layered model

| Layer                  | What it tests                           | Speed      | When it runs           |
| ---------------------- | --------------------------------------- | ---------- | ---------------------- |
| Unit tests (vitest)    | individual fork-owned functions         | ms         | pre-commit, pre-merge  |
| bible:invariants       | observable behavior via running gateway | seconds    | pre-merge, nightly     |
| Manual smoke           | user types `/new`, sends a WA, watches  | minutes    | post-merge before push |
| Production observation | journal + tinker-ui snapshot            | continuous | always                 |

Each layer catches what the layer above missed. Unit tests catch logic bugs; bible:invariants catches integration regressions; manual smoke catches UX regressions; production observation catches the long-tail surprises.

## Don't regress

- **Don't test upstream code.** If a test file imports from `src/agents/embedded-agent-runner/run/llm-idle-timeout.ts` (upstream-owned), the test must have a written justification in its header.
- **Don't put live RPCs in unit tests.** Unit tests run without a gateway. Anything that needs a gateway is bible:invariants, not vitest.
- **Don't test private internals.** Test the _public contract_ of the module. If the test breaks during refactor of internals, the test was wrong.
- **Don't write tests with sleeps.** Use vitest's fake timers or condition-based waiting (`vi.waitFor`). Sleeps flake on slow CI.

## Pending coverage (priority order)

1. `plugin-provider-config-overlay.ts` — small, well-bounded, catches the dead-code regression class. Start here.
2. `main-session-restart-recovery.ts` — `pushRestartWarningEnvelope`, `resumeMainSession`, `recoverStore`. Each takes a fake session-store + a mock callGateway and asserts the envelope payload and resume invocation order.
3. `extensions/tinkerclaw-tinker-bridge/src/session-map.ts` — the openclawSessionId fallback path is small and recently broke.
4. `extensions/tinkerclaw-tinker-bridge/src/worker-pool.ts` — the lookup-priority rule. Tests the openclawSessionId-first ordering.
5. `src/gateway/server-methods/files-resolve-bare.ts` — pure file-system search, easy to mock.
6. `src/gateway/server-methods/briefing.ts` — fallback chain.
7. `src/fork/error-envelope.ts` — error classification table; one test per category.

That ordering minimizes setup cost (small files first) while addressing the bugs that bit hardest in May.

## How to add a test

1. Pick a file from the priority list.
2. Write the test file next to the source as `<source>.test.ts`.
3. Header with four anchors: target file, bible section, bug history, what it catches.
4. Run `pnpm test <test-file>` locally; iterate until green.
5. Run `pnpm test:fork` (or whatever the eventual fork-filtered script ends up named) to confirm no regression.
6. Commit with the convention `test(<module>): <what it asserts>`.

---

## Liveness instrumentation is a SECOND testing axis, orthogonal to unit tests (2026-07-28)

**The discovery (the architect, 2026-07-28):** the instrument-liveness registry turned out to be much more
than a fix for six inert components. It is a **complementary axis of verification that unit tests
structurally cannot cover**, and it detects a class of decay no test suite will ever catch —
including STALENESS, where code that used to run silently stops.

**Why unit tests cannot see this.** A unit test proves a function _can_ behave correctly when
called. It says nothing about whether anything _calls it in production_. All six dead components
found on this deployment had passing tests and green structural checks:

| component                      | status on paper           | reality                                                                                                          |
| ------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| headroom compression proxy     | enabled + running         | **6 requests LIFETIME, 0 tokens saved**                                                                          |
| CLI cache-telemetry producer   | correct per-call logic    | bound to an unconfigured backend — **never fired once**, while its own comment claimed it served "the MAIN pipe" |
| compaction-safeguard extension | ~1,240 lines, implemented | **dead code** under the live `compaction.mode`                                                                   |
| EEG anatomy hook               | complete function         | **orphaned** — zero callers                                                                                      |
| ORCA lease hook                | working RPCs              | enforcement bound only via project-scoped settings                                                               |
| amygdala nudge injection       | implemented               | inert                                                                                                            |

The two axes answer different questions; neither substitutes for the other:

|          | unit test                             | liveness instrument                  |
| -------- | ------------------------------------- | ------------------------------------ |
| question | "does this work when called?"         | "**is anything calling it?**"        |
| fails    | at merge, loudly                      | at runtime, and today SILENTLY       |
| catches  | logic defects                         | dead wiring, config drift, STALENESS |
| blind to | whether the code is reachable in prod | whether the logic is correct         |

**Staleness is the part with no other detector.** A test suite is a snapshot of intent; it keeps
passing while the world moves underneath it. A config flips a mode and an extension arm goes dark;
a provider is re-registered as a plugin rather than a backend and a producer stops firing; an
upstream event is renamed and a hook stops receiving. In every case the tests stay green and the
component stops running. The registry is the only thing that reports **"declared, fired 0 times"**
and **"used to fire, now silent past its own tolerance"**.

**How to apply.** For any component whose failure would be SILENT — a hook, a fallback, a retry
path, a cache, a producer, an extension gated on config — add BOTH:

1. a unit test for its logic, and
2. a `declareInstrument` + `noteInstrumentFired` pair (`src/infra/instrument-liveness.ts`), with the
   firing placed where the WORK happens and never behind the same condition that decides
   registration — otherwise you rebuild the bug.

Set `expectFireWithinMs` honestly (a rarely-exercised path must not alarm hourly) and use
`conditional` WITH A WRITTEN REASON when the live config legitimately explains silence. Otherwise
the honest silences train everyone to ignore the report, which is how liveness checks usually die.

**The rule this earns:** a component that is _tested but not instrumented_ is only half-verified —
proven correct, unproven live. On this deployment "unproven live" was the more expensive half. Six
components were doing nothing while every structural check was green.

See `design-principles.md` #20 (provenance / denominator / proof-it-ran) and `failures.md` M15.
