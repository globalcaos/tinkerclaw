import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertNoLiveProcessOnOutputRoots,
  cleanTsdownOutputRoots,
  createTsdownOutputScanner,
  findProcessesRunningOutputRoots,
  pruneSourceCheckoutBundledPluginNodeModules,
  pruneStaleRootChunkFiles,
  resolveTsdownBuildInvocation,
  runTsdownBuildInvocation,
} from "../../scripts/tsdown-build.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("resolveTsdownBuildInvocation", () => {
  it("routes Windows tsdown builds through the pnpm runner instead of shell=true", () => {
    const result = resolveTsdownBuildInvocation({
      platform: "win32",
      nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath: "C:/Users/test/AppData/Local/pnpm/10.32.1/bin/pnpm.cjs",
      env: {},
    });

    expect(result).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:/Users/test/AppData/Local/pnpm/10.32.1/bin/pnpm.cjs",
        "exec",
        "tsdown",
        "--config-loader",
        "unrun",
        "--logLevel",
        "warn",
        "--no-clean",
      ],
      options: {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsVerbatimArguments: undefined,
        env: {},
      },
    });
  });

  it("keeps source-checkout prune best-effort", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rmSync = vi.spyOn(fs, "rmSync");

    rmSync.mockImplementation(() => {
      throw new Error("locked");
    });

    expect(() =>
      pruneSourceCheckoutBundledPluginNodeModules({
        cwd: process.cwd(),
      }),
    ).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      "tsdown: could not prune bundled plugin source node_modules: Error: locked",
    );

    warn.mockRestore();
    rmSync.mockRestore();
  });

  it("prunes stale hashed root chunk files but keeps stable aliases and nested assets", async () => {
    const rootDir = createTempDir("openclaw-tsdown-build-");
    const distDir = path.join(rootDir, "dist");
    const distRuntimeDir = path.join(rootDir, "dist-runtime");
    await fsPromises.mkdir(path.join(distDir, "control-ui"), { recursive: true });
    await fsPromises.mkdir(distRuntimeDir, { recursive: true });
    await fsPromises.writeFile(path.join(distDir, "delegate-BPjCe4gC.js"), "old delegate\n");
    await fsPromises.writeFile(path.join(distDir, "compact.runtime-2DiEmVcA.js"), "old runtime\n");
    await fsPromises.writeFile(path.join(distDir, "compact.runtime.js"), "stable alias\n");
    await fsPromises.writeFile(path.join(distDir, "entry.js"), "entry\n");
    await fsPromises.writeFile(path.join(distDir, "control-ui", "index.html"), "asset\n");
    await fsPromises.writeFile(
      path.join(distRuntimeDir, "heartbeat-runner.runtime-fspOEj_1.js"),
      "old runtime\n",
    );
    await fsPromises.writeFile(path.join(distRuntimeDir, "heartbeat-runner.runtime.js"), "alias\n");

    pruneStaleRootChunkFiles({ cwd: rootDir });

    await expect(
      fsPromises.readFile(path.join(distDir, "compact.runtime.js"), "utf8"),
    ).resolves.toBe("stable alias\n");
    await expect(fsPromises.readFile(path.join(distDir, "entry.js"), "utf8")).resolves.toBe(
      "entry\n",
    );
    await expect(
      fsPromises.readFile(path.join(distDir, "control-ui", "index.html"), "utf8"),
    ).resolves.toBe("asset\n");
    await expect(
      fsPromises.readFile(path.join(distRuntimeDir, "heartbeat-runner.runtime.js"), "utf8"),
    ).resolves.toBe("alias\n");
    await expect(fsPromises.stat(path.join(distDir, "delegate-BPjCe4gC.js"))).rejects.toThrow();
    await expect(
      fsPromises.stat(path.join(distDir, "compact.runtime-2DiEmVcA.js")),
    ).rejects.toThrow();
    await expect(
      fsPromises.stat(path.join(distRuntimeDir, "heartbeat-runner.runtime-fspOEj_1.js")),
    ).rejects.toThrow();
  });

  it("cleans tsdown output roots before using tsdown --no-clean without deleting staged runtime deps", async () => {
    const rootDir = createTempDir("openclaw-tsdown-clean-");
    const distFile = path.join(rootDir, "dist", "stale.js");
    const pluginManifest = path.join(rootDir, "extensions", "telegram", "openclaw.plugin.json");
    const pluginSourceManifest = path.join(rootDir, "extensions", "telegram", "package.json");
    const pluginGeneratedFile = path.join(rootDir, "dist", "extensions", "telegram", "index.js");
    const pluginRuntimeDepFile = path.join(
      rootDir,
      "dist",
      "extensions",
      "telegram",
      "node_modules",
      "grammy",
      "package.json",
    );
    const stalePluginRuntimeDepFile = path.join(
      rootDir,
      "dist",
      "extensions",
      "old-plugin",
      "node_modules",
      "left-pad",
      "package.json",
    );
    const unstagedPluginSourceManifest = path.join(
      rootDir,
      "extensions",
      "unstaged-plugin",
      "package.json",
    );
    const unstagedPluginRuntimeDepFile = path.join(
      rootDir,
      "dist",
      "extensions",
      "unstaged-plugin",
      "node_modules",
      "left-pad",
      "package.json",
    );
    const distRuntimeFile = path.join(rootDir, "dist-runtime", "stale.js");
    const unrelatedFile = path.join(rootDir, "tmp", "keep.js");
    await fsPromises.mkdir(path.dirname(distFile), { recursive: true });
    await fsPromises.mkdir(path.dirname(pluginManifest), { recursive: true });
    await fsPromises.mkdir(path.dirname(pluginSourceManifest), { recursive: true });
    await fsPromises.mkdir(path.dirname(pluginGeneratedFile), { recursive: true });
    await fsPromises.mkdir(path.dirname(pluginRuntimeDepFile), { recursive: true });
    await fsPromises.mkdir(path.dirname(stalePluginRuntimeDepFile), { recursive: true });
    await fsPromises.mkdir(path.dirname(unstagedPluginSourceManifest), { recursive: true });
    await fsPromises.mkdir(path.dirname(unstagedPluginRuntimeDepFile), { recursive: true });
    await fsPromises.mkdir(path.dirname(distRuntimeFile), { recursive: true });
    await fsPromises.mkdir(path.dirname(unrelatedFile), { recursive: true });
    await fsPromises.writeFile(distFile, "stale\n");
    await fsPromises.writeFile(pluginManifest, '{"id":"telegram"}\n');
    await fsPromises.writeFile(
      pluginSourceManifest,
      '{"openclaw":{"bundle":{"stageRuntimeDependencies":true}}}\n',
    );
    await fsPromises.writeFile(pluginGeneratedFile, "generated\n");
    await fsPromises.writeFile(pluginRuntimeDepFile, "{}\n");
    await fsPromises.writeFile(stalePluginRuntimeDepFile, "{}\n");
    await fsPromises.writeFile(unstagedPluginSourceManifest, "{}\n");
    await fsPromises.writeFile(unstagedPluginRuntimeDepFile, "{}\n");
    await fsPromises.writeFile(distRuntimeFile, "stale\n");
    await fsPromises.writeFile(unrelatedFile, "keep\n");

    cleanTsdownOutputRoots({ cwd: rootDir });

    await expect(fsPromises.stat(distFile)).rejects.toThrow();
    await expect(fsPromises.stat(pluginGeneratedFile)).rejects.toThrow();
    await expect(fsPromises.readFile(pluginRuntimeDepFile, "utf8")).resolves.toBe("{}\n");
    await expect(
      fsPromises.stat(path.join(rootDir, "dist", "extensions", "old-plugin")),
    ).rejects.toThrow();
    await expect(
      fsPromises.stat(path.join(rootDir, "dist", "extensions", "unstaged-plugin")),
    ).rejects.toThrow();
    await expect(fsPromises.stat(path.join(rootDir, "dist-runtime"))).rejects.toThrow();
    await expect(fsPromises.readFile(unrelatedFile, "utf8")).resolves.toBe("keep\n");
  });
});

