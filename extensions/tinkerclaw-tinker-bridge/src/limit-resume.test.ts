import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLimitResumeTimersForTest,
  LIMIT_RESUME_BOOT_SETTLE_MS,
  LIMIT_RESUME_DELAY_MS,
  LIMIT_RESUME_MESSAGE,
  promptAfter,
  promptedSinceOnDisk,
  planLimitResume,
  readLimitResumes,
  rearmLimitResumes,
  scheduleLimitResume,
  setLimitResumeDeps,
} from "./limit-resume.js";

// FORK 2026-10-09 — the wake after a Claude usage limit. Texts are the CLI's own, copied from the
// gateway log (30 days, 2026-10-09): session 8:30pm / 11:50am / 5am, weekly 8am and "Oct 8, 6pm",
// and the monthly-spend line that names the weekly reset.

const CHAT = "agent:main:tinker:muwizxjp";
const SESSION_830PM = "You've hit your session limit · resets 8:30pm (Europe/Madrid)";
const WEEKLY_8AM = "You've hit your weekly limit · resets 8am (Europe/Madrid)";
const WEEKLY_DATED = "You've hit your weekly limit · resets Oct 8, 6pm (Europe/Madrid)";
const MONTHLY_SPEND =
  "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your weekly limit resets Oct 1, 6pm (Europe/Madrid)";

const at = (iso: string) => Date.parse(iso);

describe("planLimitResume: when the wake fires", () => {
  it("8:30pm the same evening (the 2026-10-09 19:37 incident)", () => {
    const plan = planLimitResume({
      sessionKey: CHAT,
      raw: SESSION_830PM,
      now: at("2026-10-09T17:37:19Z"),
    });
    expect(plan?.resetAt).toBe(at("2026-10-09T18:30:00Z"));
    expect(plan?.fireAt).toBe(at("2026-10-09T18:32:00Z"));
    expect(plan?.errorAt).toBe(at("2026-10-09T17:37:19Z"));
  });

  it("8am rolls to the next morning when it is already past 8am", () => {
    const plan = planLimitResume({
      sessionKey: CHAT,
      raw: WEEKLY_8AM,
      now: at("2026-10-09T21:10:00Z"),
    });
    expect(plan?.resetAt).toBe(at("2026-10-10T06:00:00Z"));
    expect(plan?.fireAt).toBe(at("2026-10-10T06:02:00Z"));
  });

  it("an explicit date: Oct 8, 6pm", () => {
    const plan = planLimitResume({
      sessionKey: CHAT,
      raw: WEEKLY_DATED,
      now: at("2026-10-06T12:00:00Z"),
    });
    expect(plan?.resetAt).toBe(at("2026-10-08T16:00:00Z"));
  });

  it("the monthly-spend line wakes at the weekly reset it names", () => {
    const plan = planLimitResume({
      sessionKey: CHAT,
      raw: MONTHLY_SPEND,
      now: at("2026-09-29T10:00:00Z"),
    });
    expect(plan?.resetAt).toBe(at("2026-10-01T16:00:00Z"));
  });

  it("an explicit date after the October clock change reads winter time", () => {
    const plan = planLimitResume({
      sessionKey: CHAT,
      raw: "You've hit your weekly limit · resets Oct 26, 9am (Europe/Madrid)",
      now: at("2026-10-24T12:00:00Z"),
    });
    expect(plan?.resetAt).toBe(at("2026-10-26T08:00:00Z"));
  });

  it("nothing for a dated reset already behind us (it would mean next year)", () => {
    expect(
      planLimitResume({ sessionKey: CHAT, raw: MONTHLY_SPEND, now: at("2026-10-09T17:00:00Z") }),
    ).toBeNull();
  });

  it("nothing outside a Tinker tab: subagent, Fractal turn, channel", () => {
    const now = at("2026-10-09T17:37:19Z");
    for (const sessionKey of [
      "agent:main:subagent:fda3d5df-815f-4bd1-b248-4b8c955d5ce2",
      "agent:main:fractal:990b593d-13d8-4265-bcbb-09625ee1e5cb",
      "agent:main:whatsapp:direct:+34600000000",
      undefined,
    ]) {
      expect(planLimitResume({ sessionKey, raw: SESSION_830PM, now })).toBeNull();
    }
  });

  it("nothing for an error that is not a usage limit, even if it mentions a reset", () => {
    const now = at("2026-10-09T17:37:19Z");
    expect(
      planLimitResume({ sessionKey: CHAT, raw: "API Error: 500 Internal server error", now }),
    ).toBeNull();
    expect(
      planLimitResume({ sessionKey: CHAT, raw: "Connection reset at 8:30pm by peer", now }),
    ).toBeNull();
  });
});

