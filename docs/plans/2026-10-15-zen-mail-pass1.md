# Zen Mail: a mail reader that shows topics, not emails (pass 1)

Date: 2026-10-15. Status: pass 1 and the pass 2 design page are ready for the owner's review. Nothing is built.

## What it is

Zen Mail reads a mailbox every hour and turns it into a short list of topics, ranked by what needs the owner first.
A topic is one matter: a reply someone is waiting for, a decision, a payment, a document to read. Several emails,
even several threads, can make one topic (a customer's question and the colleague's internal answer about it are
one matter). Everything that needs nothing, such as receipts, notifications, newsletters and senders the owner
always ignores, is set aside and counted. It is never listed.

The owner skims from the top when there is time. A topic opens in place with a short summary, the facts that
matter (dates, amounts, attachments), the emails themselves with quotes and signatures stripped, and, when a reply
is needed, a draft already written in the owner's voice and in the thread's language. One click approves the
draft, acknowledges a topic that only needed reading, or puts it off until later.

The name is Zen Mail (the owner's choice, 2026-10-15). Its look comes from zen gardens and bonsai: paper and ink, raked
gravel for the empty screen, a bonsai as the mark, and brown only as a trace.

Borrowed from: Google Inbox's bundles and its sweep (2014 to 2019), HEY's screener for new senders, and Gmail
Priority Inbox, which learned importance from what each user did with their mail
([Aberdeen, Pacovsky and Slater, 2010](https://research.google/pubs/the-learning-behind-gmail-priority-inbox/)).

## What it does in v1

1. Topics, not emails.
2. Three bands: Now (someone is waiting or a date is close), Soon (important, no clock running), To read
   (acknowledge only). The rest is set aside.
3. The summary replaces reading the mail. The cleaned emails are one tap away, the original one more.
4. Drafts written in advance, in the owner's voice and the thread's language. A decision topic shows its options;
   picking one rewrites the draft.
5. Got it: acknowledges a topic and marks its emails read in the mailbox. "Got it, all" clears the To read band.
6. Not now: back tomorrow morning, on Monday, or on a date.
7. Per-sender noise control: Unsubscribe (one click when the sender supports RFC 8058, which Gmail and Yahoo
   require of bulk senders), Mute (new mail from them skips the inbox), Ask them to stop (a drafted request), Keep.
8. Waiting on others: once the owner replies, the topic waits on a shelf and comes back with a drafted nudge if
   nobody answers within a set number of working days.
9. Work and Personal behind one switch (Outlook and Gmail). The two never mix.
10. Runs every hour from a cron. When a mailbox stops working, the screen says so in one line, with a fix button.

Proposed for later: learn the owner's priorities from what they open, approve and ignore (recalibrated offline,
weekly); a two-minute check that starts the full run only when new mail arrives; meeting preparation the evening
before; pass a topic to a colleague or turn it into a task; questions about the mail ("what did they say about the
date?"); Teams and WhatsApp requests in the same list; a "3 need you" line in the morning briefing that links here;
a spoken "what needs me?".

## Shape

```
mailbox (Outlook / Gmail)
  -> collector (code): mail since the last run, bodies cleaned, into a local store
  -> triage (model): topic, summary, the ask, dates, amounts, noise flag, draft
  -> ranker (code): band and order from the triage fields and the owner's lists
  -> store (SQLite on this machine, git-ignored)
  -> Zen Mail tab in Tinker  <->  actions (code): push a draft, mark read, snooze, mute, unsubscribe
```

## Choices

| Choice                                                                                                                     | Why                                                                                               | Instead of                                          |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| The topic is the unit                                                                                                      | People think in matters; threads split one matter across subjects and senders                     | A thread list with labels                           |
| The model writes language (summary, the ask, the draft, a noise flag); code decides the order                              | Order has to be predictable and tunable by hand                                                   | Asking the model for a rank                         |
| One compact model call per new thread                                                                                      | Most hours bring zero to two new emails; a full agent turn re-sends a large prompt every hour     | An agent cron turn per hour                         |
| No model call when nothing is new                                                                                          | Most runs then cost nothing                                                                       | Re-reading the whole inbox each run                 |
| Drafts wait inside Zen Mail; Approve writes a threaded reply draft, with the owner's signature, into the right mailbox     | The mailbox's Drafts folder stays clean and nothing moves without a click                         | Writing every draft into the mailbox at triage time |
| Never send, never delete, in v1                                                                                            | Both mail tools are built unable to send or delete, and Zen Mail keeps it that way                | A send button (decision D1)                         |
| Mute is applied by each run, which moves a muted sender's new mail out of the inbox                                        | Needs no new mailbox permission                                                                   | Server-side mailbox rules                           |
| Unsubscribing happens only on the owner's click: a one-click POST when the sender supports it, otherwise a drafted request | It is an outbound act                                                                             | Automatic unsubscribing                             |
| A Tinker tab in the Tinker palette, with a layout that also fits a phone                                                   | The owner already works in Tinker and will skim from a phone                                      | A separate application                              |
| Hourly cron now, a cheap two-minute check later                                                                            | Real push needs a public HTTPS address and a Graph subscription renewed at least every three days | Webhooks on a laptop                                |

## Module map

- `extensions/tinkerclaw-zen-mail/`
  - `collect/outlook.ts`: reuses the outlook-hack Graph client and its token file
  - `collect/gmail.ts`: gog, with Gmail `history` for increments
  - `clean.ts`: strips quoted replies, signatures and legal footers
  - `triage.ts`: one model call per new or changed thread, output checked against a JSON schema
  - `rank.ts`: bands and order
  - `store.ts`: SQLite
  - `actions.ts`: push a draft, mark read, snooze, mute, unsubscribe, ask to stop
  - `rpc.ts`: gateway methods for the tab
  - the cron job (every hour)
- `tinker-ui/src/panels/zen-mail/`: the tab

## Build order

1. Store, collectors and cleaner, with a read-only dry run on the owner's mailboxes. No model, no writes.
2. Triage and ranker in shadow. Results are stored and reviewed with the owner on real mail; nothing touches the
   mailbox.
3. The tab: the list, an open topic, set aside, waiting, the empty screen, the broken screen, the phone layout.
4. Actions, each one behind a click: push a draft, mark read, snooze, mute, unsubscribe.
5. The cron, the status line, the ship path and docs.

## Cutover

Nothing is replaced. Outlook and Gmail stay as they are; Zen Mail reads them and writes drafts. The morning briefing
keeps its email section until the owner decides to point it here.

## Lines not to cross

- Zen Mail never sends and never deletes mail. Only decision D1 could change the first half, for one button.
- Work and personal never mix. A work topic can only produce an Outlook draft, a personal topic only a Gmail draft.
- Documents the owner keeps away from models (CVs, for example) are never sent to the model. The topic says what
  arrived and where to read it.
- Senders on the owner's always-ignore list stay set aside.
- Mail content stays on this machine, apart from the model call that triages it.
- Unsubscribe, mute and ask-to-stop happen only on a click.

## Ship path

- A fresh clone gets the plugin bundled and dormant. With no mailbox connected it makes no calls, logs no errors and
  creates no cron.
- The Zen Mail tab then shows one line, "No mailbox connected", with the command that connects one.
- It needs a mailbox credential (a Microsoft Graph token through the outlook-hack flow, or Gmail through gog's
  OAuth) and any configured model.
- Credentials stay where those tools already keep them (the credentials folder, gog's keyring), never in
  `openclaw.json`.
- Connecting the first mailbox creates the cron job; removing the last one deletes it.

## Open items

The owner decides:

- D1, what Approve does. (a) The draft lands in the mailbox and the owner presses Send there. Recommended for
  v1. (b) Approve sends after a ten-second undo, which lifts the never-send rule for that one button.
- D2, Outlook's daily sign-in. The current token lives 24 hours. (a) A Renew button in Zen Mail that the owner
  presses, recommended now. (b) An app registration with offline access, which needs the company's IT.
- D4, where it lives. A Tinker tab, and whether the phone reaches it over the tailnet.
- D5, the nudge. After how many working days without an answer (default 4).

Unverified:

- U1. Marking mail read with the current Outlook token. Move and flag work with it today; read state was not
  tried.
- U2. How many noisy senders support one-click unsubscribe. Needs a header census.
- U3. How a plugin makes a model call billed to the subscription without a full agent turn.
- U4. Topic merging on real mail. The shadow run in build step 2 answers it.

## UI choices (pass 2, round 2)

- Three panes, as in Outlook: a folder rail on the left (Today, Waiting on others, Set aside, then Inbox, Sent, Drafts,
  Archive, Deleted, Junk and the owner's own folders), the ranked topic list in the middle, and a large pane on the right.
- The right pane reads top to bottom: summary, the reply (editable), "Talk it over" (a conversation with the agent about
  the topic, answered in text and, when asked, with a rewritten reply), then the emails that make up the topic.
- A folder shows plain emails, newest first; an email that belongs to a topic links to it.
- Paper and ink, like the J-series papers. Brown appears only on the Now dot, the selected row's edge and Approve.
- The empty pane is raked gravel around stones; when nothing needs the owner, a bonsai stands above it with "Nothing
  needs you."
- Follows Apple's 2026 guidance: glass only on navigation, colour only on the primary action, reduce motion respected.
- The design page with every mock-up and a feedback box per block is private to the owner and is not in this repo.
