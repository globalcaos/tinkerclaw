---
file: pii-boundary.md
purpose: What's safe to push to the public tinkerclaw fork; what must stay in private jarvis-brain
audience: AI
last_verified: 2026-08-04
last_verified_commit: HEAD
single_owner: yes — the PII boundary INTENT is canonical here; the executable regex has exactly one home (scripts/pii-pre-push.sh) and this file must never hold a second copy
see_also: topology.md (the two-repo split), crons.md (auto-merge gate), design-principles.md#18 (one canonical derivation), design-principles.md#19 (no frozen lists)
note: this file documents intent in prose and deliberately contains NO protected literal, so it needs no self-exclusion from its own gate. If you ever paste the regex in here, you have reintroduced the duplication this file exists to forbid.
verify:
  # The two programs these checks used to inline now live in scripts/bible/ — FOUNDATION.md,
  # "Three different jobs, three different homes". Nothing about the gate was relaxed in the move:
  # the pattern is still SOURCED (never copied) from scripts/pii-pre-push.sh, the file list is still
  # a GLOB, and the FAIL-CLOSED property is no longer a promise in prose — pii-optics-clean.mjs
  # proves it on every run by pointing child processes at fixtures whose PII_RE is missing / empty /
  # ambiguous and requiring each to exit non-zero, then proves the compiled regex actually fires.
  # The scripts hold no literal either: see "Don't regress" below.
  # Both now resolve the repo from git rather than a hardcoded ~ path, so they are correct in a
  # linked worktree — the old `cd ~/src/tinkerclaw` silently checked the WRONG tree there.
  - name: no bible optic matches the leak-grep regex (pattern sourced from the one gate; files globbed, never listed; fails CLOSED)
    cmd: cd "$(git rev-parse --show-toplevel)" && node scripts/bible/pii-optics-clean.mjs
  - name: the leak-grep pattern is DEFINED in exactly one place (counts definitions, never the literal)
    cmd: cd "$(git rev-parse --show-toplevel)" && node scripts/bible/pii-pattern-single-home.mjs
---

# PII boundary — public tinkerclaw vs private jarvis-brain

