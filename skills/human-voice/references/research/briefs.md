# Research briefs (2026-09-24) — re-run these as parallel subagents to refresh the skill

Each brief was spawned with claude-code/claude-opus-5-5, thinking medium, 1500 s timeout, and wrote its report to a file. The first wave wrote under /tmp, which a reboot wipes; the second wave wrote under the agent workspace, and every brief below now does the same. Replace `<workspace>` with your agent workspace and `<date>` with the run date. The voice brief reads only the owner's local archive; its output goes to the owner's private voice profile (the files `HUMAN_VOICE_PROFILE` points at), never into this folder.

## en

```
RESEARCH UNIT: ENGLISH tells of AI-written text (2024-2026).
Must cover at minimum: Wikipedia "Signs of AI writing" (fetch the full page, it is the best single list); Russell, Karpinska & Iyyer 2025 "People who frequently use ChatGPT for writing tasks are accurate and robust detectors of AI-generated text" (what cues the expert annotators cited); Kobak et al. 2024/2025 "Delving into ChatGPT usage in academic writing through excess vocabulary" (the excess-word list, e.g. delves, showcasing, underscores); the em-dash debate (HN/Reddit, include the false-positive argument); "It's not X, it's Y" / negative parallelism; rule of three; sycophantic openers and closers in emails ("I hope this email finds you well", "Let me know if you have any questions"); LLM status-report habits (headers for three lines, bold everywhere, "I've successfully..."); GitHub humanizer projects (e.g. blader/humanizer and similar) for their pattern lists; Pangram/GPTZero/Originality blog posts on tells; Reddit r/Teachers, r/writing, r/ChatGPT threads "how do you spot AI".

HOW TO WORK: You have web access. Load the tools first with ToolSearch query "select:WebSearch,WebFetch". Search widely (15+ searches), fetch the best 10-20 pages in full, including forum/community threads where real people list the tells they notice (Reddit, Hacker News, X/Twitter threads quoted in articles, teacher and editor forums). Prefer primary sources and dated evidence. The goal is to help an assistant WRITE like a clear, natural human in real emails and messages — not to evade detectors, so skip "bypass detector" spam sites.
OUTPUT (markdown, dense, no fluff), written to the report file named below:
1. Tells taxonomy: for each tell give (a) name, (b) 2-3 real examples in the target language, (c) a natural rewrite, (d) strength: STRONG (almost only AI), MODERATE (AI-typical in density), WEAK (humans do it too — flag the false positive), (e) the source URL(s).
2. A word/phrase list: overused AI vocabulary and stock phrases in the target language, each with 1-3 plain replacements.
3. Structural/genre tells (layout, rhythm, openings, closings, formatting) — these matter more than single words.
4. "What real people said": 8-15 short quotes or paraphrases from forum/community threads about how they spot AI text, with URL.
5. Sources list (URL + one line + date if known).
Be concrete. Every claim either has a source or is marked as your own inference.
Report file: <workspace>/context/hv-<date>/en.report.md
Write your full report to <workspace>/context/hv-<date>/en.report.md and finish.
```

## es

