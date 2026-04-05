import { startQaLabServer } from "./lab-server.js";

export async function runQaLabSelfCheckCommand(opts: { output?: string }) {
  const server = await startQaLabServer({
    outputPath: opts.output,
  });
  try {
    const result = await server.runSelfCheck();
    process.stdout.write(`QA self-check report: ${result.outputPath}\n`);
  } finally {
    await server.stop();
  }
}

export async function runQaLabUiCommand(opts: { host?: string; port?: number }) {
  const server = await startQaLabServer({
    host: opts.host,
    port: Number.isFinite(opts.port) ? opts.port : undefined,
  });
  process.stdout.write(`QA Lab UI: ${server.baseUrl}\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");

  const shutdown = async () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await server.stop();
    process.exit(0);
  };

  const onSignal = () => {
    void shutdown();
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  await new Promise(() => undefined);
}
