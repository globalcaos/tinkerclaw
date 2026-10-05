---
schema: recipe/1.0
id: adversarial-review-loop
title: "Paper Improvement Loop (master–slave: Claude edits, Astra reviews)"
category: writing
subdivision: papers
summary: The DEFAULT way to improve a paper — in rounds, Claude (master) edits, GPT-6 Astra (slave) reviews the built PDF against a fixed human-readability rubric and returns a score plus improvement notes — until Astra scores it 9/10 or higher with no axis below 7
triggers:
  [
    "improve the paper",
    "the abstract",
    "abstract of the paper",
    "tells a story",
    "storyline",
    "paper's story",
    "vision of the paper",
    "improve paper",
    "revise the paper",
    "revise paper",
    "review the paper",
    "review paper",
    "paper review",
    "polish the paper",
    "round of improvements",
    "make the paper better",
    "rewrite the paper",
    "version of the paper",
    "paper is lacking",
    "a bit lacking",
    "bounce to",
    "step back",
    "concept pass",
    "real novelty",
    "flow of concepts",
    "direction of the paper",
    "ask astra",
    "astra review",
    "master-slave",
    "master slave",
    "slave review",
    "professor",
    "send it to sol",
    "score the paper",
    "score it 0-10",
    "referee",
    "until 9/10",
    "9 or higher",
    "adversarial review",
    "external review",
    "peer review the paper",
    "improve the paper in a loop",
  ]
effort: deep
tools: [read, grep, glob, exec, edit, write]
children: [compile-paper, jseries-paper-conventions]
---

## Goal

Raise a paper to a bar a human reader would accept, using a reviewer from **another vendor** and a
rubric built from the defects we actually keep shipping: papers that are hard to read, have no
diagrams, bleed tables off the page, open with an abstract that gives the reader nothing to hope for,
tell no story, refer to earlier versions, carry material that could be cut, and read as if written for a
machine.

The loop ends on a **measured** Astra score of **≥ 9.0/10 with no axis below 7**, or on an honest
"did not converge" (Step 7). Never on "it feels good now".

## Default procedure (principal, 2026-09-28)

This loop is **the** paper-improvement procedure. Any ask to improve, revise, rewrite, polish or
review ONE paper runs it, whether or not the words "Astra" or "loop" appear. `revise-paper` is no longer the
single-paper default: it is the unit step inside `revise-publish-batch`, and the fallback only when
the principal declines to chain an Astra tab (Step 0). Whole-series sweeps stay with
`revise-publish-batch`.

Triggers are paper-scoped phrases on purpose: a bare `improve` also matched "improve the dashboard
UI" and would have started an Astra loop on a code task (matcher probe, 2026-09-28).

## What a paper is (principal, 2026-09-29; refined the same day from the writing literature)

A paper is a **story** a person wants to read to the end, told for the reader, not a report of everything
that was done. The principal set the shape; the rules under it come from the standard guides (sources at the
end of this section), each phrased so a reviewer can check it.

### The four parts

1. **Vision.** The future the work reaches toward, concrete enough to picture and want. Test: say it with no
   jargon, and answer "who cares, and what changes if this works?" (Heilmeier questions 1 and 4).
2. **Claim.** One sharp idea, the paper's single "ping" (Peyton Jones), stated in one sentence and carried by
   the title (Mensh & Kording, rule 1). Several ideas means several papers.
3. **Explanation.** The idea as you would give it at a whiteboard: here is a problem, it matters, it is not
   solved, here is my idea, here is why it works, here is how it compares (Peyton Jones). An example first,
   then the general case; intuition before details.
4. **Proof, where possible.** Every claim in the introduction points forward to the section that supports it
   (Peyton Jones). Results are questions answered one by one (Mensh & Kording, rule 7), and the discussion
   states the limits (rule 8). Where there is no proof yet, name the test that would decide it (Heilmeier's
   "mid-term and final exams"). A hope is never dressed as a result.

### The engine: And, But, Therefore

