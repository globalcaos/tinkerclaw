---
schema: recipe/1.0
id: conflict-email-crucial-conversations
title: Conflict Email — Crucial Conversations
category: communication
summary: "Draft high-stakes emails to a configurable conflict circle using Crucial Conversations: separate facts from villain stories, protect mutual purpose and respect, contrast the feared change with the actual intent, then end with one explicit action."
triggers:
  [
    "conflict email",
    "difficult email",
    "sensitive family email",
    "email to my family",
    "email to my brother",
    "email to my father",
    "email to my mother",
    "IT conflict email",
    "vendor conflict email",
    "Crucial Conversations",
    "polite version of what I want to say",
  ]
effort: standard
tools: [read, exec, write, edit, browser]
composes: [outlook-email-reply]
children: []
params:
  profile_file:
    type: string
    default: "~/.openclaw/workspace/.agents/email-communication-profile.yaml"
    description: "Private per-user values: sender identity, included/excluded conflict targets, recipient aliases, profile paths, framework reference and delivery settings."
  recipient:
    type: string
    description: "Person, address, domain or organization receiving the email; resolved against profile_file before this recipe is applied."
---

## Goal

Turn the sender's unfiltered reaction into an honest, respectful and effective email without weakening the substance. Keep dialogue possible while making the fact, decision and next action unmistakable.

The recipe contains no personal target names. Resolve `{{recipient}}` against `{{profile_file}}`:

- a match in `conflict_policy.included_targets` activates the conflict-specific workflow and recipient rules;
- a match in `conflict_policy.excluded_targets` disables this recipe and falls back to an ordinary email workflow;
- an unknown recipient requires one sharp confirmation before conflict-specific assumptions are applied.

This separation is mandatory for sharing: workflow logic belongs here; people, relationships, exclusions and private profile paths belong in the user's values file.

## Source framework

If `framework.crucial_conversations_file` is present in `{{profile_file}}`, read it. Otherwise use the framework summarized below.

The governing sequence is:

- Start with Heart;
- Learn to Look;
- Make It Safe (Mutual Purpose + Mutual Respect, especially Contrast);
- Master My Stories;
- STATE My Path;
- Explore Others' Paths / ABC;
- Move to Action.

The framework is a reasoning scaffold, not vocabulary to paste into the email.

## When to Use

- Stakes are high, opinions differ and the sender is angry, contemptuous, defensive or tempted to “just tell them.”
- A recipient has interpreted information as a request for permission, a threat to authority, or a plan to replace someone's role.
- A configured family, colleague, vendor or IT disagreement needs a durable written answer.

Do not use for routine logistics, low-stakes acknowledgements, recipients listed under `excluded_targets`, or anyone outside the configured circle without confirmation.

## Steps

### 1. Retrieve the whole conflict, not the last provocation

**Tools:** read, exec
**Done when:** The complete email thread, recipient profiles and relevant sent-mail examples are loaded.

Read `{{profile_file}}`, resolve `{{recipient}}`, then read the conversation oldest-to-newest. Retrieve each recipient's configured profile and the sender's real sent replies to that person. Identify:

- the initiating fact or decision;
- what each person believes is being proposed;
- the valid concern inside their objection;
- the status, role or workflow they may feel is threatened;
- the sender's actual intended outcome;
- the one action needed after the clarification.

Do not draft from the sender's angry paraphrase alone. It is evidence of stakes and motive drift, not evidence about the recipients' exact words.

### 2. Start with Heart and remove the villain story

**Done when:** The private objective can be stated without “win,” “prove,” “obey” or a character label.

Ask privately:

- What does the sender want for the result?
- What do they want for the other person and the working relationship?
- How would he write if he wanted both honesty and cooperation?

Retrace Facts → Story → Feeling → Action. Strip labels such as stupid, lazy, controlling or obstructive. Keep the observable behavior and operational consequence.

Do not convert anger into fake warmth. Read the sender's sent-mail style from `{{profile_file}}` and live sent examples; use respect tied to useful action, not invented intimacy or moral praise.

### 3. Build safety before correction