```
RESEARCH UNIT: SPANISH (castellano) tells of AI-written text (2024-2026). Write the report in English, but all examples and word lists in Spanish.
Must cover: Spanish-language articles and threads on "cómo detectar un texto escrito por ChatGPT/IA", "palabras que usa ChatGPT", "muletillas de la IA" (Xataka, Genbeta, El País, elDiario.es, Maldita, Newtral, Fundéu RAE on anglicismos y calcos, blogs de profesores y correctores); Reddit r/es, r/spain, r/askspain, Forocoches/Menéame threads if reachable; typical AI Spanish vocabulary (e.g. "crucial", "fundamental", "en el vertiginoso mundo de", "sumergirse/adentrarse", "un sinfín de", "potenciar", "cabe destacar", "en resumen", "sin duda alguna", "no solo... sino también", "en definitiva"); calques from English that AI Spanish carries (title case in headings, gerundio de posterioridad, comillas inglesas vs «», voz pasiva perifrástica, possessives overuse, "Espero que esto te ayude", "¡Claro!", "Estimado/a" misuse); register mistakes (tú/usted mixing, over-formal emails); how real Spaniards write WhatsApp/email (short, "Buenas", "Un abrazo", "Gracias!", abbreviations "q", "xq", "tb" in casual chats) — and false positives.

HOW TO WORK: You have web access. Load the tools first with ToolSearch query "select:WebSearch,WebFetch". Search widely (15+ searches), fetch the best 10-20 pages in full, including forum/community threads where real people list the tells they notice (Reddit, Hacker News, X/Twitter threads quoted in articles, teacher and editor forums). Prefer primary sources and dated evidence. The goal is to help an assistant WRITE like a clear, natural human in real emails and messages — not to evade detectors, so skip "bypass detector" spam sites.
OUTPUT (markdown, dense, no fluff), written to the report file named below:
1. Tells taxonomy: for each tell give (a) name, (b) 2-3 real examples in the target language, (c) a natural rewrite, (d) strength: STRONG (almost only AI), MODERATE (AI-typical in density), WEAK (humans do it too — flag the false positive), (e) the source URL(s).
2. A word/phrase list: overused AI vocabulary and stock phrases in the target language, each with 1-3 plain replacements.
3. Structural/genre tells (layout, rhythm, openings, closings, formatting) — these matter more than single words.
4. "What real people said": 8-15 short quotes or paraphrases from forum/community threads about how they spot AI text, with URL.
5. Sources list (URL + one line + date if known).
Be concrete. Every claim either has a source or is marked as your own inference.
Report file: <workspace>/context/hv-<date>/es.report.md
Write your full report to <workspace>/context/hv-<date>/es.report.md and finish.
```

## ca

```
RESEARCH UNIT: CATALAN tells of AI-written text (2024-2026). Write the report in English, but all examples and word lists in Catalan.
Must cover: Catalan sources (VilaWeb, Núvol, Ara, El Nacional, Softcatalà, Optimot/TERMCAT guidance, Racó Català, r/catalunya, teachers' blogs, Plataforma per la Llengua) on "com detectar textos fets amb IA", "català de la IA", "català artificial"; AI Catalan problems: castellanismes and calcs of English/Spanish ("a més a més" everywhere, "cal destacar", "en definitiva", "clau", "fonamental", "endinsar-se", "submergir-se", "un munt de" misuse, "tanmateix" overuse, "de cara a", "en base a", "degut a", "doncs" as causal), wrong or stiff register (vostè vs tu), gerunds, apostrophe/hyphen/pronom feble errors typical of machine Catalan, dialect mixing (central vs valencià vs balear forms), over-formal "Benvolgut/Benvolguda" in casual contexts; how real Catalans write emails and WhatsApp (e.g. "Bon dia!", "Molt bé", "Gràcies!", "Una abraçada", "fins aviat", "q", "xq", "tb", "dw"), and false positives. If Catalan sources are thin, say so and fall back to careful inference from Spanish/English research plus Catalan style guides (Llibre d'estil, Optimot), labelled as inference.

HOW TO WORK: You have web access. Load the tools first with ToolSearch query "select:WebSearch,WebFetch". Search widely (15+ searches), fetch the best 10-20 pages in full, including forum/community threads where real people list the tells they notice (Reddit, Hacker News, X/Twitter threads quoted in articles, teacher and editor forums). Prefer primary sources and dated evidence. The goal is to help an assistant WRITE like a clear, natural human in real emails and messages — not to evade detectors, so skip "bypass detector" spam sites.
OUTPUT (markdown, dense, no fluff), written to the report file named below:
1. Tells taxonomy: for each tell give (a) name, (b) 2-3 real examples in the target language, (c) a natural rewrite, (d) strength: STRONG (almost only AI), MODERATE (AI-typical in density), WEAK (humans do it too — flag the false positive), (e) the source URL(s).
2. A word/phrase list: overused AI vocabulary and stock phrases in the target language, each with 1-3 plain replacements.
3. Structural/genre tells (layout, rhythm, openings, closings, formatting) — these matter more than single words.
4. "What real people said": 8-15 short quotes or paraphrases from forum/community threads about how they spot AI text, with URL.
5. Sources list (URL + one line + date if known).
Be concrete. Every claim either has a source or is marked as your own inference.
Report file: <workspace>/context/hv-<date>/ca.report.md
Write your full report to <workspace>/context/hv-<date>/ca.report.md and finish.
```

