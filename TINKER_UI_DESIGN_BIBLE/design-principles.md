---
file: design-principles.md
purpose: Codified design rules that future agents (Architect + Jarvis + upstream-merge cron + human reviewers) should follow when changing fork code
audience: AI + maintainer
last_verified: 2026-05-12
last_verified_commit: HEAD
single_owner: yes — design principles live here. When another bible file (tool-loop, failures, etc.) says "don't regress", the rationale points back to one of these principles.
see_also: ownership.md (who owns what), unit-tests.md (how to scope tests), branch-policy.md (push gates), bug-log.md (each recurring failure class violates one of these principles)
note: this file is intentionally short. Each principle is one paragraph + one application paragraph. Long-form discussion belongs in the specific file the principle applies to (cite the principle by number from there). The point is for a future agent to load THIS file once and get the rule set, then drill into specifics on demand.
verify:
  - name: every numbered principle has a "Why" and "How to apply" section
    cmd: python3 -c 'import os,re; t = open(os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/design-principles.md")).read(); headings = re.findall(r"^### \d+\. ", t, re.M); whys = re.findall(r"^\*\*Why\.\*\*", t, re.M); hows = re.findall(r"^\*\*How to apply\.\*\*", t, re.M); assert len(headings) == len(whys) == len(hows), f"{len(headings)} principles but {len(whys)} Whys and {len(hows)} How-to-apply blocks — every principle needs both"'
  - name: file references at least 10 principles (floor — encourages growth)
    cmd: python3 -c 'import os,re; t = open(os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/design-principles.md")).read(); assert len(re.findall(r"^### \d+\. ", t, re.M)) >= 10, "design-principles.md should codify at least 10 rules"'
  - name: privacy-precedes-functionality principle is present (#17 — load-bearing since 2026-05-13)
    cmd: python3 -c 'import os; t = open(os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/design-principles.md")).read(); assert "Privacy precedes functionality" in t, "design-principles.md #17 missing — see 2026-05-13 incident"'
  - name: principle #5's claim that @sinclair/typebox is a dep stays true at runtime (FORK 2026-05-14 — upstream chunk merge dropped this dep once)
    cmd: bash -lc 'cd ~/src/tinkerclaw && node -e "require.resolve(\"@sinclair/typebox\")" 2>/dev/null || (echo "@sinclair/typebox does not resolve — principle #5 references it as a dep but package.json/install state contradicts; restore deps + pnpm.overrides entries and pnpm install"; exit 1)'
---

# Design principles — the fork-side rule set

This file is the canonical "how we change things" rule set for the public fork. Every other bible file's "don't regress" clauses derive from one of these. When the rules conflict with each other, the principle with the lower number wins; that's the only override mechanism.

The rules are short on purpose. The point is that you can load this file once at the start of a session and know the whole rule set; specific applications live in the file each rule touches (`tool-loop.md`, `failures.md`, `ownership.md`, etc.) and reference back here by principle number.

## Code organization

### 1. One concern per file, named for the concern

**Why.** A file that does two things invites two agents to edit it at the same time. `tinker-ui/src/app.ts` carrying 65 of 75 fork edits today is the live evidence — the parallel-Jarvis HUD work has collided with Architect edits multiple times. A file that does one thing has one owner, has one merge boundary, and can be reasoned about without scrolling.

**How to apply.** When you add a new probe, a new handler, a new utility — start a new file in the right zone (`ownership.md`). Don't append to an existing file unless the change is genuinely part of the same concern. Three lines added to a 6,000-line file is technically smaller, structurally worse.

### 2. Folder shape "screams" what the app does, not how it's built

**Why.** A tree organized by file type (`controllers/`, `services/`, `repos/`) tells you the tech stack but hides the domain. A tree organized by concern (`extensions/tinkerclaw-whatsapp/`, `src/gateway/server-methods/`, `src/agents/pi-embedded-runner/`) tells you what the system DOES. New contributors and AI agents both navigate by domain first; the second tree wins.

**How to apply.** New domains get their own folder. Within a folder, you may layer (entry-point / domain / data-access) if the domain warrants it — but only when the domain is big enough for the layering to add clarity rather than indirection.

### 3. DRY at the seams, not inside modules

**Why.** Premature deduplication couples two unrelated callers through a shared abstraction that has to handle every caller's exception. The cost shows up the first time you need to change "the shared thing for one caller only" and can't. Conversely, leaving duplication where it should have been factored out causes the equal-and-opposite cost — change-in-two-places blindness, which is exactly what the user has flagged as the rule we want here.

**How to apply.** Cross-cutting code (used by ≥2 modules) lives in `src/fork/` (fork-shared) or upstream's `src/shared/`. Module-internal helpers stay in the module. Duplication is allowed on the first instance; on the second instance you extract, never before. If you find a third instance, you were already late.

### 4. Wrapper composition over bespoke closures

**Why.** The fork has at least five hand-coded wrapper patterns (idle timeout, heartbeat, retry, overlay merge, PII guard). Each is its own closure with its own bugs. The shared shape — `wrapper(next)(input) → output` — is generic; composing wrappers should be data, not closure soup.

**How to apply.** New wrappers go through `src/fork/pipeline.ts`'s `compose(...)` helper. Use the canned wrappers (`withRetry`, `withTimeout`, `withTrace`) before writing custom ones. Domain-specific wrappers that DO need custom logic (cc-bridge heartbeat — protocol-aware) stay where they are, but new ones should default to the shared substrate.

### 5. Validate at boundaries, trust inside

**Why.** Defensive checking everywhere creates noise and false confidence. Defensive checking at exactly the points where untrusted data enters (HTTP / WS / plugin RPC / config load / file read) catches the real class of bugs (M6 plugin-manifest-invalid, malformed openclaw.json, hostile WA payloads) without polluting internal code.

**How to apply.** Use a runtime schema validator (`@sinclair/typebox` is already a dep) at every boundary. Inside a module, trust your own types. A function that takes `{sessionKey: string}` from another fork-internal function doesn't need to re-validate; one that takes the same shape from a WS request does.

## Concurrency + merge friction

### 6. One-feature-per-file beats one-line-in-many-files

**Why.** Today's most expensive merge-friction events are concentrated on a few files: `server-methods.ts`, `app.ts`, `openclaw.json`. Adding 12 RPCs by editing one central file invites 12 merge conflicts; adding 12 RPCs by adding 12 new files invites zero. The Git data is unambiguous.

**How to apply.** When the choice is "edit a central file with a 2-line addition" vs. "add a new file in a side namespace", choose the new file. The pre-push `bible:invariants` gate catches missing wiring; the new-file path costs nothing in collision risk.

### 7. Pull before every push

**Why.** Today's session lost ~30 minutes when Jarvis's parallel HUD work was unstaged on the same path I was pushing. Two pushes converged on the same file with no prior rebase. `git pull --rebase` before push would have surfaced it instantly.

**How to apply.** Every push starts with `git pull --rebase origin develop`. The pre-push hook should refuse to push if the local branch is behind the remote — adding that check is a one-line addition to `git-hooks/pre-push` whenever someone has the cycles.

### 8. Upstream files get minimal-touch edits only

**Why.** Every line added to an upstream-owned file (`server-methods.ts`, `package.json`, `openclaw.json`) is a future merge conflict. Fork-only files (`src/fork/*`, `extensions/tinkerclaw-*/`, `TINKER_UI_DESIGN_BIBLE/`) are conflict-free by construction because upstream never writes there.

**How to apply.** When you must edit an upstream file, edit the smallest possible region (one import line + one spread line is fine; rewriting a function is not). Track the edit's location in `failures.md` M3 so the upstream-merge audit knows to verify it survived. Prefer adding files over modifying them — every time.

## Observability + debugging

### 9. Observability is a design property, not a bolt-on

**Why.** The "I'll add logging later" pattern produces logs that match the code's structure, not the user's question. Designing telemetry alongside the implementation forces you to answer "what would I want to see when this breaks?" while you still have the context to answer it cheaply.

**How to apply.** Every new feature ships with the events that prove it works AND the events that prove it broke. The bible's `failures.md` `diagnose_with:` and `manifest_via:` fields are the contract. Without both fields, a new failure mode shouldn't be documented as "supported".

### 10. One correlation ID threads through everything

**Why.** The single biggest debugging multiplier is being able to follow one operation across logs, probes, and traces without joining on multiple keys. Today the fork has `runId`, `sessionKey`, sometimes a span ID, sometimes nothing — and every debugging session pays the cost of stitching them together by hand.

**How to apply.** New code that participates in an operation accepts a `correlationId` (or `runId`, the existing equivalent for chat turns) and threads it through every log line, every probe event, every plugin call. Don't invent a new ID type; reuse `runId` where it exists. Adding a correlation ID to an existing event is always cheaper than retrofitting it during an incident.

### 11. Probes are paired with the write surface they shadow

**Why.** The J15 agent-feedback-symmetry principle: every action surface (write) has a probe (read) that returns the same surface's state. Without the pairing, debugging is asymmetric — you can change the system faster than you can inspect it.

**How to apply.** When you add a write surface (a new RPC, a new file, a new state mutation), add the matching read surface in the same PR. The pre-push gate enforces this via the bible's `verify:` blocks; failures.md `diagnose_with:` makes the pairing explicit. If you can't articulate the probe, the write surface isn't done.

### 12. Negative evidence is logged too

**Why.** "X was supposed to happen but didn't" is responsible for at least 7 of today's bug-log entries (lifecycle dropped, fallback errors never emitted, stop button not working). Today we only log positive events; the absence of an expected event passes silently until a human notices the symptom.

**How to apply.** When you wire a new lifecycle (start → end pair, request → response pair), also wire a negative-event log: "expected `lifecycle:end` for runId=X within 30s of `lifecycle:start`, did not see it." A timer + an in-memory map of pending operations is the typical shape. The cost is small; the catch is large.

### 13. Round-trip-test the symmetry

**Why.** A `diagnose_with:` claim that's never been exercised is a hope, not a contract. Every bug-log entry that says "we thought we'd catch it" is evidence of a probe that wasn't proved to detect what it claimed.

**How to apply.** For each failure mode in `failures.md`, add a `manifest_via:` field naming an admin-scope RPC that injects the failure (see `debug.simulate.stuckSession` as the first instance). The pair (`manifest_via` → fire fault → `diagnose_with` → confirm caught) becomes a round-trip self-test the merge gate can run.

## Process discipline

### 14. Defer abstraction until the second change

**Why.** "Rule of three": code that looks similar may diverge over time. Premature abstraction couples two callers that will eventually need to differ, and the extraction itself becomes the new merge-friction surface.

**How to apply.** First instance: ship it. Second instance: extract a shared helper, ideally in `src/fork/pipeline.ts` or the relevant `*-shared` location. Third instance: the helper already exists; just use it. Don't anticipate the second instance during the first.

### 15. Don't over-do it

**Why.** Every refactor pays a merge-conflict tax. "Make it great" doesn't mean "rewrite everything"; it means "address the highest-cost gaps with the lowest-risk changes". The 80/20 rule applies to architecture work directly.

**How to apply.** When in doubt, ship the smallest version of the improvement that captures the value. The brainstorm list is the long horizon; each session picks 3–6 items from it that ship cleanly. The list isn't a checklist of mandatory work — it's a menu.

### 16. The bible audits itself

**Why.** Documentation that isn't tested rots. The verify discipline (`pnpm bible:invariants`) is the mechanism that keeps the bible trustworthy; without it, the bible would drift into folklore within months.

**How to apply.** Every new bible file gets a frontmatter `verify:` block from day one. Every claim that names a file path, a method, or a value gets a verify that asserts the named thing exists. Bible meta-verify (cross-references, ownership claims, INDEX coverage) is part of the same runner. If you write a fact and you can't verify it, write the verify first or don't write the fact.

### 17. Privacy precedes functionality

**Why.** The 2026-05-13 audit found 16 PII hits had accumulated on `origin/develop` across earlier pushes — each push was individually clean within its own range, but the union across the develop branch was not. Privacy is not a co-equal axis with functionality; it dominates. A change that ships private data degrades trust in a way no later functional improvement can undo. The PII boundary (`pii-boundary.md`) is the contract; the leak-grep gate (`scripts/pii-pre-push.sh`) is the enforcement; both must run BEFORE main can advance and BEFORE the maintainer says "ship it." When sanitization is in tension with delivery speed, sanitization wins.

**How to apply.** (a) Treat `PII_GUARD=off` bypass as an emergency-only escape hatch; every use requires written justification (commit message or comment). (b) The pre-push hook scans TWO scopes from 2026-05-13: the push-range (always was) AND the accumulated-drift range from `origin/main..HEAD` (new). Pushing develop tests against main; pushing main is the final gate. (c) When auditing manually (before a `develop → main` merge), the canonical command is `git log -p origin/main..origin/develop -- ':(exclude)scripts/pii-pre-push.sh' ':(exclude)TINKER_UI_DESIGN_BIBLE/pii-boundary.md' ':(exclude)CLAUDE.md' | grep -P '^\+[^+].*<regex from pii-pre-push.sh>'`. Zero hits required, no exceptions. (d) Educational files that document the regex (the bible's `pii-boundary.md`, this principle, the script itself) use `<FirstName>` / `<owner-e164>` placeholders so they don't trip their own grep. Other files use the actual placeholder-free prose — but with `the user` / `the operator` / `the owner` standing in for any first name.

### 18. One canonical derivation per concept — name it, document it, never re-derive

**Why.** The most expensive class of defect here is not a wrong line — it is _re-implementing a concept we already implemented, without knowing we had_. 2026-05-16: "is this session busy?" was computed FOUR different ways (the chat thinking-indicator's sessionKey filter, the tab-global `sending` boolean, the sessions-panel per-session scan, the prefrontal extension-tree path). Each was individually reasonable; together they silently disagreed on every long turn — chat stuck on "sending", prefrontal "idle", sessions "thinking" — and it took a multi-hour investigation just to _characterize_ the inconsistency before any fix was possible. This is the "do it, forget we did it, break it, do it differently" loop. A derived concept with N implementations carries N−1 latent contradictions and zero compiler signal; the defect is structural, not local. The optimal route is always exactly one derivation, named, and documented so the next agent _finds it instead of inventing a second_. This is the read-side complement of #3 (DRY at the seams) and the necessary follow-through to #14 (defer abstraction): #14 says don't abstract too early; #18 says once a concept is computed in ≥2 places it MUST collapse to one named helper, and the collapse is not finished until the bible records where that helper lives and why it is the only one.

**How to apply.** Before computing any non-trivial _derived_ value — a match predicate, a scope filter, a UI state like busy/idle/active, a canonical-key resolution — grep for an existing canonical helper first; if one exists, call it, never inline a parallel computation "just here". When a concept reaches a second call site, extract ONE named helper co-located with the state it derives from — do NOT scatter it into a new file if that fragments it away from its inputs (colocation beats tidiness: moving the 2026-05-16 `runBelongsToViewedSession` / `scopedActiveRuns` / `viewedSessionBusy` helpers out of `app.ts` would recreate the very fragmentation that caused the bug). Then write the _meta-code_: in the single-owner bible optic for that concern (per `ownership.md`), document what the helper means, which consumers must route through it, and _why there is exactly one_. Add a frontmatter `verify:` (per #16) that fails the build if the helper is deleted OR a divergent re-derivation reappears. The principle is satisfied only when all three exist together: the single helper, the bible prose naming it canonical, and the verify that makes re-fragmentation un-mergeable. A concept that is computed but not documented-as-canonical is a future redundancy already in flight.
