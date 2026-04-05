import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startQaLabServer } from "./lab-server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("qa-lab server", () => {
  it("serves bootstrap state and writes a self-check report", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "qa-lab-test-"));
    cleanups.push(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });
    const outputPath = path.join(tempDir, "self-check.md");

    const lab = await startQaLabServer({
      host: "127.0.0.1",
      port: 0,
      outputPath,
    });
    cleanups.push(async () => {
      await lab.stop();
    });

    const bootstrapResponse = await fetch(`${lab.baseUrl}/api/bootstrap`);
    expect(bootstrapResponse.status).toBe(200);
    const bootstrap = (await bootstrapResponse.json()) as {
      defaults: { conversationId: string; senderId: string };
    };
    expect(bootstrap.defaults.conversationId).toBe("alice");
    expect(bootstrap.defaults.senderId).toBe("alice");

    const messageResponse = await fetch(`${lab.baseUrl}/api/inbound/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        conversation: { id: "bob", kind: "direct" },
        senderId: "bob",
        senderName: "Bob",
        text: "hello from test",
      }),
    });
    expect(messageResponse.status).toBe(200);

    const stateResponse = await fetch(`${lab.baseUrl}/api/state`);
    expect(stateResponse.status).toBe(200);
    const snapshot = (await stateResponse.json()) as {
      messages: Array<{ direction: string; text: string }>;
    };
    expect(snapshot.messages.some((message) => message.text === "hello from test")).toBe(true);

    const result = await lab.runSelfCheck();
    expect(result.scenarioResult.status).toBe("pass");
    const markdown = await readFile(outputPath, "utf8");
    expect(markdown).toContain("Synthetic Slack-class roundtrip");
    expect(markdown).toContain("- Status: pass");
  });
});
