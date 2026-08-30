import { describe, it, expect } from "vitest";
import {
  attachmentButtonLabel,
  attachmentDotFilled,
  classifyStopOutcome,
  formatAttachmentAge,
  liveAgeMs,
  sortAttachments,
  stopButtonTitle,
  type Attachment,
} from "./attachments";

function row(id: string, kind: Attachment["kind"], over: Partial<Attachment> = {}): Attachment {
  return { id, kind, label: id, ageMs: 0, stoppable: true, ...over };
}

describe("formatAttachmentAge", () => {
  it("writes the three bands from the approved mock", () => {
    expect(formatAttachmentAge(45_000)).toBe("45s");
    expect(formatAttachmentAge(757_000)).toBe("12m 37s");
    expect(formatAttachmentAge(50_100_000)).toBe("13h55m");
  });

  it("pads so a ticking readout keeps a constant width", () => {
    expect(formatAttachmentAge(64_000)).toBe("1m 04s");
    expect(formatAttachmentAge(3_900_000)).toBe("1h05m");
  });

  it("switches band exactly on the boundary", () => {
    expect(formatAttachmentAge(59_999)).toBe("59s");
    expect(formatAttachmentAge(60_000)).toBe("1m 00s");
    expect(formatAttachmentAge(3_599_000)).toBe("59m 59s");
    expect(formatAttachmentAge(3_600_000)).toBe("1h00m");
  });

  it("never renders a blank or NaN age on a row that exists", () => {
    expect(formatAttachmentAge(0)).toBe("0s");
    expect(formatAttachmentAge(-5)).toBe("0s");
    expect(formatAttachmentAge(Number.NaN)).toBe("0s");
  });
});

describe("liveAgeMs", () => {
  it("adds client elapsed to the gateway age measured at fetch", () => {
    expect(liveAgeMs(1_000, 5_000, 8_000)).toBe(4_000);
  });

  it("ignores the gateway wall clock entirely (skew must not reach the display)", () => {
    // A gateway 10 minutes ahead of the browser would make `now - startedAt` negative; the anchored
    // form cannot see startedAt at all, so a 30s-old row is still 30s old.
    expect(liveAgeMs(30_000, 1_000_000, 1_000_000)).toBe(30_000);
  });

  it("holds rather than counts down when the clock jumps backwards", () => {
    expect(liveAgeMs(30_000, 1_000_000, 999_000)).toBe(30_000);
  });

  it("treats a garbage age as zero", () => {
    expect(liveAgeMs(Number.NaN, 0, 2_000)).toBe(2_000);
    expect(liveAgeMs(-100, 0, 2_000)).toBe(2_000);
  });
});

describe("row presentation", () => {
  it("fills the dot for work in progress and hollows it for work that is waiting", () => {
    expect(attachmentDotFilled(row("a", "run"))).toBe(true);
    expect(attachmentDotFilled(row("b", "process"))).toBe(true);
    expect(attachmentDotFilled(row("c", "queued"))).toBe(false);
  });

  it("says Stop for work in progress and Clear for a queued prompt", () => {
    expect(attachmentButtonLabel(row("a", "run"))).toBe("Stop");
    expect(attachmentButtonLabel(row("b", "process"))).toBe("Stop");
    expect(attachmentButtonLabel(row("c", "queued"))).toBe("Clear");
  });

  it("explains a disabled button instead of leaving it mute", () => {
    const t = stopButtonTitle(row("a", "process", { stoppable: false }));
    expect(t).toMatch(/Cannot be stopped/);
    const withDetail = stopButtonTitle(
      row("a", "process", { stoppable: false, detail: "owned by another host" }),
    );
    expect(withDetail).toContain("owned by another host");
  });
});

describe("sortAttachments", () => {
  it("orders run, then process, then queued", () => {
    const sorted = sortAttachments([row("q", "queued"), row("p", "process"), row("r", "run")]);
    expect(sorted.map((a) => a.id)).toEqual(["r", "p", "q"]);
  });

  it("puts the OLDEST first inside a kind — that is the row the user is hunting", () => {
    const sorted = sortAttachments([
      row("young", "process", { ageMs: 1_000 }),
      row("old", "process", { ageMs: 50_100_000 }),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["old", "young"]);
  });

  it("is stable across polls so a row cannot swap under the pointer", () => {
    const rows = [row("b", "run", { ageMs: 5 }), row("a", "run", { ageMs: 5 })];
    expect(sortAttachments(rows).map((a) => a.id)).toEqual(["a", "b"]);
    expect(sortAttachments(rows.slice().reverse()).map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("does not reorder the caller's array", () => {
    const rows = [row("q", "queued"), row("r", "run")];
    sortAttachments(rows);
    expect(rows.map((a) => a.id)).toEqual(["q", "r"]);
  });

  it("sinks an unknown kind deterministically instead of scrambling the sort", () => {
    const weird = { ...row("x", "run"), kind: "gremlin" } as unknown as Attachment;
    const sorted = sortAttachments([weird, row("q", "queued"), row("r", "run")]);
    expect(sorted.map((a) => a.id)).toEqual(["r", "q", "x"]);
  });
});

describe("classifyStopOutcome", () => {
  it("reads gone and the three stop verbs as success", () => {
    expect(classifyStopOutcome({ stopped: true, action: "gone" }).ok).toBe(true);
    expect(classifyStopOutcome({ stopped: true, action: "aborted" }).ok).toBe(true);
    expect(classifyStopOutcome({ stopped: true, action: "terminated" }).ok).toBe(true);
    expect(classifyStopOutcome({ stopped: true, action: "killed" }).ok).toBe(true);
  });

  it("never lets a refusal pass silently, and carries its reason", () => {
    const out = classifyStopOutcome({
      stopped: false,
      action: "refused",
      detail: "pid 3451742 is not a child of this gateway",
    });
    expect(out.ok).toBe(false);
    expect(out.tone).toBe("warn");
    expect(out.text).toContain("pid 3451742 is not a child of this gateway");
  });

  it("still says something when a refusal gives no reason", () => {
    const out = classifyStopOutcome({ stopped: false, action: "refused" });
    expect(out.tone).toBe("warn");
    expect(out.text.length).toBeGreaterThan(0);
  });

  it("believes the flag over the verb when they disagree", () => {
    const out = classifyStopOutcome({ stopped: false, action: "terminated" });
    expect(out.ok).toBe(false);
    expect(out.tone).toBe("warn");
    expect(out.text).toContain("not stopped");
  });

  it("warns on an outcome it does not recognise rather than rendering it as success", () => {
    const out = classifyStopOutcome({
      stopped: true,
      action: "vaporised",
    } as unknown as Parameters<typeof classifyStopOutcome>[0]);
    expect(out.ok).toBe(false);
    expect(out.text).toContain("vaporised");
  });

  it("warns when there is no reply at all", () => {
    expect(classifyStopOutcome(undefined).ok).toBe(false);
    expect(classifyStopOutcome(null).tone).toBe("warn");
  });
});
