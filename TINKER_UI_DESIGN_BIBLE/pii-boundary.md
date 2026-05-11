---
file: pii-boundary.md
purpose: What's safe to push to the public tinkerclaw fork; what must stay in private jarvis-brain
audience: AI
last_verified: 2026-05-11
last_verified_commit: HEAD
single_owner: yes — the PII boundary is canonical here; never duplicate the leak-grep regex
see_also: topology.md (the two-repo split), crons.md (auto-merge gate)
note: this file is self-referential and would otherwise match its own leak grep. The grep pattern is provided once below in a literal block; aside from that single instance, the file avoids the protected literal strings.
verify:
  - name: bible files do not match the PII leak grep (excludes this self-referential file)
    cmd: |
      cd ~/src/tinkerclaw && for f in TINKER_UI_DESIGN_BIBLE/INDEX.md TINKER_UI_DESIGN_BIBLE/flows.md TINKER_UI_DESIGN_BIBLE/lifecycles.md TINKER_UI_DESIGN_BIBLE/topology.md TINKER_UI_DESIGN_BIBLE/config-shape.md TINKER_UI_DESIGN_BIBLE/failures.md TINKER_UI_DESIGN_BIBLE/probes.md TINKER_UI_DESIGN_BIBLE/tool-loop.md TINKER_UI_DESIGN_BIBLE/auth-routing.md TINKER_UI_DESIGN_BIBLE/crons.md TINKER_UI_DESIGN_BIBLE/memory-layout.md TINKER_UI_DESIGN_BIBLE/subagents-and-recipes.md; do
        if grep -P 'the user(?! Serra)|Xavi[er]?\b|Ortodó|Barcelona|/home/<user>|talleres serra|hikrobot|glpat-|oserra@' "$f" >/dev/null 2>&1; then
          echo "LEAK in $f"
          exit 1
        fi
      done
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

## The leak-grep regex (canonical, only copy)

Run this BEFORE every `git push tinkerclaw`. If anything matches in a public-bound file, sanitize first.

```
PATTERN: (architect-first-name-with-negative-lookahead-for-surname) OR (family-first-names) OR (Catalan-surname-token) OR (home-city-string) OR (host-path-prefix) OR (workplace-string) OR (customer-name-token) OR (gitlab-token-prefix) OR (work-email-local-part)
```

The above is a PROSE form. The canonical executable regex lives in `~/src/jarvis-icu/CLAUDE.md` under the "Quick Commands" block. It is the SINGLE executable source of truth; this file documents intent, not the regex literal, to avoid being self-referentially flagged.

When wiring the J15 merge gate, the verify command should call out to that one CLAUDE.md block via:

```bash
bash -c "$(grep -A1 'PII leak grep' ~/src/jarvis-icu/CLAUDE.md | tail -1)"
```

## Push policy (2026-05-09)

Push policy is LIFTED for the architect. The architect may `git push` directly to `tinkerclaw/develop`. `main` only advances by mutual agreement.

Still required before a push:

1. **Run the leak grep** (the canonical command in CLAUDE.md).
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

```yaml
verify:
  - cmd: |
      # invokes the canonical regex from jarvis-icu CLAUDE.md
      LEAK_COUNT=$(bash -c "$(grep -A1 'PII leak grep' ~/src/jarvis-icu/CLAUDE.md | tail -1)" | wc -l)
      echo $LEAK_COUNT
    expect: '. == "0"'
```

This is the most important `verify` command in the entire bible. It must pass on every pre-push to `tinkerclaw`.

## Don't regress

- The leak-grep regex is the SINGLE source of truth for the PII boundary. The canonical copy lives in `~/src/jarvis-icu/CLAUDE.md`. This file describes intent only.
- The two-repo split (public tinkerclaw / private jarvis-brain) is structural. Never propose unifying them.
- A pattern that's allowed today (the full-name pair as a surname-anchored byline) MUST remain in the negative lookahead. Editing the canonical regex is a sensitive change; review before merging.
