---
schema: recipe/1.0
id: outlook-email-reply
title: Outlook Email Reply (thread + signature safe)
category: communication
summary: Draft or revise an Outlook reply from the complete live thread while preserving the configured sender's real HTML signature, inline logo, recipients and quoted-message structure; verify the rendered draft before claiming the formatting is correct.
triggers:
  [
    "reply to this email",
    "draft an outlook reply",
    "put this in outlook",
    "outlook draft",
    "respond to the email",
    "reply all",
    "refine the email",
    "revise the email conversation",
  ]
effort: standard
tools: [read, exec, write, edit, browser]
children: []
params:
  profile_file:
    type: string
    default: "~/.openclaw/workspace/.agents/email-communication-profile.yaml"
    description: "Private per-user values: sender identity, mailbox, sent-style reference and expected Outlook signature fields."
  message_ref:
    type: string
    description: "Message id, subject, sender or other unambiguous reference to the thread being answered."
---

## Goal

Create or revise an Outlook draft that is correct at all three layers:

1. **conversation** — the right thread, recipients and complete context;
2. **message** — the configured sender's intended wording and register;
3. **rendered artifact** — Outlook's real HTML head, signature, inline logo and quoted thread remain intact.

A Graph PATCH returning 200 proves only that bytes were stored. It does not prove the email looks right.

## When to Use

- The user asks to answer, draft, revise or place a response in Outlook.
- An existing Outlook draft must be refined without damaging signatures or history.
- A reply-all must preserve the actual participants and thread.

## Steps

### 1. Synchronize and identify the anchor message

**Tools:** exec, read
**Done when:** The latest live thread is loaded and the exact message being answered is named.

Probe the token first: `timeout 30 node ~/.openclaw/workspace/skills/outlook-hack/scripts/outlook.mjs mail list --top 1`. On `AADSTS700084` (24 h SPA token) do NOT stop and ask: run `timeout 40 openclaw browser tabs`; a `teams.cloud.microsoft` tab listed means renew from it (skill outlook-hack § Renew the token, three calls) once his words say it is shared, and only ask him to share a tab when none is listed. Then run the Outlook incremental sync. Retrieve the complete conversation, not `bodyPreview`. Order it oldest-to-newest and distinguish:

- inbound human messages;
- the configured sender's prior replies;
- forwards or private commentary that must not become the reply anchor;
- drafts and sent versions of the same proposed answer.

Use the latest relevant inbound message as the reply anchor. Before reply-all, explicitly list expected `To` and `Cc`; do not infer them from prose or from an older turn in the thread.

### 2. Read the sender's real sent-mail register

**Tools:** exec, read
**Done when:** At least one recent sent email to the same recipient or recipient class has been inspected.

Read `{{profile_file}}`, then retrieve a recent sent example, preferably the configured `sender.sent_mail_style_reference` or a message in the same conversation. Learn from what the sender actually sent, including greeting, directness, sign-off and paragraph length. Generic “professional warmth” is not evidence.

The 2026-08-28 reference case that bought this rule used a natural multi-recipient greeting, direct paragraphs, a configured sign-off, and the sender's full Outlook signature. Personal names and message subjects belong in `{{profile_file}}`, not this shareable recipe.

### 3. Compose only the new message body

**Done when:** The new prose is complete without any copied signature or quoted history.

Write the response as an HTML fragment containing only the new body and sign-off line. Match the current Outlook body font/style. A safe paragraph shape observed in Outlook sent mail is:

```html
<div
  class="elementToProof"
  style="margin-top:1em; margin-bottom:1em; font-family:Aptos,Aptos_EmbeddedFont,Aptos_MSFontService,Calibri,Helvetica,sans-serif; font-size:12pt; color:rgb(0,0,0)"
>
  …
</div>
```

Use Outlook-compatible `<div>` blocks rather than Markdown, bare text separated by newlines, or a second full `<html><body>` document.

Do not fabricate a signature in the prose fragment. The signature is an artifact to preserve or clone with its inline attachments, not text to regenerate.

### 4. Establish a signature-bearing draft before patching

**Tools:** exec, browser
**Done when:** The current raw draft contains a top-level `<div id="Signature"` and the quoted-message boundary after it.

Inspect the draft with raw HTML. A correct Outlook reply has this order:

1. new-message body;
2. sign-off line;
3. `<div id="Signature">…</div>`;
4. `<div id="appendonsend"></div>` when Outlook provides it;
5. the first reply separator for this message;
6. `<div id="divRplyFwdMsg"…>` and the quoted conversation.

**Critical:** Microsoft Graph `createReply` / `createReplyAll` does not apply the mailbox's Outlook signature. A Graph-created reply is not ready for `keep-signature` merely because it contains the quoted thread.

Preferred paths, in order:

- Open Reply/Reply All in Outlook so Outlook creates the draft and inserts the configured signature, then patch it.
- Reuse an existing signature-bearing draft in the correct thread.
- If the local Outlook CLI is installed, it adds the signature by default (since 2026-10-09) to `outlook.mjs mail reply-draft <id> --body-file <fragment.html>`, `mail draft --to … --subject … --body-file <fragment.html>` and `mail forward-draft`. It copies the sender's OWN `id="Signature"` block, taken from the newest sent mail where that block sits above the quoted thread, with every `cid:` image. `--no-signature` opts out. The same rule applies to a NEW outbound mail, not only to replies.
- If only Graph is available, clone the complete `id="Signature"` block from a recent sent message **and copy every inline attachment referenced by its `cid:` URLs into the draft with matching `contentId`**. Do not paste signature HTML without its logo attachment.

