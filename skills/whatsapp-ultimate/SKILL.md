---
name: whatsapp-ultimate
version: 4.2.0
description: "You put 5 agents in a WhatsApp group. They all respond at once. Your API bill does a backflip. Protocol v2 fixes that — congestion control, conversation lifecycle, and budget-aware scheduling. Agents that know when to talk, when to shut up, and when to burn unused tokens before reset. Built for the TinkerClaw fork — github.com/globalcaos/tinkerclaw. Documentation only: this package ships no scripts."
metadata:
  openclaw:
    emoji: "📱"
    requires:
      channels: ["whatsapp"]
    notes:
      security: "Documentation only. The package contains SKILL.md and description.md and nothing executable. It reads no credentials, writes no files, patches nothing and contacts no endpoint. The WhatsApp actions it describes are performed by the OpenClaw/TinkerClaw WhatsApp channel you already run, under that channel's own configuration."
---

# WhatsApp Ultimate

> One of dozens of skills and plugins in **[TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — a self-improving OpenClaw fork that's been running 24/7 for months.

You put 5 agents in a WhatsApp group. They all respond at once. Your API bill does a backflip.

Protocol v2 fixes that. Your agents learn group etiquette: when to talk, when to shut up, and when to spend the tokens they'd otherwise waste before the limit resets.

It adds congestion control so a busy group doesn't trigger a stampede of replies, a conversation lifecycle so a thread knows when it's actually over, and budget-aware scheduling so the cheap chatter waits and the work that matters gets the headroom. Multi-agent WhatsApp groups that stay calm, stay on-topic, and stay inside budget.

**Part of [TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — real-time token tracking, self-improving crons, persistent cognitive memory. This is one piece of that stack; the repo has dozens more.

👉 **https://github.com/globalcaos/tinkerclaw**

_Clone it. Fork it. Break it. Make it yours._

<scope>
Everything you can do in WhatsApp, your AI agent can do too. This skill documents all WhatsApp capabilities available through OpenClaw's native channel integration. No external Docker services, no CLI wrappers — direct WhatsApp Web protocol via Baileys.
</scope>

---

<prerequisites>
- OpenClaw with WhatsApp channel configured
- WhatsApp account linked via QR code (`openclaw whatsapp login`)
</prerequisites>

---

## Permissions, Data Flow & Consent

This package is documentation. It contains `SKILL.md` and `description.md` — no scripts, no
binaries, no installer, no background process.

| Capability | Used by this package? |
| --- | --- |
| Read WhatsApp credentials | No |
| Network | No |
| File write | No |
| Patch OpenClaw source | No |
| Env vars / secrets / API keys | No |

Every action below is executed by your OpenClaw/TinkerClaw WhatsApp channel, with that channel's
permissions and configuration. Installing this skill does not add those actions; uninstalling it
does not remove them.

Earlier versions (up to 4.1.0) bundled four maintenance scripts — a contact inventory, a group
creator, and two source-patch scripts (inbound message retention, auth-profile prefix). 4.2.0
removes them. See the changelog for why.

---

## Capabilities Overview

| Category | Features |
|----------|----------|
| **Messaging** | Text, media, polls, stickers, voice notes, GIFs |
| **Interactions** | Reactions, replies/quotes, edit, unsend |
| **Groups** | Create, rename, icon, description, participants, admin, invite links |
| **History** | Local-DB search only (see caveat below). vCard contact extraction |

Total: 22 distinct actions.

**These 22 actions belong to OpenClaw's WhatsApp channel, not to this package.** This skill
documents them; installing it does not add them, and uninstalling it does not remove them.

---

## Messaging

### Send Text
```
message action=send channel=whatsapp to="+34612345678" message="Hello!"
```

### Send Media (Image/Video/Document)
```
message action=send channel=whatsapp to="+34612345678" message="Check this out" filePath=/path/to/image.jpg
```
Supported: JPG, PNG, GIF, MP4, PDF, DOC, etc.

### Send Poll
```
message action=poll channel=whatsapp to="+34612345678" pollQuestion="What time?" pollOption=["3pm", "4pm", "5pm"]
```

### Send Sticker
```
message action=sticker channel=whatsapp to="+34612345678" filePath=/path/to/sticker.webp
```
Must be WebP format, ideally 512x512.

### Send Voice Note
```
message action=send channel=whatsapp to="+34612345678" filePath=/path/to/audio.ogg asVoice=true
```
Use OGG/Opus format for voice notes — MP3 may not play correctly.

### Send GIF
```
message action=send channel=whatsapp to="+34612345678" filePath=/path/to/animation.mp4 gifPlayback=true
```
Convert GIF to MP4 first (WhatsApp requires this):
```bash
ffmpeg -i input.gif -movflags faststart -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" output.mp4 -y
```

---

## Interactions

### Add Reaction
```
message action=react channel=whatsapp chatJid="34612345678@s.whatsapp.net" messageId="ABC123" emoji="🚀"
```

### Remove Reaction
```
message action=react channel=whatsapp chatJid="34612345678@s.whatsapp.net" messageId="ABC123" remove=true
```

### Reply/Quote Message
```
message action=reply channel=whatsapp to="34612345678@s.whatsapp.net" replyTo="QUOTED_MSG_ID" message="Replying to this!"
```

### Edit Message (Own Messages Only)
```
message action=edit channel=whatsapp chatJid="34612345678@s.whatsapp.net" messageId="ABC123" message="Updated text"
```

### Unsend/Delete Message
```
message action=unsend channel=whatsapp chatJid="34612345678@s.whatsapp.net" messageId="ABC123"
```
> **Irreversible and visible.** Deletion-for-everyone cannot be undone, and WhatsApp leaves a
> "This message was deleted" tombstone in the chat. Confirm with the human before an agent
> unsends anything it did not send itself.

---

## Group Management

### Create Group
```
message action=group-create channel=whatsapp name="Project Team" participants=["+34612345678", "+34687654321"]
```

### Rename Group
```
message action=renameGroup channel=whatsapp groupId="123456789@g.us" name="New Name"
```

### Set Group Icon
```
message action=setGroupIcon channel=whatsapp groupId="123456789@g.us" filePath=/path/to/icon.jpg
```

### Set Group Description
```
message action=setGroupDescription channel=whatsapp groupJid="123456789@g.us" description="Team chat for Q1 project"
```

### Add Participant
```
message action=addParticipant channel=whatsapp groupId="123456789@g.us" participant="+34612345678"
```

### Remove Participant
```
message action=removeParticipant channel=whatsapp groupId="123456789@g.us" participant="+34612345678"
```
> **Affects a real person and requires admin.** Removal is visible to the whole group and you
> cannot silently undo it. Same for `promoteParticipant` / `demoteParticipant`. Get explicit
> human confirmation before an agent changes a group's membership or admin list.

### Promote to Admin
```
message action=promoteParticipant channel=whatsapp groupJid="123456789@g.us" participants=["+34612345678"]
```

### Demote from Admin
```
message action=demoteParticipant channel=whatsapp groupJid="123456789@g.us" participants=["+34612345678"]
```

### Leave Group
```
message action=leaveGroup channel=whatsapp groupId="123456789@g.us"
```

### Get Invite Link
```
message action=getInviteCode channel=whatsapp groupJid="123456789@g.us"
```
Returns: `https://chat.whatsapp.com/XXXXX`

### Revoke Invite Link
```
message action=revokeInviteCode channel=whatsapp groupJid="123456789@g.us"
```
> **Both directions are sensitive.** `getInviteCode` returns a link that lets *anyone holding
> it* join the group — treat it as a credential and do not paste it into logs or other chats.
> `revokeInviteCode` instantly breaks every copy of the old link that is already circulating.

### Get Group Info
```
message action=getGroupInfo channel=whatsapp groupJid="123456789@g.us"
```
Returns: name, description, participants, admins, creation date.

---

## JID Formats

WhatsApp uses JIDs (Jabber IDs) internally:

| Type | Format | Example |
|------|--------|---------|
| Individual | `<number>@s.whatsapp.net` | `34612345678@s.whatsapp.net` |
| Group | `<id>@g.us` | `123456789012345678@g.us` |

When using `to=` with phone numbers, OpenClaw auto-converts to JID format.

---

## History is a local-DB search. Live fetch does not work.

**Your agent cannot pull old messages back off your phone on demand.** Anything that claims
otherwise is wrong. What actually exists:

- **Search of the local `whatsapp-history.db`** — whatever your gateway captured while it was
  running, including media captions and link previews, not just plain text.
- **On-demand historySync does not land.** The phone answers the request and the payloads are
  discarded before they reach storage. Treat a live channel plus an empty result as a gap in
  what was captured, not as a broken skill.
- **Any period your gateway was down is simply missing**, and no amount of retrying will fill
  it in. Check your own downtime before assuming a bug.
- **The backfill that does work:** use *Export chat* on your phone and drop the file into your
  workspace. Re-pairing via a fresh QR *may* bootstrap history, but it drops your existing
  linked session — that is a deliberate decision, not something an agent should do for you.

> **Who writes the history DB.** The channel's own live capture does, not this package. In the
> TinkerClaw fork that capture is part of the WhatsApp channel and stores inbound messages from
> chats the gateway sees; delete `whatsapp-history.db` to clear it.

---

## Tips

### Voice Notes
Use OGG/Opus format:
```bash
ffmpeg -i input.wav -c:a libopus -b:a 64k output.ogg
```

### Stickers
Convert images to WebP stickers:
```bash
ffmpeg -i input.png -vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000" output.webp
```

### Rate Limits
WhatsApp has anti-spam measures. Avoid:
- Bulk messaging to many contacts
- Rapid-fire messages
- Messages to contacts who haven't messaged you first

### Message IDs
To react/edit/unsend, you need the message ID. Incoming messages include this in the event payload. For your own sent messages, the send response includes the ID.

---

## Comparison with Other Skills

| Feature | whatsapp-ultimate | wacli | whatsapp-automation | gif-whatsapp |
|---------|-------------------|-------|---------------------|--------------|
| Native integration | yes | no (CLI) | no (Docker) | N/A |
| Send text | yes | yes | no | no |
| Send media | yes | yes | no | no |
| Polls | yes | no | no | no |
| Stickers | yes | no | no | no |
| Voice notes | yes | no | no | no |
| GIFs | yes | no | no | yes |
| Reactions | yes | no | no | no |
| Reply/Quote | yes | no | no | no |
| Edit | yes | no | no | no |
| Unsend | yes | no | no | no |
| Group create | yes | no | no | no |
| Group management | yes (full) | no | no | no |
| Receive messages | yes | yes | yes | no |
| Two-way chat | yes | no | no | no |
| External deps | None | Go binary | Docker + WAHA | ffmpeg |

---

---

## Protocol v2: Multi-Agent Discussions

<why_this_matters>
If you put multiple AI agents in one WhatsApp group, the naive default is everyone responds to everything. Five agents replying to one message means 5x the API spend per turn, plus echo loops where agents agree with each other forever. Protocol v2 introduces congestion control, conversation lifecycle, and budget-aware scheduling so agents know when to talk, when to stay quiet, and when to wrap up.
</why_this_matters>

### Agent Identity

Each agent gets its own personality, icon, and (optionally) model:

```yaml
channels:
  whatsapp:
    agentIcon: "🤖"          # single-agent icon prefix
    turnEndMarker: "⚡"       # end-of-turn marker in 1:1 chats
    multiAgent:
      mainAgentId: "jarvis"
      agents:
        jarvis:
          id: "jarvis"
          name: "Jarvis"
          icon: "🤖"
        luna:
          id: "luna"
          name: "Luna"
          icon: "🌙"
          model: "sonnet"
        rex:
          id: "rex"
          name: "Rex"
          icon: "🦖"
          model: "haiku"
```

Agent personalities live in the workspace:
```
workspace/
├── SOUL.md                  # main agent
├── agents/
│   ├── luna/SOUL.md         # Luna's personality
│   └── rex/SOUL.md          # Rex's personality
```

### Intra-Agent Chats

Register WhatsApp groups where agents discuss freely (no trigger prefix needed):

```yaml
      intraAgentChats:
        brainstorm:
          chatId: "123456789012345678@g.us"   # your own group's JID
          participants: ["jarvis", "luna", "rex"]
          owner: "your-owner-id"
          mode: "broadcast"        # broadcast | addressed | round-robin
```

**Routing modes:**
- **broadcast** — all agents respond (with congestion control)
- **addressed** — only respond when mentioned by name ("Luna, what do you think?")
- **round-robin** — structured turn-taking

### Congestion Control (Exponential Courtesy Protocol)

Prevents N agents from all responding simultaneously:

```yaml
      congestion:
        enabled: true
        baseDelayFactor: 150     # ms × agentCount² base delay
        maxDelay: 30000          # 30s cap
        backpressureThreshold: 1.5  # slow down over-talkers
        windowMs: 60000          # 60s sliding window
```

**How it works:**
- Base delay scales quadratically with agent count (2 agents ≈ 600ms, 5 agents ≈ 3750ms)
- Random jitter prevents synchronization
- Agents talking more than their fair share get 2× delay penalty
- If another agent posts during your wait, restart the timer (yield-on-collision)

### Conversation Lifecycle

Agents detect when discussions go stale and know when to wrap up:

```yaml
      lifecycle:
        stalenessWindow: 5        # compare last N messages
        stalenessThreshold: 0.85  # cosine similarity trigger
        maxTurnsPerObjective: 30  # hard cap
        autoClose: true
```

**Features:**
- **Staleness detection** — cosine similarity of message embeddings detects circular discussions
- **Agreement loop detection** — catches "I agree" / "Good point" / "Exactly" loops
- **Topic steering** — one agent claims pivot role to redirect conversation
- **Objective tracking** — set goals, track completion, auto-close with summary
- **Closure protocol** — propose → ack → converge (all agents must agree)

### Budget-Aware Scheduling

Adjusts conversation depth based on API usage and reset timing:

```yaml
      budget:
        provider: "anthropic"
        windowDays: 7
        burnModeEnabled: true
        burnTriggerHours: 24     # hours before reset
        burnUsageThreshold: 0.20 # usage below 20%
```

**Four modes:**

| Mode | When | Congestion | Staleness | Max Turns | Tangents |
|------|------|-----------|-----------|-----------|----------|
| Conservative | >85% used | 2× slower | 0.80 | ½ | No |
| Moderate | 60-85% | Normal | 0.85 | Normal | No |
| Aggressive | <60% | 0.7× faster | 0.85 | Normal | Yes |
| **Burn** | <20% used, <24h to reset | 0.3× faster | 0.95 | 2× | Encouraged |

Burn mode philosophy: unused tokens expire at reset. Better to have emergent agent-agent discussions than waste the budget.

### DM Trigger Prefix

Protocol v2 extends `triggerPrefix` to DMs (previously groups only):

- **Owner** — always bypasses triggerPrefix
- **Authorized contacts** — must start message with prefix (e.g., "Jarvis, help me with...")
- **Intra-agent chats** — bypass triggerPrefix entirely

### Turn-End Marker

In 1:1 chats (selfChat or owner-only DM), append a visual marker to signal turn completion:

```yaml
channels:
  whatsapp:
    turnEndMarker: "⚡"
```

---

### 4.2.0

- **Removed:** all four bundled scripts (`wa-fetch-contacts.ts`, `wa-create-group.ts`, `apply-history-fix.sh`, `apply-model-prefix.sh`). The package is now documentation only and reads no credentials. Group creation and group info remain available as the channel's `group-create` / `getGroupInfo` actions
- **Fixed (by removal):** both patch scripts no longer matched current TinkerClaw source — `apply-history-fix.sh` inserted its import before checking for its anchor, leaving a half-patched `monitor.ts` whenever that anchor was missing (it is missing in current source), and re-runs overwrote the clean `.bak`; `apply-model-prefix.sh` reported "All patches applied!" when its `sed` anchors silently missed
- **Fixed (by removal):** the Baileys scripts opened a second socket on the gateway's live auth directory
- **Fixed:** the history section said the history DB was off until a script was applied; in TinkerClaw the channel's own live capture writes it

### 4.1.0

- **Added:** "Permissions, Data Flow & Consent" — full capability table, what is read, what is written, where it goes
- **Added:** Consent gate on all four bundled scripts — each prints what it will touch and exits unless you pass `--yes`
- **Added:** `--revert` off-switch and automatic `.bak` for both source-patching scripts
- **Changed:** `wa-fetch-contacts.ts` is now ephemeral by default — nothing is written to disk without `--save`, and saved files are mode `0600`
- **Changed:** `wa-fetch-contacts.ts` masks phone numbers to the last 4 digits; LID→phone resolution is opt-in via `--resolve-lids`
- **Added:** `--auth-dir` / `WA_AUTH_DIR` override so credentials are not hard-coded to one path
- **Added:** Documentation for all four bundled scripts, which were previously undisclosed
- **Added:** Safety notes on unsend, participant/admin changes, and invite links
- **Fixed:** "External deps: None" now distinguishes the channel actions from the bundled scripts
- **Fixed:** Removed operator-specific content (real group JID, owner name, internal notes) from the history section and config examples

### 4.0.0

- **Protocol v2:** Multi-agent discussions with configurable routing (broadcast/addressed/round-robin)
- **Added:** Congestion control — Exponential Courtesy Protocol prevents message explosion in multi-agent chats
- **Added:** Conversation lifecycle — staleness detection, agreement loop detection, topic steering, objective tracking, closure protocol
- **Added:** Budget-aware scheduling — four spending modes including burn mode for pre-reset token usage
- **Added:** Agent identity system — per-agent SOUL.md, icons, names, model overrides
- **Added:** DM triggerPrefix gating — non-owner contacts must use prefix in DMs
- **Added:** Turn-end marker (⚡) for 1:1 chats
- **Added:** `agentIcon` config for outbound message prefixing

### 3.7.0

- **Added:** vCard phone number extraction — contact messages now return structured `vcard` field with names and phone numbers
- **Added:** `contactsArrayMessage` support — multi-contact shares are now parsed
- **Improved:** New contact messages store phone numbers in `text_content` for full-text search (e.g. search by phone number)
- **Improved:** `raw_json` now included in search results for contact-type messages, enabling vCard extraction from historical data

### 3.4.0

- **Fixed:** Chat search now resolves LID/JID aliases — searching by chat name finds messages across both `@lid` and `@s.whatsapp.net` JID formats
- **Added:** `resolveChatJids()` cross-references chats, contacts, and messages tables to discover all JID aliases for a given chat filter
- **Improved:** Search falls back to original LIKE behaviour if no JIDs resolve, so no regressions

### 3.0.0

```
Your Agent
    ↓
OpenClaw message tool
    ↓
WhatsApp Channel Plugin
    ↓
Baileys (WhatsApp Web Protocol)
    ↓
WhatsApp Servers
```

No external services. No Docker. No CLI tools. Direct protocol integration.

---

## Included Files

| File | Purpose | Runs anything? |
| --- | --- | --- |
| `SKILL.md` | This page — the action reference and the protocol v2 config | No |
| `description.md` | ClawHub listing copy | No |

There is no `scripts/`, no `bin/`, no installer, no background process and no telemetry. If you
find a claim here that the channel does not do, open an issue on
[the repo](https://github.com/globalcaos/tinkerclaw/issues).

---

## Pairs Well With

- [smart-model-router](https://clawhub.ai/globalcaos/smart-model-router) — auto-select the right model per agent role (creative → Sonnet, analyst → Haiku, devil's advocate → GPT)
- [agent-superpowers](https://clawhub.ai/globalcaos/agent-superpowers) — verification iron law and three-agent review for when your multi-agent discussions produce code
- [subagent-overseer](https://clawhub.ai/globalcaos/subagent-overseer) — monitor agent sessions without burning tokens on polling loops

https://github.com/globalcaos/tinkerclaw

_Clone it. Fork it. Break it. Make it yours._

---

## License

MIT — Part of OpenClaw

---

## Links

- OpenClaw: https://github.com/openclaw/openclaw
- Baileys: https://github.com/WhiskeySockets/Baileys
- ClawHub: https://clawhub.com
