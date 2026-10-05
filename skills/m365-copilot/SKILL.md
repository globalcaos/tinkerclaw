---
name: m365-copilot
description: "Use your organization's Microsoft 365 Copilot (a no-training enterprise seat) through a shared browser tab. It is the model to send CVs, HR papers and other personal documents to, when your contract says the vendor may not train on them and must forget them on request. Two ways in: (1) a normal provider in the model picker, copilot/copilot-think-deeper, that gets the full turn (system prompt, tools, history) and can call tools; (2) a CLI that attaches files and writes the answer to disk, so no other model sees the content. Use when the user says Copilot, 365 Copilot, M365, 'pass it through Copilot', or when a task touches a CV, a candidate, a contract or any personal document that policy keeps inside the tenant. NOT GitHub Copilot."
allowed-tools: "Bash"
metadata:
  openclaw:
    emoji: "🔒"
    os: ["linux"]
    requires:
      capabilities: ["browser"]
    notes:
      security: "No token is stored: auth lives in the signed-in Copilot tab you share. Files go from the local disk into the chat's own upload input and nowhere else. Logs hold counts only, never content or file names. Turn files live in a tmpfs work dir and are removed after each turn. Every upload also leaves a copy in the signed-in user's work OneDrive."
---

# m365-copilot

**What it is for.** Some documents should only be read by a model your organization has a
contract with. A CV is the usual case: sending it to a general-purpose model may break data
protection law. A Microsoft 365 Copilot enterprise seat often comes with no-training and
right-to-forget terms, which makes it the right place for personal documents. It has no public
chat API for this, only the web chat. This skill makes that web chat usable as an AI provider and
as a private document reader.

**What would change it:** an approved Graph Chat API grant for your tenant (then the tab
dependency goes away), or the data owner naming another model as allowed for personal data.

Check your organization's policy before you automate a web chat. Keep the volume low: this is a
tab you drive, not a service you call.

## Parameters

Nothing below is tied to one tenant or account. The tenant is whichever account is signed in to
the tab you share.

| Parameter                 | Default                                   | What it controls                                                                                        |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `M365_COPILOT_CHAT_URL`   | `https://m365.cloud.microsoft/chat`       | The Copilot chat page the driver looks for among shared tabs                                            |
| `M365_COPILOT_SCRIPTS`    | `~/.openclaw/scripts/m365-copilot`        | Folder that holds the driver scripts (see Files)                                                        |
| `COPILOT_SAVE_ROOT`       | `~/Documents/<org>`                       | The only folder Copilot may save into                                                                   |
| read roots                | `~/Documents`, `~/Downloads`, `~/Desktop` | Folders Copilot may list and attach from                                                                |
| `COPILOT_SHIM_PORT`       | `18795`                                   | Port of the local OpenAI-compatible shim (loopback only)                                                |
| `COPILOT_SHIM_DENY_TOOLS` | `pdf,image`                               | Gateway tools withheld from Copilot. Empty it to offer them anyway                                      |
| `COPILOT_DEBUG`           | unset                                     | Set to print driver steps to stderr (never content)                                                     |
| `COPILOT_SHIM_DUMP`       | unset                                     | Set to keep the last request body and turn files in `$XDG_RUNTIME_DIR/copilot-shim/` (tmpfs, mode 0600) |
| provider id               | `copilot/copilot-think-deeper`            | The model name the gateway and picker use                                                               |
| service name              | `copilot-shim`                            | The systemd user unit that runs the shim                                                                |

## Requirement

The Copilot chat tab (`$M365_COPILOT_CHAT_URL`) must be **shared in the OpenClaw Chrome
extension**, signed in to your organization's account, and Chrome must stay open. Check:
`openclaw browser status` → `running: true`. After a reboot it reads `false` until the user
shares the tab again. Ask them; nothing else fixes it.

## Way 1 — Copilot as a normal model (picker)

Pick **`copilot/copilot-think-deeper`** in a chat tab. Every request carries the whole turn. The
system prompt and the full conversation go as two attached files (`turn-conversation.md`,
`turn-system-tools.md`); the newest message and the tool results after it are typed. Copilot
answers in text or calls tools, which the gateway runs as with any model.

- It gets every gateway tool **except those in `COPILOT_SHIM_DENY_TOOLS`** (`pdf` and `image` by
  default). Those hand the file to another model. Copilot reads documents itself with
  `TOOL attach <path>`, so the file goes to your tenant only.
- Loop guard: the same tool with the same arguments a 3rd time since the user spoke → the shim
  stops and says so.
- Each round is one Copilot message from a **daily quota**. A runaway loop once spent ~120 of them.
- Each request opens a fresh Copilot chat. The gateway resends the full history every time, as
  with a stateless API.
- Service: `systemctl --user status copilot-shim` · log: `journalctl --user -u copilot-shim`
  (counts only).

Setup, once:

1. Register the provider in `openclaw.json` (use your `COPILOT_SHIM_PORT` if you changed it):
   `"copilot": { "apiKey": "local-shim", "baseUrl": "http://127.0.0.1:18795/v1", "models": [{ "id": "copilot-think-deeper", "name": "M365 Copilot (Think deeper)" }] }`.
   The key is a placeholder: the shim needs none, auth lives in the tab.
