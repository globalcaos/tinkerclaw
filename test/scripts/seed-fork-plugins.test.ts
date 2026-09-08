import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const FORK_PLUGIN_IDS = [
  "tinkerclaw-tinker",
  "tinkerclaw-tinker-bridge",
  "tinkerclaw-cron-panel",
  "tinkerclaw-pulse-panel",
  "tinkerclaw-task-panel",
  "tinkerclaw-control-panel",
  "tinkerclaw-budget-panel",
  "tinkerclaw-prefrontal",
  "tinkerclaw-fractal-reflection",
  "tinkerclaw-identity-persistence",
  "tinkerclaw-hippocampus",
  "tinkerclaw-memory-enhancements",
  "tinkerclaw-total-recall",
  "tinkerclaw-learned-intuition",
  "tinkerclaw-computational-humor",
  "tinkerclaw-orca",
  "tinkerclaw-people",
  "tinkerclaw-round-table",
  "tinkerclaw-auth-reload",
  "tinkerclaw-browser-relay",
  "microsoft",
];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SEED_SCRIPT = path.join(REPO_ROOT, "scripts", "seed-fork-plugins.mjs");
const homes: string[] = [];

async function makeCleanHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "openclaw-fork-plugins-"));
  homes.push(home);
  return home;
}

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.OPENCLAW_HOME;
  delete env.OPENCLAW_STATE_DIR;
  delete env.OPENCLAW_CONFIG_PATH;
  return env;
}

function runSeeder(home: string, ...args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", SEED_SCRIPT, ...args, "--json"], {
    cwd: REPO_ROOT,
    env: isolatedEnv(home),
    encoding: "utf8",
    timeout: 30_000,
  });
}

function configPath(home: string): string {
  return path.join(home, ".openclaw", "openclaw.json");
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("seed-fork-plugins", () => {
  it("enables the fork UI plugins in a clean HOME and never writes plugins.allow", async () => {
    const home = await makeCleanHome();
    const output = JSON.parse(runSeeder(home)) as { added: string[]; created: boolean };
    const cfg = JSON.parse(await readFile(configPath(home), "utf8")) as {
      plugins?: {
        allow?: string[];
        entries?: Record<string, { enabled?: boolean }>;
        slots?: { memory?: string };
      };
    };

    expect(output.created).toBe(true);
    expect(output.added.sort()).toEqual([...FORK_PLUGIN_IDS].sort());
    expect(cfg.plugins?.allow).toBeUndefined();
    expect(cfg.plugins?.slots?.memory).toBe("tinkerclaw-total-recall");
    expect(FORK_PLUGIN_IDS).not.toContain("tinkerclaw-whatsapp");
    for (const id of FORK_PLUGIN_IDS) {
      expect(cfg.plugins?.entries?.[id]).toEqual({ enabled: true });
    }
  });

  it("does not overwrite an operator-disabled entry", async () => {
    const home = await makeCleanHome();
    await mkdir(path.dirname(configPath(home)), { recursive: true });
    await writeFile(
      configPath(home),
      JSON.stringify(
        {
          plugins: {
            entries: { "tinkerclaw-pulse-panel": { enabled: false, config: { keep: true } } },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    runSeeder(home);
    const cfg = JSON.parse(await readFile(configPath(home), "utf8")) as {
      plugins?: { entries?: Record<string, { enabled?: boolean; config?: unknown }> };
    };
    expect(cfg.plugins?.entries?.["tinkerclaw-pulse-panel"]).toEqual({
      enabled: false,
      config: { keep: true },
    });
    expect(cfg.plugins?.entries?.["tinkerclaw-tinker"]?.enabled).toBe(true);
  });

  it("does not expand or write plugins.allow; skips ids missing from an existing allow-list", async () => {
    const home = await makeCleanHome();
    await mkdir(path.dirname(configPath(home)), { recursive: true });
    await writeFile(
      configPath(home),
      JSON.stringify({ plugins: { allow: ["tinkerclaw-cron-panel"] } }, null, 2),
      "utf8",
    );

    const output = JSON.parse(runSeeder(home)) as { added: string[]; skippedAllow: string[] };
    const cfg = JSON.parse(await readFile(configPath(home), "utf8")) as {
      plugins?: { allow?: string[]; entries?: Record<string, { enabled?: boolean }> };
    };

    expect(cfg.plugins?.allow).toEqual(["tinkerclaw-cron-panel"]);
    expect(output.added).toEqual(["tinkerclaw-cron-panel"]);
    expect(output.skippedAllow).toContain("tinkerclaw-pulse-panel");
    expect(output.skippedAllow).toContain("tinkerclaw-task-panel");
    expect(cfg.plugins?.entries?.["tinkerclaw-pulse-panel"]).toBeUndefined();
  });

  it("is idempotent", async () => {
    const home = await makeCleanHome();
    runSeeder(home);
    const first = await readFile(configPath(home), "utf8");
    const second = JSON.parse(runSeeder(home)) as { added: string[] };
    expect(second.added).toEqual([]);
    await expect(readFile(configPath(home), "utf8")).resolves.toBe(first);
  });
});
