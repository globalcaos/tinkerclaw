import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { attachChildProcessBridge } from "./child-process-bridge.js";

function waitForLine(stream: NodeJS.ReadableStream, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timeout waiting for line"));
    }, timeoutMs);

    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      const idx = buffer.indexOf("\n");
      if (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        cleanup();
        resolve(line);
      }
    };

    const onError = (err: unknown): void => {
      cleanup();
      reject(err);
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      stream.off("data", onData);
      stream.off("error", onError);
    };

    stream.on("data", onData);
    stream.on("error", onError);
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

describe("attachChildProcessBridge", () => {
  const children: Array<{ kill: (signal?: NodeJS.Signals) => boolean }> = [];
  const detachments: Array<() => void> = [];

  afterEach(() => {
    for (const detach of detachments) {
      try {
        detach();
      } catch {
        // ignore
      }
    }
    detachments.length = 0;
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    children.length = 0;
  });

  it("forwards SIGTERM to the wrapped child", async () => {
    const childPath = path.resolve(process.cwd(), "test/fixtures/child-process-bridge/child.js");

    const beforeSigterm = new Set(process.listeners("SIGTERM"));
    const child = spawn(process.execPath, [childPath], {
      stdio: ["ignore", "pipe", "inherit"],
      env: process.env,
    });
    const exitCodes: number[] = [];
    const { detach } = attachChildProcessBridge(child, {
      exitProcess: (code) => {
        exitCodes.push(code);
      },
    });
    detachments.push(detach);
    children.push(child);
    const afterSigterm = process.listeners("SIGTERM");
    const addedSigterm = afterSigterm.find((listener) => !beforeSigterm.has(listener));

    if (!child.stdout) {
      throw new Error("expected stdout");
    }
    const portLine = await waitForLine(child.stdout);
    const port = Number(portLine);
    expect(Number.isFinite(port)).toBe(true);

    expect(await canConnect(port)).toBe(true);

    // Simulate systemd sending SIGTERM to the parent process.
    if (!addedSigterm) {
      throw new Error("expected SIGTERM listener");
    }
    addedSigterm();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout waiting for child exit")), 10_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    await new Promise((r) => setTimeout(r, 250));
    expect(await canConnect(port)).toBe(false);

    // The regression that mattered: forwarding the signal is not enough, the
    // parent has to die too or every wrapper that sent it waits forever.
    expect(exitCodes).toEqual([143]);
  }, 20_000);

  function createFakeChild(): ChildProcess {
    const emitter = new EventEmitter() as EventEmitter & ChildProcess;
    emitter.kill = ((): boolean => true) as ChildProcess["kill"];
    return emitter;
  }

  function captureListener(
    child: ChildProcess,
    signal: NodeJS.Signals,
    onExit: (code: number) => void,
    exitOnSignal = true,
  ): () => void {
    const before = new Set(process.listeners(signal));
    const { detach } = attachChildProcessBridge(child, {
      signals: [signal],
      exitProcess: onExit,
      exitOnSignal,
    });
    detachments.push(detach);
    const added = process.listeners(signal).find((listener) => !before.has(listener));
    if (!added) {
      throw new Error(`expected ${signal} listener`);
    }
    return added as () => void;
  }

  it("exits with 128 + signum once a forwarded SIGTERM has taken the child down", () => {
    const child = createFakeChild();
    const exitCodes: number[] = [];
    const fire = captureListener(child, "SIGTERM", (code) => {
      exitCodes.push(code);
    });

    fire();
    // The child is still alive: we wait for it rather than racing ahead (and
    // deliberately without a SIGKILL watchdog -- see the bridge comment).
    expect(exitCodes).toEqual([]);

    child.emit("exit", null, "SIGTERM");
    expect(exitCodes).toEqual([143]);
  });

  it("uses 130 when the forwarded signal was SIGINT", () => {
    const child = createFakeChild();
    const exitCodes: number[] = [];
    const fire = captureListener(child, "SIGINT", (code) => {
      exitCodes.push(code);
    });

    fire();
    child.emit("exit", null, "SIGINT");
    expect(exitCodes).toEqual([130]);
  });

  it("exits immediately when the child was already gone, and only once", () => {
    const child = createFakeChild();
    Object.assign(child, { exitCode: 0 });
    const exitCodes: number[] = [];
    const fire = captureListener(child, "SIGTERM", (code) => {
      exitCodes.push(code);
    });

    fire();
    expect(exitCodes).toEqual([143]);

    child.emit("exit", 0, null);
    expect(exitCodes).toEqual([143]);
  });

  it("does not exit when exitOnSignal is false", () => {
    const child = createFakeChild();
    const exitCodes: number[] = [];
    const fire = captureListener(
      child,
      "SIGTERM",
      (code) => {
        exitCodes.push(code);
      },
      false,
    );

    fire();
    child.emit("exit", null, "SIGTERM");
    expect(exitCodes).toEqual([]);
  });

  it("does not exit when the child exits on its own", () => {
    const child = createFakeChild();
    const exitCodes: number[] = [];
    captureListener(child, "SIGTERM", (code) => {
      exitCodes.push(code);
    });

    child.emit("exit", 0, null);
    expect(exitCodes).toEqual([]);
  });

  it("does not exit for a forwarded non-terminating signal", () => {
    const child = createFakeChild();
    const exitCodes: number[] = [];
    const fire = captureListener(child, "SIGWINCH", (code) => {
      exitCodes.push(code);
    });

    fire();
    child.emit("exit", 0, null);
    expect(exitCodes).toEqual([]);
  });
});
