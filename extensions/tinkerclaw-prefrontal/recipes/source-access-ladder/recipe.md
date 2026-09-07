---
schema: "kit/1.0"
slug: "source-access-ladder"
title: "Source Access Ladder — probe cheapest-first before declaring a block"
summary: "Before telling the requester a source is unreachable, climb the access ladder from cheapest to most intrusive and PROBE each rung live. A stored 'this path is dead' is a dated observation, not a property of the world, and re-testing it costs seconds while asking the human costs a turn."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "operations"
tags:
  [
    "blocked",
    "403",
    "503",
    "captcha",
    "bot wall",
    "session expired",
    "cannot access",
    "rate limited",
    "share a tab",
    "credentials",
    "access ladder",
    "unreachable source",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
---

# Source Access Ladder — probe cheapest-first before declaring a block

> The expensive failure is not being blocked. It is asking the human to unblock something that
> was never blocked, on the authority of a note written weeks ago.

## Goal

Either the data, or an honest block report the requester can act on in one step — reached by
testing rungs in cost order rather than by trusting what the docs say about them.

## When to Use

- A fetch returns 403, 503, a CAPTCHA, an empty result set, or a stale-session error.
- A skill, doc or memory says a given path "is dead" / "always 503s" / "needs a shared tab".
- You are about to write "I could not access X" or "please share a tab / paste credentials".

## Steps

### 1. Re-read the claim and date it

**Done when:** The blocking claim is identified as an observation with a date, not a fact.

Find the sentence that says the path does not work and look for when it was written. Access
paths are contested surfaces that both sides keep changing: bot walls loosen, fingerprints stop
matching, rate limits reset, credentials rotate. A negative finding is the most perishable kind
of note there is, and the more confidently it is phrased the longer it survives unexamined. If it
carries no date, treat it as maximally stale.

### 2. Climb from cheapest to most intrusive, probing each rung

**Tools:** exec, webfetch
**Done when:** A rung returns real data, or every rung has been tested TODAY and failed.

Order the rungs by cost to the requester, not by what is documented as working: unauthenticated
fetch with a browser-like client first; then a stored session or cached credential; then a
first-party API or paid connector; then anything that borrows the human's live browser; and only
last, asking the human to act. Probe each rung with the smallest possible request and read the
actual response — a status code and a byte count separate a wall from a working path in one
command. Do not skip a rung because a doc says it is dead; that is precisely the claim under test.

### 3. Distinguish WHICH endpoint is blocked

**Done when:** The block is scoped to specific endpoints, not to the whole source.

A source is rarely uniformly blocked, and "the site is blocking me" is usually an over-generalised
sample of one. Search endpoints, detail pages, media CDNs and APIs sit behind different
protections and fail independently — and they fail in an order, so the first thing to break is not
the last thing still working. Test the specific endpoint the task needs before concluding anything
about the source. A green health probe that exercises a different endpoint from the one the task
uses is worse than no probe, because it is confidently wrong.

### 4. Stop cleanly, and update the claim either way

**Tools:** write
**Done when:** The requester has one clear action, and the stale claim on disk has been corrected.

If every rung failed today, stop and say so plainly with the exact unblocking step — one action,
not a menu. Do not keep retrying a wall; each repeat pushes a soft block toward a hard one and can
cost the paths that still worked. Then, whichever way it went, correct the written claim now with
today's date and the evidence: if a "dead" path turned out alive, that note has been misdirecting
every future run; if the block is real, dating it is what stops the next session re-litigating it.
The observation is only worth what it cost if it reaches disk.

## Constraints

- Never ask the human to unblock a path you have not tested today.
- Probe with the cheapest request that would prove the point; do not sweep a catalogue to learn whether you are allowed in.
- One retry on a soft failure, none on a CAPTCHA or hard wall. Grinding converts a temporary block into a durable one.
- Scope every block claim to the endpoint actually tested.
- Never route around a block by borrowing a system that belongs to someone outside the conversation, and never switch a shared browser tab to a different site to get around it.
- A stored negative is expired on read. Re-query, then repeat.

## Safety Notes

- Impersonating a browser to read public pages is ordinary client behaviour; using it to evade an explicit authentication or licensing boundary is not. The rung ladder stops where a boundary is meant to keep you out.
- Session cookies are credentials. Never echo them, log them, or pass them on a command line.
- If the honest answer is that the source cannot be accessed within the rules, that IS the deliverable. Report it.

## Failures Overcome

- A skill's own description asserted that unauthenticated fetching was permanently dead, on evidence gathered weeks earlier. With the stored session bot-walled, the requester was asked to share a browser tab and the turn ended blocked. The next morning a three-line unauthenticated probe returned full pages AND full search results — the cheapest rung had been working the whole time, and nobody had retested it because the note sounded certain.
- A health probe reported the session OK while the very next request hit the bot wall, twice in one session: the probe exercised an endpoint the task never used.
- Repeated retries against a soft block escalated it — a path that had been serving product pages stopped serving them after several refused search requests.
