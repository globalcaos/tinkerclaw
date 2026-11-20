# Hive door: several people, one agent (opt-in multi-user mode)

**What it is for:** several people use one agent. Each has their own token, their own chats, their own tabs and page state. An admin sees everyone's chats, grouped by owner, and manages people from the page.
**How it was derived:** the single-user door takes ONE shared token plus a typed name, and the seat travels in a client-set cookie and header, so anyone holding the token can claim anyone's seat and read every chat. The owner's rules for the replacement (2026-10-06) are listed below; `acl.mjs` and `door.mjs` hold the measured basis.
**What would change it:** native per-user identity in the gateway (the enforcement then moves inside it), or sharing a chat with a named colleague (`visibleTo` already takes ids).

## Off by default

Nothing here runs unless you turn it on. `scripts/setup.sh` asks about it only for the _company_ setting, and the default answer is **no**. A personal install keeps the single-user door.

## The rules it enforces

- **Who you are** comes from your token (`~/.openclaw/data/door/tokens.json`, the sha256 the door checks, plus the token itself so an admin can copy it; 0600). A typed name or a forged `x-tinker-seat` header changes nothing: the door overwrites it. The gateway secret never reaches a browser.
- **Your own Main and tabs.** The door hands each person their own Main chat (`agent:main:hive:<id>:main`) and keys the saved tab list and panel state to their seat, so a reconnect reopens exactly what that person had.
- **Who sees a chat.** A user's new chat: that user and the admins. An admin's new chat: that admin only. Admins see every user's chats, grouped by owner in the chat list; another admin's private chats stay private. Chats that existed before multi-user mode stay visible to the admins and to the people listed in `DOOR_LEGACY_USERS`. Background chats (crons, reflections) are admin-only.
- **Deleting.** A regular user's delete only hides the chat for that user; nothing is removed and the admins still see it. An admin's delete is a real delete (the gateway archives the transcript).
- **Admin is a property**: granted and taken away from the page. The last admin cannot lose it.
- **People.** Admins add people, issue a new token (the old one stops), revoke a token, copy a person's current token, or delete them (no access; everything they made is kept), from the USERS panel at the bottom of the right rail. Nothing a person made is ever removed. New tokens are shown once.
- Every request naming a chat you may not see is refused, `sessions.list` only lists what you may see, and live events about other people's chats are dropped. Logins, refusals and admin actions go to `audit.jsonl`.
- **What a regular user can reach over HTTP**: only what the chat page loads (the page and its assets, page state, seat name, the mute state, and the call timeline of their own chats). The gateway's file reader and writer (the chat's file viewer, local images in chat, the kit editor), the host's voice and mute switch, and the gateway's own HTTP APIs are for admins. The rule is `regularMayRequest` in `door.mjs`.

## Turn it on

```bash
node scripts/hive-door/setup.mjs --owner-id alice --owner-name Alice --title MyAgent
```

Creates the owner (an admin) and their first token (private file, not printed), seeds seat names, and installs `hive-door.service` on Linux. People open the door's address (`http://<machine>:18795/tinker/`), never the gateway's. Keep the gateway on loopback. `DOOR_BIND` serves the door on a LAN address; the default is loopback, for use behind your own proxy or tunnel.

## Tokens per person (admins)

The Graphs section of the 🎯 HUD's Pulse tab opens with a time graph of the model tokens the other people used: one coloured line per person showing their running total of the week, with the same zoom, pan and hover as the other Pulse graphs. The total starts again every Monday at 07:00 on the viewer's own clock (the page sends its time zone, so a server set to UTC does not move the reset), and the chart opens on the last two weeks. The admin looking is left out, and every active person has a line, also with no calls yet. A count is input + output + cache write + cache read, read from the gateway's LLM ledger (`~/.openclaw/forensic/llm-ledger.sqlite`). A call belongs to the person whose seat sent it, else to the owner of its chat (a subagent goes through the chat that spawned it). Chats from before multi-user mode and background work (titles, reflections, crons) belong to nobody and are not shown. The data comes from `GET /tinker/door/api/usage?tz=<zone>`, admins only. Another host of the same owner can fetch the same report with `node scripts/hive-door/usage.mjs report --tz <zone>` (it reads the door's files and writes nothing).

## Day to day

From the page: the USERS panel (admins). From a terminal: `node scripts/hive-door/door-tokens.mjs list | add <id> <Name> [--admin] | rotate|revoke|delete <id> | admin <id> on|off | seed-seats`.
Updates: `bash scripts/self-update.sh` pulls the published branch, builds beside the live tree, swaps when idle, and restarts this door onto the new code.
Tests: `node --test scripts/hive-door/*.test.mjs`.
