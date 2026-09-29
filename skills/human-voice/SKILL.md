---
name: human-voice
description: >
  Write like a clear, natural person in English, Spanish (Spain) and Catalan, for anything a human
  will read. Use it BEFORE drafting or sending any email, WhatsApp/Teams message, reply or post to
  another person, for any post written in the owner's name, and whenever you explain a code change
  to the owner (low key: what was wrong, what changed, what they'll notice, what's still open). Also
  use it when someone says a text "reads like AI", "sounds robotic", "humanize this", "fes-ho més
  humà", "que suene más natural". Built on what real readers and viewers catch in 2026: the leftover
  assistant offer, more structure than the thread carries, even rhythm, hollow warmth, announced
  payoffs, and the Claude dialect (`load-bearing`, `genuinely`, `landed`, `rather than`). Ships
  voicecheck.py, a trilingual checker that can also compare a draft against the other person's own
  messages (--thread) and, when you set one up, against the owner's own voice profile (--voice).
  Not for evading detectors: for being worth reading.
metadata:
  openclaw:
    emoji: "✍️"
    requires:
      bins: ["python3"]
    notes:
      security: "Local only, standard library only. voicecheck.py reads the draft and the optional thread and profile files you pass it. selfaudit.py reads local session transcripts and an optional baseline you point it at, read-only. Nothing is sent anywhere. A voice profile is personal data: keep it outside this folder."
---

# Human voice

**What this is for.** Making text a person reads, from the agent or in the owner's name, sound like
someone wrote it for them, in EN, ES or CA. **How it was derived.** 2026-09-24: the owner called two
WhatsApp posts "very AI-ish" that a vocabulary detector had scored 0/100 "human". The problem was
genre, not words. First wave: Wikipedia _Signs of AI writing_, Russell et al. ACL 2025, Kobak
2024–25, Reinhart PNAS 2025, The Economist Jul 2026, Fundéu/RAE, the UPF 2026 Catalan study, Rogers &
Lasky-Fink, Gopen & Swan, McCulloch, and the owner's own message archive. 2026-09-25, on the owner's
push ("gather what humans are very good at catching… the rest of the population will catch up"), a
second wave was added. It covered what real readers catch: a measured corpus of 291k words of AI
video narration, ~6,200 HN comments, Reddit, Graphite's 100k-article study (Sep 2026), StoryScope,
and Spanish/Catalan forums. It also re-measured the agent's own replies against the owner's
messages. Sources: `references/research/`. **What would change it.** Tells have a half-life of
months (only 45% overlap between consecutive GPT versions). Twice a year, and after every model
upgrade, re-run the briefs and `scripts/selfaudit.py`. When the owner corrects a draft, add it to the
matching reference (dated) and, if mechanical, to `scripts/lexicon.json` (general rules) or to the
owner's voice profile (their personal corrections). Then run `scripts/selftest.py`.

## The one idea

Readers aren't running a detector; they ask whether anything is there. Every tell people catch is a
proxy for **emptiness dressed as insight**: the payoff announced and never delivered, the balance
that costs nothing, warmth nobody earned, structure the message didn't need, the same point said
twice. In 2026 the words are known and edited out first. What trained readers catch is
**structure, rhythm, and distance from what this conversation expects**. One writer banned every
word on a list and "still sounded like AI… the tell underneath was rhythm". So: say one true,
specific thing, in the thread's own register, at the length it needs. Most tells become impossible
to produce. **Never plant typos or slang to seem human.** Models copy any habit that signals
humanity, and the writing gets worse.

## When

- **Always** before an email or message to another human leaves (draft included), before a post in
  the owner's name, and when telling the owner what you changed in code.
- **Not** for documents where structure is real (a spec, a README, a table of 5 options): there,
  headings and lists are fine, but the phrase-level rules still apply.
- Agent identity furniture your deployment defines (a name line, a closing card, a reflection
  block) stays as specified elsewhere. This skill governs the prose between them.

## Process (every time, in order)

1. **Decide who, where, and how it should feel.** Who is speaking (the agent, or the owner in their
   own name), the channel (email, chat, post, code-change, doc), the language (it follows the chat,
   never the files). Then the part no fingerprint can supply: the **intended tone, familiarity and
   feeling** of _this_ message. Read them off the thread: how the other person writes to the owner
   (length, greeting, emoji, tú/usted), how warm or tense the last exchange was, what is at stake,
   and whether this is news, a favour, a reply or an apology. Match their register; don't climb or
   drop it. If the feeling is unclear (a condolence, a complaint, a first contact), ask the owner one
   short question instead of guessing. Method and evidence: `references/tone-from-context.md`.
2. **Say it out loud first.** Imagine telling the recipient across a table, then write what you said
   (Paul Graham). Speech has no "It's important to note".
