import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUsageRegistry } from "../fork/usage-attribution.js";
import { liveFinalMessage, usageMarksForToolStart } from "./server-chat.js";

const tmpDirs: string[] = [];

function skillFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "server-chat-usage-"));
  tmpDirs.push(root);
  const dir = path.join(root, "skills", "human-voice");
  fs.mkdirSync(dir, { recursive: true });
  const skillMd = path.join(dir, "SKILL.md");
  fs.writeFileSync(skillMd, "---\nname: human-voice\n---\n# human-voice\n");
  const registry = createUsageRegistry({
    skillRoots: [path.join(root, "skills")],
    recipeRoots: [],
  });
  return { skillMd, registry };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("usageMarksForToolStart (live usage for both runners)", () => {
  it("attributes a cc-bridge Bash read of a SKILL.md", () => {
    const { skillMd, registry } = skillFixture();
    const marks = usageMarksForToolStart(
      {
        phase: "start",
        name: "Bash",
        toolCallId: "toolu_1",
        args: { command: `sed -n 1,80p ${skillMd}` },
      },
      registry,
    );
    expect(marks).toEqual([
      expect.objectContaining({ kind: "skill", name: "human-voice", path: skillMd }),
    ]);
  });

  it("attributes an embedded read of a SKILL.md", () => {
    const { skillMd, registry } = skillFixture();
    const marks = usageMarksForToolStart(
      { phase: "start", name: "read", toolCallId: "call_1", args: { path: skillMd } },
      registry,
    );
    expect(marks?.[0]).toMatchObject({ kind: "skill", name: "human-voice" });
  });

  it("returns undefined for non-start phases, unknown tools, existing usage and garbage", () => {
    const { skillMd, registry } = skillFixture();
    expect(
      usageMarksForToolStart({ phase: "result", name: "read", args: { path: skillMd } }, registry),
    ).toBeUndefined();
    expect(
      usageMarksForToolStart(
        { phase: "start", name: "web_search", args: { query: "x" } },
        registry,
      ),
    ).toBeUndefined();
    expect(
      usageMarksForToolStart(
        {
          phase: "start",
          name: "read",
          args: { path: skillMd },
          usage: [{ kind: "skill", name: "already", via: "read" }],
        },
        registry,
      ),
    ).toBeUndefined();
    expect(usageMarksForToolStart(null, registry)).toBeUndefined();
    expect(usageMarksForToolStart(42, registry)).toBeUndefined();
    expect(usageMarksForToolStart({ phase: "start" }, registry)).toBeUndefined();
  });
});

describe("liveFinalMessage (typed outcome on the live final)", () => {
  it("leaves a normal answer untyped", () => {
    const msg = liveFinalMessage("Here is the answer you asked for.", "stop");
    expect(msg.outcome).toBeUndefined();
    expect(msg.content).toEqual([{ type: "text", text: "Here is the answer you asked for." }]);
  });

  it("types a cc-bridge error envelope delivered as final text", () => {
    const env = {
      kind: "error",
      id: "err_1",
      fatal: false,
      category: "rate_limit",
      headline: "Rate limited",
      icon: "⏳",
    };
    const msg = liveFinalMessage(`__ERR_ENV__:${JSON.stringify(env)}`, "stop");
    expect(msg.outcome).toMatchObject({ kind: "rate_limit", recoverable: true });
  });

  it("types gateway failure wording delivered as final text", () => {
    const msg = liveFinalMessage(
      "⚠️ All models are temporarily rate-limited. Try again shortly.",
      "stop",
    );
    expect(msg.outcome).toMatchObject({ kind: "rate_limit" });
  });

  it("never types a live abort (the UI already shows its own Stopped notice)", () => {
    expect(liveFinalMessage("partial", "aborted").outcome).toBeUndefined();
  });
});
