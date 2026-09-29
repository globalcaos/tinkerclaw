---
schema: "kit/1.0"
slug: "interview-prep-test-printout"
title: "Interview Brief from a Candidate's Online Test"
summary: "Turn one candidate's graded competency-test attempt into a printable interview brief: every section on its own page, every question numbered N.M with a coloured score chip, the candidate's verbatim answer, the grader's one-line reason, the section's time / declared-AI / paste line, the skip reason for skipped sections, and a highlighted 'ask in the interview' box on each weak spot. Then map the chosen questions to page numbers so the interviewer can find them on paper."
version: "1.1.0"
owner: "globalcaos"
license: "MIT"
category: "operations"
tags:
  [
    "interview prep",
    "interview questions",
    "print test results",
    "candidate test printout",
    "competency test report",
    "hiring test pdf",
    "preparar entrevista",
    "preguntes entrevista",
    "imprimir prova",
  ]
tools: ["read", "exec", "write"]
testedHarnesses: ["Claude Code"]
authoredBy: "jarvis-on-the-fly"
model:
  provider: "anthropic"
  name: "claude-opus-5"
  hosting: "cloud API"
resolverHints:
  [
    {
      "match": "interview prep | questions to ask | print his test | print the online test | test results pdf | preparar entrevista",
      "load": ["recipe.md"],
      "purpose": "Build a printable, question-annotated interview brief from a graded test attempt.",
    },
  ]
params:
  values_file:
    {
      type: "string",
      description: "Private vacancy notes naming: the test API and its read-only admin door, the question-bank file, the generator script path, the output folder, the printer queue, and the brief's language.",
    }
  attempt_id:
    { type: "integer", description: "Id of the candidate's attempt in the test database." }
  interview_at: { type: "string", description: "Interview date/time, printed in the header." }
---

# Interview Brief from a Candidate's Online Test

## Goal

The interviewer walks in with paper, not a laptop. Give them one document where every
weak spot of the test is already turned into a question, and each question can be
found by page and number in seconds. Scores are evidence, not a verdict: the brief
exists to make the interview test what the grader could not see.

## Output contract

One A4 PDF, portrait, in the language set in {{values_file}}:

1. **Header** — candidate name, attempt id, submit date, minutes on the clock,
   sections attempted, total pastes, window switches, grader average, interview time.
   1b. **Page 1 — "How they work with AI"** (mandatory, before section 1): the evidence
   from the test (step 2b), the working-style spectrum as a table with the preferred
   row tinted, a "do not reveal which profile we prefer" line, and a numbered ladder of
   AI questions (IA-1…) with the two decisive ones starred. Close with a one-line
   practical box (salary expectation, on-site policy) when the vacancy notes carry one.
2. **One page per section, in test order, skipped ones included.** Heading
   `N. <section name>` with a score chip coloured by band (≥8 dark green, 6–7 green,
   4–5 amber, ≤3 red). Under it: minutes spent · submitted/skipped · AI declared
   yes/no · paste count. Then the grader's section summary in italics.
3. **Skipped section** — the candidate's own skip reason and stated interest, quoted,
   plus one ask box.
4. **Every question** — `N.M · <title>` with its score chip, the question id and
   its paste count/characters in small grey, the verbatim answer in a tinted box (self-rating grids expanded row by
   row), then `Grader: <why>` in small grey.
5. **Ask box** (yellow, bordered) under each question chosen for the interview:
   one concrete question in the interviewer's voice, and — in brackets — what a good
   answer contains, when that helps.

Then, in chat: the chosen questions **in test order**, each with its N.M number and
page, and a note on how pages pair up if printed double-sided.

## Steps

### 1. Pull the attempt, the grades and the question bank

Read the attempt through the read-only admin door named in {{values_file}} (it must
create no row, send no mail and start no clock). Save the full response — attempt,
review/grades, sections — to a private file; everything below reads that file, so a
later rebuild does not depend on a live token. Load the question bank for titles,
question types and self-rating rows.

### 2. Choose the questions (the judgement step — do not automate it away)

Candidates for an ask box, in priority order:

- answers where the candidate's **own words** show a judgement or safety gap (quote
  them — e.g. an accepted risk nobody owns, a plan with no stop condition);
- grader score ≤ 5 on a question that matters for the role;
- unanswered, or "I do not understand the question" → ask it again in person;
- skipped sections that contradict the CV (skill listed, section skipped);
- declared "no AI" while whole answers were pasted → ask how the answer was produced.

