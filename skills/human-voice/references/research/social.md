# Tells people catch in AI-written social posts, comments, replies, DMs and emails (2025–2026)

**Research unit:** hv2-social · compiled 2026-09-25
**Scope:** social posts, comments, replies, DMs, emails. Not essays, not papers.
**Goal:** help an assistant write naturally for real people. Not a detector-evasion guide — the strongest finding below is that evasion _fails_ and substance is the only durable signal.

**Method note on sourcing.** reddit.com is blocked to this crawler (both the JSON API and every Redlib/Safereddit mirror returned 403/410/429), so Reddit evidence here is second-hand via press that quotes it, and is labelled as such. Hacker News was read **first-hand and verbatim** through the Algolia API (`hn.algolia.com/api/v1/search` and `/items/<id>`), so HN quotes below are exact text with real author handles and timestamps. That skews the corpus technical — weight it accordingly.

---

## 0. The headline shift (read this first)

Three things changed between mid-2025 and now, and they reframe every tell below.

1. **Vocabulary tells are being replaced by structural and rhetorical tells.** WriteHuman's corpus analysis (2026-04-21) found **only 18.5% of AI inputs contained an em-dash at all**, and named `"X plays a crucial role in shaping Y"` as "the single most formulaic thing ChatGPT produces" — a _shape_, not a word. ([writehuman.ai, 2026-04-21](https://writehuman.ai/blog/ai-tells-in-2026))
2. **"Claudespeak" became a named, separate dialect.** Through Sept 2026 HN commenters treat Claude's register as distinct from ChatGPT's and name it in passing without explanation, the way you'd name a regional accent.
3. **Tells are now model-version-specific and move fast.** `notatoad` on HN, 2026-09-22: _"after a few hours use, my impression is that Opus 5.5 writes like gemini. drastic improvement over all opus 5.1's claudeisms."_ ([HN 49809761](https://news.ycombinator.com/item?id=49809761)). Anything below dated before ~2026-06 should be assumed partly stale.

A fourth, uncomfortable finding: **the accusation is now noisier than the signal.** Multiple HN users report quitting em-dashes, "load-bearing", "scaffolding" and "verbiage" out of fear of being accused. Writing to dodge tells produces its own flatness.

---

## 1. New tells

Each: name · verbatim examples · why people notice (their words) · strength · date + URL.

**Strength key.** STRONG = people call it on a single sighting. MODERATE = contributes to a verdict, rarely decisive alone. WEAK = high false-positive rate; people are actively pushing back on it.

---

### 1.1 CLAUDE-SPECIFIC AND RECENT-MODEL TELLS

#### T1. "You're absolutely right" (and the whole agreement-reflex family)

**Verbatim:**

- `avree`, 2025-11-20: _"'You're absolutely right!' is the Claude cliche (not a ChatGPT one) — 'You are absolutely correct.' is not that."_ ([HN 45997585](https://news.ycombinator.com/item?id=45997585))
- `troupo`, 2025-10-01, on a rival model: _"significantly less obsequious (very few 'you're absolutely right' that Claude vomits out on every interaction)"_ ([HN 45443170](https://news.ycombinator.com/item?id=45443170))
- `noduerme`, 2026-09-24, parodying a science write-up: _"In Claude-speak: 'You've hit the nail on the head. The DNA does not code, but acts exactly like an associative array. To be honest, the actual protein in question has an unknown function. But you're definitely onto something!'"_ ([HN 49828306](https://news.ycombinator.com/item?id=49828306))
- `nxobject`, 2026-09-23: _"training on public codebases created by 'You're Absolutely Right!'-era Claude…"_ ([HN 49823293](https://news.ycombinator.com/item?id=49823293))

**Why people notice:** it fires when nothing right was said. The canonical complaint (GitHub issue anthropics/claude-code#3382, HN 44885398, Aug 2025) is that a user answering _"Yes please"_ to a question got _"You're absolutely right!"_ — there was no proposition to agree with. `cpfiffer` (2026-08-13) defends it as _"a linguistic artifact with a genuine purpose"_ signalling an incoming correction; `furyofantares` the same day notes the irony of _"I agree"_ followed by unrelated reasoning.
**Strength: STRONG.** It is a meme; it is recognised as _Claude's_ specifically, which is rare precision.
**Sources:** [GitHub anthropics/claude-code#3382](https://github.com/anthropics/claude-code/issues/3382) · [HN 44885398, 2025-08-13](https://news.ycombinator.com/item?id=44885398) · [daveschumaker.net](https://daveschumaker.net/youre-absolutely-right-claude/)

#### T2. "Great catch!" / "Great question" / "Ah, I see the issue"

**Verbatim:**

- `wrs`, 2025-07-23: _"My computer defenestration trigger is when Claude does something very stupid — that also contradicts its own plan that it just made — and when I hit the stop button and point this out, it says 'Great catch!'"_ ([HN 44660567](https://news.ycombinator.com/item?id=44660567))
- `hn_throwaway_99`, 2026-08-11: _"There was a lot of back and forth with each time Claude giving me the stereotypical 'Great catch! I see my mistake in the previous iteration…' responses."_ ([HN 49265943](https://news.ycombinator.com/item?id=49265943))
- `Daniel Nguyen` on X: _"Claude in Cursor: - Ah, I understand it now - Ah, I see the issue - Ah yes, you're absolutely right - Apologize for the confusion"_ ([x.com/daniel_nguyenx](https://x.com/daniel_nguyenx/status/1894622756442190182))

**Why people notice:** praise for the _other party's_ correction, rewarding the human for catching your error. In a peer conversation it reads as staff-training politeness. Note _wrs_'s word: "trigger" — it is an irritation tell, not merely a recognition tell.
**Strength: STRONG in technical/collaborative contexts.**

#### T3. "I want to be careful here" (+ "doing a lot of work", "let me gently push back")

This one is unusually well evidenced: three separate HN users independently named it as _the_ giveaway in a single June 2026 thread.
**Verbatim:**

- `lcampbell`, 2026-06-17: _"> I want to be careful here. was the giveaway for me"_ ([HN 48577416](https://news.ycombinator.com/item?id=48577416))
- `svnt`, 2026-06-19: _"Here is a particularly clear example of opus-4.8-speak. > Now, I want to be careful here, because this is the part where it would be very easy to start waving my arms around."_ ([HN 48598544](https://news.ycombinator.com/item?id=48598544))
- `tejohnso`, 2026-06-19: _"Very strong LLM signal there… it screams out LLM use and changes the reader's focus from the content to the content creation."_ ([HN 48598839](https://news.ycombinator.com/item?id=48598839))
- `dexterlagan`, 2026-08-07, quoting _"I want to be careful here, because 'taste' is doing a lot of work and it is easy to hear it as decoration"_: _"Claude, is that you? I haven't seen a human write like this, ever, and I've read a lot of books. The 'want to be careful here', the 'doing a lot of work'… common. If it had 'I'd like to gently push back here' next to it, I wouldn't have been surprised."_ ([HN 49216602](https://news.ycombinator.com/item?id=49216602))

**Why people notice:** it performs epistemic caution without exercising any — the careful thing never arrives. Same failure as "let me be direct" (below): announcing a virtue instead of having it.
**Strength: STRONG.** Note `tejohnso`'s second-order cost: the reader stops reading the content and starts auditing its provenance.

#### T4. "load-bearing"

The single best-quantified Claude tell in existence.
**Data:** `archiewood`'s **claudeisms** project (2026-07-16) diffed 175 Claude Code session files (140 MB) against Stack Overflow comments. `load-bearing`: **87 per million, >7,500× the human ratio** — by far #1. The README notes it _appears in Claude's own system prompt_. `genuinely` ranks #12 at **224×**. ([github.com/archiewood/claudeisms](https://github.com/archiewood/claudeisms) · [HN 48937785](https://news.ycombinator.com/item?id=48937785))
A second project, _Show HN: The load-bearing vocabulary of Claude_ (2026-08-27), clustered ~50M words/day of GitHub PR descriptions; top five: **load-bearing, plainly, quietly, refusal, survived**. ([HN 49461817](https://news.ycombinator.com/item?id=49461817))
**Verbatim reaction:**

- `DonsDiscountGas`, 2026-09-21, on a prose essay: _"Reads like an LLM to me. 'Load bearing' also used a few paragraphs down."_ ([HN 49781824](https://news.ycombinator.com/item?id=49781824))
- `tonyarkles`, 2026-07-17: _"This is one of the things that upsets me the most about LLM writing. 'Load bearing' and 'belt and suspenders' are two tropes I've used for a long, long time and now I have to be intentional about not using them lest I be accused of offloading my writing."_ ([HN 48946609](https://news.ycombinator.com/item?id=48946609))
- `schrodinger`, 2026-07-16: _"I've noticed 'in service of' take off similar to 'load-bearing' with LLMs, and the whole structure just pattern matched to Claude for me."_ ([HN 48941411](https://news.ycombinator.com/item?id=48941411))

**Strength: STRONG when used figuratively outside construction/ops.** MODERATE inside sysadmin contexts where it predates LLMs (`thewebguyd`, `rsanheim`, 2026-08-27, both note prior art).

#### T5. The Claude noun-cluster: seam · scaffold · wedge · spike · crux · harness · surface(d) · drift · parity · handoff · gating · verdict · canonical · idempotent · sidecar · provenance · "in service of"

**Verbatim:**

- `wpasc`, 2026-07-15: _"the words 'load-bearing' 'wedge' 'spike' 'crux' and plenty others have been driving me crazy"_ ([HN 48928537](https://news.ycombinator.com/item?id=48928537))
- `legobmw99`, 2026-08-27: _"sidecar"_ appears **3.6×** more in the Claude cluster ([HN 49461817](https://news.ycombinator.com/item?id=49461817))
- claudeisms 20×+ list: _scaffolded, blocker, pre-existing, drift, surfaced, divergence, round-trip, stale, wiring, end-to-end, landed, framing, harness, parity, mirrors, seam, probe, cleanly, idempotent, guard, silently, proves, verified, verbatim, canonical, transient, fallback, honest, surface_
  **Strength: MODERATE individually, STRONG in combination.** Two or three in one short comment is what triggers the call.

#### T6. Coined abstract nouns for ordinary things ("rollout artifact")

**Verbatim:** `mort96`, 2026-09-23: _"'Rollout artifact'? This is Claude-speak isn't it? I have never ever heard anyone call a bug like this a 'rollout artifact' before."_ ([HN 49815956](https://news.ycombinator.com/item?id=49815956)) — and immediately contested by `_vertigo`: _"Clearly not Claude-speak… Upgrade your Claudish detection"_ ([HN 49816929](https://news.ycombinator.com/item?id=49816929)).
**Why people notice:** the model reaches for a categorical noun where a person would say what happened. Related grammatical observations from the same corpus:

- `stabbles`, 2026-08-27: the **"It <verb>s no <noun>"** pattern instead of "doesn't <verb>" (e.g. _"it carries no guarantee"_).
- `prmph`, 2026-08-27: verb misuse — _"names"_ as a verb, _"carries"_ where "contains" belongs.
  **Strength: MODERATE** (see the immediate dispute above — genuine false-positive risk).

#### T7. Depth-manufacturing adverbs: quietly · genuinely · honestly · plainly · structurally · fundamentally · meaningfully

**Verbatim:**

- `slappywhite`, 2026-04-07: _"'Quietly' refilling--ugh! This LLM-ish word is everywhere lately and rarely should be."_ ([HN 47677977](https://news.ycombinator.com/item?id=47677977))
- `brap`, 2026-09-21, quoting _"Quiet is not proof that nobody is recording, and a detection is not proof that anyone is"_: _"Is such claudespeak it's not even annoying it's just funny at this point"_ ([HN 49785768](https://news.ycombinator.com/item?id=49785768))
- Forbes (Jodie Cook), Feb 2026, sign #5 — **"Everything is quietly something"**: overuse of "quiet" as a crutch, e.g. _"quiet confidence"_. Reported as flagged by a Reddit user as consistent across Claude, ChatGPT **and** Gemini.
- Forbes sign #3 — **"'Honestly?' followed by nothing honest"**: the setup promises revelation, the payload is unremarkable.
  **Strength: STRONG for "quietly" in 2026.** MODERATE for the rest.
  **Sources:** [Forbes 2026-02-03](https://www.forbes.com/sites/jodiecook/2026/02/03/the-15-new-giveaway-signs-of-ai-generated-content-in-february-2026/) (paywalled to crawlers; full list reproduced at [freerepublic mirror, reposted 2026-07-09](https://freerepublic.com/focus/f-chat/4387361/posts)) · [Forbes May 2026 update](https://www.forbes.com/sites/jodiecook/2026/05/21/15-new-giveaway-signs-of-ai-writing-may-2026-update/)

The May 2026 Forbes update extends the ban list to: **"quietly," "shift," "matters," "shape," "land," "actually," "real," "earn," "the work," "hold," "pull," "compound," "signal," "built different"** — abstract fillers and unearned intensifiers.

#### T8. Announced directness that never arrives ("let me be direct", "worth stating plainly", "to be clear", "the honest answer")

**Verbatim:** HN 44885398 (Aug 2025) commenters report that _explicitly requesting directness generates responses about being direct rather than actually achieving it_ — one commenter's phrase for it: **"compliance theater."**
Forbes Feb 2026, sign #4: setups like _"I'm going to state this as clearly as possible"_ and _"Here's the part most people miss"_ — **"real directness doesn't announce itself."**
**Strength: STRONG.** This is the meta-rule that T3, T9 and T10 are instances of.

#### T9. "the part nobody talks about" / "here's the part that nobody talks about"

**Verbatim:**

- `aaronbrethorst`, 2026-01-12: _"Here's the part nobody talks about — This feels like such an obvious LLM tell; it has that sort of breathless TED Talk vibe that was so big in the late oughts."_ ([HN 46585208](https://news.ycombinator.com/item?id=46585208))
- `aalam`, 2026-05-02, pairing it with _"Two gotchas before you click buy"_: _"I really think there could be a score for entropy in playfulness that should differentiate LLM output"_ ([HN 47986860](https://news.ycombinator.com/item?id=47986860))
- `almondfestival`, 2026-09-22: _"it's literally the top 2 AI writing tropes in a single sentence… 1) negative parallelism: 'It's not bold. It's backwards.' 2) em-dash addiction: 'The problem -- and this is the part nobody talks about -- is systemic.'"_ ([HN 49796967](https://news.ycombinator.com/item?id=49796967))
  **Strength: STRONG.**

#### T10. "Here's the kicker" / "The best part?" / "But here's the thing"

Forbes Feb 2026, sign #1 — **"Announcing the good part"**: _"promise a payoff that rarely arrives. The insight that follows is usually standard advice dressed up as revelation."_
**Strength: STRONG.**

#### T11. The closing offer to do more — "Would you like me to…?" / "Let me know if you'd like me to…"

The cleanest caught-in-the-wild case in this corpus, because it survived a copy-paste into a professional artifact:
**Verbatim:** `bobmarleybiceps`, 2026-09-24: _"A recent review of mine had a LLM-ism at the very end, 'would you like me to format this into a formal peer review report?' So they very likely copy-pasted their whole review :). I'm pretty down on academia atm ;-;"_ ([HN 49824793](https://news.ycombinator.com/item?id=49824793))
**Why people notice:** a human ending a message does not offer to reformat it. In a _post or comment_ — where there is no ongoing service relationship — it is instantly disqualifying, because the reader is not a client.
**Strength: STRONG (fatal when present).**

#### T12. Self-ranking your own points — "the key insight here", "most importantly"

From `tyre`'s banned-moves list (below), filed under _"Self-ranking your own points: 'most importantly', 'the key insight here'."_ Same family as T8: telling the reader which of your sentences is the good one.
**Strength: MODERATE.**

#### T13. "Claudespeak" as an identified dialect — the meta-tell

By Sept 2026 the term needs no gloss on HN, and people report it spreading into human-written workplace text.
**Verbatim:**

- `invalidusernam3`, 2026-09-23: _"I would happily pay more for a claude model that performs the same but speaks normal English. The proliferation of claudespeak in the workplace is driving me insane. Every ticket, every PR feedback, every comment in the codebase is poisoned with its ridiculous unnatural vocabulary"_ ([HN 49817128](https://news.ycombinator.com/item?id=49817128))
- `scottyah`, 2026-09-23: _"The only thing worse than reading the repetitive claude-ism's while using the actual tool is seeing (likely human) efforts to reproduce it on every comment and blog."_ ([HN 49823350](https://news.ycombinator.com/item?id=49823350))
- `spdustin`, 2026-09-20: _"Sorry, I closed the tab after the first two Claude-isms. It's *so* frustrating."_ ([HN 49779384](https://news.ycombinator.com/item?id=49779384))
- `hypfer`, 2026-09-23, on cross-contamination: _"GLM felt like it got at least 20 IQ points dumber just from being exposed to claude's writing."_ ([HN 49812186](https://news.ycombinator.com/item?id=49812186))
- `cge`, 2026-09-02, on an arXiv paper: _"The entire paper is almost certainly Claude-generated, given the clear Claude-speak throughout… down to the needless sectioning with idiosyncratic title language."_ ([HN 49535005](https://news.ycombinator.com/item?id=49535005))
  **Strength: STRONG.** Note `spdustin`: two tells and the tab closes. That is the real cost function.

#### T14. A practitioner's full ban list (the most useful single artifact found)

`tyre`, 2026-08-23, posting the "Voice" section of a working AGENTS.md ([HN 49413456](https://news.ycombinator.com/item?id=49413456)) — reproduced verbatim because it is a hand-built taxonomy of 2026 tells:

> **Banned phrases** — never use these, or close variants:
>
> - "Honest" or "honestly"
> - "Exactly" or "exact", unless referencing a specific quantity or measurement
> - "You're absolutely right" / "You're right to push back" / "Great question"
> - "load-bearing", "full stop", "worth stating plainly", "worth noting"
> - "the honest answer", "to be clear", "let me be direct"
> - "it's not just X, it's Y" — and every cousin: "not X but Y", "X is not Y; it is Z", "this isn't X — it's Y"
> - "this matters because", "that reduction is useful, because", "here's the thing", "and that's the trap"
> - "in other words", "put differently", "better posed:", "the deeper point is"
> - "delve", "leverage", "harness", "unlock", "tapestry", "realm", "seamless", "robust", "holistic", "paradigm", "cutting-edge", "game-changer", "transformative", "elevate", "empower", "streamline", "landscape", "ecosystem"
> - "genuinely", "structurally", "fundamentally", "quietly", "meaningfully" as depth-manufacturing adverbs
> - "Ultimately," / "At the end of the day," as a closing summary
> - "serves as", "stands as", "represents", "marks a" where "is" works
> - "say the word"
>
> **Banned moves:**
>
> - The aphoristic closer. Don't end on a line engineered to sound quotable.
> - The suspense hook — "the cleanest way to think about this is this:"
> - Anticipate-and-rebut — raising an objection only to knock it down.
> - Meta-signposting — "Three caveats belong up front", "below I'll explain".
> - Reflexive hedging stacks: "almost", "tends to", "roughly", "largely", "with few exceptions".
> - Litotes as confidence: "not difficult", "not optional", "no small thing".
> - AI-humility asides about being a language model.
> - Self-ranking your own points: "most importantly", "the key insight here".
> - Em dash overuse. One per paragraph at most; a comma usually works.
> - Colon-reveals and dramatic mid-sentence pauses where "and" or "but" is the real conjunction.
> - Fragment rhythm. Not every third sentence. Like this.
> - Uniform structure — every paragraph three sentences, every sentence the same length. Vary it.
> - Mirrored clauses: "X does A; Y does B" balanced for symmetry alone.
> - Validate-then-precise: "That's correct, and we can make it precise."
>
> Vary the openers. Don't answer three messages in a row with the same shape.

The **banned moves** half is the more valuable half, and almost none of it appears in the already-covered literature.

---

### 1.2 STRUCTURAL / RHETORICAL TELLS (channel-independent)

#### T15. "X plays a crucial role in shaping Y"

Named "the single most formulaic thing ChatGPT produces." Top AI trigrams measured: _"is essential for", "role in shaping", "crucial role in", "critical role in", "important role in"_. Companion families: hedging verbs (_ensuring, ensures, highlights, supports, reflects_), intensifiers implying evidence without providing it (_significantly, effectively, directly, increasingly_), and **"rather than"** — the strongest multi-word marker, 17,251 occurrences in AI inputs vs 6,859 in humanised text.
**Strength: STRONG.** **Source:** [writehuman.ai, 2026-04-21](https://writehuman.ai/blog/ai-tells-in-2026)

#### T16. Therapist mode nobody asked for

Forbes Feb 2026, signs #6 and #7: unsolicited validation — _"You're not alone"_ — in a business context, and coaching-style interruptions — _"Do you want to sit with that for a while?"_
**Strength: STRONG in a peer channel** (comment, DM, reply). Emotional register is wildly miscalibrated and people feel it before they can name it.

#### T17. Missing emotional spikes / no stakes

Forbes Feb 2026 #11: flat neutral tone regardless of how much the subject should provoke. This is the load-bearing tell for condolence notes, thank-yous and apologies (§1.4).
**Strength: STRONG.**

#### T18. Too-tidy internal coherence

Forbes Feb 2026 #14 and May 2026 #5: _"As mentioned above"_, paragraphs looping back to the intro's framing, threads that weave too neatly. `cge`'s _"needless sectioning with idiosyncratic title language"_ (HN, 2026-09-02) is the same animal in long form.
**Strength: MODERATE.**

#### T19. Too clean to be human

Forbes Feb 2026 #15 and PCWorld #6: _"If the text you're reading is 100 percent error-free, there may be a reason for that."_ ([PCWorld, 2026-03-31](https://www.pcworld.com/article/3101116/busted-6-red-flags-that-message-was-written-by-chatgpt.html)) Pangram's Reddit guidance adds _"perfect grammar, punctuation, and sentence structure every single time"_ and a lack of **burstiness** — sentence-length variation. ([pangram.com](https://www.pangram.com/blog/how-to-detect-ai-on-reddit))
**Strength: MODERATE and falling** — see §1.5, people now add typos deliberately.

#### T20. Faux balance / refusing to take a side

`tingling168`, HN 2026-01-17: _"too balanced, too fair. Every argument has a counterargument. Every claim has a caveat. Real people pick sides, forget disclaimers, or double down when they shouldn't. AI keeps the peace like it's being graded."_ ([HN 46658458](https://news.ycombinator.com/item?id=46658458))
Also named by Medium's LLM-bot guide as an _"LLM fingerprint"_: _"While there are many sides to this…"_, _"It's important to consider both…"_ — _"humans tend to take sides harder when passionate, while bots pivot to neutral ground."_
**Strength: STRONG in opinionated communities.** This is the highest-signal tell for _comments and replies_ specifically, because a comment exists to have a position.

#### T21. The invented case study ("the mysterious Sarah Chen")

Fictional named examples standing in for evidence. ([Write With AI, 2025-09-21](https://writewithai.substack.com/p/10-dead-giveaways-your-content-screams))
**Strength: STRONG when the name is checkable and isn't real.**

---

### 1.3 PLATFORM-SPECIFIC TELLS

#### T22. LinkedIn — the whole genre is now presumed machine-written

**Base rates.** Pangram Labs scanned **1,002,627 posts >50 words** across five platforms, 2026-04-24 → 2026-06-30, with Pangram 3.3:
| Platform | Fully AI (long-form >250 words) |
|---|---|
| LinkedIn | **>40%** |
| Medium | ~33% AI or co-written |
| X/Twitter | ~24% fully AI; **~47%** any AI involvement |
| Substack | 21.9% AI or AI-assisted |
| Reddit | 11.6% of top-level posts; **98.1% of _comments_ classified human-authored** |

LinkedIn supplied **62% of all AI-flagged material** while being ~⅓ of the scan. Only **4.3%** of LinkedIn long-form was "AI-assisted/mixed" — i.e. people use AI **all-or-nothing**, they don't polish. ([TechTimes, 2026-07-15](https://www.techtimes.com/articles/320534/20260715/linkedin-leads-all-platforms-ai-written-posts-study-million-feeds-confirms.htm))

**Named tells** ([hiration.com, 2026](https://www.hiration.com/blog/ai-slop-linkedin/)):

- _"It's not X, it's Y"_ — "the most commonly named tell" (e.g. _"It's not about the tools, it's about the mindset."_)
- em-dash _"in nearly every sentence, always deployed the same polished way"_
- clipped broetry cadence: _"Short line. Then another. Building to a lesson."_
- stock openers: _"I'm thrilled to announce"_, _"Humbled and honored to share"_
- rocket/checkmark/sparkle emoji as decoration
- buzzword density: _"Shift. Reshape. Disrupt. Synergy"_
- **uniform over-polish**: no typos, identical paragraph lengths, _"sanded so smooth there's nothing to grab"_

**Human detection in the wild:** a 25-year-old Cape Town marketer (surname Stent) read ~200 posts across ~50 profiles and judged **~75%** AI-generated; her write-up of the telltale signs became her most-viewed post ever, tens of thousands of impressions. She named _dramatic metaphors_, _"grabby hooks"_, and _absence of a distinct voice_. Bloomberg reports users now openly _"scrutinising em dashes, emojis and repetitive phrasing to call out inauthenticity."_ ([Bloomberg, 2026-01-30](https://www.bloomberg.com/news/articles/2026-01-30/chatgpt-written-linkedin-posts-have-users-analyzing-emojis-other-ai-signs))
**Strength: STRONG.** On LinkedIn the prior is now _against_ you: readers assume AI and look for evidence of a human.

#### T23. X/Twitter reply bots — behaviour beats wording

The key 2026 finding, stated flatly by the detection guides: _"In 2026, **behavior beats wording** — bots write well now."_
**Behavioural tells:** replies within seconds (_"a consistent sub-30-second gap"_), 24/7 activity, _"the same 20–30 accounts are always first in the replies"_, brand-new or reactivated-dormant accounts, near-identical replies across threads.
**Textual tells (weaker):** generic praise — _"Great post!"_, _"So true 🙌"_, _"This is gold."_ — emoji-only filler, off-topic praise that doesn't engage the actual post, crypto/giveaway bait.
**Platform response:** X removed 1.7M spam bots in an Oct 2025 purge; Feb 2026 crackdown aimed at AI reply bots, with X's Head of Product quoted: _"If a human is not tapping on the screen, the account and all associated accounts will likely be suspended."_
**Strength: STRONG behaviourally, WEAK textually.**
**Sources:** [kitha.co 2026](https://www.kitha.co/blog/how-to-spot-ai-bot-replies-on-x) · [superx.so](https://superx.so/blog/ai-bot-twitter)

#### T24. Reddit — community-knowledge absence, and the mod-side view

Pangram's tells for Reddit specifically: content _"overly polite, neutral, or structured with perfect bullet points"_ is suspicious _"especially in communities with casual, slang-heavy, or opinionated discourse"_; and a post is suspect when it lacks _"current events that are relevant to the community"_ or _"specific community knowledge that a real person belonging to that community would naturally include."_
A Cornell study (Jul 2023 – Nov 2024) found subreddit rules explicitly addressing AI **more than doubled in one year**; r/writing's rule reads _"No Generative AI: r/writing is a place for human-created writing. AI slop has no place here."_
**Mod-side (second-hand, reddit.com unreachable):** moderators of r/AmItheAsshole and r/AITAH report AI submissions at a _"breaking point"_; mods estimate _nearly half_ of submissions may be AI-written or "enhanced"; one study puts ~23% of posts in popular advice subreddits as AI slop. Operators use **aged or purchased accounts** with existing karma and run _warm-up routines_ before switching to content mode; repost networks recycle high-performing images with AI-written titles. Reddit removed 40M+ pieces of spam/manipulated content in H1 2025. ([Stan Ventures](https://www.stanventures.com/news/ai-slop-is-ruining-reddit-for-everyone-say-moderators-6106/) — 403 to crawler, summary via search index · [winbuzzer, 2025-12-07](https://winbuzzer.com/2025/12/07/reddits-dead-internet-crisis-moderators-battle-ai-slop-while-company-profits-xcxwbn/))
**Note the asymmetry:** Reddit _comments_ are still 98.1% human. Reddit _posts_ are the contaminated surface. So for an assistant writing a **comment**, the ambient suspicion is lower than on LinkedIn — but the community-knowledge bar is much higher.

#### T25. Hacker News — the accusation has become its own noise

Accusation is now a reflex, and a counter-reaction is visible:

- `jamesbaker1`, 2026-09-14: _"ai slop comment and my eyes glaze over"_ ([HN 49692784](https://news.ycombinator.com/item?id=49692784))
- `nubg`, 2026-08-04: _"ai slop comment. post the original prompt"_ ([HN 49172720](https://news.ycombinator.com/item?id=49172720))
- **Counter:** `rkent`, 2026-06-22: _"I'm getting very tired of all of the 'this is ai slop' comments. They are now worse than the slop itself."_ ([HN 48630618](https://news.ycombinator.com/item?id=48630618))
- **Counter:** `rpdillon`, 2026-08-07: _"I'm well past trying to determine whether a human wrote something, and have fallen back to my old ways of critical reading to search for value… if I don't find it, it doesn't matter who wrote it."_ ([HN 49212068](https://news.ycombinator.com/item?id=49212068))
- **Counter:** `matheusmoreira`, 2026-07-13: _"On Lobsters it actually got to the point where I no longer felt welcome on the site, even though I don't use LLMs to generate articles."_ ([HN 48886991](https://news.ycombinator.com/item?id=48886991))
  **Implication for writing:** the goal is not to pass as human. It is to carry enough value that `rpdillon`'s test — is there something here? — returns yes.

#### T26. Support tickets, PRs and bug reports — "confident, well-formatted, completely fabricated"

The recognisable shape is _plausible structure wrapping a non-existent fact_.

- **cURL** shut its 6-year, $86,000 bug bounty in Jan 2026. Daniel Stenberg: by mid-2025 roughly **20% of all submissions were AI slop**, with only ~5% finding real vulnerabilities; the trigger was **seven submissions in sixteen hours**, none actual vulnerabilities. A May 2025 "did you use AI" checkbox didn't save it.
- `dax`, 2026-01-20: _"7 security advisories today all of which did not make sense in the context of our project"_
- Seth Larson (PSF), Dec 2024: _"wasting tons of time on a false report"_
- Craig McLuckie (Stacklok): _"low quality vibe coded slop that takes time away from doing real work"_
- Ghostty (Mitchell Hashimoto): permanent ban for bad AI-generated code. tldraw (Steve Ruiz), Jan 2026: auto-close all external PRs.
  ([RedMonk, 2026-02-03](https://redmonk.com/kholterhoff/2026/02/03/ai-slopageddon-and-the-oss-maintainers/) · [The Register, 2026-02-03](https://www.theregister.com/2026/02/03/github_kill_switch_pull_requests_ai/))
  **Strength: STRONG.** The tell is not prose style — it is _a well-formed artifact whose factual core dissolves on inspection_.

#### T27. Customer-support email — the invented policy

The canonical incident: Cursor's AI support agent "Sam" (Apr 2025) told a user that Cursor _"is designed to work with one device per subscription as a core security feature."_ No such policy existed. The user posted it as official; cancellations followed; the company corrected it three hours later.
**Why people notice:** confident, correctly-formatted, policy-shaped prose asserting something that is not true — and crucially, **no escape hatch**. Operational signs support teams watch: customers repeating the same question, and a spike in requests for a human.
**Strength: STRONG (fatal, in trust terms).**

#### T28. Dating DMs — "chatfishing"

**Verbatim reader reactions:**

- A Virginia dater on an opener reading _"makes a playlist for every life moment energy"_ — a construction _"no human would naturally produce."_
- An opener: _"your smile is effortlessly captivating."_ Recipient: _"No one talks like that."_
- A Californian woman whose date later admitted to ChatGPT: _"There was so much social awkwardness in person. This is what happens when people hide behind a screen."_
  **Named tells:** flawless vocabulary and grammar; polish plus cliché together; round-the-clock availability; **"performative empathy"** — mirroring your hopes and fears back at you to build trust.
  **Scale:** Google searches for "chatfishing" up **5,000%**; 26% of US adults and **49% of Gen Z daters** have used AI for dating help.
  **Critical caveat:** a 2024 study cited on the Chatfishing Wikipedia page found people averaged only **57% accuracy** at telling human from AI text. People _catch_ the bad ones and are confident about it; they do not catch the good ones and are equally confident.
  **Sources:** [TNW, 2026-07-20](https://thenextweb.com/news/chatfishing-ai-dating-apps-chatgpt-claude-tinder-hinge) · [Bloomberg, 2026-07-20](https://www.bloomberg.com/news/features/2026-07-20/chatgpt-claude-infiltrate-dating-apps-by-helping-singles-flirt-with-matches) · [Wikipedia: Chatfishing](https://en.wikipedia.org/wiki/Chatfishing)
  **Strength: STRONG for the clichéd compliment; MODERATE overall.**

---

### 1.4 CONDOLENCE, VOWS, THANK-YOUS — emotional flatness

The tell here is not vocabulary. It is that **the reader's brain registers absent interiority**.

- University of Melbourne (Pursuit / TechXplore, May 2026): _"From wedding vows to retirement speeches, AI is increasingly ghost writing our most intimate moments, and our brains seem to sense something is wrong."_ AI-generated language in personal communication _"lacks the emotional authenticity and idiosyncratic qualities of human expression, leading to reduced cognitive engagement and perceived sincerity."_ ([techxplore, 2026-05](https://techxplore.com/news/2026-05-dont-ai-eulogy.html) · [Pursuit](https://pursuit.unimelb.edu.au/articles/dont-let-ai-give-your-eulogy) — 403 to crawler)
- Quoted position: _"if you've been asked by a person to speak in front of the community… at an important moment in their life and say something meaningful — that is worth your agony and worth your time."_
- **Social consequence is real, not hypothetical:** a June 2026 first-person account of a groom caught using AI for wedding vows, whose partner walked out. Zola's 2026 First Look Report: **63% of couples reject** AI-written vows, while **over a third** of engaged couples draft vows with AI.
  **Writing implication:** in this register, _the specific shared memory is the entire message_. Generic warmth is worse than a two-line note, because generic warmth signals that the sender did not spend the time — which is the only thing a condolence note actually communicates.
  **Strength: STRONG.**

---

### 1.5 THE COUNTER-MOVEMENT (why "just avoid the tells" fails)

- **39%** of 12,600+ surveyed adults _deliberately altered their writing_ to avoid sounding AI-generated; **46%** worry their own writing will be mistaken for machine output; **58%** have seen someone criticised for AI use. (Use.AI survey, Jun 2026, via [detectiondrama.com, verified 2026-08-01](https://detectiondrama.com/avoid-sounding-like-ai-statistics/))
- **35%** would think less of a colleague or creator using undisclosed AI; **34%** would withdraw support.
- Reported tactics: shortened sentences, **deliberately added small imperfections**, em-dashes removed ("long dashes that AI tools still seem obsessed with using"), em-dashes swapped for parentheses, aggressive sentence-length variance.
- **First-person, verbatim:** `tamimio`, HN 2026-02-16: _"I used to be super keen about grammar and typos in texts as well, recently, I have been intentionally keeping some mistakes to prove that a human actually wrote that text… I found that people now assume any perfectly written text is an AI generated and ended up not reading it all."_ ([HN 47040609](https://news.ycombinator.com/item?id=47040609))
- `sieste`, HN 2026-02-17: _"All these forced metaphors and clumsy linguistic flourishes made me cringe. Just add some typos and grammar mistakes like the rest of us to prove that your human."_ (the "your/you're" slip is his own, and is the point) ([HN 47053582](https://news.ycombinator.com/item?id=47053582))
- **Collateral damage is documented.** `jedberg`, 2026-01-28: _"AIs use em dashes because competent writers have been using em dashes for a long time. I really hate the fact that we assume em dash == AI written. I've had to stop using em dashes because of it."_ ([HN 46789300](https://news.ycombinator.com/item?id=46789300)). `kasey_junk`, 2026-09-19: _"This is the real crime of llms on writing. They've taken perfectly reasonable verbal ticks… and caused the audience to rebel against them en masse."_ ([HN 49762521](https://news.ycombinator.com/item?id=49762521)). `OsamaJaber`, 2026-01-31: _"AI detectors punishing non native English speakers for writing too cleanly is the part nobody talks about enough"_ ([HN 46839695](https://news.ycombinator.com/item?id=46839695)).
- **The trap:** Tech Business News notes AI can imitate imperfection too — _"once people associate a particular writing habit with human authorship, there's nothing stopping a generative system from copying the same habit."_ The durable trust signal is _"original documents, photographs, recordings, firsthand observations, and whether the writer has a history of actually engaging with the subjects they write about."_

**Conclusion for an assistant: do not simulate imperfection. Supply substance.**

---

## 2. What people said — verbatim

All HN quotes below were read first-hand via the Algolia API; handles and timestamps are exact.

1. **`lcampbell`, 2026-06-17** — _"> I want to be careful here. was the giveaway for me"_ — [HN 48577416](https://news.ycombinator.com/item?id=48577416)
2. **`dexterlagan`, 2026-08-07** — _"Claude, is that you? I haven't seen a human write like this, ever, and I've read a lot of books. The 'want to be careful here', the 'doing a lot of work'… common."_ — [HN 49216602](https://news.ycombinator.com/item?id=49216602)
3. **`tingling168`, 2026-01-17** — _"You usually can't prove it instantly—but you can smell it fast. AI writing leaves fingerprints… it sounds correct but feels hollow. The sentences are clean, grammatical, and oddly polite. Nothing risks being wrong. Humans leave dents—opinions, hesitations, slightly ugly phrasing. AI sandpapers those off."_ — [HN 46658458](https://news.ycombinator.com/item?id=46658458)
4. **`tingling168`, same comment** — _"No concrete scars, no oddly specific anecdotes, no 'this broke in production at 2am' energy. It knows about things, not through them."_
5. **`tingling168`, same comment** — _"the absence of stakes. There's no sense that being wrong would matter. Human writing often leaks anxiety, pride, frustration, or desire. AI writing feels emotionally insured."_
6. **`invalidusernam3`, 2026-09-23** — _"The proliferation of claudespeak in the workplace is driving me insane. Every ticket, every PR feedback, every comment in the codebase is poisoned with its ridiculous unnatural vocabulary"_ — [HN 49817128](https://news.ycombinator.com/item?id=49817128)
7. **`spdustin`, 2026-09-20** — _"Sorry, I closed the tab after the first two Claude-isms. It's *so* frustrating."_ — [HN 49779384](https://news.ycombinator.com/item?id=49779384)
8. **`mort96`, 2026-09-23** — _"'Rollout artifact'? This is Claude-speak isn't it? I have never ever heard anyone call a bug like this a 'rollout artifact' before."_ — [HN 49815956](https://news.ycombinator.com/item?id=49815956)
9. **`_vertigo`, 2026-09-23 (rebuttal, same thread)** — _"Clearly not Claude-speak… 'Rollout artifact' just means 'an artifact of how we rolled this change out'… Upgrade your Claudish detection"_ — [HN 49816929](https://news.ycombinator.com/item?id=49816929)
10. **`bobmarleybiceps`, 2026-09-24** — _"A recent review of mine had a LLM-ism at the very end, 'would you like me to format this into a formal peer review report?' So they very likely copy-pasted their whole review :)"_ — [HN 49824793](https://news.ycombinator.com/item?id=49824793)
11. **`DonsDiscountGas`, 2026-09-21** — _"Reads like an LLM to me. 'Load bearing' also used a few paragraphs down."_ — [HN 49781824](https://news.ycombinator.com/item?id=49781824)
12. **`wrs`, 2025-07-23** — _"My computer defenestration trigger is when Claude does something very stupid — that also contradicts its own plan that it just made — and when I hit the stop button and point this out, it says 'Great catch!'"_ — [HN 44660567](https://news.ycombinator.com/item?id=44660567)
13. **`avree`, 2025-11-20** — _"'You're absolutely right!' is the Claude cliche (not a ChatGPT one)"_ — [HN 45997585](https://news.ycombinator.com/item?id=45997585)
14. **`aaronbrethorst`, 2026-01-12** — _"Here's the part nobody talks about — This feels like such an obvious LLM tell; it has that sort of breathless TED Talk vibe that was so big in the late oughts."_ — [HN 46585208](https://news.ycombinator.com/item?id=46585208)
15. **`slappywhite`, 2026-04-07** — _"'Quietly' refilling--ugh! This LLM-ish word is everywhere lately and rarely should be."_ — [HN 47677977](https://news.ycombinator.com/item?id=47677977)
16. **`tonyarkles`, 2026-07-17** — _"'Load bearing' and 'belt and suspenders' are two tropes I've used for a long, long time and now I have to be intentional about not using them lest I be accused of offloading my writing."_ — [HN 48946609](https://news.ycombinator.com/item?id=48946609)
17. **`tamimio`, 2026-02-16** — _"I have been intentionally keeping some mistakes to prove that a human actually wrote that text… people now assume any perfectly written text is an AI generated and ended up not reading it all."_ — [HN 47040609](https://news.ycombinator.com/item?id=47040609)
18. **`Wowfunhappy`, 2026-09-24** — *"I just don't understand why people who clearly spent time doing interesting work, which I would like to read about, feel the need to run their findings through an LLM like this. *Please* just talk about what you found! Why do *you* find it interesting or notable? That's what I want to read!"* — [HN 49831957](https://news.ycombinator.com/item?id=49831957)
19. **`rpdillon`, 2026-08-07** — _"I'm well past trying to determine whether a human wrote something… if I don't find [value], it doesn't matter who wrote it."_ — [HN 49212068](https://news.ycombinator.com/item?id=49212068)
20. **`bradfa`, 2026-09-14** — _"This writing style, which reads like an LLM wrote it, is draining to read. I put up with it when I'm actively using an LLM tool… but when reading a blog I expect to read words written in one of the vast varieties of normal human-written blog formats."_ — [HN 49700314](https://news.ycombinator.com/item?id=49700314)
21. **`Zee2`, 2025-10-14**, itemising a post — _"This is AI-written. - Ten em-dashes - 'not just A, but B' … - incessant bullet points/markdown-style formatting - And an overly dramatic/promotional tone"_ — [HN 45584143](https://news.ycombinator.com/item?id=45584143)
22. **`parsimo2010`, 2026-02-13** — _"there is no em-dash on a standard keyboard… The proportion of people who do any of those things in writing for the web is quite small. The number of clearly AI written posts with em-dashes is quite large."_ — [HN 46998100](https://news.ycombinator.com/item?id=46998100)
23. **Virginia dater, via TNW, 2026-07-20** — an opener reading _"makes a playlist for every life moment energy"_, described as a construction _"no human would naturally produce"_
24. **Dating-app recipient, via ESET/PCWorld reporting, 2026** — on _"your smile is effortlessly captivating"_: _"No one talks like that."_
25. **Stephanie Steele-Wren, psychologist, via TIME/Futurism, 2026** — _"There's a real hunger right now for writing that feels unmistakably human, with all the quirks, oddly specific details, and little flashes of personality that AI can't quite mimic."_
26. **Michael Waters, The Atlantic, via Futurism 2026** — _"On a base level, many of us are willing to invest time in reading a long email if we sense that someone actually wrote it, line by line."_
27. **`dax` (maintainer), 2026-01-20, via RedMonk** — _"7 security advisories today all of which did not make sense in the context of our project"_
28. **r/writing rule text, via Pangram** — _"No Generative AI: r/writing is a place for human-created writing. AI slop has no place here."_

---

## 3. What's NEW since mid-2025

Ordered by how much a writer's behaviour should change.

| #   | New since mid-2025                                                                                                                                                        | Evidence                                               | First seen                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| 1   | **"Claudespeak"/"Claudeisms" as a named dialect** distinct from "AI writing"                                                                                              | 6+ HN uses in Sept 2026 alone, no gloss needed         | ~Mar 2026 (HN 47272240), mainstream Jul–Sep 2026 |
| 2   | **"load-bearing"** as the #1 measured Claude marker (>7,500× baseline)                                                                                                    | archiewood/claudeisms; Show HN load-bearing-vocabulary | 2026-07-16 / 2026-08-27                          |
| 3   | **"I want to be careful here"** named as a single-sighting giveaway                                                                                                       | 4 independent HN users, Jun–Aug 2026                   | 2026-06-17                                       |
| 4   | **The closing offer left in** ("would you like me to format this…") as a copy-paste fingerprint                                                                           | HN 49824793                                            | 2026-09-24                                       |
| 5   | **Em-dash demoted.** Only 18.5% of AI inputs contain one; structural tells replace punctuation tells                                                                      | writehuman corpus                                      | 2026-04-21                                       |
| 6   | **"quietly" / depth-manufacturing adverbs** named across Claude, ChatGPT _and_ Gemini                                                                                     | Forbes Feb + May 2026; HN                              | 2026-02-03                                       |
| 7   | **Behaviour-over-text for bot detection** — "bots write well now"                                                                                                         | kitha, superx                                          | 2026                                             |
| 8   | **Comment-level base rates published**: Reddit comments 98.1% human, LinkedIn long-form >40% AI                                                                           | Pangram 1M-post study                                  | 2026-07-15                                       |
| 9   | **"chatfishing"** enters the lexicon; searches +5,000%; 49% of Gen Z daters                                                                                               | TNW/Bloomberg                                          | Oct 2025 coverage → Jul 2026                     |
| 10  | **Deliberate typos as a human signal** — 39% of adults now alter their writing                                                                                            | Use.AI survey                                          | Jun 2026                                         |
| 11  | **Backlash against the accusation itself** ("slop-calling is worse than the slop")                                                                                        | HN 48630618, 49212068, 48886991                        | Jun–Aug 2026                                     |
| 12  | **Maintainer capitulation** — cURL kills its bug bounty; tldraw auto-closes PRs                                                                                           | RedMonk / Register                                     | Jan–Feb 2026                                     |
| 13  | **Tells are model-version-scoped** — "Opus 5.5 writes like gemini"                                                                                                        | HN 49809761                                            | 2026-09-22                                       |
| 14  | **Invented-noun coinages** ("rollout artifact") — and a live dispute about false positives                                                                                | HN 49815956 / 49816929                                 | 2026-09-23                                       |
| 15  | **New-model complaint shifts from flowery to _dense_** — Astra criticised for packing _"as much information in as few tokens as possible, at the expense of readability"_ | HN 49797581                                            | 2026-09-22                                       |

**Retired or weakening since mid-2025:** em-dash-as-proof (contested hard, and measurably weak); "delve/tapestry" (still true, but so widely known it is edited out first, so its absence proves nothing); perfect grammar (people now add errors on purpose).

---

## 4. What readers say makes a reply feel HUMAN

Ranked by evidence strength. The honest summary: **there is strong, repeated evidence for four of these and thin evidence for two**, and I've marked which.

**4.1 A position, taken, without the counterweight. [STRONG evidence]**
_"Real people pick sides, forget disclaimers, or double down when they shouldn't. AI keeps the peace like it's being graded."_ (`tingling168`). The Medium bot guide says the same: humans _"take sides harder when passionate, while bots pivot to neutral ground."_ A reply that presents both sides and lands nowhere reads as machine-written _even when it isn't_. **Disagreement specifically — with the person you're replying to — is close to unfakeable in practice**, because the sycophancy family (T1, T2) is the most recognised tell there is.

**4.2 Lived, oddly specific detail — the kind that doesn't serve the argument. [STRONG]**
_"No concrete scars, no oddly specific anecdotes, no 'this broke in production at 2am' energy. It knows about things, not through them."_ (`tingling168`). Steele-Wren: _"quirks, oddly specific details, and little flashes of personality."_ Forbes Feb 2026 #15 makes the inverse the tell — AI lacks _"accidental details and irrelevant specifics."_ Pangram's Reddit criterion is the community version: _"specific community knowledge that a real person belonging to that community would naturally include."_
**The operative word is _irrelevant_.** A detail that perfectly supports the point reads as constructed. A detail that is merely true reads as remembered.

**4.3 Stakes — evidence that being wrong would cost the writer something. [STRONG]**
_"Human writing often leaks anxiety, pride, frustration, or desire. AI writing feels emotionally insured."_ (`tingling168`). This is also the condolence finding (§1.4) restated: the message is a proxy for time spent, and readers price it that way.

**4.4 Uneven shape — lingering, rambling, rhythm problems. [STRONG]**
_"Paragraphs march in neat formation. Transitions are impeccable. You could reshuffle them and nothing would change. Human writing has rhythm problems and obsessions — it lingers where it shouldn't."_ (`tingling168`). And on vagueness: _"Phrases like 'various factors,' 'a range of considerations'… Humans usually either ramble or overshare instead."_ `tyre`'s banned-moves list independently forbids _"Uniform structure — every paragraph three sentences, every sentence the same length."_

**4.5 A typo left unfixed. [MODERATE — real but degrading]**
Documented as a deliberate practice (`tamimio`, `sieste`; 39% of surveyed adults adding imperfections). But it is the weakest item here and getting weaker: Tech Business News notes AI can be told to add typos too, and once a habit signals humanity it gets copied. **An assistant should not manufacture typos.** The finding to take is the _cause_: over-polish is itself a tell, so don't sand a reply flat.

**4.6 Answering only part of the question; specific humour. [WEAK evidence — flagged honestly]**
I found no direct verbatim reader testimony for either in this corpus. The closest support is indirect: `tingling168`'s _"forget disclaimers"_ and _"ramble or overshare"_ imply partial, uneven coverage; `aalam` (2026-05-02) gestures at humour with _"a score for entropy in playfulness that should differentiate LLM output"_ ([HN 47986860](https://news.ycombinator.com/item?id=47986860)); and `tyre` bans _"anticipate-and-rebut"_, which is the completeness reflex in disguise. Treat both as plausible and untested rather than evidenced.

**4.7 The meta-finding that outranks all six.**
Two independent 2026 HN comments say the same thing, and it is the most actionable sentence in this report:

- `Wowfunhappy`, 2026-09-24: _"Please just talk about what you found! Why do you find it interesting or notable? That's what I want to read!"_
- `rpdillon`, 2026-08-07: _"…critical reading to search for value in the thing I'm reading. And if I don't find it, it doesn't matter who wrote it."_

Readers are not running a detector. They are asking whether anything is there. Every tell in §1 is a proxy for _emptiness dressed as insight_ — the announced payoff that doesn't arrive (T8–T10), the balance that costs nothing (T20), the validation that isn't earned (T1, T2, T16), the tidy coherence with no friction (T18). **Say one true specific thing and most of the tells become structurally impossible to produce.**

---

## 5. Sources

**Read first-hand, verbatim (Hacker News via Algolia API):**
44660567 · 44885398 · 44888281 · 45443170 · 45584143 · 45997585 · 46585208 · 46658458 · 46789300 · 46839695 · 46998100 · 47040609 · 47053582 · 47053177 · 47677977 · 47986860 · 48577416 · 48578557 · 48598544 · 48598839 · 48630618 · 48886991 · 48928537 · 48937785 · 48941411 · 48946609 · 49172720 · 49212068 · 49216602 · 49265943 · 49413456 · 49461817 · 49475944 · 49692784 · 49700314 · 49762521 · 49772455 · 49779384 · 49781824 · 49785768 · 49796967 · 49797581 · 49809761 · 49812186 · 49815956 · 49816929 · 49817128 · 49822964 · 49823293 · 49823350 · 49824793 · 49826174 · 49828306 · 49831957 · 49535005
(pattern: `https://news.ycombinator.com/item?id=<id>`)

**Projects / datasets**

- [github.com/archiewood/claudeisms](https://github.com/archiewood/claudeisms) — 175 Claude Code sessions (140 MB) vs Stack Overflow; ratio table. 2026-07-16.
- _Show HN: The load-bearing vocabulary of Claude_ — ~50M words/day of GitHub PR descriptions. [HN 49461817](https://news.ycombinator.com/item?id=49461817), 2026-08-27.
- [GitHub issue anthropics/claude-code#3382](https://github.com/anthropics/claude-code/issues/3382) — "Claude says 'You're absolutely right!' about everything".

**Press / analysis**

- [Bloomberg, 2026-01-30 — LinkedIn posts, emoji forensics](https://www.bloomberg.com/news/articles/2026-01-30/chatgpt-written-linkedin-posts-have-users-analyzing-emojis-other-ai-signs)
- [Bloomberg, 2026-07-20 — ChatGPT/Claude on dating apps](https://www.bloomberg.com/news/features/2026-07-20/chatgpt-claude-infiltrate-dating-apps-by-helping-singles-flirt-with-matches)
- [TechTimes, 2026-07-15 — Pangram 1M-post platform study](https://www.techtimes.com/articles/320534/20260715/linkedin-leads-all-platforms-ai-written-posts-study-million-feeds-confirms.htm)
- [Forbes (Jodie Cook), 2026-02-03 — 15 giveaway signs](https://www.forbes.com/sites/jodiecook/2026/02/03/the-15-new-giveaway-signs-of-ai-generated-content-in-february-2026/) · full list mirrored at [freerepublic, 2026-07-09](https://freerepublic.com/focus/f-chat/4387361/posts)
- [Forbes (Jodie Cook), 2026-05-21 — May update](https://www.forbes.com/sites/jodiecook/2026/05/21/15-new-giveaway-signs-of-ai-writing-may-2026-update/)
- [writehuman.ai, 2026-04-21 — "The Real Signature of AI Writing Isn't the Em-Dash Anymore"](https://writehuman.ai/blog/ai-tells-in-2026)
- [pangram.com — How to Detect AI on Reddit](https://www.pangram.com/blog/how-to-detect-ai-on-reddit)
- [hiration.com, 2026 — Is AI Writing Your LinkedIn Hurting You? The 2026 AI-Slop Backlash](https://www.hiration.com/blog/ai-slop-linkedin/)
- [PCWorld, 2026-03-31 — 6 red flags that message was written by ChatGPT](https://www.pcworld.com/article/3101116/busted-6-red-flags-that-message-was-written-by-chatgpt.html)
- [TNW, 2026-07-20 — chatfishing](https://thenextweb.com/news/chatfishing-ai-dating-apps-chatgpt-claude-tinder-hinge) · [Wikipedia: Chatfishing](https://en.wikipedia.org/wiki/Chatfishing)
- [kitha.co, 2026 — How to Spot AI Bot Replies on X](https://www.kitha.co/blog/how-to-spot-ai-bot-replies-on-x) · [superx.so — AI Bot Twitter Guide 2026](https://superx.so/blog/ai-bot-twitter)
- [RedMonk, 2026-02-03 — AI Slopageddon and the OSS Maintainers](https://redmonk.com/kholterhoff/2026/02/03/ai-slopageddon-and-the-oss-maintainers/) · [The Register, 2026-02-03](https://www.theregister.com/2026/02/03/github_kill_switch_pull_requests_ai/)
- [Write With AI, 2025-09-21 — 10 dead giveaways](https://writewithai.substack.com/p/10-dead-giveaways-your-content-screams)
- [detectiondrama.com, verified 2026-08-01 — Use.AI survey statistics](https://detectiondrama.com/avoid-sounding-like-ai-statistics/)
- [Futurism, 2026 — People Are Loading Their Writing With Typos to Prove They're Not AI](https://futurism.com/artificial-intelligence/typos-ai-humans-authentic)
- [techxplore, 2026-05 — Don't let AI give your eulogy](https://techxplore.com/news/2026-05-dont-ai-eulogy.html) (Univ. of Melbourne)
- [Tech Business News — Human Imperfection May Become a Trust Signal](https://www.techbusinessnews.com.au/human-imperfection-may-become-a-trust-signal-amid-the-growth-of-ai-content-creation/)
- [Stan Ventures — AI Slop Is Ruining Reddit, Say Moderators](https://www.stanventures.com/news/ai-slop-is-ruining-reddit-for-everyone-say-moderators-6106/) · [winbuzzer, 2025-12-07](https://winbuzzer.com/2025/12/07/reddits-dead-internet-crisis-moderators-battle-ai-slop-while-company-profits-xcxwbn/)
- [Medium — How to Spot an LLM Bot in Your Comments (2025–2026 Edition)](https://medium.com/@sherylclyde_94933/how-to-tell-if-the-person-commenting-on-a-post-is-a-bot-or-not-7cb807660a6e)
- [Entrepreneur, 2024-10-15 — 9 dead giveaways](https://www.entrepreneur.com/science-technology/9-dead-giveaways-ai-wrote-a-story/481330) (baseline; largely superseded)

**Blocked / not reachable from this environment (declared, not silently dropped):** reddit.com (all paths, incl. JSON API), old.reddit.com, redlib + safereddit mirrors, Bluesky public API, forbes.com direct fetch, pursuit.unimelb.edu.au, stanventures.com, af.net. Where these are cited above, the content came via search-index summaries or third-party quotation and is labelled as such.