Every level of the paper moves the same way: **and** sets up what the reader already accepts, **but**
introduces the obstacle, **therefore** delivers what the paper does about it (Olson's ABT; the same three
beats as Mensh & Kording's context–content–conclusion, rule 3). It applies to the abstract, to each section
and to each paragraph. A run of "and … and … and" is a list, not a story. This is not cosmetic: across 732
climate-science abstracts, the more narrative ones (more connectives, sensory language, sentences that link
to each other, direct appeal to the reader) were cited more often (Hillier et al., 2016). The study is
correlational and largely tracks journal prestige, so story helps a good result travel; it never replaces one.

### The abstract: the kid reaching for the stars

The abstract is the whole story in miniature, because most readers read nothing else (Mensh & Kording,
rules 5 and 9). It opens on the vision and speaks to the reader's inner child: a future they already hope
for, made concrete. Then, in order:

1. **Vision** (1–2 sentences): the hope, in words anyone understands. Nature's template opens the same way,
   with an introduction "comprehensible to a scientist in any discipline". When the idea borrows from nature,
   open on the reader's own experience of that natural function, in a few plain phrases (J11 v6.4: the voice that
   jerks your hand away from a spider), before saying what the engineering version would do.
2. **But** (1–2 sentences): what stands in the way today, narrowing to the specific gap.
3. **Therefore** (1 sentence): the claim, with "here we show", "we propose" or their equivalent.
4. **What it does for the reader, and where it stands** (2–3 sentences): the concrete benefits in the reader's own
   system, then one plain phrase on where the work stands, with "not yet" where there is no proof. A number goes
   in only when it IS the story; case counts, thresholds and caveats live in the body, where a reader who wants
   them can check them. The how lives in the body, and the history of earlier attempts never goes in the abstract (principal, 29 Sep 2026: "the reader
   does not give a fuck about our previous attempts, but what the digital amygdala can actually do for their
   harness").
5. **Back to the vision** (1 sentence): what becomes possible if this holds.

There is no word budget and no paragraph quota: the abstract is as long as the story needs and short enough to
sit under the title on page 1 (compile-paper, blank first page). Test each sentence by what the reader loses
without it; a sentence that is there to fill a slot of this list, meet a count or satisfy a reviewer's rigor
axis fails the test. **Too much rigor is rigor mortis** (principal, 29 Sep 2026): precision serves the reader,
and it pays in the body, not in the doorway. The vision is one or two sentences, not a preamble: Widom's rule, "little if any background", still
holds for everything after it. Wonder, not hype: no adjective does the work of evidence.

### No literal prompts

A paper never prints the text sent to a model: no prompt, no question "as sent", no system message. It says how
such text is built (what it asks about, its options, the habits behind its wording) and points to where the
exact wording is kept, available on request. Examples of what a user sees or an agent says are fine. A wording
in print freezes one version of a text that is meant to improve, and it reads as a recipe to copy instead of an
idea to understand (principal, 29 Sep 2026: "I don't want to see, anywhere in the paper, literal prompts. I just
want to see pointers, recommended ways to word things").

### Checks a reviewer can run

- **One sentence.** If the author cannot state the claim in one sentence, or walk a colleague through the
  outline in a few minutes, the reader will not manage either (Mensh & Kording, rule 10).
- **The skim test.** Title, abstract, first figure and conclusion, read alone, tell the whole story. Peyton
  Jones's rough funnel: 1,000 readers see the title, 100 the abstract and introduction, 3 the details.
- **Contributions** are a short list, each refutable and each pointing to the section that proves it. No
  "the rest of this paper is organised as follows".
- **The introduction** answers: what is the problem, why it matters, why it is hard (why do naive approaches
  fail?), why it is not solved yet, and what this paper does, with its limits (Widom).
- **Related work comes early and short** in the principal's papers: right after an introduction that expands
  what the abstract had no room to say, a brief section places the work among papers and harnesses doing
  similar things, then gets out of the way (principal, 29 Sep 2026; Peyton Jones puts it after the idea, and
  the principal's order wins). Credit the competition generously, and **tie every cited work back to ours**: what
  it does, where ours builds on it or differs, and a pointer to the section that explains ours. That one move
  teases what the paper has not explained yet, sets the original contribution against solid references, and shows
  the due diligence of understanding what exists before building on it (principal, 29 Sep 2026, 13:22).
- **References are on-ramps.** A citation brings a reader who does not know the field closer to the idea. Mention,
  quote or summarise an external work only as much as the argument needs, and point the curious reader to the
  paper, site or book that goes deeper, so each can choose their own rabbit hole (principal, 29 Sep 2026).
- **Chapters as orthogonal views.** When a problem can be seen from several sides (J11: the brain, one agent
  turn, the judge, then the proposal), give each side its own chapter that a reader can take alone, keep each
  to what the case needs, and cite specialised work instead of replacing it (principal, 29 Sep 2026).
- **The idea's story, not the author's diary.** "Do not recapitulate your personal journey of discovery"
  (Peyton Jones). In the principal's papers an earlier failed attempt does not appear at all: its lessons show
  up as design choices, stated as such (principal, 29 Sep 2026: "do not mention things that did not work. We've
  learned from it and this is why we are now proposing to use Jev instead"). Current limits of the proposed
  design are not history and stay.
- **One subject in one place, one word per concept** (Mensh & Kording, rule 4). Each paragraph opens with its
  context and closes with its conclusion; each figure title states what the figure shows.
- **Sentences:** the familiar before the new (the end of a sentence is where the reader looks for what
  matters), the subject close to its verb, the action in the verb (Gopen & Swan, 1990).
- **The closing chapters are Conclusions, then Next steps** (principal, 29 Sep 2026). _Conclusions_ opens with an
  executive summary of the whole paper in a few sentences, written for a reader who now knows every concept, so
  nothing is re-explained, and ends on the vision; then it states the limitations found. _Next steps_ says which
  tests would settle what is not yet known (the evaluation protocol lives here), what else is worth trying, and,
  for a TinkerClaw feature, that it will be built and tested and that an updated version of the paper will
  follow. It does not repeat the abstract (Widom).

A paper that fails the one-sentence test or the skim test, or has no vision that the conclusion returns to,
is a DIRECTION finding (Step 1), not a polish item. Worked instance: J11 v6.0 (the amygdala paper) was
rebuilt on this shape after automatic rounds had turned it into a report.

**Sources** (read 29 Sep 2026): Mensh & Kording, "Ten simple rules for structuring papers", _PLOS
Computational Biology_ 13(9), 2017, <https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1005619>;
Peyton Jones, "How to write a great research paper" (slides),
<https://www.microsoft.com/en-us/research/wp-content/uploads/2016/07/How-to-write-a-great-research-paper.pdf>;
Nature, "How to construct a Nature summary paragraph", <https://www.nature.com/documents/nature-summary-paragraph.pdf>;
Gopen & Swan, "The science of scientific writing", _American Scientist_ 78(6), 1990,
<https://www.usenix.org/sites/default/files/gopen_and_swan_science_of_scientific_writing.pdf>; DARPA, "The
Heilmeier Catechism", <https://www.darpa.mil/about/heilmeier-catechism>; Widom, "Tips for writing technical
papers", <https://cs.stanford.edu/people/widom/paper-writing.html>; Olson, the ABT framework,
<http://abtframework.com/>; Hillier, Kelly & Klinger, "Narrative style influences citation frequency in
climate change science", _PLOS ONE_ 11(12), 2016, <https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0167983>.

## Roles (master–slave; principal's decision, 2026-09-28)

| Role                | Model                                                                              | Job                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Master**          | Claude (the running session)                                                       | Owns the manuscript. Assembles the review packet, adjudicates every note, makes every edit, rebuilds and looks at the PDF.              |
| **Slave ("Astra")** | GPT-6 Astra (`gpt-6-astra`, provider `openai-codex`) in the **chained Tinker tab** | Reads the built PDF, the page images and the layout report, scores the rubric, and returns concrete improvement notes. **Never edits.** |

The cross-vendor split is the point: a model grading its own writing converges on flattery. Astra
replaced the earlier two-reviewer setup (a "professor" referee plus a devil's advocate) because one
strong, diverse reviewer with a fixed rubric and a master who must justify every rejection gave the
same pressure with half the round time.

## Steps

### 0. Resolve the slave and check it is really Astra (gate)

**Tools:** exec
**Done when:** `loop-partner.mjs` returns `role: master` for this tab, and the slave session runs `gpt-6-astra`.

The principal draws the pair in the Tinker UI (right-click a tab, **Set conversation slave**). The
master never picks a partner by guessing from tab titles:

```bash
S=~/.openclaw/workspace/skills/conversation-loop/scripts
P=$(node $S/loop-partner.mjs)                       # uses $TC_SESSION_KEY
SLAVE=$(echo "$P" | python3 -c 'import json,sys;print(json.load(sys.stdin)["partner"]["sessionKey"])')
openclaw gateway call sessions.list --json | SLAVE=$SLAVE python3 -c 'import json,os,sys
d=json.load(sys.stdin); d=d.get("sessions",d)
print([(x["model"],x["modelProvider"],x.get("status")) for x in d if x["key"]==os.environ["SLAVE"]])'
# expect [('gpt-6-astra', 'openai-codex', ...)]  (verified 2026-09-28)
```

`role` must be `master`; exit 2 means the tab is not chained, so ask the principal to chain it. If
the slave is not on `gpt-6-astra`, say so and stop; never substitute Claude.

**Exception: the principal moved the slave himself** (J11 r16–r17, 2026-09-29). His newest explicit choice
wins over this gate: keep the loop running, mark each such round same-vendor in its `adjudication.md`, never let
a same-vendor score close the loop (Step 7), and do not send through `send_round.sh`, which pins Astra again.

### 1. Concept pass (first round; again only after a direction change)

**Tools:** read, write, exec
**Done when:** The blind reply is saved and compared with the sealed intent, and every DIRECTION finding has the principal's decision.

Before any readability round, review the paper one level up, as if it were compressed to a page: what it
conveys, what is really new, whether the argument holds, whether the examples carry weight. Polishing a paper
whose direction is wrong wastes every later round (Failures Overcome, J11).

1. **Seal the intent first.** Write `<round-dir>/intended-message.md` (intended sentence and contribution,
   in the principal's OWN WORDS, quoted and dated; a master's paraphrase drifted once already, J11 29 Sep;
   ask him for one sentence if none is on record) and `<round-dir>/master-blind.md` (the master's own
   compression and expected findings) BEFORE sending. The timestamps prove the order.
2. **Send the Concept Prompt** (section below) verbatim, with the paper path, audience and constraints, never
   the intended message. Same send path as Step 3; end the turn.
3. **Intent comparison.** Save the blind reply. If its sentence and contribution match the sealed intent,
   note it and move on; otherwise send the intended message as the prompt's "later turn" and have the
   reviewer classify each material difference against the paper.
4. **Adjudicate.** EDIT findings go through Steps 4–5 as usual. **DIRECTION findings stop the loop:** show them
   to the principal next to the master's own view and edit nothing they touch until he decides. Record each
   decision in the round's `adjudication.md` so later rounds do not reopen it; only a question still waiting
   for him goes into `improvement_notes.md`, under its decisions heading. The reviewer can test provenance only
   for what it can open; incidents drawn from the principal's private chats and session logs never go to it,
   so the master checks those against the record here (observed sequence vs the paper's diagnosis).
5. **Repeat** only after a material change to thesis, contribution, audience or evidence; after ordinary
   edits, re-check only the affected argument links. Two concept passes without convergence: stop and hand
   the choice to the principal. Stop the loop, not the disagreement.

### 2. Build the review packet (every round)

**Tools:** exec
**Done when:** One folder holds the PDF, page images, the layout report and the Markdown source.

The reviewer judges what a reader sees, so the packet is built from the **PDF**, not only the source:

- the PDF, built through `compile-paper` (post-processing included);
- every page rendered to PNG and tiled four to a contact sheet;
- a **layout report produced by code**: page count; every `Overfull \hbox` wider than 5 pt with the
  source line; every `Overfull \vbox` (a page built too tall) and any body text inside the footer zone, the
  two checks that alone caught twenty lines of J11 v6.6 printing off page 9, which a 60-dpi contact sheet
  hid (a packet never ships while either is red); near-blank pages; section titles stranded at the foot of a page; the count of
  "References" headings (must be 1); figure and table counts; the hand-set footer against the front matter;
  and whether `improvement_notes.md` is reconciled with this version (its header names it, nothing struck
  through, no scores or loop status);
- the Markdown source, for exact quoting in notes.

Look at every contact sheet yourself before sending: the layout report has missed defects a glance
catches (Failures Overcome). Reference implementation (J11): `reviews/make_packet.sh <paper.md> <round-dir>`
and `reviews/layout_report.py` in `~/Documents/AI_reports/Papers/J11_learned_intuition/`.

Before a novelty-type claim is scored, spend five minutes on a live-product search for each
load-bearing mechanism and add the hits to the packet (Failures Overcome, last entry).

### 3. Send the round to the slave tab, then END the turn

**Tools:** exec
**Done when:** The watcher is armed, the turn is sent with `--no-wait`, and the master's turn has ended.

The review goes **into the slave's Tinker tab**, where the principal watches it arrive as a blue
bubble badged with the master tab's name. The master does not wait for it. A detached watcher wakes
the master's tab when the slave's run finishes, and the wake prompt carries the slave's final message,
so the review arrives as the master's next input (cut short when long; see "When the wake arrives").

```bash
R=<round-dir>                                    # e.g. reviews/r4
# the turn file: the fixed rubric, absolute packet paths, and (from round 2) the author's response
READY=/tmp/review-wake-<paper>.ready             # one file PER PAPER: two loops (J11 and J19 ran the same
                                                   # evening, 2026-09-29) sharing one path can read each other's
                                                   # 'armed' and send unarmed
systemctl --user is-active review-wake-<paper> && { echo "watcher already running"; exit 1; }
rm -f "$READY"
systemd-run --user --unit=review-wake-<paper> --collect \
  node $S/wake-on-finish.mjs --watch "$SLAVE" --wake "$TC_SESSION_KEY" \
    --ready-file "$READY" --timeout 3600
for i in $(seq 1 240); do [ -s "$READY" ] && break; sleep 0.25; done
[ -s "$READY" ] || { echo "watcher not armed"; exit 1; }   # never send unarmed
node $S/converse.mjs --session "$SLAVE" --say-file "$R/turn.md" --no-wait --json > "$R/sent.json"
```

Then end the turn with one line to the principal: which round was sent, and that the tab wakes
itself when Astra finishes. Do not poll, do not `--wait`: a turn that sits on a spinner can die
holding the loop, and it hides the exchange from the principal.

**The turn file.** The rubric below, verbatim, plus the absolute paths of the packet files and the
instruction to open every contact sheet with an image-capable reader. Do not state the round number
or any previous score. From the second round on, add a short **author's response**: one line per
earlier note, saying what changed or why it was rejected. The slave's tab keeps its earlier reviews,
so this is a second-round referee, as at a journal: it sees its previous report and the response,
and it must re-score every axis from the new PDF.

**When the wake arrives** (a blue bubble in the master's tab, badged with the slave's tab name):
save the text as `<round-dir>/astra-review.md` and go to Step 4. **A long review arrives truncated** (it ends in
`… (truncated)`; J19 r1 and r2, 29 Sep 2026, both ~20 k characters): save the full final message instead, from
`openclaw gateway call chat.history --params '{"sessionKey":"<slave>","limit":6}' --json` (the last `assistant`
entry with text), and check its length and its ending before judging anything. An empty or error wake is not a
review: check `sessions.list` for the slave's status; if it is running again, re-arm and end the
turn; never resend a prompt that is already being worked on (conversation-loop skill, wake section).
Kill switch: `systemctl --user stop review-wake-<paper>.service`.

**Fallback, only if the tab path is down** and the principal agrees: `codex exec --model gpt-6-astra
--sandbox read-only -i <sheets> -o <round-dir>/astra-review.md - < turn.md`. It runs off-channel,
so the principal sees nothing in the slave tab; say so in the round report.

### 4. Adjudication (master)

**Tools:** read, write
**Done when:** Every note is marked accept, reject-with-reason, or defer.

Accept what improves the paper for a human reader. Reject with a stated reason (the note misreads the
text, would add length without meaning, or would require inventing evidence). Defer what is real but
out of scope as a `###` entry in `improvement_notes.md`. Keep the adjudication file next to the review.

**The principal's own marks come first.** When the architect has read the PDF in the review viewer
(`~/src/pdf-review`, page-by-page pdf.js at `http://127.0.0.1:18820/viewer/web/viewer.html?file=/papers/<name>.pdf`)
and saved it, run `~/src/pdf-review/pdf-comments.py <the saved PDF, newest in ~/Downloads>`. Each line is page,
kind, the quoted text and his note; find the passage in the source by the quote. His notes are accepted by default;
reject one only with a reason he would accept, and say which. Added 2026-10-03, when the viewer was built:
"I would like to be able to easily annotate the file so you can easily read the comments I made".

### 5. Revise (master)

**Tools:** edit, write, exec
**Done when:** Accepted notes are applied, the version and footer are bumped, `improvement_notes.md` is
reconciled, and the PDF is rebuilt and LOOKED at.

**Every rebuilt version is an incorporation event, so reconcile the queue here, every round, not only at
close-out** (`jseries-paper-conventions` § 2). Move `improvement_notes.md` to
`improvement_notes.incorporated-<date>-v<N>.md`, then write a stub whose header names the new version,
followed only by the entries still pending, as `###` items. The queue never holds done items, scores, round status
or decisions already made; those belong in the round's `adjudication.md`. Questions still waiting for the
principal do stay, under the queue's decisions heading (Step 1.4). Bump the hand-set footer
(`_J-series paper … | Version … | date_`) with the version.

Targeted edits, not rewrites. Diagrams are drawn as real figures (D2 or TikZ rendered to PDF/PNG and
embedded), never ASCII art. After the rebuild, look at every page Astra flagged and at the first and
last pages.

**Every text change goes through skill `human-voice` before the rebuild**, reviewer notes and the principal's own
edits alike (title, abstract, a replaced phrase): read its `SKILL.md`, then
`voicecheck.py <title+abstract>.txt --mode doc` and the same on the body. Fix every HIGH; bold run-in heads and
the qualifiers that mark evidence limits are document structure, so judge those MEDs, don't strip them. the architect,
2026-09-30, after a retitle written without it: "did you use the humanization skill we developed?"

### 6. Re-review

Back to Step 2: a fresh packet, a fresh watcher, a fresh send with the author's response.

### 7. Stop rules

- **Astra overall ≥ 9.0 and no axis < 7** → Step 8.
- **Flat round:** a round in which every accepted note was applied and the score did not rise, or the
  top note is the same as last round → stop; the remaining defect is structural. Write it up for the
  principal with a recommendation.
- **Safety cap: 8 rounds.** Report the trajectory honestly; never report a score that was not
  measured.
- **The principal stops the loop** (the slave's budget, time, a new priority) → Step 8 at once. Report the
  last revision as unscored.

### 8. Close out

1. Archive the review and adjudication files next to the paper (`reviews/`).
2. Confirm the queue is reconciled with the final version: the layout report's queue line says ok. A loop
   stopped between rounds may not have run Step 5 for its last revision; reconcile it now, the same way.
   Whether that version was scored, the scores and why the loop stopped go in the round's `adjudication.md`
   and the close-out report, **never in the stub**: its header names the version and the archive, nothing else.
3. Commit every recipe and tool edit the loop made (on `develop`, or merged into it with the branch deleted).
   A long loop runs under several session ids in the same tab, so an uncommitted edit to these recipes is the
   loop's own until a transcript proves otherwise (`grep -l '<a phrase from the diff>'
~/.claude/projects/*/*.jsonl`). Never leave it as "another session's work".
4. Report the score trajectory per axis, the notes rejected and why, the final PDF path, and the state of the
   queue and of the commits, so "did you finish?" is already answered.

## The Concept Prompt (Step 1; published to the slave verbatim)

Co-designed with Astra, 29 Sep 2026 (`reviews/r10-prompt-design/` in the J11 folder); the story checks in
items 1 and 2 were added the same day on the principal's instruction (§ What a paper is). Replace nothing
but the inputs line.

> You are reviewing the paper's intellectual direction, not its presentation. Read-only: do not edit files,
> score the paper, polish sentences or perform an exhaustive inventory audit. Read the paper, compress its
> actual argument, then inspect only the passages needed to test that argument.
>
> Inputs: the paper; intended audience and publication context; explicit constraints; available evidence and
> references. The author's intended message and novelty statement are withheld until a later turn. Missing
> evidence is a limitation, not permission to invent it.
>
> **1. Reconstruct what the paper actually conveys, not the better paper you would prefer:**
> one sentence a reader would repeat to a colleague; one paragraph (problem, central claim or proposal,
> reasoning, evidence and limits; separate demonstrated results from proposed benefits); an argument spine of
> 3–7 necessary claims with section references, showing dependencies (fewer if sufficient). Name the paper's
> kind: empirical result, design proposal, theory, synthesis, position, or a justified combination. Name its
> **story**: the vision it reaches toward, its claim, its explanation and its proof, as a reader finds them,
> and say which of the four is missing or out of order.
>
> **2. Test the spine.** Does the abstract open on a vision the reader can picture and want (speak to the
> reader's inner child) before the problem, and does the conclusion return to it? Is the vision kept apart
> from what is proven? Does it pass the skim test (title, abstract, first figure and conclusion alone tell the
> whole story) and can its claim be said in one sentence? Is the problem consequential for this audience, and does the contribution address it?
> What is genuinely new against at most three close precedents, including products shipping today (search them
> live)? Unverified novelty is not demonstrated duplication; lack of implementation does not negate conceptual
> novelty. Which transitions need an unstated assumption? Test the strongest alternative explanation or
> counterexample. What competes with the central contribution; would subtraction or reordering strengthen it,
> keeping necessary qualifications? Inspect load-bearing examples, figures and numbers only: for each contested
> one give its role, provenance (observed, synthetic, illustrative, unverified), the inference it supports and
> the stronger one it does not, and what deleting it would lose. Synthetic examples establish possibility, not
> frequency or effectiveness. Separate an incident's observed sequence from the author's diagnosis of its cause.
> Widen the inspection only when a defect could change the conclusion or suggests a systematic evidence problem.
>
> **3. Report at most five findings, ranked by consequence; fewer or none is valid.** Each: EDIT or DIRECTION;
> section and concrete observation; consequence for what the reader believes ("it changes whether the reader
> should believe \_\_\_"); smallest sufficient remedy and what must survive it; confidence and the evidence that
> would settle it. EDIT preserves the central promise, contribution, audience and evidential commitment;
> DIRECTION requires the author to choose or change one of them. Effort does not decide the label. Do not force
> a new direction. If no finding covers it, name the single change that would most raise the paper's value to
> its audience, if there is one. End with: ready for detailed review, author decision needed, or evidence
> needed, naming only material blockers.
>
> **Later turn, intent comparison:** the author's intended message and contribution are supplied. Keep the
> original compression. Classify each material difference as compression loss, reader error, unclear
> communication, or a substantive thesis/evidence disagreement, and justify it against the paper. Neither version
> is automatically right. Escalate only differences that change the promised contribution or the reader's
> understanding.

## Variant: content round (no rubric, no score)

Used when the principal asks Astra about the **meaning** rather than the page (first run: J11, 2026-09-29):
the core concept, a verdict on each planned function (keep / cut / merge / move / change), new functions
with evidence that people ask for them, and a mechanism-level build plan with **no prompt texts**. Same
Steps 0 and 3 (verified pairing, pinned model, watcher before send, end the turn); no layout packet, the
Markdown plus the notes file suffice. When the wake arrives the master does **its own pass on the same
questions**, using Astra's answer as input, and presents a feedback table (item | Astra | master | verdict).
The paper is not rewritten on the strength of a content round: concept and function changes wait for the
principal's go (Safety Notes). Reference brief and sender: `reviews/r9-content/turn.md` and
`reviews/send_round.sh` in the J11 folder (the sender hard-codes that pair's keys; re-check with
`loop-partner.mjs` first).

## The Rubric (fixed for the whole loop; published to the slave verbatim)

Each axis 0–10. **Overall = mean. No overall ≥ 9.0 may be reported while any axis is < 7.** Axis 4 was
rewritten and axis 9 added on 29 Sep 2026 by the principal; rounds scored before that used eight axes.

| Axis                     | What earns a 9–10                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1. Human readability** | A capable non-specialist follows every section on first reading; terms are explained where they first appear; the argument has a visible thread                                                                          |
| **2. Diagrams**          | Every mechanism that is easier to see than to read has a figure; no figure is decorative; each is referenced and captioned                                                                                               |
| **3. Print layout**      | Nothing bleeds out of the printable area (tables, code, URLs); no blank or near-blank pages; one References section with its entries; tables fit and stay legible                                                        |
| **4. Abstract**          | Opens on a vision the reader can picture and wants (the kid reaching for the stars), then what stands in the way, the claim, how it works and what is shown, in plain words; the vision inspires, the results stay exact |
| **5. Stand-alone**       | Never refers to earlier versions of the paper or to their history; codenames and companion papers are explained or removed                                                                                               |
| **6. Concision**         | Nothing can be cut without losing a core concept; repetition removed; appendices only for what readers may need                                                                                                          |
| **7. Human language**    | Written for people, not machines: no AI-isms, no jargon without need, no status-marker soup, sentences a person would say; the familiar before the new, subject near its verb, the action in the verb                    |
| **8. Evidence honesty**  | Every claim is measured, cited or labelled unmeasured; numbers agree across sections; every reference exists                                                                                                             |
| **9. Story**             | Reads as one story: vision, claim, explanation, proof where possible, moving by And–But–Therefore; passes the skim test; every section serves it; the conclusion returns to the vision (§ What a paper is)               |

## Constraints

- The slave never edits; the master owns every write.
- The rubric is fixed before round 1 and never adjusted to make a score land.
- No round number and no previous score in the prompt; the author's response states changes, not scores.
- Every review goes through the chained slave tab, so the principal sees it (Step 3).
- Cross-vendor is mandatory; a silent fallback to Claude voids the round (Step 0).
- The master ends its turn after sending; it never waits in-turn for the slave.
- The PDF, not only the source, is what gets reviewed; layout is checked by code and by eye.
- Deferred is not dropped: every deferred note becomes a `###` entry in `improvement_notes.md`. The queue is
  emptied as it is incorporated, never used as a log (`jseries-paper-conventions` § 2).

## Safety Notes

- Never invent evidence to satisfy a reviewer; label the claim unmeasured instead.
- The reviewer does not get to change the paper's thesis without the principal's approval.
- Keep each round's PDF (`reviews/rN/`) so a regression can be undone.

## Failures Overcome

- **Eight readability rounds before anyone asked what the paper was for (J11, 28–29 Sep 2026):** rounds 1–8
  raised the score from 5.x to 8.6 while the paper grew to 54 functions; the first content round (r9) found
  more than all of them, starting with "the centre should be authorisation and effects". The concept pass is
  now Step 1.

- **Silent model fallback:** a pinned non-Anthropic reviewer fell back to the author's own model and
  the "external" review was self-review. Step 0's probe catches it.
- **Score inflation by anchoring:** a reviewer shown its previous score reports a higher one whatever
  changed. The prompt never states a score; the tab still remembers its own reports, so the rubric
  demands a re-score of every axis from the new PDF.
- **Spawned "Astra" was Claude (J11, 2026-09-28):** `openclaw-spawn-subagent.mjs --model
openai-codex/gpt-6-astra` reported `modelApplied:true` and ran `claude-code/claude-opus-5`. The
  spawn path is not used for the slave any more; the slave is the chained tab, whose model is read
  from `sessions.list` in Step 0.
- **Reviews the principal could not see (J11, 2026-09-28):** rounds 1 and 2 ran through `codex exec`,
  off-channel. The principal: "I cannot see any blue message in your slave, you are doing something
  wrong." Every round now goes into the slave tab with `converse.mjs`.
- **Master waiting in-turn (J11, 2026-09-28):** round 3 was sent with `--wait 585` and the master sat
  on it for 3.7 minutes. The principal: the call ends after sending, and the slave wakes the master.
  Step 3 now arms `wake-on-finish.mjs` as a systemd unit and sends with `--no-wait`.
- **Mean-score laundering:** a 9.1 average hiding a 4. The no-axis-below-7 gate blocks it.
- **Conceptual ceiling mistaken for missing polish (J19, 2026-07-28):** 5.8 → 7.8 → 8.0 → 7.8 after
  every note was applied. A flat round after a fully executed round means the defect is structural;
  stop and hand the decision to the principal.
- **Review of the source instead of the page (J11 v5.0, 2026-09-28):** a clean build and a correct
  Markdown file shipped a blank first page, cramped six-column tables and a second, empty "References"
  section at the end of the PDF; the principal found the last one. The packet now includes page
  images and a code-made layout report, and the reviewer looks at the page.
- **Prior art swept from papers only while a competitor ships (NeuroCoin, 2026-09-14):** search for
  live products before scoring novelty.
- **Thesis drift through rubric rounds (J11, 2026-09-29):** eight readability rounds each accepted
  reasonable notes and together turned "distil the amygdala, build it beside the model with Jev" into "a
  guard that demands evidence". The principal: "the paper got distorted from its original intention by
  automatic updates." Every adjudication (Step 4) now checks each accepted note against the sealed intent;
  a note that moves the thesis is a DIRECTION item for the principal, never an edit the master applies.
- **The notes queue became a log (J11, 2026-09-29):** v6.1, v6.2 and v6.3 were built in three rounds and the queue
  was never reset; the master appended a struck-through "done" item and a loop-status line instead. Cause: this
  recipe told the master to append to `improvement_notes.md` at Steps 1, 4 and 8, never said when to empty it, and
  did not link `jseries-paper-conventions`, where the reset rule lives, so the rule never loaded during a loop.
  The principal had to ask "did you forget to reset improvement notes?". Now Step 5 reconciles the queue on every
  version, decisions go to the adjudication file, the conventions recipe is a child, and the layout report
  checks the queue header against the manuscript's version.
- **Close-out wrote the loop's status into the queue and left the recipe uncommitted (J11 v6.7, 2026-09-29):**
  Step 8 told the master to "say in the stub's header whether that version was scored", so the stub carried
  "unscored", both scores and the stop rule, and the layout report passed it because it checked only the
  version and strike-throughs. The same close-out left 323 lines of this recipe family uncommitted, calling
  them another session's work; they were the same tab's, under two earlier session ids. The principal had to
  ask "did you finish? did you remember to clear out the improvement notes?". Now Step 8 sends status to the
  adjudication, commits the loop's own edits, and reports both; the layout report goes red on scores or loop
  status in the queue (reference: J11 `reviews/layout_report.py`).
- **Rigor mortis in the abstract (J11 v6.5–v6.7, 2026-09-29):** the abstract list asked for "the results with
  exact numbers and an honest not yet", two recipes gave word targets (200–350 here, 300–450 in `revise-paper`),
  and each round's evidence-honesty note added a caveat. The last paragraph became a test report: 12 cases
  against 8, "at a fixed threshold", a protocol. The principal asked why it was there: "too much rigor can lead
  to rigor mortis". Now a number enters the abstract only when it is the story, there is no word budget, and
  caveats live in the body.