describe("promptAfter: did anything prompt the chat after the error", () => {
  const line = (role: string, text: string, iso: string) =>
    JSON.stringify({
      type: "message",
      timestamp: iso,
      message: { role, content: [{ type: "text", text }], timestamp: Date.parse(iso) },
    });
  const errorAt = at("2026-10-09T17:37:19Z");
  const before = line(
    "user",
    "[Fri 2026-10-09 19:30 GMT+2] Nearly done then?",
    "2026-10-09T17:31:01Z",
  );

  it("yes for his own prompt after the error", () => {
    const t = [
      before,
      line("user", "[Fri 2026-10-09 20:52 GMT+2] keep going", "2026-10-09T18:53:00Z"),
    ];
    expect(promptAfter(t.join("\n"), errorAt)).toBe(true);
  });

  it("yes for an agent's wake or a gateway [System] resume after the error: the chat moved on", () => {
    const wake = line(
      "user",
      "[Fri 2026-10-09 20:31 GMT+2] ⟦AGENT:⏳ Longjob · x⟧ done",
      "2026-10-09T18:31:00Z",
    );
    const resume = line(
      "user",
      "[System] The machine was shut down or rebooted …",
      "2026-10-09T18:41:00Z",
    );
    expect(promptAfter([before, wake].join("\n"), errorAt)).toBe(true);
    expect(promptAfter([before, resume].join("\n"), errorAt)).toBe(true);
  });

  it("no for a prompt before the error, an assistant line, a custom record, a broken line", () => {
    const t = [
      before,
      line("assistant", "__ERR_ENV__:{}", "2026-10-09T17:37:19Z"),
      line("assistant", "hello", "2026-10-09T18:42:00Z"),
      JSON.stringify({ type: "custom", customType: "openclaw.restart-notice", data: {} }),
      "not json at all {",
    ].join("\n");
    expect(promptAfter(t, errorAt)).toBe(false);
  });
});

