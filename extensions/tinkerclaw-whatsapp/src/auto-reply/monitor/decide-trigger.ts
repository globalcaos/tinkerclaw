/**
 * FORK 2026-05-11 — pure trigger-gate decision, extracted from
 * `createWebOnMessageHandler` in `on-message.ts` so it can be unit-tested
 * without the whatsmeow / processMessage / getRuntimeConfig context.
 *
 * Invariants (see TINKER_UI_DESIGN_BIBLE/wa-triggers.md):
 *   - In a chat listed in `noPrefixChats`, ANY allowlisted sender triggers.
 *   - Outside `noPrefixChats`, the body must start with `triggerPrefix`
 *     (case-insensitive, followed by space/comma/dot/!/?/: or EOL).
 *   - The owner (`fromMe=true`) using the prefix sets `ownerPrefixTriggered`
 *     so downstream `applyGroupGating` bypasses the mention requirement —
 *     "owner+Jarvis must trigger in any chat" (2026-05-09 invariant).
 *   - When the prefix gated entry, strip it so Jarvis doesn't see "Jarvis …"
 *     redundantly inside the envelope (only outside `noPrefixChats`; inside
 *     `noPrefixChats` the body is left untouched).
 *   - For non-owner senders with a `thirdPartyGuardPrompt`, prepend the
 *     guard to the working body so the model can reason about provenance.
 *
 * Allowlist gating (`allowFrom`) happens upstream in
 * `checkInboundAccessControl` and is NOT this function's concern.
 */

export type TriggerInputs = {
  body: string;
  fromMe: boolean;
  chatJid: string;
  noPrefixChats: readonly string[];
  triggerPrefix: string;
  thirdPartyGuardPrompt?: string;
  senderName?: string;
  senderId?: string;
};

export type TriggerDecision =
  | {
      fires: false;
      reason: "no-prefix-chat=false body-prefix=false";
    }
  | {
      fires: true;
      ownerPrefixTriggered: boolean;
      workingBody: string;
      reason: "no-prefix-chat" | "body-prefix";
    };

export function decideTrigger(input: TriggerInputs): TriggerDecision {
  const inNoPrefix = input.noPrefixChats.includes(input.chatJid);
  const lowerPrefix = input.triggerPrefix.toLowerCase();
  const body = input.body ?? "";
  const lowerBody = body.toLowerCase().trimStart();
  const hasPrefix =
    lowerPrefix.length > 0 &&
    (lowerBody === lowerPrefix ||
      lowerBody.startsWith(`${lowerPrefix} `) ||
      lowerBody.startsWith(`${lowerPrefix},`) ||
      lowerBody.startsWith(`${lowerPrefix}.`) ||
      lowerBody.startsWith(`${lowerPrefix}!`) ||
      lowerBody.startsWith(`${lowerPrefix}?`) ||
      lowerBody.startsWith(`${lowerPrefix}:`));

  if (!inNoPrefix && !hasPrefix) {
    return { fires: false, reason: "no-prefix-chat=false body-prefix=false" };
  }

  let workingBody = body;
  if (hasPrefix && !inNoPrefix) {
    const original = body.trimStart();
    const stripped = original.slice(input.triggerPrefix.length).replace(/^[\s,.!?:]+/, "");
    const leadingWs = body.length - body.trimStart().length;
    workingBody = body.slice(0, leadingWs) + stripped;
  }

  if (!input.fromMe && input.thirdPartyGuardPrompt) {
    const filled = input.thirdPartyGuardPrompt
      .replaceAll("{senderName}", input.senderName ?? "unknown")
      .replaceAll("{senderId}", input.senderId ?? "unknown");
    workingBody = `${filled}\n\nMessage:\n${workingBody}`;
  }

  return {
    fires: true,
    ownerPrefixTriggered: hasPrefix && input.fromMe,
    workingBody,
    reason: inNoPrefix ? "no-prefix-chat" : "body-prefix",
  };
}
