# Tells of AI-written ENGLISH text (2024–2026)

**Purpose.** Help an assistant _write_ like a clear, natural human in real emails and messages. Not detector evasion — the tells below are mostly things that make writing worse, so removing them is an improvement on its own terms.

**Provenance.** Primary sources: Wikipedia's `Signs of AI writing` field guide (raw wikitext pulled 2026-09-24, ~221 KB, built from thousands of real diffs); Russell/Karpinska/Iyyer ACL 2025 (300 articles, 5 expert annotators, coded explanations); Kobak et al. (14 M PubMed abstracts); Reinhart et al. PNAS 2025 (grammatical features); The Economist July 2026 (55,940 sentences / 1.2 M words across 4 model families); community threads on Hacker News; two open-source tell inventories (blader/humanizer, tbhb/vale-ai-tells).

**What would change it.** Word-level tells rot fast — `delve` peaked in 2023–24 and collapsed by 2025; em dashes were suppressed in GPT-5.1. Structural tells (negative parallelism, triads, staged significance, formatting-by-rule) have survived three model generations and are the durable half of this document. Re-check the word lists yearly; the structure lists age much more slowly.

**Caveat that should govern how any of this is used.** Humans are bad at this. A 2025 study found lay detection "no better than random chance"; a German-theses study got 57% on AI text and 64% on human text; expert LLM users hit ~90%, i.e. roughly 1 false positive in 10 accusations. `Signs of AI writing` says plainly: human judgment is "significantly worse than random chance" for untrained readers, and false accusations drive away real writers. **Use these to edit your own prose, not to convict someone else's.**

---

## 1. Tells taxonomy

Strength key:

- **STRONG** — almost only AI; act on a single sighting.
- **MODERATE** — AI-typical in density; a careful human does it sometimes, a model does it every paragraph.
- **WEAK** — humans do it too; only counts stacked with others. False positive noted.

---

### A. Rhetorical staging (the durable core)

#### A1. Negative parallelism — "It's not X, it's Y"

**Strength: STRONG.** The single most-cited structural tell in both the literature and community threads. Variants: `not only X but also Y`, `not just X — it's Y`, `X rather than Y` (Grok-flavoured), `no…, no…, just…`, and the split-across-sentences form (`This does not mean X. It means Y.`).

Real examples:

- "This choice of language is **not only dismissive but also unnecessarily harsh** and confrontational." (Talk:Eric Dick, Aug 2024)
- "constitutes **not only a work of self-representation, but a visual document** of her obsessions, visual strategies and psychobiographical narratives." (Self-portrait (Yayoi Kusama), Apr 2025)
- "**Not a career, not a body of work, not sustained relevance** — just an algorithmic moment." (AfD/Lilly Contino, Jun 2025)
- "The issue here **isn't just sourcing** — **it's framing**." (AfD/Northern English nationalism, Aug 2025)

Natural rewrite: state the claim once. _"Calling another editor's view 'bogus' is harsh and shuts down the discussion."_ / _"The problem is framing, not sourcing."_ (only if someone actually argued sourcing).

Why it reads wrong: the negative half denies something nobody claimed, so the positive half sounds bigger than it is. Keep the contrast **only** when the negative half corrects a belief the reader actually holds.