3. **Draft with the twelve rules below**, in the channel's shape (`references/registers.md`).
4. **Check it:**
   `python3 {baseDir}/scripts/voicecheck.py draft.txt --mode chat|email|post|code|doc [--thread their_msgs.txt] [--voice owner]`
   When replying to someone, put their last 5–10 messages (theirs only, one per line) in a file
   and pass `--thread`. It flags length, structure, emoji, greeting and language that deviate from
   them. Fix every HIGH; judge the MEDs; ignore LOWs unless several stack.
5. **Subtract, then read it aloud once:** closing offer, conclusion, unneeded structure, the third
   item of a triple, sentences that do no work, the repeated adverb. If you'd groan reading it as a
   real message, rewrite that line. Then send.

## Twelve rules (what readers catch, strongest first)

1. **No leftover assistant turn.** Never end on "Would you like me to…", "Let me know if you'd like
   me to…", "¿Quieres que te prepare…?", "Si necesitas más ideas, no dudes en pedírmelo". It is the one
   tell with no innocent explanation. A specific next step is fine ("Want me to do staging too?").
2. **Match the thread, not an average.** Length within one order of magnitude of their messages,
   no more structure than they use, their emoji rate, their greeting, the language of their last
   message. Deviation from the expected register is what people catch first in real conversations.
3. **Point first, and say it once.** Answer in sentence one. Never restate a point in other words,
   never add the conclusion nobody asked for, and stop when the information stops.
4. **Deliver, don't announce.** No "here's the part nobody talks about", "here's the kicker",
   "Honestly?", "let me be direct", "I want to be careful here", "the key insight". Just the thing.
5. **Warmth has to cost something.** Answer before validating. No therapist mode
   ("you're not alone"), no praise for noticing your mistakes ("Great catch"), no forced joke. Take a
   position where one is wanted; faux balance reads as a machine keeping the peace.
6. **Uneven rhythm.** Mark the sentence lengths; if they're even, split one and join two. People
   use exclamation marks and brackets (models almost never do); let them in where they're true.
7. **Grain.** One true specific only the writer could know, even one that doesn't serve the
   argument ("a detail that is merely true reads as remembered"). Names, not substitute nouns
   ("our protagonist", "the user"). If someone said something, quote them rather than "X explains that…".
8. **Formatting only when the structure is real, and never more than the channel carries.** Never
   `**Label:** text` lists, bold in a paragraph, emoji as bullets, headers over three lines, or
   raw markdown in WhatsApp.
9. **No contrast frames or significance staging** unless someone believes the X: "not X, but Y",
   "rather than", "less like X, more like Y", "plays a crucial role in shaping", `-ing` tails
   ("…, ensuring…"), "serves as" for "is".
10. **Honest cost.** Say what took longer, what was wrong yesterday, what's still open, and what you
    did _not_ check. Hedge where an expert would hedge, and nowhere else.
11. **Drop the Claude dialect.** `load-bearing`, `genuinely`, `quietly`, `plainly`, `honestly`, "doing a lot of work",
    and in figurative use `landed`, `wired`, `surfaced`, `verified`, `stale`, `drift`, `seam`, `crux`, `canonical`.
    People now call these Claude on sight. List, ratios and one deployment's measured rates: `references/claudeisms.md`.
12. **Match the channel's markup and language.** Chat has no headers, dashes or final full stop; an
    email has no Subject line in its body; a message to Spain uses `ordenador`, `vosotros`; a
    Catalan colleague gets `Hola, Marc,` and `tu`, not `Benvolgut` and `vostè`.

## The language flips (what does NOT transfer from English)

- **Spanish:** the raya (`—que ya habíamos hablado—`) is correct in an email or doc; only chat makes
  it odd. **Title Case** is a strong tell (and an error). Email greeting `Hola, Marta:`. Spain
  lexicon (`ordenador`, `móvil`, `vosotros` for an informal group). No quotation marks around
  greetings. Watch for "suena a traducción": correct grammar, English rhythm. Card: `references/tells-es.md`.
- **Catalan:** register beats grammar. `Benvolgut`/`vostè` to someone you call `tu`, a dialect mix
  (`aquest`/`este`, `avui`/`hui`), half-Spanish or Italian words (`parlém`, `posso`), Title Case,
  flat book-standard with no colloquial mark, and zero reference to the shared context are the
  loud tells. Spanish calques (`a que`, `degut a`) are common in human Catalan, so they're no
  proof. Card: `references/tells-ca.md`.
- **English:** the em dash is weak evidence now (GPT-6 uses it less than people do). In chat it's
  still wrong, and Claude uses one every ~72 words. The durable tells are structural. Cards:
  `references/tells-en.md`, `references/tells-heard.md`.

## Writing in the owner's name (optional voice profile)

