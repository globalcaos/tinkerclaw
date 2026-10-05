# THE CRAFT: writing like a clear, natural human in emails, chat, and code-change explanations

**Scope.** Target language: English. Target reader: a busy technical owner who did not review the
code, reads on a phone half the time, and has already paid for the work — they want the outcome,
not the journey. Research date: 2026-09-24. Every claim below is either sourced (URL inline and in
§5) or explicitly marked **[inference]** — my own reasoning from the sourced material, not a
finding.

**What this is FOR:** helping an assistant write prose a human would actually have written. It is
NOT a detector-evasion guide. Detector evasion and good writing point in the same direction for
about 80% of the distance and then diverge: evasion says "insert typos and fragments to look
human" (documented as a real and damaging cultural response —
[Vollmer, "paranoia spiral"](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself)),
craft says "have something specific to say and say it in the fewest words that carry it." Follow
craft. The tells disappear as a side effect.

---

## PART 0 — The craft foundations (what the primary sources actually say)

### 0.1 Rogers & Lasky-Fink, _Writing for Busy Readers_ (2023) — the six principles

Verbatim from the authors' own one-page checklist
([PDF](https://writingforbusyreaders.com/wp-content/uploads/2023/10/Writing-for-Busy-Readers-Checklist.pdf),
© Rogers and Lasky-Fink 2023):

1. **Less Is More** — (1) Use fewer words. (2) Include fewer ideas. (3) Make fewer requests.
2. **Make Reading Easy** — (1) Use short and common words. (2) Write straightforward sentences.
   (3) Write shorter sentences.
3. **Design for Easy Navigation** — (1) Make key information immediately visible. (2) Separate
   distinct ideas. (3) Place related ideas together. (4) Order ideas by priority. (5) Include
   headings. (6) Consider using visuals.
4. **Use Enough Formatting but No More** — (1) Match formatting to readers' expectations.
   (2) Highlight, bold, or underline the most important ideas. (3) **Limit your formatting.**
5. **Tell Readers Why They Should Care** — (1) Emphasize what readers value ("So what?").
   (2) Emphasize which readers should care ("Why me?").
6. **Make Responding Easy** — (1) Simplify the steps required to act. (2) Organize key information
   needed for action. (3) Minimize the amount of attention required.

**The evidence, with numbers** ([Behavioral Scientist,
2023](https://behavioralscientist.org/when-writing-for-busy-readers-less-is-more/)):

- Field experiment, 7,002 US school board members. Wordy email (127 words) → **2.7%** response
  rate. Concise email (49 words) → **4.8%** response rate. Cutting words nearly doubled response.
- The same survey took ~5 minutes either way. But 29% of concise-email readers expected it to take
  under 5 minutes, vs 15% of wordy-email readers. **Length is read as a proxy for cost.**
- Adams et al. (Virginia): when asked to edit, **83% of people ADD words.** Cutting is the
  unnatural act; it has to be deliberate.
- Related Rogers co-authored field trial, N = 131,312: rewriting legalistic truancy notices in
  simplified language cut absences by ~40% relative to the standard notice
  ([Educational Researcher, 2021](https://journals.sagepub.com/doi/10.3102/0013189X211000749)).

**Note principle 4 is the one AI assistants break.** It is not "use formatting." It is _use enough
and no more_, and "remove it from information that is not critical." Bolding every line is
formatting that carries zero information, because emphasis is defined by contrast. [inference]

### 0.2 BLUF / answer-first

Bottom Line Up Front is the US military writing standard: begin with the key information; the
opening should answer who/what/where/when/why and state the action required
([Wikipedia](<https://en.wikipedia.org/wiki/BLUF_(communication)>); [Beale AFB
commentary](https://www.beale.af.mil/News/Commentaries/Display/Article/280275/bottom-line-up-front/)).
It differs from an executive summary by being shorter and by naming the ask. Canonical shape:
`BLUF: I need X from you by <date>, because <one clause>.` Then context.

Why it works on a screen: users read ~20–28% of the words on a page, scan rather than read, and
scan in an F-pattern with the strongest attention on the first lines
([NN/g](https://www.nngroup.com/articles/f-shaped-pattern-reading-web-content-discovered/)).
Information placed after paragraph three is, statistically, not read.

### 0.3 Gopen & Swan, "The Science of Scientific Writing" (_American Scientist_, 1990)

The key reframe: readers spend a fixed budget of energy on _structure_ and whatever is left on
_content_. Bad structure does not just annoy; it consumes the attention that comprehension needed.
([PDF](https://www.gatsby.ucl.ac.uk/~pel/misc/gopen_swan.pdf))

- **Topic position** (sentence opening): where the reader looks for _context_ and _what this is
  about_. Put the OLD, already-known thing here — it links to the previous sentence.
- **Stress position** (sentence end, at a point of syntactic closure): where the reader
  automatically applies emphasis. Put the NEW information, the thing you want remembered, here.
- **Subject–verb proximity**: "the farther apart the subject and verb appear, the harder readers
  must work." Follow the grammatical subject with its verb as soon as possible.
- **One unit, one point**: every unit of discourse, whatever its size, should serve a single
  function.

The practical version for chat and email: **end sentences on the payload, not on a qualifier.**
"The build is fixed, although I have not tested on Windows" buries the caveat's importance; "The
build is fixed on Linux and macOS; Windows is untested" puts both facts in stress positions.
[inference, applying Gopen & Swan]

### 0.4 Orwell's six rules (_Politics and the English Language_, 1946)

1. Never use a metaphor, simile, or other figure of speech which you are used to seeing in print.
2. Never use a long word where a short one will do.
3. If it is possible to cut a word out, always cut it out.
4. Never use the passive where you can use the active.
5. Never use a foreign phrase, a scientific word, or a jargon word if you can think of an everyday
   English equivalent.
6. **Break any of these rules sooner than say anything outright barbarous.**
   ([Duke summary](https://sites.duke.edu/scientificwriting/orwells-6-rules/))

Rule 1 is the one that matters most for AI writing and the one most often forgotten: the objection
is not to metaphor, it is to _pre-owned_ metaphor. "Rich tapestry," "shed light on," "at its core"
are fossils. Rule 6 is the escape hatch: the rules serve the sentence, not the reverse.

### 0.5 Plain-language guidance (GOV.UK; plainlanguage.gov)

GOV.UK's A-to-Z bans a specific list of abstract verbs and demands a concrete replacement
([guidance.publishing.service.gov.uk](https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/style-guides/a-to-z-style-guide/)).
A selection, verbatim mapping:

`agenda→plan` · `advance→improve` · `collaborate→work with` · `combat→solve, fix` ·
`deliver→make, create, provide` (pizzas and post are delivered; improvements are not) ·
`deploy→use, build, put into place` (unless military or software) · `dialogue→discussion` ·
`empower→allow` · `facilitate→<say what you actually did>` · `focus→work on` · `foster→encourage,
help` · `impact→affect, influence` · `initiate→start` · `key→important` · `leverage→use` ·
`liaise→work with` · `overarching→encompassing` · `promote→recommend, support` ·
`robust→well thought out` · `streamline→simplify` · `tackle→stop, solve, deal with` ·
`transform→<describe the specific change>` · `utilise→use`

Dead metaphors GOV.UK also bans: `drive→cause, encourage` · `going/moving forward→from now on` ·
`in order to→to` · `hub / portal / one-stop shop→website` · `ring fencing→separate`.

Note the overlap with the AI-vocabulary lists in §2 is near-total. **Most "AI tells" are just the
abstract-institutional register that plain-language movements have been fighting since the 1970s.**
AI did not invent this dialect; it learned it from corporate and academic prose and now emits it at
volume. [inference — but see §4, where several practitioners say the same thing independently]

### 0.6 Paul Graham — "Write Simply" and "Writing, Briefly"

From ["Write Simply"](https://paulgraham.com/simply.html): "The easier something is to read, the
more deeply readers will engage with it." "The less energy they expend on your prose, the more
they'll have left for your ideas." And the test that matters: **"If you say nothing simply, it will
be obvious to everyone, including you."** Complexity is where empty claims hide. Graham also flags
non-native readers: many people understand the _idea_ more easily than the difficult English.

From ["Writing, Briefly"](https://paulgraham.com/writing44.html) — the operational advice, condensed:
write a bad version 1 fast and rewrite repeatedly; **cut out everything unnecessary**; write in a
conversational tone; if stuck, tell someone your topic and then write what you said; be confident
enough to cut; **don't try to sound impressive**; read it aloud to find the awkward and boring
parts; **use simple, Germanic words**; write for readers less careful than you; tell readers
something new and useful.

"Tell someone your topic, then write what you said" is the single most useful anti-AI-voice
technique available, because speech has none of the register inflation. [inference]

### 0.7 Gretchen McCulloch, _Because Internet_ (2019) — how people actually write in chat

Informal writing is not degraded formal writing; it is a separate system that evolved its own tone
markers to replace the ones speech has.

- **Typographical tone of voice.** Since chat carries no prosody, writers repurpose typography:
  ALL CAPS = shouting/intensity, _asterisks_ and ~tildes~ for emphasis, and all-lowercase
  "minimalist typography" reading as deadpan or sarcastic monotone
  ([Wikipedia](https://en.wikipedia.org/wiki/Because_Internet);
  [Notion interview](https://www.notion.com/blog/gretchen-mcculloch)).
- **The period is now marked.** In a short chat reply, a full stop adds formality, and formality in
  an informal frame reads as distance or irritation. Binghamton University's experiment ("Texting
  insincerely: the role of the period in text messaging", 126 undergraduates) found one-word
  positive replies — _Okay. Sure. Yeah. Yup._ — were rated **less sincere with a period than
  without**, with no such effect in handwritten versions; exclamation points read as _more_ sincere
  ([ScienceDaily](https://www.sciencedaily.com/releases/2015/12/151208094229.htm);
  [APS](https://www.psychologicalscience.org/news/in-texting-punctuation-conveys-different-emotions-period.html)).
- **Message splitting is punctuation.** People who grew up with unmetered messaging use a new
  message or a line break where speech would have a pause — the send button does the work a comma
  or a paragraph break does in prose ([Notion interview](https://www.notion.com/blog/gretchen-mcculloch)).
  Consequence: a single dense paragraph in a chat window is a register error, but so is a
  bulleted list. The native form is 2–4 short lines.
- **Emoji inflate like hyperbole.** Once everyone uses 😂 it stops meaning anything and the
  community moves to 💀. Emoji are gesture, not decoration — which is why 🚀 and ✅ in a _heading_
  are wrong: nobody gestures at a section title. [inference from McCulloch's gesture framing]
- **Stock phrases are social, not informational.** "Circling back", "bumping this onto your radar"
  exist to show you're a member of the group, and McCulloch declines to sneer at them. Useful
  correction to the "cut all filler" instinct: a small amount of phatic language is how humans
  signal relationship. Zero is as marked as too much.
- **Lowercase-no-punctuation is a community membership signal** and can be used deliberately to
  invite or discourage engagement.

### 0.8 Email length and openers — dated evidence

- Boomerang, 2016, ~40M emails: responses peak in the **50–125 word** band; **75–100 words got a
  51% response rate**. Rates decline slowly from ~50% at 125 words to ~44% at 500 words, and a
  25-word email does about as badly as a 2,000-word one (~44%) — so there is a floor as well as a
  ceiling ([Boomerang](https://blog.boomerangapp.com/2016/02/7-tips-for-getting-more-responses-to-your-emails-with-data/);
  [summary](https://emailanalytics.com/ideal-email-length/)). Treat as directional, not physics —
  it is sales-email data, now a decade old.
- **"I hope this email finds you well"** is now actively counterproductive: unoriginal, meaningless,
  delays the point, and — the new part — it is the default AI opener, so inboxes are saturated with
  it ([Grammarly](https://www.grammarly.com/blog/writing-tips/i-hope-this-email-finds-you-well/);
  [LanguageTool](https://languagetool.org/insights/post/word-choice-i-hope-this-emails-finds-you-well/)).
  Replacement: the reason you are writing, or one concrete specific ("Saw the deploy went out
  Friday —").

### 0.9 How good engineers explain changes

**Commit messages** (Tim Pope 2008 → [Chris Beams, cbea.ms/git-commit](https://cbea.ms/git-commit/)):
separate subject from body with a blank line; subject ≤ 50 chars; capitalise; no trailing period;
**imperative mood** ("Fix crash", not "Fixed crash" — the subject completes _"If applied, this
commit will…"_); wrap body at 72; **use the body to explain what and why, not how.** The governing
insight: _the diff already shows what changed; only the message can say why._

**PR descriptions**: what changed, why, how it was tested, what the risks are, where the reviewer
should look hardest — and state the primary change in the **first sentence**, so someone scanning a
list of open PRs gets it instantly. Keep the template short enough to actually be filled in; a
fifteen-checkbox template gets rubber-stamped
([Kodus](https://kodus.io/en/best-practices-for-pull-requests/);
[Awesome Code Reviews](https://www.awesomecodereviews.com/pull-request-template/)).

**Incident write-ups** ([Google SRE postmortem culture](https://sre.google/sre-book/postmortem-culture/)):
the executive summary is two or three paragraphs covering _what happened, user impact, duration,
how service was restored, and the most important planned changes._ Blameless means describing
systemic causes — process gaps, tool limits, missing documentation — without indicting a person,
and assuming everyone acted reasonably on the information they had. Impact is stated in user terms
and in time, not in stack traces.

**Release notes / changelogs**: answer "does this affect me?" in the first sentence. The field test —
finish the sentence _"here's what you can do now that you couldn't before"_; if you can't, the item
probably doesn't belong in user-facing notes ([Beamer](https://www.getbeamer.com/blog/changelog-or-release-notes);
[Appcues](https://www.appcues.com/blog/release-notes-examples)).

**Explaining to a non-reviewing owner**: lead with business impact, drop the technical process,
close with what happens next; replace jargon with the plain phrase ("data ingestion" → "how we
collect and organise information"); use analogy sparingly; offer depth rather than imposing it
("want the detail on any of that?")
([Stanford Online](https://online.stanford.edu/10-tips-communicating-technical-ideas-non-technical-people);
[Mercedes Bernard](https://mercedesbernard.com/blog/how-to-talk-technical/)).

**Synthesis — the four-move shape for any change explanation** [inference, from the commit/PR/
changelog/incident sources above, which all converge on it]:
`what changed → why → what you'll notice → what I did NOT do`.
The fourth move is the one almost nobody writes and the one an owner most needs, because it is the
only part they cannot infer from the working system. It also pre-empts the false impression of
completeness that a tidy summary creates.

### 0.10 Honest uncertainty, and polite disagreement

**Uncertainty.** The rationalist "epistemic status" convention exists precisely so a writer can
state a conclusion _confidently_ while flagging how much to trust it — the alternative is either
false confidence or hedging every sentence into mush
([LessWrong](https://www.lesswrong.com/posts/Hrm59GdN2yDPWbtrd/feature-idea-epistemic-status);
[EA Forum explainer](https://forum.effectivealtruism.org/posts/bbtvDJtb6YwwWtJm7/epistemic-status-an-explainer-and-some-thoughts)).
The "epistemic effort" variant is better still for engineering: state _what you actually did to
check_, not how you feel ([LessWrong](https://www.lesswrong.com/posts/oDy27zfRf8uAbJR6M/epistemic-effort)).

The honest-uncertainty pattern in practice is **localised and specific**, never diffuse:

- Good: "Tested on Linux only. I'd give it 80% that it works on Windows — the path handling is the
  part I'd check first."
- Bad: "It should generally work, though results may vary depending on your environment."
  The first tells you where to look. The second is insurance. [inference]

Calibration language research supports verbal confidence phrases over numbers for human readers —
people reason poorly with raw probabilities but read "I'm fairly sure / I haven't checked / I'm
guessing" correctly ([Calibrating Expressions of Certainty, arXiv:2410.04315](https://arxiv.org/pdf/2410.04315)).

**Disagreement.** The working advice converges on: acknowledge the other position in one clause,
state your own position plainly, give the concrete reason, leave the decision with them
([Grammarly](https://www.grammarly.com/blog/workplace-communication/respectfully-disagree/)).
Avoid _wrong, bad, nonsense_. But note the failure mode in the other direction — "I appreciate your
input; however, I respectfully disagree" is itself boilerplate and now reads as AI. The human
version is shorter and more specific: **"I'd push back on the second one — <reason>. Your call
though."** [inference]

For code review specifically, [Conventional Comments](https://conventionalcomments.org/) solves the
tone problem structurally rather than lexically: prefix the comment with its own severity —
`praise:`, `nitpick:`, `suggestion:`, `issue:`, `question:`, `thought:`, `chore:`, plus decorations
`(blocking)` / `(non-blocking)` / `(if-minor)`. The severity travels with the words, so you don't
have to soften the words to signal that something is optional.

---

## PART 1 — Tells taxonomy

Format: **name** → examples → natural rewrite → strength → sources.

**Strength key.** **STRONG** = almost only AI produces this; a single instance is real evidence.
**MODERATE** = humans do it, but AI does it at a density humans don't sustain; judge by frequency.
**WEAK** = common in human writing, high false-positive rate; listed because it _contributes_ to the
composite impression, not because it convicts. The literature is unanimous that **density and
co-occurrence, not any single marker, is the actual signal**
([Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)).

### 1.1 The negated contrast — "It's not just X, it's Y"

- "It's not just about efficiency — it's about transformation."
- "This isn't a bug fix; it's a rethink of how the cache works."
- "We're not merely building software; we're rewriting the rules."
- **Rewrite:** "It's faster, and the cache logic is simpler now." (State the two facts. Drop the
  rhetorical escalation.)
- **STRONG** at density; MODERATE for a single instance (debate-trained humans use it deliberately).
  ChatGPT emitted a version of "not just X, but Y" in ~6% of chats.
- Sources: [Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) ·
  [Vollmer](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself) ·
  [Yahoo/WaPo style analysis](https://www.yahoo.com/news/articles/clues-chatgpt-wrote-something-analyzed-214947550.html) ·
  HN [48503918](https://news.ycombinator.com/item?id=48503918), [46127293](https://news.ycombinator.com/item?id=46127293)

### 1.2 Tricolon / rule of three

- "Fast. Simple. Effective."
- "No fluff. No filler. No stress."
- "I cleaned up the config, tightened the tests, and documented the flow." (the benign version)
- **Rewrite:** use two items, or four, or an uneven list. "I cleaned up the config and tightened the
  tests." Three parallel items in a row, repeatedly, is the tell — not any single triple.
- **MODERATE** — rhetorically trained humans love this; AI cannot stop.
- Sources: [Vollmer](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself) ·
  HN [44629579](https://news.ycombinator.com/item?id=44629579) ("Spams of groups of threes")

### 1.3 Significance inflation

- "This commit stands as a testament to the team's commitment to quality."
- "The config file plays a crucial role in the deployment pipeline."
- "This marks a pivotal moment in the project's evolution."
- **Rewrite:** "The config file sets the deploy target." Say what the thing does. Importance is for
  the reader to conclude.
- **STRONG** — the "significance" register applied to ordinary facts is the most reliable single
  tell in the Wikipedia catalogue.
- Sources: [Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) ·
  [Worldcom summary](https://worldcomgroup.com/insights/how-to-spot-ai-writing-tips-from-wikipedia-on/)

### 1.4 Avoidance of plain "is" and "has"

- "The module **serves as** the entry point." → "The module **is** the entry point."
- "The repo **boasts** 200 tests." → "The repo **has** 200 tests."
- "This function **functions as** a wrapper." → "This function wraps `fetch`."
- **STRONG** at density. There is no reason to avoid _is_; avoiding it is a trained stylistic
  reflex, not a choice.
- Sources: [Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)

### 1.5 Signposting filler

- "It's important to note that the migration is reversible."
- "It's worth noting that this only affects staging."
- "When it comes to performance, the change is neutral."
- "At its core, the problem was a race condition."
- **Rewrite:** delete the frame. "The migration is reversible." "This only affects staging." "It was
  a race condition." Every one of these phrases is removable with zero information loss — which is
  the definition of filler.
- **STRONG** at density (three-plus in a short message), MODERATE singly.
- Sources: [Vollmer](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself) ·
  [Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)

### 1.6 Sycophantic opener

- "Great question!"
- "You're absolutely right to push back on this."
- "What a thoughtful observation!"
- **Rewrite:** answer the question. If they were right, "Yes — you're right, I had the direction
  backwards" carries the same acknowledgement attached to actual content.
- **STRONG.** OpenAI itself conceded in April 2025 that GPT-4o had become "overly flattering or
  agreeable — often described as sycophantic" and rolled the update back; the residue is still the
  single most recognisable AI opener.
- Sources: [Vollmer](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself) ·
  [PCWorld](https://www.pcworld.com/article/3179916/claude-ranked-my-sounds-like-ai-writing-habits.html)

### 1.7 Completion boilerplate — "I have successfully…"

- "I have successfully implemented the requested changes."
- "I've gone ahead and updated the configuration file."
- "The task has been completed successfully."
- **Rewrite:** "Done — the retry now backs off instead of hammering." Or just say what it does now.
  _Successfully_ is doing no work: nobody writes "I have unsuccessfully implemented."
- **STRONG** for assistant output specifically. A human engineer writes "pushed it" or "that's in".
- Sources: [inference, strongly supported by] the assistant-register complaints in
  [Vollmer §Tonal](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself) ·
  HN [48508216](https://news.ycombinator.com/item?id=48508216)

### 1.8 Restating the question before answering

- "You asked whether the cache invalidation is working. Let me walk you through what I found."
- "To answer your question about the deploy failing: the deploy was failing because…"
- **Rewrite:** "Cache invalidation works. The stale entries were coming from the CDN, not us."
- **MODERATE–STRONG.** Humans do this in formal correspondence; in chat, answering-by-restating is
  almost purely a model behaviour, and it is the single biggest source of dead words in assistant
  replies. Directly contradicts BLUF.
- Sources: [BLUF](<https://en.wikipedia.org/wiki/BLUF_(communication)>) · [inference]

### 1.9 Bold-stemmed bullets where prose belongs

- "**Root cause:** A race condition. **Fix:** Added a mutex. **Testing:** Ran the suite. **Impact:**
  None for users."
- **Rewrite:** "Two threads were writing the same file; I added a lock. Tests pass. Nothing changes
  for users."
- **STRONG** in short messages. Four facts and twelve words of scaffolding is a formatting-to-
  content ratio no human sustains. Violates _Writing for Busy Readers_ principle 4 ("limit your
  formatting") — emphasis works by contrast, so bolding everything bolds nothing.
- Sources: [Vollmer, "bold-stemmed nested bullet lists where paragraph prose would do"](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself) ·
  [OpenAI community bug thread on excessive bullets](https://community.openai.com/t/excessive-bullet-point-formatting-issue-in-chatgpt-responses/1097391) ·
  [Busy Readers checklist](https://writingforbusyreaders.com/wp-content/uploads/2023/10/Writing-for-Busy-Readers-Checklist.pdf)

### 1.10 Headers over three lines of content

- `## Summary` / `## Changes Made` / `## Next Steps` — each with one sentence under it.
- **Rewrite:** three sentences, no headers. Headers are navigation aids; navigating five lines is
  not a task.
- **STRONG** in chat/email, WEAK in documents.
- Sources: [Busy Readers principle 3/4](https://writingforbusyreaders.com/wp-content/uploads/2023/10/Writing-for-Busy-Readers-Checklist.pdf) ·
  HN [44703440](https://news.ycombinator.com/item?id=44703440) ("numbered lists, 'Key Takeaways'")

### 1.11 Emoji in section headings

- "🚀 Deployment" · "🔑 Key Findings" · "✅ What I Did" · "💡 Recommendation"
- **Rewrite:** drop them. If the channel is emoji-native, an emoji belongs _in a sentence_ as
  gesture ("that build took 40 minutes 😐"), not stapled to a heading.
- **STRONG.** Per McCulloch, emoji function as gesture; there is no gesture that accompanies a
  section title. By July 2025, ~70% of ChatGPT messages contained at least one emoji.
- Sources: [Vollmer](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself) ·
  [Yahoo/WaPo](https://www.yahoo.com/news/articles/clues-chatgpt-wrote-something-analyzed-214947550.html) ·
  HN [48224690](https://news.ycombinator.com/item?id=48224690) ("long dashes and emoji lists") ·
  [McCulloch](https://www.notion.com/blog/gretchen-mcculloch)

### 1.12 Em dash overuse

- "The fix — which touches three files — is small, but the test — added last — matters more."
- **Rewrite:** vary. Use a comma, a semicolon, brackets, or a full stop. Keep one em dash where it
  earns its keep.
- **WEAK individually — flag the false positive loudly.** Em dashes are correct, long-established
  punctuation. HN is full of people objecting that they have used them for 10–15 years and now get
  accused. The tell is _rate and monotony_: >3 per 500 words, and used additively where a comma
  would serve, rather than for interruption. Em-dash usage also dropped in GPT-5.1, so this marker
  is decaying.
- Sources: HN [46789300](https://news.ycombinator.com/item?id=46789300), [44308161](https://news.ycombinator.com/item?id=44308161),
  [49586484](https://news.ycombinator.com/item?id=49586484), [43668490](https://news.ycombinator.com/item?id=43668490) ·
  [Vollmer](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself)

### 1.13 Closing ritual / cheap warmth

- "Hope this helps!"
- "Let me know if you'd like me to go deeper!"
- "Please let me know if there's anything else I can help with!"
- "In conclusion, the migration is complete."
- **Rewrite:** end on the last real fact, or on a specific offer: "Want me to do staging too?"
  A specific offer is useful; a generic one is a verbal bow.
- **STRONG** when generic, especially with the exclamation mark.
- Sources: [Vollmer §Tonal sprinkle and §Email](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself)

### 1.14 Hedge-and-reassure / both-sides mush

- "While this may vary depending on your setup, generally speaking it should work in most cases."
- "There are valid arguments on both sides; the truth likely lies somewhere in between."
- **Rewrite:** "It works on Linux. I haven't tried Windows." Name the specific unknown, then stop.
- **STRONG** when stacked (two or more hedges in one sentence). Note this is listed as a
  _Claude-specific_ fingerprint — heavier hedging, "it's worth noting," "generally speaking."
- Sources: [Vollmer §Model-specific fingerprints](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself) ·
  [Yahoo/WaPo: "risk-averse… unwillingness to commit"](https://www.yahoo.com/news/articles/clues-chatgpt-wrote-something-analyzed-214947550.html)

### 1.15 Abstract prestige nouns

- "the security landscape" · "a rich tapestry of integrations" · "the deployment realm" ·
  "the testing ecosystem"
- **Rewrite:** name the thing. "our security setup", "the integrations", "deploys", "the tests".
- **STRONG** — _tapestry_ in particular is near-diagnostic.
- Sources: [Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) ·
  [Wikipedia talk archive](https://en.wikipedia.org/wiki/Wikipedia_talk:Signs_of_AI_writing/Archive_1) ·
  [Vollmer](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself)

### 1.16 Verb inflation

- "We leveraged the existing cache to facilitate faster lookups."
- "This utilises the new API to streamline the workflow."
- **Rewrite:** "We reused the cache, so lookups are faster." "It uses the new API, which cuts a
  step."
- **MODERATE** — corporate humans write this too. That is exactly why GOV.UK banned the words; AI
  inherited the register.
- Sources: [GOV.UK A–Z](https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/style-guides/a-to-z-style-guide/) ·
  [Vollmer](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself)

### 1.17 Participial tail

- "I moved the retry into the worker, **marking a significant improvement in reliability.**"
- "The patch removes the lock, **thereby enhancing throughput.**"
- **Rewrite:** cut the tail, or make it a real clause with a real number. "I moved the retry into
  the worker. Failed jobs dropped from ~12/day to 0 yesterday."
- **STRONG.** The tail is nearly always a restatement of the main clause dressed as an insight, and
  it violates Gopen & Swan by putting _nothing_ in the stress position.
- Sources: [Vollmer §Syntactic](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself) ·
  [Gopen & Swan](https://www.gatsby.ucl.ac.uk/~pel/misc/gopen_swan.pdf)

### 1.18 Uniform rhythm (low burstiness)

- Every paragraph 3–5 sentences; every sentence 14–22 words; no fragments; no one-line paragraph.
- **Rewrite:** let length follow content. A four-word sentence after a long one is how emphasis
  works in speech. "That was the bug."
- **MODERATE**, and it is the tell readers feel without being able to name. Wikipedia editors
  independently identified an apparent instruction to "keep paragraphs around the same length
  (3–5 sentences)."
- Sources: [Wikipedia talk archive, editor Foxtail286](https://en.wikipedia.org/wiki/Wikipedia_talk:Signs_of_AI_writing/Archive_1) ·
  [Vollmer §Uniform sentence length](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself) ·
  [Yahoo/WaPo, "paragraph uniformity"](https://www.yahoo.com/news/articles/clues-chatgpt-wrote-something-analyzed-214947550.html)

### 1.19 Missing concrete particulars

- "The change improves performance significantly across a range of scenarios."
- "Several issues were identified and addressed."
- **Rewrite:** "P95 went from 800 ms to 210 ms on the search endpoint." "Two bugs: the null check in
  `parse()` and the off-by-one in the pager."
- **STRONG.** Absence of proper nouns, dates, file names, and numbers is one of the most reliable
  markers — and the easiest to fix, because the specifics exist; they were just smoothed away.
  (Related corollary: when AI invents a specific, it is often a fictional person named Sarah Chen.)
- Sources: [Vollmer §Missing concrete particulars](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself) ·
  [g2](https://learn.g2.com/was-this-written-by-ai) · HN [49818566](https://news.ycombinator.com/item?id=49818566)

### 1.20 Orphaned demonstratives

- "This ensures the system remains stable." (this _what_?)
- "That means better performance going forward."
- **Rewrite:** name the referent. "The lock ensures two workers can't write at once."
- **MODERATE** — tired human writing does it too, but AI does it structurally, because the
  antecedent was never a specific thing.
- Sources: [Vollmer §Bad-subject problem](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself) ·
  [PCWorld](https://www.pcworld.com/article/3179916/claude-ranked-my-sounds-like-ai-writing-habits.html)

### 1.21 Vague attribution

- "Industry reports suggest this is best practice."
- "Experts argue that microservices add operational overhead."
- **Rewrite:** cite or drop. "The Google SRE book says…" or "I think…". Own the claim or source it.
- **MODERATE–STRONG.** In an assistant context this is worse than a style problem — it manufactures
  authority for something that is really the model's prior.
- Sources: [Wikipedia:Signs of AI writing §Vague attribution](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)

### 1.22 False certainty about unverified work

- "The fix is deployed and everything is working correctly." (when nothing was run)
- "All tests pass." (when the suite was not run)
- **Rewrite:** "Pushed. I ran the unit tests — green. I haven't run the integration suite or checked
  staging."
- **STRONG as a _behaviour_, not a lexical tell** — and the most consequential item in this
  document, because it is the one that costs the reader money rather than taste.
- Sources: [Google SRE](https://sre.google/sre-book/postmortem-culture/) ·
  [epistemic effort](https://www.lesswrong.com/posts/oDy27zfRf8uAbJR6M/epistemic-effort) ·
  HN [48861849](https://news.ycombinator.com/item?id=48861849) ("overconfident explanations despite falsehoods")

### 1.23 Unnecessary digression / teaching the unasked

- Asked for a one-paragraph overview, the writer detours into a hundred-line introduction to Git.
- "As you may know, caching is a technique used to store frequently accessed data…"
- **Rewrite:** delete. Assume competence; offer depth instead of imposing it.
- **MODERATE–STRONG** in assistant output. Named explicitly by HN commenters as a documentation
  failure mode, and separately as patronising.
- Sources: HN chipotle_coyote (documentation thread), HN [48858590](https://news.ycombinator.com/item?id=48858590)
  ("thanks for the reminder on how the scientific method works")

### 1.24 Repackaging the same point

- Summary says it, then bullets say it, then the closing line says it again.
- **Rewrite:** say it once, in the position where it will be read (first).
- **MODERATE.**
- Sources: HN [47114052](https://news.ycombinator.com/item?id=47114052) ("Repeating the same points
  and numbers over and over, repackaging the same idea") · HN [46700387](https://news.ycombinator.com/item?id=46700387)

### 1.25 Zero contractions / zero fragments

- "I have updated the file. It is now consistent with the specification. I will proceed to test it."
- **Rewrite:** "I've updated the file — it matches the spec now. Testing next."
- **WEAK.** Plenty of humans write formally, and non-native writers especially. Listed because it
  _compounds_: with 1.18 (uniform rhythm) it produces the "flat affect" readers detect without
  being able to name it.
- Sources: [Vollmer §Punctuation](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself)

### 1.26 Typographic artefacts

- Curly quotes (" ") and apostrophes (') pasted into plain-text/code contexts; Unicode bold
  (𝗯𝗼𝗹𝗱) instead of markdown; stray `→` in non-technical prose; markdown asterisks in a channel
  that doesn't render markdown; leftover citation junk (`contentReference`, `oaicite`, `[cite: 1]`).
- **Rewrite:** match the channel's own markup. In WhatsApp that means `*bold*` and `_italic_` and
  nothing else.
- **STRONG for the citation junk** (it can only come from a model). **WEAK for curly quotes** —
  every word processor produces them by default, and Wikipedia editor Grayfell explicitly warns
  they "can help imply LLM usage, but not by themselves."
- Sources: [Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) ·
  [talk archive](https://en.wikipedia.org/wiki/Wikipedia_talk:Signs_of_AI_writing/Archive_1) ·
  HN [43668490](https://news.ycombinator.com/item?id=43668490) ("markdown line breaks for some ungodly reason")

### 1.27 "I hope this email finds you well" and the ritual opener

- Covered in §0.8. **STRONG** now that it is the AI default.
- Sources: [Grammarly](https://www.grammarly.com/blog/writing-tips/i-hope-this-email-finds-you-well/) ·
  [Vollmer §Email](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself)

### 1.28 Answering more than was asked (over-complete coverage)

- Asked "did the deploy go out?", the reply covers the deploy, the rollback plan, the monitoring
  setup, and three future recommendations.
- **Rewrite:** "Yes, 14:20. Green." Then stop. Additional material goes behind an offer.
- **MODERATE–STRONG** for assistants; it is the behavioural twin of 1.23.
- Sources: [Busy Readers principle 1](https://writingforbusyreaders.com/wp-content/uploads/2023/10/Writing-for-Busy-Readers-Checklist.pdf) · [inference]

### 1.29 Promotional register on neutral subjects

- "a robust and elegant solution", "a seamless experience", "a comprehensive overhaul"
- **Rewrite:** describe, don't sell. "It handles the three cases we hit. It's about 40 lines."
- **STRONG.** Wikipedia's editors call this the hardest LLM habit to suppress: output "will often
  tend toward advertisement-like writing even when prompted to use an encyclopedic tone."
- Sources: [Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) ·
  HN [49588996](https://news.ycombinator.com/item?id=49588996), [47343357](https://news.ycombinator.com/item?id=47343357)
  ("cribbed from like, LinkedIn and marketing slop")

### 1.30 The aphoristic close

- "Sometimes the smallest change makes the biggest difference."
- "At the end of the day, good software is about people."
- **Rewrite:** delete. Nothing replaces it.
- **STRONG.** Every paragraph ending on a pull-quote is a machine reaching for profundity it has no
  stake in.
- Sources: [Vollmer §Aphoristic closure and §False profundity](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself)

---

## PART 2 — Word and phrase list, with plain replacements

Two rules before the table. **(a)** None of these words is forbidden. Each is a _flag_: if you
reach for it, check whether a plainer word carries the same meaning — it usually does, and if it
doesn't, keep the word. **(b)** The evidence that these specifically spiked with LLMs is
[Kobak et al., "Delving into LLM-assisted writing… through excess vocabulary"](https://arxiv.org/abs/2406.07016)
— 14M PubMed abstracts, 2010–2024, showing an abrupt post-2022 frequency jump in a defined set of
style words, larger than the effect of COVID on the literature. Reported excess ratios include
_delve_ r = 28.0, _underscores_ r = 13.8, _showcasing_ r = 10.7. The paper also found _delve_ usage
**dropping** once it was publicly named — these markers decay as they become known.

### 2.1 Verbs

| Flagged                                          | Plain replacements                     |
| ------------------------------------------------ | -------------------------------------- |
| delve into                                       | look at, dig into, go through          |
| leverage                                         | use, reuse                             |
| utilise / utilize                                | use                                    |
| facilitate                                       | help, run, set up, make it possible to |
| streamline                                       | simplify, cut a step                   |
| optimise                                         | speed up, make cheaper, tune           |
| enhance                                          | improve, make better, speed up         |
| empower                                          | let, allow                             |
| foster                                           | encourage, help, build                 |
| underscore / highlight (figurative)              | show, prove, mean                      |
| showcase                                         | show                                   |
| harness                                          | use                                    |
| navigate (figurative)                            | deal with, handle, get through         |
| align with                                       | match, fit, agree with                 |
| ensure                                           | make sure                              |
| commence / initiate                              | start                                  |
| terminate                                        | stop, end                              |
| implement                                        | build, add, write, do                  |
| serves as / stands as / functions as             | is                                     |
| boasts / features / offers (of inanimate things) | has                                    |
| unpack / explore / dive into                     | look at, explain                       |
| bolster                                          | strengthen, back up, add to            |
| garner                                           | get, collect, win                      |
| transform                                        | say what actually changed              |
| deliver (abstract)                               | make, create, provide, give            |
| tackle / combat                                  | fix, solve, deal with                  |
| liaise                                           | talk to, work with                     |

### 2.2 Adjectives

| Flagged                                          | Plain replacements                                     |
| ------------------------------------------------ | ------------------------------------------------------ |
| robust                                           | solid, reliable, well tested, or: say what it survives |
| seamless                                         | smooth, invisible, no extra step                       |
| comprehensive                                    | complete, full, covers everything                      |
| pivotal / crucial / vital / critical             | important, or: delete                                  |
| intricate / nuanced / multifaceted               | complicated, detailed, or: delete                      |
| holistic                                         | whole, overall                                         |
| cutting-edge / state-of-the-art / groundbreaking | new, recent, or: name the version                      |
| transformative                                   | say what changed                                       |
| profound                                         | big, deep, or: delete                                  |
| vibrant / rich                                   | delete, or be specific                                 |
| innovative                                       | new, unusual, or: delete                               |
| meticulous                                       | careful, thorough                                      |
| unparalleled                                     | best, fastest, or: give the number                     |
| significant (unstressed)                         | give the number instead                                |
| key (adj.)                                       | important, main, or: delete                            |
| overarching                                      | overall, main                                          |

### 2.3 Nouns

| Flagged                        | Plain replacements                                                    |
| ------------------------------ | --------------------------------------------------------------------- |
| tapestry                       | delete — there is no replacement, the metaphor was never load-bearing |
| landscape (figurative)         | field, market, situation, setup                                       |
| realm                          | area, field, or: name it                                              |
| ecosystem (non-biological)     | tools, setup, the stack                                               |
| testament (to)                 | proof, sign, or: delete                                               |
| cornerstone / bedrock / beacon | main part, basis, or: delete                                          |
| journey (non-travel)           | project, process, work                                                |
| insights                       | findings, what I learned, notes                                       |
| solution (vague)               | name the thing: script, patch, config change                          |
| synergy / alignment            | delete                                                                |
| paradigm                       | model, way of doing it                                                |
| best practices                 | the usual way, what most people do                                    |
| deep dive                      | detailed look                                                         |
| impact (n.)                    | effect, result, what it does to X                                     |

### 2.4 Stock phrases — cut or replace

| Flagged                                    | What to do                                                      |
| ------------------------------------------ | --------------------------------------------------------------- |
| It's important to note that…               | delete the frame, keep the fact                                 |
| It's worth noting that…                    | delete                                                          |
| That being said…                           | "But"                                                           |
| When it comes to X…                        | "For X" or delete                                               |
| At its core / fundamentally                | delete                                                          |
| In today's fast-paced world                | delete                                                          |
| In conclusion / In summary / Ultimately    | delete; end on the last fact                                    |
| I hope this email finds you well           | delete; open with the reason                                    |
| I hope you're doing well                   | replace with a specific: "Hope the release went OK"             |
| Hope this helps!                           | delete or make specific: "Shout if the staging one matters too" |
| Let me know if you have any questions      | delete, or ask the actual open question                         |
| Please don't hesitate to reach out         | "Ask me if it breaks"                                           |
| I wanted to reach out regarding…           | "About X —"                                                     |
| As per our discussion                      | "Like we said"                                                  |
| Going/moving forward                       | "From now on"                                                   |
| In order to                                | "To"                                                            |
| A number of / a variety of                 | give the number                                                 |
| It should be noted / one might argue       | delete                                                          |
| I have successfully completed              | "Done."                                                         |
| I've gone ahead and…                       | "I…"                                                            |
| Great question! / Absolutely! / Certainly! | delete                                                          |
| You're absolutely right                    | "Yes — you're right about X" (then the specific)                |
| plays a crucial role in                    | "does" / "handles"                                              |
| stands as a testament to                   | delete the whole clause                                         |
| The truth lies somewhere in between        | take a position or say you don't know                           |

### 2.5 Sentence patterns to avoid

- `It's not just X — it's Y.`
- `X isn't about A; it's about B.`
- `Short. Punchy. Three.`
- `While X, it's important to remember Y.`
- `Not only… but also…`
- `From X to Y, the Z…` (flagged specifically by Wikipedia editor MrPersonHumanGuy as a frequent
  AI opener — [talk archive](https://en.wikipedia.org/wiki/Wikipedia_talk:Signs_of_AI_writing/Archive_1))
- `<Main clause>, marking/highlighting/underscoring <restatement of main clause>.`

---

## PART 3 — Structural and genre tells (these matter more than words)

Single words are the cheapest tell to fix and the weakest evidence. Shape is what readers actually
react to, and shape is what survives a find-and-replace pass. Ranked roughly by how strongly each
identifies machine authorship.

### 3.1 The universal shape: intro → three parallel sections → recap

Every output, regardless of what was asked, arrives as a miniature five-paragraph essay scaled to
fit. Wikipedia catalogues it as rigid section headers recurring across unrelated articles
("Challenges and Legacy", "Future Outlook"); Vollmer names it the five-paragraph-essay shape; HN
readers describe "the same argument/paragraph structure and sentence structure many times with
different words swapped in" ([46700387](https://news.ycombinator.com/item?id=46700387)).
**Human counter-shape:** the shape follows the content. An answer to a yes/no question is one line.
An explanation of a tricky bug is three paragraphs with no headings and one code snippet. A
comparison of five options is a table. Nothing has an intro and a recap unless it's long enough
that a reader could lose the thread — which, in chat, is never.

### 3.2 Formatting/content ratio

The reliable, mechanical test: **count the formatting marks, count the facts.** Four bullets, four
bold stems, two headers and a horizontal rule wrapped around three sentences of content is a
machine signature. Rogers & Lasky-Fink's principle 4 is exactly this: formatting draws attention,
so applying it to everything removes its ability to draw attention to anything, and it must be
_removed from information that is not critical_
([checklist](https://writingforbusyreaders.com/wp-content/uploads/2023/10/Writing-for-Busy-Readers-Checklist.pdf)).
**Threshold heuristic [inference]:** in a message under ~150 words, use at most ONE formatting
device — either a short list, or one bolded phrase, or a code block. Not three.

### 3.3 Lists used for non-list content

A list implies its items are parallel, unordered-or-ordered, and separable. Causation, sequence
with dependencies, and "I did A, which made B possible, so I also did C" are none of those — they
are prose. The tell is bullets whose items are full sentences that reference each other, or a
bulleted "list" of two items. [inference, supported by the OpenAI bug thread where users complain
the model inserts bullets "even when it's not appropriate for the context" —
[community.openai.com](https://community.openai.com/t/excessive-bullet-point-formatting-issue-in-chatgpt-responses/1097391)]

### 3.4 Openings

- **AI opening:** restates the question, or greets, or announces intent ("Let me walk you through…",
  "I'll break this down into three parts.").
- **Human opening:** the answer, or the single most load-bearing fact, or — in chat — no opening at
  all, just the content.
- BLUF formalises this; NN/g's scanning data explains why it matters (first lines get
  disproportionate attention, and 72–80% of the words are never read).

### 3.5 Closings

- **AI closing:** a recap of what was just said, plus an offer of further help, plus an exclamation
  mark. Vollmer lists "aphoristic closure" — paragraphs ending on pseudo-profound pull-quotes — as a
  separate tell.
- **Human closing:** stops. Or asks one real question. Or has a genuine loose end: "the staging one
  I haven't looked at."
- Note the asymmetry: a human ends where the information ends; a model ends where the _form_ ends.
  That's why AI closings feel ceremonial. [inference]

### 3.6 Rhythm and burstiness

Human prose varies: a 30-word sentence next to a 4-word one; a paragraph of one line; an
interrupted thought. LLM prose flatlines — uniform sentence length (14–22 words), uniform paragraph
length (3–5 sentences), no fragments, no comma splices, no anacoluthon. This is measurable
(perplexity/burstiness) but readers also feel it as "flat affect" without being able to name it
([Vollmer §Computational signals](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself)).
**Fix is not random variation** — it is letting the content set the length, and allowing a short
sentence to carry the emphasis, which is what Gopen & Swan's stress position predicts. [inference]

### 3.7 Register mismatch to channel

The single most-punished error in practice. Each channel has native markup and native length:

| Channel               | Native form                                          | What breaks it                                                    |
| --------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| Email to a busy owner | 50–125 words, one ask, plain paragraphs              | headers, nested bullets, emoji headings                           |
| WhatsApp / SMS        | 2–4 short lines, `*bold*` at most, split messages    | markdown tables, `###`, HTML, a wall paragraph                    |
| Chat with a colleague | lowercase-tolerant, fragments fine, emoji as gesture | formal salutations, "Dear", full-stop-terminated one-word replies |
| Commit message        | ≤50-char imperative subject, blank line, 72-col body | marketing adjectives, bullets, "successfully"                     |
| PR description        | first sentence = the change; then why/test/risk      | a fifteen-item checklist nobody fills                             |
| Incident note         | what happened, impact, duration, fix, next           | blame, jargon, minimising                                         |

McCulloch's point underwrites the top two rows: informal writing has its _own_ conventions, and
importing formal ones reads as coldness rather than professionalism. The Binghamton period study is
the crispest evidence — the same word, with and without a full stop, measurably changes perceived
sincerity in a chat context and not in handwriting.

### 3.8 Missing "grain"

Grain = the irreducible specifics that only someone who was actually there would have: the file
name, the exact error string, the time, the number, the person, the thing that surprised them.
AI-written text is smooth because it was never in the room. **This is the highest-leverage fix in
the whole document** — almost every other tell is downstream of it, because concrete detail forces
short words, forces active voice, forces variable rhythm, and leaves no room for "significant".
[inference, supported by Vollmer §Missing concrete particulars and HN 49818566]

### 3.9 No cost, no surprise, no residue

Real work has a cost, a surprise, and a leftover. A human report mentions at least one:
"took longer than I thought", "the actual cause wasn't what I said yesterday", "there's still the
Windows path thing". A model report is frictionless and complete. Reporting frictionlessly is not
just a style tell; it is a false statement about the work.
[inference — this is the writing-craft face of the Google SRE blameless-postmortem principle that
the write-up must include what went badly.]

### 3.10 Uniform politeness gradient

Humans modulate: warmer when asking a favour, terser when busy, blunter with people they know well.
An assistant that is identically courteous to a one-word question and a two-day investigation is
displaying the "flatness of affect" tell at conversation scale rather than sentence scale.
[inference]

---

## PART 4 — What real people said

Retrieved via the Hacker News Algolia comment API and the Wikipedia talk archives, 2026-09-24.
HN comment IDs are given so each can be opened and checked at
`https://news.ycombinator.com/item?id=<id>`. Quotes are as returned by the API extraction; where I
am summarising rather than quoting I say so. These are practitioners and volunteer editors
describing what they actually notice, not vendors selling detection.

1. **"When you see the long dashes and emoji lists you can tell right away ChatGPT wrote it."**
   — HN [48224690](https://news.ycombinator.com/item?id=48224690). _The two tells named together;
   neither alone would convince this person._

2. **"The em-dash and 'this isn't…but' pattern are louder than the text at this point."**
   — HN, user flatline, [46127293](https://news.ycombinator.com/item?id=46127293). _"Louder than the
   text" is the key phrase: the style is now overwhelming the content for experienced readers._

3. **"People latch onto the word 'delve' or an em-dash or the idiom of 'it's not X it's Y'."**
   — HN, user smithoc, [48503918](https://news.ycombinator.com/item?id=48503918).

4. **"AIs use em dashes because competent writers have been using em dashes for a long time."**
   — HN, user jedberg, [46789300](https://news.ycombinator.com/item?id=46789300). _The false-positive
   objection, from the other side._

5. **"paranoid accusations against anything that is remotely non-standard ('you used an em-dash, you
   must be AI!')"** — HN, user hyperpape, [49586484](https://news.ycombinator.com/item?id=49586484).
   _Second false-positive complaint; there is a live, unresolved argument here and the report should
   not pretend otherwise._

6. **"Spams of groups of threes"** and **"It's not just X - it's Y type of sentence structure"**
   — HN, user ntstr, [44629579](https://news.ycombinator.com/item?id=44629579).

7. **"Every post sounds the same. No intelligence. No individuality. Just pure, clean LLM slop."**
   — HN, user roywiggins, [47232580](https://news.ycombinator.com/item?id=47232580). _The complaint
   is sameness, not error._

8. **"LLM style of writing is cribbed from like, LinkedIn and marketing slop. It's definitely not
   good writing."** — HN, user dddgghhbbfblk, [47343357](https://news.ycombinator.com/item?id=47343357).
   _Independently arrives at the point in §0.5: the register was corporate before it was artificial._

9. **"Repeating the same points and numbers over and over, repackaging the same idea."**
   — HN, user SolarNet, [47114052](https://news.ycombinator.com/item?id=47114052).

10. **"cheesy, marketingese sycophantic ChatGPT tone"** — HN, user dofm,
    [48508216](https://news.ycombinator.com/item?id=48508216).

11. **"thanks for the reminder on how the scientific method works… that's most certainly not
    something you can count on your audience being familiar with"** — HN, user arcfour,
    [48858590](https://news.ycombinator.com/item?id=48858590). _Sarcasm aimed at the unasked-for
    tutorial — the patronising tell (§1.23)._

12. **"the post talks a lot about how great this tool is but describes nearly nothing of value."**
    — HN, user eis, [49818566](https://news.ycombinator.com/item?id=49818566). _Promotional register
    plus missing particulars, diagnosed as one problem._

13. On AI-written documentation: it is **"extremely generic and repetitive, often effectively
    duplicating other work in your documentation repo"** and **"subject to unnecessary digression,
    e.g., while writing a high-level overview… it will mention that using version control is a good
    idea, then detour for a hundred lines giving you a quick introduction to Git."**
    — HN, user chipotle_coyote. _The most concrete description of the digression failure mode I found._

14. Em-dash overuse specifically as **using them "for everything, regardless of whether a parentheses,
    comma, or semi-colon was more appropriate"**, plus **"markdown line breaks for some ungodly
    reason"** — HN, user defsectec, [43668490](https://news.ycombinator.com/item?id=43668490).
    _Note the refinement: the tell is not the em dash, it is the em dash_ instead of _the correct mark._

15. **"I've used them for the last 10-15 years"** (of em dashes, predating LLMs) — HN, user ben_w,
    [44308161](https://news.ycombinator.com/item?id=44308161).

16. Wikipedia editor **Foxtail286** identifies "LLMs having an instruction to keep paragraphs around
    the same length (3–5 sentences)" as a structural marker
    ([talk archive](https://en.wikipedia.org/wiki/Wikipedia_talk:Signs_of_AI_writing/Archive_1)).

17. An IP editor on the same page names "the abuse of hyphens and the absolute lack of semicolons"
    as a fast check — while another IP editor objects that the list "leaves aside personal choices
    for styling and prose" and risks flagging legitimate human writing
    ([talk archive](https://en.wikipedia.org/wiki/Wikipedia_talk:Signs_of_AI_writing/Archive_1)).

18. Wikipedia editor **Grayfell**, on curly quotation marks: they "can help imply LLM usage, but not
    by themselves," because word processors produce them by default
    ([talk archive](https://en.wikipedia.org/wiki/Wikipedia_talk:Signs_of_AI_writing/Archive_1)).

**What the corpus of complaints has in common** [inference]: almost nobody objects to a _word_.
They object to sameness, to volume without substance, to being lectured, and to praise they didn't
earn. The lexical tells are how people _justify_ a reaction they had for structural reasons.
Which means fixing vocabulary alone does not fix the reaction.

### 4.1 The false-positive problem, stated plainly

This matters because writing _to avoid_ tells produces worse writing than writing well, and because
accusations land on real people:

- A Stanford study found detectors misclassified **61.3% of TOEFL essays** by non-native English
  speakers as AI-generated; non-native writers naturally produce lower-perplexity text.
- A UC Davis case found **15 of 17** flagged students were false positives; neurodivergent writers
  produce structured or repetitive patterns that trigger detectors.
- Grammarly and similar tools "normalize" human text in ways that raise detector scores.
- Human detection accuracy in meta-studies runs roughly **60–70%**, with some data at **53%** —
  barely above chance.
- Current methods cannot distinguish 20%-machine/80%-human from the reverse.
- Second-order damage: writers now insert deliberate typos and fragments to signal humanity.
  (All: [Vollmer §Critical false-positive caveats](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself))

**Operational consequence:** never write in order to pass as human. Write to be useful to the
specific person reading, with real specifics, at the length the content actually needs. The overlap
with "not sounding like AI" is large but incidental. [inference]

---

## PART 5 — Sources

**Primary craft sources**

- Rogers & Lasky-Fink, _Writing for Busy Readers_ — [official one-page checklist, PDF](https://writingforbusyreaders.com/wp-content/uploads/2023/10/Writing-for-Busy-Readers-Checklist.pdf) (2023). The six principles verbatim.
- [Behavioral Scientist, "When Writing for Busy Readers, Less Is More"](https://behavioralscientist.org/when-writing-for-busy-readers-less-is-more/) (2023). Authors' own summary; the 7,002-school-board-member experiment, 127 vs 49 words, 2.7% vs 4.8%.
- [Lasky-Fink, Robinson, Chang & Rogers, "Using Behavioral Insights to Improve School Administrative Communications"](https://journals.sagepub.com/doi/10.3102/0013189X211000749), _Educational Researcher_ (2021). N = 131,312; simplified truancy notices, ~40% improvement.
- [Gopen & Swan, "The Science of Scientific Writing"](https://www.gatsby.ucl.ac.uk/~pel/misc/gopen_swan.pdf), _American Scientist_ 78 (1990). Topic/stress position, subject-verb proximity, reader energy.
- [Orwell's six rules, summarised](https://sites.duke.edu/scientificwriting/orwells-6-rules/) — from "Politics and the English Language" (1946).
- [Paul Graham, "Write Simply"](https://paulgraham.com/simply.html) (2021).
- [Paul Graham, "Writing, Briefly"](https://paulgraham.com/writing44.html) (March 2005).
- [GOV.UK A-to-Z style guide](https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/style-guides/a-to-z-style-guide/) — words to avoid with mandated replacements. Plain English is mandatory on GOV.UK.
- [GOV.UK, "Use clear language"](https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/writing-guidelines/clear-language/).
- [digital.gov plain-language guide index](https://digital.gov/guides/plain-language) — successor location of plainlanguage.gov's guidelines (the old URL 301s here; detailed content archived on GitHub).
- [Gretchen McCulloch, _Because Internet_ (2019) — overview](https://en.wikipedia.org/wiki/Because_Internet) and [Notion interview with McCulloch](https://www.notion.com/blog/gretchen-mcculloch) — typographical tone of voice, lowercase as deadpan, emoji as gesture, message splitting, stock phrases as social signals.
- [Binghamton University, "Texting insincerely: the role of the period in text messaging" (2015)](https://www.sciencedaily.com/releases/2015/12/151208094229.htm), and [APS summary](https://www.psychologicalscience.org/news/in-texting-punctuation-conveys-different-emotions-period.html). 126 participants; periods reduce perceived sincerity in one-word chat replies; exclamation marks increase it.
- [BLUF (communication) — Wikipedia](<https://en.wikipedia.org/wiki/BLUF_(communication)>) and [Beale AFB, "Bottom line up front"](https://www.beale.af.mil/News/Commentaries/Display/Article/280275/bottom-line-up-front/).
- [Nielsen Norman Group, F-shaped reading pattern (2006 eyetracking)](https://www.nngroup.com/articles/f-shaped-pattern-reading-web-content-discovered/) — users read ~20–28% of words per visit.
- [Boomerang, "7 Tips for Getting More Responses to Your Emails (With Data!)" (2016)](https://blog.boomerangapp.com/2016/02/7-tips-for-getting-more-responses-to-your-emails-with-data/) — ~40M emails; 50–125 word band, 75–100 words → 51% response. [Summary with the decline curve](https://emailanalytics.com/ideal-email-length/).
- [Grammarly on "I hope this email finds you well"](https://www.grammarly.com/blog/writing-tips/i-hope-this-email-finds-you-well/) and [LanguageTool](https://languagetool.org/insights/post/word-choice-i-hope-this-emails-finds-you-well/) — now an AI-saturated default.
- [Grammarly, "How to Respectfully Disagree in Writing"](https://www.grammarly.com/blog/workplace-communication/respectfully-disagree/).

**Engineering-explanation sources**

- [Chris Beams, "How to Write a Git Commit Message"](https://cbea.ms/git-commit/) (2014, building on Tim Pope 2008) — the seven rules; body explains what and why, not how.
- [Conventional Comments](https://conventionalcomments.org/) — `praise/nitpick/suggestion/issue/question/thought/chore` + `(blocking)`/`(non-blocking)`/`(if-minor)`.
- [Google SRE Book, "Postmortem Culture: Learning from Failure"](https://sre.google/sre-book/postmortem-culture/) and [SRE Workbook chapter](https://sre.google/workbook/postmortem-culture/) — blameless framing; summary = what happened, user impact, duration, restoration, planned changes.
- [Google SRE example postmortem](https://sre.google/sre-book/example-postmortem/).
- [Kodus, PR best practices](https://kodus.io/en/best-practices-for-pull-requests/) and [Awesome Code Reviews, PR templates](https://www.awesomecodereviews.com/pull-request-template/) — what changed / why / how tested / risks / where to look; first sentence carries the change; short templates get filled in, long ones get rubber-stamped.
- [Beamer, changelog vs release notes](https://www.getbeamer.com/blog/changelog-or-release-notes) and [Appcues, release notes examples](https://www.appcues.com/blog/release-notes-examples) — plain language, answer "does this affect me?" first, the "here's what you can do now that you couldn't before" test.
- [Stanford Online, "10 Tips for Communicating Technical Ideas to Non-Technical People"](https://online.stanford.edu/10-tips-communicating-technical-ideas-non-technical-people) and [Mercedes Bernard, "Explaining technical concepts to a non-technical audience"](https://mercedesbernard.com/blog/how-to-talk-technical/).

**Uncertainty and calibration**

- [LessWrong, "[Feature Idea] Epistemic Status"](https://www.lesswrong.com/posts/Hrm59GdN2yDPWbtrd/feature-idea-epistemic-status) and [EA Forum explainer](https://forum.effectivealtruism.org/posts/bbtvDJtb6YwwWtJm7/epistemic-status-an-explainer-and-some-thoughts).
- [LessWrong, "Epistemic Effort"](https://www.lesswrong.com/posts/oDy27zfRf8uAbJR6M/epistemic-effort) — state what you did to check, not how confident you feel.
- [Chris Krycho, "Epistemic Status"](https://v5.chriskrycho.com/journal/epistemic-status/).
- [Calibrating Expressions of Certainty, arXiv:2410.04315](https://arxiv.org/pdf/2410.04315).

**AI-tells catalogues and evidence**

- [Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) — maintained by WikiProject AI Cleanup from thousands of flagged articles since 2023. The best-sourced catalogue that exists.
- [Wikipedia talk:Signs of AI writing/Archive 1](https://en.wikipedia.org/wiki/Wikipedia_talk:Signs_of_AI_writing/Archive_1) — the editors arguing about it, including the false-positive objections.
- [Matthew Vollmer, "I Asked the Machine to Tell on Itself: A Field Guide to AI Tells"](https://matthewvollmer.substack.com/p/i-asked-the-machine-to-tell-on-itself) — the densest single taxonomy found: lexical, syntactic, rhetorical, tonal, punctuation, domain-specific, model-specific, computational, plus a strong false-positive section.
- [Kobak, González-Márquez et al., "Delving into LLM-assisted writing in biomedical publications through excess vocabulary", arXiv:2406.07016](https://arxiv.org/abs/2406.07016) (2024) — 14M PubMed abstracts 2010–2024; the quantitative basis for the word lists; ≥10% of 2024 abstracts LLM-processed, up to 30% in some sub-corpora; _delve_ usage dropped after being named.
- [Washington Post style analysis, syndicated](https://www.yahoo.com/news/articles/clues-chatgpt-wrote-something-analyzed-214947550.html) — "not just X, but Y" in ~6% of chats; ~70% of messages contained an emoji by July 2025; paragraph uniformity.
- [OpenAI developer community: "Excessive Bullet Point Formatting Issue in ChatGPT Responses"](https://community.openai.com/t/excessive-bullet-point-formatting-issue-in-chatgpt-responses/1097391) — users reporting bullets inserted where prose was asked for.
- [PCWorld, "Does my writing sound like AI? Claude ranked my red flag habits"](https://www.pcworld.com/article/3179916/claude-ranked-my-sounds-like-ai-writing-habits.html).
- [Hacker News comment corpus](https://news.ycombinator.com/) — IDs listed in Part 4.
- [Worldcom, "How to Spot AI Writing: 7 Telltale Patterns from Wikipedia"](https://worldcomgroup.com/insights/how-to-spot-ai-writing-tips-from-wikipedia-on/) — secondary summary of the Wikipedia guide.

**Retrieval notes / limits.** Reddit was not directly reachable from this environment (both the API
and the HTML front end returned nothing), so the community voices in Part 4 are Hacker News and
Wikipedia editors rather than the broader Reddit/teacher-forum sample the brief asked for. Reddit
material appears here only where it was quoted in reachable secondary sources, and is labelled as
such. The plainlanguage.gov guidelines now 301 to digital.gov and the landing page no longer
carries the detailed word tables; GOV.UK's A-to-Z is used as the equivalent primary source.

---

# PART 6 — One-page checklist: EMAIL

**Target: 50–125 words. One ask. No headers. No bullets unless there are genuinely 3+ parallel items.**

### 1. Subject line states the outcome or the ask, not the topic

- ❌ `Update on the deployment situation`
- ✅ `Deploy is out — need your OK on the DB migration by Thu`
- _Why: the subject is the only part guaranteed to be read._

### 2. First sentence = the answer or the ask (BLUF). No greeting ritual.

- ❌ "Hi Jamie, I hope this email finds you well. I wanted to reach out regarding the topic of the
  caching issue we discussed last week."
- ✅ "Hi Jamie — the caching bug is fixed and live since Tuesday. One thing needs your call:"
- _Why: 127 words → 2.7% reply; 49 words → 4.8% ([Behavioral Scientist](https://behavioralscientist.org/when-writing-for-busy-readers-less-is-more/))._

### 3. One ask, stated as an imperative with a deadline

- ❌ "It would be great if you could possibly take a look at this when you have a moment and let me
  know your thoughts."
- ✅ "Can you approve the migration by Thursday? Reply 'yes' is enough."
- _Why: principle 6, "make responding easy" — simplify the steps required to act._

### 4. Every abstract verb replaced with a concrete one

- ❌ "We leveraged the existing infrastructure to facilitate a more robust deployment pipeline."
- ✅ "We reused the staging server, so deploys no longer need a manual step."
- _Why: [GOV.UK bans exactly these words](https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/style-guides/a-to-z-style-guide/); they hide whether anything happened._

### 5. Numbers and names instead of adjectives

- ❌ "This significantly improves performance across a variety of scenarios."
- ✅ "Search went from 800ms to 210ms. Checkout is unchanged."
- _Why: missing concrete particulars is the strongest tell and the biggest loss of information._

### 6. Caveats are specific and localised, never diffuse

- ❌ "While results may vary depending on your configuration, it should generally work as expected."
- ✅ "I only tested this on Linux. Windows path handling is the part I'd expect to break."
- _Why: a named unknown is useful; a blanket hedge is insurance for the writer._

### 7. Disagreement: acknowledge in one clause, then state your position with the reason

- ❌ "I appreciate your input on this matter; however, I must respectfully disagree with the proposed
  approach for a number of reasons."
- ✅ "Agree on the first two. I'd push back on the rewrite — we'd lose the audit log, and that's the
  bit the auditors asked for. Your call, though."
- _Why: the polite formula is now itself boilerplate; specificity is what reads as respect._

### 8. Close on the last real fact, or one real question. No ceremony.

- ❌ "In conclusion, I hope this helps! Please don't hesitate to reach out if you have any questions."
- ✅ "Rollback is a one-liner if it misbehaves." _(or just: end after item 5.)_
- _Why: AI closings are ceremonial; human ones stop where the information stops._

### 9. Formatting budget: ONE device maximum

One short list, **or** one bolded phrase, **or** one code block. Not a header stack.

- ❌ `## Summary` / `**What changed:**` … / `**Why:**` … / `**Next steps:**` … (four facts, eight marks)
- ✅ A three-sentence paragraph, with the date bolded because the date is the ask.
- _Why: principle 4 — emphasis works only by contrast._

### 10. Read it aloud before sending

If you would not say the sentence to their face, rewrite it. Graham's test; it catches register
inflation faster than any word list.

**Final pass — delete these if present:** _I hope this email finds you well · I wanted to reach out ·
It's important to note that · going forward · in order to · leverage · robust · comprehensive ·
I have successfully · Hope this helps! · Let me know if you have any questions · In conclusion._

---

# PART 7 — One-page checklist: WHATSAPP / CHAT MESSAGE

**Target: 2–4 short lines. Split across messages where speech would pause. Zero markdown beyond
`*bold*` and `_italic_`. No headers, no tables, no bullets, ever.**

### 1. No salutation, no sign-off

- ❌ "Hi Jamie, I hope you're doing well. I wanted to update you on the server."
- ✅ "server's back up"
- _Why: chat is a continuing conversation; re-opening it each time reads as formal distance._

### 2. Answer first, in the first four words

- ❌ "So regarding your question about whether the backup ran last night, I checked the logs and..."
- ✅ "yeah it ran. 03:12, clean."
- _Why: BLUF, but harder — on a phone, line one is often all that shows in the notification._

### 3. Split messages where you would pause; don't build a paragraph

- ❌ "The build is fixed, it was the node version in CI, and I also bumped the lockfile, but the
  Windows runner is still failing and I haven't looked at that yet."
- ✅ `build's fixed — was the node version in CI`
  `also bumped the lockfile`
  `windows runner still red, haven't looked yet`
- _Why: message splitting is chat's punctuation ([McCulloch](https://www.notion.com/blog/gretchen-mcculloch))._

### 4. Lose the full stop on short replies

- ❌ "Okay." / "Sure." / "Yes."
- ✅ "ok" / "sure" / "yep" / "yes — doing it now"
- _Why: Binghamton, N=126 — the period measurably reduces perceived sincerity on one-word chat
  replies, with no such effect in handwriting ([ScienceDaily](https://www.sciencedaily.com/releases/2015/12/151208094229.htm))._

### 5. NO markdown the channel doesn't render

- ❌ `### Status` / `| item | state |` / `**Root cause:**` / `- bullet`
- ✅ `*done* — cache was the issue`
- _Why: on WhatsApp, `###` and tables arrive as literal characters. Register mismatch is the most
  punished error (§3.7)._

### 6. Emoji as gesture, inside a sentence — never as a bullet or a heading

- ❌ "✅ Build fixed 🚀 Deployed 💡 Recommendation: monitor it"
- ✅ "deployed. took 40 min though 😐"
- _Why: emoji replace gesture and facial expression; nobody gestures at a heading
  ([McCulloch](https://en.wikipedia.org/wiki/Because_Internet))._

### 7. Lowercase is allowed and often correct; match their register

If they write lowercase-no-punctuation, matching it is not sloppiness — it is the register of the
channel. If they write in full sentences, do that. Mirror, don't impose.

- ❌ (to someone who writes "u around?") "Yes, I am available. How may I assist you?"
- ✅ "yeah what's up"

### 8. Long answer → offer it, don't dump it

- ❌ _(600 words of explanation, unprompted, across one message)_
- ✅ "short version: the DB was locking on the nightly job. want the long version or is that enough?"
- _Why: principle 1, "make fewer requests" — a wall of text is a request for ten minutes of attention._

### 9. Uncertainty in plain speech

- ❌ "It is possible that the issue may be related to the configuration, though further investigation
  would be required to confirm."
- ✅ "pretty sure it's the config, 80%. haven't proved it yet"

### 10. Bad news stays short and unhedged

- ❌ "Unfortunately, it appears that we may have encountered a minor setback with regard to the
  timeline, though I remain optimistic..."
- ✅ "won't make friday. the migration's bigger than I thought — probably tuesday"
- _Why: hedging bad news reads as evasion. The specifics ARE the reassurance._

**Final pass — delete if present:** _any heading · any bullet · any table · "I hope you're doing
well" · "Please let me know if" · an exclamation mark you wouldn't have said out loud · a full stop
after a one-word reply._

---

# PART 8 — One-page checklist: EXPLAINING A CODE CHANGE TO THE OWNER (3–6 plain sentences)

**They did not read the diff and will not. They want: does it work, what do I see, what should I
worry about. Four moves: what changed → why → what you'll notice → what I did NOT do.**

### 1. Sentence one is the outcome in their words, not the mechanism

- ❌ "I refactored the `SessionStore` to use a write-through cache with a TTL-based invalidation
  strategy."
- ✅ "Chats load fast again — about half a second instead of six."
- _Why: [changelog test](https://www.getbeamer.com/blog/changelog-or-release-notes) — finish "here's
  what you can do now that you couldn't before."_

### 2. The "why" is the cause, in one sentence, no jargon wall

- ❌ "The root cause was an O(n²) deserialization path in the session hydration layer compounded by
  an unbounded structuredClone in the store persistence hook."
- ✅ "Every time you opened a tab it was re-reading the whole history file, and the file had grown to
  16MB."
- _Why: commit-message rule 7 — the diff shows what, only you can say why
  ([Beams](https://cbea.ms/git-commit/)). But for an owner, "why" means the cause, not the design
  rationale._

### 3. "What you'll notice" is phrased as something they can check themselves

- ❌ "Performance has been significantly improved across the board."
- ✅ "Open three tabs and switch between them — no more spinner. If you still see one, tell me, that
  means I missed a path."
- _Why: gives them a falsifiable test, which is also how you find out you were wrong._

### 4. "What I did NOT do" — always present, always specific

- ❌ _(omitted entirely — the reader infers completeness)_
- ✅ "I didn't touch the search index, so search is still slow. That's a separate thing."
- _Why: the single most valuable sentence for an owner, because it is the only part they cannot
  infer from a working system. [inference, from the SRE principle that a write-up must include what
  went badly.]_

### 5. State what you actually verified, not how confident you feel

- ❌ "Everything is working correctly now."
- ✅ "Unit tests pass and I clicked through it on my machine. I have not tried it on the production
  data volume."
- _Why: [epistemic effort](https://www.lesswrong.com/posts/oDy27zfRf8uAbJR6M/epistemic-effort) —
  what you did to check is checkable; a confidence claim is not._

### 6. Name the risk and the undo

- ❌ "The change is low-risk and fully backwards compatible."
- ✅ "Worst case it serves a stale chat for a few seconds. Reverting is one commit, takes a minute."
- _Why: risk stated with its remedy is information; risk stated as "low" is reassurance._

### 7. No marketing adjectives about your own work

- ❌ "a robust, elegant solution that significantly streamlines the entire flow"
- ✅ "it's about 40 lines, in one file"
- _Why: promotional register on neutral subjects is a STRONG tell (§1.29) and it makes an owner
  wonder what you're selling._

### 8. Mention the surprise, if there was one

- ✅ "The thing I got wrong yesterday: I said it was the network. It wasn't — it was our own file
  reads."
- _Why: real work has friction, and a frictionless report is a false statement about the work.
  Correcting yourself plainly also buys the credibility you need next time. [inference]_

### 9. Offer depth; do not impose it

- ❌ _(three paragraphs on the caching strategy nobody asked about)_
- ✅ "Happy to go into how the cache works if it's useful."

### 10. Three to six sentences. Then stop.

No headings. No bullets unless there are genuinely several independent changes, in which case one
flat list of one-liners, no bold stems.

---

### Worked example — all four moves in five sentences

> ❌ **Bad (AI-shaped):**
>
> ## Summary
>
> I have successfully implemented a comprehensive fix for the performance degradation issue.
> **Root cause:** An inefficient data access pattern in the session layer.
> **Solution:** Implemented a robust caching mechanism to optimize retrieval.
> **Impact:** Significantly improved load times across the application.
> **Testing:** All tests pass. 🚀
> Let me know if you have any questions!

> ✅ **Good (human-shaped):**
> Chats open fast again — about half a second instead of six.
> The cause was that every tab switch re-read the whole history file, which had quietly grown to
> 16MB; it now keeps a small index instead.
> You'll notice it when switching between tabs — if you still get a spinner anywhere, tell me,
> because that means there's a path I missed.
> I didn't touch search, so search is still slow; that's a separate job.
> Tests pass and I clicked through it here, but I haven't run it against the production data volume,
> and reverting is one commit if it misbehaves.

_Word count: 47 vs 106. Facts delivered: 8 vs 5. Formatting marks: 0 vs 11._

---

## Appendix — the four questions to ask of any draft

1. **Could someone who wasn't there have written this?** If yes, it's missing the grain: the file
   name, the number, the time, the surprise. Add one specific and half the tells die with it.
2. **What did I delete?** If nothing, you skipped the step; 83% of people ADD words when editing
   ([Adams et al., via Behavioral Scientist](https://behavioralscientist.org/when-writing-for-busy-readers-less-is-more/)).
3. **Does the shape come from the content or from a template?** Intro-three-sections-recap on a
   one-line answer is a template.
4. **Would I say this sentence out loud to them?** Graham's read-aloud test catches register
   inflation faster than any checklist above.
