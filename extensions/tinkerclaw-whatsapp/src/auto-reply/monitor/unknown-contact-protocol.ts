/**
 * FORK 2026-05-20: protocol Jarvis follows when an inbound DM is from an
 * unknown contact (no name in the owner's phonebook AND no people-profile slug).
 *
 * Until 2026-05-20 the default behavior was "say 'I don't have context'" and
 * stop. The protocol below pushes Jarvis to actually try and identify the
 * person before giving up: signature in body, shared groups, public web,
 * domain-of-email lookups. Only after those return nothing does the
 * fallback fire.
 *
 * The block is appended to the prelude only when `[contact-card]` reports
 * no saved name and no slug — otherwise it's noise. Step 2 searches across
 * chats only when shouldOfferCrossChatLookup() allows it (message-line.ts).
 *
 * Researching the contact on the public web and keeping a lasting
 * `memory/people/<slug>.md` profile of them is OFF by default: it profiles a
 * third party who only sent a message. It is added to the block only when
 * OPENCLAW_WHATSAPP_CONTACT_RESEARCH=1.
 */
export function shouldOfferContactResearch(
  raw = process.env.OPENCLAW_WHATSAPP_CONTACT_RESEARCH,
): boolean {
  return raw?.trim() === "1";
}

export function buildUnknownContactProtocolBlock(params: {
  allowCrossChat: boolean;
  allowResearch?: boolean;
}): string {
  const lookupSteps = params.allowCrossChat
    ? [
        "  2. Scan whatsapp_history for prior cross-chat mentions of the phone or",
        '     name fragment (action="search", query="<fragment>").',
      ]
    : [
        "  2. Check earlier messages in THIS chat with whatsapp_history",
        '     (action="search", chat=<this chat>) for a name or context.',
      ];
  const researchSteps = params.allowResearch
    ? [
        "  3. If you have an email or company name, WebSearch them (LinkedIn,",
        "     corporate site, GitHub) to learn role and context.",
        "  4. If still unknown after those, ask politely WHO they are (in the",
        "     recipient's language) — but only after the steps above.",
        "When the conversation produces real signal (name, role, why they wrote),",
        "create `memory/people/<slug>.md` so the next inbound from this number",
        "lands with context. Slug = lowercase first-name-or-handle, kebab-case.",
      ]
    : [
        "  3. If still unknown after those, ask politely WHO they are (in the",
        "     recipient's language). Do not look them up on the web and do not",
        "     create a people profile for them.",
      ];
  return [
    "[unknown-contact-protocol]",
    "This contact is NOT in the owner's phonebook and has NO people-profile slug yet.",
    "Before answering, try to identify them from what is already here:",
    "  1. Read the inbound body and any quoted message for a signature, company,",
    "     email, role, or surname.",
    ...lookupSteps,
    ...researchSteps,
    "[/unknown-contact-protocol]",
  ].join("\n");
}

/** Owner-initiated form (cross-chat lookup allowed; research still opt-in). */
export const UNKNOWN_CONTACT_PROTOCOL_BLOCK = buildUnknownContactProtocolBlock({
  allowCrossChat: true,
  allowResearch: shouldOfferContactResearch(),
});