Skip strengths the interview does not need to re-test. Aim for 8–12 questions; mark
the two to push hardest.

### 2b. Place the candidate on the AI working-style spectrum (always)

How someone actually codes with AI is the question the test measures worst and the
interview settles best, so every brief carries it on page 1. The spectrum:

| profile                                     | what it sounds like                                                                                                                                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A · generates with AI, tests hard**       | delegates big blocks or whole files; explains HOW they verify — runs it, real data, edge cases, logs, breaks it on purpose, tests the AI did not write; reads closely only the risky parts; has used an agent harness |
| **B · uses AI, reviews every line**         | autocomplete or small snippets; "I read all of it before shipping"; never lets the tool touch whole files. Safe, slow                                                                                                 |
| **C · copy-paste, no net**                  | chat, paste, ships if it compiles; no word on verification                                                                                                                                                            |
| **D · does not use it / does not trust it** | little real use; generic or purely theoretical talk                                                                                                                                                                   |

Which profile the team prefers lives in {{values_file}}, not here; tint that row.

Gather the evidence before writing questions:

- the answer to the **"would you ship AI-written code you do not fully understand"**
  question (quote it verbatim) — and whether **that answer itself** was pasted;
- AI declared per section vs. pastes per section and per question (whole /
  substantial counts, characters, seconds between pastes);
- **repeated pastes into one code question** (e.g. 25 versions) — it may be the
  good pattern (iterating and running the code elsewhere), so it becomes a question,
  never a verdict;
- the AI-tools questions (which assistants, how many hours a day, agent harness,
  model differences) — if skipped, they go on page 1 to ask in person.

Then write the ladder, open to closed: (1) how did you do the test, what by hand,
what with which tool; (2) which assistant today, hours per day, ever an agent that
edits files and runs commands; (3) ★ walk me through the last AI-written code you
shipped — how you asked, what you checked, how you knew it worked; (4) ★ confront
their own answer to the ship question with a concrete case (400 generated lines, all
tests green, customer waiting — do you read every line?) — this is what separates A
from B; (5) if the AI writes the code AND the tests, how do you know the tests test
the right thing; (6) the repeated-paste question, if the pattern exists; (7) have you
seen one model clearly beat another. Quote any contradiction between their stated
principle and their telemetry: that tension is the most useful minute of the interview.

### 3. Build and look

Run the generator named in {{values_file}}. Render to PDF with headless Chrome
(`--no-pdf-header-footer`). Then **verify on the PDF, not the HTML**: every section
heading is the first heading of its page (`pdftotext -f N -l N`), the number of ask
boxes equals the number chosen, and one page with an ask box has been rendered to an
image and looked at.

### 4. Map questions to pages

Search each question id in the PDF page by page and report `N.M · page`. Page numbers
come from the PDF that will be printed, never from the HTML.

### 5. Print only when asked

Printing is a separate, explicit request. Use the saved queue from {{values_file}},
A4, double-sided long edge, and confirm the job left the queue.

## Constraints

- The brief contains the candidate's personal data: keep the PDF and the saved
  attempt in the private hiring folder; never attach them to chat channels.
- Quote the candidate verbatim; never paraphrase an answer into something sharper
  or softer than what they wrote.
- The grader never sees paste telemetry; the brief must show it, section by section.
- Candidates are named with name and surname everywhere.
- Never reveal to the candidate which AI working style the team prefers; the brief
  says so on page 1, because a leading question buys the answer you wanted to hear.

## Failures Overcome

- **Self-rating grid printed as "no answer"** — grid answers are stored per row as
  `<question_id>::<row>`, not under the question id. Expand them row by row.
- **Numbers stored as text** — elapsed seconds arrive as strings; convert before
  dividing.
- **Section continuity** — without an explicit page break per section, a skipped
  section collapses into the previous page and the interviewer loses the thread.
- **The interview is where scores get checked** — two candidates with the same grade
  can differ completely in authorship (typed vs. pasted); the brief must make that
  visible next to the score.
- **A stated AI principle can be pasted too** (2026-09-24) — a candidate answered
  "passing tests is not enough if I cannot explain the function", and that very
  answer arrived as one whole paste, like every other written answer. Always check the
  telemetry of the ship-AI-code answer itself before taking it as their practice.
- **A generator hard-wired to one candidate** — the first build fixed the attempt file,
  name and questions in code. Key them by attempt id (`generator <id>`) so the next
  candidate is a new entry, not an edit that destroys the previous brief.
