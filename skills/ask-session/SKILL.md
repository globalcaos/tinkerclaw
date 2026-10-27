---
name: ask-session
description: Before you rebuild something, ask the session that already built it. This skill keeps a searchable catalogue of every past Claude Code session (what the owner asked, which files it edited, how it ended) and can wake one of them to answer a question from its own memory, in about 15 seconds. Use it whenever you are about to write a script, a fix or a design that may already exist, when you catch yourself asking "what did we decide about X", "why is it done this way", "how did we do X last time", "who worked on X", "where did that file come from", or when a search through code and notes keeps coming back thin, and whenever the prompt's note says the harness is already asking a past chat (run the `answer <wake-id>` command it gives). The session that did the work still holds the reasoning that never reached a commit message.
metadata:
  openclaw:
    emoji: 🗣️
    requires:
      bins: [python3, claude, git]
    why: Agents keep rebuilding work that a past session already did, because they don't know what they don't know. On 2026-10-19 a test wake of a dormant session (claude -p --resume) answered three questions about its own work correctly in 13.9 s, for 274k cold cache-write tokens. Searching for the same facts by hand would have taken many tool calls and some guessing.
---

# ask-session

Canonical path: `~/src/tinkerclaw/skills/ask-session/`.

Every Claude Code session leaves a transcript in `~/.claude/projects/<dir>/<id>.jsonl`. Those
transcripts hold the reasoning behind the work: the options that were tried and dropped, the
reason a value is what it is, the bug that made someone write a guard. Most of that never reaches
a commit message or a memory file. This skill does two things with it:

1. **Catalogue**: one card per session, so you can find out which session knows about a topic.
2. **Ask**: wake that session with one question and get its answer back. It works like asking the
   colleague who did the job, and it is often cheaper than digging.

## Finding the session when titles all look alike

Every worker of one long Tinker chat gets that chat's first prompt as its title, so `find` can list
five sessions with the same title and no way to tell them apart. Search the owner's own words in the
transcripts instead, and rank by how often the topic appears (2026-10-22: the battery-table session
was found this way in one call after `find` returned five identical titles):

```bash
grep -l "drains my battery" ~/.claude/projects/*/*.jsonl | xargs -r ls -t | head -5 |
  while read f; do echo "$(basename "$f" .jsonl) $(grep -c battery "$f")"; done
```

Skip your own session id, then `show` the top hit before you `ask` it.

## When to use it

- You are about to build a tool, script, recipe or fix, and it smells like something that may
  already exist. Run `find` first. It is free and takes a second.
- You need the _why_ behind a decision: "why did we pick SQLite", "why is this timeout 600 s",
  "what did the architect decide about X".
- You need the _how_ of a past job: "how did we get past the login wall last time", "which
  command rebuilt the index".
- You need _who_: which session worked on a file or a topic, and when.

When a plain search is enough, do that instead. If your own chat is still short (small
context), each search call costs you little, so search first. The wake pays off when your context
is large and the target session's is modest (see the cost rule below).

Separately: read the card before you wake anything. `show` prints the owner prompts and the final
reply, and that is often the answer. A fact that sits in a file `grep` would find needs no wake
either.

## Commands

```bash
S=~/src/tinkerclaw/skills/ask-session/scripts/sessions.py

# Build or refresh the catalogue. Incremental: unchanged files (same size and mtime) are skipped.
python3 -I $S catalog                      # all of ~/.claude/projects/*/*.jsonl
python3 -I $S catalog --since 7            # only files touched in the last 7 days
python3 -I $S catalog --summarize 20       # also ask haiku for a 5-line summary of the 20
                                           # newest main sessions that lack one (off by default)

# Which session knows about it? Full-text search over titles, owner prompts, summaries,
# edited files and final replies, ranked by bm25 (title weighs most).
python3 -I $S find "gantt tab machines panel"
python3 -I $S find "zen mail sync" --kind main --limit 10 --json
python3 -I $S find "safety checker" --kind any   # include headless 'other' runs too

# Finding the right one fast (2026-10-21: five finds and two greps to reach the Pi Chromium session):
#  1. Work from the last day or two? Run `catalog --since 2` first; the nightly scan may not have it yet.
#  2. Search with the OWNER's words (what he typed: "install chrome in the pi"), not technical terms
#     ("load-extension relay"): titles and owner prompts weigh most, so jargon ranks old chats first.
#  3. Before waking, `show <id>` and read its owner prompts; skip sessions dormant under an hour (a live tab).

# Read one card (unique id prefixes work).
python3 -I $S show 8b4c7d70

# Is a wake worth it? Prints the break-even number of saved tool calls.
python3 -I $S cost 8b4c7d70 --asker-context 120000

# Ask it. Give your Bash call a timeout at least 20 s above --timeout (default 110 s),
# so the tool can stop the wake cleanly and log it before Bash gives up.
python3 -I $S ask 8b4c7d70 "Why did the catalogue end up in SQLite and not JSON?"
python3 -I $S ask 8b4c7d70 "Which file holds the retry limit?" --timeout 90 --json

# Read the answer of a wake the harness started for you (the note names the wake id).
# It waits while the wake runs (--wait, default 110 s) and prints exactly what `ask` prints.
python3 -I $S answer 20261025-140212-8b4c7d70
```