## craft

```
RESEARCH UNIT: THE CRAFT of writing like a clear, natural human in EMAILS, CHAT MESSAGES, and when EXPLAINING CODE CHANGES to a busy technical owner.
Must cover: Rogers & Lasky-Fink "Writing for Busy Readers" (the 6 principles); BLUF / answer-first; Gopen & Swan "The Science of Scientific Writing" (reader expectations); plain-language guidance (plainlanguage.gov, UK GOV.UK style); Orwell's six rules; Paul Graham "Write Simply" and "Writing, Briefly"; Gretchen McCulloch "Because Internet" on how people actually write in chat (lowercase, punctuation as tone, message splitting, emoji); email etiquette research on length and openers; how good engineers explain changes (good commit messages, PR descriptions, "what changed / why / what you will notice / what I did not do"), incident write-ups in plain words, and how to explain a code change to a non-reviewing owner low-key without jargon walls; anti-patterns of AI assistants' status reports (over-structuring, every line bolded, headers for 3 lines, hedging, restating the question, fake certainty, "I have successfully"). Also: how humans signal uncertainty honestly and how they disagree politely in writing.
Deliver, in addition to the standard output: (6) a one-page checklist for an email, (7) for a WhatsApp/chat message, (8) for explaining a code change to the owner in 3-6 plain sentences, each with a bad/good example pair.

HOW TO WORK: You have web access. Load the tools first with ToolSearch query "select:WebSearch,WebFetch". Search widely (15+ searches), fetch the best 10-20 pages in full, including forum/community threads where real people list the tells they notice (Reddit, Hacker News, X/Twitter threads quoted in articles, teacher and editor forums). Prefer primary sources and dated evidence. The goal is to help an assistant WRITE like a clear, natural human in real emails and messages — not to evade detectors, so skip "bypass detector" spam sites.
OUTPUT (markdown, dense, no fluff), written to the report file named below:
1. Tells taxonomy: for each tell give (a) name, (b) 2-3 real examples in the target language, (c) a natural rewrite, (d) strength: STRONG (almost only AI), MODERATE (AI-typical in density), WEAK (humans do it too — flag the false positive), (e) the source URL(s).
2. A word/phrase list: overused AI vocabulary and stock phrases in the target language, each with 1-3 plain replacements.
3. Structural/genre tells (layout, rhythm, openings, closings, formatting) — these matter more than single words.
4. "What real people said": 8-15 short quotes or paraphrases from forum/community threads about how they spot AI text, with URL.
5. Sources list (URL + one line + date if known).
Be concrete. Every claim either has a source or is marked as your own inference.
Report file: <workspace>/context/hv-<date>/craft.report.md
Write your full report to <workspace>/context/hv-<date>/craft.report.md and finish.
```

## voice

