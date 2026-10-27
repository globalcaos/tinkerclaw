---
name: fork-and-skill-scanner-ultimate
version: 1.1.3
description: "Reference material, not a runnable skill: a one-page outline of a workflow for scanning GitHub forks and ClawHub skills (bash pre-filter, sub-agent fan-out, scheduled reports). It ships no scripts and has no entry point. Read it only for the workflow shape; for working scanner code use the sibling skills/fork-scanner/ directory."
---

# Fork and Skill Scanner (Ultimate)

## What this is

This directory is documentation, not an executable skill. It contains a single
README describing a two-part workflow the operator sketched out — scanning the
forks of a GitHub repository for interesting changes, and scanning ClawHub for
notable skills — plus an empty `data/` directory held open by a `.gitkeep`.

There is no code here. Earlier revisions of the README described a `scripts/`
directory, a `Cron_Tasks/` output directory and a "META" file "in the skill
package"; none of those ever existed — `README.md` and `data/.gitkeep` are the
only two files ever committed under this path — and as of 1.1.3 the README says
so rather than implying otherwise.

The workflow the README outlines, in its own terms:

- **Fork scanner** — pre-filter a large fork list in bash to drop inactive
  forks, fan the surviving candidates out to sub-agents for parallel analysis,
  reassemble a report in the main agent, run on a Monday/Thursday schedule.
- **Skill scanner** — score a batch of ten ClawHub skills on functionality,
  relevance and maintenance, then look at the other skills by the top author,
  then write up the findings.

Those are the described intentions. This directory does not implement or
perform any of them, and nothing here has been verified to work.

## When to use / when not to

**Use it** when you want the shape of that scanning workflow — the phase
breakdown, the pre-filter-then-fan-out structure, the scoring dimensions — as
a starting point for writing your own implementation.

**Do not use it** when you need to actually scan anything. There is no command
to run. An agent that loads this skill expecting a scanner will find prose and
an empty directory.

For working code, look at the sibling `skills/fork-scanner/` directory in this
repository instead. It contains a Python implementation under `scripts/`
(including `fork_scanner.py`, `tier1_metadata.py`, `tier2_commits.py`,
`tier3_diff.py`, `watchlist.py`, `reporter.py`, `database.py` and
`rate_limiter.py`), a `schema.sql`, a `requirements.txt`, a `setup_cron.sh`, an
`example_usage.sh`, and its own architecture and quickstart documents. This
SKILL.md makes no claim about whether that sibling code currently runs — it is
simply where the executable material is, and it should be read before being
relied on.

## Entry points

None. The complete file list is:

- `README.md` — the workflow description summarised above.
- `data/.gitkeep` — a placeholder keeping an otherwise empty `data/` directory
  in version control. Its one line of content says the directory is meant to
  hold scanning output; nothing in this directory writes any.
- `SKILL.md` — this file.

## Permissions & Data Flow

Because this directory contains no executable code, loading it does nothing:

- **Reads:** nothing. No file, environment variable or configuration is read.
- **Writes:** nothing. The `data/` directory is empty and no code here writes
  to it.
- **Network calls:** none. The described workflow would require GitHub and
  ClawHub access, but that access is not implemented here.
- **Credentials:** none touched. No token, key or authenticated session is
  read, stored or transmitted by anything in this directory.
- **Self-modification:** none, and none described. The README's talk of keeping
  "interests" current means the list of repos and topics *you* want scanned, held
  in a file you own. Nothing here rewrites this skill's own files, installs an
  update, or edits your agent's configuration — there is no code here that could.

If you build the described workflow yourself, note that the fork-scanning half
implies authenticated GitHub API access and therefore a token with its own
handling requirements. That is a property of the implementation you would
write, not of this directory.
