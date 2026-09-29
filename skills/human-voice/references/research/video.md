# Tells in AI-written VIDEO SCRIPTS (narration, not voice)

**Research unit: hv2-video · compiled 2026-09-25 · for writing naturally, not for evading detectors.**

Scope: what gives away the **words** of manhwa/manga recap channels, faceless YouTube (history, true crime, "explained", motivation), TikTok/Shorts story narration, Reddit-story channels and AI documentary voiceovers. Excludes the already-covered text corpus (Wikipedia "Signs of AI writing", Russell et al. ACL 2025, Kobak, Reinhart PNAS 2025, The Economist Jul 2026, delve/tapestry, em dash, "not X but Y", rule of three).

---

## 0. Method, and an honesty note on the primary corpus

Two evidence classes are used and kept separate throughout.

**(a) Measured corpus — my own, new.** On 2026-09-25 I pulled English subtitle tracks with `yt-dlp` for the top search results on "manhwa recap" plus two faceless WW2 documentaries, stripped the timing, and counted phrases. Seven scripts, **291,370 words total**:

| file             | channel                | uploaded   | length   | words  |
| ---------------- | ---------------------- | ---------- | -------- | ------ |
| ZzF1XpllnY8      | Manhwa Kiri            | 2026-09-25 | 8 h 57 m | 94,586 |
| ctrl_My-vEkJTP28 | Manhwa Fresh           | 2026-09-18 | 4 h 16 m | 52,923 |
| plOzoO8UPZk      | Daily Manhwas          | 2026-09-24 | 3 h 44 m | 46,289 |
| ctrl_o3ntGK6EwhA | ManhwaUpdater          | 2026-09-09 | 3 h 17 m | 38,281 |
| s4U56bCwKrE      | Love, Manhwa           | 2026-09-24 | 2 h 01 m | 25,761 |
| hist_dAHJ0omYo7U | Der Kommandant English | 2025-09-12 | 1 h 14 m | 11,481 |
| hist_FlNrx-m-Ld4 | EpicWar                | 2026-05-23 | 0 h 47 m | 6,049  |

**Caveats, stated up front.** I have no proof any _named_ channel used an LLM; I sampled the genre that viewers and YouTube both describe as machine-assembled, and I report what the words do. Two artefacts to discount: subtitles are ASR of synthetic speech, so **punctuation and quotation marks are unreliable** (I do not lean on them), and proper nouns are mangled — the very first words of the Daily Manhwas script transcribe as _"RMC only had to devour the demon king"_, which is ASR eating **"Our MC"**. The phrase counts and reported-speech verbs are robust to both artefacts. The two documentaries are a weak contrast set (different genre, ~6% of the corpus), not a human control.

**(b) Viewer testimony.** Reddit (via the Arctic Shift archive, since reddit.com blocks this host), Hacker News (Algolia API), and trade/press pages. Dates on everything; 2025–2026 weighted.

---

## 1. New tells

### T1 — "Our MC" / "our protagonist" as the character's actual name

**STRONG.** The single loudest tell in the recap genre, and it is measurable.

Verbatim, from the measured corpus:

- _"Our protagonist eventually arrives at the esteemed Marshall Hall, a massive building symbolizing the clan's long history."_ — Manhwa Fresh, 2026-09-18
- _"This leaves our MC thoroughly confused."_ — Manhwa Kiri, 2026-09-25
- _"But our MC didn't even care about all of these because he knew things that only he can exploit."_ — ManhwaUpdater, 2026-09-09
- _"The butler watches him and inwardly notes that our protagonist is holding the book upside down."_ — Manhwa Kiri, 2026-09-25

Rate: **221 occurrences of "our protagonist" in 52,923 words** (41.8 per 10k — roughly once every 240 words, i.e. about every 90 seconds of narration, sustained for four and a quarter hours). Manhwa Kiri: 54 "our MC" + 45 "our protagonist" + 21 "the MC". Present in 3 of 5 recap scripts sampled; absent from both documentaries.

Why people notice, in their words: it is the deixis of someone _summarising_ a story to a third party, not someone _telling_ one. A narrator inside the fiction says "Jin-Woo"; a summariser says "our protagonist". Viewers phrase the same intuition as texture: _"the summary sometimes feels so dry and rigid"_ (r/manhwa, 2025-07-20); _"They do not even narrate properly. The most brain dead shit."_ (r/manhwa, 2025-07-20).
Source: measured corpus; https://www.reddit.com/r/manhwa/comments/1m42kaz/titlethoughtson_manwhahua_youtube_tts_story/ (2025-07-19)

**Writing implication:** name your subject, then use pronouns. A recurring noun phrase standing in for a person is the smell of a summary.

---

### T2 — Everything is reported speech; nobody ever says anything

**STRONG**, and the deepest structural tell in the corpus. The source material is a comic — i.e. almost pure dialogue — and the script converts every speech bubble into indirect speech with a reporting verb.

Measured density per 10,000 words:

