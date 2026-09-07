---
schema: recipe/1.0
id: adversarial-review-loop
title: Adversarial Review Loop (Sol → Grok → Opus)
category: writing
subdivision: papers
summary: Score a paper against a fixed rubric with an external referee (Sol), attack both paper and referee with a devil's advocate (Grok), revise with Opus, and re-score cold until it clears 9/10
triggers:
  [
    "send it to sol",
    "professor sol",
    "devil's advocate",
    "score the paper",
    "score it 0-10",
    "referee",
    "until 9/10",
    "adversarial review",
    "external review",
    "peer review the paper",
  ]
effort: deep
tools: [read, grep, glob, exec, edit, write]
children: []
---

## Goal

Raise a paper to a defensible quality bar using **cross-vendor** review rather than self-review.
A single model grading its own output converges on flattery; a referee from another vendor, an
adversary that attacks the referee as well as the paper, and a fixed published rubric make the
score mean something.

Terminates on a measured **≥ 9.0/10 with no axis below 7**, or on an honest "did not converge"
after the round cap. Never on "it feels good now."

## When to Use

- A paper is drafted and needs to clear a publication bar, not just get polished
- The user asks for a score, a referee, a devil's advocate, or "iterate until 9/10"
- A revision pass has already run (`revise-paper`) and the remaining defects are the ones the
  author cannot see from the inside

**Not for:** first drafts (write it first), papers with no actionable improvement notes
(`revise-paper` Step 0 exits those), or copy-editing (that is `revise-paper` Step 4).

## Roles

| Role                | Model               | Job                                                                |
| ------------------- | ------------------- | ------------------------------------------------------------------ |
| **Referee ("Sol")** | `codex/gpt-5.6-sol` | Constructive review + rubric score. Never edits the paper.         |
| **Adversary**       | `xai/grok-4.5`      | Attacks the paper AND the referee's review. Never edits the paper. |
| **Author/Judge**    | `claude-opus-5`     | Adjudicates the two reviews, revises, owns every accept/reject.    |

The vendor split is the point. Two reviewers from one vendor share blind spots and correlate
their errors; the disagreement between Sol and Grok is the signal the loop runs on.

## Steps

### 0. Reviewer liveness probe (gate)

**Tools:** exec, read
**Done when:** Each reviewer model has answered with a unique token and `modelApplied:true`

**Non-Anthropic pins can fall back to Opus SILENTLY.** A whole review round once ran as
Opus-reviewing-Opus without anyone noticing for two days. Before spending a round, probe:

```bash
node ~/src/tinkerclaw/scripts/openclaw-spawn-subagent.mjs \
  --task 'Write the line PROBE-<TAG>-OK plus your model name to /tmp/probe-<tag>.txt. Then finish.' \
  --label probe-<tag> --model <provider/model> --json
```

Require all three: (a) the file exists, (b) the spawn returned `modelApplied:true`,
(c) the review that arrives later reads in that model's voice, not Opus's. If a reviewer is
dead, say so and either substitute a _different vendor_ or run the loop degraded — never
silently let Opus wear the referee's hat.

### 1. Assemble the review packet

**Tools:** read, glob
**Done when:** Canonical version identified and the packet path is fixed for all rounds

Pick the genuinely latest version (a dated filename is not proof — compare `vX.Y` headers,
including any undated file). Bundle: the paper, its `improvement_notes.md`, and the rubric
below. Every round reviews the SAME artifact path so the scores are comparable.

### 2. Referee pass — Sol

**Tools:** exec
**Done when:** A written review with per-axis subscores exists on disk

Sol reads the paper cold and returns, to a file:

- **Per-axis subscores** on the rubric, each with a one-line justification
- **The 5–8 highest-leverage defects**, each with section, why it fails, and a concrete fix
- **What must change to reach 9.0** — stated as a checklist, not a vibe
- **What is already strong** and must not be lost in revision

Constructive means specific. "Tighten §4" is not a review; "§4's Q(n) curve has no fitted
coefficients, so a referee can dismiss it as a just-so story — fit it to MAST's published
per-framework failure rates" is.

### 3. Devil's advocate — the adversary

**Tools:** exec
**Done when:** An attack file exists that names at least one referee error

The adversary receives **the paper AND Sol's full review**, and is told its job is to be right,
not agreeable. It must produce:

1. **The strongest case that the paper is wrong** — not weak, _wrong_. Attack the thesis.
2. **Where the referee was too kind** — every inflated subscore, named.
3. **Where the referee was WRONG** — at least one. A devil's advocate that endorses the
   referee has not done the job; make this a hard requirement of the prompt.
4. **Which of Sol's fixes would make the paper worse** if applied literally.
5. **Its own independent score**, so the two reviewers can be compared.

### 4. Adjudication (Opus)

**Tools:** read, write
**Done when:** Every item from both reviews is marked accept / reject-with-reason / defer

Opus is the judge, not a third reviewer. For each item: **accept** (fix this round), **reject**
(with a stated reason — "the reviewer misread §6.2, the claim is already hedged"), or **defer**
(real but out of scope → goes to `improvement_notes.md`, not silently dropped).

Where Sol and Grok disagree, the disagreement is the most informative thing in the round —
resolve it explicitly and say which side won and why.

### 5. Revision (Opus)

**Tools:** edit, write
**Done when:** All accepted items are applied and the version is bumped

Apply the accepted items. Preserve the author's voice — improve, don't rewrite. Version the
output (v1.1, not overwrite v1.0). Never delete a section without rehoming its content.

### 6. Cold re-score

**Tools:** exec
**Done when:** A new score exists, produced without sight of the previous one

The referee re-scores the **revised** paper against the same rubric, **without being told the
prior score or that this is round N**. Anchoring is the failure mode here: a referee shown "you
said 7.4 last time" will report 8.9 whether or not the paper improved.