A voice profile is the owner's measured writing habits plus their own corrections. It is optional
and personal: the skill ships only a neutral template (`profiles/example.json` and
`profiles/example.md`). To set one up, copy both files **outside this folder** (they are personal
data), fill them from the `voice` brief in `references/research/briefs.md`, and set
`HUMAN_VOICE_PROFILE` to the JSON. Its `notes` key names the prose fingerprint next to it.

**The fingerprint gives defaults, not rules.** It is measured over thousands of messages to
everyone, so it averages away the thing that matters most: who this one is for ("you don't
necessarily know the intended tone, familiarity or feeling of the message", the owner, 2026-09-24).
**The thread comes first.** How the owner already writes to this person, and how they write back,
beats any average. A condolence, a complaint or a message to family will break every number in the
profile, and it should. Use the numbers only where the thread says nothing.

When drafting as the owner: read the profile's notes file; if the deployment keeps a message archive
the agent may read, pull 5 of the owner's own messages from the same chat (skip anything the agent
sent from their account), and the other person's recent messages for `--thread`. Run
`voicecheck.py --voice owner` (or `--voice path/to/profile.json`). Its habit findings are hints
(LOW/MED) that the thread can overrule; the HIGH ones are the owner's own explicit corrections (the
profile's `rules`). **Keep their plainness; never copy their typos or calques.**

Without a profile, write in the plain defaults of `references/registers.md` and match the thread.

## Explaining a code change to the owner

Four moves, 3–6 plain sentences: **what was wrong** (as they saw it) → **what changed** (one
sentence, plain words, one path at most) → **what they'll notice**, and whether it is running or
only written → **what wasn't done / what's still open**. No headers, no `**Label:** text` lists
(measured 2026-09-25 on one deployment: 99 of 400 of the agent's recent replies to the owner failed
on exactly that), no "successfully", no tour of files, and none of the Claude dialect (rule 11).
Worked bad/good pair: `references/registers.md`.

## Configuration

| Variable                   | Used by                       | Meaning                                                                        | Default                                    |
| -------------------------- | ----------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| `HUMAN_VOICE_PROFILE`      | voicecheck.py `--voice owner` | path to the owner's voice profile JSON                                         | unset: no personal rules                   |
| `HUMAN_VOICE_SESSIONS`     | selfaudit.py                  | glob of the agent's session transcripts (JSONL)                                | `~/.openclaw/agents/main/sessions/*.jsonl` |
| `HUMAN_VOICE_BASELINE`     | selfaudit.py                  | the owner's own messages: a text file (one per line) or a `.db` SQLite archive | unset: agent rates only                    |
| `HUMAN_VOICE_AGENT_NAME`   | selfaudit.py                  | lines starting with this are prompts to the agent, not messages                | `jarvis`                                   |
| `HUMAN_VOICE_STRIP_MARKER` | selfaudit.py                  | drop each reply's text after this marker (a reflection block)                  | `🌿 FRACTAL`                               |

Each has a matching command-line flag; run a script with `--help` for the list.

## Files

- `scripts/voicecheck.py` + `scripts/lexicon.json`: the checker; add general rules to the lexicon,
  not the code, and one writer's rules to their profile, not the lexicon.
- `scripts/selftest.py`: 20 controls (machine texts must fail, human texts must pass, per language,
  plus thread match/mismatch and the example voice profile). **Run after any lexicon edit.**
- `scripts/selfaudit.py`: the agent's own last N days of replies against a human baseline, per
  million words. Run after a model upgrade and update `references/claudeisms.md`.
- `profiles/example.json`, `profiles/example.md`: the voice-profile template (made-up values).
- Corpus check, 2026-09-25, on one deployment: of 400 of the owner's own messages, 8.5% flagged, all
  by the dash and bold rules and mostly lines the agent drafted for them; none by the new rules. Of
  400 agent messages sent from the owner's account (marked 🤖), 78% flagged. Of 400 of the agent's
  replies to the owner, 26.5% flagged, as code-change notes.
- `references/tells-heard.md`: what readers and viewers catch in 2026, ranked, with the human
  markers to put back. `references/claudeisms.md`: the Claude dialect. `references/tone-from-context.md`:
  reading tone, familiarity and feeling off the thread.
- `references/tells-en.md`, `tells-es.md`, `tells-ca.md`: per-language cards (read the one you write in).
- `references/registers.md`: channel shapes, checklists, bad/good pairs.
- `references/research/`: the full reports with URLs (first wave: en, es, ca, craft; second wave:
  video, social, studies, esca) and the briefs that produced them (`briefs.md`).

## Maintenance

Twice a year, and after every model upgrade: re-run the briefs in `references/research/briefs.md`
as parallel research subagents (write reports under your agent workspace, not `/tmp`, which a
reboot wipes), diff the new tells against `lexicon.json`, keep what has a source, then run
`selftest.py`, the corpus check and `selfaudit.py`. Refresh the owner's fingerprint with the `voice`
brief. It reads only their local archive, and the result goes to their private profile, never into
this folder.