| verb                     | Manhwa Kiri   | Manhwa Fresh | Daily Manhwas | Love, Manhwa | ManhwaUpdater | both documentaries |
| ------------------------ | ------------- | ------------ | ------------- | ------------ | ------------- | ------------------ |
| "realizes that"          | 11.8          | 3.2          | 7.3           | 1.9          | 8.6           | 1.7 / 0.9          |
| "explains that"          | 6.3           | 12.3         | 8.6           | 7.0          | —             | —                  |
| "reveals that"           | 1.9           | 2.8          | 1.7           | 3.1          | —             | —                  |
| "inwardly"               | **9.2 (87×)** | 0.8          | —             | 0.4          | 0.3           | —                  |
| "tells/asks/informs him" | 5.6           | 7.9          | 8.6           | 10.1         | —             | —                  |

_"inwardly"_ is a genuinely rare English word appearing 87 times in one script — it is the machine's standard device for rendering a thought bubble. Verbatim: _"Regardless, Evan accepts the praise, and our protagonist reflects on hiring him specifically for his unwavering loyalty."_ (Manhwa Kiri, 2026-09-25).

Why people notice: they experience it as flatness and distance rather than as a grammar fact — _"the voices in these type of vids annoy me, not to mention the summary sometimes feels so dry and rigid"_ (2025-07-20); _"They ruin the whole experience … neither satisfying nor memorable"_ (2025-07-20).
Source: measured corpus; https://www.reddit.com/r/manhwa/comments/1m42kaz/ (2025-07-19/20)

**Writing implication:** if a real person said it, quote them. Wall-to-wall "X explains that Y" is the most reliable non-vocabulary signature of machine summarisation I found.

---

### T3 — Panel-description leakage: the script narrates the artwork, not the events

**MODERATE** (STRONG when it appears more than once).

- _"The scene shifts to…"_ — 16× in Manhwa Kiri, 14× in Manhwa Fresh, 2× in Love, Manhwa; **0× in both documentaries**.
- _"Meanwhile, inside a luxurious mansion, the pages of a book are being turned."_ — Manhwa Kiri opening, 2026-09-25 (passive, camera-positioned, no agent)
- _"Our story begins with a scene set 10 years in the future…"_ — same script, first sentence

The writer is looking at pages and describing them in order. A human telling you the same story says what happened, not where the camera went.
Source: measured corpus, 2026-09-25

---

### T4 — Compulsive re-anchoring of the subject

**STRONG** — people catch this on one sighting and it makes them angry.

> _"You mean the ones who feel the need to INCESSANTLY restate the era/decade/video title's NAME - in case we forget? **'In the 1970s/80s/90s' 'During the 1970s' 'In sports medicine'** AGGGHHHHH. We KNOW what video we're watching! Gtf ON with it!"_
> — r/youtube, 2026-04-12, https://www.reddit.com/r/youtube/comments/1sjd2gb/

Cause is mechanical: each section is generated with the topic restated in its prompt, so each section re-introduces it. Related failure in the same corpus is pronoun instability — _"kept mixing up he/she"_ (r/manhwa, 2025-07-20) and _"change characters names"_ (2025-07-20).

---

### T5 — Say it, then say it again slightly differently

**STRONG.** The most widely and independently reported script tell across every genre I searched, 2024 → 2026.

> _"my personnal pet peeve, reading a factoid out loud, and then repeating it with minimal reformulation to give the impression of vulgarization but just to pad out an extra 15 seconds of runtime."_ — r/youtube, 2026-04-12
> _"People with no talent use computers to repeat the exact same point three or four times, just rephrased slightly, looping the same eight minutes of footage back-to-back so that the single fact you clicked to find is buried in the final minute of a 30-minute video."_ — r/youtube, 2026-09-25
> _"They spend 1-3 hours talking constantly but saying very little, like it's just reading the same paragraph over and over again in different ways."_ — r/youtube, 2024-03-09
> _"It was about Sumerians and it was fine until it started repeating the same couple 'facts' over and over again. Super weird."_ — r/history, 2025-09-04

YouTube's own policy names the same shape (see T14). Note the escalation in the numbers: the 2024 complaint is about 1–3 hours; my 2026-09 sample includes a **single 8 h 57 m upload**.
Sources: https://www.reddit.com/r/youtube/comments/1sjd2gb/ · https://www.reddit.com/r/youtube/comments/1wlyktt/ · https://www.reddit.com/r/youtube/comments/1bamo41/ · https://www.reddit.com/r/history/comments/1n8lesp/

---

### T6 — The abstract opener that commits to nothing

**STRONG**, and viewers quote it back verbatim, which is the sign of a tell that has fully landed.

> _"'As we navigate the intricate tapestry of modern life, it's important to recognize the interconnected nature of our experiences and the evolving role of technology in shaping our shared future.' They say that shit and think it sounds normal lmao"_ — r/youtube, 2026-04-12
> _"'Think about how tech affects life.' fucking high-school essay looking ass sentence."_ — same thread, 2026-04-12
> _"Artificial intelligence is changing the world in many ways. In this video, we will explore…"_ — cited as the canonical weak AI hook by a faceless-channel guide, OverseerOS, 2026-06-04 (updated 2026-08-20)
> _"It is important to understand that this development could have significant implications…"_ — same guide

