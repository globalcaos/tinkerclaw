# Registers — the shape each channel expects

**For:** picking the right shape before writing a word. **From:** Rogers & Lasky-Fink _Writing for
Busy Readers_ (2023; 49-word email got 4.8% replies vs 2.7% for 127 words, N=7,002), BLUF, Gopen &
Swan 1990, Paul Graham ("tell someone, then write what you said"), McCulloch _Because Internet_ +
Binghamton 2015 (a full stop makes a one-word chat reply read less sincere), Boomerang 2016 (50–125
words), Chris Beams on commits, Google SRE postmortems, the owner's own measured habits. Evidence:
`research/craft.md`. **Changes when:** the owner corrects a shape; record the correction here, dated.

The one test before any channel: **could the reader act on the first sentence alone?** If not, move
the point up.

## Email (to a person)

Shape: reason for writing in sentence 1 → the one ask or the one fact → one line of context if
needed → a concrete next step or nothing. 50–125 words. Paragraphs, no headers, no bold labels.
One ask per email.

Checklist: greeting that fits the relationship (EN `Hi Marta,` · ES `Hola, Marta:` · CA `Hola, Marta,`)
· no "hope you're well" filler (a specific is fine: "Hope the audit went OK") · point first · the ask
names a date or a choice · a detail only the sender could know · stop; closing by relationship
(`Thanks,` · `Un saludo` / `Un abrazo` · `Gràcies!` / `Una abraçada`), never stacked · one tú/usted
or tu/vostè choice held throughout · subject line in sentence case.

Bad:

> Dear Marta, I hope this email finds you well. I wanted to reach out regarding the updated quote.
> It's important to note that we have made several key adjustments, ensuring a streamlined process.
> Please don't hesitate to reach out if you have any questions. Best regards,

Good:

> Hi Marta, here's the revised quote. I took out the assembly line item because we'll do it
> ourselves, so it's €1,200 lower. Does Tuesday work to go through it?

## WhatsApp / Teams / chat

Shape: 1–2 short sentences, often one line; split a second thought into a second message; no
headers, no bullets, no bold, no dashes; at most one emoji, at the end; no full stop on the last line.
Answer the question asked, then stop. In a group, you are one voice among several: match the median.

Bad: `**Update:** The report is ready — you can find it attached. Let me know if you need anything else! 🚀`
Good: `Report's ready, it's in the shared folder` · ES `Ya está el informe, lo tienes en la carpeta` ·
CA `Ja tens l'informe a la carpeta`

## A post in the owner's name (groups, LinkedIn, community)

Write it as they would: plain, first person, what they did and why, a plain ask for feedback
(`I would appreciate your feedback`). Continue their earlier threads; correct their own past
numbers openly — that reads human, polish does not. Never the announcement template (hook → bold
stat → link → call to action → witty sign-off). If a voice profile is set (`HUMAN_VOICE_PROFILE`),
read its notes file and follow its emoji and greeting habits; if the agent may read the owner's
message archive, pull 5 of their own messages from that chat before drafting. Ask before sending,
and say so if your gateway marks agent sends (for example with a 🤖 prefix).

## Explaining a code change to the owner (low key)

They did not review the code, read on a phone half the time, and want the outcome, not the journey.
Four moves, 3–6 plain sentences, in this order:

1. **What was wrong**, in terms of what they saw ("the site kept the old drag").
2. **What I changed**, in one sentence, in plain words (name one file only if they'll want to open it).
3. **What they'll notice** now, and whether it is running or only written (source ≠ built ≠ restarted).
4. **What wasn't done / what's still open** — the part they can't infer and most need.

No headers, no bold, no bullet list for fewer than ~6 facts, no "successfully", no percentages of
confidence, no tour of the files. If there is a real either/or for them, put it last as one question.

Bad:

> ## Summary
>
> I have successfully implemented a comprehensive fix, ensuring robust behaviour.
>
> - **Root cause:** Stale export script
> - **Fix:** Ported applyFocus and wireUtilDrag into CHART_JS
> - **Verification:** 10/10 checks pass ✅

Good:

> The website didn't change because it runs its own copy of the chart script, and I had only updated
> the app. I copied the hover and snapping logic into that script and republished the page, so hover
> now lights a whole model and dragging snaps onto each plan. It's live; reload if it looks old, the
> host caches for a few minutes. I haven't fixed the cache purge itself yet.

## Commit messages (Beams)

Imperative subject ≤ 50 chars, no trailing period, blank line, body wraps at 72 and says _why_ (the
diff says what). No marketing adjectives, no "successfully", no bullets of virtues. A project's own
commit rules override these where they conflict.

## Honest uncertainty and polite disagreement

Say what you checked, not how you feel: "Tested on Linux only; Windows untested, the path handling is
where I'd look first." Not: "It should generally work in most environments."
Disagree in one clause of acknowledgement, one plain position, one reason, and leave the call with
them: "I'd push back on the second one: it doubles the send path. Your call though."
Soft forms that work: EN `I don't think…` · ES `Creo que no…` · CA `Jo diria que no…`.
