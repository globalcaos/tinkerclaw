import { describe, it, expect } from "vitest";
import { dropImportCoveredLocalAssistants } from "./cli-session-history.js";

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