The genre marker is a **spoken** sentence built to written-essay spec. "Tapestry" is on the covered list, but the _construction_ — abstract subject + hedged significance claim + no referent — is the part that survives vocabulary swaps.
Sources: https://www.reddit.com/r/youtube/comments/1sjd2gb/ · https://www.overseeros.com/blog/ai-slop-faceless-youtube

---

### T7 — No first-person specifics: the script has never been anywhere

**STRONG.** The clearest articulation I found of _why_ an AI script reads wrong even when every sentence is fine.

> _"you can tell because they never actually share real story from their life, just these perfectly structured talking points that feel like they came straight from prompt … worst part is people in comments eating it up like its some deep wisdom when its just repackaged self help garbage that AI already recycled from actual books"_
> — r/youtube, 2026-04-12, https://www.reddit.com/r/youtube/comments/1sjd2gb/

Corroborated from the creator side: *"A script, (a good one atleast) can and should entirely, or heavily rely on one's own thoughts and perception for it to *actually* be interesting … AI is not human, and wouldn't add anything *original* to the discussion"* (r/youtube, 2026-09-24). And from HN: _"We all can tell the BS people are selling us, unoriginal ideas, shallow concepts, open ended questions"_ (2026-09-06, item 49583393).

**Writing implication:** one concrete, checkable, non-generic particular per section does more anti-AI work than any amount of vocabulary scrubbing.

---

### T8 — Stock emotional-beat phrases in story narration

**STRONG** — a viewer-compiled list, which is the best possible evidence that these are caught on one sighting. Asked what marks the AI Reddit-story videos, r/AmITheAngel answered with a bullet list:

> _"They always include — 'systematically' doing something · 'documenting everything' · 'color drained from her face' · 'opened and closed their mouth as if they were a fish out of water'"_
> — r/AmITheAngel, 2025-07-25, https://www.reddit.com/r/AmITheAngel/comments/1m8hwnw/

Replies in the same thread add the prop and cast inventory: _"there's always a good kind amazing character who helps the protagonist with the surname 'chen', 'rodriguez', and/or 'patel'"_ (2025-07-24); _"Forgot to mention the night shifts at the hospital, beat up Honda, and working nights at a diner"_ (2025-07-25); _"Don't forget 'Judge Harrison'"_ (2025-10-19). A commenter's verdict on the register: _"We're using 12 year old script writing skills with these🤣 especially color drainage and the mouth agape"_ (2025-07-25).

---

### T9 — One plot, regenerated

**STRONG** for the story-narration genres. The template is described identically by unrelated viewers:

> _"They sound like soap operas and they all have the same basic plot: Someone (a family member or business partner) committed a gross injustice (stole their inheritance, embezzled money) and laughed in their face about their powerlessness to right the wrong. The victim is then able to concoct a brilliant scheme to turn the tables and recover whatever was taken from them, bring them to justice, and laugh at them while living happily ever after."_ — r/DeadInternetTheory, 2025-07-06
> _"many of them always seem to hinge on young girls being abused and they seem to, miraculously, get a recording devise to prove the evil person's guilt."_ — r/AmITheAngel, 2025-07-24
> _"templates that repeat the same emotional pattern: sad child, poor man, rich villain, shocking twist"_ — OverseerOS, 2026-06-04

This is the tell YouTube's policy is actually written against (T14): not any single sentence, but _interchangeability_.
Sources: https://www.reddit.com/r/DeadInternetTheory/comments/1glw7w2/ · https://www.reddit.com/r/AmITheAngel/comments/1m8hwnw/

---

### T10 — Written connectives in spoken narration

**MODERATE** (individually weak, decisive in aggregate — high false-positive risk on any single instance).

Measured per 10,000 words across the five recap scripts: **"however" 3.5–14.4**, **"suddenly" 9.3–12.8**, **"meanwhile" 2.3–9.3**, **"just then" 0.4–3.6**, **"at that moment" 0.4–2.7**. Manhwa Kiri alone: _however_ 136×, _suddenly_ 98×, _meanwhile_ 88×, _just then_ 34×.

"However" is a written-register connective; a person talking says "but". "Suddenly" and "just then" are the machine's way of covering a panel cut it cannot dramatise. The cross-channel consistency is the real finding: **five unrelated channels, the same connective skeleton at the same rates.**
Source: measured corpus, 2026-09-25

---

### T11 — Metronome sentence rhythm

**WEAK — reported for completeness, with its own counter-evidence.** Sentence-length standard deviation in the five recap scripts: 5.9–6.6 words (means 12.4–20.0). In the two documentaries: 7.8 and 8.8. So the recap scripts vary less. But the sample is tiny, the genres differ, and ASR sentence segmentation is unreliable — **do not use this as a detector.** It is listed because it is the measurable version of a claim people make everywhere (_"Every sentence lands at the same length, like a metronome"_ — imperfectly.app, ~2026-09) and it deserves to be marked as thin rather than repeated as folklore.

