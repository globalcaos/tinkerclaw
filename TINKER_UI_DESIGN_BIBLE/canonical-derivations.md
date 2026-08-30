---
file: canonical-derivations.md
purpose: The register of concepts that must have exactly ONE implementation — and an executable ratchet that fails the build when one gains another
audience: AI + maintainer
last_verified: 2026-08-04
last_verified_commit: HEAD
single_owner: yes — duplicate-derivation policy lives here. design-principles.md #18 states the RULE; this file holds the LEDGER and the gate.
see_also: design-principles.md#18 (one canonical derivation per concept), design-principles.md#20 (a measurement carries provenance), FOUNDATION.md ("Three different jobs, three different homes" — why the gates below are one-line pointers), bug-log.md (every entry below cost a real incident), failures.md
note: |
  #18 has existed since 2026-05-16 and is correct. It could not fail a build, so the codebase kept
  growing second implementations anyway — 10 of cosineSimilarity, 13 of estimateTokens. This file is
  the missing half: a counted ledger plus a RATCHET. The counts below are the measured status quo,
  not a target. The gate does not demand you fix them; it demands you never make them worse.
  The counts table in the prose is the readable copy. The ENFORCED numbers are the LEDGER constant
  at the top of scripts/bible/canonical-ledger-ratchet.mjs — move both in the same commit, and the
  --check-table gate below fails the build if you don't. If they ever disagree, THIS FILE is the
  authority and the script is the bug.
verify:
  # POINTERS, not programs. The checks live in scripts/bible/ per FOUNDATION.md, "Three different
  # jobs, three different homes": explain here, enforce in the running code, CHECK in a script that
  # can be linted, reviewed and — the reason this one moved — TESTED. The ratchet is the most
  # load-bearing gate the bible has, and it had no test for as long as it lived in this frontmatter.
  - name: no concept in the ledger gains another implementation (ratchet — counts may fall, never rise)
    cmd: cd ~/src/tinkerclaw && node scripts/bible/canonical-ledger-ratchet.mjs
  - name: the ratchet itself trips — a simulated extra implementation fails every ledger row, and no ledger regex has rotted into matching nothing
    cmd: cd ~/src/tinkerclaw && node scripts/bible/canonical-ledger-ratchet.mjs --self-test
  - name: the counts table in this file and the enforced LEDGER caps say the same thing (one fact, two readable homes)
    cmd: cd ~/src/tinkerclaw && node scripts/bible/canonical-ledger-ratchet.mjs --check-table
  - name: the leak-grep pattern has exactly one definition (collapsed 3 -> 1 on 2026-08-03)
    cmd: cd ~/src/tinkerclaw && node scripts/bible/canonical-singletons.mjs --check=pii-re
  - name: the chrome extension has exactly one tree (collapsed 2 -> 1 on 2026-08-03)
    cmd: cd ~/src/tinkerclaw && node scripts/bible/canonical-singletons.mjs --check=chrome-extension
  - name: the ENGRAM library is not vendored back into an extension, and its sanctioned crossing still exists (collapsed 2 -> 1 on 2026-08-03)
    cmd: cd ~/src/tinkerclaw && node scripts/bible/canonical-singletons.mjs --check=engram
---

# Canonical derivations — the ledger and the ratchet

`design-principles.md` #18 says it: **one canonical derivation per concept, named, documented, and
never re-derived.** The rule is right and has been since 2026-05-16. It also could not fail a build,
so the tree kept growing second implementations regardless.

This file is the half that bites.

## Why a ratchet and not a rule

The measured status quo on 2026-08-03, after the ENGRAM collapse:

| Concept                    | Implementations |       Was |
| -------------------------- | --------------: | --------: |
| `estimateTokens`           |          **12** |        13 |
| `cosineSimilarity`         |           **8** |        10 |
| `deliverWebReply`          |               3 |         3 |
| `mmrRerank`                |               3 |         3 |
| `retrieval-pack assembler` |               2 |         2 |
| `movePathToTrash`          |               2 |         2 |
| `estimateTokensFromChars`  |               2 |         2 |
| `assembleRetrievalPack`    |           **1** | 2 ✅ done |