If none is possible, stop and report `signature formatting unverified`; do not silently ship a sign-off-only draft.

### 5. Patch at the semantic boundary, never at the first `<hr>`

**Tools:** exec
**Done when:** Only the new-message region changed.

For a signature-bearing draft, use the Outlook helper:

```bash
node scripts/outlook-mail-fetch.mjs --patch-draft <id> --body-file <fragment.html> --keep-signature
```

The preserved tail begins at the current draft's **top-level** `<div id="Signature"`. Preserve it byte-for-byte, including the signature, `appendonsend`, reply separator and every nested historical signature.

Never splice at the first `<hr>`. That destroys the current sender's signature when the draft was created through Graph and confuses top-level structure with archaeological layers inside the quote. Never search for the first generic `Signature` occurrence without first delimiting the current message; quoted emails contain their own signature IDs.

### 6. Verify structure, attachments and rendered appearance

**Tools:** exec, browser
**Done when:** Storage and appearance checks are both green, or appearance is explicitly marked unverified.

With the local CLI this is one call: `outlook.mjs mail check-draft <id> --html-out draft.html` (exit 1 when the sender's signature is missing, doubled or below the quote, or a `cid:` image has no inline attachment); then render `draft.html` and look. Without it, re-fetch the draft from Graph and verify:

- `isDraft: true`;
- subject, `To`, `Cc`, conversation/thread anchor;
- new body appears exactly once;
- old proposed body is absent;
- top-level ordering is body → sign-off → `id="Signature"` → quoted boundary;
- all `cid:` values used by the signature resolve to inline draft attachments;
- every value in `sender.signature.expected_text` from `{{profile_file}}` is present;
- previous messages and their signatures remain below the current reply separator.

Then open the draft in Outlook and look at it. Verify paragraph spacing, the configured sign-off, sender name/title/logo/contact details, and the visible quoted-thread separator. A string match proves presence; only the Outlook render proves formatting.

## Constraints

- Never propose meeting days or time slots that were not read from the sender's calendar this turn. With no calendar read, give his mobile (<owner-mobile>) and ask them to call when they can, or ask him for his free slots first.

- Draft only. Never send.
- Never replace the entire raw body when a signature-bearing draft exists.
- Never downgrade the configured sender's full Outlook signature to typed name/sign-off text.
- Never claim “correctly formatted” without viewing the rendered draft.
- Keep private forwards/commentary out of business replies.

## Safety Notes

- Email recipients and sending are external effects. Creating/editing a draft is permitted; sending remains human-only and code-blocked.
- Do not expose access tokens, refresh tokens, message bodies or private commentary in logs.

## Failures Overcome

- **2026-08-28 — anonymized compliance-thread case:** a Graph reply was patched at the first `<hr>`, preserving the quote but omitting the sender's Outlook signature. The HTML survived, yet the email was not correctly formatted. The sender repaired it before sending. The cure is a signature-bearing draft, semantic `id="Signature"` splice, CID attachment preservation and rendered Outlook verification.
- **2026-10-09 — supplier RFQs and replies:** six new outbound mails and five replies were created through Graph with a typed sign-off block (name, title, company, address) in place of the sender's Outlook signature; the six RFQs were sent that way. This recipe was never opened, because the turn read only the Outlook skill. The signature came out wrong. Cure: the skill now points here, and `--signature` clones the real block with its logo in one call.
- **2026-10-09 (second pass) — the cure was opt-in:** `--signature` had to be remembered on every call, and its lookup took the first `id="Signature"` anywhere in a sent mail, so a reply sent without the sender's own signature, quoting an Outlook user whose block is followed by their own `appendonsend`, would have signed the draft with that person's name. Cure: the CLI adds the signature by default, accepts only a block above the quote (tested), and `mail check-draft` verifies a draft in one call.
- **2026-08-28 — shareability correction:** sender identity, signature expectations and sent-mail specimen were moved to `{{profile_file}}`; the recipe now carries only portable workflow logic.
- Treating `PATCH 200` as visual proof.
- Editing against `bodyPreview`, which truncates the conversation.
- Selecting a private forward or the sender's own draft as the reply anchor.
- **2026-10-15 — expired token, tab already shared:** drafting a personal mail, the Outlook token was dead (`AADSTS700084`) and the turn asked for a go without listing the browser tabs; a Teams tab was shared the whole time (it had either dropped or not reconnected after the browser restart). Same miss as 2026-10-05, when the shared Teams tab also went undetected, so step 1 now carries the tab check and the renewal path, and `outlook.mjs` prints the next step with the error. Also: `mail draft --help` is not supported and the usage line hid `--body-file`, `--attach-dir` and comma-separated `--to`; the line lists them now.
- **2026-10-10 — slots invented:** a reply offered a four-day window of meeting slots with no calendar read, and the owner already had meetings on one of those days. Cure: the constraint above.
