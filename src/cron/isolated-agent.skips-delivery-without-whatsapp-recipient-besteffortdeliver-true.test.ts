import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as modelSelection from "../agents/model-selection.js";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import type { CliDeps } from "../cli/deps.js";
import {
  createCliDeps,
  mockAgentPayloads,
  runTelegramAnnounceTurn,
} from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  withTempCronHome as withTempHome,
  writeSessionStore,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

vi.mock("../agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthProfileOverride: vi.fn(async () => undefined),
}));

const TELEGRAM_TARGET = { mode: "announce", channel: "telegram", to: "123" } as const;

async function withTelegramAnnounceFixture(
  run: (params: { home: string; storePath: string; deps: CliDeps }) => Promise<void>,
  params?: {
    deps?: Partial<CliDeps>;
    sessionStore?: { lastProvider?: string; lastTo?: string };
  },
): Promise<void> {
  await withTempHome(async (home) => {
    const storePath = await writeSessionStore(home, {
      lastProvider: params?.sessionStore?.lastProvider ?? "webchat",
      lastTo: params?.sessionStore?.lastTo ?? "",
    });
    const deps = createCliDeps(params?.deps);
    await run({ home, storePath, deps });
  });
}

async function expectBestEffortTelegramNotDelivered(
  payload: Record<string, unknown>,
): Promise<void> {
  await expectStructuredTelegramFailure({
    payload,
    bestEffort: true,
    expectedStatus: "ok",
    expectDeliveryAttempted: true,
  });
}

async function expectStructuredTelegramFailure(params: {
  payload: Record<string, unknown>;
  bestEffort: boolean;
  expectedStatus: "ok" | "error";
  expectedErrorFragment?: string;
  expectDeliveryAttempted?: boolean;
}): Promise<void> {
  await withTelegramAnnounceFixture(
    async ({ home, storePath, deps }) => {
      mockAgentPayloads([params.payload]);
      const res = await runTelegramAnnounceTurn({
        home,
        storePath,
        deps,
        delivery: {
          ...TELEGRAM_TARGET,
          ...(params.bestEffort ? { bestEffort: true } : {}),
        },
      });

      expectFailedTelegramDeliveryResult({
        res,
        deps,
        expectedStatus: params.expectedStatus,
        expectedErrorFragment: params.expectedErrorFragment,
        expectDeliveryAttempted: params.expectDeliveryAttempted,
      });
    },
    {
      deps: {
        sendMessageTelegram: vi.fn().mockRejectedValue(new Error("boom")),
      },
    },
  );
}

function expectFailedTelegramDeliveryResult(params: {
  res: Awaited<ReturnType<typeof runCronIsolatedAgentTurn>>;
  deps: CliDeps;
  expectedStatus: "ok" | "error";
  expectedErrorFragment?: string;
  expectDeliveryAttempted?: boolean;
}) {
  expect(params.res.status).toBe(params.expectedStatus);
  if (params.expectedStatus === "ok") {
    expect(params.res.delivered).toBe(false);
  } else {
    expect(params.res.delivered).toBeUndefined();
  }
  if (params.expectDeliveryAttempted !== undefined) {
    expect(params.res.deliveryAttempted).toBe(params.expectDeliveryAttempted);
  }
  if (params.expectedErrorFragment) {
    expect(params.res.error).toContain(params.expectedErrorFragment);
  }
  expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
  expect(params.deps.sendMessageTelegram).toHaveBeenCalledTimes(1);
}

describe("runCronIsolatedAgentTurn", () => {
  beforeEach(() => {
    vi.spyOn(modelSelection, "resolveThinkingDefault").mockReturnValue("off");
    setupIsolatedAgentTurnMocks({ fast: true });
  });

  it("ignores structured direct delivery failures when best-effort is enabled", async () => {
    await expectBestEffortTelegramNotDelivered({
      text: "hello from cron",
      mediaUrl: "https://example.com/img.png",
    });
  });
});
