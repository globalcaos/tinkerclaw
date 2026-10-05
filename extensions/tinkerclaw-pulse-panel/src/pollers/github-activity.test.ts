/**
 * FORK 2026-09-10 — GitHub activity buckets are the series the owner asked for
 * (when he pushed, and how much). The GraphQL fetch is mocked at the seam;
 * these specs pin the grouping / gap-fill that the Pulse graph actually plots.
 */
import { describe, expect, it } from "vitest";
import { bucketCommits, dayNoonUtc, fillDayGaps, parseActivityArgs } from "./github-activity.js";

const DAY = 86_400_000;

describe("parseActivityArgs", () => {
  it("splits metric and owner/repo", () => {
    expect(parseActivityArgs("commits:globalcaos/tinkerclaw")).toEqual({
      metric: "commits",
      owner: "globalcaos",
      repo: "tinkerclaw",
    });
  });
  it("rejects a missing metric or a nested path", () => {
    expect(() => parseActivityArgs("globalcaos/tinkerclaw")).toThrow(/github.activity needs/);
    expect(() => parseActivityArgs("commits:globalcaos/tinkerclaw/extra")).toThrow(
      /github.activity needs/,
    );
  });
});

describe("dayNoonUtc + bucketCommits", () => {
  it("collapses two commits on the same UTC day and sums lines", () => {
    const days = bucketCommits([
      { committedDate: "2026-09-08T10:06:56Z", additions: 10, deletions: 1 },
      { committedDate: "2026-09-08T13:04:23Z", additions: 21, deletions: 3 },
      { committedDate: "2026-09-09T20:49:04Z", additions: 107, deletions: 75 },
    ]);
    expect(days).toHaveLength(2);
    expect(days[0]).toEqual({
      ts: dayNoonUtc("2026-09-08T00:00:00Z"),
      commits: 2,
      additions: 31,
      deletions: 4,
    });
    expect(days[1].commits).toBe(1);
    expect(days[1].additions).toBe(107);
  });
});

describe("fillDayGaps", () => {
  it("inserts zero days so the line sits on the floor between bursts", () => {
    const a = dayNoonUtc("2026-09-07T12:00:00Z");
    const b = a + 2 * DAY;
    const filled = fillDayGaps(
      [
        { ts: a, commits: 2, additions: 10, deletions: 1 },
        { ts: b, commits: 1, additions: 5, deletions: 0 },
      ],
      b,
    );
    expect(filled).toHaveLength(3);
    expect(filled[1]).toEqual({ ts: a + DAY, commits: 0, additions: 0, deletions: 0 });
    expect(filled[0].commits).toBe(2);
    expect(filled[2].commits).toBe(1);
  });
});