**Which of these numbers is the gate?** Not this table. The table is the readable copy, kept here
because a reader must be able to see the ledger without opening a script. The numbers the build
actually fails on are the `LEDGER` constant at the top of
[`scripts/bible/canonical-ledger-ratchet.mjs`](../scripts/bible/canonical-ledger-ratchet.mjs): one
row per concept — the regex that matches its **definition** sites, and the cap. The two cannot
drift, because `--check-table` fails the build when they disagree in either direction; and when
they do disagree, **this file is the authority and the script is the bug**. Keep the shape of the
rows above (a backticked concept in the first cell, its count in the second) — the gate parses
them. `node scripts/bible/canonical-ledger-ratchet.mjs --list` prints the measured counts without
failing, so settling any of this takes one command.

Collapsing 13 token estimators is not a session's work, and a gate that demands it on day one gets
switched off — which is how you end up with 13. So the gate asserts only that **the count never
rises**. Adding a ninth `cosineSimilarity` fails the build; collapsing two and lowering the cap
in the same commit passes. The numbers only move one way.

`estimateTokens` is the worst of them and deserves naming: it is a **measurement**, and #20 requires
a measurement to carry its provenance. Thirteen estimators that disagree, none declaring whether it
is `estimated` or provider-reported, is precisely the failure #20 was written after.

### The two rows added 2026-08-04, and why each earns its line

Both came out of an ORCA pass that read the retrieval and token paths side by side. Neither is a
"there are N copies" observation — a bare count is cheap and the ledger would drown in them. Each is
here because the copies **behave differently**, which is the only version of this bug that can bite.

**`mmrRerank` — 3 sites, and the two exported ones already diverged.** `src/memory/mmr.ts` (215
lines) and `extensions/memory-core/src/memory/mmr.ts` (250 lines) export the **same nine symbols**
and are 50 diff-lines apart. This is the twin shape from the ENGRAM collapse, caught earlier: the
copies started identical and one of them got maintained. There is also a third, private
`mmrRerank` at `src/memory/engram/retrieval-integration.ts:76` — not exported, so no import graph
reveals it, and a maintainer collapsing "the two copies" would leave it behind still running. That
third one is the reason the cap is 3 and not 2: **the ledger counts definitions, not modules**,
because a private re-derivation is exactly as capable of disagreeing as a published one.

**`estimateTokensFromChars` — 2 sites that return different numbers.** This is the sharper of the
two, and the reason it gets its own row despite already being inside the `estimateTokens` count:

| Site                                  | Body                                               | `chars=5` |
| ------------------------------------- | -------------------------------------------------- | --------: |
| `src/utils/cjk-chars.ts:79`           | `Math.ceil(max(0, chars) / CHARS_PER_TOKEN)`       |     **2** |
| `extensions/ollama/src/stream.ts:546` | `Math.max(1, Math.round(chars / CHARS_PER_TOKEN))` |     **1** |

Same name, same constant, same intent — one rounds up, the other rounds to nearest and floors the
result at one. They agree on 0 and on 2; they part company at 5 and stay parted. A duplicate that is
merely redundant costs maintenance. A duplicate that **disagrees numerically** costs a budget
decision: whichever of these feeds a context-window check is deciding whether to truncate on a
different arithmetic from the one that reported the usage. That is a #20 provenance failure with a
concrete
consumer, so it is worth counting on its own even though the broader `estimateTokens` row overlaps
it. The overlap is deliberate: the wide row tracks sprawl, the narrow row tracks the pair that is
already wrong.

## Already collapsed

Recorded so nobody re-splits them, each with the incident that paid for it.

| Concept                     | Was | Now                                                                   | What it cost                                                                                                                                                     |
| --------------------------- | --: | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PII leak-grep pattern       |   3 | `PII_RE` in `scripts/pii-pre-push.sh`                                 | one copy lived in the **private** repo and was called canonical; a contributor cloning the public fork would have had no pattern and a silently-passing gate     |
| Chrome extension tree       |   2 | `extensions/tinkerclaw-browser-relay/chrome-extension`                | the CLI installed the **older** copy — v0.1.0, `host_permissions` limited to localhost, so it could not relay a real site. Six weeks of relay work never shipped |
| AMYGDALA subsystem          |   2 | `extensions/tinkerclaw-learned-intuition`                             | 3,152 dead lines in `src/amygdala` kept alive by four `expect(mod).toBeDefined()` assertions                                                                     |
| cron wake-target resolution |   2 | `resolveCronWakeTarget`, reached only via injected deps               | a second path skipped the resolver and re-broke a fixed bug — see below                                                                                          |
| ENGRAM memory library       |   2 | `src/memory/engram/`, reached via `openclaw/plugin-sdk/memory-engram` | 30 vendored files drifting for four months. See _When a boundary rule causes the duplication_ below — this is the one worth reading twice                        |

