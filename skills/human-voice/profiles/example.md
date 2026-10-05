# Voice fingerprint — the example writer (template, made-up values)

**For:** drafting a message that goes out in this person's name. **From:** their own sent
messages, measured with the `voice` brief in `../references/research/briefs.md`. **Changes when:**
they correct a draft (add the correction to the profile JSON's `rules`, dated) or twice a year
when the brief is re-run.

This is a template. The numbers below are invented to show the shape. Keep your real fingerprint
OUTSIDE the skill folder, next to your real profile JSON, because it is personal data. Point
`HUMAN_VOICE_PROFILE` at the JSON and set its `notes` key to this file's real counterpart.

**The fingerprint gives defaults, not rules.** It averages over every message to everyone, so it
cannot know who this one is for. How the writer already talks to this person, and how that person
writes back, beats any number here. A condolence or a complaint will break every default, and it
should.

## All languages

- Length: one sentence, median about 12 words. Long answers are split into two or three messages.
- Punctuation: capital first letter, no full stop at the end of a chat message. No dashes,
  semicolons, bold, bullets or headers in chat (0 in 1,200 measured messages).
- Emoji: at most one, at the end. Which ones and what they mean for this writer
  (example: `🙂` warmth, `😅` a small apology).
- Greeting: a short word plus the first name (`Hi Jamie`, `Hola, Jamie`, `Bon dia, Jamie`). No sign-off in chat.
- Asking: a conditional, the reason, and an exit ("could you send it today, the vendor closes at
  six, otherwise I'll call them myself").
- Disagreeing: softly and once (`I don't think so` · `Creo que no` · `Jo diria que no`).

## Per language

- **English:** example: expands (`I am`, `do not`) in most messages; says `thanks`, rarely `thank you`.
- **Spanish:** example: often drops the opening `¿`; closes with `Un abrazo` to friends.
- **Catalan:** example: `merci`, `porfa` in casual chat; `Gràcies!` in email.

## What to keep and what not to copy

Keep the writer's plainness and their short shape. Never copy their typos, calques or
non-native slips into a draft: the reader would see a machine imitating mistakes.

## Where their messages live

Name the archive the agent may read to pull 5 recent messages from the same chat before drafting
(example: a local SQLite export with a `from_me` column), and which lines to skip (anything the
agent itself sent from their account).
