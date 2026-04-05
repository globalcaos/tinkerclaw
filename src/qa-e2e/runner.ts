import fs from "node:fs/promises";
import path from "node:path";
import { qaChannelPlugin, setQaChannelRuntime } from "../../extensions/qa-channel/api.js";
import type { OpenClawConfig } from "../config/config.js";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaRunnerRuntime } from "./harness-runtime.js";
import { renderQaMarkdownReport } from "./report.js";
import { runQaScenario } from "./scenario.js";
import { createQaSelfCheckScenario } from "./self-check-scenario.js";

export async function runQaE2eSelfCheck(params?: { outputPath?: string }) {
  const startedAt = new Date();
  const state = createQaBusState();
  const bus = await startQaBusServer({ state });
  const runtime = createQaRunnerRuntime();
  setQaChannelRuntime(runtime);

  const cfg: OpenClawConfig = {
    channels: {
      "qa-channel": {
        enabled: true,
        baseUrl: bus.baseUrl,
        botUserId: "openclaw",
        botDisplayName: "OpenClaw QA",
        allowFrom: ["*"],
      },
    },
  };

  const account = qaChannelPlugin.config.resolveAccount(cfg, "default");
  const abort = new AbortController();

  const task = qaChannelPlugin.gateway?.startAccount?.({
    accountId: account.accountId,
    account,
    cfg,
    runtime: {
      log: () => undefined,
      error: () => undefined,
      exit: () => undefined,
    },
    abortSignal: abort.signal,
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    getStatus: () => ({
      accountId: account.accountId,
      configured: true,
      enabled: true,
      running: true,
    }),
    setStatus: () => undefined,
  });

  const checks: Array<{ name: string; status: "pass" | "fail"; details?: string }> = [];
  let scenarioResult: Awaited<ReturnType<typeof runQaScenario>> | undefined;

  try {
    scenarioResult = await runQaScenario(createQaSelfCheckScenario(cfg), { state });
    checks.push({
      name: "QA self-check scenario",
      status: scenarioResult.status,
      details: `${scenarioResult.steps.filter((step) => step.status === "pass").length}/${scenarioResult.steps.length} steps passed`,
    });
  } catch (error) {
    checks.push({
      name: "QA self-check",
      status: "fail",
      details: error instanceof Error ? error.message : String(error),
    });
  } finally {
    abort.abort();
    await task;
    await bus.stop();
  }

  const finishedAt = new Date();
  const snapshot = state.getSnapshot();
  const timeline = snapshot.events.map((event) => {
    switch (event.kind) {
      case "thread-created":
        return `${event.cursor}. ${event.kind} ${event.thread.conversationId}/${event.thread.id}`;
      case "reaction-added":
        return `${event.cursor}. ${event.kind} ${event.message.id} ${event.emoji}`;
      default:
        return `${event.cursor}. ${event.kind} ${"message" in event ? event.message.id : ""}`.trim();
    }
  });
  const report = renderQaMarkdownReport({
    title: "OpenClaw QA E2E Self-Check",
    startedAt,
    finishedAt,
    checks,
    scenarios: scenarioResult
      ? [
          {
            name: scenarioResult.name,
            status: scenarioResult.status,
            details: scenarioResult.details,
            steps: scenarioResult.steps,
          },
        ]
      : undefined,
    timeline,
    notes: [
      "Vertical slice only: bus + bundled qa-channel + in-process runner runtime.",
      "Full Docker orchestration and model/provider matrix remain follow-up work.",
    ],
  });

  const outputPath =
    params?.outputPath ?? path.join(process.cwd(), ".artifacts", "qa-e2e", "self-check.md");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, report, "utf8");
  return {
    outputPath,
    report,
    checks,
  };
}
