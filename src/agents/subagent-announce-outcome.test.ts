import { describe, expect, test } from "vitest";
import {
  buildEmptyResultReplyInstruction,
  describeAnnounceOutcome,
  EMPTY_RESULT_PLACEHOLDER,
} from "./subagent-announce-outcome.js";

// FORK 2026-09-07 (the user, on the SerraVision tab) — the incident these pin.
//
// On 2026-09-03 a subagent labelled `saica-video-audit` ran for 3 SECONDS, spent 0 tokens
// (in 0 / out 0), and returned an EMPTY string. The announce path reported
// `status: completed successfully`, substituted the literal "(no output)" for the missing
// result, and then handed the parent this instruction:
//
//   "A completed subagent task is ready for user delivery. Convert the result above into
//    your normal assistant voice and send that user-facing update now."
//
// So a task that did nothing cost a full parent turn AND was announced as a success. The
// requested SerraVision video-recording audit never ran, and nothing said so.
//
// An `ok` transport status means "the child process ended without erroring". It does NOT
// mean the child produced anything. Those are different facts and must read differently.
describe("describeAnnounceOutcome", () => {
  test("an ok status with no findings is NOT reported as success", () => {
    const out = describeAnnounceOutcome({ status: "ok", rawFindings: "" });
    expect(out.producedNoOutput).toBe(true);
    expect(out.statusLabel).not.toContain("successfully");
    expect(out.statusLabel).toContain("no output");
    // The placeholder still stands in for the body, so the event stays well-formed.
    expect(out.findings).toBe(EMPTY_RESULT_PLACEHOLDER);
  });

  test("whitespace-only findings count as no output", () => {
    for (const raw of ["   ", "\n", "\t\n  \n"]) {
      const out = describeAnnounceOutcome({ status: "ok", rawFindings: raw });
      expect(out.producedNoOutput).toBe(true);
    }
  });

  test("a real result keeps the existing success wording untouched", () => {
    const out = describeAnnounceOutcome({ status: "ok", rawFindings: "KNOW: 3 cameras wired." });
    expect(out.producedNoOutput).toBe(false);
    expect(out.statusLabel).toBe("completed successfully");
    expect(out.findings).toBe("KNOW: 3 cameras wired.");
  });

  // The non-ok ladder is pre-existing behaviour and must not shift: those statuses already
  // tell the truth, and an empty body on top of them adds nothing.
  test("timeout, error and unknown keep their labels and are not re-branded as empty", () => {
    expect(describeAnnounceOutcome({ status: "timeout", rawFindings: "" }).statusLabel).toBe(
      "timed out",
    );
    expect(
      describeAnnounceOutcome({ status: "error", rawFindings: "", error: "boom" }).statusLabel,
    ).toBe("failed: boom");
    expect(describeAnnounceOutcome({ status: "error", rawFindings: "" }).statusLabel).toBe(
      "failed: unknown error",
    );
    expect(describeAnnounceOutcome({ status: "unknown", rawFindings: "" }).statusLabel).toBe(
      "finished with unknown status",
    );
    for (const status of ["timeout", "error", "unknown"] as const) {
      expect(describeAnnounceOutcome({ status, rawFindings: "" }).producedNoOutput).toBe(false);
    }
  });
});

describe("buildEmptyResultReplyInstruction", () => {
  test("tells the parent to report the empty result and forbids inventing one", () => {
    const instruction = buildEmptyResultReplyInstruction("subagent task");
    expect(instruction).toContain("no output");
    expect(instruction).toMatch(/do not (invent|fabricate)/i);
    // The whole defect was the parent being told to dress nothing up as an update.
    expect(instruction).not.toContain("Convert the result above into your normal assistant voice");
  });

  test("names the announce type so a cron job does not read as a subagent", () => {
    expect(buildEmptyResultReplyInstruction("cron job")).toContain("cron job");
  });
});