---

### T12 — Confident fabrication paired with a mismatched detail

**STRONG** in history/documentary, because the audience is subject-matter expert enough to catch it.

> _"I was watching a ww2 documentary on YT few months ago and could tell the script was total ChatGPT that literally made up facts. A few of B roll photos were of jet fighters from the 1960's…"_ — r/youtube, 2026-04-03
> _"Their latest video on the life and times of Puyi, China's last emperor, struck a bad chord because it was so poorly written and full of awful factual errors. I, and many others it seems, figured out that instead of a well-researched video essay, they tossed the whole thing into an AI and just read out the nonsense verbatim!"_ — r/youtubedrama on Kings and Generals, 2024-06-26
> _"many of the scripts are highly formulaic and more dramatized than historical"_ — r/youtube, 2025-12-01
> _"I don't think there is ANY way any historian could realistically create a 40-60 minute documentary based on some of the supposed 'journal entries' of soldiers' diaries."_ — r/youtube, 2026-03-19

Note the shape: it is not the error alone, it is **fluent unhedged prose around an error a real researcher would have hedged.**
Sources: https://www.reddit.com/r/youtube/comments/1saj8y8/ · https://www.reddit.com/r/youtubedrama/comments/1dp7ugc/ · https://www.reddit.com/r/youtube/comments/1pbbfuy/

---

### T13 — Buried payload / runtime-to-substance ratio

**STRONG.** Not a sentence tell — a document-shape tell, and the one that converts irritation into unsubscribing.

> _"the single fact you clicked to find is buried in the final minute of a 30-minute video"_ — r/youtube, 2026-09-25
> _"they make a 5 hour video explaining 30 ch of content, with bad narration"_ — r/manhwa, 2025-07-20
> _"It takes 5mins to read a manhua/wa chapter but an hour to listen to those crap on YouTube."_ — r/manhwa, 2025-07-20

My corpus corroborates the ratio directly: 94,586 words of narration in one upload.

---

### T14 — The platform's own description of the pattern (useful as a checklist)

YouTube renamed "repetitious content" to **"inauthentic content"** effective **2025-07-15**, and the policy language is a surprisingly precise description of AI script output. Verbatim from the help page:

- content must _"not be mass-produced, generic, repetitive, or manipulative"_
- prohibited: _"content that looks like it's made with a template, or that may feel repetitive"_
- prohibited: _"Similar or repetitive content with low educational value, commentary, narratives, or minimal variation"_
- prohibited: _"Videos where characters are put in the same situation over and over again with the same outcome"_
- prohibited: _"Image slideshows, templated storylines, or scrolling text with minimal or no narrative"_
- prohibited: _"AI-generated content made with generic or unoriginal templates"_
- requirement: the substance of each video _"should be materially varied and deliver creative, educational, or other value"_
- disqualifier: _"content feels interchangeable from video to video"_

The operative concept is **interchangeability**, not authorship — which matches how viewers actually judge (T9).
Source: https://support.google.com/youtube/answer/1311392 (policy update 2025-07-15); clarification coverage https://www.socialmediatoday.com/news/youtube-clarifies-monetization-update-inauthentic-repeated-content/752892/

Scale context (Search Engine Journal, 2026-03-02): AI slop is **21% of Shorts shown to new users**; **278 exclusively-AI channels** hold ~63bn views and ~221m subscribers; **10% of YouTube's 100 fastest-growing channels** publish only AI-generated content; consumer trust falls ~50% when content is _perceived_ as AI-generated **regardless of actual origin**. YouTube CEO Neal Mohan used the phrase "AI slop" in his January 2026 annual letter. Enforcement in Jan 2026 removed or wiped 16 leading AI channels (~35m subs, 4.7bn views).

---

### T15 — The recap-specific "no source" move

**MODERATE** — not itself an AI tell, but it co-occurs so reliably in this genre that viewers treat it as part of the same package, and it is the single most-upvoted complaint in the manhwa threads (221 points).

> _"I hate them. Often they have good recommendations but they never give the title of the work so i can never find it"_ — r/manhwa, 2025-07-19 (+221)
> _"99% of them don't even bother listing the actual title to force people to engage in the comment section to boost their video popularity."_ — 2025-07-20
> _"It is annoying AF to have to do this consistently"_ — r/youtube, 2023-10-13

---

## 2. What people said — verbatim