```
RESEARCH UNIT: THE OWNER'S OWN WRITING FINGERPRINT (local data only, no web; private — never quote other people).
The owner writes in <languages, e.g. Catalan, Spanish and English>. Build their style fingerprint per language from their OWN sent messages.
Data: <the owner's message archive>. Example: a WhatsApp history export in SQLite, opened read-only (file:...?mode=ro, uri=True), with a table messages(chat_jid, from_me, timestamp, message_type, text_content, chat_name); use from_me=1 AND message_type='text'. EXCLUDE texts starting with "🤖" (sent by the agent from their account), texts starting with the agent's name (prompts to the agent), and the owner's self/assistant chats (chats where only they and the agent write). Detect language per message with simple heuristics (Catalan markers: "què","perquè","doncs","molt","també","avui","gràcies","bon dia","vull","però" ; Spanish: "que","porque","pues","muy","también","hoy","gracias","buenos","quiero","pero" with ñ/á; English otherwise). Sample at least 150 messages per language if available (prefer longer ones, >8 words, mixed DMs and groups).
Deliver (write to <the private folder that holds the owner's voice profile>/voice.report.md): per language: (1) typical length (median words), sentence shape; (2) greetings and sign-offs they actually use; (3) how they ask, thank, apologise, disagree, and give instructions (5 short paraphrased patterns each, with 1 short real example max 15 words, no names of third parties); (4) punctuation/casing habits (question marks, exclamations, lowercase starts, ellipses, emoji — which ones and how often); (5) contractions and formality; (6) recurring phrases/fillers; (7) non-native quirks they have (list them, but note: do NOT copy errors into drafts, only keep their plainness); (8) what they NEVER do (e.g. em dashes? bold? bullet lists in chat?) with counts. Include the counts you measured (e.g. "em dash in 0 of 412 messages"). Keep all example snippets short and strip any third-party names or numbers. Finish by proposing the habits block of a voice profile JSON (template: profiles/example.json in this skill).
Write your full report to that file and finish.
```

# Second wave, 2026-09-25 (what people catch; sonnet-4-6, thinking medium)

## video

```
RESEARCH UNIT: tells in AI-WRITTEN VIDEO SCRIPTS AND NARRATION that viewers catch: AI manhwa/manga/webtoon recap channels, faceless YouTube (history, true crime, "explained", motivation), TikTok/Shorts story narration, Reddit-story narration channels, AI documentary voiceovers. Focus on the SCRIPT (words, structure, pacing, hooks, transitions, cliffhanger cadence, recap summaries, filler lines such as "little did he know", "but here is where it gets interesting", "what happens next will shock you", "our MC"), not only the synthetic voice. Find viewer complaints: r/manhwa, r/manga, r/youtube, r/NewTubers, r/PartneredYoutube, r/ArtificialInteligence, YouTube comments quoted in press, articles on "AI slop" channels (2025-2026), YouTube's 2025 "inauthentic content" monetization policy and how it describes the pattern. Also: why this trains people to notice the same pattern in other videos and in text (the owner reports exactly this after watching a few AI manhwa recaps per week).

HOW TO WORK: You have web access. Load tools first with ToolSearch query "select:WebSearch,WebFetch". Do 15+ searches and fetch 10-20 pages in full. Prefer places where ordinary people describe what gave it away: Reddit threads (try old.reddit.com and search-engine caches if reddit.com blocks you), YouTube comment sections quoted in articles, Hacker News (hn.algolia.com API works: https://hn.algolia.com/api/v1/search?query=...&tags=comment), forums, X/Bluesky threads quoted in press, newsletters. Date everything; 2025-2026 matters most because tells move. Goal: help an assistant WRITE naturally for real people. It is not a detector-evasion guide.
ALREADY COVERED (do not repeat unless you add new evidence): Wikipedia "Signs of AI writing", Russell et al. ACL 2025, Kobak excess vocabulary, Reinhart PNAS 2025, The Economist Jul 2026, blader/humanizer, vale-ai-tells, "delve/tapestry/testament", em dash debate, "not X but Y", rule of three, "I hope this email finds you well".
OUTPUT, markdown, dense:
1. New tells, each with: name, 2-3 verbatim real examples, why people notice it (their words), strength (STRONG = people catch it on one sighting; MODERATE; WEAK = false-positive risk), date and source URL.
2. "What people said": 12-20 verbatim quotes with URL and date.
3. Which of these are NEW since mid-2025 (model generations change the tells).
4. Sources list.
Write your full report to <workspace>/context/hv-<date>/video.report.md and finish.
```

