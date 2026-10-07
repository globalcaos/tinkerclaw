/**
 * FORK: Downloader — owns the download daemon the torrent-scout skill hands work to.
 *
 * The skill decides WHAT to fetch (search, verify, rank). This plugin owns the part
 * that must run with no agent at all: an aria2 daemon on a systemd user unit, so a
 * download outlives the turn, a gateway restart and a reboot.
 *
 * 1. Guard service (every gateway start, Linux): repairs a config that would replay
 *    finished downloads (force-save), and starts the unit if it is installed but down.
 *    It never installs anything: installing is `node scripts/downloader/setup.mjs`.
 * 2. RPCs: downloader.status, downloader.add, downloader.remove, downloader.forget.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/core";
import {
  type Aria2Task,
  TASK_KEYS,
  findProblems,
  readSetting,
  repairConf,
  resolveOptions,
  resolvePaths,
  rpc,
  summarizeTask,
} from "./aria2-core.mjs";

const run = promisify(execFile);

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

async function systemctl(...args: string[]): Promise<string> {
  try {
    const { stdout } = await run("systemctl", ["--user", ...args], { timeout: 20_000 });
    return stdout.trim();
  } catch (err) {
    // `is-active` exits non-zero for an inactive unit; its stdout still says why.
    return ((err as { stdout?: string }).stdout ?? "").trim();
  }
}

export default function register(api: OpenClawPluginApi) {
  const opts = resolveOptions(api.pluginConfig ?? {});
  const paths = resolvePaths(os.homedir(), opts.unitName);

  async function secret(): Promise<string> {
    const fromFile = (await readText(paths.secret))?.trim();
    if (fromFile) {
      return fromFile;
    }
    const conf = await readText(paths.conf);
    return (conf && readSetting(conf, "rpc-secret")) || "";
  }

  async function call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return rpc<T>({ port: opts.rpcPort, secret: await secret(), method, params });
  }

  const guard: OpenClawPluginService = {
    id: "downloader-guard",
    start: async (ctx) => {
      try {
        if (process.platform !== "linux") {
          ctx.logger.info("downloader: systemd is Linux-only; guard skipped");
          return;
        }
        const conf = await readText(paths.conf);
        if (conf === undefined) {
          ctx.logger.info(
            `downloader: no daemon config at ${paths.conf}; install with: node scripts/downloader/setup.mjs`,
          );
          return;
        }
        const problems = findProblems(conf);
        let restart = false;
        if (problems.some((p) => p.startsWith("force-save"))) {
          await fs.writeFile(paths.conf, repairConf(conf));
          restart = true;
          ctx.logger.warn(`downloader: removed force-save from ${paths.conf}`);
        }
        for (const p of problems.filter((p) => !p.startsWith("force-save"))) {
          ctx.logger.warn(`downloader: ${paths.conf}: ${p}`);
        }
        if ((await readText(paths.unit)) === undefined) {
          return;
        }
        const state = await systemctl("is-active", `${paths.unitName}.service`);
        if (state === "active" && restart) {
          // The running daemon still holds force-save in memory and would write its
          // finished tasks back on shutdown, so drop them before it stops.
          await call("purgeDownloadResult").catch(() => {});
          await systemctl("restart", `${paths.unitName}.service`);
          ctx.logger.info("downloader: daemon restarted with the repaired config");
        } else if (state !== "active") {
          await systemctl("start", `${paths.unitName}.service`);
          ctx.logger.info(`downloader: daemon was ${state || "down"}; started it`);
        }
      } catch (err) {
        ctx.logger.warn(`downloader: guard failed: ${String(err)}`);
      }
    },
  };
  api.registerService(guard);

  api.registerGatewayMethod("downloader.status", async ({ respond }) => {
    const conf = await readText(paths.conf);
    const base = {
      installed: conf !== undefined,
      problems: conf ? findProblems(conf) : [],
      downloadDir: (conf && readSetting(conf, "dir")) || opts.downloadDir,
    };
    try {
      const [version, active, waiting, stopped] = await Promise.all([
        call<{ version: string }>("getVersion"),
        call<Aria2Task[]>("tellActive", [TASK_KEYS]),
        call<Aria2Task[]>("tellWaiting", [0, 100, TASK_KEYS]),
        call<Aria2Task[]>("tellStopped", [0, 100, TASK_KEYS]),
      ]);
      const tasks = [...active, ...waiting, ...stopped].map(summarizeTask);
      respond(true, {
        ...base,
        daemon: { reachable: true, version: version.version },
        counts: { active: active.length, waiting: waiting.length, stopped: stopped.length },
        tasks,
      });
    } catch (err) {
      respond(true, { ...base, daemon: { reachable: false, error: String(err) }, tasks: [] });
    }
  });

  api.registerGatewayMethod("downloader.add", async ({ params, respond }) => {
    const p = (params ?? {}) as { uri?: string; dir?: string };
    if (!p.uri) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "uri is required" });
      return;
    }
    try {
      const gid = await call<string>("addUri", [[p.uri], p.dir ? { dir: p.dir } : {}]);
      respond(true, { gid });
    } catch (err) {
      respond(false, undefined, { code: "DAEMON_ERROR", message: String(err) });
    }
  });

  api.registerGatewayMethod("downloader.remove", async ({ params, respond }) => {
    const gid = (params as { gid?: string } | undefined)?.gid;
    if (!gid) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "gid is required" });
      return;
    }
    try {
      await call("forceRemove", [gid]).catch(() => {});
      await call("removeDownloadResult", [gid]).catch(() => {});
      respond(true, { gid, removed: true });
    } catch (err) {
      respond(false, undefined, { code: "DAEMON_ERROR", message: String(err) });
    }
  });

  api.registerGatewayMethod("downloader.forget", async ({ respond }) => {
    try {
      await call("purgeDownloadResult");
      respond(true, { forgotten: true });
    } catch (err) {
      respond(false, undefined, { code: "DAEMON_ERROR", message: String(err) });
    }
  });
}
