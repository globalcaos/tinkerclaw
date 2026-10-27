# Ultimate Fork and Skill Scanner

Scan GitHub forks and ClawHub skills to discover valuable changes and emerging trends.

## Setup

This is a written workflow, not a program. To use it, implement the phases below
in your own agent: scan the forks of a repository you care about, and review the
top skills on a registry. Automate the runs with cron once you have something that
works.

## What's in this package

Two documents and an empty directory. There is no code here:

- `README.md` — this file: the workflow, and what it does and does not do.
- `SKILL.md` — the same workflow stated for an agent, including the plain warning
  that there is nothing here to execute.
- `data/` — an empty directory held open by a `.gitkeep`, a place for *you* to put
  scan output. Nothing in this package writes to it, or to anywhere else.

## Key Phases

### Fork Scanner

1. **Bash Pre-Filter:** Triage 1,000 forks, discard non-active.
2. **Sub-Agent Fan-Out:** Distribute candidate analysis for parallel processing.
3. **Main Agent Assembly:** Finalize report and insights.
4. **Scheduled Runs:** Mon/Thu.

### Skill Scanner

1. **Evaluate 10 Skills:** Score by functionality, relevance, and maintenance.
2. **In-Depth Author Scan:** Check top author's other skills.
3. **Compile Insights:** Lay practical improvement steps.

## Keeping your interests current

The "interests" this workflow tracks are **your** list of what to watch — the repos,
authors and topics you care about — kept in a file you own and edit. Refining that
list between runs is the point of running it repeatedly.

Stating it plainly, because "continuous improvement" inside an agent skill reads the
wrong way otherwise: **this skill does not modify itself.** It has no code, no
installer, no update step, and no write path to its own files or to your agent's
configuration. The only thing that changes between runs is the note *you* keep about
what you want scanned next.

## What it touches

Read-only, and only once you implement it: public GitHub repository data and public
registry listings. No credentials are requested or stored. Nothing is written outside
the output directory you choose. There is no write access to GitHub, to any registry,
or to any skill — including this one.
