import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runQaDockerUp } from "./docker-up.runtime.js";

describe("runQaDockerUp", () => {
  it("builds the QA UI, writes the harness, starts compose, and waits for health", async () => {
    const calls: string[] = [];
    const fetchCalls: string[] = [];
    const responseQueue = [false, true, false, true];
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "qa-docker-up-"));

    try {
      const result = await runQaDockerUp(
        {
          repoRoot: "/repo/openclaw",
          outputDir,
          gatewayPort: 18889,
          qaLabPort: 43124,
        },
        {
          async runCommand(command, args, cwd) {
            calls.push([command, ...args, `@${cwd}`].join(" "));
            return { stdout: "", stderr: "" };
          },
          fetchImpl: vi.fn(async (input: string) => {
            fetchCalls.push(input);
            return { ok: responseQueue.shift() ?? true };
          }),
          sleepImpl: vi.fn(async () => {}),
        },
      );

      expect(calls).toEqual([
        "pnpm qa:lab:build @/repo/openclaw",
        expect.stringContaining(
          `docker compose -f ${outputDir}/docker-compose.qa.yml up --build -d @/repo/openclaw`,
        ),
      ]);
      expect(fetchCalls).toEqual([
        "http://127.0.0.1:43124/healthz",
        "http://127.0.0.1:43124/healthz",
        "http://127.0.0.1:18889/healthz",
        "http://127.0.0.1:18889/healthz",
      ]);
      expect(result.qaLabUrl).toBe("http://127.0.0.1:43124");
      expect(result.gatewayUrl).toBe("http://127.0.0.1:18889/");
      expect(result.composeFile).toBe(`${outputDir}/docker-compose.qa.yml`);
      expect(result.stopCommand).toBe(`docker compose -f ${outputDir}/docker-compose.qa.yml down`);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("skips UI build and compose --build for prebuilt images", async () => {
    const calls: string[] = [];
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "qa-docker-up-"));

    try {
      await runQaDockerUp(
        {
          repoRoot: "/repo/openclaw",
          outputDir,
          usePrebuiltImage: true,
          skipUiBuild: true,
        },
        {
          async runCommand(command, args, cwd) {
            calls.push([command, ...args, `@${cwd}`].join(" "));
            return { stdout: "", stderr: "" };
          },
          fetchImpl: vi.fn(async () => ({ ok: true })),
          sleepImpl: vi.fn(async () => {}),
        },
      );

      expect(calls).toEqual([
        `docker compose -f ${outputDir}/docker-compose.qa.yml up -d @/repo/openclaw`,
      ]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
