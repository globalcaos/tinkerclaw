import process from "node:process";
import { execDocker, dockerContainerState } from "../agents/sandbox/docker.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const logger = createSubsystemLogger("security/gateway-container");

const GATEWAY_IMAGE = "openclaw-gateway:latest";
const GATEWAY_CONTAINER_NAME = "openclaw-gateway-secure";

export type GatewayContainerOptions = {
  proxyUrl: string;
  env?: Record<string, string | undefined>;
};

/**
 * Filters environment variables to exclude secrets.
 * Excludes variables ending with _API_KEY, _TOKEN, _SECRET.
 */
function filterSecretEnv(env: Record<string, string | undefined>): Record<string, string> {
  const filtered: Record<string, string> = {};
  const secretSuffixes = ["_API_KEY", "_TOKEN", "_SECRET"];

  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    
    const isSecret = secretSuffixes.some((suffix) => key.toUpperCase().endsWith(suffix));
    if (!isSecret) {
      filtered[key] = value;
    }
  }

  return filtered;
}

export async function stopGatewayContainer(): Promise<void> {
  const state = await dockerContainerState(GATEWAY_CONTAINER_NAME);
  if (state.exists) {
    logger.info(`Stopping existing gateway container: ${GATEWAY_CONTAINER_NAME}`);
    await execDocker(["rm", "-f", GATEWAY_CONTAINER_NAME]);
  }
}

export async function startGatewayContainer(opts: GatewayContainerOptions): Promise<string> {
  await stopGatewayContainer();

  const filteredEnv = filterSecretEnv(opts.env || process.env);
  
  const args = [
    "run",
    "-d",
    "--name", GATEWAY_CONTAINER_NAME,
    "--network", "bridge",
    "--add-host", `host.docker.internal:host-gateway`,
    // Port mapping for gateway WebSocket server (default 18789)
    "-p", "18789:18789",
    // Set secure mode flag so gateway knows to use placeholders and fetch wrapper
    "-e", "OPENCLAW_SECURE_MODE=1",
    // Tell the container where the proxy is
    "-e", `PROXY_URL=${opts.proxyUrl}`,
  ];

  for (const [key, value] of Object.entries(filteredEnv)) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(GATEWAY_IMAGE);
  
  // Run gateway with allow-unconfigured flag for secure mode
  args.push("node", "dist/index.js", "gateway", "--allow-unconfigured");

  logger.info(`Starting gateway container: ${GATEWAY_CONTAINER_NAME}`);
  await execDocker(args);

  return GATEWAY_CONTAINER_NAME;
}