describe("createTsdownOutputScanner", () => {
  it("tracks fatal build diagnostics while bounding captured output", () => {
    const scanner = createTsdownOutputScanner({ maxCaptureBytes: 20 });

    scanner.append("prefix that should be trimmed\n");
    scanner.append("[INEFFECTIVE_DYNAMIC_IMPORT]\n");
    scanner.append("[UNRESOLVED_IMPORT] src/index.ts\n");

    const result = scanner.finish();

    expect(result.hasIneffectiveDynamicImport).toBe(true);
    expect(result.fatalUnresolvedImport).toContain("[UNRESOLVED_IMPORT] src/index.ts");
    expect(result.captured.length).toBeLessThanOrEqual(20);
  });

  it("ignores unresolved imports from bundled plugin and dependency paths", () => {
    const scanner = createTsdownOutputScanner();

    scanner.append("[UNRESOLVED_IMPORT] extensions/telegram/src/index.ts\n");
    scanner.append("[UNRESOLVED_IMPORT] node_modules/example/index.js\n");

    expect(scanner.finish().fatalUnresolvedImport).toBeNull();
  });
});

describe("runTsdownBuildInvocation", () => {
  function createWriteSink() {
    const chunks: string[] = [];
    return {
      sink: {
        write(chunk: unknown) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
          return true;
        },
      },
      chunks,
    };
  }

  it("streams child output while preserving diagnostics for post-run checks", async () => {
    const output = createWriteSink();
    const result = await runTsdownBuildInvocation(
      {
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write('stdout-ok\\n'); process.stderr.write('[INEFFECTIVE_DYNAMIC_IMPORT]\\n')",
        ],
        options: {
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          env: process.env,
        },
      },
      {
        stdout: output.sink,
        stderr: output.sink,
        env: { ...process.env, OPENCLAW_TSDOWN_HEARTBEAT_MS: "0" },
      },
    );

    expect(result.status).toBe(0);
    expect(result.hasIneffectiveDynamicImport).toBe(true);
    expect(output.chunks.join("")).toContain("stdout-ok");
  });

  it("terminates the child when OPENCLAW_TSDOWN_TIMEOUT_MS elapses", async () => {
    const output = createWriteSink();
    const result = await runTsdownBuildInvocation(
      {
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10000)"],
        options: {
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          env: process.env,
        },
      },
      {
        stdout: output.sink,
        stderr: output.sink,
        env: {
          ...process.env,
          OPENCLAW_TSDOWN_HEARTBEAT_MS: "0",
          OPENCLAW_TSDOWN_TIMEOUT_MS: "50",
        },
      },
    );

    expect(result.timedOut).toBe(true);
    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(output.chunks.join("")).toContain("timeout after 50ms");
  });
});

