/**
 * FORK 2026-05-11 — trigger-gate invariants. Test target:
 * `decide-trigger.ts` (pure decision extracted from on-message.ts).
 *
 * Bible anchor: TINKER_UI_DESIGN_BIBLE/wa-triggers.md (single owner for
 * the WA trigger contract).
 *
 * Bug history this guards against:
 *   - 2026-05-04 sister-DM leak (LID rescue too permissive; this test
 *     covers the POST-rescue trigger gate, which is the second line of
 *     defence — if the gate ever started firing on no-prefix non-owner
 *     LID messages, the sister-DM bug class would return).
 *   - 2026-05-09 owner-prefix invariant ("owner+Jarvis must trigger in
 *     any chat without per-chat allowlist"). Covered by case (c) below.
 *
 * Catches: any change to the prefix-match semantics (terminator chars,
 * case folding), the owner-only bypass, or the third-party guard prompt
 * shape.
 */

import { describe, expect, it } from "vitest";
import { decideTrigger, type TriggerInputs } from "./decide-trigger.js";

// FORK 2026-05-13: use a clearly-fake test number (E.164 shape preserved so the
// trigger logic that depends on it still exercises the same code path). Real
// owner numbers do not belong in checked-in test fixtures (PII boundary).
const owner_self_dm = "+34555111000@s.whatsapp.net";
const sister_lid = "12345@lid";
const group_jid = "ABCD@g.us";
const noPrefixGroup = "FRIENDLY@g.us";

const baseInputs: Omit<TriggerInputs, "body" | "fromMe" | "chatJid"> = {
  noPrefixChats: [owner_self_dm, noPrefixGroup],
  triggerPrefix: "jarvis",
  thirdPartyGuardPrompt: "",
};

describe("decideTrigger", () => {
  it("(a) owner self-DM with no prefix → passes (no-prefix-chat)", () => {
    const decision = decideTrigger({
      ...baseInputs,
      body: "what time is the meeting tomorrow?",
      fromMe: true,
      chatJid: owner_self_dm,
    });
    expect(decision.fires).toBe(true);
    if (decision.fires) {
      expect(decision.reason).toBe("no-prefix-chat");
      expect(decision.workingBody).toBe("what time is the meeting tomorrow?");
      // ownerPrefixTriggered is false here — the prefix didn't gate this turn.
      expect(decision.ownerPrefixTriggered).toBe(false);
    }
  });

  it("(b) sister LID with fromMe=true and no prefix → REJECTED", () => {
    // This is the post-rescue gate. If LID rescue (in inbound/monitor.ts)
    // correctly DOESN'T rewrite the sister's LID to owner self-DM, the
    // chatJid stays "12345@lid" — not in noPrefixChats. The owner is
    // typing without saying "Jarvis". The gate MUST silence.
    const decision = decideTrigger({
      ...baseInputs,
      body: "hey, see you sunday",
      fromMe: true,
      chatJid: sister_lid,
    });
    expect(decision.fires).toBe(false);
    if (!decision.fires) {
      expect(decision.reason).toContain("body-prefix=false");
    }
  });

  it("(c) owner saying 'Jarvis ...' in a non-self LID → passes", () => {
    const decision = decideTrigger({
      ...baseInputs,
      body: "Jarvis, what's on my calendar today?",
      fromMe: true,
      chatJid: sister_lid,
    });
    expect(decision.fires).toBe(true);
    if (decision.fires) {
      expect(decision.reason).toBe("body-prefix");
      expect(decision.workingBody).toBe("what's on my calendar today?");
      // CRITICAL: ownerPrefixTriggered=true so applyGroupGating bypasses
      // the mention requirement. 2026-05-09 invariant.
      expect(decision.ownerPrefixTriggered).toBe(true);
    }
  });

  it("(d) noPrefixChats group entry passes without prefix", () => {
    const decision = decideTrigger({
      ...baseInputs,
      body: "what does the spec say about reactions?",
      fromMe: false,
      chatJid: noPrefixGroup,
      senderName: "Carlos",
      senderId: "+34555111222",
    });
    expect(decision.fires).toBe(true);
    if (decision.fires) {
      expect(decision.reason).toBe("no-prefix-chat");
      // Body is untouched inside noPrefixChats — no prefix-strip.
      expect(decision.workingBody).toBe("what does the spec say about reactions?");
    }
  });

  it("(e) random group without prefix → rejected", () => {
    const decision = decideTrigger({
      ...baseInputs,
      body: "lol ok",
      fromMe: false,
      chatJid: group_jid,
      senderName: "Random",
      senderId: "+34555000999",
    });
    expect(decision.fires).toBe(false);
  });

  it("prefix is case-insensitive and accepts comma/dot/!/?/: terminators", () => {
    for (const variant of [
      "jarvis hello",
      "JARVIS hello",
      "Jarvis, hello",
      "jarvis. what time?",
      "jarvis! help",
      "jarvis? please",
      "jarvis: do this",
    ]) {
      const decision = decideTrigger({
        ...baseInputs,
        body: variant,
        fromMe: true,
        chatJid: group_jid,
      });
      expect(decision.fires).toBe(true);
      if (decision.fires) {
        expect(decision.reason).toBe("body-prefix");
      }
    }
  });

  it("prefix-as-prefix-of-word is NOT treated as the trigger", () => {
    // 'jarvisland is great' should NOT fire — the prefix matcher only
    // accepts terminator chars after the prefix, not letters.
    const decision = decideTrigger({
      ...baseInputs,
      body: "jarvisland is great",
      fromMe: true,
      chatJid: group_jid,
    });
    expect(decision.fires).toBe(false);
  });

  it("non-owner with prefix → fires; thirdPartyGuardPrompt is prepended with placeholders filled", () => {
    const decision = decideTrigger({
      ...baseInputs,
      thirdPartyGuardPrompt:
        "This message is from {senderName} ({senderId}); they are not the owner.",
      body: "jarvis, what's pi?",
      fromMe: false,
      chatJid: group_jid,
      senderName: "Carlos",
      senderId: "+34555111222",
    });
    expect(decision.fires).toBe(true);
    if (decision.fires) {
      expect(decision.workingBody).toContain("Carlos");
      expect(decision.workingBody).toContain("+34555111222");
      expect(decision.workingBody).toContain("Message:\nwhat's pi?");
      expect(decision.ownerPrefixTriggered).toBe(false);
    }
  });

  it("empty body never fires", () => {
    const decision = decideTrigger({
      ...baseInputs,
      body: "",
      fromMe: false,
      chatJid: group_jid,
    });
    expect(decision.fires).toBe(false);
  });
});
