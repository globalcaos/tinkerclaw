# Workspace starter kit

These files are what make a fresh clone's agent _behave_, not just boot.

`scripts/setup.sh` copies each file into `~/.openclaw/workspace/` **only if
that path does not already exist.** Your edits survive `git pull`.

| file                      | why it is here                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `AGENTS.md`               | How work gets done: the 14 primaries, measure-don't-recall, named-host lookup, green is observable |
| `HEARTBEAT.md`            | What a periodic poll is allowed to do                                                              |
| `SESSION.md`              | Thin dispatcher on `/new`                                                                          |
| `CRON-REPORT-CONTRACT.md` | What every nightly job must leave on disk                                                          |
| `TOOLS.md`                | Local notes (hosts, speakers) — no secrets                                                         |
| `USER.md`                 | Who the operator is                                                                                |

Persona (`SOUL.md`) and ethics (`ethical-rules-default.md`) already ship as
bundled defaults with workspace-override paths. Identity is written by setup
from the agent-name prompt. Do not copy MEMORY.md — that is recovery state,
not a template.
