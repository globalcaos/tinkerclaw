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

Run the Outlook incremental sync first. Retrieve the complete conversation, not `bodyPreview`. Order it oldest-to-newest and distinguish:

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

Re-fetch the draft from Graph and verify:

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
- **2026-08-28 — shareability correction:** sender identity, signature expectations and sent-mail specimen were moved to `{{profile_file}}`; the recipe now carries only portable workflow logic.
- Treating `PATCH 200` as visual proof.
- Editing against `bodyPreview`, which truncates the conversation.
- Selecting a private forward or the sender's own draft as the reply anchor.
