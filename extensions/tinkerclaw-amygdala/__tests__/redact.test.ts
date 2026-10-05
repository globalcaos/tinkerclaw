import { describe, expect, it } from "vitest";
import { redactForSend, redactText, SendBlocked } from "../src/redact.js";
import { buildSituation } from "../src/situation.js";
import type { Question, SituationFieldName } from "../src/types.js";

function stubQuestion(id: string, fields: SituationFieldName[]): Question {
  return {
    id,
    version: 1,
    family: "safety",
    seams: ["pre-tool"],
    type: "noul",
    criteria: [],
    instructions: "test-question",
    fields,
    cutoff: { kind: "prob", at: 0.5 },
    purpose: "p",
    origin: "o",
    retirement: "r",
    mustCatch: [],
    status: "active",
    name: id,
  };
}

describe("redactText tokens", () => {
  const o = {};
  it.each([
    ["key AKIAIOSFODNN7EXAMPLE end", "key [secret] end"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "[secret]"],
    ["gho_abcdefghijklmnopqrstuvwxyz0123456789", "[secret]"],
    ["ghs_abcdefghijklmnopqrstuvwxyz0123456789", "[secret]"],
    ["tok xoxb-1234567890-abcdefghij here", "tok [secret] here"],
    ["k=sk-abcdefghijklmnop1234567890", "k=[secret]"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc_DEF-123 x", "jwt [secret] x"],
    ["Authorization: Bearer abcdefgh12345678", "Authorization: [secret]"],
    ["-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----", "[secret]"],
  ])("%s", (input, expected) => {
    expect(redactText(input, o)).toBe(expected);
  });

  it("strips URL query strings and userinfo", () => {
    expect(redactText("see https://user:pw@example.com/a/b?token=1&x=2 ok", {})).toBe(
      "see https://example.com/a/b?[redacted] ok",
    );
    expect(redactText("https://example.com/plain", {})).toBe("https://example.com/plain");
  });

  it("replaces the home directory prefix with ~", () => {
    expect(redactText("rm /home/u/x/y and /home/u", { homeDir: "/home/u" })).toBe("rm ~/x/y and ~");
    expect(redactText("/home/user2/x", { homeDir: "/home/u" })).toBe("/home/user2/x");
  });

  it("numbers addresses, phones and contacts stably within one call", () => {
    const labels = new Map<string, string>();
    const out = redactText(
      "mail a@x.com then b@y.org then a@x.com; call +34 612 345 678 or 934567890 or +34 612 345 678; Sophie met bob and SOPHIE",
      { contactNames: ["Sophie", "Bob"] },
      labels,
    );
    expect(out).toBe(
      "mail Address 1 then Address 2 then Address 1; call Phone 1 or Phone 2 or Phone 1; Person 1 met Person 2 and Person 1",
    );
  });

  it("matches contact names as whole words only", () => {
    expect(redactText("Sophieland and Sophie", { contactNames: ["Sophie"] })).toBe(
      "Sophieland and Person 1",
    );
  });
});

describe("redactForSend", () => {
  const home = "/home/u";
  const ctx = { workspaceRoot: "/w", homeDir: home };
  const real = buildSituation(
    {
      seam: "pre-tool",
      sessionKey: "s",
      turnId: "t",
      now: 1,
      tool: "Write",
      toolInput: { file_path: "/home/u/a.txt", content: "line1\nline2\nsecret" },
      reply: "x".repeat(500),
    },
    { ...ctx, request: "email bob@example.com" },
  );

  it("throws SendBlocked for a real situation without allowReal", () => {
    expect(() => redactForSend(real, [stubQuestion("a", ["tool"])], { allowReal: false })).toThrow(
      SendBlocked,
    );
    try {
      redactForSend(real, [stubQuestion("a", ["tool"])], { allowReal: false });
    } catch (e) {
      expect((e as Error).name).toBe("SendBlocked");
    }
  });

  it("lets a real situation through with allowReal and a synthetic one always", () => {
    expect(() =>
      redactForSend(real, [stubQuestion("a", ["tool"])], { allowReal: true }),
    ).not.toThrow();
    const syn = { ...real, originKind: "synthetic" as const };
    expect(() =>
      redactForSend(syn, [stubQuestion("a", ["tool"])], { allowReal: false }),
    ).not.toThrow();
  });

  it("returns only the fields the questions read, plain values, missing omitted", () => {
    const state = redactForSend(
      real,
      [stubQuestion("a", ["tool", "request"]), stubQuestion("b", ["tool", "claims"])],
      { allowReal: true, homeDir: home },
    );
    expect(Object.keys(state).toSorted()).toEqual(["request", "tool"]);
    expect(state.tool).toBe("Write");
    expect(state.request).toBe("email Address 1");
  });

  it("reduces content args and long strings, redacts home in args", () => {
    const state = redactForSend(real, [stubQuestion("a", ["args", "reply"])], {
      allowReal: true,
      homeDir: home,
    });
    expect(state.args).toEqual({
      file_path: "~/a.txt",
      content: { redacted: "content", bytes: 18, lines: 3 },
    });
    expect(state.reply).toBe(`${"x".repeat(300)} […100 chars…] ${"x".repeat(100)}`);
  });

  it("a long reply or request goes as a redacted head+tail excerpt, so a refusal can be judged (2026-09-30)", () => {
    const refusal = `**Jarvis:** *No. I won't build that.* ${"filler ".repeat(120)}The end.`;
    const s = buildSituation(
      { seam: "stop", sessionKey: "s", turnId: "t", now: 1, reply: refusal },
      { ...ctx, request: `please ${"do it ".repeat(100)}now` },
    );
    const state = redactForSend(s, [stubQuestion("r", ["reply", "request"])], { allowReal: true });
    expect(typeof state.reply).toBe("string");
    expect(state.reply as string).toContain("I won't build that.");
    expect(state.reply as string).toContain("The end.");
    expect((state.reply as string).length).toBeLessThan(450);
    expect(state.request as string).toMatch(/^please do it/);
  });

  it("redacts the whole text before cutting: a key across the cut does not leak a fragment", () => {
    const key = "sk-" + "A".repeat(40);
    const reply = `${"a ".repeat(145)}${key} ${"b".repeat(300)}`;
    const s = buildSituation({ seam: "stop", sessionKey: "s", turnId: "t", now: 1, reply }, ctx);
    const state = redactForSend(s, [stubQuestion("r", ["reply"])], { allowReal: true });
    expect(state.reply as string).not.toContain("sk-A");
    expect(state.reply as string).toContain("[secret]");
  });

  it("keeps long commands verbatim (still redacted)", () => {
    const cmd = `echo ${"a".repeat(450)} AKIAIOSFODNN7EXAMPLE`;
    const s = buildSituation(
      {
        seam: "pre-tool",
        sessionKey: "s",
        turnId: "t",
        now: 1,
        tool: "Bash",
        toolInput: { command: cmd },
      },
      ctx,
    );
    const state = redactForSend(s, [stubQuestion("a", ["command"])], { allowReal: true });
    expect(typeof state.command).toBe("string");
    expect(state.command as string).toContain("[secret]");
  });

  it("uses one label map across fields", () => {
    const s = buildSituation(
      { seam: "stop", sessionKey: "s", turnId: "t", now: 1, reply: "write to a@x.com" },
      { ...ctx, request: "a@x.com and b@y.com" },
    );
    const state = redactForSend(s, [stubQuestion("a", ["request", "reply"])], {
      allowReal: true,
    });
    expect(state.request).toBe("Address 1 and Address 2");
    expect(state.reply).toBe("write to Address 1");
  });
});