- **Score ≥ 9.0 AND no axis < 7** → go to Step 7.
- **Otherwise** → back to Step 3 with the new review. **Cap: 3 rounds.**
- **Cap reached without convergence** → STOP and report the blocking axis honestly. A paper
  that cannot clear 9 usually has a structural or evidence problem no prose pass will fix.
  Reporting "9.0" that was not measured is the one unrecoverable failure of this recipe.

### 6b. The cap bounds the REVIEWERS, not the work

**Read this before invoking the round cap.** The cap exists so reviewers do not loop forever and
so a score is never reported that was not measured. It is _not_ permission to stop editing.

When the loop terminates — converged or capped — sort every outstanding item into three bins
before writing a single one into the notes:

1. **Editable without a reviewer** — a wrong sentence the referee already handed you the repair
   for, a table that over-promises, repetition, broken counts, an unread citation, a stale build.
   **Do these now.** They needed a reviewer to _find_; they do not need one to _fix_. Re-scoring is
   optional for this class — the fix is verifiable by inspection.
2. **Needs the author's decision** — anything that changes the artifact's shape or central claim.
   Write it up with a recommendation, not a bare question ([[feedback_dont_make_oscar_the_bottleneck]]).
3. **Genuinely blocked** — needs data, infrastructure, or time the pass does not have.

Only bins 2 and 3 belong in the pending notes. A pending list padded with bin-1 items is a report
that the work stopped early, and the author will read it that way and be right. Observed on J19
(2026-07-28): seven of ten "pending" items were bin 1, deferred purely because the round cap had
been reached — conflating "stop reviewing" with "stop working."

### 7. Close out

**Tools:** read, write, exec
**Done when:** Notes reset, artifacts rebuilt, score trajectory reported

1. Fold accepted items out of `improvement_notes.md` (archive → `improvement_notes.incorporated-<date>.md`);
   **keep every deferred item as a pending entry.**
2. Rebuild any derived artifacts (`.tex` → `.pdf`) if the paper has them.
3. Report the **score trajectory** (r1 → r2 → r3, per axis), what changed, and what was
   deliberately rejected. The rejections are as informative as the fixes.

## The Rubric (fixed — do not renegotiate mid-loop)

Each axis 0–10. **Overall = mean, but no result ≥ 9.0 may be reported while any axis is < 7.**
A 9 average hiding a 4 on evidence is a failed paper with good prose.

| Axis                 | What earns a 9–10                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------- |
| **Thesis**           | One sharp claim, stated early, that the whole paper actually argues                       |
| **Evidence**         | Every load-bearing claim is measured, cited, or explicitly labelled as unmeasured         |
| **Novelty**          | Positioned against real prior art; the delta is stated and defensible                     |
| **Structure**        | Each section earns its place; numbering, cross-refs and the abstract all agree            |
| **Prose**            | Tight, active, no hedging or AI-isms, consistent terminology                              |
| **Self-containment** | Reads standalone — no series in-jokes, no "see companion paper", no unexplained codenames |

The rubric is published to the reviewers verbatim so their scores are commensurable across
rounds and across models.

## Constraints

- **Reviewers never edit.** They return files; Opus owns every write to the paper.
- **The rubric is fixed before round 1** and never adjusted to make a score land.
- **Cold re-scoring only** — the re-scorer must not see prior scores or round numbers.
- **Cross-vendor is mandatory.** Referee and adversary from the same vendor correlate their
  blind spots and the loop degrades into agreement theatre.
- **Round cap 3.** Non-convergence is a legitimate, reportable outcome.
- **Deferred ≠ dropped** — anything not fixed goes back into `improvement_notes.md`.
- Self-contained, version-independent prose: no changelog, no "improved in this version".

## Safety Notes

- Don't invent evidence to satisfy a reviewer. If a reviewer demands a number the work does not
  have, the correct fix is to label the claim unmeasured — not to fabricate the measurement.
- Don't let a reviewer change the paper's thesis without the author's explicit approval.
- Keep the prior version intact on disk; every round writes a new version.

## Failures Overcome

- **Silent model fallback:** a pinned non-Anthropic reviewer falls back to Opus and the "external"
  review is self-review wearing a costume. Step 0's probe plus a voice check catches it.
- **Score inflation:** a referee shown its own prior score anchors upward regardless of the
  revision. Cold re-scoring against a fixed rubric is the fix.
- **Devil's advocate as theatre:** an adversary asked to "give a second opinion" agrees with the
  referee. Requiring it to name a referee ERROR forces genuine adversarial work.
- **Mean-score laundering:** a 9.1 average concealing a 4 on evidence. The no-axis-below-7 gate
  blocks it.
- **Infinite polish:** each round finds new nits forever. The round cap plus "report the blocking
  axis honestly" ends it.
- **Mistaking a conceptual ceiling for an unfinished polish pass.** First observed on J19
  (2026-07-28), trajectory 5.8 → 7.8 → 8.0 → 7.8. Round 1 moved the score 2 points; rounds 2 and 3
  executed _every_ change the adversary named as highest-leverage — obtained the primary source for
  the load-bearing citation, cut the oversized section by half, rewrote the evaluation plan into a
  runnable protocol — and the score did not move. **A flat round after a fully-executed round is
  the signal to stop.** It means the remaining defects are structural (in that case: the taxonomy
  mixed levels of abstraction, and the thesis sentence was refuted by two of the paper's own
  categories) and no amount of editing reaches them. Write them to the notes as decisions the
  author must make, and stop. Diagnostic: if the referee's top defect is unchanged across two
  rounds while everything below it churns, you are at a conceptual ceiling, not a polish deficit.
