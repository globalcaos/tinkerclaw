import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  callUsage,
  claudeProjectSlug,
  derive,
} from "../crons/memory-consolidation/memory-breakeven.mjs";
import {
  collectOwnerPrompts,
  labelOffsetMinutes,
  ownerWords,
  stampInstant,
} from "../crons/wind-down/owner-prompts.mjs";

const CRONS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "crons");

type Job = { id: string; schedule: { kind: string; expr: string; tz?: string } };

function bundle(): Job[] {
  return readdirSync(CRONS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => JSON.parse(readFileSync(join(CRONS, e.name, "job.json"), "utf8")) as Job);
}

function minuteOfDay(expr: string): number {
  const [minute, hour] = expr.split(/\s+/);
  return Number(hour) * 60 + Number(minute);
}

describe("bundled cron jobs", () => {
  it("every job folder holds a job.json named after it and a routine", () => {
    for (const e of readdirSync(CRONS, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const job = JSON.parse(readFileSync(join(CRONS, e.name, "job.json"), "utf8")) as Job;
      expect(job.id).toBe(e.name);
      expect(existsSync(join(CRONS, e.name, "routine.md"))).toBe(true);
    }
  });

  it("schedules wind-down before memory-consolidation, which reads its reflection", () => {
    const jobs = new Map(bundle().map((j) => [j.id, j]));
    const wind = jobs.get("wind-down");
    const consolidation = jobs.get("memory-consolidation");
    expect(wind?.schedule.tz).toBe(consolidation?.schedule.tz);
    expect(minuteOfDay(wind!.schedule.expr)).toBeLessThan(
      minuteOfDay(consolidation!.schedule.expr),
    );
  });

  it("every helper a routine calls by $CRONS path ships in the bundle", () => {
    for (const job of bundle()) {
      const routine = readFileSync(join(CRONS, job.id, "routine.md"), "utf8");
      for (const m of routine.matchAll(/\$CRONS\/([\w./-]+\.(?:mjs|json))/g)) {
        expect(existsSync(join(CRONS, m[1])), `${job.id} names ${m[1]}`).toBe(true);
      }
    }
  });
});

describe("owner-prompts", () => {
  const stamp = "[Tue 2026-10-27 21:04 GMT+1]";

  it("keeps the owner's words between the bridge context and the appended blocks", () => {
    const text = `<turn_context>chat state</turn_context>\n${stamp} why did the build fail?\n\n<!-- TINKERCLAW chat-row contract -->\nrules`;
    expect(ownerWords(text)).toEqual({
      day: "2026-10-27",
      hm: "21:04",
      label: "GMT+1",
      text: "why did the build fail?",
    });
  });

  it("cuts the reflection doctrine appended after the words", () => {
    const text = `${stamp} rename the tab\n\n---\n\n⟦FRACTAL-DOCTRINE⟧\nreflect after`;
    expect(ownerWords(text)?.text).toBe("rename the tab");
  });

  it.each([
    "⟦AGENT:Fan-out · prompt 2⟧ do the thing",
    "⟦AGENT⟧ Parent took over",
    "[System] The gateway restarted",
    "[Subagent Context] You are a subagent",
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> payload",
    "<task-notification>done</task-notification>",
  ])("drops a turn no person wrote: %s", (body) => {
    expect(ownerWords(`${stamp} ${body}`)).toBeNull();
  });

  it("drops a worker's own background turn and an unstamped prompt", () => {
    expect(ownerWords(`${stamp} [bg-turn bgt-abc-1] carry on`)).toBeNull();
    expect(ownerWords("a terminal prompt with no stamp")).toBeNull();
  });

  it("reads offsets and resolves an abbreviation in the owner's zone", () => {
    expect(labelOffsetMinutes("GMT+2")).toBe(120);
    expect(labelOffsetMinutes("UTC")).toBe(0);
    expect(labelOffsetMinutes("GMT-5:30")).toBe(-330);
    expect(labelOffsetMinutes("PDT")).toBeUndefined();
    const at = stampInstant("2026-10-27", "21:04", "PDT", "America/Los_Angeles");
    expect(at.offset).toBe(-420);
    expect(new Date(at.epochMs).toISOString()).toBe("2026-10-28T04:04:00.000Z");
  });

  describe("collectOwnerPrompts", () => {
    let dir: string;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("keeps each prompt once, inside the window, oldest first", async () => {
      dir = mkdtempSync(join(tmpdir(), "owner-prompts-"));
      const line = (text: string) =>
        JSON.stringify({ message: { role: "user", content: [{ type: "text", text }] } });
      const original = [
        line("[Tue 2026-10-27 22:10 GMT+1] second"),
        line("[Tue 2026-10-27 09:00 GMT+1] first"),
        line("[Mon 2026-10-26 09:00 GMT+1] before the window"),
        JSON.stringify({
          message: { role: "assistant", content: "[Tue 2026-10-27 10:00 GMT+1] not a user" },
        }),
      ];
      writeFileSync(join(dir, "chat-a.jsonl"), `${original.join("\n")}\n`);
      // A resumed chat copies the history into a new file.
      writeFileSync(join(dir, "chat-b.jsonl"), `${original.slice(0, 2).join("\n")}\n`);
      const prompts = await collectOwnerPrompts({
        dirs: [dir],
        sinceMs: Date.parse("2026-10-27T00:00:00+01:00"),
        untilMs: Date.parse("2026-10-28T00:00:00+01:00"),
        timeZone: "UTC",
      });
      expect(prompts.map((p) => [p.when, p.text])).toEqual([
        ["2026-10-27T09:00+01:00", "first"],
        ["2026-10-27T22:10+01:00", "second"],
      ]);
    });

    it("skips a file not written since before the window", async () => {
      dir = mkdtempSync(join(tmpdir(), "owner-prompts-"));
      const file = join(dir, "old.jsonl");
      writeFileSync(
        file,
        `${JSON.stringify({ message: { role: "user", content: "[Tue 2026-10-27 09:00 GMT+1] hi" } })}\n`,
      );
      const old = new Date("2026-10-01T00:00:00Z");
      utimesSync(file, old, old);
      const prompts = await collectOwnerPrompts({
        dirs: [dir],
        sinceMs: Date.parse("2026-10-27T00:00:00Z"),
        untilMs: Date.parse("2026-10-28T00:00:00Z"),
        timeZone: "UTC",
      });
      expect(prompts).toEqual([]);
    });
  });
});

describe("memory-breakeven", () => {
  it("names Claude Code project folders the way Claude Code does", () => {
    expect(claudeProjectSlug("/srv/agent/.openclaw")).toBe("-srv-agent--openclaw");
  });

  it("reads one call per record from both transcript shapes", () => {
    const cc = {
      message: {
        role: "assistant",
        model: "claude-opus-5-5",
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 1000,
          output_tokens: 50,
          cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 },
        },
      },
    };
    expect(callUsage(cc, "claude-code")).toEqual([10, 100, 1000, 50, 100, 0, "claude-opus-5-5"]);
    const gw = {
      message: {
        role: "assistant",
        provider: "xai",
        model: "grok",
        usage: { input: 20, cacheWrite: 5, cacheRead: 200, output: 7 },
      },
    };
    expect(callUsage(gw, "gateway")).toEqual([20, 5, 200, 7, 0, 5, "xai/grok"]);
    // The gateway's copy of a claude-code turn sums many calls already counted per call.
    expect(
      callUsage({ message: { ...gw.message, provider: "claude-code" } }, "gateway"),
    ).toBeNull();
    expect(
      callUsage({ message: { ...cc.message, model: "<synthetic>" } }, "claude-code"),
    ).toBeNull();
  });

  it("derives the hop cost and the carry limits from the formula", () => {
    // Every call: 100,000 tokens of context, all cache reads; 1,000 output; 4 calls per session.
    const calls = Array.from({ length: 8 }, () => [0, 0, 100_000, 1000, 0, 0]);
    const prices = { r_cache_read: 0.05, w_cache_write_5m: 1.25, w_cache_write_1h: 2, g_output: 5 };
    const res = derive({ calls, perSession: [4, 4], prices });
    // H = C * r_mix + o * g = 100,000 * 0.05 + 1,000 * 5
    expect(res.derived.hop_cost_H_in_input_tokens).toBe(10_000);
    // No cache writes seen: priced as the 1-hour lifetime (w = 2), as when 1h writes dominate.
    expect(res.measured.cache_ttl).toBe("1h");
    // Carry wins at any size above P = rR / (w + rR/2) = 0.2 / 2.1
    expect(res.derived.need_share_above_which_carry_wins_at_any_size).toBeCloseTo(0.095, 3);
    expect(res.derived.max_always_loaded_tokens_by_need_share["0.1"]).toBeNull();
    // s*(0.05) = 0.05 * 10,000 / (0.2 - 0.05 * 2.1)
    expect(res.derived.max_always_loaded_tokens_by_need_share["0.05"]).toBe(5263);
    // An index line of 30 tokens pays when needed in 1 of H / (30 * r * R) sessions
    expect(res.derived.index_line_pays_if_target_needed_in_one_of_N_sessions).toBe(1667);
  });
});

describe("price ratios shipped with the bundle", () => {
  it("has every ratio the script reads", () => {
    const p = JSON.parse(
      readFileSync(join(CRONS, "memory-consolidation", "price-ratios.json"), "utf8"),
    );
    for (const k of ["r_cache_read", "w_cache_write_5m", "w_cache_write_1h", "g_output"]) {
      expect(typeof p[k]).toBe("number");
    }
  });
});