## social

```
RESEARCH UNIT: tells people catch in AI-written SOCIAL posts, COMMENTS, REPLIES, DMs and EMAILS in 2025-2026: LinkedIn (r/LinkedInLunatics, "broetry"), Reddit bot comments and AI-written posts (r/ChatGPT "dead giveaways", r/mildlyinfuriating, r/Teachers, r/Professors, r/recruitinghell for cover letters, r/sysadmin for AI tickets), X/Twitter reply bots, Hacker News accusations of AI-written posts, customer-support emails, dating-app messages, AI-written condolence or thank-you notes (emotional flatness). MUST include a section on CLAUDE-SPECIFIC and recent-model tells that people now name (for example "You're absolutely right", "genuinely", "honestly", "quietly", "load-bearing", "the part nobody talks about", "I want to be careful here", "Great catch", "that's the key insight", closing offers to help), with where each was reported. Also: what readers say makes a reply feel HUMAN (a small odd detail, disagreement, a typo they did not fix, answering only part of the question, humour that is specific).

HOW TO WORK: You have web access. Load tools first with ToolSearch query "select:WebSearch,WebFetch". Do 15+ searches and fetch 10-20 pages in full. Prefer places where ordinary people describe what gave it away: Reddit threads (try old.reddit.com and search-engine caches if reddit.com blocks you), YouTube comment sections quoted in articles, Hacker News (hn.algolia.com API works: https://hn.algolia.com/api/v1/search?query=...&tags=comment), forums, X/Bluesky threads quoted in press, newsletters. Date everything; 2025-2026 matters most because tells move. Goal: help an assistant WRITE naturally for real people. It is not a detector-evasion guide.
ALREADY COVERED (do not repeat unless you add new evidence): Wikipedia "Signs of AI writing", Russell et al. ACL 2025, Kobak excess vocabulary, Reinhart PNAS 2025, The Economist Jul 2026, blader/humanizer, vale-ai-tells, "delve/tapestry/testament", em dash debate, "not X but Y", rule of three, "I hope this email finds you well".
OUTPUT, markdown, dense:
1. New tells, each with: name, 2-3 verbatim real examples, why people notice it (their words), strength (STRONG = people catch it on one sighting; MODERATE; WEAK = false-positive risk), date and source URL.
2. "What people said": 12-20 verbatim quotes with URL and date.
3. Which of these are NEW since mid-2025 (model generations change the tells).
4. Sources list.
Write your full report to <workspace>/context/hv-<date>/social.report.md and finish.
```

## studies

