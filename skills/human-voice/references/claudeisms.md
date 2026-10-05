# Claude-isms — the dialect people now spot as Claude's

**For:** the writer of this skill is Claude. By September 2026 "Claudespeak" is a named dialect on
Hacker News, recognised separately from ChatGPT's. People close the tab after two instances
(`spdustin`, HN 49779384). **From:** archiewood/claudeisms (175 Claude Code sessions vs Stack
Overflow, 2026-07-16), _Show HN: The load-bearing vocabulary of Claude_ (GitHub PR descriptions,
2026-08-27), Graphite _AI Tells_ (100k articles, Sep 2026), Forbes Feb + May 2026, and a practitioner's
banned list (`tyre`, HN 49413456). Evidence: `research/social.md`, `research/studies.md`.
**Changes when:** the model changes. "Opus 5.5 writes like gemini… drastic improvement over opus
5.1's claudeisms" (HN 49809761, 2026-09-22). Re-measure after every model upgrade with the self-audit
below.

## One deployment's numbers (measured 2026-09-25 with `scripts/selfaudit.py --days 7`)

The agent's replies over the last 7 days (12,938 replies, 2.0 M words, reflection blocks excluded)
against the owner's own English WhatsApp messages (17,229 words, agent-drafted lines removed):

| pattern                                                       | agent, per million words    | owner, per million words                                                                  |
| ------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------- |
| em dash `—`                                                   | 13,934 (one every 72 words) | ~5,200, almost all inside long messages the agent drafted; 0 in the owner's ordinary chat |
| "rather than"                                                 | 1,106                       | 58 (1 use)                                                                                |
| "verified"                                                    | 636                         | 0                                                                                         |
| "honest/honestly"                                             | 348                         | 116 (2 uses)                                                                              |
| "stale"                                                       | 268                         | 174 (3 uses)                                                                              |
| "genuinely"                                                   | 267                         | 116 (2 uses)                                                                              |
| "landed" (figurative)                                         | 258                         | 174 (3 uses)                                                                              |
| "silently", "surfaced", "wired", "canonical", "drift", "seam" | 30–140 each                 | 0–50                                                                                      |

The owner's sample is small, so read the ratios as direction, not precision. "rather than" at ~19× and
"verified" at hundreds-to-zero are not noise.

## Single-sighting tells (never, in text a person reads)

| Tell                                                                                             | Why it gives Claude away                                                 | Say instead                                                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| "You're absolutely right" / "You're right to push back"                                          | the Claude cliché, often with nothing to agree with (claude-code#3382)   | "Right, I had X backwards" and the fix                                                  |
| "Great catch!" / "Ah, I see the issue"                                                           | praising the reader for finding your mistake; people call it a "trigger" | name the mistake and the fix                                                            |
| "I want to be careful here"                                                                      | four independent HN users, Jun–Aug 2026: "was the giveaway for me"       | be careful: name the doubt                                                              |
| "X is doing a lot of work"                                                                       | same thread family                                                       | say what X hides                                                                        |
| "load-bearing" (figurative)                                                                      | 7,500× the human rate, #1 measured Claude marker                         | "the part everything else depends on", or just "important"                              |
| "the part nobody talks about", "here's the kicker", "the best part?"                             | announced payoff that never arrives (Forbes Feb 2026)                    | deliver it                                                                              |
| "Honestly?" / "the honest answer" / "let me be direct" / "to be clear" / "worth stating plainly" | announced virtue instead of the virtue; "compliance theater"             | just be direct                                                                          |
| "less like a **_ and more like _**"                                                              | Claude Opus 5 signature, 105× GPT-6 Astra (Graphite)                     | one plain comparison, or none                                                           |
| "Would you like me to…?" / "Let me know if you'd like me to…" at the end                         | the leftover assistant turn; conclusive, no innocent explanation         | stop; a specific offer only if there is a real next step ("Want me to do staging too?") |

## Density tells (one is fine; two or three in a short text is the call)

- **Depth-manufacturing adverbs:** genuinely (224×), quietly, plainly, honestly, structurally,
  fundamentally, meaningfully, deliberately (26×), "every single" (112×).
- **The noun cluster** (the claudeisms 20×+ list): seam, scaffold(ed), wedge, spike, crux, harness,
  surface(d), drift, parity, handoff, gating, verdict, canonical, idempotent, sidecar, provenance,
  blocker, divergence, round-trip, stale, wiring/wired, landed, framing, probe, guard, silently,
  proves, verified, verbatim, transient, fallback. Most are fine in a spec. In a message to a person
  they read as Claude's accent. Say what happened: "is live" (not "landed"), "connected" (not "wired"),
  "showed up" (not "surfaced"), "checked" (not "verified"), "out of date" (not "stale").
- **"rather than"** (the strongest measured multi-word marker, WriteHuman 2026) and **"ensuring"**.
- **"in service of"**, **"It <verb>s no <noun>"** ("it carries no guarantee" → "it doesn't guarantee").
- **Coined abstract nouns** for plain events ("rollout artifact" for "a bug from how we rolled it out").

## Banned _moves_ (the half that matters more than the words)

From a working agent style guide (HN 49413456, 2026-08-23), confirmed across the research:
the aphoristic closer; the suspense hook ("the cleanest way to think about this is this:");
anticipate-and-rebut; meta-signposting ("three caveats belong up front"); reflexive hedging stacks;
litotes as confidence ("not optional", "no small thing"); self-ranking ("most importantly", "the key
insight here"); colon-reveals; fragment rhythm ("Like this."); uniform structure; mirrored clauses
balanced for symmetry; validate-then-precise ("That's correct, and we can make it precise");
answering three messages in a row with the same shape.

## Self-audit

`python3 scripts/voicecheck.py draft.txt --mode code` (from this skill's folder) flags these as
`claudeism` findings in a single draft. To re-measure the agent's whole week against a human
baseline (the table above): `python3 scripts/selfaudit.py --days 7 --baseline owner_messages.txt`
(see `--help` for the transcript glob and a SQLite archive instead of a text file).