1. _"Yeah I get like a tingle in my head a few minutes in and in like yeah this dude used a chat bot LOL it instantly feels unauthentic to me and I bail from the video."_ — r/youtube, **2026-04-16**, https://www.reddit.com/r/youtube/comments/1sjd2gb/
2. _"You mean the ones who feel the need to INCESSANTLY restate the era/decade/video title's NAME - in case we forget? 'In the 1970s/80s/90s' 'During the 1970s' 'In sports medicine' AGGGHHHHH. We KNOW what video we're watching! Gtf ON with it!"_ — r/youtube, **2026-04-12**, same thread
3. _"my personnal pet peeve, reading a factoid out loud, and then repeating it with minimal reformulation to give the impression of vulgarization but just to pad out an extra 15 seconds of runtime."_ — r/youtube, **2026-04-12**, same thread
4. _"yeah its really annoying, especially when they try to sound all wise and personal but then say stuff like 'as we navigate the complexities of modern life' … you can tell because they never actually share real story from their life, just these perfectly structured talking points that feel like they came straight from prompt"_ — r/youtube, **2026-04-12**, same thread
5. _"'Think about how tech affects life.' fucking high-school essay looking ass sentence."_ — r/youtube, **2026-04-12**, same thread
6. _"i had it in my recommended and watched it for a little bit but because the voice was ai and the script also sounded like ai considering that the channel was VERY new it threw me off completely and i just stopped watching"_ — r/youtube, **2026-09-22** (+261), https://www.reddit.com/r/youtube/comments/1wmty3y/
7. _"Oh okay I was listening and I'm like, his voice sounds very much human to me, maybe a little monotone.. I can typically can tell pretty well when the script is using AI, I didn't really notice here."_ — r/youtube, **2026-09-22** (+21), same thread
8. _"Dude the script sounded like ai, 'purely academic tone' my ass."_ — r/youtube, **2026-09-22** (+8), same thread
9. _"They always include — 'systematically' doing something · 'documenting everything' · 'color drained from her face' · 'opened and closed their mouth as if they were a fish out of water'"_ — r/AmITheAngel, **2025-07-25** (+18), https://www.reddit.com/r/AmITheAngel/comments/1m8hwnw/
10. _"there's always a good kind amazing character who helps the protagonist with the surname 'chen', 'rodriguez', and/or 'patel'."_ — r/AmITheAngel, **2025-07-24**, same thread
11. _"They sound like soap operas and they all have the same basic plot: Someone … committed a gross injustice … The victim is then able to concoct a brilliant scheme to turn the tables … and laugh at them while living happily ever after."_ — r/DeadInternetTheory, **2025-07-06**, https://www.reddit.com/r/DeadInternetTheory/comments/1glw7w2/
12. _"They spend 1-3 hours talking constantly but saying very little, like it's just reading the same paragraph over and over again in different ways, while unrelated stock videos also play multiple times in one documentary."_ — r/youtube, **2024-03-09**, https://www.reddit.com/r/youtube/comments/1bamo41/
13. _"It's terrible. I was watching a ww2 documentary on YT few months ago and could tell the script was total ChatGPT that literally made up facts. A few of B roll photos were of jet fighters from the 1960's…"_ — r/youtube, **2026-04-03**, https://www.reddit.com/r/youtube/comments/1saj8y8/
14. _"Their latest video … was so poorly written and full of awful factual errors. I, and many others it seems, figured out that instead of a well-researched video essay, they tossed the whole thing into an AI and just read out the nonsense verbatim!"_ — r/youtubedrama on Kings and Generals, **2024-06-26**, https://www.reddit.com/r/youtubedrama/comments/1dp7ugc/
15. _"scripts, voice, thumbnails, and images are obviously AI generated … many of the scripts are highly formulaic and more dramatized than historical"_ — r/youtube, **2025-12-01**, https://www.reddit.com/r/youtube/comments/1pbbfuy/
16. _"I ran into one of these the other day! It was about Sumerians and it was fine until it started repeating the same couple 'facts' over and over again. Super weird."_ — r/history, **2025-09-04**, https://www.reddit.com/r/history/comments/1n8lesp/
17. _"I tried listening to one the whole way through but the voices in these type of vids annoy me, not to mention the summary sometimes feels so dry and rigid."_ — r/manhwa, **2025-07-20**, https://www.reddit.com/r/manhwa/comments/1m42kaz/
18. _"THAT SAID, PLEASE SHOW HIM ANYTHING BUT LAZY AI RECAPS … The scripts aren't even written by real people. It's fully just comics/manwa/etc being fed into a machine and spat out scripted, TTS'd, and 'edited' by AI"_ — r/manhwa, **2025-11-16**, same thread
19. _"it's just ai slops in the name of manhua/manhwa narration and in general they make a 5 hour video explaining 30 ch of content, with bad narration and don't provide the title"_ — r/manhwa, **2025-07-20**, same thread
20. _"People with no talent use computers to repeat the exact same point three or four times, just rephrased slightly … so that the single fact you clicked to find is buried in the final minute of a 30-minute video."_ — r/youtube, **2026-09-25**, https://www.reddit.com/r/youtube/comments/1wlyktt/
21. _"What's worse now it seems people are writing their YouTube scripts with Claude et al. so at times even if it is a human creator you can clearly and immediately tell the words are not their own. To those creators I have but one message: IT SUCKS. I'd rather have you ramble incoherently in your mic then reading an LLM script and I will remove you from my feed immediately."_ — Hacker News, **2026-09-06**, https://news.ycombinator.com/item?id=49583393
22. _"I'll be unsubscribing to those writing scripts with AI as well, as I notice them."_ — Hacker News, **2026-06-12**, https://news.ycombinator.com/item?id=48499762
23. _"Yeah most of the video essay side of youtube has gone down the shitter. Full of obviously AI scripts."_ — r/youtube, **2026-09-25**, https://www.reddit.com/comments/1wol3wr/_/pbx5jrl
24. _"This is a genuine question since I'd really like to learn more, but how do you know it's scripted AI stuff? I'm terrible at being able to discern AI stuff"_ — r/youtube, **2026-09-24**, https://www.reddit.com/comments/1wovt03/_/pbv46yv (the counter-case: the skill is unevenly distributed)

