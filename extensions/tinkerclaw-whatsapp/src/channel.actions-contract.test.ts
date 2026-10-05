import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { whatsAppActionRuntime } from "./action-runtime.js";
import { whatsappPlugin } from "./channel.js";
import {
  registerWhatsAppConnectionController,
  unregisterWhatsAppConnectionController,
} from "./connection-controller-registry.js";
import type { ActiveWebListener } from "./inbound/types.js";
import { setWhatsAppRuntime } from "./runtime.js";

// Contract: an action the plugin advertises to the agent must reach the live WhatsApp listener.
// unsend (2026-10-02) and edit (2026-10-03) were both advertised while the handler threw
// "Unsupported WhatsApp action", so the agent kept offering things it could not do.

const DM = "+15550001111";
const GROUP = "120363000000000000@g.us";

const cfg = {
  channels: { whatsapp: { allowFrom: ["*"], actions: { reactions: true, polls: true } } },
} as OpenClawConfig;

// Params as the core runner hands them over (`target` already mapped to `to`).
const SAMPLE_PARAMS: Record<string, Record<string, unknown>> = {
  react: { to: DM, messageId: "m1", emoji: "👍" },
  edit: { to: DM, messageId: "m1", message: "fixed text" },
  unsend: { to: DM, messageId: "m1" },
  delete: { to: DM, messageId: "m1" },
  reply: { to: DM, messageId: "m1", message: "answer" },
  sticker: { to: DM, filePath: "/tmp/sticker.webp" },
  renameGroup: { to: GROUP, name: "New name" },
  setGroupIcon: { to: GROUP, filePath: "/tmp/icon.jpg" },
  setGroupDescription: { to: GROUP, description: "About" },
  addParticipant: { to: GROUP, participants: ["+15550002222"] },
  removeParticipant: { to: GROUP, participants: ["+15550002222"] },
  promoteParticipant: { to: GROUP, participants: ["+15550002222"] },
  demoteParticipant: { to: GROUP, participants: ["+15550002222"] },
  leaveGroup: { to: GROUP },
  getInviteCode: { to: GROUP },
  revokeInviteCode: { to: GROUP },
  getGroupInfo: { to: GROUP },
  "group-create": { name: "Group", participants: ["+15550002222"] },
};

const calls: string[] = [];
const record =
  <T>(name: string, value: T) =>
  async () => {
    calls.push(name);
    return value;
  };

const listener = {
  sendMessage: record("sendMessage", { messageId: "out1" }),
  sendPoll: record("sendPoll", { messageId: "poll1" }),
  sendReaction: record("sendReaction", undefined),
  revokeMessage: record("revokeMessage", undefined),
  editMessage: record("editMessage", undefined),
  updateGroup: record("updateGroup", undefined),
  sendComposingTo: record("sendComposingTo", undefined),
} as unknown as ActiveWebListener;
const controller = { getActiveListener: () => listener };

const actions = whatsappPlugin.actions!;
const advertised = actions.describeMessageTool({ cfg })?.actions ?? [];
const originalRuntime = { ...whatsAppActionRuntime };

describe("WhatsApp advertised actions contract", () => {
  beforeEach(() => {
    calls.length = 0;
    registerWhatsAppConnectionController("default", controller);
    // The edit window check reads the original's send time; this one was sent just now.
    Object.assign(whatsAppActionRuntime, originalRuntime, {
      resolveWhatsAppMessageSentAtMs: () => Date.now(),
    });
  });

  afterAll(() => {
    unregisterWhatsAppConnectionController("default", controller);
    Object.assign(whatsAppActionRuntime, originalRuntime);
  });

  it("advertises at least the basics", () => {
    expect(advertised).toEqual(expect.arrayContaining(["react", "poll", "edit", "unsend"]));
  });

  it.each(advertised.filter((action) => action !== "poll"))(
    "advertised action %s reaches the live listener",
    async (action) => {
      const params = SAMPLE_PARAMS[action];
      expect(params, `add SAMPLE_PARAMS for advertised action ${action}`).toBeDefined();
      expect(actions.supportsAction?.({ action })).toBe(true);
      await actions.handleAction!({
        channel: "whatsapp",
        action,
        params,
        cfg,
        accountId: "default",
      });
      expect(calls.length).toBeGreaterThan(0);
    },
  );

  it("poll is delivered by the outbound adapter (core routes it there)", async () => {
    setWhatsAppRuntime({ logging: { shouldLogVerbose: () => false } } as never);
    expect(advertised).toContain("poll");
    expect(actions.supportsAction?.({ action: "poll" })).toBe(false);
    await whatsappPlugin.outbound!.sendPoll!({
      cfg,
      to: DM,
      poll: { question: "Lunch?", options: ["yes", "no"] },
      accountId: "default",
    });
    expect(calls).toEqual(["sendPoll"]);
  });

  it("the CLI's delete reaches unsend", async () => {
    expect(actions.supportsAction?.({ action: "delete" })).toBe(true);
    await actions.handleAction!({
      channel: "whatsapp",
      action: "delete",
      params: SAMPLE_PARAMS.delete,
      cfg,
      accountId: "default",
    });
    expect(calls).toEqual(["revokeMessage"]);
  });

  it.each([...advertised.filter((action) => action !== "poll"), "delete" as const])(
    "%s runs in the gateway, where the listener lives (CLI calls route there)",
    (action) => {
      expect(actions.resolveExecutionMode?.({ action })).toBe("gateway");
    },
  );
});
