---
schema: "kit/1.0"
slug: "supervise-child-agent"
title: "Supervise a Child Agent — usage, work and resource needs, in the chat"
summary: "Audit how a human uses a child agent (another OpenClaw/TinkerClaw host you run for a colleague): how many prompts they really typed, per day, versus UI replays, your own tests and automatic traffic; what the child did for them; what they are working on; and what resources their manager should look into. Output: an inline HTML report in the chat (charts included) plus a saved file."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "analysis"
tags:
  [
    "analysis",
    "supervision",
    "child agent",
    "hivemind",
    "seats",
    "usage report",
    "adoption",
    "manager",
    "audit the use",
    "how is he using the agent",
    "supervise children",
    "child agent activity",
    "interactions graph",
    "what is he working on",
    "resources he needs",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
---

# Supervise a Child Agent

> Turn a child agent's transcripts into a manager's view: how much the human really uses it, what it did for them, what they are working on, and what they need. The report is shown **inline in the chat** and saved as a file.

## Goal

Answer three questions about one human working with one child agent, from evidence rather than impressions:

1. **Usage:** how many prompts did the human actually type, per day, and how much of the child's effort went to them versus to replays, tests and automatic traffic?
2. **Work:** which projects and problems do those prompts serve, and what did the child find?
3. **Needs:** which resources (hardware, time, people, access, decisions) would unblock the human, seen through their manager's eyes?

## When to Use

- A colleague "barely uses" or "doesn't trust" an agent you set up for them.
- A periodic check (weekly) of each child agent in a hive.
- Before an onboarding session, to know what they already tried and where it failed them.

## Steps

### 0. Is the child even alive?

Before counting anything: is the child's gateway process running, listening, and **supervised** (a service that restarts it)? Is its model login valid (send one real test prompt per model the human uses and read the reply)? A child that silently died looks exactly like a human who stopped using it.

Over SSH the `openclaw` CLI is usually not on the PATH (2026-10-14: one wasted call). Read the child's config and inventory straight from disk instead: `~/.openclaw/openclaw.json` (`plugins.entries`, `agents.defaults.model`), `~/src/tinkerclaw/skills/`, `~/.openclaw/recipes/`, and `git -C ~/src/tinkerclaw log -1` for the build it runs.

### 1. Load the private context for this child

Host alias, the human's display name, and the classification rules live in the supervisor's private memory, **not in this recipe** (e.g. `memory/supervision/<child>/rules.json`). If none exist, create them: a `test` rule for every window or phrasing that was the supervisor's own testing, and a `redact` rule for any credential the human typed. Ask the owner which early traffic was theirs; a wrong guess here mislabels the human as struggling.

### 2. Collect and classify (read-only)

```
python3 assets/child-activity-report.py --host <ssh-alias> --since <YYYY-MM-DD> \
  --human-label "<Name>" --title "<Name> × <Child> — activity report" \
  --rules <private rules.json> --out <report.html> --data /tmp/child-rows.json
```

It reads both transcript stores on the host at low priority, deduplicates, and classifies every prompt as `human`, `repeat`, `test` or `auto` (see the script header). **Check the `human` rows by eye** (`/tmp/child-rows.json`) before trusting any number. If agent-written prompts show up as human, extend the `AUTO` pattern or the agent-session filter; don't hand-edit counts. If the host has `~/.openclaw/forensic/llm-ledger.sqlite`, its `driver` column is recorded attribution: prefer it over the heuristics.

### 3. Read what the child actually answered

For every `human` prompt, open the child's reply (the CLI-bridge turn file under `~/.claude/projects/` or the gateway transcript) and note what it found or did. Replies to `repeat` prompts often hold the most measurements, since the child redid the work, so read those too.

### 4. Write the narrative

Write `narrative.json` (private, next to the rules) with four HTML fragments: `working_on` (projects, the symptom, measured findings), `needs` (numbered, manager-lens resources, each tied to a quoted piece of evidence), `our_side` (defects in the child itself that the supervisor owes a fix for), `reading` (a two-line interpretation of the usage pattern). Check project deadlines and governance notes in memory before writing `needs`.

### 5. Render and verify

Re-run step 2 with `--narrative <narrative.json>`. Screenshot the file (`google-chrome --headless=new --screenshot`) and **look at it**: the charts must show bars, the effort numbers must count each session once, the timeline must hold only human prompts, and **no credential or email may appear** (`grep` the file for the password and for `@`).

### 6. Show it in the chat

On the Tinker chat: paste the file's full HTML into one ` ```html-render ` block, then a one-line clickable path to the file. On WhatsApp or other channels: no HTML; send the four numbers and the top three needs as plain text, and the file path.

### 7. Record the outcome

Update the private audit note for this child (counts, dates, corrections the owner gave) so the next run compares against it.

### 8. When someone claims "the child said X"

A complaint about one reply ("it brought up another project when I asked something else") is checked against the record before anyone answers it:

1. **Search whole words, every alias.** `\bX\b`, case-insensitive, plus every other name the thing goes by (customer, product, codename, repo remote). Substrings lie across languages: a short project name can sit inside an everyday Spanish or Catalan word (the 2026-10-07 case matched the words for "relevant" in both).
2. **Cover every store, including the ones grep cannot read.** Gateway sessions with `.reset`/`.bak` copies, CLI-bridge turn files, trajectories, UI snapshots, the engram/retrieval stores, the child's memory folder, any other harness folder (e.g. `~/.codex`), and the LLM ledger, whose request/response columns are gzipped (decompress each row).
3. **Prove coverage before trusting an absence.** Count the replies per day in each store over the claimed window. An absence only counts where the days are continuous and no human chat is missing from the session index.
4. **Separate what it SAID from what it HOLDS.** Grep the memory and retrieval stores for the same words. A note that holds the topic is a scoping problem (who should see that folder) even when no reply ever repeated it, and it is the part to fix first. Rate what it holds on the owner's scale, not yours (step 9), and never shrink it with "only one line".
5. **Get the claimant's day or question** and open that exact session; until then, report "not in the record", never "it did not happen".
6. **Search the other agents too.** People rarely tell agents apart. Before concluding, run the same search on every agent the claimant has dealt with directly or through someone else (the parent agent, siblings, an agent that briefed them for a meeting), and on any messages or documents an agent wrote for them. Check the claimed period against the date the child came into service.

### 9. What the child holds that its human should not

Every run, and before any memory is copied into a child (the run that prepares a training session included): grep the child's memory folder, its workspace files and its retrieval stores (not the human's own chats) for the owner's sensitive classes. **The owner's intentions are sensitive in themselves**, not only the facts behind them: plans to change a supplier or partner, negotiations and contract clauses, prices and discounts, hiring plans, management and family matters. A note qualifies if the human working with the child is not meant to know it, however short it is. For each hit: back up the file off the child first, then propose its removal with the exact command (file, index line, retrieval-store entry), lead the report with it, and check afterwards with a whole-machine grep that no copy is left. Use whole words (`grep -w`, or `\b…\b`) for every name: `levante` inside `relevantes` produced all three hits on 2026-10-14, the same trap step 8 names. Expect false hits ("candidate" in tracker docs, "dirección IP" in manuals) and read each line before counting it.

