import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MORAL_CODE_CLOSE,
  MORAL_CODE_MARKER,
  moralCodePackPath,
  readPublishedMoralCode,
  retirePublishedMoralCode,
  shouldRetirePublishedMoralCode,
  transcriptHasMoralCode,
} from "./contract.js";

describe("moral code published contract", () => {
  it("withdraws the pack only when the owning plugin is known and not loaded", () => {
    expect(
      shouldRetirePublishedMoralCode([{ id: "tinkerclaw-moral-code", status: "loaded" }]),
    ).toBe(false);
    expect(
      shouldRetirePublishedMoralCode([{ id: "tinkerclaw-moral-code", status: "disabled" }]),
    ).toBe(true);
    expect(shouldRetirePublishedMoralCode([{ id: "tinkerclaw-moral-code", status: "error" }])).toBe(
      true,
    );
    // Not listed at all (e.g. loaded later): leave the file alone.
    expect(shouldRetirePublishedMoralCode([{ id: "other", status: "loaded" }])).toBe(false);
  });

  it("publishes, reads and retires one file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moral-contract-"));
    expect(readPublishedMoralCode(dir)).toBe("");
    fs.mkdirSync(path.dirname(moralCodePackPath(dir)), { recursive: true });
    fs.writeFileSync(moralCodePackPath(dir), `${MORAL_CODE_MARKER}\nX\n`);
    expect(readPublishedMoralCode(dir)).toBe(`${MORAL_CODE_MARKER}\nX`);
    expect(retirePublishedMoralCode(dir)).toBe(true);
    expect(readPublishedMoralCode(dir)).toBe("");
    expect(retirePublishedMoralCode(dir)).toBe(false);
  });

  // FORK 2026-10-02 — until then any line holding the opening marker counted, so a pack the CLI had
  // cut to a preview (and the unsent hook stdout holding the whole of it) passed as delivered.
  it("counts only a COMPLETE pack in what the CLI sends; unreadable counts as delivered", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moral-contract-"));
    const pack = `${MORAL_CODE_MARKER}\nX\n${MORAL_CODE_CLOSE}`;
    const write = (name: string, lines: unknown[]): string => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
      return p;
    };
    const userText = (text: string) => ({ type: "user", message: { role: "user", content: text } });
    // The resume fallback's delivery: the whole pack prefixed to a user message.
    expect(transcriptHasMoralCode(write("prefixed.jsonl", [userText(`${pack}\n\nhello`)]))).toBe(
      true,
    );
    // A tool result that shows the pack (the model read the file) is in context too.
    expect(
      transcriptHasMoralCode(
        write("read.jsonl", [
          {
            type: "user",
            message: {
              role: "user",
              content: [{ type: "tool_result", content: [{ type: "text", text: pack }] }],
            },
          },
        ]),
      ),
    ).toBe(true);
    // The opening tag alone, anywhere: not a delivery.
    expect(transcriptHasMoralCode(write("open-only.jsonl", [{ x: MORAL_CODE_MARKER }]))).toBe(
      false,
    );
    expect(transcriptHasMoralCode(write("without.jsonl", [{ x: "hello" }]))).toBe(false);
    // A pack before the last compaction is no longer in the model's context.
    expect(
      transcriptHasMoralCode(
        write("compacted.jsonl", [
          userText(pack),
          { type: "system", subtype: "compact_boundary" },
          userText("after the summary"),
        ]),
      ),
    ).toBe(false);
    // A sidechain (a subagent's own transcript lines) is not this conversation's context.
    expect(
      transcriptHasMoralCode(write("sidechain.jsonl", [{ ...userText(pack), isSidechain: true }])),
    ).toBe(false);
    expect(transcriptHasMoralCode(path.join(dir, "missing.jsonl"))).toBe(true);
  });
});
