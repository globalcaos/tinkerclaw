import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadCronStore } from "../../src/cron/store.js";
import type { CronJob } from "../../src/cron/types.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SEED_SCRIPT = path.join(REPO_ROOT, "scripts", "seed-structural-crons.mjs");
const homes: string[] = [];

async function makeCleanHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "openclaw-structural-crons-"));
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

function storePath(home: string): string {
  return path.join(home, ".openclaw", "cron", "jobs.json");
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("seed-structural-crons", () => {
  it("installs six enabled model-inheriting jobs into a clean offline HOME", async () => {
    const home = await makeCleanHome();

    const output = JSON.parse(runSeeder(home)) as { added: string[]; enabled: boolean };
    const store = await loadCronStore(storePath(home));

    expect(output).toMatchObject({ enabled: true });
    expect(output.added).toHaveLength(6);
    expect(store.jobs).toHaveLength(6);
    expect(store.jobs.every((job) => job.enabled)).toBe(true);
    expect(store.jobs.map((job) => job.id).sort()).toEqual(output.added.toSorted());
    for (const job of store.jobs) {
      expect(job.payload).not.toHaveProperty("model");
      expect(job.payload).not.toHaveProperty("fallbacks");
      expect(job.delivery).toEqual({ mode: "none" });
    }
  });

  it("does not overwrite or duplicate an existing matching job", async () => {
    const home = await makeCleanHome();
    const cronDir = path.dirname(storePath(home));
    const existing: CronJob = {
      id: "operator-owned-cleaning-job",
      name: "Cleaning Lady (Workspace Hygiene)",
      description: "Operator-owned description",
      enabled: false,
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
      schedule: { kind: "cron", expr: "5 3 * * 1", tz: "Europe/Madrid" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "Keep this operator-owned prompt",
        model: "operator/model",
        thinking: "high",
      },
      delivery: { mode: "none" },
      state: { lastRunAtMs: 1_500, lastRunStatus: "ok" },
    };
    await mkdir(cronDir, { recursive: true });
    await writeFile(
      storePath(home),
      JSON.stringify({ version: 1, jobs: [existing] }, null, 2),
      "utf8",
    );

    runSeeder(home);
    const store = await loadCronStore(storePath(home));

    expect(store.jobs).toHaveLength(6);
    expect(store.jobs.filter((job) => job.name === existing.name)).toHaveLength(1);
    expect(store.jobs.find((job) => job.id === existing.id)).toEqual(existing);
  });

  it("is byte-for-byte idempotent when repeated", async () => {
    const home = await makeCleanHome();

    runSeeder(home);
    const firstJobs = await readFile(storePath(home), "utf8");
    const firstState = await readFile(storePath(home).replace(/\.json$/u, "-state.json"), "utf8");
    const secondOutput = JSON.parse(runSeeder(home)) as { added: string[]; skipped: string[] };

    expect(secondOutput.added).toEqual([]);
    expect(secondOutput.skipped).toHaveLength(6);
    await expect(readFile(storePath(home), "utf8")).resolves.toBe(firstJobs);
    await expect(
      readFile(storePath(home).replace(/\.json$/u, "-state.json"), "utf8"),
    ).resolves.toBe(firstState);
  });

  it("supports explicitly seeding the six jobs disabled", async () => {
    const home = await makeCleanHome();

    const output = JSON.parse(runSeeder(home, "--disabled")) as {
      added: string[];
      enabled: boolean;
    };
    const store = await loadCronStore(storePath(home));

    expect(output).toMatchObject({ enabled: false });
    expect(output.added).toHaveLength(6);
    expect(store.jobs).toHaveLength(6);
    expect(store.jobs.every((job) => !job.enabled)).toBe(true);
  });
});