`find` prints, per hit: id, date, kind, title, days dormant, context tokens and the estimated
cold wake cost (1.25 x its context, in tokens). The date and days dormant count from the session's
last real work; a wake does not reset them.

Kinds: `main` (a chat with the owner, stamped `[Day YYYY-MM-DD HH:MM GMT+2]` prompts),
`fractal` (a 🌿 Fractal reflection), `longjob` (a ⏳ Longjob wake), `subagent` (it starts with
`[Subagent Context]`), `wake` (a file that a wake created), and `other` (headless runs such as
classifiers and audits). `find` leaves out `other` unless you pass `--kind any` or `--kind other`;
there are thousands of them and they are noise for most questions. Search `--kind main` first:
that is where decisions get made.

The catalogue keeps itself fresh. When the TinkerClaw gateway runs, Thalamus runs `catalog`
once a night between 02:00 and 06:00, and builds the catalogue a few minutes after the first
start when there is none (`anticipate.refreshCatalog`, on by default; it never wakes a session
and never calls a model). Without the gateway, `bash scripts/install-timer.sh` installs a
systemd user timer that runs `catalog` every night at 03:40 (`--uninstall` removes it). Both
can run; each `catalog` run touches `catalog.stamp` next to the catalogue.

## When the harness asks for you

With Thalamus's `anticipate.wake` set to `on`, the gateway does the `find` and the `ask` itself.
When an owner prompt in a Tinker tab or the main chat matches a past chat strongly (a stricter
bar than the pointer's), it starts `sessions.py ask <id> "<the prompt>" --wake-id <wake-id>` in
the background, with all the guards below, and the prompt's note gets one line:

    The harness is already asking that past chat (session 8b4c7d70) your prompt; ... Read it
    before you search: python3 -I …/sessions.py answer 20261025-140212-8b4c7d70

Run that command before you search for the same thing. If you don't, the finished answer is put
on top of your next turn's note, once. At most 5 such wakes a day (`anticipate.wake.dailyCap`),
never the same session twice for one chat within 12 hours, and none while `anticipate.wake` is
`watch` (the default), which only records what it would have woken.

## What a wake does

`ask` runs `claude -p --resume <id> --output-format json "<question>"` from the session's own
working directory, with a hard timeout (110 s by default).

**The wake is read-only.** It gets only the Read, Grep and Glob tools (`--tools=Read,Grep,Glob`,
with Edit, Write, MultiEdit, NotebookEdit, Bash and Agent also denied) and no MCP servers
(`--strict-mcp-config`). Old sessions often end on "next I will…"; a woken one cannot act on that,
whatever the owner's default permission mode is. `--summarize` runs haiku with no tools at all.

The woken process starts with a clean environment: the caller's `TC_*`, `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_MESSAGING_*`, `CLAUDE_PID`, `CLAUDECODE` and similar are removed, so its hooks do not
mistake it for the caller's tab, and `ASK_SESSION_WAKE=1` is set, so it cannot wake another session
in turn.

**It wakes the session in place. It never uses `--fork-session`.** The owner decided this on
2026-10-19: the woken session's transcript grows by one exchange, so the session remembers that it
was asked and what it said, and the record stays in one place.

If the session has been dormant for more than 60 minutes, the question goes in with a short
**wake-up note** first (under about 1,500 tokens, skip it with `--no-preamble`):

- the current date and time, and how long the session slept;
- for each git repo it edited files in, `git log` since its last activity on those files
  (10 lines per repo at most);
- new entries in the memory index `~/.openclaw/agent-memory/MEMORY.md` dated on or after its last
  day (10 titles at most);
- a line telling it that its knowledge is from that date, to check whether any of this changes its
  answer, to answer, and to say plainly what changed.

Every ask is logged to `$OPENCLAW_STATE_DIR/ask-session/asks.jsonl` (time, id, minutes dormant,
note on or off, duration, token usage, exit code, answer length; never the question text), so
the cost of wakes can be measured later. The record is written even when the wake times out or is
cut short.

An ask with `--wake-id` also writes its whole result, question and answer included, to
`$OPENCLAW_STATE_DIR/ask-session/wakes/<wake-id>.json` (owner-private, like the cards); files
older than 7 days are removed on the next such ask. `answer` marks the file read.

On a timeout the tool sends SIGTERM, waits 5 s, then SIGKILL. If the caller itself is killed,
the woken `claude` is stopped with it (Linux parent-death signal). Either way the question may
already sit in the session's transcript with no answer after it, and the next resume of that
session will see it. That is the price of waking in place; keep questions short and the timeout
realistic.

### When it refuses

- A running process holds the session: some process on the machine has `--resume <id>`,
  `-r <id>` or `--session-id <id>` on its command line (an open Tinker tab keeps a worker like that
  alive however long it sits idle). Its in-memory history would never see the wake, and the
  transcript would branch. `--force` never overrides this.
- Another ask on the same session is running (a per-session lock in
  `$OPENCLAW_STATE_DIR/ask-session/locks/`).
- The session file was written in the last 10 minutes: it may still be live. `--force` overrides
  this when you know it is idle. A follow-up right after your own wake is allowed, because the
  tool remembers the file state its last wake left.
- The session is not one of the owner's own kinds (`main`, `fractal`, `longjob`). `--force`
  overrides it, and the wake-up note then leaves out the memory index titles.
- It is your own session (`CLAUDE_CODE_SESSION_ID` matches). Claude Code's in-process subagents
  share their parent's id, so they cannot wake the tab that spawned them.
- The caller is itself a woken session (`ASK_SESSION_WAKE` is set): wakes do not chain.
- With `--wake-id`, a refusal is also written to the wake's result file, so `answer` reports it.
- The caller is a narrower reader: `TC_SESSION_KEY` contains `:subagent` or `tinker-sp-`, or
  `OPENCLAW_SUBAGENT` is set. `find` and `show` refuse there too. The reason is printed.
- The session's working directory no longer exists, so `claude` could not resume it.

## The cost rule

A cold wake writes the session's whole context to the prompt cache once, at 1.25 x the input
price: about `1.25 x C_session`. Each tool call you make yourself re-reads your own context from the
cache, at the model's cache-read price: 0.05 x input on Opus 5.5 and Sonnet 5.5, 0.1 x on older
models. So on current models the wake pays in tokens when it saves you more than

    k* = 25 x C_session / C_asker    tool calls   (12.5 x on 0.1x-read models).

A 300k session asked from a 100k session breaks even at 75 saved calls; a 60k session asked from
a 300k session pays after 5. In wall time it nearly always pays: one plain wake took 13.9 s, one
with the wake-up note and a catch-up read took 41 s, while a search that ends in a guess takes
minutes. `cost <id>` does the arithmetic with the real numbers (`--read-mult 0.1` for older
models). Ask one precise question per wake and put everything you need into it.

## The answer is testimony

The output starts `Session <id> (<date>) says:`, where the date is the session's last real work.
With `--json` the same text is in `label`, next to `"testimony": true`.

Before the answer is handed over, every file it names (up to 8; absolute, `~/` or relative to the
session's folder or repo) is checked against the disk as it is now, and the result is printed
under the answer (`checks` in `--json`):

    [checked against the disk now, before anyone acts on it:
      src/limits.py: changed 2026-10-23 14:02, after this testimony (2026-10-12); re-read it
      docs/retry.md: unchanged since 2026-10-12
      scripts/old.sh: not found on disk]

A `changed` file is where the testimony is most likely stale: read it before you rely on what the
session said about it. The check is stat only; it says nothing about facts that are not files. Treat it like a colleague's
memory: it is what that session believed on that date, and it can be wrong or stale. The wake-up note helps it notice
what changed, but before you act on a fact that matters, check it against the code or the file it
names. When you pass the answer on, say where it came from ("session 8b4c7d70, 2026-10-12, says
…"), never as a fact you verified.

## Privacy

Every card is `owner-private`. It holds the owner's own words from his chats. Don't paste cards,
owner prompts or wake answers into a group chat, a public post, an issue, a commit message or a
message to someone else. Quote only the part the task needs, and only back to the owner or into
his own work. Gateway-spawned subagents and side panels cannot wake sessions or read cards, by
design. Claude Code's own in-process Agent and Workflow children are NOT detected (their
environment looks like the parent tab's), so they can run `find`, `show` and `ask`; an agent that
spawns them decides whether they get this skill. The catalogue lives in `$OPENCLAW_STATE_DIR/ask-session/catalog.sqlite` (default `~/.openclaw`) and
never leaves the machine. The only model call is the optional `--summarize`, which runs through
the local `claude` login. A summary is redone once the session file has grown by half, and a failed
one is retried after three days or when the file changes.

## Tests

```bash
python3 -m pytest -q ~/src/tinkerclaw/skills/ask-session/tests
```

The tests build fixture sessions in temporary folders and use a fake `claude` on `PATH`. The
conftest fails any test that touches the real `~/.openclaw` or `~/.claude`, and puts a stub
`claude` first on `PATH` that fails the test if it is ever called, so a test without its own fake
cannot reach the real one.