## The two shapes this failure takes

**1. Twin implementations, instrument welded to the corpse.** `assembleRetrievalPack` exists twice
with different signatures — `src/memory/engram/` (sync) and `extensions/tinkerclaw-total-recall/src/`
(async). The `engram:retrieval-pack-inject` instrument is attached to the **dead** one, so the
liveness registry reports the opposite of the truth. Same shape in the amygdala twin: the panel read
the write half while the read half had never fired.

**2. A second route that skips the canonical derivation.** On 2026-08-03 a new cron wake lane called
`runCronWakeOnce` directly instead of through the injected dep — bypassing `resolveCronWakeTarget`,
the helper that turns a main-target cron's absent `job.sessionKey` into a concrete session key. That
**re-broke a bug fixed on 2026-07-25 by routing around the layer that fixed it.** The fix's own
comment describes the failure verbatim.

Shape 2 is the dangerous one, because it leaves no duplicate to grep for. The only defence is that
the canonical helper be the _only reachable path_ — injected, not importable — and that this file say
so out loud.

## When the only available exemption is the wrong one

The ENGRAM collapse (2026-08-03) is the case to learn from, because nobody was careless — and
because the first write-up of it (mine) got the diagnosis wrong in a way worth preserving.

`pnpm lint:plugins:no-extension-src-imports` forbids extensions from importing the repo `src/` tree.
`tinkerclaw-total-recall` instead carried a private 26-file copy of `src/memory/engram/`, and its own
`__tests__/scaffold.test.ts` locked that copy in with three assertions: _no `src/**` leaks_, _all 26
source files present_, and _no `../../` imports_.

**What I wrote first, and it was false:** _"there was no sanctioned crossing."_ There was.
`FORK_EXTENSION_ALLOWLIST` has lived in the checker since `013711df4c4` (2026-03-22) — **eight days
before this plugin existed** (`7220c637582`, 2026-03-30). I asserted the absence of an escape hatch
without opening the file I had just run, which is the exact shape of `core-principles.md`'s _"check
the codebase — is the capability already there, just not wired up?"_

**What is true, and is the more useful lesson:** the allowlist was available and would have been the
**wrong** fix. It is a lint exemption and nothing else. `tinkerclaw-total-recall` is
`publishToNpm: true`, ships `files: ["index.ts", "src/", …]`, and declares `openclaw` only as an
_optional_ peerDependency — so `../../src/**` is unresolvable inside the published tarball however
the linter is configured. An allowlist entry turns the gate green and ships a package that throws
`ERR_MODULE_NOT_FOUND` on first use. A subpath is the only crossing that survives packaging.

> **Availability is not validity.** When a rule has more than one escape hatch, the question is not
> "is one open?" but "which one is correct for _this_ artefact?" Ask what the code has to survive —
> compilation, packaging, install, a split bundle graph — not what the gate will accept.

Four months of drift followed, and every symptom was invisible from either side alone:

- a second `vectorSearch` grew beside the one the copy's own **byte-identical** `search-index.ts`
  already exported;
- `temporal-decay.ts` carried a header comment claiming it was "wired into retrieval-integration.ts"
  — it was imported by nothing but its own test;
- `knowledge-compiler.ts` had never executed on any path, in the plugin or the CLI or `dist`;
- the `engram:retrieval-pack-inject` instrument was welded to whichever copy was dead, so the
  liveness registry reported **the inverse of the truth**.

The fix was not to weaken the rule. It was to build the crossing the rule's own error message
prescribes — `src/plugin-sdk/memory-engram.ts`, a deliberately narrow surface — and then delete the
copy. Six port candidates were investigated and **all six refuted**: every capability that looked
exclusive to the copy was either already present in the canonical library under another name, or
provably dead, or a regression if grafted on.

