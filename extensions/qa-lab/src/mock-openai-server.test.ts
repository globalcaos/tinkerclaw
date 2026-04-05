import { afterEach, describe, expect, it } from "vitest";
import { startQaMockOpenAiServer } from "./mock-openai-server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("qa mock openai server", () => {
  it("serves health and streamed responses", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const health = await fetch(`${server.baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, status: "live" });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Inspect the repo docs and kickoff task." }],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain('"type":"response.output_item.added"');
    expect(body).toContain('"name":"read"');
  });
});
