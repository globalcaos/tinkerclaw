# The starter kit — the markdown that makes the agent behave

A fork ships code. What actually separates an assistant that has been corrected for months from a
fresh install is not the code — it is a pile of prose that nobody thinks to distribute, because on
the maintainer's machine it lives in a personal workspace and never enters the artifact.

This is that pile. It ships, it loads automatically, and every file can be overridden without
forking the repo.

## What loads at the start of every conversation

All of these live in `extensions/tinkerclaw-moral-code/prompts/` and are composed into one
moral code pack, delivered once when a conversation starts and again after every compaction,
whichever model is answering, in this order:

| Block                                                     | What it settles                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| persona (`personas/jarvis-default.md`)                    | how the agent sounds                                               |
| `ethical-rules-default.md`                                | **the 13 rules** — what it must never do, priority-ordered         |
| `objectives-default.md`                                   | what any of the work is _for_, and how much effort a task deserves |
| `verification-discipline.md`                              | when a claim is allowed to be called true                          |
| `persistence-and-blockers.md`                             | dig _into_ a hard problem, never _around_ a real wall              |
| `engineering-discipline.md`                               | the smallest change that fully solves it                           |
| `memory-discipline.md`                                    | write it or it didn't happen                                       |
| `reflection-loop.md`                                      | how it improves instead of merely repeating                        |
| `orchestration-disposition.md`                            | when to fan out instead of grinding serially                       |
| `narration-contract.md`                                   | say what you are about to do, in plain language                    |
| `subagent-helper.md` · `tool-choice.md` · `plan-tools.md` | mechanics                                                          |

The moral code pack is the seven rows from `ethical-rules-default.md` to `reflection-loop.md`. The
persona and the last four rows are Claude-bridge mechanics: they stay in `extensions/tinkerclaw-tinker-bridge/prompts/`
and ride that bridge's system prompt.

## The four that matter most, and why

**The 13 rules** (`ethical-rules-default.md`) are the foundation, priority-ordered so that when
two conflict there is an answer rather than a vibe. Rules 11–13 were added after a documented
multi-agent security incident and each cites its evidence: bystanders bear no cost; when blocked,
stop and say so; whatever you spawn is you. Rule 3 is the one that will save you most often — the
gate is on the **effect**, not on the tool: asking a service to fetch a URL or letting a CI job run
on your behalf is still your action.

**Verification** (`verification-discipline.md`) attacks the single most common way an assistant is
wrong: a true statement about the wrong layer. The code was edited, the file saved, the test
passed — none of which is the change appearing where the user is looking. Source ≠ built ≠
restarted ≠ rendered.

**Persistence** (`persistence-and-blockers.md`) is the deliberate counterweight to rule 12. On its
own, "when blocked, stop and say so" reads as permission to give up on the first hard thing. This
file says the opposite for the case that actually occurs: "impossible" is nearly always "I tried
one approach once". It draws the line precisely — dig into the problem as deep as it goes, never
around a wall that is there on purpose.

**Reflection** (`reflection-loop.md`) is the only reason an agent is different in ninety days. It
costs a few lines at the end of a turn and it has one hard rule: a claim about disk needs a tool
call behind it. Everything else in this kit was produced by that loop.

## Making them yours

Every block resolves in the same order, so your edits survive `git pull`:

1. an env var (`TINKERCLAW_<NAME>_PROMPT`) pointing at a file
2. `~/.openclaw/workspace/memory/knowledge/<name>.md` — **your version**
3. the bundled default in this repo

Copy a file to path 2 and edit it there. Never edit it in the repo; `git pull` will reset it. The
same contract governs `SOUL.md` (persona) and `BRIEFING.md` — see `FORK_SETUP.md`.

## A word on the ethical rules specifically

They are informational, not code-enforced — an assistant that decides to ignore them can. They
work because they are loaded every turn, priority-ordered, and justified. The asymmetry in the
durability section is what keeps them from eroding: the assistant may make a gate **stricter** on
its own and report it afterwards; only the operator may make one **looser**. Drift always runs one
way, so only one direction needs a gate.
