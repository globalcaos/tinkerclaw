/**
 * `openclaw jev status`: is Jev dormant (no token), checking a token, armed, or refused, and where a token goes.
 * Asks the running gateway; with none running it reads this machine's own token sources and says what it cannot know.
 * Never prints a token.
 */
import type { Command } from "commander";
import { callGatewayCli } from "../gateway/call.js";
import { jevAvailability, refreshJevNow, type JevAvailability } from "../infra/jev/availability.js";
import { defaultRuntime } from "../runtime.js";

const SOURCE_LABEL = {
  env: "environment (TYPESAFE_API_KEY)",
  file: "key file",
} as const;

export function formatJevStatus(s: JevAvailability, source: "gateway" | "local"): string[] {
  const lines = [s.line, `  state: ${s.state}`];
  lines.push(`  token source: ${s.keySource ? SOURCE_LABEL[s.keySource] : "none"}`);
  lines.push(`  key file: ${s.tokenFile} (picked up without a restart)`);
  lines.push("  TYPESAFE_API_KEY in the environment needs a gateway restart");
  if (s.state === "dormant" && s.tokenHelpUrl) {
    lines.push(`  get a token: ${s.tokenHelpUrl}`);
  }
  if (s.breakerOpen) {
    lines.push("  paused for a moment after errors (the token is fine)");
  }
  if (s.lastProbe) {
    lines.push(
      `  last answer: ${s.lastProbe.ok ? "ok" : `failed${s.lastProbe.status ? ` (HTTP ${s.lastProbe.status})` : ""}`}`,
    );
  }
  lines.push(
    source === "gateway"
      ? "  read from: the running gateway"
      : "  read from: this machine's files (gateway not reached); armed or refused shows only from the running gateway",
  );
  return lines;
}

export async function readJevStatus(
  deps: {
    callGateway?: () => Promise<JevAvailability>;
    local?: () => JevAvailability;
  } = {},
): Promise<{ status: JevAvailability; source: "gateway" | "local" }> {
  const call =
    deps.callGateway ??
    (() => callGatewayCli<JevAvailability>({ method: "jev.status", timeoutMs: 4000 }));
  try {
    return { status: await call(), source: "gateway" };
  } catch {
    const local =
      deps.local ??
      (() => {
        refreshJevNow();
        return jevAvailability();
      });
    return { status: local(), source: "local" };
  }
}

export function registerJevCli(program: Command) {
  const jev = program
    .command("jev")
    .description("Jev, the optional judge behind safety checks and routing reads");
  jev
    .command("status")
    .description("Show whether Jev is off (no token), checking a token, on, or refused")
    .option("--json", "Print the status as JSON", false)
    .action(async (opts: { json?: boolean }) => {
      const { status, source } = await readJevStatus();
      if (opts.json) {
        defaultRuntime.writeJson({ ...status, source });
        return;
      }
      defaultRuntime.log(formatJevStatus(status, source).join("\n"));
    });
}