**Done when:** The first substantive paragraph protects the recipient's legitimate concern, role or status.

Use **ABC**:

- **Agree** with the valid part of their concern.
- **Build** by adding the fact or distinction they missed.
- **Compare** views instead of declaring them wrong.

For defensive or authority-sensitive recipients, lead with what remains true and unchanged. Give credit only to the useful action or valid concern:

- “Your point about preserving the responsible person's judgment is correct…”
- not sincerity claims, invented good intentions, or character praise the sender does not believe.

### 4. Contrast the feared change with the actual fact

**Done when:** One explicit don't/do contrast resolves the central misunderstanding.

Use the Crucial Conversations Contrast pattern:

> I am **not** proposing X, the feared replacement/loss of authority.  
> The relevant fact is Y, and this message concerns Z.

Put facts in chronological order. Distinguish clearly among:

- something already happening;
- a decision still open;
- a consequence required by law/policy/fact;
- the narrow implementation action.

Do not ask permission for a fact that already exists or a compliance action already required. Avoid “si us sembla bé” when it falsely reopens the decision.

### 5. Address people in the order needed for safety and action

**Done when:** Each recipient sees their concern or responsibility handled explicitly.

Default order for multi-recipient conflict mail:

1. the highest-status or most defensive person — validate and correct the frame;
2. the implementer — state what remains unchanged and give the narrow action;
3. everyone — state the shared outcome.

Use the recipients' preferred names and the sender's natural conjunction from `{{profile_file}}` and sent-mail examples, not a comma-separated roster that reads like generated mail.

Apply any recipient-specific rules from the matched `included_targets` entry. Never encode those names or rules back into this shareable recipe.

### 6. STATE the path briefly

**Done when:** Facts, interpretation and action are distinguishable.

Apply STATE:

- **Share facts:** least controversial observable facts first.
- **Tell the conclusion:** one plain paragraph.
- **Ask/encourage testing:** only when a real factual or decision uncertainty remains.
- **Talk tentatively:** soften interpretations, never settled facts.

If the message's purpose is clarification plus implementation, four to six short paragraphs usually beat a legal memorandum. Include legal detail only to establish the operative distinction.

### 7. Move to one concrete action

**Done when:** Owner, change and completion condition are explicit.

End with who does what. If useful, state what does **not** change. A robust generic shape is:

> “Your procedure remains exactly the same. The only change is…”

Then give one implementation instruction. Avoid a bouquet of recommendations, rhetorical closers or assigning moral homework.

### 8. Install through the Outlook reply recipe

**Tools:** exec, browser
**Done when:** The correct thread contains an unsent, signature-safe, rendered draft.

Follow `outlook-email-reply` for recipients, reply anchor, HTML structure, signature/CID preservation and visual verification. Content quality and Outlook integrity are separate gates; both must pass.

## Constraints

- Honest **and** respectful; never polite at the cost of ambiguity.
- No fake intimacy, moral praise or personality claims.
- No labels, sarcasm or diagnostic language about the recipient.
- Never apply conflict assumptions to a recipient listed under `excluded_targets`.
- Never send; draft for the configured sender's review.

## Safety Notes

- Personal/business overlap raises the cost of leakage. Keep private commentary and angry source text out of the external thread.
- Verify legal, contractual and policy claims from the live thread or source before presenting them as facts.

## Failures Overcome

- **2026-08-28 — anonymized AI/CV compliance thread:** the thread was initially answered as a generic operational disagreement. The effective version first affirmed the authority-sensitive recipient's concern for the implementer's judgment, then contrasted “not replacing the implementer” with “AI is already in use,” and finally gave the implementer one change: the automatic legal footnote.
- **2026-08-28 — shareability correction:** personal names, relationships and exclusions were initially hardcoded into this recipe. They now live only in `{{profile_file}}`; the recipe is portable logic.
- Fake warmth that exposes AI authorship and weakens the sender politically.
- Leading with correction before restoring safety, causing the recipient to defend status instead of hearing facts.
- Ending with “if you agree” when the message concerns an existing fact or mandatory consequence.
