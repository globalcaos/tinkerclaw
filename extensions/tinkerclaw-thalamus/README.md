# Thalamus v4

Thalamus routes each model call, and before each owner prompt it works out what the agent will probably go looking
for. It loads by default in `shadow` mode: it computes and records everything and hands the agent nothing. Only
`enforce` changes what the agent sees.

Config lives under `plugins.entries.tinkerclaw-thalamus.config` in `openclaw.json`. Every key and its default is in
`openclaw.plugin.json`; the design is `docs/plans/2026-09-30-thalamus-v4-design.md`.

## The anticipation note

Finding something costs the agent rounds: it reads the prompt, decides to search, waits, and reads its whole context
again for each search. So before round 1, Thalamus can put a short note on top of the prompt with a few one-line
pointers. The tool lines are the short list of skills, recipes and plugins that may fit; Jev ranks them when a token
is set, and local word matching does it otherwise. Below them go up to 2 note files whose "use when" key matches the
prompt, by path, and up to 1 earlier session that worked on the same thing, by session id, which the `ask-session`
skill can wake and ask.

It is always advice, never content. Each pointer is one line with an exact address, the memory pointers are capped at
3 lines and 600 characters, the note ends with "None of these may fit", and when nothing fits there is no note at all.

### Where the notes and chats come from

- Notes: Markdown files in `anticipate.noteDirs`, read two levels deep. With the list empty, the agent workspace's
  `memory` folder is used. A frontmatter `description` is the note's key; otherwise its first heading and opening text.
  `MEMORY.md` (already loaded every turn) and dated daily logs are skipped.
- Past chats: the catalogue the `ask-session` skill builds (`anticipate.chatCatalog`, default
  `$OPENCLAW_STATE_DIR/ask-session/catalog.sqlite`). Chats an agent started, and any chat worked in the last hour, are
  skipped. The gateway keeps that file fresh itself (`anticipate.refreshCatalog`, on by default): it runs the skill's
  incremental `sessions.py catalog` once a night between 02:00 and 06:00, at any hour once the last run is two days
  old, and once a few minutes after the first start, when there is no catalogue yet. No model is called and no session
  is woken. A custom `chatCatalog` is yours to refresh. The skill's own systemd timer (`install-timer.sh`) still works
  alongside; whichever runs first leaves the other a quick incremental scan.

Both indexes are built in the background and checked again every 10 minutes. The prompt never waits for them;
matching takes about a millisecond.

### Privacy

Memory pointers are only looked for on the owner's own prompt in a Tinker tab or the main chat. Cron runs, subagents,
channel chats, runtime notices and any private source (`privacy.privateSources`) get none. Matching is local: no note
or chat title is sent to Jev or any other service. The ledger stores addresses and numbers, never a note's text.

### Modes

| `anticipate.mode` | What happens                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `watch` (default) | Pointers are found and recorded in the ledger; the agent sees nothing new.                             |
| `inject`          | They are also added to the note, which only happens with `mode: "enforce"` and `enforce.shortlist` on. |
| `off`             | Nothing is looked for.                                                                                 |

A fresh clone therefore runs `shadow` + `watch`: it records, it shows nothing. To turn the whole note on:

```bash
openclaw config set plugins.entries.tinkerclaw-thalamus.config.mode enforce
openclaw config set plugins.entries.tinkerclaw-thalamus.config.anticipate.mode inject
# optional: point at your own note folders
openclaw config set plugins.entries.tinkerclaw-thalamus.config.anticipate.noteDirs '["~/notes"]' --strict-json
openclaw gateway restart
```

### The harness asks the past chat

