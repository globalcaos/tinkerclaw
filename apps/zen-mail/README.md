# Mail reader (topics, not emails)

Every hour it reads your Outlook and Gmail, turns the threads into topics and ranks them by urgency and then
importance. A topic opens with a summary, a reply already written in the thread's language, a chat where you
can ask about it or have the reply changed, and the emails underneath. Mail that needs nothing is set aside
per sender, where you can mute it, keep it, unsubscribe or ask the sender to stop.

Design: `docs/plans/2026-10-15-zen-mail-pass1.md`.

## What it never does

- It never sends and never deletes mail. Approve writes a reply draft into the topic's own mailbox, in the
  thread; you press Send there. The one outbound act is a one-click unsubscribe, and only when you press it.
- Work and personal never mix: a work topic can only make an Outlook draft, a personal one only a Gmail draft.
- Subjects that look like a CV or a job application never go to a model.

## Needs

- Outlook through the `outlook-hack` skill CLI (its `mail sync`, `mail mark-read`, `mail unsub-header` and
  `mail reply-draft` commands). Its sign-in lasts 24 hours; when it lapses the screen says so.
- Gmail through `gog`, signed in.
- The `claude` CLI, signed in to a subscription. Each run makes one short call per batch of six new threads
  and none when nothing is new.

With no mailbox configured it does nothing: `settings.json` starts with empty addresses, and the screen shows
why.

## Run

```
python3 -I sync.py      # collect and triage once
python3 -I server.py    # http://127.0.0.1:18804/  (ZEN_MAIL_PORT to change)
sh try-copy.sh          # test a change on a COPY of the live data, :18897, 10 min; --stop removes it
python3 -I card.py show <words>              # a card: messages, butler needs, folder, attach list
python3 -I card.py attach <topic> <file>...   # files a send will attach (copies + updates the card's list)
```

Data and settings live in `~/.local/share/zen-mail/` (`ZEN_MAIL_DATA` to change), outside any repository:
`settings.json` (addresses, a sentence about you, always-ignored senders), `zen.db`, `sync.log`, and the two
optional fonts in `fonts/` (`inter.woff2`, `serif.woff2`).

## Jarvis cards and the dams (2026-10-16)

Zen Mail is where Jarvis tells the architect things; Tinker is where the architect tells Jarvis things. Besides mail, Jarvis brings
cards from five streams (`streams.py`): a tour of the crons, open tasks, unwritten tasks in recent chat tabs, pinned
answers (the Tinker page posts them to `/api/pins`) and butler nudges. `dams.py` decides what reaches the list:

- a stream opens at level 1 only when the architect is calm (little new and urgent arriving, no burst of clicks) and nothing
  else opened in the last two days; level 1 = one card a day, faint, at the bottom;
- his reactions move it: useful/done/opened lift it, "less of this" or two days unopened lower it, "not this kind"
  seals it for two weeks; levels 2 and 3 show more cards, ranked like mail;
- every click on any card is logged in `events`, and senders he answers within four hours rise one step.

`python3 -I dams.py` (or `GET /api/dams`) prints each dam's level, what waits behind it and the current load.
