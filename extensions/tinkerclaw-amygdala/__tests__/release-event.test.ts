/**
 * An evidence release must reach the chat like a click does. The store closed the intervention but no
 * `amygdala2.intervention` event went out, so the Allow card stayed up under a step that had already run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import type { Family } from "../src/families/types.js";
import { createHttpHandlers } from "../src/http.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

const EXT = fileURLToPath(new URL("..", import.meta.url));
const TOKEN = "b".repeat(64);

const servers: http.Server[] = [];
const runtimes: Runtime[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const r of runtimes.splice(0)) r.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let phase: "hold" | "release" = "hold";
const fam: Family = {
  id: "safety",
  questionsFor: () => [],
  decide: () =>
    phase === "hold"
      ? {
          response: {
            kind: "proof",
            templateId: "proof-required",
            slots: { what: "w", needs: "n" },
            needs: ["user-request"],
          },
          drivers: [],
          reasonCode: "table-d3-low",
        }
      : {
          response: { kind: "proceed" },
          drivers: ["evidence-present"],
          reasonCode: "evidence-released",
        },
};

async function decideOver(port: number, body: string): Promise<{ hook: { kind: string } }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/plugins/amygdala2/decide",
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(JSON.parse(data)));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("evidence release reaches the chat", () => {
  it("emits a released intervention event for the card the hold opened", async () => {
    const root = mkdtempSync(join(tmpdir(), "amy-release-ev-"));
    dirs.push(root);
    const events: Array<{ event: string; payload: { id?: string; state?: string } }> = [];
    const rt = createRuntime({
      config: parseConfig({ mode: "enforce", dataDir: join(root, "data") }),
      extensionRoot: EXT,
      gatewayPort: 1,
      v31: { readPluginConfig: () => undefined, settingsPath: join(root, "none.json") },
      apiKey: () => undefined,
      emit: (event: string, payload: unknown) =>
        events.push({ event, payload: payload as { id?: string; state?: string } }),
      logger: { info() {}, warn() {}, error() {} },
      families: [fam],
    });
    runtimes.push(rt);
    rt.start();
    const h = createHttpHandlers(rt, () => TOKEN);
    const server = http.createServer((req, res) => void h.decide(req, res));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const body = JSON.stringify({
      seam: "pre-tool",
      hook: {
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: "echo demo-send" },
        cwd: "/tmp",
      },
    });

    phase = "hold";
    await decideOver(port, body);
    const opened = rt.feed().interventions.find((i) => i.state === "open");
    expect(opened).toBeDefined();

    phase = "release";
    events.length = 0;
    await decideOver(port, body);
    expect(rt.feed().interventions.find((i) => i.id === opened!.id)?.state).toBe("released");
    const closing = events.filter(
      (e) => e.event === "amygdala2.intervention" && e.payload.id === opened!.id,
    );
    expect(closing.map((e) => e.payload.state)).toContain("released");
  });
});