A pointer to a past chat only helps if the agent asks it, and left to itself it rarely does. With `anticipate.wake` on,
a strong match is asked by the harness: it starts the skill's own `sessions.py ask <id> "<prompt>" --wake-id <id>` in
the background, with the owner's prompt as the question. The wake keeps every guard the skill has: read-only tools, the
dated wake-up note (today's date, how long it slept, what changed since), the per-session lock, and the refusal when an
open tab holds that session. The answer comes back as testimony from the session's date, and before it is handed over
the files it names are checked against the disk (changed since then, unchanged, or gone).

The gateway gives a prompt hook 15 seconds and a wake takes 15 to 110, so nothing waits for it. The note gets one line
with the command that prints the answer (`python3 -I …/sessions.py answer <wake-id>`, which waits while the wake runs).
If the agent never runs it, the finished answer goes on top of that chat's next note, once.

A wake costs about 1.25 times the woken session's context, on your own subscription, so the bar is higher than a
pointer's: the past chat must cover 65% of the prompt's information over at least 5 shared rare words
(`anticipate.wake.minCover`, `minTerms`; a pointer needs 45% over 3). On the live catalogue a real match ("help Robin
with her job search") scored 73% over 7 words, and a false one 60% over 3. Other limits: `wake.dailyCap` (5 a day,
counted from the result files on disk), never the same past chat twice for one chat within 12 hours, one wake per chat
at a time, and none for a short follow-up that borrowed the previous prompt's words.

| `anticipate.wake.mode` | What happens                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `watch` (default)      | The decision is made as `on` would make it and recorded on the pointer's ledger row (`wake`); nothing is started.      |
| `on`                   | The wake starts, but only when the pointer is shown: `mode: "enforce"`, `enforce.shortlist`, `anticipate.mode` inject. |
| `off`                  | No decision at all.                                                                                                    |

The ledger value is one of `watched`, `started`, `capped`, `repeat`, `busy`, `follow-up` or `no-script` (the skill's
script was not found next to the plugin, or under `$OPENCLAW_BUNDLED_SKILLS_DIR`). Each wake's result is in
`$OPENCLAW_STATE_DIR/ask-session/wakes/<wake-id>.json` for a week, and its cost in the skill's `asks.jsonl`.
`thalamus.status` shows the mode, today's wakes, and how the last catalogue refresh ended.

```bash
openclaw config set plugins.entries.tinkerclaw-thalamus.config.anticipate.wake.mode on
```

### Measuring it

Every owner task gets a row in `enh_uses` (`<dataDir>/thalamus.sqlite`) with `rounds` (its model calls),
`pointers_json` (each pointer's address, cover, whether it was shown, and the round a tool call first opened it) and
`pointer_skip` (why none was looked for). The gateway method sums it up:

```bash
openclaw gateway call thalamus.anticipate.report --params '{}'
```

It splits the tasks into no pointer, pointers watched and pointers shown, with mean rounds, the share answered in one
round, and how often and how early a pointed note or chat was opened. A watched pointer that the agent opened in round
3 is two rounds that showing it could have saved.

## The nightly lesson pass

When you correct the agent twice about the same thing, the first lesson failed. Thalamus already reads each of your
prompts for corrections (reply in my language, don't ask, simpler, the purple line, keep going, "you have a skill for
this"). With `lessons.mode` on (the default is `watch`), it also keeps each one, with your words redacted and capped, in
the local table `corrections`. Once a night, `thalamus.lessons.run` reads them and works out, for every lesson that
slipped again, where its rule lives and why it did not hold.

A lesson can live on four rungs, weakest first: a saved note, the task's notes (a skill or recipe), a line read with every
turn, and a check in code. The rung is read from disk each night, so a rule you moved by hand is where you put it. The
cause decides the repair, and none of these repairs is a lock:

| Cause        | What it means                                                   | Repair                                                     |
| ------------ | --------------------------------------------------------------- | ---------------------------------------------------------- |
| not loaded   | the rule is in a note or a skill, not in a file read every turn | the concrete rule line in a file read every turn           |
| contradicted | a line in view says the opposite                                | strike or scope that line: always yours, it may loosen one |
| vague        | the rule is in view but too soft to act on                      | the concrete line beside it                                |

Only a rule that was in view, clear and unopposed, and still broken moves up a rung, to a drafted check in
`<dataDir>/lessons/checks/`. "Still broken" means a slip after the always-read files last changed. The draft carries your
corrections as the cases the check must catch, and once someone builds it as an amygdala question it starts by only
watching: amygdala in shadow mode records flags, and a rule acts only after the reviewer finds it worth it. Delete a
draft to decline it; it is not drafted again.

The pass writes the ledger (`<dataDir>/lessons/ledger.json`) and a short report (`<dataDir>/lessons/reports/<date>.md`),
which the bundled sleep routine copies into the one morning report.

| `lessons.mode`    | What happens                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `watch` (default) | Corrections are kept, repairs are drafted in the report. No rule file changes.                   |
| `apply`           | Also adds the concrete rule line, under `## Lessons from the nightly pass`, to `lessons.target`. |
| `off`             | No correction is kept and the pass does not run.                                                 |

`apply` only ever adds a line: it may tighten a rule on its own, and only you may loosen one, so a repair that strikes or
rewords an existing line always waits for you in the report. Adding a line to AGENTS.md re-keys running chat workers, the
same as any edit to that file.

The files it reads, each empty by default: `lessons.alwaysRead` (the workspace's AGENTS.md, SOUL.md, TOOLS.md, USER.md,
IDENTITY.md and MEMORY.md), `lessons.taskDirs` (the workspace's `skills`), `lessons.noteDirs` (the anticipation note's
folders), and `lessons.target` (the workspace's AGENTS.md). `lessons.minSlips` (2) is how many corrections make a lesson.

```bash
openclaw gateway call thalamus.lessons.run --params '{}'                  # dry run: the report, nothing written
openclaw gateway call thalamus.lessons.run --params '{"dryRun":false}'    # what the nightly routine runs
openclaw config set plugins.entries.tinkerclaw-thalamus.config.lessons.mode apply
```

## The Claude Code hook

`hooks/prompt-shortlist.mjs` is a `UserPromptSubmit` hook for plain Claude Code sessions. It posts the prompt to the
gateway's loopback route and prints the note it gets back. Chat workers do not need it, because the gateway adds the
note itself. Nothing installs it; wire it by hand in a Claude Code `settings.json` if you want the same note there,
tools and memory pointers alike, under the same modes.
