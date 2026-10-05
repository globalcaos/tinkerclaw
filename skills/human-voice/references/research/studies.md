# What the research (and the crowd) says about catching AI text — and about reading tone from a conversation

**Research unit, 2026-09-25.** Sweep of 2025–2026 studies plus ~6,200 Hacker News comments pulled from the Algolia API (Jan 2025 → Sep 2026) and Reddit threads reached through search-engine snapshots (reddit.com blocks direct fetch from here).

**What this is FOR:** helping an assistant _write_ text that reads as a person wrote it, for real readers. Not detector evasion — the useful finding throughout is that the reliable tells are things that make writing _worse_ (aimlessness, uniform rhythm, structure nobody asked for, hollow warmth), so removing them is a quality move, not a camouflage move.

**How it was DERIVED:** peer-reviewed and preprint studies dated 2025–2026; one large measured corpus study (Graphite, Sep 2026, 100k articles); one taxonomy of crowd behaviour (Yeung et al., AIES 2026, 222,060 comments); and first-person accounts from people who actually caught something, quoted verbatim with dates.

**What would CHANGE it:** tells move with model generations — the Graphite corpus shows only 45% overlap between two consecutive GPT versions' tells. Anything below dated after mid-2026 should be re-checked in ~6 months. The _structural_ findings (§1.7–1.10, §1.16) are the ones that have survived a model generation so far.

**Explicitly excluded as already covered:** Wikipedia "Signs of AI writing", Russell et al. ACL 2025, Kobak excess vocabulary, Reinhart PNAS 2025, The Economist Jul 2026, blader/humanizer, vale-ai-tells, delve/tapestry/testament, the em-dash debate, "not X but Y", rule of three, "I hope this email finds you well". Where one of these reappears below it is because **new 2026 evidence changed its status** — and that is stated.

---

## 1. New tells

Strength key: **STRONG** = people catch it on one sighting, low false-positive risk. **MODERATE** = real signal, needs a second cue. **WEAK** = high false-positive risk; humans do this too, and accusing on it alone misfires.

### 1.1 The leftover assistant turn