---

## 3. What is NEW since mid-2025

Ordered by how much the tell itself has moved, not by how loud the complaint is.

1. **The complaint object shifted from the VOICE to the SCRIPT.** This is the headline change. 2023–2024 manhwa/recap threads are almost entirely about TTS: _"The mistakes and weird pronunciations of AI voices can be annoying"_ (2024-06-05), _"Most recap uses bad AI voice"_ (2023-05-29). By September 2026 the two are explicitly separated, and the script is judged independently of a human voice: _"his voice sounds very much human to me … I can typically can tell pretty well when the script is using AI"_ (2026-09-22). A viewer flagging an AI script **on a real human's voice** is a 2026 phenomenon and did not appear in my 2024 material.

2. **"Our MC / our protagonist" at industrial density.** My 2026-09 sample shows 41.8 per 10k words. I found no 2024-era complaint naming this phrase, which suggests either that it is new or — more likely — that it is still _below_ the threshold of conscious noticing for most viewers even as it saturates the genre. Worth watching: it is currently a near-perfect marker precisely because nobody has been taught it yet.

3. **Runtime inflation.** 2024 complaints top out at "1-3 hours" (2024-03-09). My 2026-09-25 sample includes a **single 8 h 57 m / 94,586-word** upload, and a genre norm of 2–4 hours. The padding tell (T5) scales with it.

4. **Policy language exists now.** "Inauthentic content" (2025-07-15) gave people a shared vocabulary — _"mass-produced"_, _"templated"_, _"interchangeable from video to video"_ — for what they had been describing ad hoc since 2024. By 2026 creators reason in policy terms: _"I 100% think its the format pattern … its only train on this pattern is recognizable AI slop content and then scoops you into the net with everyone else"_ (r/NewTubers, 2026-09-24).

5. **The stock-phrase lists went public.** The AmITheAngel bullet list (2025-07-25) is the clearest example: viewers now trade _specific quotable strings_ ("color drained from her face", "Judge Harrison") rather than general vibes. A tell that becomes a meme burns out fast — expect these four to be scrubbed from generated scripts within months, and expect the _structural_ tells (T2, T9, T13) to outlast them.

6. **Crowd tooling.** A "real or slop" crowd-voted Firefox extension is being recommended in r/youtube as of **2026-04-02** — viewer detection is becoming collective rather than individual.

7. **Scale figures only exist from 2026.** 21% of Shorts to new users; 278 all-AI channels at 63bn views; 10% of the 100 fastest-growing channels (SEJ, 2026-03-02); YouTube's CEO adopting the term "AI slop" in the January 2026 annual letter.

---

## 4. Why this trains people to notice it elsewhere — and the honest limits

**The mechanism, from the evidence.** A recap/faceless script is the same generator running for hours at a time on one topic. That does something a paragraph of AI text cannot: it lets the reader **hear the same device recur**. 221 instances of "our protagonist" in one sitting is not a subtle statistical signal, it is a drumbeat. Someone watching a few of these a week is effectively doing supervised training on high-density positive examples — and the features they learn (T1 substitute-noun deixis, T2 reported speech, T5 restate-padding, T6 abstract opener, T7 missing particulars) are **register and structure features, not vocabulary features**, so they transfer straight to prose. That is precisely why they survive a "delve"-scrub and why they show up in the owner's reported experience.

The subjective form of the transfer is described consistently:

- _"Yeah I get like a tingle in my head a few minutes in"_ — r/youtube, 2026-04-16
- _"you can clearly and immediately tell the words are not their own"_ — HN, 2026-09-06
- _"Once you learn to see it, you can't unsee it"_ — imperfectly.app, ~2026-09 ("AI writing has a shape")
- _"AI reuses a few sentence shapes too, and once you see them, you see them everywhere"_ — gptinf.com, 2026-08-20

**The limits, stated plainly.** Three pieces of counter-evidence keep this from being a clean story:

