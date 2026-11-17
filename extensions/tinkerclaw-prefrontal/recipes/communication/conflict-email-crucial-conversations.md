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

- **Soft and short by default.** A heated instruction from the sender sets the substance, not the tone: keep the substance and soften the tone without being asked. Aim for about 200 words; a group thread does not read a long mail.
- **Never concede in writing.** Do not volunteer a fact that confirms the other side's accusation, even a true one. State the sender's position (for example, "there is no clear way to know the consumption") and stop. A conceded fact becomes evidence the other side can use later.

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
- A review or analysis turn ends with ONE default next step phrased as a yes/no question ("Do I put the proposed version in the Outlook thread?"), never an open choice between versions: a bare "continue" must map to exactly one action.
- When the sender supplies his own draft, it is the base: fix the language and add only what he names. A framework analysis of his draft is offered as notes; it never re-inserts names, contrasts, procedural defences or actions he left out on purpose, and it does not overrule his choice of figures (a percentage he picked stays).
- When the sender dictates the order of the blocks, the draft follows it one-to-one: no added opener, no extra paragraph, no reordering. Soften the tone by default in group conflict threads, and never concede in writing a point the other side raised.

- A heated first ask with a list of points gets a skeleton first: one line per block, in the sender's order, in chat. The full draft goes into the mail client only after he confirms the skeleton. Heat in the request is venting, so the skeleton is where tone and content get settled.
- Language fixes cover real errors only (spelling, a non-word, a wrong relative or a wrong preposition). A construction that is correct but unusual is his register: "X però és", a closing formula or a verb form he chose stays as he wrote it.
- In a family or board thread, responsibility can be placed through a list of roles instead of names ("whoever contracts the plan, whoever approves it…"). Everyone recognises the roles, and no single reader is accused, so nobody has to defend themselves. Offer this before naming people.

- A hint about someone else's performance is phrased as shared regret about the outcome ("it is a pity that in a month no satisfactory option was found"), never as a causal chain of dates and consequences that the reader can trace back to them. The facts can stay; the arrow pointing at a person goes.
- A purchase request in a conflict thread carries every component the sender required earlier in the thread (a second disk, a charger), each checked against the vendor spec for the exact model (slot count, form factor) before the draft goes in. A single-option request still lists all its parts.

## Safety Notes

- Personal/business overlap raises the cost of leakage. Keep private commentary and angry source text out of the external thread.
- Verify legal, contractual and policy claims from the live thread or source before presenting them as facts.

## Failures Overcome

- **2026-08-28 — anonymized AI/CV compliance thread:** the thread was initially answered as a generic operational disagreement. The effective version first affirmed the authority-sensitive recipient's concern for the implementer's judgment, then contrasted “not replacing the implementer” with “AI is already in use,” and finally gave the implementer one change: the automatic legal footnote.
- **2026-08-28 — shareability correction:** personal names, relationships and exclusions were initially hardcoded into this recipe. They now live only in `{{profile_file}}`; the recipe is portable logic.
- Fake warmth that exposes AI authorship and weakens the sender politically.
- Leading with correction before restoring safety, causing the recipient to defend status instead of hearing facts.
- Ending with “if you agree” when the message concerns an existing fact or mandatory consequence.
- **2026-11-09 — anonymized group billing thread:** the first draft carried the sender's heat at full strength and ran to about 400 words. The second draft was soft but volunteered the warning the other side had cited. Both were corrected. The accepted version is about 220 words, soft, and states only the sender's position on that point. A third round followed: the sender had dictated five blocks in order, and the draft opened with a paragraph he had not asked for. The constraint above now covers it.
- **2026-11-09 — same billing thread, review round:** the analysis ended by asking which of two versions to install. The sender's next message was a bare "continue"; the agent read it as the proposed version, and the action guard held the draft replacement as ambiguous. The constraint above now makes the analysis end on one default step.
- **2026-11-09 — same thread, fourth round:** the sender wrote his own version and asked for an analysis. The analysis was right on language, but the proposed rewrite named the responsible roles, added a procedural defence and an explicit contradiction, and swapped his percentage for a unit price. He rejected all of it and kept his draft plus one answer to the newest objection. The constraint above now covers it.
- **2026-11-09 — same thread, sent version:** the mail that went out was the sender's own text. It kept the fixes to real errors and the one sentence he had asked for. He undid the style "corrections" and dropped an added phrase that he had requested earlier. Responsibility stayed a list of roles with no names. Six rounds could have been about three: a skeleton first, then his draft as the base, then only errors fixed.
- **2026-11-10 — anonymized IT purchase thread:** the sender asked for one option and a hint that the price rise came from the IT side. The draft listed the dates and said the only option left "costs more", which read as an accusation. He asked for a softer line, framed as regret. The draft had also left out the extra 4 TB disk he had required earlier, because the slot count had not been checked. The vendor spec sheet showed two M.2 slots, so the disk went into the same request. The two constraints above now cover both cases.