**STRONG** · 2025-07-19 · [HN 44617497](https://news.ycombinator.com/item?id=44617497)

The single most conclusive tell in the corpus: the model's own closing offer, pasted through.

Real examples:

- `"Would you like me to format this for Outlook or help you post it to a specific channel or distribution list?"` — at the bottom of a work email, quoted by SoftTalker
- `"Here's the revised version:"` left above the text
- A reply that restates the request back and ends `"Would you like me to [the thing you just asked for]?"` — JimDabell, [HN 47433473](https://news.ycombinator.com/item?id=47433473), 2026-03-19

Why people notice it: it is not a _style_ cue at all, it is a provenance artifact. SoftTalker: _"Even worse when they accidently leave in the dialog with the AI. Dead giveaway."_ No false positives exist — a human does not spontaneously offer to reformat their own email for Outlook.

### 1.2 Bolded lead-in on every bullet

**STRONG in messaging/email, MODERATE in docs** · 2026-04-09 → 2026-08-07

The `**Term:** explanation` list shape, every item, no exceptions.

Real examples:

- `"- The bullet points with a bolded gist, a colon, and then elaboration (and bonus with details stats)."` — runjake describing what flagged a post, [HN 49211774](https://news.ycombinator.com/item?id=49211774), 2026-08-07
- `"When I see long lists of bullet points with interspersed bold text, I know that it is something the sender did not write or bother reviewing."` — bragh, [HN 48792787](https://news.ycombinator.com/item?id=48792787), 2026-07-05
- `"Every bullet point or list item starts with a bolded phrase or sentence… Almost nobody formats lists this way when writing by hand."` — quoted and _disputed_ by andrewshadura, [HN 47710059](https://news.ycombinator.com/item?id=47710059), 2026-04-09

Why people notice it: it is a formatting habit almost nobody has by hand but every chat model has by default. Note the dispute — andrewshadura's reply is just _"That's bullshit. It's very common."_ That is the false-positive edge: technical writers do use it. It is STRONG where the channel doesn't normally carry markdown (a text message, a WhatsApp reply, an email to one person) and weaker in a README.

### 1.3 Random mid-paragraph bolding — now rated above the em dash

**STRONG** · 2025-12-25 · [HN 46385404](https://news.ycombinator.com/item?id=46385404)

alexanderchr: _"Yes this reads like vacuous AI slop and and the \*\*randomly bolded\*\* text everywhere is a **dead giveaway**. At this point it's becoming a stronger signal than em-dashes."_

Corroborated by stlwtt on the visual side: _"formatting vomit with italics/bolding every other word"_ ([HN 49568370](https://news.ycombinator.com/item?id=49568370), 2026-09-04).

Why people notice it: emphasis is supposed to be scarce. Bolding every third phrase means nothing was emphasised, and readers feel the absence of a decision behind it.

### 1.4 Emoji as bullet points and as table-cell status markers

**STRONG** · 2025-10-13 → 2026-04-25

Real examples:

- `"The emojis at the start of each row in the table are also a dead giveaway. What's up with the green checks, red Xs, rockets, and other stupid emoji in AI slop?"` — username223, [HN 45564142](https://news.ycombinator.com/item?id=45564142), 2025-10-13
- `"It's actually really poor formatting to use some arbitrary emoji as a pseudo bullet point. Not only is it usually a dead giveaway for AI, it's just trash formatting anyway"` — r/ChatGPT, 2026-04-25 ([thread](https://www.reddit.com/r/ChatGPT/comments/1sv6abc/all_my_posts_get_accused_of_being_ai_and_i_am/))
- `"The emojis used in the bullet points (which are missing from your original text, but were added in at some point) are also dead giveaways that AI was involved here."` — cobolcomesback, [HN 48222466](https://news.ycombinator.com/item?id=48222466), 2026-05-21

Note the second example: the person calling it out reaches for a _quality_ argument first and the AI argument second. The tell and the defect are the same thing.

### 1.5 The interrogative / cute section header

**STRONG** · 2026-05-04 · [HN 48008272](https://news.ycombinator.com/item?id=48008272)

planb: _"'Why Does This Matter?' was a dead giveaway that this article was not written by a human — it was written by a large language model."_

Also: _"I mean, the cute section titles are a dead giveaway."_ — fckgw, [HN 46446906](https://news.ycombinator.com/item?id=46446906), 2025-12-31. And poisonborz on a hardware article, 2026-09-24: _"not only attention grabbing section titles (xy is the biggest downfall), but the A-B structured subtitles"_ ([HN 49834492](https://news.ycombinator.com/item?id=49834492)).

Why people notice it: the header asks a question the reader did not ask, then answers it. It is the structure of a model filling a section, not a writer organising an argument.

### 1.6 The conclusion nobody requested

**STRONG** · 2025-04-10 · [HN 43642898](https://news.ycombinator.com/item?id=43642898)

loloquwowndueo: _"Dead giveaway? The 'conclusion' section - no human writes like that unless they're doing a high school essay, and most AI slop out there has that predictable structure with an often unnecessary conclusions section. AI just can't tell the difference or whether it's actually needed."_

Note the method: they checked the author's _other_ posts and found none of them had a conclusion. That is baseline comparison (§1.16) doing the real work.

A_D_E_P_T on the same habit, 2025-08-24: _"(It could hardly ever resist ending its responses with a summary paragraph.)"_ ([HN 45004425](https://news.ycombinator.com/item?id=45004425)).

### 1.7 Uniform sentence rhythm — the tell that survives a word-level rewrite

**STRONG (as a felt cue), hard to name** · 2026-07-26 → 2026-09-08

Real examples:

- _"I made a list of AI tells and banned all of them. my writing still sounded like AI… The tell underneath, for me, was rhythm. My AI-assisted draft was averaging about fifty words a sentence, some over two hundred, every one evenly built."_ — r/WritingWithAI, [2026-07-26](https://www.reddit.com/r/WritingWithAI/comments/1v7dtak/i_made_a_list_of_ai_tells_and_banned_all_of_them/)
- _"the metaphors are unenlightening, the rhythm is exhaustingly uniform."_ — wiml, [HN 49615852](https://news.ycombinator.com/item?id=49615852), 2026-09-08
- _"rewrite that because LLMs have absolutely no sense for word rhythm."_ — seanmcdirmid, [HN 49622220](https://news.ycombinator.com/item?id=49622220), 2026-09-09
- _"it dodges delve and lands on a synonym that reads just as flat, because the tell was the rhythm and not the word."_ — r/PromptEngineering, ~2026-09-04

Why it matters more than any word list: this is the direct evidence that **banning vocabulary does not work**. The same commenter who banned every word on their list still read as a model. Actionable test given in the wild: _"Read a paragraph and mark the length of each sentence in words"_ (textpulse.ai, Aug 2026).

### 1.8 Aimlessness — sentences that are well-formed and do no work

**STRONG once seen, MODERATE to name** · 2026-05-29 · [r/technology](https://www.reddit.com/r/technology/comments/1trjb19/the_biggest_tell_that_something_was_written_by_ai/)

The most-quoted formulation of 2026, from the thread on The Atlantic's _The Biggest Tell That Something Was Written by AI_:

> _"Yes, the aimlessness is the tell for me. It's a moment I'm coming to recognise more and more. It looks like a polished text until you read it at the sentence level and you realise how many sentences, phrases and metaphors actually have no purpose."_

And upstream in the same thread: _"An articulate, concise sentence usually indicates to me that a human with a goal wrote it. Most AI is aimless in its tone."_

The Atlantic's own argument (Hua Hsu / tech desk, 2026-05-29) is that there is no single tell: _"every part of the text is not quite right"_ — _"The tone is bland; individual word choices are baffling; the structure lacks sense; key pieces of the argument are missing; facts are false."_ The cue is **simultaneity**, not any one item.

### 1.9 Missing connective tissue — depth, not pattern

**MODERATE** · 2025-11-17 · [HN 45959365](https://news.ycombinator.com/item?id=45959365)

codingdave, arguing against the whole pattern-hunting approach:

> _"The 'dead giveaways' are not writing patterns, it is depth. AI will stay at a surface level when using argumentative writing patterns, whereas humans will add supporting information and connect the dots across sentences and paragraphs. It is the lack of connective language between thoughts and phrases that flag an AI."_

wiml (2026-09-08) reaches the same place from the other direction: _"LLMs are good at a lot of the surface indicators of good writing… But they're terrible at organizing the text and marshalling a concept to get it across to a specific audience. The section and paragraph breaks are meaningless."_

Why this is the most useful tell for a writer: it is the only one you fix by _thinking harder_, not by editing.

### 1.10 Narrative structure — the plot fingerprint (StoryScope)

**STRONG, and survives style-stripping** · 2026-04-03, rev. 2026-08-10 · [arXiv 2604.03136](https://arxiv.org/abs/2604.03136)

Russell, Rajendhran, Pham, Iyyer & Wieting fed ~61,000 stories (10,272 prompts × human + Claude, GPT, Gemini, DeepSeek, Kimi) to a classifier that was given **only narrative-structure features — no word choice, no punctuation, no rhythm**.

- Human vs AI: **93.2% macro-F1** from structure alone
- Six-way model attribution: **68.4% macro-F1**
- Narrative features retained **"over 97% of the performance"** when stylistic cues were excluded

What structurally marks AI fiction: **over-explained themes, single-track tidy plots, reduced temporal complexity, protagonist choices that are not morally ambiguous.** Per-model: **Claude** — flat event escalation; **GPT** — over-indexes on dream sequences; **Gemini** — defaults to external character description.

Why this is the most important entry in this list: it means the tells are not on the surface at all. You cannot edit them out at the sentence level. A reader who says _"I can't point to it but I can tell"_ may be reading structure.

### 1.11 Dialectical hedging — the 2026 descendant of "not X but Y"

**MODERATE** · 2025-08-07 · [HN 44819566](https://news.ycombinator.com/item?id=44819566)

llamasushi, on one line in a Node.js article: _"Yeah, this one line gave it away for me: 'you're not just writing contemporary code—you're building applications that are more maintainable…' Look up dialectical hedging. Dead AI giveaway."_

The family has mutated. The 2026 measured successors, from 80,141 humanization pairs (WriteHuman, 2026-04-21):

- **"rather than"** — 17,251 occurrences in AI input vs 6,859 in humanized output (G² = 5,939.78), the single strongest phrase tell
- **"ensuring"** — 7,325 vs 1,703 (G² = 3,808.58), strongest single word
- **"highlights"**, **"supports"**, **"rather"** next
- Template: **"X plays a crucial/critical/important role in shaping Y"** dominates the trigram rankings

And from the Graphite corpus (Sep 2026): Claude Opus 5's rising signature is **"less like a **_ and more like _**"** at 105× the rate of GPT-6 Astra.

### 1.12 The adverb that appears four times

**MODERATE** · 2026-06-17 · [HN 48570209](https://news.ycombinator.com/item?id=48570209)

mdrzn annotating a blog post live:

> _"'It has run quietly for years' overuse of quietly … 'the system quietly pays out far less' overuse of quietly"_

Why people notice it: a human writer hears the repetition on re-read and changes it. The repeat is evidence that **nobody re-read the text**, which is the actual accusation being made in most of these threads.

### 1.13 The vaguely-positive adjective that doesn't fit

**MODERATE** · 2025-11-13 · [HN 45919351](https://news.ycombinator.com/item?id=45919351)

burkaman, doing the most granular public teardown in the corpus:

> _"> indefatigable — This adjective does not make sense in this context, but it's the sort of vaguely positive and smart-sounding word that LLMs like to use."_
> _"> (what?!) — This is a classic LLM-style exclamation trying to create an emotional reaction where it doesn't really make sense."_
> _"> autonmous — This is actually surprising, LLMs don't make typos like this."_

Three distinct cues in one comment, including the inverse: **a typo is evidence of a human.**

### 1.14 Forced levity

**MODERATE** · 2026-03-08 · [HN 47302096](https://news.ycombinator.com/item?id=47302096)

wolvoleo's five-item list of what _"really screams ChatGPT"_:

> _"- Overly positive commentary and encouragement - Constant use of bullet point lists, bolding and emoji - This quaint forced 'funniness', like a misplaced attempt at being lighthearted - A lot of blablah that just missed the point - Not concise and to the point, but also not super long"_

burkaman names the same thing precisely: _"the microwave burrito of content creation—technically food, requires minimal effort, and you feel vaguely ashamed afterward. Hard to explain, but this is the kind of bland but mildly amusing joke that LLMs come up with."_

That last one is the sharpest observation about humour in the whole corpus: the joke _works_, it is just the joke a model would make.

### 1.15 Over-validation — warmth with nothing inside it

**STRONG in interpersonal messaging** · 2026-04-24 → 2026-06-05

Real examples, all from people reading messages from someone they know:

- _"They are over the top and have the over-validating yet fundamentally hollow feel of AI."_ — r/isthisAI, [2026-04-24](https://www.reddit.com/r/isthisAI/comments/1su5690/is_this_guy_texting_me_ai_here_are_some_excerpts/)
- _"it feels placating and not like the way she speaks"_ — r/isthisAI thread title, [2026-06-05](https://www.reddit.com/r/isthisAI/comments/1tx1wu5/did_a_friend_use_ai_to_write_this_text_response/)
- _"AI or not, that's just bullshittting and sentence after sentence of empty words."_ — same thread
- _"That reads to me like Zoltar the fortune teller staring off into the middle distance reciting a script. I.e. extremely impersonal and painfully generic."_ — r/Productivitycafe, [2026-02-25](https://www.reddit.com/r/Productivitycafe/comments/1ret6bf/why_is_ai_generated_text_so_irritating/)

The offered test in that last thread is the best heuristic anywhere in this document: _"Treat it like it's a real message and stop when you would normally groan."_

### 1.16 Baseline violation — the tell that needs no tells

**STRONGEST cue in interpersonal channels** · 2026-02-27 → 2026-05-29

This is what actually catches AI in messages between people who know each other. Not a feature of the text — a _delta_ from the sender's own history.

Real examples:

- _"he never texts like this ever and it just genuinely sounds like ai"_ — r/isthisAI thread title, [2026-02-27](https://www.reddit.com/r/isthisAI/comments/1rfxfmq/does_this_sound_like_ai_text_a_guy_sent_me_this/)
- _"She is 1000% using ChatGPT… Also, the significant difference in texting once you called her out and how her sentences began with lowercase letters"_ — r/AmIOverreacting, [2026-03-19](https://www.reddit.com/r/AmIOverreacting/comments/1rxmp16/aio_for_thinking_my_friend_is_using_chatgpt_to/) — the register **snapped back** the moment they were confronted
- A professor: _"he was writing at an 8th grade level in class. His out-of-class papers tested as written at first year college level. The difference is too radical… This is why some profs insist they can spot AI. It's a comparative thing."_ — r/Professors, [2026-03-03](https://www.reddit.com/r/Professors/comments/1rjl5u0/students_are_deliberately_writing_worse_to_avoid/)
- The Atlantic (2026-05-29) reports a mechanic whose texting style _"suddenly shifted to match the voice of an AI-generated accident report."_

Why this is the one that matters for writing: **it is not about what the text contains, it is about the distance from what this person, in this thread, normally sends.** Every §4 recommendation below follows from it.

### 1.17 Typographic perfection in a thumb-typed channel

**STRONG in SMS/WhatsApp, irrelevant elsewhere** · 2026-02-27 → 2026-05-20

- _"If this is a text, it is definitely AI. Who the fuck writes this much on their phone and there is 0 spelling errors, no autocorrect fuck ups, and all this punctuation."_ — r/isthisAI, 2026-02-27
- _"Look at the typographically correct quotation marks in his second message, with one pointing down and one up. You can't type those on a phone or computer keyboard."_ — r/isthisAI, [2026-05-20](https://www.reddit.com/r/isthisAI/comments/1ti7owh/am_i_wrong_for_thinking_hes_flirting_by_using/)
- Paired with §1.16 in the Yeung corpus: _"It's not just misspelling but the em dash, and the kerning. A human didn't write that"_ (User 74675)

Caveat this is channel-bound. On a laptop, curly quotes are just a text editor. The tell is **effortlessness that the channel makes impossible** — length plus cleanliness plus punctuation, together, on a phone.

### 1.18 The inverted tells — what measured human writing does that models don't

**Measured, Sep 2026** · [Graphite, _AI Tells_](https://graphite.io/five-percent/research/ai-tells)

Graphite built 10,000 pre-Nov-2022 human articles from Common Crawl against 90,000 AI articles (10,000 each from GPT-4.1, GPT-5, GPT-5.6 Sol, GPT-6 Astra, Claude Opus 4 / 4.6 / 5, Gemini 2.5 Pro, Gemini 3.1 Pro), matched topic-for-topic across 9,984 topics. **12,877 unique tells; 65% unique to a single model family.**

The findings most useful to a writer are the _human_ markers, because they are what to put back in:

| Human marker             | Finding                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| **Exclamation marks**    | **100+ times more frequent in human writing than in any AI model** |
| **Parenthetical asides** | substantially more frequent in humans                              |
| **First person plural**  | "we all know", "we're going to"                                    |
| **Direct address**       | "you can't", "did you know"                                        |

And the em dash has **inverted**: GPT-6 Astra uses em dashes **88% below the human rate**; Gemini 3.1 has nearly eliminated them; Claude Opus 5 has come back up _to_ roughly the human rate. In 2026, an em dash is weak evidence in either direction and its absence is not evidence of a human.

### 1.19 Model-specific fingerprints (2026)

**MODERATE, decays fast** · Sep 2026 Graphite + Apr 2026 StoryScope + crowd

- **GPT-6 Astra:** "dependable" (59× human), "practical" (26×), "another dimension" (117×), "rather than relying" (187×)
- **Claude Opus 5:** "deliberately" (26×), "every single" (112× vs Astra), "less like a \_\_\_ and more like" (105×); mannered prose **rose 19%** from Opus 4 → Opus 5
- **Gemini 3.1 Pro:** "incredibly" (18× human), "absolutely", "furthermore" (43× human; absent from Astra); contractions nearly gone
- **Gemini, from the crowd:** _"Gemini frequently titles sections in a way that mimics the way humans would but in a way that is uncanny… It makes odd decisions as to what words to put into quotation marks and tends to title it like it's introducing a slideshow."_ — r/AskReddit, [2026-03-04](https://www.reddit.com/r/AskReddit/comments/1rkdsaf/what_are_the_most_obvious_signs_of_ai_writing/)

Graphite's conclusion: _"Tells shift between model versions, but they do not go away."_ Well-known tells declined 41–86%, yet only Claude's word distribution actually moved _toward_ human writing — GPT and Gemini diverged **more** while suppressing the famous tells. Suppressing a tell creates a new one.

### 1.20 Structure inflation relative to the channel

**MODERATE-STRONG, underrated** · derived across the corpus

A pattern visible across dozens of comments but rarely named: the text carries _more structure than its channel warrants_. Headers in a Reddit comment. Bullets in a text message. A three-part argument in a two-line answer. A r/NoStupidQuestions explanation of exactly this ([2026-06-29](https://www.reddit.com/r/NoStupidQuestions/comments/1uirpwo/what_makes_aigenerated_text_noticeable/)):

> _"most people who want to, say, generate a Reddit post via AI are just telling it to write about a certain topic, and the AI thinks, 'Oh, this user wants a magazine article.' You're not used to seeing that style of writing on Reddit, so it reads AI to you."_

Corroborated by the Slop-or-Not dataset (16k human posts from Reddit / HN / Yelp vs six models, [Show HN 47357745](https://news.ycombinator.com/item?id=47357745), 2026-03-15): **Reddit posts were easier to identify as AI; Hacker News content was "significantly harder."** HN's native human register already sits closer to model register — so the mismatch is smaller and the tell is quieter. **The tell is the gap between the model's default register and the venue's, not the model's register itself.**

---

## 2. What people said

Verbatim, with source and date.

1. _"Yes, the aimlessness is the tell for me. It's a moment I'm coming to recognise more and more. It looks like a polished text until you read it at the sentence level and you realise how many sentences, phrases and metaphors actually have no purpose."_ — r/technology, [2026-05-29](https://www.reddit.com/r/technology/comments/1trjb19/the_biggest_tell_that_something_was_written_by_ai/)

2. _"Honestly, I can't point out some specific giveaway, but if you've interacted with LLMs enough you can simply tell. It's kinda like recognizing someones voice… I've heard the exact same argument/paragraph structure and sentence structure many times with different words swapped in."_ — scratchyone, [HN 46700387](https://news.ycombinator.com/item?id=46700387), 2026-01-21

3. _"The 'dead giveaways' are not writing patterns, it is depth… It is the lack of connective language between thoughts and phrases that flag an AI."_ — codingdave, [HN 45959365](https://news.ycombinator.com/item?id=45959365), 2025-11-17

4. _"I made a list of AI tells and banned all of them. my writing still sounded like AI… The tell underneath, for me, was rhythm. My AI-assisted draft was averaging about fifty words a sentence, some over two hundred, every one evenly built."_ — r/WritingWithAI, [2026-07-26](https://www.reddit.com/r/WritingWithAI/comments/1v7dtak/i_made_a_list_of_ai_tells_and_banned_all_of_them/)

5. _"it dodges delve and lands on a synonym that reads just as flat, because the tell was the rhythm and not the word."_ — r/PromptEngineering, [~2026-09](https://www.reddit.com/r/PromptEngineering/comments/1w7xzjw/i_turned_wikipedias_signs_of_ai_writing_into_an/)

6. _"Even worse when they accidently leave in the dialog with the AI. Dead giveaway. I got an email from a colleague the other day and at the bottom was this line: 'Would you like me to format this for Outlook or help you post it to a specific channel or distribution list?'"_ — SoftTalker, [HN 44617497](https://news.ycombinator.com/item?id=44617497), 2025-07-19

7. _"Yes this reads like vacuous AI slop and and the \*\*randomly bolded\*\* text everywhere is a dead giveaway. At this point it's becoming a stronger signal than em-dashes."_ — alexanderchr, [HN 46385404](https://news.ycombinator.com/item?id=46385404), 2025-12-25

8. _"Dead giveaway? The 'conclusion' section - no human writes like that unless they're doing a high school essay… I even went through some other articles in this same blog to see if it was just this article… Others don't have a conclusion, this AI-assisted one is the first one with that structure."_ — loloquwowndueo, [HN 43642898](https://news.ycombinator.com/item?id=43642898), 2025-04-10

9. _"> indefatigable — This adjective does not make sense in this context, but it's the sort of vaguely positive and smart-sounding word that LLMs like to use. … > autonmous — This is actually surprising, LLMs don't make typos like this."_ — burkaman, [HN 45919351](https://news.ycombinator.com/item?id=45919351), 2025-11-13

10. _"Overly positive commentary and encouragement… This quaint forced 'funniness', like a misplaced attempt at being lighthearted… Then that really screams ChatGPT to me."_ — wolvoleo, [HN 47302096](https://news.ycombinator.com/item?id=47302096), 2026-03-08

11. _"'Why Does This Matter?' was a dead giveaway that this article was not written by a human"_ — planb, [HN 48008272](https://news.ycombinator.com/item?id=48008272), 2026-05-04

12. _"When I see long lists of bullet points with interspersed bold text, I know that it is something the sender did not write or bother reviewing."_ — bragh, [HN 48792787](https://news.ycombinator.com/item?id=48792787), 2026-07-05

13. _"The emojis at the start of each row in the table are also a dead giveaway. What's up with the green checks, red Xs, rockets, and other stupid emoji in AI slop?"_ — username223, [HN 45564142](https://news.ycombinator.com/item?id=45564142), 2025-10-13

14. _"Truth is, there are no longer any dead giveaways, let alone any where you can really catch an AI red-handed… I don't think I've seen 'delve' in more than a year!"_ — A_D_E_P_T, [HN 45004425](https://news.ycombinator.com/item?id=45004425), 2025-08-24

15. _"The only people who think em dashes are a dead giveaway for AI are people who don't know how to write and whose grammar is too poor to use them properly."_ — psunavy03, [HN 44115722](https://news.ycombinator.com/item?id=44115722), 2025-05-28

16. _"It's not just misspelling but the em dash, and the kerning. A human didn't write that"_ — User 74675, quoted in Yeung et al., [AIES 2026](https://arxiv.org/abs/2606.22689)

17. _"…you're also making it harder for real artists. Some of you are convincing people that \*actual\* artistic quirks, mistakes, and techniques are 'obvious' AI."_ — User 63442, same paper

18. _"If this is a text, it is definitely AI. Who the fuck writes this much on their phone and there is 0 spelling errors, no autocorrect fuck ups, and all this punctuation."_ — r/isthisAI, [2026-02-27](https://www.reddit.com/r/isthisAI/comments/1rfxfmq/does_this_sound_like_ai_text_a_guy_sent_me_this/)

19. _"They are over the top and have the over-validating yet fundamentally hollow feel of AI."_ — r/isthisAI, [2026-04-24](https://www.reddit.com/r/isthisAI/comments/1su5690/is_this_guy_texting_me_ai_here_are_some_excerpts/)

20. _"It sounds like he hit too many personal notes to have just copy-pasted from a bot. The way they tie into your connection with music especially."_ — r/isthisAI, [2026-03-06](https://www.reddit.com/r/isthisAI/comments/1rmbmoo/is_this_ai_friend_responds_like_this_to_casual/) — **the acquittal cue: specific shared history**

21. _"That reads to me like Zoltar the fortune teller staring off into the middle distance reciting a script. I.e. extremely impersonal and painfully generic."_ — r/Productivitycafe, [2026-02-25](https://www.reddit.com/r/Productivitycafe/comments/1ret6bf/why_is_ai_generated_text_so_irritating/)

22. _"It's the banality of it all, and the fact that there are very few concrete details provided. AI tends to be terrible storytellers… The story is generic and cliche. Every emotion is overwrought."_ — r/CasualConversation, [2026-01-06](https://www.reddit.com/r/CasualConversation/comments/1q599t2/how_does_everyone_seem_to_know_what_writing_is/)

23. _"It's the lack of any emotion behind the story. One of the things that used to be fun about AITA is how posters couldn't truly hide their real feelings."_ — r/AmITheAngel, [2025-12-30](https://www.reddit.com/r/AmITheAngel/comments/1pz78cy/the_biggest_tell_that_a_story_is_ai/)

24. _"it reads clean and clear… but sometimes lacks the messy, specific, slightly imperfect voice that makes human writing feel real"_ — r/AskReddit, [2026-03-04](https://www.reddit.com/r/AskReddit/comments/1rkdsaf/what_are_the_most_obvious_signs_of_ai_writing/)

25. _"Its default is to write like a copy writer who aced persuasive writing in year 7 English."_ — r/isthisAI, [2026-03-15](https://www.reddit.com/r/isthisAI/comments/1rujwfk/how_do_i_know_if_a_text_is_ai_or_not_recently/)

26. _"I'm not that impressed by Fable's writing to be honest, still has the AI giveaways like em dash."_ — behnamoh, [HN 48800117](https://news.ycombinator.com/item?id=48800117), 2026-07-06

27. _"my AI-generated text radar pinged hard and I was caught in a moment of dissonance between the sleek design and the AI-cadenced copy."_ — yallpendantools, [HN 49809088](https://news.ycombinator.com/item?id=49809088), 2026-09-22

28. _"Pangram says 50% human. That seems to check out, heavily edited yet the LLM aha sentences and cadence are still definitely there… I read some Dostoevsky recently and I found my speech to be substantially altered for a while, so it makes sense that LLM writing would have an influence."_ — woolion, [HN 49640386](https://news.ycombinator.com/item?id=49640386), 2026-09-10

29. _"…like anything inspired by, not just completely generated by, AI is 'marked' in a way that I don't know can be eliminated. Like people will slowly do what they naturally do with language and start adopting AI-speak. Writing will have a certain structure and cadence to it henceforth."_ — r/literature, [2025-11-14](https://www.reddit.com/r/literature/comments/1ox7too/constant_exposure_to_aigenerated_writing_has/)

30. _"It is the most refreshing article I've read through the HN homepage lately. Not a single em-dash, no 'not X. Just Y', none of the other more subtle AI tells. I felt like reading the thoughts of an actual person, not reading an expanded version of a person's core idea."_ — sebastiennight, [HN 48781459](https://news.ycombinator.com/item?id=48781459), 2026-07-04

**"an expanded version of a person's core idea"** is, across this entire corpus, the best one-line description of what readers are actually detecting.

---

## 3. What is new since mid-2025

**Dead or dying.**

- _delve_ — A_D_E_P_T, Aug 2025: _"I don't think I've seen 'delve' in more than a year!"_
- The em dash as a positive signal. **Inverted** by Sep 2026 (Graphite): GPT-6 Astra is 88% _below_ the human rate; Gemini 3.1 nearly zero; Claude Opus 5 back at human rate. Its absence proves nothing; its presence in 2026 is weak evidence at best. The crowd hasn't caught up — people were still calling it in Sep 2026 — which makes it a **false-positive generator**.
- Marketing verbs (_unlock_, _streamline_, _supercharge_, _leverage_) — down 73% across GPT versions (Graphite).

**Risen or newly named (mid-2025 → Sep 2026).**

- **Random mid-paragraph bolding**, explicitly rated above the em dash (Dec 2025).
- **Bolded-lead-in bullets** and **emoji bullets** — the dominant 2026 format tells.
- **"rather than" / "ensuring" / "X plays a crucial role in shaping Y"** — the measured 2026 replacements for "not X but Y" (WriteHuman, Apr 2026).
- **"less like a **_ and more like _**"** — Claude Opus 5 specific, rising while its hype words decline (Graphite, Sep 2026).
- **Rhythm and cadence as _the_ named tell**, displacing vocabulary. This is the biggest shift in the corpus: the 2025 conversation was about words; the mid-2026 conversation is explicitly about sentence-length variance and structure, with people reporting that word-level bans did not help.
- **Narrative structure detection** (StoryScope, Apr 2026) — new capability, and new knowledge: structure carries 93.2% F1 with style stripped out.
- **The texting front opened.** r/isthisAI (411k subscribers by mid-2026) and r/RealOrAI barely existed for text-message judgement in early 2025; by 2026 people routinely post a friend's WhatsApp message asking whether a human wrote it. That moved the dominant cue from _style_ to **baseline deviation** (§1.16), which is a different kind of tell entirely.
- **"AI slop" went mainstream** — Macquarie Dictionary Word of the Year 2025 (both Committee's and People's Choice, only the fourth time they agreed), announced 2025-11-25.
- **Reciprocal contamination.** Max Planck Institute for Human Development (Yakura et al., 2025) tracked "GPT words" across 360,000 YouTube videos and 771,000 podcast episodes and found a surge in _spoken_ usage of _delve_, _realm_, _meticulous_ in the 18 months post-ChatGPT — including in spontaneous conversation. Sourati, Ziabari & Dehghani (Trends in Cognitive Sciences, Mar 2026; [arXiv 2508.01491](https://arxiv.org/abs/2508.01491)) frame this as cognitive homogenisation: LLMs _"reflect and reinforce dominant styles while marginalizing alternative voices and reasoning strategies."_ Practical consequence: **every vocabulary-based tell has a rising human false-positive rate**, because humans are adopting the vocabulary.

**The accuracy picture is contested, and the contradiction is informative.**

- Cooke et al., CACM Oct 2025 ([As Good as a Coin Toss](https://dl.acm.org/doi/10.1145/3729417)), 1,276 participants: mean detection ≈ **50%, chance**.
- Russell et al. (already covered): expert LLM users, majority vote misclassified **1 of 300** articles.
- German theses study (Int. J. Educ. Integrity, 2025): humans **57%** on AI text, **64%** on human text — barely above chance.
- Yeung et al. (AIES, Aug 2026): in posts ultimately resolved as **not AI**, "AI Style" reasoning was **+318.8%** more common than in true-positive posts. **The style-cue strategy is the one most associated with being wrong.**

Reconciliation: detection accuracy is bimodal. Heavy LLM users reading _unedited_ output are near-perfect; the general population reading _edited_ output is at chance. Which means, for a writer: the audience that will catch you is small, expert, and catches you on **rhythm and structure** — not on the word list the general population argues about.

---

## 4. A practical method: deciding tone, familiarity and feeling from the conversation itself

**The problem this solves.** A personal fingerprint (how _I_ write) is not available when writing to someone new, writing on someone's behalf, or writing in a channel with no history. The literature above says the readers who catch you are reading **deviation from an expected register**, not vocabulary. So the register has to be derived from the conversation. This section is that procedure.

**The one principle underneath it.** Communication Accommodation Theory: people negotiate social distance by _converging_ on each other's speech patterns or _diverging_ from them. Language Style Matching — similarity in **function word** use — predicts liking and relationship development (Bierstetel et al., 2020; Niederhoffer & Pennebaker, 2002). **Convergence is read as warmth; divergence is read as distance, and it is read as distance whichever direction you diverge in.** Over-formality toward an intimate reads cold; under-formality toward a stranger reads careless. There is no neutral default — a "professional, helpful" register is itself a position on the ladder, and in a casual thread it is the _wrong_ one.

### 4.1 Read six things off the thread, in this order

**(1) The last inbound message's register — copy its mechanics, not its words.**
Extract and match: capitalisation (do they capitalise sentence-initial letters?), sentence-final punctuation (present or absent?), contractions, greeting present/absent, sign-off present/absent, emoji present/absent and which ones, slang, swearing. These are function-level features and they are what LSM actually measures. Concretely: _if they don't capitalise, don't capitalise._ A friend's register snapping back to lowercase the moment she was confronted (§1.16) is the clearest field evidence that people track exactly this.

**(2) The thread's median message length — and stay inside one order of magnitude of it.**
Length is the loudest single mismatch in interpersonal channels. _"Who the fuck writes this much on their phone"_ is a length judgement before it is anything else. If the thread's messages run 8–20 words, a 90-word reply is wrong regardless of how well written it is. If a long answer is genuinely needed, **offer it rather than dump it**: one short message that says what you found, and an offer of the detail.

**(3) Familiarity, on the evidence.** Place the relationship on the classic register ladder — frozen / formal / consultative / casual / intimate — using observable markers rather than assumption:

| Marker present                                                               | Reads as                                                  |
| ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| Greeting + sign-off, full sentences, title/surname                           | formal                                                    |
| No greeting, contractions, first names                                       | consultative → casual                                     |
| Nicknames, diminutives, in-jokes, shared referents, swearing, no punctuation | casual → intimate                                         |
| Apologising for a slow reply; asking a personal follow-up unprompted         | relationship is closer than the surface register suggests |

**Match the level; do not climb it.** Climbing (more intimate than earned) is the over-validation tell of §1.15. Descending (more formal than earned) is the _"reciting a script"_ tell of quote 21.

**(4) The stakes and the face-threat — separately from the warmth level.**
Is this bad news, a refusal, a correction, an apology, a request for a favour, or just information? Face-threatening acts require politeness _work_ — hedging, mitigation, an account — and that work is orthogonal to how close you are. A close friend delivering a refusal still hedges. Getting this wrong in either direction is what makes a message feel off: unhedged bad news to an intimate reads brutal; heavily hedged trivia reads evasive. Note from the disclosure study (Nakano et al., Jan 2026): **apologies and letters of encouragement are the two contexts where AI involvement is rejected most sharply** — 82 responses coded "inappropriate context", with _"I can't help but question whether it's truly sincere"_. High-stakes interpersonal writing is where the register has to be exactly right.

**(5) The feeling in the inbound — from mechanics and timing, not from content words.**

- **A sentence-final period on a short message reads as insincere or abrupt** — Gunraj et al. (_Computers in Human Behavior_, 2016) found this for texts and, crucially, **not** for the same messages handwritten. It is a channel-specific convention, not a fact about punctuation.
- **Exclamation marks function as sincerity markers, not intensity markers** — small overall effect on perceived warmth (~+3.7%), but for under-25s, senders using them were rated **22% more likable** and ~16% warmer (see §5). Note also §1.18: humans use them **100× more than any model**, so they are simultaneously a warmth signal and a human signal.
- **Emoji raise perceived warmth and lower perceived competence**, and the direction depends on formality of context (_Collabra: Psychology_). Reciprocated emoji raise warmth and playfulness on both sides (Cavalheiro et al., 2024). **So: mirror their emoji rate; do not introduce emoji into a thread that has none.**
- **Latency is a signal.** Faster replies read as closer; delay reads as dispreference — preferred responses are sent quickly, dispreferred ones delayed (Rendle-Short, 2015). What sets tolerance is the partner's _prior_ responsiveness, not closeness (Chen et al., _Computers in Human Behavior_, 2025). If you are slower than your own baseline in this thread, acknowledge it in three words; if you are answering instantly to something that deserved thought, the speed itself will read as not having thought.

**(6) Language choice, in bilingual threads.**
Code-switching carries solidarity, intimacy and group identity, not just lexical convenience (Wen & Zhang, _Code-switching and identity construction in WhatsApp_). **Reply in the language they used in the last message**, not the language of the underlying documents or the topic. A switch is itself a message — it can mark a topic boundary, a shift to seriousness, or a bid for closeness — so switch only when you mean one of those.

### 4.2 Then write, then subtract

Draft freely. The value is in the subtraction pass, done in this order:

1. **Delete the closing offer.** No "let me know if you'd like…", no "would you like me to…". (§1.1)
2. **Delete the summary/conclusion** unless the reader asked for one. (§1.6)
3. **Delete structure the channel did not ask for** — headers, bullets, bolding — down to what the last inbound message carried. (§1.2, §1.20)
4. **Kill the third item** in any group of three that exists only because three felt right. Groups of three are fine; _frequency_ is the tell.
5. **Cut every sentence you can remove without losing information.** This is the aimlessness pass (§1.8). The test is per-sentence: what does this one do?
6. **Break the rhythm.** Mark sentence lengths in words. If the variance is low, split one and run two together. Short. Then a long one. (§1.7)
7. **Check for a repeated adverb or adjective.** Fix it — the repeat is proof nobody re-read. (§1.12)
8. **Put one concrete, non-generic thing in.** A specific detail, a real number, a shared referent. Quote 20 is the acquittal: _"he hit too many personal notes to have just copy-pasted from a bot."_ Genericity is the substrate every other tell grows on.

### 4.3 Five calibration questions before sending

1. **Does my reply carry more structure than the message it answers?** If yes, the register is inflated. This is the single highest-yield check.
2. **Is my formality above or below theirs?** Either direction is distance. Aim level.
3. **Would this read as odd if a stranger saw it?** If yes, I climbed the familiarity ladder.
4. **Did I answer in the first sentence?** Validation-then-answer is the placating shape of §1.15. Answer, then add.
5. **Would I groan reading this?** The crowd's own test, and the best one: _"Treat it like it's a real message and stop when you would normally groan."_

### 4.4 The assistant-specific failure modes

Named explicitly because each one is a default, not a mistake — they fire unless actively suppressed:

- **Defaulting to article register.** The model _"thinks, 'Oh, this user wants a magazine article'"_ regardless of channel (§1.20).
- **Treating every message as a request for completeness.** Most messages want an answer, not coverage.
- **Adding structure unprompted.** Headers and bullets are a response to complexity, not a house style.
- **Validating before answering.** Warmth that costs nothing reads as hollow precisely because it cost nothing (§1.15).
- **Ending with an offer.** The single most conclusive tell in the entire corpus (§1.1).
- **Even rhythm.** Not a stylistic preference — a measured property of the output, and the one that survives every vocabulary edit (§1.7).

### 4.5 One caution on using any of this to _judge_ others

Yeung et al. (AIES, Aug 2026) is the corrective: "AI Style" reasoning appeared **318.8% more often** in threads resolved as **not** AI. Style cues are the strategy most correlated with being wrong. The measured human-detection rate for the general population is ≈50% (Cooke et al., CACM 2025). And the quote that should end any accusation impulse — User 63442 in that dataset: _"you're also making it harder for real artists. Some of you are convincing people that \*actual\* artistic quirks, mistakes, and techniques are 'obvious' AI."_

These findings are for **writing better**, not for calling people out.

---

## 5. Sources

**Studies and papers**

- Sun, Yin et al., _Idiosyncrasies in Large Language Models_, ICML 2025 — [arXiv 2502.12150](https://arxiv.org/abs/2502.12150). 97.1% five-way model attribution; idiosyncrasies are word-distribution-level (bag of words survives shuffling) and survive paraphrase/translation/summarisation.
- Russell, Rajendhran, Pham, Iyyer & Wieting, _StoryScope: Investigating idiosyncrasies in AI fiction_, Apr 2026 (rev. Aug 2026) — [arXiv 2604.03136](https://arxiv.org/abs/2604.03136). ~61k stories; 93.2% macro-F1 from narrative structure alone.
- Yeung, Weld, Mink & Roesner, _Is This AI? Longitudinal Analysis of Strategies Used for AI Detection on Two Subreddits_, AIES 2026, 2026-08-10 — [arXiv 2606.22689](https://arxiv.org/abs/2606.22689) · [project page](https://agent-security.cs.washington.edu/is-this-ai.html). 13,098 posts / 222,060 comments; 12-strategy taxonomy; the +318.8% false-positive finding.
- Cooke, Edwards, Barkoff & Kelly, _As Good as a Coin Toss: Human Detection of AI-Generated Content_, CACM 68(10), Oct 2025 — [ACM](https://dl.acm.org/doi/10.1145/3729417) · [arXiv 2403.16760](https://arxiv.org/abs/2403.16760). n=1,276; ≈chance.
- Sourati, Ziabari & Dehghani, _The Homogenizing Effect of Large Language Models on Human Expression and Thought_, Trends in Cognitive Sciences, Mar 2026 — [Cell](<https://www.cell.com/trends/cognitive-sciences/fulltext/S1364-6613(26)00003-3>) · [arXiv 2508.01491](https://arxiv.org/abs/2508.01491).
- Yakura et al. (Max Planck Institute for Human Development), _Empirical evidence of Large Language Model's influence on human spoken communication_, 2025 — [arXiv 2409.01754](https://arxiv.org/html/2409.01754v1) · [Scientific American coverage](https://www.scientificamerican.com/article/chatgpt-is-changing-the-words-we-use-in-conversation/). 360k YouTube videos + 771k podcast episodes.
- Nakano, Takezawa, Matulic, Yang & Yatani, _Understanding Reader Perception Shifts upon Disclosure of AI Authorship_, Jan 2026 — [arXiv 2510.24011](https://arxiv.org/html/2510.24011v2). n=261; disclosure erodes trustworthiness, caring, competence, likability; sharpest in interpersonal writing.
- Liu, Giorgi, Aich, Lahnala, Curtis, Ungar & Sedoc, _The Illusion of Empathy_, Nov 2024 — [arXiv 2411.12877](https://arxiv.org/html/2411.12877v1). Humans rated 5.42 vs chatbots 4.04 on empathy (p<0.001) **while chatbots scored higher on overall conversation quality**.
- Wang, Xing, Mansurov, Puccetti et al., _Is Human-Like Text Liked by Humans? Multilingual Human Detection and Preference Against AI_ — [arXiv 2502.11614](https://arxiv.org/pdf/2502.11614).
- _Do humans identify AI-generated text better than machines? Evidence from German theses_, Int. J. for Educational Integrity, 2025 — [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S1477388025000131). Humans 57% / 64%.
- Columbia SIPA Institute of Global Politics + Hewlett Foundation, _AI Slop and the Information Ecosystem_, June 2026 (convening 2026-03-05, Chatham House Rule, 20 participants) — [PDF](https://igp.sipa.columbia.edu/sites/igp/files/2026-06/AI%20Slop%20and%20the%20Information%20Ecosystem_IGP%20Report.pdf). Slop = _"content that feels low-effort, repetitive, or strangely hollow."_
- Macquarie Dictionary Word of the Year 2025, announced 2025-11-25 — [ABC News](https://www.abc.net.au/news/2025-11-25/ai-slop-named-macquarie-dictionary-word-of-the-year-2025/106047682).
- HBR _workslop_ study, Sep 2025, n=1,150 US desk workers — [Axios summary](https://www.axios.com/2025/09/24/ai-workslop-workplace-efficiency-study). 41% received workslop in a month; ~1h56m to resolve each; trust in the sender fell 42%, perceived effort 49%.

**Measured corpora (industry)**

- Graphite, _AI Tells_, Sep 2026 — [graphite.io](https://graphite.io/five-percent/research/ai-tells). 10k human + 90k AI articles, nine models; 12,877 tells; exclamation marks 100×+ more human; em-dash inversion.
- WriteHuman, _The Real Signature of AI Writing Isn't the Em-Dash Anymore_, 2026-04-21 — [writehuman.ai](https://writehuman.ai/blog/ai-tells-in-2026). 80,141 humanization pairs; G² rankings.
- eigen-vector, _Slop or not_ dataset, Show HN 2026-03-15 — [HN 47357745](https://news.ycombinator.com/item?id=47357745). 16k human posts (Reddit/HN/Yelp) × 6 models; Reddit easier than HN.

**CMC / politeness / register**

- Gunraj, Drumm-Hewitt, Dashow, Upadhyay & Klin, _Texting insincerely: The role of the period in text messaging_, Computers in Human Behavior, 2016 — [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0747563215302181); follow-up _Punctuation in text messages may convey abruptness. Period_ (2017).
- _Emojis at Work: The Effects of Emoji Use on Perceptions of Competence and Appropriateness_, Collabra: Psychology 12(1) — [UC Press](https://online.ucpress.edu/collabra/article/12/1/147309/217078/Emojis-at-Work-The-Effects-of-Emoji-Use-on).
- Cavalheiro, Prada & Rodrigues, _Examining the effects of reciprocal emoji use_, J. Social and Personal Relationships, 2024 — [Sage](https://journals.sagepub.com/doi/full/10.1177/02654075231219032).
- _When does waiting for a reply turn into ghosting?_, Computers in Human Behavior, 2025 — [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S0747563225002213).
- Rendle-Short, _Dispreferred responses when texting: Delaying that 'no' response_, 2015 — [Sage](https://journals.sagepub.com/doi/10.1177/1750481315600309).
- Bierstetel et al., _Associations between language style matching and relationship commitment and satisfaction_, JSPR 2020 — [Sage](https://journals.sagepub.com/doi/10.1177/0265407520923754); Niederhoffer & Pennebaker, _Linguistic Style Matching in Social Interaction_, 2002 — [PDF](https://www.ffri.hr/~ibrdar/komunikacija/seminari/Niederhoffer,%202002%20-%20Linguistic%20style%20matching.pdf).
- Wen & Zhang, _Code-switching and identity construction in WhatsApp_, John Benjamins — [link](https://www.jbe-platform.com/content/books/9789027264022-dapsac.78.05wen); _Insertion Function in Code-Mixing Use on WhatsApp Group Chats_, JLTR — [link](https://jltr.academypublication.com/index.php/jltr/article/view/5897).

**Press**

- _The Biggest Tell That Something Was Written by AI_, The Atlantic, 2026-05-29 — [theatlantic.com](https://www.theatlantic.com/technology/2026/05/how-to-tell-ai-writing/687345/).
- _What's Wrong With Using AI to Text?_, The Atlantic, Sep 2026 — [theatlantic.com](https://www.theatlantic.com/technology/2026/09/chatgpt-imessage-ai-texting/688507/).

**Crowd corpora gathered for this report**

- 6,221 Hacker News comments, Algolia API (`search_by_date`, `tags=comment`, `created_at_i>1735689600`), 20+ query terms, pulled 2026-09-25. Working files: `/tmp/hv2/hn_corpus.json`, `/tmp/hv2/tells2.txt`, `/tmp/hv2/tells3.txt`.
- Reddit threads reached via search-engine snapshots (r/isthisAI, r/RealOrAI, r/technology, r/Professors, r/AskReddit, r/CasualConversation, r/WritingWithAI, r/AmITheAngel, r/Productivitycafe, r/AmIOverreacting, r/NoStupidQuestions, r/literature, r/AccusedOfUsingAI, r/Entrepreneur). Direct fetch of reddit.com is blocked from this environment; every Reddit quote above is from an indexed snippet and carries its thread URL and date.

---

## Method note and limits

- **Reddit was not fetched directly.** reddit.com, old.reddit.com, api.reddit.com all return an interstitial to this host, and the redlib mirrors sit behind an Anubis proof-of-work. Reddit quotes come from search-engine snippets — verbatim as indexed, but each is a fragment and I could not read the surrounding thread or verify vote counts. HN quotes are full-text from the API and are exact.
- **YouTube comments** were not reached in quotable form; the brief's "quoted in articles" route produced nothing new beyond what is above. Gap acknowledged rather than padded.
- **Two paywalls held**: The Atlantic (both pieces) and cell.com. The Atlantic content above comes from a mirror and from the r/technology and HN discussion threads; the TiCS paper from its arXiv preprint. The r/technology quotes are from the discussion of the article, not the article itself, and are labelled as such.
- **Crowd data is not a population sample.** Hacker News and r/isthisAI over-represent heavy LLM users — exactly the group Russell et al. found is near-perfect at detection. The general population sits at chance (Cooke et al.). Treat §1 as "what the expert tail notices", which is the right target for writing well, and not as "what the average reader will catch".
