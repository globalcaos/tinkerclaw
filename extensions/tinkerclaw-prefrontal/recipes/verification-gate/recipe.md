---
schema: "kit/1.0"
slug: "verification-gate"
title: "Verification gate — evidence before claiming done"
summary: "Prove work is done before saying it is done. Name the command that would prove each claim, run it fresh in this session, test the surface the way a user would reach it, read the whole output, and only then claim — with the evidence attached. Use when about to say done, finished, or ready to merge, when asked are you sure it works, prove it, or show me the evidence, and before shipping anything a second pair of eyes should confirm."
version: "2.1.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "review"
tags:
  [
    "verify",
    "verification",
    "done",
    "complete",
    "finished",
    "ready to merge",
    "ship it",
    "are you sure",
    "are you sure it works",
    "did it work",
    "prove it",
    "evidence",
    "confirm it works",
    "check it works",
  ]
antiTriggers:
  [
    "brainstorm",
    "how should we build",
    "plan only",
    "design a feature",
    "write the code",
    "fix this bug",
    "refactor",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
  notes: |
    [0] Identify is one reasoning pass; it names what every later step must prove. No fan-out.
    [1] Barrier step, but INTERNALLY parallel: independent checks (suite, build, served fetch, render) run concurrently; nothing is judged until all return.
    [2] Barrier. The second-opinion leg is dispatched from here and must come back before any claim is written.
    [3] The claim is written once, after all evidence is in. Never earlier.
params:
  second_opinion_model:
    {
      type: "string",
      default: "opus",
      description: "Model for the second-opinion leg on shippable work. Must be a DIFFERENT family from whoever produced the work, so blind spots are not correlated.",
    }
---

# Verification gate — evidence before claiming done

> No claim without the command. Run it fresh, on the surface the user
> actually touches, and read the whole output before you open your mouth.

## Goal

Prove work is complete with fresh evidence gathered in THIS session. Every
claim is paired with the command or observation that backs it; anything
unproven is reported as unproven, in those words.

## When to Use

- About to say "done", "complete", "finished", "ready to merge", or "ship"
- Asked "are you sure it works?", "prove it", "did it actually work?"
- A subagent reports success and you are about to relay it
- Before anything leaves the branch: merge, deploy, publish, send

## When NOT to use

- Mid-implementation, where a failing check is expected and informative
- Pure exploration or research with no claim attached
- A throwaway spike whose output nobody will act on
- As a substitute for the fix: this gate reports status, it does not repair

## Steps

### 1. Identify the claims and their proofs

**Done when:** every claim you are about to make is written down next to the exact command or observation that would prove it, and tagged with its row in the Verification Table.

List the claims first — "tests pass", "the button appears", "the fix is
live" are three different claims with three different proofs. For each, name
the command whose output settles it and the claim TYPE: behaviour, text or
wiring, appearance, a control behind an action, or deployment. If no command
exists for a claim, that is the finding: the claim is unprovable as stated,
so either sharpen it until it is checkable or drop it. Claims about somebody
else's work — a subagent's, a prior session's — get their own row; their
report is a claim, never evidence.

### 2. Run fresh — on the surface the user reaches

**Done when:** every named command has run in this session after the latest change, with exit codes captured, against the built and restarted artifact where one exists.

Fresh means after the change, not before it. Source is not built and built
is not restarted: rebuild and restart before observing anything that comes
from an artifact. Reach the surface the way a user does — the served URL for
wiring, a real browser render for UI, the actual CLI for a tool. Exercise the
changed behaviour AND the two nearest neighbouring flows, since a change that
works in isolation and breaks its neighbour is the common miss. Never alter
the surface to make it observable: no CSS overrides, no stubbed fixture, no
disabled guard. Independent checks run concurrently; keep them independent.
Context-cheap output: swallow successful runs down to their exit code, keep
failing output verbatim.

### 3. Read the whole output — and get a second opinion on anything shippable

**Done when:** full output read and exit codes checked explicitly, and for work that will be shipped a second reader on a different model family has re-run the decisive check and agreed.

Read all of it, not the tail: a suite prints per-file passes and still exits
non-zero. Report measurements as numbers — pixels from a measured box, byte
counts, exit codes — never as "looks right" or "more compact". For anything
that will merge, deploy or publish, dispatch a fresh agent on
{{second_opinion_model}}, a different family from whoever produced the work,
handed the claim and the command but NOT your conclusion. Never let the
suspect be the investigator: correlated blind spots pass each other through.

### 4. Claim with evidence — or report the real status

**Done when:** each claim is stated with its evidence attached, or the actual status is reported plainly, including "written, not running" wherever that is the truth.

State claim, command, result — in that order, so a reader who did not watch
can audit it. Where evidence is missing or contradicts the claim, report the
status instead; a partial pass is never presented as a complete one. "Edited
but not deployed" has an exact phrasing: written, not running. If the user
has corrected the same claim twice, stop patching the third answer — clear
the context and re-prompt from the raw evidence, because attempt three
inherits the frame that produced attempts one and two. Evidence in the
report, never code.

## Verification Table

| Claim                    | Requires                                                                     | NOT sufficient                           |
| ------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------- |
| Tests pass               | Test output read, 0 failures, exit 0                                         | A previous run, "should pass"            |
| Build succeeds           | Build exit 0 in this session                                                 | Linter or typecheck passing              |
| Bug fixed                | The original reproduction re-run, symptom gone                               | "The code looks correct"                 |
| Agent completed          | You read the actual diff and output                                          | The agent's own report                   |
| Text or wiring changed   | The SERVED output carries the new string (fetch the URL, run the real CLI)   | The string present in source             |
| Appearance changed       | A render you looked at; geometry reported as numbers                         | A value present in the stylesheet        |
| Control behind an action | Drive the action first — expand, click, navigate — then observe              | The control present in the DOM or source |
| Fix is live              | Built artifact greps for a NEW symbol **and** a control symbol; then restart | Source edited, build green, "deploy ran" |
| Edited but not deployed  | Say "written, not running"                                                   | "Done", "shipped", "fixed"               |
| Ready to ship            | A second-opinion leg on a different model family agrees                      | Your own pass alone, however careful     |

## Red Flags — STOP

- "Should", "probably", "seems to", "looks right", "more compact"
- Expressing satisfaction BEFORE the evidence is in
- Relaying a subagent's report as if it were an observation
- Modifying the thing under verification so the check will pass
- Reading only the tail of the output, or only the exit code

## Constraints

- NEVER claim without fresh evidence from THIS session.
- One verification round minimum — even for "obvious" one-line changes.
- Never alter the surface under verification to make it observable; verify the
  surface, not the thing you added.
- Presence in source is never proof of appearance on screen. Source is not
  built; built is not restarted.
- Swallow successful output, surface failures verbatim — context is a budget.
- The second-opinion leg runs on a different model family from the author.
- After two corrections on the same claim, clear the context and re-prompt from
  evidence instead of writing a third patch over the same frame.
- The report carries evidence and prose, not code.

## Safety Notes

- This gate is read-mostly: run checks, do not repair. A defect found here goes
  back to the unit that owns it as a fix round, with the evidence attached.
- The second-opinion agent gets read, grep and exec-for-tests only — no commit,
  no merge, no deploy.
- Destructive verification (migrations, resets, seed wipes) runs only against a
  scratch or worktree copy, never a shared or live target.
- "Written, not running" is a complete and acceptable answer. Deploying to make
  a claim true is a separate, separately authorized act.

## Failures Overcome

- **Claiming from stale evidence:** a test run predating the latest change was
  cited as proof; every verification command must now be re-run fresh in the
  current session before any claim.
- **Trusting subagent reports:** a "completed" summary was relayed without
  reading the actual changes; the real diff and output are now mandatory, and
  the report itself counts as a claim.
- **2026-07-30 — stale dist, three times:** the source was rebuilt but the
  running artifact was never swapped, and the fix was reported as shipped on
  three separate occasions. Deployment claims now require the running artifact
  to grep positive for a NEW symbol AND a control symbol.
- **2026-08-04 — colour present, not rendered:** the hex value sat in the
  stylesheet while the screen showed the old colour. Appearance claims need a
  render someone actually looked at.
- **2026-08-11 — verified without expanding:** a control behind an expander was
  declared working from its presence in the markup; nobody opened the expander.
  Drive the action, then observe.
- **2026-08-30 — the screenshot hid its own bug:** a capture script set
  `maxHeight: none; overflow: visible` to photograph a palette, which disabled
  the scrollbar defect it was photographing, and the run was called verified.
  Never modify the surface you are verifying.
- v1.0 resurrected 2026-06-13 from commit a239df31a4^.
- v2.0 2026-09-02: added the evidence ladder (served output, render, driven
  control, written-not-running), test-as-the-user, context-cheap output, the
  different-family second-opinion leg, and the two-corrections reset.
- **v2.1.0 (2026-09-03):** folded in the AI-native SDLC playbook (claude.com/blog/the-ai-native-sdlc-playbook — the source the "INTENT.md" video walks through): exercise the changed behaviour and its two nearest neighbouring flows.
