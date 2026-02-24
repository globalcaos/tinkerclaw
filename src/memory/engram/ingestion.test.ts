/**
 * ENGRAM Phase 1.1: Ingestion pipeline unit tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createIngestionPipeline, DEFAULT_ARTIFACT_THRESHOLD_BYTES } from "./ingestion.js";
import { createEventStore, generateULID } from "./event-store.js";
import { createArtifactStore } from "./artifact-store.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "engram-ingestion-test-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function makePipeline(overrides?: { artifactThresholdBytes?: number }) {
	return createIngestionPipeline({
		baseDir: tmpDir,
		sessionKey: "test-session",
		...overrides,
	});
}

// ============================================================
// Event kind correctness
// ============================================================
describe("ingestUserMessage", () => {
	it("creates a user_message event", () => {
		const p = makePipeline();
		const ev = p.ingestUserMessage("Hello there!", 1);
		expect(ev.kind).toBe("user_message");
		expect(ev.content).toBe("Hello there!");
		expect(ev.turnId).toBe(1);
		expect(ev.sessionKey).toBe("test-session");
	});

	it("assigns importance 7", () => {
		const p = makePipeline();
		const ev = p.ingestUserMessage("hi", 1);
		expect(ev.metadata.importance).toBe(7);
	});
});

describe("ingestAssistantMessage", () => {
	it("creates an agent_message event", () => {
		const p = makePipeline();
		const ev = p.ingestAssistantMessage("Sure, here is the answer.", 2);
		expect(ev.kind).toBe("agent_message");
		expect(ev.content).toBe("Sure, here is the answer.");
	});

	it("assigns importance 5", () => {
		const p = makePipeline();
		const ev = p.ingestAssistantMessage("reply", 2);
		expect(ev.metadata.importance).toBe(5);
	});
});

describe("ingestToolCall", () => {
	it("creates a tool_call event with serialised args", () => {
		const p = makePipeline();
		const args = { path: "/tmp/file.txt", limit: 100 };
		const ev = p.ingestToolCall("read_file", args, 3);
		expect(ev.kind).toBe("tool_call");
		const parsed = JSON.parse(ev.content) as { tool: string; args: typeof args };
		expect(parsed.tool).toBe("read_file");
		expect(parsed.args).toEqual(args);
	});

	it("assigns importance 5", () => {
		const p = makePipeline();
		const ev = p.ingestToolCall("exec", {}, 3);
		expect(ev.metadata.importance).toBe(5);
	});
});

describe("ingestToolResult (small output)", () => {
	it("creates a tool_result event for output under threshold", () => {
		const p = makePipeline();
		const output = "file contents here";
		const ev = p.ingestToolResult("read_file", output, 4);
		expect(ev.kind).toBe("tool_result");
		const parsed = JSON.parse(ev.content) as { tool: string; output: string };
		expect(parsed.tool).toBe("read_file");
		expect(parsed.output).toBe(output);
	});

	it("assigns importance 3", () => {
		const p = makePipeline();
		const ev = p.ingestToolResult("list", "a\nb\nc", 4);
		expect(ev.metadata.importance).toBe(3);
	});
});

describe("ingestSystemEvent", () => {
	it("creates a system_event", () => {
		const p = makePipeline();
		const ev = p.ingestSystemEvent("Session started", 0);
		expect(ev.kind).toBe("system_event");
		expect(ev.content).toBe("Session started");
	});

	it("assigns importance 5", () => {
		const p = makePipeline();
		const ev = p.ingestSystemEvent("init", 0);
		expect(ev.metadata.importance).toBe(5);
	});
});

// ============================================================
// Artifact externalization
// ============================================================
describe("large tool result externalization", () => {
	it("creates artifact_reference for output over threshold", () => {
		const p = makePipeline({ artifactThresholdBytes: 100 });
		const largeOutput = "x".repeat(200);
		const ev = p.ingestToolResult("big_tool", largeOutput, 5);
		expect(ev.kind).toBe("artifact_reference");
		expect(ev.metadata.artifactId).toBeTruthy();
	});

	it("artifact_reference content includes tool name and artifactId", () => {
		const p = makePipeline({ artifactThresholdBytes: 50 });
		const output = "y".repeat(200);
		const ev = p.ingestToolResult("search_tool", output, 5);
		const parsed = JSON.parse(ev.content) as {
			tool: string;
			artifactId: string;
			preview: string;
			totalSize: number;
		};
		expect(parsed.tool).toBe("search_tool");
		expect(parsed.artifactId).toBe(ev.metadata.artifactId);
		expect(parsed.totalSize).toBe(200);
	});

	it("full output is retrievable from artifact store", () => {
		const p = makePipeline({ artifactThresholdBytes: 50 });
		const output = "z".repeat(300);
		const ev = p.ingestToolResult("dump_tool", output, 5);
		const artifactId = ev.metadata.artifactId;
		expect(artifactId).toBeTruthy();
		const artifactStore = createArtifactStore({ baseDir: tmpDir });
		const stored = artifactStore.read(artifactId!);
		expect(stored).toBe(output);
	});

	it("assigns importance 3 to artifact_reference", () => {
		const p = makePipeline({ artifactThresholdBytes: 10 });
		const ev = p.ingestToolResult("tool", "x".repeat(100), 5);
		expect(ev.kind).toBe("artifact_reference");
		expect(ev.metadata.importance).toBe(3);
	});

	it("does NOT externalise output exactly at threshold boundary (must exceed)", () => {
		const threshold = DEFAULT_ARTIFACT_THRESHOLD_BYTES;
		const p = makePipeline();
		// Exactly at threshold → NOT externalised
		const ev = p.ingestToolResult("tool", "a".repeat(threshold), 6);
		expect(ev.kind).toBe("tool_result");
		// One byte over → externalised
		const ev2 = p.ingestToolResult("tool", "a".repeat(threshold + 1), 7);
		expect(ev2.kind).toBe("artifact_reference");
	});
});

// ============================================================
// Token counting
// ============================================================
describe("token counting", () => {
	it("estimates tokens proportional to text length", () => {
		const p = makePipeline();
		const shortText = "hi";
		const longText = "a".repeat(400);
		const evShort = p.ingestUserMessage(shortText, 1);
		const evLong = p.ingestUserMessage(longText, 2);
		expect(evLong.tokens).toBeGreaterThan(evShort.tokens);
	});

	it("records non-zero tokens for non-empty content", () => {
		const p = makePipeline();
		const ev = p.ingestUserMessage("Some text here.", 1);
		expect(ev.tokens).toBeGreaterThan(0);
	});

	it("rough token estimate: ~1 token per 4 chars", () => {
		const p = makePipeline();
		// 100 chars → ~25 tokens
		const ev = p.ingestUserMessage("a".repeat(100), 1);
		expect(ev.tokens).toBe(25);
	});
});

// ============================================================
// ULID monotonicity
// ============================================================
describe("ULID ordering", () => {
	it("event IDs are monotonically increasing within a session", () => {
		const p = makePipeline();
		const events = [
			p.ingestUserMessage("first", 1),
			p.ingestAssistantMessage("second", 1),
			p.ingestToolCall("tool", {}, 1),
			p.ingestToolResult("tool", "result", 1),
			p.ingestSystemEvent("meta", 1),
		];
		for (let i = 1; i < events.length; i++) {
			expect(events[i].id > events[i - 1].id).toBe(true);
		}
	});

	it("raw generateULID produces monotonic IDs across 100 calls", () => {
		const ids: string[] = [];
		for (let i = 0; i < 100; i++) {
			ids.push(generateULID());
		}
		for (let i = 1; i < ids.length; i++) {
			expect(ids[i] > ids[i - 1]).toBe(true);
		}
	});
});

// ============================================================
// Bulk ingest (ingest(messages) — Phase 1.1 turn hook)
// ============================================================
describe("ingest(messages)", () => {
	it("ingests user and assistant messages from a snapshot", async () => {
		const p = makePipeline();
		const messages = [
			{ role: "user", content: "Hello from user!" },
			{ role: "assistant", content: [{ type: "text", text: "Hi back!" }] },
		];
		await p.ingest(messages);

		const store = createEventStore({ baseDir: tmpDir, sessionKey: "test-session" });
		const all = store.readAll();
		expect(all).toHaveLength(2);
		expect(all[0].kind).toBe("user_message");
		expect(all[0].content).toBe("Hello from user!");
		expect(all[1].kind).toBe("agent_message");
		expect(all[1].content).toBe("Hi back!");
	});

	it("uses cursor so repeated calls don't duplicate events", async () => {
		const p = makePipeline();
		const snapshot1 = [
			{ role: "user", content: "Turn 1" },
			{ role: "assistant", content: [{ type: "text", text: "Response 1" }] },
		];
		await p.ingest(snapshot1);

		// Simulate a second turn: snapshot grows with 2 new messages.
		const snapshot2 = [
			...snapshot1,
			{ role: "user", content: "Turn 2" },
			{ role: "assistant", content: [{ type: "text", text: "Response 2" }] },
		];
		await p.ingest(snapshot2);

		const store = createEventStore({ baseDir: tmpDir, sessionKey: "test-session" });
		const all = store.readAll();
		// Exactly 4 events, not 6 (no duplicates from snapshot1).
		expect(all).toHaveLength(4);
		expect(all[2].kind).toBe("user_message");
		expect(all[2].content).toBe("Turn 2");
	});

	it("ingests tool calls from assistant messages and tool results", async () => {
		const p = makePipeline();
		const messages = [
			{ role: "user", content: "Run a tool" },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "tc1", name: "read_file", arguments: { path: "/tmp/x" } },
				],
			},
			{ role: "toolResult", toolName: "read_file", content: [{ type: "text", text: "file text" }] },
		];
		await p.ingest(messages);

		const store = createEventStore({ baseDir: tmpDir, sessionKey: "test-session" });
		const all = store.readAll();
		// user_message, tool_call, tool_result
		expect(all).toHaveLength(3);
		expect(all[0].kind).toBe("user_message");
		expect(all[1].kind).toBe("tool_call");
		const toolCallParsed = JSON.parse(all[1].content) as { tool: string };
		expect(toolCallParsed.tool).toBe("read_file");
		expect(all[2].kind).toBe("tool_result");
	});
});

// ============================================================
// Persistence (events survive across store re-open)
// ============================================================
describe("persistence", () => {
	it("ingested events are on disk and readable from a fresh store", () => {
		const p = makePipeline();
		p.ingestUserMessage("persist me", 1);
		p.ingestAssistantMessage("and me", 2);

		const store = createEventStore({ baseDir: tmpDir, sessionKey: "test-session" });
		const all = store.readAll();
		expect(all).toHaveLength(2);
		expect(all[0].kind).toBe("user_message");
		expect(all[1].kind).toBe("agent_message");
	});
});