- **It is not universal.** _"This is a genuine question since I'd really like to learn more, but how do you know it's scripted AI stuff? I'm terrible at being able to discern AI stuff"_ (r/youtube, 2026-09-24). And in the same thread as the +261 "the script also sounded like ai" comment, another viewer with the same intent missed it entirely.
- **Trained intuition misfires, and the cost is asymmetric.** SEJ (2026-03-02) reports consumer trust drops ~50% when content is _perceived_ as AI-generated **regardless of actual origin**. Heavy exposure produces false positives on human writers who happen to be tidy.
- **The academic position is "maybe".** Celeste Rodriguez Louro (The Conversation / UWA, **2026-08-25**) finds _"there is no single giveaway"_ and warns that _"LLMs are also updated rapidly and efficiently so what gives away synthetic text today may no longer do a few months from now"_; she cites the 2023 Stanford result that seven detectors falsely flagged **61%** of essays by non-native English speakers. She offers no evidence that exposure trains detection — that part is testimony, not a finding.

**So the defensible claim** is narrow and worth stating precisely: watching high-volume AI narration is unusually good at surfacing _structural_ habits, because volume is what makes a habit visible. It does not confer reliable detection, and the tells it teaches have a short half-life.

---

## 5. Consolidated writing implications

Ranked by how much they buy, given everything above:

1. **Name people and things; then use pronouns.** Never a recurring substitute noun phrase ("our protagonist", "the user", "this technology") where a name belongs. (T1)
2. **Quote what was said.** Reported speech everywhere — "X explains that…", "Y realizes that…" — is the strongest non-vocabulary signature found. (T2)
3. **Say it once.** If a sentence restates the previous one in different words, cut it. This is the most-reported tell across every genre and all three years. (T5)
4. **Put the payload early, and make the length match the content.** Buried-lede padding is what converts irritation into leaving. (T13)
5. **One concrete particular per section** — something checkable that only someone who was there would know. Its absence is what people mean by "feels like it came straight from prompt". (T7)
6. **Open on something, not on significance.** No abstract-subject + hedged-implication opener. (T6)
7. **Talk, don't write.** "But" not "however"; drop "meanwhile", "just then", "at that moment" as scene glue. (T10)
8. **Vary the plot shape, not just the words.** Interchangeability is what platforms and viewers both punish. (T9, T14)
9. **Hedge where a real expert would hedge.** Unhedged fluency around a shaky fact is the documentary tell. (T12)
10. Do **not** trust sentence-length variance, quotation-mark counts, or any single connective as a detector. (T11)

---

## 6. Sources

**Primary — measured by me, 2026-09-25** (`yt-dlp` English subtitle tracks; working files in `/tmp/subs/`):

- Manhwa Kiri — https://www.youtube.com/watch?v=ZzF1XpllnY8 (2026-09-25, 8 h 57 m, 94,586 w)
- Manhwa Fresh — https://www.youtube.com/watch?v=My-vEkJTP28 (2026-09-18, 4 h 16 m, 52,923 w)
- Daily Manhwas — https://www.youtube.com/watch?v=plOzoO8UPZk (2026-09-24, 3 h 44 m, 46,289 w)
- ManhwaUpdater — https://www.youtube.com/watch?v=o3ntGK6EwhA (2026-09-09, 3 h 17 m, 38,281 w)
- Love, Manhwa — https://www.youtube.com/watch?v=s4U56bCwKrE (2026-09-24, 2 h 01 m, 25,761 w)
- Der Kommandant English — https://www.youtube.com/watch?v=dAHJ0omYo7U (2025-09-12, contrast set)
- EpicWar — https://www.youtube.com/watch?v=FlNrx-m-Ld4 (2026-05-23, contrast set)

**Reddit** (retrieved via the Arctic Shift archive API, `arctic-shift.photon-reddit.com`; reddit.com blocks this host at the network level):

