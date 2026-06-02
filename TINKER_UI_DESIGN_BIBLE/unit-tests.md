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
---

# Unit tests — fork-side strategy

The bible:invariants suite (`scripts/test-invariants.mjs`) is the **integration** layer: it exercises probes through a running gateway and asserts on observable RPC output. Unit tests are the **finer** layer: they exercise fork-touched modules in isolation, run in milliseconds, and catch the class of regression that lives _inside_ a single function.

Together: bible:invariants catches "the feature is broken end-to-end"; unit tests catch "the implementation drifted in a way that hasn't surfaced yet."

## Scope: what the fork owns

We DO NOT test upstream's code. Upstream has its own tests; running them here is duplicate work that breaks when upstream refactors. The fork tests **fork-touched** code, which today is:

- `src/agents/plugin-provider-config-overlay.ts` (FORK 2026-05-10)
- `src/agents/main-session-restart-recovery.ts` (FORK 2026-05-09/10)
- `extensions/tinkerclaw-cc-bridge/` (all)
- `extensions/tinkerclaw-whatsapp/` (fork-owned)
- `extensions/tinkerclaw-people/` (fork-owned)
- `extensions/tinkerclaw-prefrontal/` (fork-owned)
- `src/gateway/server-methods/{briefing,files-resolve-bare,debug-probes,cron-probes,debug-ui-snapshot,config-open-external}.ts` (fork-added RPCs)
- `src/gateway/server-methods/chat.ts` only inside the `chat.send` backstop block (FORK 2026-05-10)
- `src/fork/error-envelope.ts` and other `src/fork/*` modules
- `tinker-ui/src/app.ts` for fork-added UI behaviors

Tests for any path outside this list need an explicit reason in the test file's header.

## Framework

Vitest, matching upstream. Test files live next to their source as `*.test.ts` (vitest auto-discovery). The repo already has `scripts/run-vitest.mjs`; reuse it.

A typical fork-side test file:

```ts
/**
 * Test target: src/agents/plugin-provider-config-overlay.ts
 * Bible anchor: config-shape.md §4.1 ("Plugin runtime overlay")
 * Bug history:  failures.md M1 (cc-bridge SIGTERM), bug-log.md 2026-05-10
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
3. `extensions/tinkerclaw-cc-bridge/src/session-map.ts` — the openclawSessionId fallback path is small and recently broke.
4. `extensions/tinkerclaw-cc-bridge/src/worker-pool.ts` — the lookup-priority rule. Tests the openclawSessionId-first ordering.
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