## Constraints

- **Read-only on the child host** during the audit. No restarts, no edits, no killing processes: the human may be mid-turn. If step 0 finds the child dead, restoring it is a separate, announced action.
- **No names, hosts or credentials in this recipe or its script.** Everything specific lives in private memory. The script must stay generic enough to run against any child.
- Attribution is **inferred** until the host runs the LLM ledger. The report says so in its "How this was measured" line; never present an inference as a recorded fact.
- The `needs` section is advice to a manager about a colleague: evidence-based, respectful, about resources and obstacles, never about the person's worth.

## Safety Notes

- Transcripts contain credentials people type into chats (passwords, tokens). The script redacts emails and long hex tokens by default; add a `redact` rule for anything else, and verify the rendered file before showing it.
- `--data` rows and any transcript extract hold the credentials people typed. Keep them as named files under `/tmp/jarvis/<task>/` and remove each one by name as soon as the report is rendered; AEGIS refuses a recursive removal of an absolute path, so clearing the whole folder at the end strands them until the owner types an allow code (2026-10-14).
- Governance items the owner reserved for a face-to-face talk stay out of anything the human might see.

## Failures Overcome

- **Prompts the UI and gateway write counted as the human's (2026-10-14).** Tab-naming requests, background-task notices, output-limit and classifier notices and supervisor probes made 25 of 136 "human" prompts. They are in `AUTO` now (`d025a51cbbb`); a hand count of the human rows is still the check.

- **The gateway index under-counts.** `sessions.json` showed 4 human sessions; the real turns of a CLI-bridge child live one file per turn under `~/.claude/projects/`. Read both stores.
- **UI replays look like a frustrated human.** An outbox flush re-sent old prompts every few hours, and each made the child redo live work on production hardware. Signature: several different prompts carrying the same client timestamp, landing minutes or hours later. Classify them as `repeat`.
- **The supervisor's own tests look like the human's failures.** On the first run the owner's setup tests (7 errors in a row) were read as the human's bad first day. Ask, then encode the answer as a `test` rule.
- **Agent-written prompts leak in as human.** Subagent tasks (`[Subagent Context]`), reflection triage (`# FRACTAL…`) and internal events land in gateway transcripts. Filter by session kind (subagent / reflection / cron / probe) and by those markers.
- **A half-stripped sender header hides the prompt.** `Sender (untrusted metadata):` wraps a fenced JSON block; strip through the closing fence or the timestamp and text are lost.
- **Effort counted once per prompt triples it.** Several prompts in one CLI turn share that turn's tool calls; count effort per turn file, not per prompt.
- **The child was dead, not ignored.** A gateway started by hand from an SSH session had no supervisor; one crash (a missing `xdg-open` on a headless host) left it down for 90 minutes while the human's prompts went nowhere. Step 0 exists for this.
- **A substring search "found" the project the child was accused of naming (2026-10-07).** A colleague said the child had mixed a customer project into an unrelated answer. The first pass returned 19 hits, all the Spanish word for "relevant"; the Catalan one fooled the alias search the same way. With whole words across both stores, the ledger and the snapshots, no reply named it, while the child's memory folder did hold an off-topic note about it. Step 8 exists for this.
- **A plan was rated as harmless because it was "one line" (2026-10-07).** That off-topic note held the owner's plan to replace a supplier. The report called the debt and the copied-code story "the really sensitive material", said they were not on the child, and left the plan there pending a go. The owner: "The fact that I want to replace [the supplier] is already sensitive information." It was removed the same afternoon. Step 9 exists for this.
- **The slip was the parent's, not the child's (2026-10-07).** The child's record was clean. The same search on the parent found a briefing it wrote six months before the child existed, for a meeting the colleague ran, listing that project as something to show a competitor. The owner had to suggest looking there. Step 8.6 exists for this.
