# English — what makes a draft read machine-written, and the plain fix

**For:** editing your own English before a person reads it. **From:** Wikipedia _Signs of AI writing_
(Sep 2026), Russell/Karpinska/Iyyer ACL 2025, Kobak et al. 2024–25 (14 M abstracts), Reinhart et al.
PNAS 2025, The Economist 30 Jul 2026 (1.2 M words), vale-ai-tells, blader/humanizer, HN threads.
Full evidence: `research/en.md`. **Changes when:** word tells rot within a year (`delve` collapsed in
2025, GPT-5.1 dropped em dashes); structure tells have survived three model generations. Re-check the
word list yearly, the structure list rarely.

Strength: **S** = one sighting is enough · **M** = only in density · **W** = humans do it too; never act on it alone.

## Structure first (the durable half)

| Tell                                                                                                                          | S/M/W            | Fix                                                               |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------- |
| "It's not X, it's Y" / "not only… but also" / "This isn't A — it's B"                                                         | S                | State Y. Keep the contrast only if the reader actually believes X |
| Significance staging: "marking a pivotal moment", "stands as a testament", "plays a crucial role", "reflects a broader trend" | S                | Keep the fact, drop the meaning-of-the-fact                       |
| `-ing` rider: "…, highlighting / underscoring / ensuring / reflecting …" (2–5× the human rate, Reinhart)                      | S in density     | Cut it, or make it its own sentence with a number                 |
| Copula avoidance: "serves as", "stands as", "boasts", "features"                                                              | M                | is / has                                                          |
| Run-up before the point: "Let's dive in", "Here's the thing", "Without further ado"                                           | S                | Start with the point                                              |
| Arguing with no one: "This isn't about…", "To be clear", "One might be tempted to"                                            | M                | Say what is, not what isn't                                       |
| One-line closers and slogan fragments: "Same model, same money." "No fluff. No filler."                                       | S when repeated  | Merge into the sentence they decorate                             |
| Rule of three everywhere                                                                                                      | M                | Two items, or four; three only when there are three               |
| Uniform rhythm: every sentence 14–22 words, every paragraph 3–5 sentences                                                     | M→S              | Let length follow content; a four-word sentence after a long one  |
| Optimistic tidy ending: "The future looks bright", "Despite these challenges…"                                                | S                | End on the last fact. Humans end abruptly                         |
| Formatting by rule: bold on every item, `**Label:** text` bullets, headers over three lines, emoji as bullets                 | S in a message   | Prose. One formatting device at most under ~150 words             |
| Restating the question: "You asked whether…", "To answer your question…"                                                      | M→S              | Answer first                                                      |
| Unasked tutorial ("As you may know, caching is…") and answering more than was asked                                           | M→S              | Answer, then offer depth                                          |
| Phantom experts: "Experts argue", "Industry reports suggest"                                                                  | M→S              | Name the source or own the claim ("I think")                      |
| No grain: no file, number, date, name, error string                                                                           | S                | Put the specific back — it was there, it got smoothed away        |
| Frictionless report: no cost, no surprise, no leftover                                                                        | S (as behaviour) | Say what took longer, what was wrong yesterday, what's still open |

## Email and message furniture

| Tell                                                                                 | S/M/W                                                                | Fix                                                                           |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| "Great question!", "Certainly!", "You're absolutely right", "I'd be happy to help"   | S                                                                    | Delete; answer. If they were right, say what you had wrong                    |
| "I hope this email finds you well"                                                   | W as evidence, bad as writing (it is also the AI default opener now) | Open with why you are writing                                                 |
| "Hope this helps", "Let me know if you have any questions", "Feel free to reach out" | S as a stack, W alone                                                | End on the real next step: "If Tuesday doesn't work, say so and I'll move it" |
| `Subject:` line pasted into the body                                                 | S                                                                    | Subject field only                                                            |
| Knowledge-cutoff talk: "While details are limited…", "not widely documented"         | S                                                                    | "I couldn't find X." Stop. Never fill the gap with a guess                    |

## Code-change and status reports

| Tell                                                                            | S/M/W                 | Fix                                                         |
| ------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------- |
| "I have successfully implemented…", "I've gone ahead and…", "This commit adds…" | S                     | "Fixed X." "Done: the retry now backs off."                 |
| "significantly faster", "dramatically reduced", "much cleaner"                  | S                     | The number, or no grade                                     |
| "comprehensive test suite", "robust error handling", "proper cleanup"           | M→S                   | What it covers: "12 tests, incl. the malformed-header case" |
| "ensuring consistency", "improving maintainability" tails                       | S                     | Delete; the diff shows it                                   |
| "This should fix", "may resolve"                                                | M                     | What you ran and what it showed                             |
| "production-ready", "battle-tested", "bulletproof"                              | S                     | Delete                                                      |
| "All tests pass" / "deployed and working" when you did not run them             | S, and the costly one | "Unit tests green; didn't run integration; not deployed"    |

## Words (read literally — synonyms are not implicated)

additionally (sentence-initial) → also/and · align with → match · boasts → has · bolstered → backed ·
crucial → important or delete · delve → look at · emphasizing → delete · enduring → lasting ·
enhance → improve · fostering → building · garner → get · highlight (v.) → show · interplay → how X
and Y interact · intricate → complicated · landscape (abstract) → field · meticulous → careful ·
pivotal → important · robust (figurative) → solid · showcase → show · tapestry → delete ·
testament → delete the clause · underscore → show · vibrant → delete · leverage/utilize → use ·
facilitate → say what you did · seamless → smooth · streamline → simplify.
Era note: GPT-5-era output leans on _emphasizing, enhance, highlighting, showcasing_; Grok on
_underscore, causal, empirical_; "quietly" was flagged on HN as the Q3-2026 word.

## What reads human — permit yourself these

`is` and `has`; plain verbs (wrote, moved, used, tried); contractions; the occasional `just`,
`really`; a bracketed aside; a definite verdict ("the only one", "the first"); mixed feelings left
unresolved; one odd, specific, true detail. Humans write more run-ons than models, not fewer.

## False positives — do not "fix" these

- **Em dash.** Weak alone. The Economist (Jul 2026): only Claude exceeds professional writers;
  ChatGPT now uses fewer. The shape matters: a spaced `—` used as the default joint where a full
  stop belonged. Don't ban it; don't lean on it. (In chat it is still wrong: nobody types it on a phone.)
- Perfect grammar, formal prose, curly quotes, transition words in isolation, unsourced text,
  detector scores. None is evidence.
- Never plant typos or fragments to "seem human". It is the documented paranoia spiral and makes the
  writing worse.
