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

## Constraints

- **Read-only on the child host** during the audit. No restarts, no edits, no killing processes: the human may be mid-turn. If step 0 finds the child dead, restoring it is a separate, announced action.
- **No names, hosts or credentials in this recipe or its script.** Everything specific lives in private memory. The script must stay generic enough to run against any child.
- Attribution is **inferred** until the host runs the LLM ledger. The report says so in its "How this was measured" line; never present an inference as a recorded fact.
- The `needs` section is advice to a manager about a colleague: evidence-based, respectful, about resources and obstacles, never about the person's worth.

## Safety Notes

- Transcripts contain credentials people type into chats (passwords, tokens). The script redacts emails and long hex tokens by default; add a `redact` rule for anything else, and verify the rendered file before showing it.
- Governance items the owner reserved for a face-to-face talk stay out of anything the human might see.

## Failures Overcome

- **The gateway index under-counts.** `sessions.json` showed 4 human sessions; the real turns of a CLI-bridge child live one file per turn under `~/.claude/projects/`. Read both stores.
- **UI replays look like a frustrated human.** An outbox flush re-sent old prompts every few hours, and each made the child redo live work on production hardware. Signature: several different prompts carrying the same client timestamp, landing minutes or hours later. Classify them as `repeat`.
- **The supervisor's own tests look like the human's failures.** On the first run the owner's setup tests (7 errors in a row) were read as the human's bad first day. Ask, then encode the answer as a `test` rule.
- **Agent-written prompts leak in as human.** Subagent tasks (`[Subagent Context]`), reflection triage (`# FRACTAL…`) and internal events land in gateway transcripts. Filter by session kind (subagent / reflection / cron / probe) and by those markers.
- **A half-stripped sender header hides the prompt.** `Sender (untrusted metadata):` wraps a fenced JSON block; strip through the closing fence or the timestamp and text are lost.
- **Effort counted once per prompt triples it.** Several prompts in one CLI turn share that turn's tool calls; count effort per turn file, not per prompt.
- **The child was dead, not ignored.** A gateway started by hand from an SSH session had no supervisor; one crash (a missing `xdg-open` on a headless host) left it down for 90 minutes while the human's prompts went nowhere. Step 0 exists for this.
