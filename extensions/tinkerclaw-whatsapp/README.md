# tinker-whatsapp

WhatsApp channel plugin for OpenClaw, from the TinkerClaw fork
(github.com/globalcaos/tinkerclaw, `extensions/tinkerclaw-whatsapp`).
Published on ClawHub as `@globalcaos/tinker-whatsapp`. It is not published to
npm; install it from ClawHub or run it from the fork.

## What it does

- Links a WhatsApp account by QR code (WhatsApp Web protocol) and keeps the
  session in `~/.openclaw/credentials/whatsapp/<account>/`.
- Receives messages and sends replies, reactions and media, subject to your
  `channels.whatsapp` `dmPolicy`, `groupPolicy` and `allowFrom` settings.
- Before each reply it adds context to the agent prompt:
  - who will read the reply (you, or the contact) and a reply-language rule;
  - a contact card: saved name, phone, WhatsApp display name;
  - the sender's profile from `~/.openclaw/workspace/memory/people/<slug>.md`
    and, in groups, the group's notes from
    `~/.openclaw/workspace/memory/chat-profiles/<slug>.md`, when those files
    exist (the plugin reads them; you or your agent write them);
  - the last 6 messages of the same chat and the typical message length there
    (chat rhythm);
  - a hint for reading older messages of that chat with the
    `whatsapp_history` tool.

  The saved contact name, the recent messages and the chat rhythm come from
  the local history database (see Backends); without it they are left out.

## Where your message data goes

- **To your model provider.** The incoming message and all the prompt context
  listed above (contact card, profiles, recent messages, chat rhythm) are part
  of the agent prompt, and the agent prompt is sent to whichever model provider
  you configured in OpenClaw. Voice notes are handed to OpenClaw's configured
  audio transcription. The plugin makes no other upload of message data.
- **To WhatsApp.** Replies, reactions and media you send, plus the history
  backfill request described below.
- **To local disk only:** the session credentials, and on the whatsmeow
  backend the history database.

## Backends

| `OPENCLAW_WHATSAPP_BACKEND` | Backend                                               |
| --------------------------- | ----------------------------------------------------- |
| unset (default)             | Baileys (JavaScript)                                  |
| `whatsmeow` or `wm`         | whatsmeow-node (a Go subprocess; optional dependency) |

With the whatsmeow backend the plugin also:

- writes every sent and received message (text plus the raw message JSON) to a
  local SQLite database with full-text search,
  `~/.openclaw/data/whatsapp-history.db`. The database file and its `-wal` and
  `-shm` companion files are kept at mode 0600 (checked each time the database
  is opened). It also keeps a `contacts` and a `chats` table (names only);
- after a reconnect, asks WhatsApp for the messages missed during the downtime
  and stores them in the same database. The last-connected time is kept in
  `~/.openclaw/workspace/memory/whatsapp-backfill/last-connected.txt`.

On the Baileys backend the plugin does not create or write this database. If
one already exists (for example from an earlier whatsmeow run) the prompt
context reads from it.

### Retention and deletion

History is kept until you remove it. To keep a rolling window, set
`OPENCLAW_WHATSAPP_HISTORY_RETENTION_DAYS=<days>`: messages older than that are
deleted when the database is opened and every 6 hours after that. To remove
everything, stop the gateway and delete `whatsapp-history.db`,
`whatsapp-history.db-wal`, `whatsapp-history.db-shm` and `last-connected.txt`.

## The `whatsapp_history` tool

The prompt hints refer to a `whatsapp_history` tool. That tool is not part of
this package: the TinkerClaw host provides it, and it can search every chat in
the history database. This plugin only decides which hint the agent gets:

- On turns you started (you manage the agent, or ask it to draft a message)
  the hint mentions searching all chats.
- On turns a contact started (an auto-reply to them) the hint points only at
  that chat, unless you set `OPENCLAW_WHATSAPP_CROSS_CHAT_HINT=all`.

## Unknown contacts

When a direct message comes from a number that is not in your phonebook, the
prompt asks the agent to work out who it is from the message itself and from
earlier messages, and otherwise to ask the person. By default it does NOT tell
the agent to look the person up on the web or to save a profile of them. With
`OPENCLAW_WHATSAPP_CONTACT_RESEARCH=1` it also suggests a web search on a name,
email or company found in the message, and saving what was learned to
`memory/people/<slug>.md` in the agent workspace.

## Bundled command-line helpers

Two scripts ship in `src/history/`. The plugin never runs them; you run them
by hand.

- `download-media.ts` (`--id <messageId> [--out <dir>]`, or
  `--list-media [--since YYYY-MM-DD] [--chat <jid>]`): reads the media
  metadata of a stored message from the history database, downloads the file
  from the WhatsApp media server and decrypts it. Default output directory:
  `~/.openclaw/workspace/data/wa-media`.
- `retry-download-one.mjs <messageId> <outPath>`: for media whose download
  link has expired. It opens the whatsmeow session store
  (`~/.openclaw/credentials/whatsapp/default/whatsmeow.db`), connects to
  WhatsApp as your account, asks your phone to re-upload that one file, and
  writes it to `<outPath>`. Paths can be changed with `OPENCLAW_HOME`,
  `OPENCLAW_HISTORY_DB` and `OPENCLAW_WHATSMEOW_STORE`.

## Environment variables

| Variable                                   | Default          | Effect                                                                                                                                                                    |
| ------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_WHATSAPP_BACKEND`                | `baileys`        | Selects the backend (see above).                                                                                                                                          |
| `OPENCLAW_WHATSMEOW_BINARY`                | unset            | Absolute path to a rebuilt whatsmeow-node binary. Refused unless it is a regular executable file owned by the gateway user (or root) and not writable by group or others. |
| `OPENCLAW_WHATSMEOW_EVENT_TRACE`           | off              | `1` logs the first 1500 characters of each whatsmeow message, receipt, presence and history-sync event, including message text, to the gateway log.                       |
| `OPENCLAW_WHATSAPP_CROSS_CHAT_HINT`        | off              | `all` gives contact-started turns the all-chats search hint too.                                                                                                          |
| `OPENCLAW_WHATSAPP_CONTACT_RESEARCH`       | off              | `1` adds the web lookup and people-profile steps for unknown contacts.                                                                                                    |
| `OPENCLAW_WHATSAPP_HISTORY_RETENTION_DAYS` | unset (keep all) | Deletes stored messages older than this many days.                                                                                                                        |

## Build note

`dist/` bundles the `better-sqlite3` JavaScript library. Its `Database.exec`
function runs SQL statements against the local history database; it does not
start processes.

## Plugin config

`pluginHooks.messageReceived` (boolean, default off): broadcast inbound
`message_received` hook payloads to other loaded plugins.