describe("the wake: one per chat, persisted, skipped when the chat moved on, re-armed at boot", () => {
  let dir: string;
  let sent: Array<{ sessionKey: string; message: string; idempotencyKey: string }>;
  let prompted: boolean;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "limit-resume-"));
    process.env.OPENCLAW_TINKER_BRIDGE_LIMIT_RESUME = path.join(dir, "limit-resume.json");
    sent = [];
    prompted = false;
    setLimitResumeDeps({
      send: async (req) => {
        sent.push(req);
      },
      promptedSince: () => prompted,
    });
    vi.useFakeTimers({ now: at("2026-10-09T17:37:19Z") });
  });

  afterEach(() => {
    __resetLimitResumeTimersForTest();
    setLimitResumeDeps(null);
    vi.useRealTimers();
    delete process.env.OPENCLAW_TINKER_BRIDGE_LIMIT_RESUME;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fires once at reset + 2 min, as a blue agent bubble, and clears the record", async () => {
    const plan = scheduleLimitResume({ sessionKey: CHAT, raw: SESSION_830PM });
    expect(plan?.fireAt).toBe(at("2026-10-09T18:32:00Z"));
    expect(readLimitResumes()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(at("2026-10-09T18:32:00Z") - Date.now() - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].sessionKey).toBe(CHAT);
    expect(sent[0].message).toBe(LIMIT_RESUME_MESSAGE);
    expect(sent[0].message.startsWith("⟦AGENT:⏰ Limit reset⟧")).toBe(true);
    expect(readLimitResumes()).toEqual([]);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(sent).toHaveLength(1);
  });

  it("keeps one pending wake per chat: a second error replaces the first", async () => {
    scheduleLimitResume({ sessionKey: CHAT, raw: SESSION_830PM });
    await vi.advanceTimersByTimeAsync(60_000);
    scheduleLimitResume({ sessionKey: CHAT, raw: SESSION_830PM });
    const other = "agent:main:tinker:mtba8duf";
    scheduleLimitResume({ sessionKey: other, raw: SESSION_830PM });
    expect(
      readLimitResumes()
        .map((w) => w.sessionKey)
        .toSorted(),
    ).toEqual([CHAT, other].toSorted());

    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(sent.map((s) => s.sessionKey).toSorted()).toEqual([CHAT, other].toSorted());
  });

  it("skips the wake when a prompt reached that chat after the error", async () => {
    scheduleLimitResume({ sessionKey: CHAT, raw: SESSION_830PM });
    prompted = true;
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(sent).toEqual([]);
    expect(readLimitResumes()).toEqual([]);
  });

  it("survives a gateway restart: timers gone, the record on disk is re-armed at boot", async () => {
    scheduleLimitResume({ sessionKey: CHAT, raw: SESSION_830PM });
    __resetLimitResumeTimersForTest(); // the process died; only the file is left
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(rearmLimitResumes()).toBe(1);
    await vi.advanceTimersByTimeAsync(at("2026-10-09T18:32:00Z") - Date.now());
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toBe(LIMIT_RESUME_MESSAGE);
  });

  it("a wake that fell due while the gateway was down fires just after boot", async () => {
    scheduleLimitResume({ sessionKey: CHAT, raw: SESSION_830PM });
    __resetLimitResumeTimersForTest();
    vi.setSystemTime(at("2026-10-09T18:50:00Z")); // 18 min overdue
    expect(rearmLimitResumes()).toBe(1);
    await vi.advanceTimersByTimeAsync(LIMIT_RESUME_BOOT_SETTLE_MS - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
  });

  it("drops a wake that is hours stale at boot instead of sending it", async () => {
    scheduleLimitResume({ sessionKey: CHAT, raw: SESSION_830PM });
    __resetLimitResumeTimersForTest();
    vi.setSystemTime(at("2026-10-10T08:00:00Z")); // laptop was off overnight
    expect(rearmLimitResumes()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sent).toEqual([]);
    expect(readLimitResumes()).toEqual([]);
  });

  it("retries a failed send and stops at the first success", async () => {
    let calls = 0;
    setLimitResumeDeps({
      send: async (req) => {
        calls += 1;
        if (calls === 1) {
          throw new Error("gateway busy");
        }
        sent.push(req);
      },
      promptedSince: () => false,
    });
    scheduleLimitResume({ sessionKey: CHAT, raw: SESSION_830PM });
    await vi.advanceTimersByTimeAsync(at("2026-10-09T18:32:00Z") - Date.now() + 20_000);
    expect(calls).toBe(2);
    expect(sent).toHaveLength(1);
  });

  it("arms nothing for a non-limit error", () => {
    expect(scheduleLimitResume({ sessionKey: CHAT, raw: "API Error: 500" })).toBeNull();
    expect(readLimitResumes()).toEqual([]);
    expect(LIMIT_RESUME_DELAY_MS).toBe(120_000);
  });
});

describe("promptedSinceOnDisk: the chat's transcript, found through the session store", () => {
  const userLine = (text: string, iso: string) =>
    JSON.stringify({
      type: "message",
      timestamp: iso,
      message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(iso) },
    });
  let stateDir: string;
  let transcript: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "limit-resume-state-"));
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    // The file name differs from the session id on purpose: transcripts rotate, the entry says where.
    transcript = path.join(sessionsDir, "rotated-file.jsonl");
    fs.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({ [CHAT]: { sessionId: "abc", sessionFile: transcript, updatedAt: 1 } }),
    );
    fs.writeFileSync(
      transcript,
      `${userLine("[Fri 2026-10-09 19:30 GMT+2] Nearly done then?", "2026-10-09T17:31:01Z")}\n`,
    );
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const errorAt = at("2026-10-09T17:37:19Z");

  it("no while his last prompt is the one before the error", async () => {
    await expect(promptedSinceOnDisk(CHAT, errorAt)).resolves.toBe(false);
  });

  it("yes once he typed in that chat after the error", async () => {
    fs.appendFileSync(
      transcript,
      `${userLine("[Fri 2026-10-09 20:52 GMT+2] keep going", "2026-10-09T18:53:00Z")}\n`,
    );
    await expect(promptedSinceOnDisk(CHAT, errorAt)).resolves.toBe(true);
  });

  it("no for a chat the store does not know", async () => {
    await expect(promptedSinceOnDisk("agent:main:tinker:unknown", errorAt)).resolves.toBe(false);
  });
});