```
RESEARCH UNIT: what the RESEARCH says about which cues let humans catch AI text, and how readers infer TONE, FAMILIARITY and FEELING without knowing the writer. Cover 2025-2026 studies beyond the ones already covered: human detection accuracy and the cues accurate detectors use; "AI slop" perception studies; LLM idiosyncrasies (models identifiable by word choice, e.g. "Idiosyncrasies in Large Language Models"); homogenisation of human writing by AI (people starting to sound like models); studies on emotional/affective flatness and "uncanny valley" in AI text; politeness and warmth research in computer-mediated communication (how readers judge sincerity, closeness, irritation from punctuation, length, response latency, emoji); code-switching and register in bilingual chat. Deliver as an extra section a practical method: how a writer (or an assistant) should decide the intended tone, familiarity and feeling of a message from the conversation itself (thread history, relationship, stakes, the other person's own register) when the writer's personal fingerprint is not enough.

HOW TO WORK: You have web access. Load tools first with ToolSearch query "select:WebSearch,WebFetch". Do 15+ searches and fetch 10-20 pages in full. Prefer places where ordinary people describe what gave it away: Reddit threads (try old.reddit.com and search-engine caches if reddit.com blocks you), YouTube comment sections quoted in articles, Hacker News (hn.algolia.com API works: https://hn.algolia.com/api/v1/search?query=...&tags=comment), forums, X/Bluesky threads quoted in press, newsletters. Date everything; 2025-2026 matters most because tells move. Goal: help an assistant WRITE naturally for real people. It is not a detector-evasion guide.
ALREADY COVERED (do not repeat unless you add new evidence): Wikipedia "Signs of AI writing", Russell et al. ACL 2025, Kobak excess vocabulary, Reinhart PNAS 2025, The Economist Jul 2026, blader/humanizer, vale-ai-tells, "delve/tapestry/testament", em dash debate, "not X but Y", rule of three, "I hope this email finds you well".
OUTPUT, markdown, dense:
1. New tells, each with: name, 2-3 verbatim real examples, why people notice it (their words), strength (STRONG = people catch it on one sighting; MODERATE; WEAK = false-positive risk), date and source URL.
2. "What people said": 12-20 verbatim quotes with URL and date.
3. Which of these are NEW since mid-2025 (model generations change the tells).
4. Sources list.
Write your full report to <workspace>/context/hv-<date>/studies.report.md and finish.
```

## esca

```
RESEARCH UNIT: SPANISH and CATALAN speakers describing how they catch AI text and AI video scripts, 2024-2026. Report in English; keep every example and quote in its original language. Search in Spanish ("se nota que es IA", "texto hecho con ChatGPT se nota", "guion de IA YouTube", "vídeos de IA en YouTube comentarios", "canales de resúmenes de manhwa con IA", "comentarios hechos con IA en LinkedIn", "correo escrito con ChatGPT se nota") and Catalan ("es nota que està fet amb IA", "text fet amb ChatGPT", "català de la IA", "vídeos fets amb IA"). Sources: Forocoches, Mediavida, Menéame, r/spain, r/es, r/catalunya, Racó Català, X/Bluesky threads quoted in press, El País, elDiario.es, Xataka, Genbeta, VilaWeb, Núvol, Ara, El Nacional, 3Cat, teachers and copywriters. Include video narration tells in Spanish (dubbed or AI-voiced channels) and the Latin-American-neutral register as a giveaway in Spain.

HOW TO WORK: You have web access. Load tools first with ToolSearch query "select:WebSearch,WebFetch". Do 15+ searches and fetch 10-20 pages in full. Prefer places where ordinary people describe what gave it away: Reddit threads (try old.reddit.com and search-engine caches if reddit.com blocks you), YouTube comment sections quoted in articles, Hacker News (hn.algolia.com API works: https://hn.algolia.com/api/v1/search?query=...&tags=comment), forums, X/Bluesky threads quoted in press, newsletters. Date everything; 2025-2026 matters most because tells move. Goal: help an assistant WRITE naturally for real people. It is not a detector-evasion guide.
ALREADY COVERED (do not repeat unless you add new evidence): Wikipedia "Signs of AI writing", Russell et al. ACL 2025, Kobak excess vocabulary, Reinhart PNAS 2025, The Economist Jul 2026, blader/humanizer, vale-ai-tells, "delve/tapestry/testament", em dash debate, "not X but Y", rule of three, "I hope this email finds you well".
OUTPUT, markdown, dense:
1. New tells, each with: name, 2-3 verbatim real examples, why people notice it (their words), strength (STRONG = people catch it on one sighting; MODERATE; WEAK = false-positive risk), date and source URL.
2. "What people said": 12-20 verbatim quotes with URL and date.
3. Which of these are NEW since mid-2025 (model generations change the tells).
4. Sources list.
Write your full report to <workspace>/context/hv-<date>/esca.report.md and finish.
```
