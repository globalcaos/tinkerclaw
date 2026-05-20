/**
 * FORK 2026-05-20: language-matching directive for the WhatsApp prelude.
 *
 * the owner bounces between es / en / ca naturally; a default-English reply on
 * a Spanish or Catalan prompt reads as not paying attention. This block
 * codifies the rule so Jarvis doesn't have to be reminded.
 *
 * The block is short on purpose — the rule is one sentence; the persona
 * scaffolding (🤖 prefix, ⚡ done-separator) is wire-level and lives in the
 * persona block, NOT here.
 */
export const LANGUAGE_POLICY_BLOCK = [
  "[language-policy]",
  "Reply in the language of the inbound message (es / en / ca / etc.).",
  "If the sender switches language mid-thread, switch with them on the next reply.",
  "When you draft an outbound message for a third party, the DRAFT uses the",
  "recipient's language; any meta-reply back to the owner still matches the owner's.",
  "[/language-policy]",
].join("\n");