This is also what upstream intended. `a0aba7302a4` (Peter Steinberger, 2026-03-17) added the checker
**and** `channel-runtime`, `config-runtime`, `agent-runtime` plus four `*-core` subpaths in the same
commit, documenting them in `docs/tools/plugin.md` as _"narrow … subpaths for channel-specific
primitives that should stay smaller than the full channel helper barrels."_ The boundary was never
"don't touch core"; it is **"cross through a versioned surface."** Upstream states the reason at
`extensions/AGENTS.md:73` — _"Keep new plugin-facing seams backwards-compatible and versioned.
Third-party plugins consume this surface."_

### Which crossing is correct

| The extension is…                              | Correct crossing              | Why                                                                                                                                                                                                                         |
| ---------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publishToNpm` or `publishToClawHub`           | **SUBPATH, always**           | the tarball ships only its own directory and `openclaw` is an _optional_ peer — a relative `src/` reach cannot resolve at install, whatever the lint says                                                                   |
| bundled-only, unified build graph              | allowlist is fine             | nothing is published and core is emitted once                                                                                                                                                                               |
| bundled-only, `stageRuntimeDependencies: true` | **check before allowlisting** | `tsdown.config.ts:288-341` gives that extension its own rolldown graph, so a relative `src/` import **inlines a second copy of core** into the plugin bundle. Only safe if the module is `globalThis`-hardened or stateless |

That third row is the failure mode that applies even to a plugin nobody ever publishes, and it is
the one worth remembering: `dist/extensions/tinkerclaw-learned-intuition/index.js` is 194 KB with
`emitAgentEvent` inlined and **no edge** back to core's copy. It does not bite today only because
`src/infra/agent-events.ts:127` resolves its state through
`resolveGlobalSingleton(Symbol.for("openclaw.agentEvents.state"))`. The repo already names the class
at `scripts/check-gateway-watch-regression.mjs:776`: _"split runtime personalities where plugins and
core observe different global state."_

When you add or enforce a boundary, ship the crossing in the same change — upstream did. And when
you find a duplicate, check whether a rule is _requiring_ it before you blame whoever wrote it —
but check the history before asserting that it was.

**A test that asserts a duplicate still exists is not a guard — it is life support.** `has all 26
source files in src/` is the same shape as the four `expect(mod).toBeDefined()` calls that kept 3,152
dead amygdala lines in the build. Both pass forever, both describe a directory rather than a
behaviour, and both fail only when someone tries to fix the problem.

## How to add to the ledger

When you collapse a concept, or find a new one that must be singular:

1. Add a row to the `LEDGER` constant at the top of `scripts/bible/canonical-ledger-ratchet.mjs`
   with a regex matching its **definition** sites and the count you measured — `--list` measures it
   for you — and mirror the row into the counts table above so it is legible without opening the
   script. The regex is POSIX ERE: it is handed to `grep -rnE`, not to a JS `RegExp`. `--check-table`
   fails the build if you add it in only one of the two places.
2. Record it in _Already collapsed_ with the incident that paid for it. The incident is the part
   future readers act on; the rule alone never has been.
3. If the concept cannot be expressed as a grep — shape 2 above — say where the single reachable
   path is and why the alternatives are unreachable, and add a `verify:` asserting that property
   directly (e.g. "timer.ts must not import the wake functions") — as a one-line `cmd:` pointing at
   a `scripts/bible/*.mjs`, never as a program pasted back into this frontmatter.

## Don't regress

- The ledger caps move DOWN only. Raising one — in `scripts/bible/canonical-ledger-ratchet.mjs`,
  where they are enforced — is not a fix; it is the bug being recorded as policy, exactly what
  `bug-log.md:257` did when it made "keep the two `GENERIC_WS_CLIENT_LABELS` sets in lockstep" a
  _don't-regress rule_ instead of collapsing them. The ratchet prints that sentence in its own
  failure message, because the moment you read it is the moment you are tempted.
- The gates stay in `scripts/bible/`, one line of `cmd:` each. A check pasted back into this
  frontmatter is untested by construction — and the ratchet is the last gate in the bible that can
  afford to be the least-exercised code in the repo. See `FOUNDATION.md`, _Three different jobs,
  three different homes_.
- Never document a duplication as a maintenance instruction. `bible.md:1050` §5.84a records two
  effort-resolution paths as a lesson, and `bible.md:1368` sanctions a triple-derived provider value
  as "a belt to the suspenders". Both are duplications wearing a policy costume.
- A concept that is computed but not registered here is a future redundancy already in flight (#18).
