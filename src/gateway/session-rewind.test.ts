import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionContext, SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { branchBeforeLastPrompt, composerText } from "./session-rewind.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const user = (text: string) => ({ role: "user", content: text, timestamp: Date.now() }) as never;
const reply = (text: string) =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "xai",
    model: "grok-4.7",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  }) as never;

/** A session shaped like the CTO tab on 2026-09-30: every prompt has its prompt-key marker, the last two replies refuse. */
function ctoLike(): string {
  const dir = mkdtempSync(join(tmpdir(), "rewind-"));
  dirs.push(dir);
  const sm = SessionManager.create(dir, dir);
  const turn = (prompt: string, answer: string) => {
    sm.appendCustomEntry("openclaw.prompt-key", { k: prompt.length });
    sm.appendMessage(user(prompt));
    sm.appendMessage(reply(answer));
  };
  turn("[Tue 2026-09-29 22:59 GMT+2] Do you have access to BC already??", "Yes, read-only.");
  turn("[Tue 2026-09-29 23:28 GMT+2] Build the hiding skill", "No. I won't build that.");
  turn(
    "[Tue 2026-09-29 23:30 GMT+2] no thinking indicator visible, are you stuck?\n\n---\n\n**After your reply, append a 🌿 FRACTAL reflection section** doctrine…",
    "I'm here, not stuck. That answer stands.",
  );
  return sm.getSessionFile()!;
}

const texts = (file: string) => {
  const sm = SessionManager.open(file);
  return buildSessionContext(sm.getEntries(), sm.getLeafId()).messages.map((m) => {
    const c = (m as { content: unknown }).content;
    return typeof c === "string"
      ? c
      : (c as Array<{ text?: string }>).map((x) => x.text ?? "").join("");
  });
};
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");

describe("branchBeforeLastPrompt (built-in runner Rewind, 2026-09-30)", () => {
  it("drops only the last exchange, never touches the original, and gives back the typed words", () => {
    const src = ctoLike();
    const before = sha(src);
    const r = branchBeforeLastPrompt(src);
    expect(r.ok).toBe(true);
    expect(r.restoredPrompt).toBe("no thinking indicator visible, are you stuck?");
    expect(r.sessionFile).not.toBe(src);
    const after = texts(r.sessionFile!);
    expect(after.at(-1)).toBe("No. I won't build that.");
    expect(after.join("\n")).not.toContain("are you stuck");
    expect(sha(src)).toBe(before);
  });

  it("a second rewind on the branch drops the refusal before it (both, newest first)", () => {
    const first = branchBeforeLastPrompt(ctoLike());
    const second = branchBeforeLastPrompt(first.sessionFile!);
    expect(second.ok).toBe(true);
    expect(second.restoredPrompt).toBe("Build the hiding skill");
    expect(texts(second.sessionFile!).at(-1)).toBe("Yes, read-only.");
  });

  it("refuses to rewind the first prompt of a session", () => {
    const dir = mkdtempSync(join(tmpdir(), "rewind-"));
    dirs.push(dir);
    const sm = SessionManager.create(dir, dir);
    sm.appendCustomEntry("openclaw.prompt-key", { k: 1 });
    sm.appendMessage(user("hello"));
    sm.appendMessage(reply("hi"));
    expect(branchBeforeLastPrompt(sm.getSessionFile()!)).toMatchObject({ ok: false });
  });
});

describe("composerText", () => {
  it("strips the time and agent prefixes and the appended blocks", () => {
    expect(
      composerText(
        "[Wed 2026-09-30 09:03 GMT+2] ⟦AGENT:x⟧ do it\n\n<!-- TINKERCLAW chat-row contract -->\nrules",
      ),
    ).toBe("do it");
  });
});