The fork ships to a **public GitHub repo** (`globalcaos/tinkerclaw`). The workspace runtime data ships to a **private GitLab repo** (`globalcaos/jarvis-brain`, via the symlink layout — see topology.md). The split is load-bearing: a leak from private to public is irreversible (git blob already pushed; even a force-push can't unpublish).

## Public-OK

These are explicitly allowed on the public fork:

- **The architect's full name pair** (first + last) on author bylines (FORK.md, package.json `author` field, paper bylines). Normal OSS authorship practice.
- **The `globalcaos` handle** — already on the GitHub URL, badges, plugin org. Public domain by deployment.
- **Public-OK paths** — `~/src/tinkerclaw/`, `~/Documents/AI_reports/Papers/` (the J-series is intended for publication).

## Private-only (NEVER on the public fork)

- **First-name narrative use** of the architect's name. The full-name byline is fine; first-name narrative ("\<first\> said …") is not. Rewrite as "the user said …" or "the architect said …".
- **Family or contact names** — spouse, children, in-laws, siblings, friends, business contacts. Use role placeholders (`a family member`, `the sister`).
- **Location** — city/neighborhood/address. Generic location placeholder if needed.
- **Host paths** — the architect's home-directory path. Rewrite as `~/` in user-facing strings.
- **Business contacts** — workplace name, customer/supplier names. See memory `project_serra_business_threads.md` (private).
- **Phone numbers** — including the architect's own and any contact number.
- **Email addresses** — both personal and work. Use `@example.com` placeholders for fixtures.
- **Credentials** — API keys, OAuth tokens, session cookies. ALL env vars in `openclaw.json`'s `env.vars` block (lives in private jarvis-brain only).
- **GitLab project tokens** — the standard GitLab personal-access-token prefix is a sentinel for leak grep.

## The leak-grep regex — one executable home

Run the gate BEFORE every `git push tinkerclaw`. If anything matches in a public-bound file, sanitize first.

```
PATTERN: (architect-first-name-with-negative-lookahead-for-surname) OR (family-first-names) OR (Catalan-surname-token) OR (home-city-string) OR (host-path-prefix) OR (workplace-string) OR (customer-name-token) OR (gitlab-token-prefix) OR (work-email-local-part)
```

That is a PROSE form and is deliberately not executable.

**The single executable source of truth is `PII_RE` in `scripts/pii-pre-push.sh`** (2026-08-02). Everything
that needs the pattern — the pre-push hook, this file's `verify:` blocks, any future tooling — _sources it
from there_. Nothing holds a second copy.

**Why it moved here from `~/src/jarvis-icu/CLAUDE.md` (2026-08-02).** The previous text named a file in the
**private** repo as canonical for a gate that protects the **public** one. That is unsound three ways: the
public fork must be self-contained (a contributor cloning `tinkerclaw` has no `jarvis-icu`), the gate would
silently no-op wherever the private repo is absent, and it forced this file to hold a third copy in its own
frontmatter just to have something runnable — which is why the file used to have to exclude itself from its
own check. One public home fixes all three.

**What was wrong before, recorded so it is not re-introduced.** The frontmatter check hardcoded a
**twelve-file list** written when the bible had ~13 optics. The bible reached 29 and the list never grew, so
**17 optics — including `FOUNDATION.md` — were never scanned**. A 2026-08-02 sweep found 82 bare first-name
uses across 6 unchecked files (64 of them unpushed, in `bug-log.md` and `tinker-ui.md`); the one file the
gate did catch, `auth-routing.md`, was caught only by the luck of being on the old list. This is the frozen-
list failure that `design-principles.md` #19 forbids, sitting inside the check this file calls the most
important in the bible. **The list is now a glob and the regex is now sourced — neither can go stale.**

## Push policy (2026-05-09)

Push policy is LIFTED for the architect. The architect may `git push` directly to `tinkerclaw/develop`. `main` only advances by mutual agreement.

Still required before a push:

1. **Run the leak grep** — `scripts/pii-pre-push.sh`, which owns `PII_RE`. It runs automatically as pre-push gate #1; run it by hand when you want the answer before committing.
2. **Confirm `git status` reflects intentional content.** No accidental jarvis-brain artifacts.
3. **Force-push and `--no-verify`** still require explicit user confirmation; they bypass safety machinery.

## Sanitization workflow

When a string under one of the private-only categories is needed in a code comment, docs section, test fixture, etc.:

- Replace the home-directory absolute path with `~/` in user-facing strings.
- Replace first-name narrative use with role placeholders (`the user said …`, `the architect said …`).
- Replace specific people with role placeholders (`the spouse`, `a family member`, `the sister`).
- Replace numbers with masked equivalents.
- Replace business names with generic placeholders or `[redacted]`.

For test fixtures that genuinely need a phone number, use the E.164 reserved-for-fiction range (the `+1 555 555 0xxx` block).

## Verify

The executable checks are the two `verify:` entries in this file's frontmatter. They are the most important
`verify` commands in the entire bible and must pass on every pre-push to `tinkerclaw`. Since 2026-08-04 each
entry is a **one-line pointer** at a script — `scripts/bible/pii-optics-clean.mjs` and
`scripts/bible/pii-pattern-single-home.mjs` — because a gate this load-bearing must be lintable, reviewable
and testable as code, which a program pasted into YAML frontmatter can never be (FOUNDATION.md, _"Three
different jobs, three different homes"_). Between them they assert four things:

1. **Coverage** — every `TINKER_UI_DESIGN_BIBLE/*.md` is scanned, by glob. Adding an optic cannot create a
   blind spot.
2. **Single derivation** — the pattern is read out of `scripts/pii-pre-push.sh` at run time, so this file and
   the gate can never disagree.
3. **The check cannot pass vacuously** — if `PII_RE` is missing, empty, ambiguous (defined twice), or does
   not compile, the check FAILS loudly instead of scanning with an empty pattern and reporting success. A
   privacy gate that cannot find its pattern is not a gate (`design-principles.md` #20: _a declared
   instrument that never fires is a defect_). **This is now proven, not promised:** every run first executes
   the negative test — child processes aimed at broken fixtures, each required to exit non-zero — and then a
   liveness probe that takes the plain-literal alternatives out of the pattern it just sourced and asserts the
   compiled regex matches each one. The probe is derived at run time precisely so that proving the regex
   fires does not require writing a protected literal into a public file.
4. **Matches are named by FILE, never quoted** — echoing the matched text would copy the private data into
   CI logs, which is the leak the gate exists to stop.

**One real hole was found and closed while extracting these (2026-08-04).** The second check used to be
`grep -rl '^PII_RE=' … | wc -l`, and `-l` counts _files that match_, not _matches_. A single file defining
`PII_RE` **twice** therefore passed it — which is precisely the drift this check exists to catch, and the
worst shape of it, because bash silently keeps the last assignment while a reader's eye stops at the first.
The check now counts definitions, per file and in total, as its name always claimed. Confirmed by negative
test: duplicating the assignment inside `scripts/pii-pre-push.sh` was green before the fix and is red after.

## Don't regress

- The leak-grep regex has exactly ONE executable home: `PII_RE` in `scripts/pii-pre-push.sh`. This file
  describes intent only and holds no literal. If you find yourself pasting the pattern anywhere, stop — the
  second `verify:` block above will fail the build, by design.
- **That applies to `scripts/bible/pii-*.mjs` as much as to this file.** They source the pattern; they never
  carry it. A literal pasted into either script would be a second definition, it would be scanned by the very
  gate it implements, and — because those scripts are not on the pre-push hook's self-exclusion list — it
  would block the next push. Keep the liveness probe deriving its own test strings from the sourced pattern.
- Never replace the glob with a file list. The list is what broke this gate for 17 optics.
- The two-repo split (public tinkerclaw / private jarvis-brain) is structural. Never propose unifying them.
- A pattern that's allowed today (the full-name pair as a surname-anchored byline) MUST remain in the negative lookahead. Editing the canonical regex is a sensitive change; review before merging.
