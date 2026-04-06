import { execFile } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { writeQaDockerHarnessFiles } from "./docker-harness.js";

type QaDockerUpResult = {
  outputDir: string;
  composeFile: string;
  qaLabUrl: string;
  gatewayUrl: string;
  stopCommand: string;
};

type RunCommand = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string }>;

type FetchLike = (input: string) => Promise<{ ok: boolean }>;

const DEFAULT_QA_DOCKER_DIR = path.resolve(process.cwd(), ".artifacts/qa-docker");

function describeError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return JSON.stringify(error);
}

async function execCommand(command: string, args: string[], cwd: string) {
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(command, args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            stderr.trim() || stdout.trim() || `Command failed: ${[command, ...args].join(" ")}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function waitForHealth(
  url: string,
  deps: {
    fetchImpl: FetchLike;
    sleepImpl: (ms: number) => Promise<unknown>;
    timeoutMs?: number;
    pollMs?: number;
  },
) {
  const timeoutMs = deps.timeoutMs ?? 120_000;
  const pollMs = deps.pollMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const response = await deps.fetchImpl(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`Health check returned non-OK for ${url}`);
    } catch (error) {
      lastError = error;
    }
    await deps.sleepImpl(pollMs);
  }

  throw new Error(
    `Timed out waiting for ${url}${lastError ? `: ${describeError(lastError)}` : ""}`,
  );
}

export async function runQaDockerUp(
  params: {
    repoRoot?: string;
    outputDir?: string;
    gatewayPort?: number;
    qaLabPort?: number;
    providerBaseUrl?: string;
    image?: string;
    usePrebuiltImage?: boolean;
    skipUiBuild?: boolean;
  },
  deps?: {
    runCommand?: RunCommand;
    fetchImpl?: FetchLike;
    sleepImpl?: (ms: number) => Promise<unknown>;
  },
): Promise<QaDockerUpResult> {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const outputDir = path.resolve(params.outputDir ?? DEFAULT_QA_DOCKER_DIR);
  const gatewayPort = params.gatewayPort ?? 18789;
  const qaLabPort = params.qaLabPort ?? 43124;
  const runCommand = deps?.runCommand ?? execCommand;
  const fetchImpl =
    deps?.fetchImpl ??
    (async (input: string) => {
      return await fetch(input);
    });
  const sleepImpl = deps?.sleepImpl ?? sleep;

  if (!params.skipUiBuild) {
    await runCommand("pnpm", ["qa:lab:build"], repoRoot);
  }

  await writeQaDockerHarnessFiles({
    outputDir,
    repoRoot,
    gatewayPort,
    qaLabPort,
    providerBaseUrl: params.providerBaseUrl,
    imageName: params.image,
    usePrebuiltImage: params.usePrebuiltImage,
    includeQaLabUi: true,
  });

  const composeFile = path.join(outputDir, "docker-compose.qa.yml");
  const composeArgs = ["compose", "-f", composeFile, "up"];
  if (!params.usePrebuiltImage) {
    composeArgs.push("--build");
  }
  composeArgs.push("-d");

  await runCommand("docker", composeArgs, repoRoot);

  const qaLabUrl = `http://127.0.0.1:${qaLabPort}`;
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}/`;

  await waitForHealth(`${qaLabUrl}/healthz`, { fetchImpl, sleepImpl });
  await waitForHealth(`${gatewayUrl}healthz`, { fetchImpl, sleepImpl });

  return {
    outputDir,
    composeFile,
    qaLabUrl,
    gatewayUrl,
    stopCommand: `docker compose -f ${composeFile} down`,
  };
}