describe("findProcessesRunningOutputRoots", () => {
  function createFixture() {
    const rootDir = createTempDir("openclaw-tsdown-live-");
    const cwd = path.join(rootDir, "tinkerclaw");
    const procRoot = path.join(rootDir, "proc");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(procRoot, { recursive: true });
    return { rootDir, cwd, procRoot };
  }

  function writeProcTree(procRoot: string, processes: Record<number, string[]>): void {
    for (const [pid, argv] of Object.entries(processes)) {
      const pidDir = path.join(procRoot, pid);
      fs.mkdirSync(pidDir, { recursive: true });
      fs.writeFileSync(path.join(pidDir, "cmdline"), `${argv.join("\0")}\0`);
    }
  }

  it("detects a gateway running from this checkout's dist entry", () => {
    const { cwd, procRoot } = createFixture();
    const entry = path.join(cwd, "dist", "index.js");
    writeProcTree(procRoot, {
      1234: ["node", entry, "gateway", "--port", "18789"],
      5678: ["node", path.join(cwd, "scripts", "unrelated.mjs")],
    });
    fs.mkdirSync(path.join(procRoot, "self"), { recursive: true });

    const matches = findProcessesRunningOutputRoots({ cwd, procRoot, selfPid: 1, ppid: 2 });

    expect(matches).toHaveLength(1);
    expect(matches[0].pid).toBe(1234);
    expect(matches[0].argv).toContain(entry);
  });

  it("detects a process running from the dist-runtime entry", () => {
    const { cwd, procRoot } = createFixture();
    writeProcTree(procRoot, { 4242: ["node", path.join(cwd, "dist-runtime", "index.js")] });

    const matches = findProcessesRunningOutputRoots({ cwd, procRoot, selfPid: 1, ppid: 2 });

    expect(matches.map((match) => match.pid)).toEqual([4242]);
  });

  it("does not block a detached-worktree build while the live gateway runs elsewhere", () => {
    const { rootDir, cwd, procRoot } = createFixture();
    const liveEntry = path.join(cwd, "dist", "index.js");
    const deployCheckout = path.join(rootDir, ".tclaw-deploy-2026-07-29");
    writeProcTree(procRoot, { 4343: ["node", liveEntry, "gateway", "--port", "18789"] });

    const matches = findProcessesRunningOutputRoots({
      cwd: deployCheckout,
      procRoot,
      selfPid: 1,
      ppid: 2,
    });

    expect(matches).toEqual([]);
  });

  it("ignores this process and its parent", () => {
    const { cwd, procRoot } = createFixture();
    const entry = path.join(cwd, "dist", "index.js");
    writeProcTree(procRoot, { 111: ["node", entry], 222: ["node", entry] });

    expect(findProcessesRunningOutputRoots({ cwd, procRoot, selfPid: 111, ppid: 222 })).toEqual([]);
  });

  it("returns an empty list when the proc root is missing", () => {
    const { cwd, rootDir } = createFixture();
    let matches: unknown;

    expect(() => {
      matches = findProcessesRunningOutputRoots({
        cwd,
        procRoot: path.join(rootDir, "no-such-proc"),
        selfPid: 1,
        ppid: 2,
      });
    }).not.toThrow();
    expect(matches).toEqual([]);
  });
});