Sources: [Wikipedia:Signs of AI writing §Negative parallelisms](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) · [Russell et al. 2025, Table 17](https://aclanthology.org/2025.acl-long.267/) (annotator: _"the comparison of 'it's not just this, it's this' … along with listings of specifically three ideas"_) · [The Economist, 30 Jul 2026](https://www.economist.com/culture/2026/07/30/how-to-spot-ai-writing) · [HN 49047444](https://news.ycombinator.com/item?id=49047444)

#### A2. Rule of three / forced triad

**Strength: MODERATE→STRONG in density.** One triad is rhetoric; a triad per paragraph is a generator.

Real examples:

- "Designed for tougher materials such as **tiles, metals, and plastics**." … "Used in **model making, woodworking, and other craft projects**." (Rotary saw, Jul 2024 — every bullet a triad)
- "The film preserves core elements such as Nezha's **mythological image, magical weapons, and spirit of resistance** while reshaping them through **contemporary values, modern aesthetics, and digital animation technology**." (Ne Zha, Jun 2026 — two triads, one sentence)
- "Attendees can expect **innovation, inspiration, and industry insights**."

Natural rewrite: _"The event has talks and panels, plus time to talk to people between sessions."_ Cut to the items that carry distinct information; two is fine, one is often better.

Stronger signal when it shows up where nobody would bother with rhetoric — commit messages, edit summaries, a two-line Slack reply.

Sources: [Signs of AI writing §Rule of three](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) · [GPTZero AI Patterns, "Everything in Threes"](https://gptzero.me/news/ai-patterns/) · [blader/humanizer §6](https://github.com/blader/humanizer)

#### A3. Inflated significance / legacy staging

**Strength: STRONG.** Wikipedia editors call this the single most consistent observation: AI text reads like promotional copy, inflating whatever it describes.

Watch for: `stands/serves as a testament`, `marking a pivotal moment`, `plays a crucial/key role`, `underscores its importance`, `reflects a broader`, `enduring legacy`, `setting the stage for`, `evolving landscape`, `indelible mark`, `deeply rooted`.

Real examples:

- "The Statistical Institute of Catalonia was officially established in 1989, **marking a pivotal moment in the evolution of regional statistics** in Spain. … This initiative **was part of a broader movement** across Spain to decentralize administrative functions and **enhance regional governance**."
- "This etymology **highlights the enduring legacy** of the community's resistance and **the transformative power** [of…]" (Bacnotan, Dec 2024 — about a place-name spelling)
- "It **plays a role in the ecosystem** and **contributes to Hawaii's rich cultural heritage**. … **Preserving this endemic species is vital** not only for ecological diversity but also for sustaining the cultural traditions…" (a plant species, Dec 2024)

Natural rewrite: _"The Statistical Institute of Catalonia was set up in 1989, part of a wider decentralisation of administration in Spain."_ Keep the fact, drop the significance. End on the last concrete fact rather than a send-off.

Sources: [Signs of AI writing §Undue emphasis on significance](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) · [GPTZero, "Overblown Importance"](https://gptzero.me/news/ai-patterns/) · [Belcher, _10 Ways AI Is Ruining Your Students' Writing_, Chronicle of Higher Education, 16 Sep 2025](https://www.chronicle.com/article/10-ways-ai-is-ruining-your-students-writing)

#### A4. Shallow `-ing` riders (participial padding)

**Strength: STRONG** in density — Reinhart et al. measured instruction-tuned LLMs using present participial clauses at **2–5× the human rate**.

Watch for a fact followed by a bolted-on: `highlighting`, `underscoring`, `emphasizing`, `ensuring`, `reflecting`, `symbolizing`, `contributing to`, `fostering`, `showcasing`, `encompassing`.

Real examples:

- "The temple's colour palette of blue, green, and gold **resonates with** the region's natural beauty, **symbolizing** Texas bluebonnets, the Gulf of Mexico, and the diverse Texan landscapes, **reflecting** the community's deep connection to the land."
- "…**further enhancing its significance as a dynamic hub of activity**."
- "Bryan, **leaning on his agility**, dances around the ring, **evading**…" (GPT-4o, cited in Reinhart et al.)

Natural rewrite: _"The temple is painted blue, green and gold — meant to echo Texas bluebonnets and the Gulf."_ If the rider claims something the source doesn't support, it is not just padding, it is invention.

Sources: [Signs of AI writing §Superficial analyses](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) · [Reinhart et al., PNAS 2025](https://www.pnas.org/doi/10.1073/pnas.2422455122) · [blader/humanizer §15](https://github.com/blader/humanizer)

#### A5. Copula avoidance — anything but "is"

**Strength: MODERATE.** One study found a >10% drop in `is`/`are` in academic writing in 2023 with no prior trend.

Watch for: `serves as`, `stands as`, `functions as`, `operates as`, `marks`, `represents [a]`, and the marketing verbs `boasts`, `features`, `offers`, `maintains` in place of `has`. Also `refers to` opening a definition.

Real examples:

- "Gallery 825 **serves as** LAAA's exhibition space for contemporary art. The gallery **features** four separate spaces and **boasts** over 3,000 square feet."
- "Catchment area (health) **refers to** the geographic area from which a health facility draws its patients."

Natural rewrite: _"Gallery 825 is LAAA's exhibition space for contemporary art. It has four rooms, about 3,000 square feet."_

Sources: [Signs of AI writing §Avoidance of basic copulatives](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) · [GPTZero, "Dressed-up Verbs"](https://gptzero.me/news/ai-patterns/)

#### A6. Vague connection — "associated with"

**Strength: MODERATE.** The text asserts a link without naming it.

Real examples:

- "He is **associated with** the Rajhans Orchestra, which he founded and conducts."
- "The concerts were organised **in connection with** the celebrations of Pakistan's 50th anniversary."
- "The system has been **associated with** residential water management applications."

Natural rewrite: _"He founded the Rajhans Orchestra and conducts it."_ If you genuinely don't know the relationship, say you don't know — don't paper over it with `associated with`.

Source: [Signs of AI writing §Vague expression of connection](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)

#### A7. False profundity / aphorism mode

**Strength: MODERATE.** Ordinary points dressed as hidden truths.

Watch for: `the real question is`, `at its core`, `what really matters`, `fundamentally`, `the deeper issue`, `X is the language of Y`, `X is not a tool but a mirror`, `the architecture of`, `the currency of`.

Real examples:

- "**The real question is** whether teams can adapt. **At its core, what really matters is** organizational readiness."
- "Symmetry **is the language of** trust."

Natural rewrite: _"The question is whether teams adapt, which mostly depends on whether the organisation will change its habits."_

Source: [blader/humanizer §3](https://github.com/blader/humanizer)

#### A8. Staged run-up before the point

**Strength: MODERATE→STRONG** depending on phrase. `Let's dive in` / `Without further ado` are near-certain; `Honestly,` mid-sentence is ordinary human speech.

Watch for: `Let's dive in`, `Let's explore`, `Let's break this down`, `Here's what you need to know`, `Without further ado`, `Before we dive in`, `By the end of this guide`, and the fake-candour openers `Honestly?`, `Look,`, `Here's the thing`, `Real talk`.

Natural rewrite: delete the run-up entirely and start with the point. _"Next.js caches data at three layers: request memoisation, the data cache, and the router cache."_

Sources: [blader/humanizer §4](https://github.com/blader/humanizer) · [vale-ai-tells OpeningCliches.yml](https://github.com/tbhb/vale-ai-tells/blob/main/styles/ai-tells/OpeningCliches.yml)

#### A9. Arguing with no one (strawman defence)

**Strength: MODERATE.** The text rebuts an objection nobody made — usually a leftover from the model's own reasoning.

Watch for: `This isn't (mainly) about`, `I'm not saying`, `To be clear`, `Don't get me wrong`, `A tempting approach would be`, `One might be tempted to`, `You might think… but`.

Real example (constructed from the pattern, source lists the family):

- "**A tempting approach would be** to rotate tokens by restarting the auth service on a cron job, but that would drop every active session."

Natural rewrite: _"Tokens rotate in place every 24 hours; clients refresh transparently."_

Source: [blader/humanizer §5](https://github.com/blader/humanizer)

#### A10. One-line closers and dramatic fragments

**Strength: STRONG** when repeated across sections.

Watch for: a one-sentence paragraph restating the paragraph above; `That's the real win.`; `Read that again.`; `Let that sink in.`; rows of fragments (`No aesthetic prior. No nostalgia.`); `every. single. day.`

Real example:

- "Then AlphaEvolve arrived. It had no preference for symmetry. **No aesthetic prior. No nostalgia** for human taste. The old rules were gone."

Natural rewrite: _"AlphaEvolve searched differently because it didn't favour symmetry or human-looking designs, which made some older assumptions less useful."_

Source: [blader/humanizer §2](https://github.com/blader/humanizer)

#### A11. Borrowed authority / phantom experts

**Strength: MODERATE→STRONG.** Unnamed authorities propping up a claim; or a list of prestige outlets propping up a person.

Watch for: `Experts argue`, `Observers have cited`, `Industry reports`, `Some critics argue`, `several publications`; `cited/featured/profiled in [NYT, BBC, …]`, `trade publications`, `independent coverage`, `active social media presence`.

Real examples:

- "Due to its unique characteristics, the Haolai River **is of interest to researchers and conservationists**."
- "Her views have been **cited in The New York Times, BBC, Financial Times, and The Hindu.** She **maintains an active social media presence** with over 500,000 followers."

Natural rewrite: name who said what, or cut the claim. Never invent a source to fix this.

Sources: [Signs of AI writing §Vague attributions](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) · [GPTZero, "Phantom Experts" / "Name Dropping"](https://gptzero.me/news/ai-patterns/)

#### A12. Sales-brochure register

**Strength: STRONG** for places, products, organisations.

Watch for: `boasts`, `vibrant`, `rich`, `nestled`, `in the heart of`, `breathtaking`, `renowned`, `groundbreaking`, `diverse array`, `natural beauty`, `must-visit`, `stunning`, `commitment to`.

Real examples:

- "**Nestled within the breathtaking region** of Gonder in Ethiopia, Alamata Raya Kobo **stands as a vibrant town with a rich cultural heritage and stunning natural beauty**."
- "**seamlessly connecting** the beginning and end of every traveller's journey"

Natural rewrite: _"Alamata Raya Kobo is a town in the Gonder region of Ethiopia."_

Sources: [Signs of AI writing §Promotional language](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) · [GPTZero, "Sales-pitch Tone"](https://gptzero.me/news/ai-patterns/)

#### A13. Nominalisation density

**Strength: MODERATE** (measured, but invisible to most readers as a "tell" — it registers as heaviness). Reinhart et al.: instruction-tuned models use nominalisations at **1.5–2× the human rate**.

Real example (Llama 3 70B Instruct, four in one sentence):

- "These schemes can help to reduce **deforestation, habitat destruction, and pollution**, while also **promoting sustainable consumption patterns**."

Natural rewrite: _"These schemes can slow deforestation, stop habitats being destroyed and cut pollution. They also push people to consume less."_ (verbs instead of noun-phrases).

Source: [Reinhart et al., PNAS 2025](https://www.pnas.org/doi/10.1073/pnas.2422455122)

---

### B. Rhythm and punctuation

#### B1. Em dash overuse — **the most over-claimed tell; treat with care**

**Strength: WEAK alone, MODERATE in density. Major false-positive risk.**

The evidence is genuinely mixed and has _moved_:

- `Signs of AI writing` now carries a maintenance banner (Sep 2026) saying this sign should probably be moved to **Historical indicators** because it is less common in current output.
- **The Economist (Jul 2026), 1.2 M words:** of contemporary models, **only Claude used em dashes more than professional writers; ChatGPT used them _less_.**
- OpenAI explicitly suppressed them in GPT-5.1.
- Confounders: iOS/macOS autocorrect, Word autoformat, Markdown `--` → `—`, house style guides.

The _shape_ is more diagnostic than the count: AI em dashes are typically **spaced** (`—`, against most typographic guides) and used as a universal connector where a comma, colon or full stop would do, often to punch up a parallelism.

Real examples:

- "Ultimately, one of the admins blocked me **— not because of the AI usage itself, which had already been addressed —** but because I didn't respond to their continued questioning."
- "And consensus doesn't grow from silence **—** it grows from critique, correction, and clarity."

Natural rewrite: _"An admin blocked me for not answering their questions, not for the AI use itself."_

**Practical rule for writing:** don't ban the em dash, but don't use it as your default joint. If a paragraph has three, two of them wanted a full stop.

Sources: [Signs of AI writing §Overuse of em dashes](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) · [The Economist, 30 Jul 2026](https://www.economist.com/culture/2026/07/30/how-to-spot-ai-writing) · [HN 44867692 "Why the em dash is attracting unfair suspicion"](https://news.ycombinator.com/item?id=44867692) · [The Ringer, 20 Aug 2025](https://www.theringer.com/2025/08/20/pop-culture/em-dash-use-ai-artificial-intelligence-chatgpt-google-gemini)

#### B2. Uniform cadence — every sentence the same length

**Strength: MODERATE→STRONG**, and repeatedly named by humans as what actually gives it away, more than any word.

The Economist found LLMs "skimp on commas, semicolons and parentheses, instead churning out overly long sentences, relying on `and` as their single most overused word," producing sentences of uniform length. Russell's annotators wrote the human-side version of the same observation: _"Short choppy sentences and paragraphs"_ and _"There's a lot of variety in the article's grammar use, with dashes, brackets, quotes intermixed."_

Natural rewrite: alternate. A long sentence that carries a clause or two, then a short one. Like that.

Sources: [The Economist, 30 Jul 2026](https://www.economist.com/culture/2026/07/30/how-to-spot-ai-writing) · [Russell et al. Table 17](https://aclanthology.org/2025.acl-long.267/) · [HN 48379358](https://news.ycombinator.com/item?id=48379358)

#### B3. Grammatical flawlessness / no contractions, no filler

**Strength: MODERATE, and a counter-intuitive one.** Russell's non-expert annotators wrongly assumed run-on sentences meant AI; in fact **humans are more likely to write ungrammatical or run-on sentences**. Experts flagged the _opposite_: "there's nothing off about the grammar or syntax in this piece."

Human markers the annotators cited approvingly: filler words (`just`, `very`, `really`), contractions, colloquialism ("sucked"), self-correction, parentheticals, mixed registers.

Natural rewrite: allow yourself contractions, the occasional `just`, an aside in brackets, and a sentence that trails somewhere slightly unplanned.

Sources: [Russell et al. Table 17 §Formality, §Grammar](https://aclanthology.org/2025.acl-long.267/) · [Pangram blog on Russell et al.](https://www.pangram.com/blog/russell)

#### B4. Repeated sentence openings / stacked hedges / hyphenated pairs

**Strength: WEAK each; MODERATE together.**

- Several consecutive sentences starting with the same subject ("She noted the door. She noted the lock. She filed both away.").
- `could potentially`, `might arguably`, `it's also possible`, `to be fair` stacked in one claim.
- Everything hyphenated regardless of position: "the report is **high-quality**" (should be _high quality_ after the noun).

Natural rewrites: merge the sentences; keep one hedge; drop the post-nominal hyphen.

False positive: ordinary hedges (`perhaps`, `tends to`) are human habits, not tells; anaphora is a deliberate human device ("She came. She saw. She conquered.").

Source: [blader/humanizer §7, §9, §10](https://github.com/blader/humanizer)

#### B5. Curly quotes and the single-character ellipsis

**Strength: WEAK.** Most editors auto-curl quotes; Word and iOS do it silently. One HN commenter flags the single `…` glyph (rather than three periods) as a secondary tell. Worth knowing, not worth accusing anyone over.

Sources: [Signs of AI writing §Curly quotation marks](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) · [HN 49760222](https://news.ycombinator.com/item?id=49760222)

---

### C. Email and message tells (highest relevance for the target use case)

#### C1. Sycophantic opener

**Strength: STRONG.** Named "the most certain tell in this list" by blader/humanizer — and the easiest to miss because it wraps real content.

Watch for: `Great question!`, `Excellent question!`, `That's a great question`, `Certainly!`, `Of course!`, `Absolutely!`, `You're absolutely right`, `I'd be happy to help`, `I'm glad you asked`, `I couldn't agree more`.

Real example:

- "**Great question!** Here is an overview of the French Revolution. It began in 1789 when a financial crisis and food shortages led to widespread unrest. **I hope this helps! Let me know if you'd like me to expand on any section.**"

Natural rewrite: _"The French Revolution started in 1789, out of a financial crisis and food shortages."_

Sources: [Signs of AI writing §Collaborative communication (WP:CERTAINLY)](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) · [vale-ai-tells SycophancyMarkers.yml](https://github.com/tbhb/vale-ai-tells/blob/main/styles/ai-tells/SycophancyMarkers.yml)

#### C2. Closing pleasantries

**Strength: STRONG in the AI-assistant register; WEAK as evidence against a human in a business email** — see the false-positive note.

Watch for: `I hope this helps`, `Hope this helps`, `I hope this clarifies`, `Feel free to reach out`, `Don't hesitate to ask`, `Let me know if you have any questions`, `Let me know if you need anything else`, `Happy to clarify further`, `Is there anything else…`.

Real example:

- "…**I hope this helps! Let me know if you'd like me to expand on any section.**"

Natural rewrite: end on the content, or on a real, specific next step. _"I'll send the revised figures on Thursday."_ / _"If Tuesday doesn't work, say so and I'll move it."_

**False positive, important:** `Let me know if you have any questions` and `I hope this email finds you well` are _decades-old business-email boilerplate_, not AI inventions — and `Signs of AI writing` explicitly notes that "salutations and sign-offs on a letter or comment predate chatbots." They are a **quality** problem (empty, canned, zero information) rather than reliable **evidence** of AI. My own inference: the AI-specific version is the _stack_ — a sycophantic opener AND a summary AND a closing pleasantry AND an offer of more help, all in a four-line message.

Sources: [vale-ai-tells ClosingPleasantries.yml](https://github.com/tbhb/vale-ai-tells/blob/main/styles/ai-tells/ClosingPleasantries.yml) · [blader/humanizer §22 and "When not to act"](https://github.com/blader/humanizer) · [Mergers & Inquisitions, _ChatGPT for Email_](https://mergersandinquisitions.com/chatgpt-for-email/) (on "I hope this note finds you well" as GPT-4's default opener)

#### C3. A `Subject:` line pasted into the body

**Strength: STRONG.** Wikipedia documents a whole family of comments that begin with a literal `Subject:` line — the model producing email-shaped output regardless of channel.

Real examples:

- "**Subject: Request for Permission to Edit Wikipedia Article - "Dog"**" (Feb 2024)
- "**Subject: Concerns about Inaccurate Information**" (Mar 2025)
- "**Subject: Behavioral issues and Wikihounding by User:Binksternet**" (May 2026, on a noticeboard)

Also the stock title shapes: `Request for Clarification`, `Request for Review and …`, `Concerns Regarding …`, `Appeal Against …`.

Source: [Wikipedia:Signs of AI use in comments §Subject lines](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_use_in_comments)

#### C4. Titled sections inside a short message

**Strength: STRONG.** A four-paragraph reply broken into headed sections, or bold inline headers with colons, is the shape of a generated document, not a message.

Real example (an AfD comment):

- "**Conflict of Interest (COI)/Autobiography:** While I understand the concern regarding my username […] **Notability (GNG and NPOLITICIAN):** I have revised the article […] **Original Research and Promotional Tone:** I have worked on removing…"

Natural rewrite: prose. If the message truly has three separable points, three short paragraphs beat three bold labels.

Sources: [Signs of AI writing §Inline-header vertical lists (WP:AILIST)](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) · [Signs of AI use in comments §Division of text into titled sections](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_use_in_comments)

#### C5. Canned assurance and policy itemisation

**Strength: STRONG** in its native habitat (a reply to criticism). Generalises to work email as: listing the rules you promise to follow instead of saying what you'll do.

Real examples:

- "Moving forward, I will strictly adhere to Wikipedia's **Neutral Point of View (NPOV)** and **verifiability** guidelines, **ensuring that all contributions are non-promotional, well-sourced, and align with Wikipedia's standards**." (note: triad + `ensuring` rider + itemised policies, all in one sentence)
- "The current revision **fully complies with** Wikipedia's core content policies — including **WP:V, WP:RS, and WP:BLP** — with all significant claims supported by **multiple independent and reputable international sources**."

Natural rewrite: _"I've added citations for the three disputed claims and cut the marketing language from the intro."_

Source: [Signs of AI use in comments §Itemization of policies](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_use_in_comments)

#### C6. Knowledge-cutoff disclaimers and dressed-up guesses

**Strength: STRONG.**

Watch for: `As of my last knowledge update`, `Up to my last training update`, `While specific details are limited`, `not widely documented`, `based on available information`, `in the provided sources` — and the dangerous follow-on, a plausible guess presented as fact.

Real example:

- "**While specific details about the company's founding are not extensively documented in readily available sources,** it appears to have been established sometime in the 1990s."
- "Information about her early life **is not publicly available, suggesting she maintains a low profile**. She **likely** grew up in a middle-class household, which shaped her later interest in education reform."

Natural rewrite: _"I couldn't find the founding date."_ Then stop. Do not fill the hole.

Source: [Signs of AI writing §Knowledge-cutoff disclaimers](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)

#### C7. Stock names

**Strength: MODERATE** (11.7% of expert explanations). Models reach for the same names: **Emily Carter, Sarah Thompson**, and give everyone the same title (`Dr.`) with no distinguishing detail.

Annotator quote: _"the introduction of Dr. Sarah Thompson and Dr. Emily Carter (who by now has more than a lifetime's worth of qualifications), means that it has to be AI text."_ And the inverse: _"A couple of the experts also have quite unique names, and none of them are referred to as Dr. X (bonus points for none of them being named Emily)."_

Source: [Russell et al. Table 17 §Names & Titles](https://aclanthology.org/2025.acl-long.267/)

---

### D. Status-report and commit-message tells

These are their own genre and the task flagged them specifically. Source for this whole block unless noted: [tbhb/vale-ai-tells `ai-tells-commits`](https://github.com/tbhb/vale-ai-tells/tree/main/styles/ai-tells-commits) (a Vale rule package, i.e. these are mechanically checkable).

#### D1. Self-narration — "This commit adds…", "I've successfully…"

**Strength: STRONG.** The message describes itself instead of the change.

Examples: `This commit adds`, `This change fixes`, `This PR introduces`, `I have successfully implemented`, `I've successfully updated`.
Natural rewrite: _"Add retry to the upload handler"_ / _"Fixed the timezone offset in the invoice export."_ Imperative or plain past; no preamble.

#### D2. Unquantified claims

**Strength: STRONG.** `significantly faster`, `substantially improved`, `dramatically reduced`, `much cleaner`, `blazingly fast`, `major performance boost`.
Natural rewrite: _"Cuts p95 latency from 840 ms to 210 ms."_ If you don't have the number, say what you changed, not how much better it is.

#### D3. Buzzword pairs

**Strength: MODERATE→STRONG.** `comprehensive test suite`, `comprehensive error handling`, `robust error handling`, `robust validation`, `proper cleanup`, `properly handle`.
Natural rewrite: _"Adds 12 tests for the parser, including the malformed-header case."_

#### D4. Trailing justification

**Strength: STRONG.** A participial tail explaining why the change is virtuous: `ensuring consistency`, `ensuring type safety`, `improving maintainability`, `enhancing readability`, `maintaining compatibility`.
Natural rewrite: cut it. The diff shows it.

#### D5. Hedging about your own change

**Strength: MODERATE.** `This should fix`, `This may resolve`, `This helps to ensure`, `appears to fix`.
Natural rewrite: say what you actually tested. _"Reproduced the crash with the 4 KB payload; it no longer crashes after this change."_

#### D6. Marketing adjectives

**Strength: STRONG** in a commit. `production-ready`, `enterprise-grade`, `battle-tested`, `rock-solid`, `bulletproof`, `carefully crafted`, `meticulously crafted`.

#### D7. Headers and bold for three lines of content

**Strength: STRONG.** Bold applied to every item in a list, a heading over each two-sentence chunk, emoji as bullet glyphs (`🚀 **Launch Phase:**`), horizontal rules between every section, Title Case headings.

Real example:

- "- **User Experience:** The user experience has been significantly improved with a new interface.
  - **Performance:** Performance has been enhanced through optimized algorithms.
  - **Security:** Security has been strengthened with end-to-end encryption."

Natural rewrite: _"The update reworks the interface, speeds up load times, and adds end-to-end encryption."_ Note the original also restates each bold label in its own sentence — a compounding tell.

Sources: [Signs of AI writing §Overuse of boldface, §Emoji as formatting](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) · [blader/humanizer §19, §20](https://github.com/blader/humanizer)

#### D8. A heading restated by its own first sentence

**Strength: MODERATE.**

- "## Performance / Speed matters. / When users hit a slow page, they leave."
  Natural rewrite: drop "Speed matters."

---

### E. Content-shape tells

#### E1. The "Challenges / Future Outlook" outline ending

**Strength: STRONG.** A stock closing move: acknowledge difficulties, then reassure.

Real examples:

- "**Despite its** industrial and residential prosperity, Korattur **faces challenges typical of urban areas**… **Despite these challenges**, with its strategic location and ongoing initiatives, Korattur **continues to thrive**."
- "**Future investments in technology** could **enhance** the canal's efficiency."
- "**The future looks bright** for the company. **Exciting times lie ahead.**"

Natural rewrite: _"Korattur has recurring traffic congestion and water shortages."_ Then stop.

#### E2. Optimistic closing summary

**Strength: STRONG** — Russell's annotators flagged this repeatedly; 13.1% of explanations cited conclusions. The paper ends on this annotator quote:

> "This time I went to the end of the piece and said: 'Hello, AI.' There it was in all its glory: the '**testament**' serving '**as a beacon of hope and inspiration**' and '**demonstrating**' to us humans '**that anything is possible**.'"

Natural rewrite: end on the last real fact. Human-written pieces "end more abruptly and less tidily" (Russell et al.).

#### E3. Generic scene-setting opener

**Strength: MODERATE.** The experts' own guidebook: AI intros "often contain a strong scene-opener with a description of a specific time or place, such as `On a drab November morning…`". Also `In the year of…` for fiction, and `I recently had the pleasure of…` for reviews (Pangram).

#### E4. Positivity floor / topic avoidance

**Strength: MODERATE.** AI text skews positive by default and avoids darker material. Annotator: _"It spends very little time talking about the horrors of the disease, and instead focuses on future research, hopeful quotes, and potential cures, even referring to it as 'embarking on a new chapter'."_

#### E5. Homogeneous quotes

**Strength: MODERATE** (22.3% of explanations). Invented quotes all sound like the surrounding prose, sit in the same position in each paragraph, and every speaker has the same register. Annotator: _"every expert speaks the same way and it's too homogenous with the text."_ Human giveaway, per another annotator: _"The quotes being short snippets also makes me think they're real, as the writer had to find a way to fit them into the text."_

Source for E1–E5: [Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) · [Russell et al. Tables 11, 17](https://aclanthology.org/2025.acl-long.267/) · [Pangram](https://www.pangram.com/blog/russell)

---

### F. Ineffective indicators — do NOT treat these as tells

From `Signs of AI writing §Ineffective indicators`, plus Russell et al. on non-expert error modes:

| Non-tell                          | Why it fails                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Perfect grammar                   | Many humans are professional writers                                                                            |
| "Fancy" or academic prose         | The correlation is with _specific words_, not with formality in general                                         |
| "Bland" or "robotic" prose        | LLM output has specific traits; blandness alone isn't one                                                       |
| Mixed casual/formal register      | Indicates a technical person, youth, playfulness, neurodivergence, or multiple authors                          |
| Transition words in isolation     | Only a few (`Additionally`, `Moreover`) are actually overused; style guides endorse them                        |
| Unsourced content                 | 570,000+ Wikipedia articles predate LLMs and lack citations; modern LLMs _do_ add citations                     |
| Run-on sentences                  | Backwards — **humans** produce more run-ons than AI (Russell et al.)                                            |
| Bizarre wikitext / HTML artifacts | More often browser extensions or VisualEditor bugs                                                              |
| Correct formatting                | Normal for anyone using a visual editor or the preview button                                                   |
| Detector scores                   | GPTZero/Pangram beat chance but have non-trivial error rates and are defeated by paraphrasing and unseen models |

---

## 2. Word and phrase list, with plain replacements

### 2a. The core overused-word list

This is the intersection of the Wikipedia "Words to watch" box, Kobak's measured excess words, and Russell's expert-compiled guide. **Only these specific words are evidenced** — synonyms are not implicated (`Signs of AI writing` says to read the list "as literally as possible").

| AI word                         | Plain replacements                                         |
| ------------------------------- | ---------------------------------------------------------- |
| additionally (sentence-initial) | also, and, plus — or nothing                               |
| align with                      | match, fit, agree with                                     |
| boasts                          | has                                                        |
| bolstered                       | strengthened, backed, helped                               |
| crucial                         | important, necessary — or delete                           |
| deep dive                       | a close look, a detailed look                              |
| delve / delve into              | look at, dig into, go through                              |
| emphasizing                     | which shows, stressing — usually delete                    |
| enduring                        | lasting, long — usually delete                             |
| enhance                         | improve, add to, speed up, make better                     |
| fostering                       | encouraging, building, helping                             |
| garner                          | get, win, attract                                          |
| highlight (verb)                | show, point out, mention                                   |
| interplay                       | how X and Y interact                                       |
| intricate / intricacies         | complicated, the details of                                |
| key (adjective)                 | main, important — often delete                             |
| landscape (abstract)            | field, market, situation                                   |
| meticulous / meticulously       | careful, carefully, thorough                               |
| pivotal                         | important, decisive, turning point                         |
| quietly (figurative)            | delete — flagged as "the biggest AI tell of Q3 2026" on HN |
| robust (figurative)             | strong, reliable, thorough (keep technical uses)           |
| showcase / showcasing           | show, display, include                                     |
| tapestry (abstract)             | mix, range — or delete                                     |
| testament (to)                  | shows, proves — usually delete the clause                  |
| underscore (verb)               | show, stress, confirm                                      |
| valuable                        | useful, helpful — or say why                               |
| vibrant                         | lively, busy, colourful — or delete                        |

**Kobak's measured numbers** (PubMed, 14 M abstracts, 2024 vs counterfactual): `delves` **r = 25.2×**, `showcasing` **r = 9.2×**, `underscores` **r = 9.1×**. High-volume words with big absolute gaps: `potential` (δ = 0.041), `findings` (δ = 0.027), `crucial` (δ = 0.026). A non-overlapping ten-word set reproduced the same 10% lower bound: **across, additionally, comprehensive, crucial, enhancing, exhibited, insights, notably, particularly, within**. (The later _Science Advances_ version reports `delves` at ~28×.)

**Era matters.** From `Signs of AI writing`:

- 2023–mid-2024 (GPT-4): _Additionally, boasts, bolstered, crucial, delve, emphasizing, enduring, garner, intricate, interplay, key, landscape, meticulous, pivotal, underscore, tapestry, testament, valuable, vibrant_
- Mid-2024–mid-2025 (GPT-4o): _align with, bolstered, crucial, emphasizing, enhance, enduring, fostering, highlighting, pivotal, showcasing, underscore, vibrant_
- Mid-2025 onward (GPT-5): _emphasizing, enhance, highlighting, showcasing_ — plus notability language
- **Grok** is idiosyncratic: `causal`, `empirical`, `correlate`, and still overuses `underscore` in 2026.

### 2b. Stock phrases → replacements

| Stock phrase                                     | Replacement                                              |
| ------------------------------------------------ | -------------------------------------------------------- |
| It's not X, it's Y                               | State Y.                                                 |
| Not only X but also Y                            | X and Y.                                                 |
| stands as a testament to                         | shows (or delete the sentence)                           |
| plays a crucial/key role in                      | is part of / does                                        |
| marking a pivotal moment in                      | (delete; give the date and the fact)                     |
| underscores the importance of                    | matters because… (then say why)                          |
| reflects a broader trend                         | (delete unless you can name the trend and a source)      |
| is associated with / in connection with          | name the actual relationship                             |
| serves as / functions as / stands as             | is                                                       |
| boasts / features / offers                       | has                                                      |
| Experts argue / Observers have cited             | name the expert, or cut the claim                        |
| a diverse array of                               | several, many, a few — or list them                      |
| in the heart of / nestled in                     | in                                                       |
| Let's dive in / Let's explore                    | (delete; start with the point)                           |
| In today's fast-paced world                      | (delete entirely)                                        |
| It's important to note that                      | (delete; just note it)                                   |
| It's worth noting that                           | (delete)                                                 |
| In conclusion / In summary / Overall             | (delete; a short message needs no summary)               |
| Great question! / Certainly! / Of course!        | (delete)                                                 |
| I hope this helps                                | (delete, or give a real next step)                       |
| Let me know if you have any questions            | (delete, or ask the specific question you need answered) |
| Feel free to reach out / Don't hesitate to ask   | (delete)                                                 |
| I'd be happy to help                             | I'll do X by Y.                                          |
| Despite these challenges                         | (delete; the "challenges" paragraph usually goes too)    |
| The future looks bright / Exciting times ahead   | (delete)                                                 |
| significantly improved / dramatically faster     | give the number                                          |
| comprehensive test suite / robust error handling | say what it actually covers                              |
| ensuring consistency / improving maintainability | (delete; the diff shows it)                              |
| This should fix                                  | I tested X and it no longer does Y                       |
| production-ready / battle-tested / bulletproof   | (delete)                                                 |
| a wide range of / a variety of                   | some, three, most — be specific                          |
| in order to                                      | to                                                       |
| due to the fact that                             | because                                                  |
| has the ability to / is capable of               | can                                                      |
| utilize                                          | use                                                      |
| authored                                         | wrote                                                    |
| relocated                                        | moved                                                    |
| attempted                                        | tried                                                    |
| passed away                                      | died                                                     |

(The last five are from the `Signs of AI writing` **§Signs of human writing** list, which records that the _simple_ word is the human marker, measured over 25 years of Wikipedia editing.)

### 2c. Words and habits that mark writing as HUMAN

Measured to be more common in human Wikipedia writing than in AI text — so these are things to _permit yourself_, not avoid:

- Simple `is`/`has` constructions: _there is a_, _it has a_
- Plain verbs over stiff synonyms: _wrote, moved, used, tried, died_
- Superlative or definitive statements: _one of the best_, _is the only_, _was the first_
- Hedging qualifiers and intensifiers: _very_, _perhaps_, _tends to_
- Wordy constructions in isolation: _as a result of_, _in order to_, _all of the_, _the fact that_
- Contractions, filler (`just`, `really`), mild slang, a self-correcting parenthetical
- A specific, odd, verifiable detail — "the lawyer who used to work upstairs from my dentist"
- Mixed feelings left unresolved: "I think this is mostly good, but it bothers me and I can't say why"

---

## 3. Structural and genre tells — these matter more than single words

Ranked by how much they carry, on my reading of the combined evidence (Russell's category frequencies + the Economist's finding that word-level tells are converging).

1. **Uniform texture.** The most-repeated human observation, and the hardest thing for a model to break. Same sentence length, same paragraph length, same register from first line to last. Human writing wobbles: a long clause-heavy sentence next to a four-word one, a paragraph that's one line because that's all it needed. HN: _"the biggest AI writing tell … is an unnatural consistency in style, whatever style that may be."_

2. **Everything is formatted.** Bold on every list item, a colon after every label, a heading over every two sentences, emoji as bullets, Title Case headings, horizontal rules between sections, a table where a sentence would do. The tell is **decoration applied by rule**, not the presence of formatting. A three-line answer with two headings is a generated document wearing a message's clothes.

3. **The closing summary that adds nothing.** AI text "always ends with a neat conclusion, instead of just ending the article naturally," and the conclusion restates what was already said, positively. Human pieces end abruptly. For a message: the last sentence should be the last piece of information, not a wrap-up of the message you just sent.

4. **Openings that stage rather than start.** Scene-setting ("On a drab November morning…"), the promise of what's coming ("By the end of this guide you'll…"), the generic frame ("In today's fast-paced world"), or the greeting-plus-praise combo. Human openings drop you nearer the middle.

5. **Density of rhetorical devices per unit of information.** Not any single device — the _rate_. One triad, one contrast, one dash, one "it's not X it's Y" per paragraph means the writing is generating rhythm rather than following the meaning. HN: _"One in a piece can be effective; ten in a blog post is a genuine insult to the reader."_

6. **Symmetrical structure.** Every section the same size. Every bullet the same shape (`**Label:** one-sentence gloss`). Every paragraph three sentences. A human's sections are lopsided because their knowledge is lopsided. Russell's annotator praised a human text precisely for asymmetry: _"the bullet points not going into a title: one-to-two sentence explanation format."_

7. **Positivity floor and conflict avoidance.** Neutral-to-upbeat throughout, controversy softened, no swearing, no strong verdict, criticism always balanced by a redeeming clause. Human writing has a slant, sometimes an unflattering one.

8. **Over-explanation / telling rather than showing.** 19.5% of expert explanations cited clarity problems: irrelevant detail, restating the same idea in slightly different words, explaining what was already clear. HN on a flagged post: _"whole chunks of prose repeating what's already appeared, but in slightly different words."_

9. **Quotes and names that don't behave like reality.** All quotes the same length and register, placed identically in each paragraph; recycled stock names; everyone a "Dr." with no distinguishing detail.

10. **Channel mismatch.** Email furniture (a `Subject:` line, a formal salutation, a signature block) in a chat message; headings in a two-paragraph reply; Markdown asterisks in a plain-text field; a "key takeaways" block on a three-sentence answer. _(My own inference, generalised from the Wikipedia `Subject:` and Markdown-residue findings — these are documented as AI tells on Wikipedia specifically because the output shape didn't match the destination.)_

11. **Self-narration.** The text describes what it is doing instead of doing it: "This commit adds…", "In this section we will discuss…", "Here is an overview of…", "I have successfully completed…".

---

## 4. What real people said

Quotes and close paraphrases from community threads. Reddit was inaccessible (blocked to automated fetching from this environment), so these are drawn from Hacker News, the Russell et al. annotator corpus, and quoted community voices in published articles.

1. **On the strongest single tell** — _"The 'It's not X — it's Y' pattern, often with an em dash. The single most commonly identified AI writing tell. Man I f\*cking hate it. AI uses this to create false profundity by framing everything as a surprising reframe. One in a piece can be effective; ten in a blog post is a genuine insult to the reader. Before LLMs, people simply did not write like this at scale."_ — [HN 49047444](https://news.ycombinator.com/item?id=49047444)

2. **On uniformity beating vocabulary** — _"For me, the biggest AI writing tell (other than the blatantly obvious ones) is an unnatural consistency in style, whatever style that may be. It's most apparent in longer pieces… human writers seem to lack the ability to keep a 100% consistent voice and lapse into different registers at different times."_ — [HN 48379358](https://news.ycombinator.com/item?id=48379358)

3. **On voice being more than tone** — _"You can spot AI writing now. Not because it's bad, but because it all sounds the same. Same cadence, same transitions, same careful optimistic closer… your writing voice is made of dozens of interwoven patterns: sentence rhythm, punctuation habits, where your analogies come from, how you build and close an argument. A system prompt captures maybe 10% of that."_ — [HN 47349777](https://news.ycombinator.com/item?id=47349777)

4. **On the word of the moment** — _"'quietly' is the biggest AI writing tell of Q3 2026."_ — [HN 49275858](https://news.ycombinator.com/item?id=49275858)

5. **On em dashes being low-signal** — _"If you know what you're looking for — and no, that does not mean em-dashes, they're a low-signal indicator and people get precious about them — your false positive rate can get pretty low. See Russell et al… Anecdotally speaking, I'm heavily involved in AI cleanup work on Wikipedia."_ — [HN 46863420](https://news.ycombinator.com/item?id=46863420)

6. **On the false positive, from the accused side** — _"I am not an LLM and use em-dashes and they were house style in my last 20+ years of employment. The whole em dashes == AI thing needs to just stop."_ — [HN 49468718](https://news.ycombinator.com/item?id=49468718)

7. **On the middle position** — _"I hate those arguments 'it has emdash therefore AI', of course humans also write that way. But poor and excessive usage of them is a pretty strong red flag, also together with other tells."_ — [HN 48970196](https://news.ycombinator.com/item?id=48970196)

8. **On stacking tells rather than single ones** — _"The subheadings are all full of AI tells… All of those read like AI, especially considering that the subsections aren't consistent. Some are numbers, some are not… EM dashes everywhere, AI tells in subheadings, 'It's not X it's Y' all over the text of the body."_ — [HN 48911495](https://news.ycombinator.com/item?id=48911495)

9. **On consistency across the whole output** — _"even if your writing is influenced by 'the AI style,' it would likely only show up in patches, a word or rhetorical flourish maybe, but AI-generated text doesn't 'sound like AI' in patches, it does so consistently across the entirety of the output."_ — [HN 48984879](https://news.ycombinator.com/item?id=48984879)

10. **On the repetition tell** — _"The writing style screams AI slop — whole chunks of prose repeating what's already appeared, but in slightly different words."_ — [HN 46590209](https://news.ycombinator.com/item?id=46590209)

11. **On perception being irreversible** — _"I couldn't spot AI writing for a while, and I was suddenly enjoying reading clear and punchy text… Then at some point it 'clicked' and I was suddenly unable to not see it. Articles that I had thought sophisticated now came across to me as if they were written in crayon."_ — [HN 49298993](https://news.ycombinator.com/item?id=49298993)

12. **On the vocabulary being a fine-tuning artefact** — _"'delve' and the em-dash are both a result of the finetuning dataset, not the base LLM."_ — [HN 45724367](https://news.ycombinator.com/item?id=45724367)

13. **Expert annotator, on what human word choice looks like** — _"I very much doubt AI would have used adventurous adjectives like 'chunky', 'musky' or 'thin' to describe food. Nor would it have used verbs like 'blitzing' or 'bolstering'."_ — [Russell et al. 2025, Table 17](https://aclanthology.org/2025.acl-long.267/)

14. **Expert annotator, on formality as the tell** — _"It includes filler words like 'just', 'very' and 'really'. Colloquial language like 'sucked'."_ (given as evidence the text was _human_) — [Russell et al. 2025, Table 17](https://aclanthology.org/2025.acl-long.267/)

15. **Expert annotator, on the closing move** — _"This time I went to the end of the piece and said: 'Hello, AI.' There it was in all its glory: the 'testament' serving 'as a beacon of hope and inspiration' and 'demonstrating' to us humans 'that anything is possible.'"_ — [Russell et al. 2025, §Conclusion](https://aclanthology.org/2025.acl-long.267/)

16. **On the cost of getting it wrong** — a teacher told a student's sister that an AI detector had flagged her (AI-free) essay "with 100% confidence" and planned to give her a zero. Separately: _"One of my kid's teachers sent out a warning that all essays would be checked with AI detection software… A classmate did an AI check on the teacher's warning and it came back positive for having been AI-generated."_ — [HN 46037449](https://news.ycombinator.com/item?id=46037449), [HN 41903806](https://news.ycombinator.com/item?id=41903806)

17. **On models being unable to suppress their own tells** — _"Even if you tell the LLM not to use LLM prose they (still) do it. If you feed the Wikipedia article on signs of AI writing and tell them to use none of those signs they will also (still) do it."_ — [HN 49236698](https://news.ycombinator.com/item?id=49236698)

---

## 5. Sources

**Primary field guides**

- [Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) — the best single list; ~221 KB, hundreds of dated real diffs; living document, "descriptive not prescriptive"; carries its own caveats on detection reliability. Retrieved 2026-09-24 as raw wikitext.
- [Wikipedia:Signs of AI use in comments](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_use_in_comments) — the companion guide for _messages_ rather than articles; source for `Subject:` lines, titled sections in short replies, canned assurances. ~152 KB.
- [Wikipedia:WikiProject AI Cleanup](https://en.wikipedia.org/wiki/Wikipedia:WikiProject_AI_Cleanup) — the project that maintains both; formed 2023. Since March 2026, WP:LLM prohibits LLM-generated article content except for translation and basic copyediting.

**Peer-reviewed / preprint studies**

- Russell, Karpinska & Iyyer (2025), _People who frequently use ChatGPT for writing tasks are accurate and robust detectors of AI-generated text_, ACL 2025 — [ACL Anthology](https://aclanthology.org/2025.acl-long.267/) / [arXiv:2501.15654](https://arxiv.org/abs/2501.15654). 300 articles, 5 expert annotators, 1 error in 300 by majority vote; coded taxonomy of cues (vocabulary 53.1%, sentence structure 35.9%, grammar 24.8%, originality 23.7%, quotes 22.3%, clarity 19.5%, formatting 15.0%, conclusions 13.1%, formality 12.3%, names 11.7%, tone 9.3%, intros 7.3%, factuality 7.2%, topics 3.1%). [Data/code](https://github.com/jenna-russell/human_detectors).
- Kobak, González-Márquez, Horvát & Lause (2024/2025), _Delving into ChatGPT usage in academic writing through excess vocabulary_ — [arXiv:2406.07016](https://arxiv.org/abs/2406.07016), later [Science Advances](https://www.science.org/doi/10.1126/sciadv.adt3813). 14 M PubMed abstracts 2010–2024; ≥10% of 2024 abstracts LLM-processed (up to 30% in some sub-corpora); 2024 excess vocabulary almost entirely _style_ words (66% verbs, 18% adjectives) vs. Covid-era excess being content words.
- Reinhart et al. (2025), _Do LLMs write like humans? Variation in grammatical and rhetorical styles_, PNAS 122(8) — [PNAS](https://www.pnas.org/doi/10.1073/pnas.2422455122) / [arXiv:2410.16107](https://arxiv.org/abs/2410.16107). Present participial clauses 2–5× human rate; nominalisations 1.5–2×; noun-heavy informationally dense style persists even when prompted to be informal; effect larger for instruction-tuned than base models.
- Juzek & Ward (2025), _Why Does ChatGPT "Delve" So Much?_ — [arXiv:2412.11385](https://arxiv.org/abs/2412.11385); and _Word Overuse and Alignment in LLMs: The Influence of Learning from Human Feedback_ — [arXiv:2508.01930](https://arxiv.org/pdf/2508.01930). Traces overuse to RLHF rather than pretraining.
- Shaib et al. (2025, rev. 2026), _Measuring AI "Slop" in Text_ — [arXiv:2509.19163](https://arxiv.org/abs/2509.19163). Taxonomy of "slop" from expert interviews; binary slop judgments are partly subjective but correlate with coherence and relevance.
- Sun, Yin, Xu, Koller & Liu (2026), _Idiosyncrasies in Large Language Models_ — [arXiv:2502.12150](https://arxiv.org/abs/2502.12150v2).
- Geng & Trotta (2025), _Human-LLM Coevolution: Evidence from Academic Writing_ — [ACL Findings](https://aclanthology.org/2025.findings-acl.657.pdf). Human language is absorbing LLM habits, which erodes every tell over time.
- Huang et al. (2026), _Wikipedia in the Era of LLMs: Evolution and Risks_ — [OpenReview](https://openreview.net/pdf?id=ahVmnYkVLt).
- Dik, Erdem & Dik (2025), _Assessing GPTZero's Accuracy_ — [arXiv:2506.23517](https://arxiv.org/abs/2506.23517).
- Dugan et al. (2024), _RAID: A Shared Benchmark for Robust Evaluation of Machine-Generated Text Detectors_, ACL — [ACL Anthology](https://aclanthology.org/2024.acl-long.674). Detectors break on paraphrasing, markup and spacing changes, and unseen models.

**Journalism and essays**

- [The Economist, _How to spot AI writing_, 30 July 2026](https://www.economist.com/culture/2026/07/30/how-to-spot-ai-writing) — 55,940 sentences / 1.2 M words across ChatGPT, Claude, Gemini, Grok. Em dashes no longer a reliable marker (only Claude exceeds professional writers; ChatGPT is _below_); LLMs underuse commas, semicolons and parentheses and overuse `and`; uniform sentence length; heavy "It's not X, it's Y". Its own warning: _"claiming that a text is by an LLM because it uses the word 'delve' is like claiming one is by Jane Austen because it uses 'imprudence'."_ Discussion: [Daring Fireball](https://daringfireball.net/linked/2026/08/11/economist-ai-writing).
- [Sam Kriss, _Why Does A.I. Write Like … That?_, NYT Magazine, 3 Dec 2025](https://www.nytimes.com/2025/12/03/magazine/chatbot-writing-style.html) (paywalled).
- [Wendy Belcher, _10 Ways AI Is Ruining Your Students' Writing_, Chronicle of Higher Education, 16 Sep 2025](https://www.chronicle.com/article/10-ways-ai-is-ruining-your-students-writing).
- [The Ringer, _Stop AI-Shaming Our Precious, Kindly Em Dashes_, 20 Aug 2025](https://www.theringer.com/2025/08/20/pop-culture/em-dash-use-ai-artificial-intelligence-chatgpt-google-gemini) and [Rolling Stone, _'ChatGPT Hyphen'_](https://www.rollingstone.com/culture/culture-features/chatgpt-hypen-em-dash-ai-writing-1235314945/) — the false-positive backlash.
- [McSweeney's, _The Em Dash Responds to the AI Allegations_](https://www.mcsweeneys.net/articles/the-em-dash-responds-to-the-ai-allegations) — the joke version, useful as a cultural marker of how tired the tell is.

**Detector-vendor material** (useful for their tell taxonomies; treat their accuracy claims as marketing)

- [GPTZero, _Introducing AI Patterns_](https://gptzero.me/news/ai-patterns/) — ten named patterns: Overblown Importance, Name Dropping, Empty Commentary, Sales-pitch Tone, Phantom Experts, Dressed-up Verbs, Not just X but Y, Everything in Threes, Unnecessary Caveats, Chatbot Language. Essentially a re-badged subset of the Wikipedia guide.
- [GPTZero, _Why Does My Writing Get Flagged as AI (When It's Not)?_](https://gptzero.me/news/why-writing-flagged-ai/) — the vendor's own false-positive discussion.
- [Pangram, _Pangram is the only AI detector that outperforms human experts_](https://www.pangram.com/blog/russell) — their analysis of Russell et al.; notes AI reaches for _clichéd metaphorical_ language rather than sophisticated vocabulary, and that non-experts wrongly read run-ons as AI.

**Community threads**

- [HN 44867692, _Why the em dash is attracting unfair suspicion_](https://news.ycombinator.com/item?id=44867692) — the fullest airing of the false-positive argument: decades-long em-dash users being accused; iOS/macOS/Word/Markdown autoconversion as confounders; "people are over-estimating the positive predictive value of the em dash."
- [HN 45428052, _Not only am I losing my livelihood to AI – now it's stealing my em dashes too_](https://news.ycombinator.com/item?id=45428052).
- Individual comments cited inline in §4 above.

**Open-source tell inventories** (derivative of the above, but the most operationally concrete)

- [blader/humanizer](https://github.com/blader/humanizer) — 25 numbered patterns in five groups, each with before/after rewrites, explicitly ranked by strength (§1–§5 act on one sighting; others marked _weak alone_). Its "When not to act" section is unusually honest: acknowledges the Nov 2022 cutoff, that judging by feel is near chance, and that human writing is absorbing AI habits. Derived from the Wikipedia guide.
- [tbhb/vale-ai-tells](https://github.com/tbhb/vale-ai-tells) — ~170 Vale rules, machine-checkable, split into `ai-tells`, `ai-tells-commits` (15 commit-message-specific rules) and `ai-tells-experimental` (statistical: sentence-length variance, sentence-start entropy, tricolon density, contraction avoidance). The commit rules are the best source found for status-report tells.
- Others in the same family: [kastrah/humaniser](https://github.com/kastrah/humaniser) (74 patterns), [lguz/humanize-writing-skill](https://github.com/lguz/humanize-writing-skill), [arturnbull/remove-ai-writing](https://github.com/arturnbull/remove-ai-writing).

---

## Appendix: the shortest usable version

If only ten rules survive into a writing prompt, these are the ten with the best evidence-to-effort ratio:

1. Never write "not X, but Y" / "not only… but also" unless correcting a belief the reader actually holds.
2. Never put three items in a list unless there are exactly three things.
3. Cut every sentence about why the thing you just said is significant.
4. Use `is` and `has`. Not `serves as`, `stands as`, `boasts`, `features`.
5. Delete the opener ("Great question!", "Let's dive in") and the closer ("I hope this helps", "Let me know if you have any questions"). Start with the point; end with the last fact.
6. No `-ing` tail explaining what the fact demonstrates.
7. Vary sentence length deliberately. Read it aloud; if every sentence breathes the same, rewrite.
8. Bold and headings only when the structure is real. Not on a four-line message.
9. Give numbers instead of `significantly`, names instead of `experts say`, and "I don't know" instead of a plausible guess.
10. Keep one specific, slightly odd, true detail. That is the thing a model cannot fake and a reader can always feel.
