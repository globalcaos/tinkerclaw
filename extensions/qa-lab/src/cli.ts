import type { Command } from "commander";

type QaLabCliRuntime = typeof import("./cli.runtime.js");

let qaLabCliRuntimePromise: Promise<QaLabCliRuntime> | null = null;

async function loadQaLabCliRuntime(): Promise<QaLabCliRuntime> {
  qaLabCliRuntimePromise ??= import("./cli.runtime.js");
  return await qaLabCliRuntimePromise;
}

async function runQaSelfCheck(opts: { output?: string }) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaLabSelfCheckCommand(opts);
}

async function runQaUi(opts: { host?: string; port?: number }) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaLabUiCommand(opts);
}

export function registerQaLabCli(program: Command) {
  const qa = program
    .command("qa")
    .description("Run private QA automation flows and launch the QA debugger");

  qa.command("run")
    .description("Run the bundled QA self-check and write a Markdown report")
    .option("--output <path>", "Report output path")
    .action(async (opts: { output?: string }) => {
      await runQaSelfCheck(opts);
    });

  qa.command("ui")
    .description("Start the private QA debugger UI and local QA bus")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port", (value: string) => Number(value))
    .action(async (opts: { host?: string; port?: number }) => {
      await runQaUi(opts);
    });
}