- r/youtube, "so may channels now where people just read out AI scripts?" — https://www.reddit.com/r/youtube/comments/1sjd2gb/ (2026-04-12)
- r/youtube, "Fed up with these AI slop channels everywhere" — https://www.reddit.com/r/youtube/comments/1saj8y8/ (2026-04-02)
- r/youtube, MrBeast/dogpack AI-script thread — https://www.reddit.com/r/youtube/comments/1wmty3y/ (2026-09-22)
- r/youtube, AI-slop feed-blocking thread — https://www.reddit.com/r/youtube/comments/1wlyktt/ (2026-09-25)
- r/youtube, "Has anyone noticed the number of obvious AI written 'documentaries'" — https://www.reddit.com/r/youtube/comments/1bamo41/ (2024-03-09)
- r/youtube, "AI history channels are proliferating" — https://www.reddit.com/r/youtube/comments/1pbbfuy/ (2025-12-01)
- r/youtube, "my problem with recap reddits like for manga or manhwa" — https://www.reddit.com/r/youtube/comments/176wrk9/ (2023-10-13)
- r/manhwa, "Thoughts on manwha/hua YouTube TTS story tellers" — https://www.reddit.com/r/manhwa/comments/1m42kaz/ (2025-07-19)
- r/manhwa, "Are there some manhwa recap channels that don't use ai voices?" — https://www.reddit.com/r/manhwa/comments/1d8yda5/ (2024-06-05)
- r/manhwa, "5 Manhwa Recap Channels You Must Follow" — https://www.reddit.com/r/manhwa/comments/13v9dzr/ (2023-05-29)
- r/AmITheAngel, "fake and really dramatic ai TikTok Reddit stories" — https://www.reddit.com/r/AmITheAngel/comments/1m8hwnw/ (2025-07-24)
- r/DeadInternetTheory, "obviously AI generated stories on TikTok" — https://www.reddit.com/r/DeadInternetTheory/comments/1glw7w2/ (2024-11-07)
- r/history, "AI Generated 'Boring History' Videos Are Flooding YouTube" — https://www.reddit.com/r/history/comments/1n8lesp/ (2025-09-04)
- r/history, "'Amateur and dangerous': Historians weigh in on viral AI history videos" — https://www.reddit.com/r/history/comments/1iwjz7w/ (2025-02-23)
- r/youtubedrama, Kings and Generals AI scripts — https://www.reddit.com/r/youtubedrama/comments/1dp7ugc/ (2024-06-26)
- r/NewTubers, repetitive-content demonetization threads — https://www.reddit.com/r/NewTubers/comments/1wndbzq/ (2026-09-24); https://www.reddit.com/r/NewTubers/comments/1o31zg9/ (2025-10-10)
- r/PartneredYoutube, "How are these 'Recap' accounts not getting taken down?" — https://www.reddit.com/r/PartneredYoutube/comments/1exvn7o/ (2024-08-21)
- r/TrueCrimeDiscussion, non-AI-narration channel list — https://www.reddit.com/r/TrueCrimeDiscussion/comments/1i6kkl2/ (2025-01-21)
- r/rant, movie/manhwa recap channels — https://www.reddit.com/r/rant/comments/1cz0w1m/ (2024-05-23)

**Hacker News** (Algolia comment API):

- https://news.ycombinator.com/item?id=49583393 (2026-09-06) · =48499762 (2026-06-12) · =48965887 (2026-07-19) · =44923161 (2025-08-16) · =47641701 (2026-04-04)

**Platform / policy / press:**

- YouTube channel monetization policies, "inauthentic content" — https://support.google.com/youtube/answer/1311392 (renamed 2025-07-15)
- Social Media Today, YouTube clarifies the update — https://www.socialmediatoday.com/news/youtube-clarifies-monetization-update-inauthentic-repeated-content/752892/ (2025-07)
- Search Engine Journal, "YouTube's AI Slop Problem" — https://www.searchenginejournal.com/youtubes-ai-slop-problem-and-how-marketers-can-compete/567297/ (2026-03-02)
- SlopDetector, "How to Spot AI Slop on YouTube" — https://slopdetector.org/blog/youtube-ai-slop (2026-06-30)
- OverseerOS, "AI Slop Is Killing Faceless YouTube" — https://www.overseeros.com/blog/ai-slop-faceless-youtube (2026-06-04, upd. 2026-08-20)
- ScaleLab, YouTube's AI crackdown in 2026 — https://scalelab.com/en/why-youtube-is-cracking-down-on-ai-generated-content-in-2026
- Digital Camera World / Yahoo Tech, YouTube vs "AI slop" brain-rot channels — https://www.digitalcameraworld.com/tech/artificial-intelligence/youtube-gets-tough-on-ai-slop-ruining-the-party-for-million-dollar-brain-rot-video-channels

**On the noticing/transfer question:**

- Celeste Rodriguez Louro, "Can you teach yourself to detect AI writing? Maybe" — https://theconversation.com/can-you-teach-yourself-to-detect-ai-writing-maybe-289236 (2026-08-25)
- imperfectly.app, "7 common AI writing patterns" — https://imperfectly.app/post/common-ai-writing-patterns (~2026-09)
- gptinf.com, "How to Avoid AI Detection in Writing" — https://www.gptinf.com/blog/how-to-avoid-ai-detection-in-writing (2026-08-20) — cited only for its description of transition-stacking

**Creator-side templates** (useful as the _source_ of the tells):

- FluxNote, "The Complete AI Workflow for Manhwa Recap YouTube Channels" — https://fluxnote.io/guides/ai-workflow-manhwa-recap-channel (2026-03-09)
- zachdoesAI, "The Faceless YouTube Playbook" — https://zachdoesai.com/guides/faceless-youtube-playbook (2026-06)
- RecapDrop — https://www.recapdrop.com/ · YTVoice anime-recap use case — https://ytvoice.app/use-cases/anime-recap-youtube

**Access notes for whoever picks this up next:** reddit.com, old.reddit.com and r.jina.ai→reddit all return 403 from this host; PullPush is paywalled; Redlib mirrors sit behind an Anubis proof-of-work gate. Arctic Shift works (`/api/comments/search?subreddit=X&body=Y`, `body` requires a subreddit, `limit` ≤ 100, rate-limits quickly). `yt-dlp --no-config --skip-download --write-auto-subs` works; the local yt-dlp config otherwise forces a format request and fails.
