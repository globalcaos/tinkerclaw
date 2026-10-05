# Tone, familiarity and feeling — read them off the thread

**For:** the owner, 2026-09-24: "you don't necessarily know the intended tone, familiarity or feeling
of the message". A fingerprint averaged over thousands of messages to everyone cannot tell a condolence
from a delivery time. The thread can. **From:** Communication Accommodation Theory and Language
Style Matching (Niederhoffer & Pennebaker 2002; Bierstetel et al. 2020), Gunraj et al. 2016
(_Computers in Human Behavior_: a full stop makes a short text read insincere, handwriting unaffected),
Cavalheiro et al. 2024 and _Collabra_ on emoji (warmth up, competence down), Rendle-Short 2015 and
Chen et al. 2025 on reply latency, Nakano et al. 2026 on where AI help is rejected (apologies,
encouragement), Wen & Zhang on WhatsApp code-switching, and the 2026 crowd finding that the
strongest interpersonal tell is **deviation from the sender's own baseline**. Evidence:
`research/studies.md` §4. **Changes when:** the owner corrects a tone call. Record the case here, dated.

## The principle

People converge on the style of those they like and diverge from those they keep at a distance.
**Convergence reads as warmth; divergence reads as distance, in either direction.** Too formal with
a friend reads cold; too casual with a stranger reads careless. There is no neutral default: a
"professional, helpful" register is itself a position, and in a casual thread it is the wrong one.

## Read six things, in this order

1. **The last inbound message's mechanics.** Copy its mechanics, not its words: capitals at the
   start, full stop at the end or not, contractions, greeting and sign-off present or absent, emoji
   (which ones), slang, swearing. If they don't capitalise, the reply can relax too; if they write
   `Hola, Lucía:`, so do you.
2. **The thread's median length.** Stay within one order of magnitude. If they write 8–20 words, a
   90-word reply is wrong however good it is. If the long answer is needed, **offer it**: one short
   message saying what you found, then the detail only if they want it.
3. **Familiarity, on evidence.** Formal (greeting + sign-off, surname, full sentences) → consultative
   → casual (first names, contractions, no greeting) → intimate (nicknames, in-jokes, shared
   references, no punctuation). Also check the relationship's history in the archive: how the owner
   has written to _this_ person before beats how they write on average. Match the level; don't climb
   it (that is the hollow over-validation tell) and don't step down it (the "reciting a script" tell).
4. **Stakes and face-threat, separately from warmth.** Is this bad news, a refusal, a correction,
   an apology, a favour, or plain information? Face-threatening acts need politeness _work_ (a reason,
   an out, a softener) whatever the closeness: a close friend's refusal still hedges. Unhedged bad
   news to an intimate reads brutal; heavily hedged trivia reads evasive.
5. **The feeling in the inbound, from mechanics and timing.**
   - A full stop on a short chat reply reads abrupt or insincere; an exclamation mark reads sincere
     (for under-25s, ~22% more likable). Humans use exclamation marks over 100× more than models.
   - Emoji raise warmth and lower perceived competence. **Mirror their emoji rate; never introduce
     emoji into a thread that has none.**
   - Latency speaks. If the reply is late against the thread's own rhythm, acknowledge it in three
     words ("Sorry, just seen this"). An instant reply to something that deserved thought reads as not having thought.
6. **Language.** Reply in the language of their last message, not the topic's or the documents'.
   A switch is a message in itself (a topic boundary, seriousness, a bid for closeness), so switch only when you mean one.

## Where to be most careful

Apologies, condolences, encouragement, thank-yous and anything to family are where people reject AI
help hardest ("I can't help but question whether it's truly sincere"). In those, the specific
shared memory _is_ the message. Two true lines beat a warm paragraph. **If the feeling is
unclear, ask the owner one short question instead of guessing.** A wrong condolence costs more than a
five-second delay.

## Then write, then subtract (in this order)

1. Delete the closing offer.
2. Delete the summary or conclusion nobody asked for.
3. Delete structure the inbound didn't carry (headers, bullets, bold), down to what they used.
4. Kill the third item of any triple that exists because three felt right.
5. Cut every sentence you can remove without losing information.
6. Break the rhythm: mark sentence lengths; split one, join two.
7. Fix any repeated adverb or adjective (proof nobody re-read).
8. Put one concrete, non-generic thing in: a real number, a name, "what we said on Tuesday".

## Five questions before sending

1. Does my reply carry more structure than the message it answers?
2. Is my formality above or below theirs?
3. Would this read oddly if a stranger saw it?
4. Did I answer in the first sentence?
5. Would I groan reading this? ("Treat it like a real message and stop where you'd groan.")

## Tooling

`voicecheck.py draft.txt --mode chat --thread thread.txt` compares the draft with the other
person's recent messages in `thread.txt` (one message per line, theirs only). It flags a length far
beyond their median, structure or emoji they never use, a formal greeting in an informal thread, and
a reply in a different language from their last message. It does the counting only; the judgement in
steps 3–4 stays with the writer.