describe("assertNoLiveProcessOnOutputRoots", () => {
  function createFixture() {
    const rootDir = createTempDir("openclaw-tsdown-guard-");
    const cwd = path.join(rootDir, "tinkerclaw");
    const procRoot = path.join(rootDir, "proc");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(procRoot, { recursive: true });
    return { rootDir, cwd, procRoot };
  }

  function writeLiveGateway(procRoot: string, pid: number, entry: string): void {
    const pidDir = path.join(procRoot, String(pid));
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(
      path.join(pidDir, "cmdline"),
      `${["node", entry, "gateway", "--port", "18789"].join("\0")}\0`,
    );
  }

  it("exits 1 and explains the ERR_MODULE_NOT_FOUND failure mode", () => {
    const { cwd, procRoot } = createFixture();
    const entry = path.join(cwd, "dist", "index.js");
    writeLiveGateway(procRoot, 9001, entry);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.fn();

    assertNoLiveProcessOnOutputRoots({ cwd, procRoot, selfPid: 1, ppid: 2, env: {}, exit });

    expect(exit).toHaveBeenCalledWith(1);
    const message = String(error.mock.calls[0]?.[0]);
    expect(message).toContain("9001");
    expect(message).toContain(entry);
    expect(message).toContain("ERR_MODULE_NOT_FOUND");
    expect(message).toContain("scripts/deploy-worktree.sh");
    expect(message).toContain("systemctl --user stop openclaw-gateway");
    expect(message).toContain("OPENCLAW_BUILD_ALLOW_LIVE_GATEWAY");

    error.mockRestore();
  });

  it("warns but continues when OPENCLAW_BUILD_ALLOW_LIVE_GATEWAY is set", () => {
    const { cwd, procRoot } = createFixture();
    writeLiveGateway(procRoot, 9002, path.join(cwd, "dist", "index.js"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exit = vi.fn();

    assertNoLiveProcessOnOutputRoots({
      cwd,
      procRoot,
      selfPid: 1,
      ppid: 2,
      env: { OPENCLAW_BUILD_ALLOW_LIVE_GATEWAY: "1" },
      exit,
    });

    expect(exit).not.toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain("9002");

    warn.mockRestore();
  });

  it("stays silent when nothing is running from the output roots", () => {
    const { cwd, procRoot } = createFixture();
    const exit = vi.fn();

    expect(
      assertNoLiveProcessOnOutputRoots({ cwd, procRoot, selfPid: 1, ppid: 2, env: {}, exit }),
    ).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });
});
