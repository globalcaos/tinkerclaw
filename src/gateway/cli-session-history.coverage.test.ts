import { describe, it, expect } from "vitest";
import { dropImportCoveredLocalAssistants } from "./cli-session-history.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";

// FORK 2026-06-25 (Mechanism A): dropImportCoveredLocalAssistants must let the cc-bridge import's
// native per-step assistant segments win a covered turn (drop the local coalesced blob) WITHOUT ever
// losing user prompts or an uncovered local assistant.
const T = 1_000_000_000_000;
const userMsg = (text: string, ts: number) => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: ts,
});
const asstText = (text: string, ts: number) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp: ts,
});
const asstToolOnly = (ts: number) => ({
  role: "assistant",
  content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
  timestamp: ts,
});

describe("dropImportCoveredLocalAssistants", () => {
  it("drops a local coalesced assistant blob covered by an import assistant (same slot)", () => {
    const local = [userMsg("q", T), asstText("long coalesced blob", T + 1000)];
    const out = dropImportCoveredLocalAssistants(local, [T + 2000]); // within 5min
    expect(out).toEqual([local[0]]); // user kept, assistant blob dropped
  });

  it("keeps a local assistant the import does NOT cover (outside the 5-min slot)", () => {
    const local = [userMsg("q", T), asstText("uncovered answer", T)];
    const out = dropImportCoveredLocalAssistants(local, [T + 10 * 60 * 1000]); // 10 min away
    expect(out).toEqual(local); // nothing dropped
  });

  it("never drops user messages even when timestamps coincide", () => {
    const local = [userMsg("prompt", T), asstText("blob", T)];
    const out = dropImportCoveredLocalAssistants(local, [T]);
    expect(out).toEqual([local[0]]); // user survives, assistant dropped
  });

  it("keeps a local assistant with no resolvable timestamp", () => {
    const local = [{ role: "assistant", content: [{ type: "text", text: "no ts blob" }] }];
    const out = dropImportCoveredLocalAssistants(local, [T]);
    expect(out).toEqual(local);
  });

  it("keeps tool-only / non-text assistant messages", () => {
    const local = [asstToolOnly(T)];
    const out = dropImportCoveredLocalAssistants(local, [T]);
    expect(out).toEqual(local);
  });

  it("is a no-op when there are no import assistant timestamps", () => {
    const local = [userMsg("q", T), asstText("blob", T)];
    expect(dropImportCoveredLocalAssistants(local, [])).toBe(local);
  });

  it("handles ISO-string timestamps on local messages", () => {
    const iso = new Date(T).toISOString();
    const local = [
      { role: "assistant", content: [{ type: "text", text: "blob" }], timestamp: iso },
    ];
    const out = dropImportCoveredLocalAssistants(local, [T + 1000]);
    expect(out).toEqual([]); // covered → dropped
  });
});

// FORK 2026-08-23 (B043 — "I saw an answer yesterday and this morning it was gone"):
// an EMPTY local assistant placeholder (a turn that died before producing text) must not
// suppress the import's real answer for that slot.
//
// The two coverage filters are symmetric and run in sequence on the same data:
//   A. dropImportCoveredLocalAssistants — drops LOCAL assistants covered by an IMPORT timestamp.
//      It already ignores no-text messages, so an empty placeholder SURVIVES it.
//   B. mergeImportedChatHistoryMessages layer 2 — drops IMPORT assistants covered by a LOCAL
//      assistant timestamp. It did NOT check for text, so the placeholder that survived A then
//      covered the import's real answer in B.
// Net effect: the local copy is deleted by A, the imported copy is deleted by B, and the turn
// renders as an empty bubble. Observed live on session c4786af3 (Sat 2026-08-22 22:27, 9,526 chars).
describe("B043 — empty local assistant must not suppress the imported answer", () => {
  const asstEmpty = (ts: number) => ({ role: "assistant", content: [], timestamp: ts });

  it("keeps the imported answer when the only local assistant in that slot is empty", () => {
    const local = [userMsg("why is it broken?", T), asstEmpty(T + 1000)];
    const imported = [userMsg("why is it broken?", T), asstText("the real answer", T + 2000)];
    const merged = mergeImportedChatHistoryMessages({
      localMessages: local,
      importedMessages: imported,
    });
    const texts = merged.map((m) => JSON.stringify(m)).join("\n");
    expect(texts).toContain("the real answer");
  });

  it("still suppresses the imported copy when the local assistant HAS the text", () => {
    const local = [userMsg("q", T), asstText("already rendered locally", T + 1000)];
    const imported = [asstText("already rendered locally", T + 2000)];
    const merged = mergeImportedChatHistoryMessages({
      localMessages: local,
      importedMessages: imported,
    });
    const assistants = merged.filter((m) => (m as { role?: string }).role === "assistant");
    expect(assistants).toHaveLength(1);
  });
});
