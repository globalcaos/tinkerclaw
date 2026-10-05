/**
 * Exact chat-JID candidates for history lookups scoped to ONE chat.
 *
 * Callers pass either a full JID (`34600000000@s.whatsapp.net`, `…@g.us`,
 * `…@lid`) or a bare / E.164 number (`+34600000000`). The previous
 * `chat_jid LIKE %digits%` match was not scoped to one chat: legacy group JIDs
 * embed the creator's phone number (`34600000000-1600000000@g.us`), so a DM
 * with that person also pulled that group's messages into the DM prelude.
 *
 * Returns two exact values for a `chat_jid IN (?, ?)` clause:
 *   - full JID  -> the JID itself (twice)
 *   - bare/E.164 -> the input as given, and `<digits>@s.whatsapp.net`
 */
export function resolveChatJidCandidates(chatJid: string): [string, string] {
  const trimmed = chatJid.trim().replace(/^whatsapp:/i, "");
  if (trimmed.includes("@")) {
    return [trimmed, trimmed];
  }
  const digits = trimmed.replace(/^\+/, "");
  return [trimmed, `${digits}@s.whatsapp.net`];
}