2. **Enroll the model too:** add `agents.defaults.models["copilot/copilot-think-deeper"] = {}`.
   The picker lists the keys of `agents.defaults.models`, not `models.providers`. A registered
   but unenrolled provider stays invisible. The key is picked up live.
3. Prove routing with the shim's own log (`journalctl --user -u copilot-shim | grep chat/completions`).
   Two surfaces mislead: `openclaw models list` never shows config-only providers, and a spawned
   subagent can report the model as applied while it answers from a fallback model.

## Way 2 — private document task, the calling model never sees the content

```
node "$M365_COPILOT_SCRIPTS/copilot-agent.mjs" \
  --attach "<documents-dir>/<file>.pdf" \
  --out "$COPILOT_SAVE_ROOT/<answer>.md"  "<task in words>"
```

`--out` writes the answer to disk and prints only the path and counts. **Do not open that file**
when the caller is another model (the agent included). Tell the user where it is. Copilot can
also drive itself here, for up to 8 rounds:

- `TOOL list <folder>` — read-only, inside the read roots.
- `TOOL attach <file>` — at most 10 files per message, inside the read roots.
- `TOOL save <file>` — only under `COPILOT_SAVE_ROOT`, only `.md`, `.txt`, `.csv` or `.html`,
  never overwrites (a second save gets ` (2)`).

**Never** `pdftotext`, `Read` or image-read a personal document "to help Copilot". That puts the
content in front of the very model the lane exists to avoid. Hand Copilot the file.

## Things to tell the user before a batch of personal documents

- Copilot keeps a **cross-chat Memory**. A fresh chat once recalled a code from the previous
  day's chat. It can mix up candidates, and it retains data a right-to-forget request may need to
  cover. Switching it off is the user's own Copilot setting.
- Every attachment leaves a copy in the signed-in user's **work OneDrive** (folder "Microsoft
  Copilot Chat Files"). That is inside the tenant contract, but it accumulates, and a
  right-to-forget request must cover it too.

## Files

The driver scripts are **not shipped in this skill folder**. The skill expects them in
`$M365_COPILOT_SCRIPTS`; bring your own copy or write them to this contract:

- `m365-copilot-ask.mjs` — drives the tab over the browser relay and CDP: `--new-chat`,
  `--attach <file>`, then the prompt. Finds the shared tab whose URL matches
  `$M365_COPILOT_CHAT_URL`, forces the "Think deeper" model, stages files through the page's own
  upload input, waits for the answer to settle.
- `br-relay.mjs` — a small client for the gateway's `browser.request` RPC (`node br-relay.mjs GET
/tabs`). It reads `OPENCLAW_GATEWAY_URL` (default `http://127.0.0.1:18789`) and
  `OPENCLAW_GATEWAY_TOKEN` (default: the gateway token in `~/.openclaw/openclaw.json`).
- `copilot-agent.mjs` — Way 2: the local `TOOL list/attach/save` loop, the read roots and
  `COPILOT_SAVE_ROOT` checks, and a cross-process tab lock (`$XDG_RUNTIME_DIR/copilot-tab.lock`),
  because there is one tab and many callers.
- `copilot-context.mjs` — what Copilot is told on each ask: a catalog of skills and recipes (name
  plus one line) and the tool protocol. It never sends agent memory or persona files. If Copilot
  asks to read a skill it gets the text; if it asks to run one, the answer is no.
- `copilot-provider.mjs` — Way 1: renders the turn files, parses `TOOL_CALLS` replies, loop guard.
- `copilot-shim.mjs` — the OpenAI-compatible service on `127.0.0.1:$COPILOT_SHIM_PORT`
  (`/v1/models`, `/v1/chat/completions`).

They need Node.js and the `ws` package. The chat URL, read roots and save root are listed as
parameters above; if your copy of the driver keeps them as constants, change them there. Keep the
scripts in a tracked folder and point the service's `ExecStart` there. Keep your own dated history
note next to them.

## Failures overcome

- **2026-09-24 — bridge dead after a reboot.** A cleanup sweep moved the untracked scripts out of
  the folder the service ran from. The running shim kept serving from memory until the next
  reboot, then crash-looped on `MODULE_NOT_FOUND` for 14 hours. Fix: the scripts moved to a
  tracked folder and the unit points there. Grep live consumers before moving "clutter".
- **2026-09-24 — progress line returned as the answer.** "Think deeper" can hold "Making it
  happen…" longer than the settle window. A short single line ending in "…" is now provisional.
- **2026-09-24 — the whole system prompt typed into the chat box.** ~96k characters, private
  memory included, outlived every timeout. The turn now goes as attached files, and only the
  newest message is typed.
- **2026-09-26 — 117 repeated calls.** With one 170k-character file, Copilot retrieved chunks
  instead of reading it whole, never saw the newest tool results, and repeated one call 117
  times. That spent ~120 messages of the daily quota. Fix: two files (the conversation file stays
  small enough to be read whole), the newest steps typed, and the loop guard.
- **2026-09-26 — every ask hung for 400 s.** "Think deeper" renders a collapsed reasoning block
  with its own hidden reply element first. The driver now reads the last non-empty reply.
- **2026-09-25 — a tool loop that restarted from step 1.** Each tool result re-pasted the whole
  task. The follow-up now says to continue from the start of this chat without repeating
  completed steps.
