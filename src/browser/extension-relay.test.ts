import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  ensureChromeExtensionRelayServer,
  getChromeExtensionRelayAuthHeaders,
  stopChromeExtensionRelayServer,
} from "./extension-relay.js";

async function getFreePort(): Promise<number> {
  while (true) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const assigned = (s.address() as AddressInfo).port;
        s.close((err) => (err ? reject(err) : resolve(assigned)));
      });
    });
    if (port < 65535) {
      return port;
    }
  }
}

function waitForOpen(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitForError(ws: WebSocket) {
  return new Promise<Error>((resolve, reject) => {
    ws.once("error", (err) => resolve(err instanceof Error ? err : new Error(String(err))));
    ws.once("open", () => reject(new Error("expected websocket error")));
  });
}

// The real extension always connects with its chrome-extension:// origin; loopback + that origin
// is what the relay accepts without a token.
const EXTENSION_SOCKET_OPTS = { headers: { origin: "chrome-extension://relay-test" } };

function relayAuthHeaders(url: string) {
  return getChromeExtensionRelayAuthHeaders(url);
}

function createMessageQueue(ws: WebSocket) {
  const queue: string[] = [];
  let waiter: ((value: string) => void) | null = null;
  let waiterReject: ((err: Error) => void) | null = null;
  let waiterTimer: NodeJS.Timeout | null = null;

  const flushWaiter = (value: string) => {
    if (!waiter) {
      return false;
    }
    const resolve = waiter;
    waiter = null;
    const reject = waiterReject;
    waiterReject = null;
    if (waiterTimer) {
      clearTimeout(waiterTimer);
    }
    waiterTimer = null;
    if (reject) {
      // no-op (kept for symmetry)
    }
    resolve(value);
    return true;
  };

  ws.on("message", (data) => {
    const text =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.from(data).toString("utf8");
    if (flushWaiter(text)) {
      return;
    }
    queue.push(text);
  });

  ws.on("error", (err) => {
    if (!waiterReject) {
      return;
    }
    const reject = waiterReject;
    waiterReject = null;
    waiter = null;
    if (waiterTimer) {
      clearTimeout(waiterTimer);
    }
    waiterTimer = null;
    reject(err instanceof Error ? err : new Error(String(err)));
  });

  const next = (timeoutMs = 5000) =>
    new Promise<string>((resolve, reject) => {
      const existing = queue.shift();
      if (existing !== undefined) {
        return resolve(existing);
      }
      waiter = resolve;
      waiterReject = reject;
      waiterTimer = setTimeout(() => {
        waiter = null;
        waiterReject = null;
        waiterTimer = null;
        reject(new Error("timeout"));
      }, timeoutMs);
    });

  return { next };
}

async function waitForListMatch<T>(
  fetchList: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 2000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await fetchList();
    if (predicate(value)) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error("timeout waiting for list update");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("chrome extension relay server", () => {
  let cdpUrl = "";

  afterEach(async () => {
    if (cdpUrl) {
      await stopChromeExtensionRelayServer({ cdpUrl }).catch(() => {});
      cdpUrl = "";
    }
  });

  it("advertises CDP WS only when extension is connected", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const v1 = (await fetch(`${cdpUrl}/json/version`, {
      headers: relayAuthHeaders(cdpUrl),
    }).then((r) => r.json())) as {
      webSocketDebuggerUrl?: string;
    };
    expect(v1.webSocketDebuggerUrl).toBeUndefined();

    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`, EXTENSION_SOCKET_OPTS);
    await waitForOpen(ext);

    const v2 = (await fetch(`${cdpUrl}/json/version`, {
      headers: relayAuthHeaders(cdpUrl),
    }).then((r) => r.json())) as {
      webSocketDebuggerUrl?: string;
    };
    expect(String(v2.webSocketDebuggerUrl ?? "")).toContain(`/cdp`);

    ext.close();
  });

  it("rejects CDP access without relay auth token", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const res = await fetch(`${cdpUrl}/json/version`);
    expect(res.status).toBe(401);

    const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`);
    const err = await waitForError(cdp);
    expect(err.message).toContain("401");
  });

  it("tracks attached page targets and exposes them via CDP + /json/list", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`, EXTENSION_SOCKET_OPTS);
    await waitForOpen(ext);

    // Simulate a tab attach coming from the extension.
    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "cb-tab-1",
            targetInfo: {
              targetId: "t1",
              type: "page",
              title: "Example",
              url: "https://example.com",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    const list = (await fetch(`${cdpUrl}/json/list`, {
      headers: relayAuthHeaders(cdpUrl),
    }).then((r) => r.json())) as Array<{
      id?: string;
      url?: string;
      title?: string;
    }>;
    expect(list.some((t) => t.id === "t1" && t.url === "https://example.com")).toBe(true);

    // Simulate navigation updating tab metadata.
    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.targetInfoChanged",
          params: {
            targetInfo: {
              targetId: "t1",
              type: "page",
              title: "DER STANDARD",
              url: "https://www.derstandard.at/",
            },
          },
        },
      }),
    );

    const list2 = await waitForListMatch(
      async () =>
        (await fetch(`${cdpUrl}/json/list`, {
          headers: relayAuthHeaders(cdpUrl),
        }).then((r) => r.json())) as Array<{
          id?: string;
          url?: string;
          title?: string;
        }>,
      (list) =>
        list.some(
          (t) =>
            t.id === "t1" && t.url === "https://www.derstandard.at/" && t.title === "DER STANDARD",
        ),
    );
    expect(
      list2.some(
        (t) =>
          t.id === "t1" && t.url === "https://www.derstandard.at/" && t.title === "DER STANDARD",
      ),
    ).toBe(true);

    const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
      headers: relayAuthHeaders(`ws://127.0.0.1:${port}/cdp`),
    });
    await waitForOpen(cdp);
    const q = createMessageQueue(cdp);

    cdp.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
    const res1 = JSON.parse(await q.next()) as { id: number; result?: unknown };
    expect(res1.id).toBe(1);
    expect(JSON.stringify(res1.result ?? {})).toContain("t1");

    cdp.send(
      JSON.stringify({
        id: 2,
        method: "Target.attachToTarget",
        params: { targetId: "t1" },
      }),
    );
    const received: Array<{
      id?: number;
      method?: string;
      result?: unknown;
      params?: unknown;
    }> = [];
    received.push(JSON.parse(await q.next()) as never);
    received.push(JSON.parse(await q.next()) as never);

    const res2 = received.find((m) => m.id === 2);
    expect(res2?.id).toBe(2);
    expect(JSON.stringify(res2?.result ?? {})).toContain("cb-tab-1");

    const evt = received.find((m) => m.method === "Target.attachedToTarget");
    expect(evt?.method).toBe("Target.attachedToTarget");
    expect(JSON.stringify(evt?.params ?? {})).toContain("t1");

    cdp.close();
    ext.close();
  }, 15_000);

  it("rebroadcasts attach when a session id is reused for a new target", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`, EXTENSION_SOCKET_OPTS);
    await waitForOpen(ext);

    const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
      headers: relayAuthHeaders(`ws://127.0.0.1:${port}/cdp`),
    });
    await waitForOpen(cdp);
    const q = createMessageQueue(cdp);

    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "shared-session",
            targetInfo: {
              targetId: "t1",
              type: "page",
              title: "First",
              url: "https://example.com",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    const first = JSON.parse(await q.next()) as { method?: string; params?: unknown };
    expect(first.method).toBe("Target.attachedToTarget");
    expect(JSON.stringify(first.params ?? {})).toContain("t1");

    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "shared-session",
            targetInfo: {
              targetId: "t2",
              type: "page",
              title: "Second",
              url: "https://example.org",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    const received: Array<{ method?: string; params?: unknown }> = [];
    received.push(JSON.parse(await q.next()) as never);
    received.push(JSON.parse(await q.next()) as never);

    const detached = received.find((m) => m.method === "Target.detachedFromTarget");
    const attached = received.find((m) => m.method === "Target.attachedToTarget");
    expect(JSON.stringify(detached?.params ?? {})).toContain("t1");
    expect(JSON.stringify(attached?.params ?? {})).toContain("t2");

    cdp.close();
    ext.close();
  });
  describe("several browsers at once", () => {
    const graceEnv = "OPENCLAW_EXTENSION_RELAY_RECONNECT_GRACE_MS";
    let savedGrace: string | undefined;

    afterEach(() => {
      if (savedGrace === undefined) {
        delete process.env[graceEnv];
      } else {
        process.env[graceEnv] = savedGrace;
      }
    });

    type ForwardCommand = {
      id: number;
      method: string;
      params: { method: string; params?: Record<string, unknown>; sessionId?: string };
    };

    async function startRelay(graceMs?: number) {
      savedGrace = process.env[graceEnv];
      if (graceMs !== undefined) {
        process.env[graceEnv] = String(graceMs);
      }
      const port = await getFreePort();
      cdpUrl = `http://127.0.0.1:${port}`;
      await ensureChromeExtensionRelayServer({ cdpUrl });
      return port;
    }

    async function connectExtension(port: number, browserId?: string) {
      const query = browserId ? `?browserId=${browserId}` : "";
      const ws = new WebSocket(`ws://127.0.0.1:${port}/extension${query}`, EXTENSION_SOCKET_OPTS);
      const q = createMessageQueue(ws);
      await waitForOpen(ws);
      // Next forwardCDPCommand frame, skipping the relay's pings.
      const nextCommand = async (timeoutMs = 5000) => {
        while (true) {
          const msg = JSON.parse(await q.next(timeoutMs)) as ForwardCommand | { method: "ping" };
          if (msg.method === "forwardCDPCommand") {
            return msg as ForwardCommand;
          }
        }
      };
      return { ws, nextCommand };
    }

    function announceTab(ext: WebSocket, sessionId: string, targetId: string, url: string) {
      ext.send(
        JSON.stringify({
          method: "forwardCDPEvent",
          params: {
            method: "Target.attachedToTarget",
            params: {
              sessionId,
              targetInfo: { targetId, type: "page", title: url, url },
              waitingForDebugger: false,
            },
          },
        }),
      );
    }

    async function fetchList() {
      return (await fetch(`${cdpUrl}/json/list`, {
        headers: relayAuthHeaders(cdpUrl),
      }).then((r) => r.json())) as Array<{ id: string; url: string }>;
    }

    async function connectCdp(port: number) {
      const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
        headers: relayAuthHeaders(`ws://127.0.0.1:${port}/cdp`),
      });
      await waitForOpen(cdp);
      const q = createMessageQueue(cdp);
      // Next message matching the predicate; others are dropped.
      const nextMatching = async (
        predicate: (msg: Record<string, unknown>) => boolean,
        timeoutMs = 5000,
      ) => {
        const deadline = Date.now() + timeoutMs;
        while (true) {
          const msg = JSON.parse(await q.next(Math.max(1, deadline - Date.now()))) as Record<
            string,
            unknown
          >;
          if (predicate(msg)) {
            return msg;
          }
        }
      };
      return { cdp, nextMatching };
    }

    it("accepts a second extension and lists both browsers' tabs with distinct ids", async () => {
      const port = await startRelay();
      const a = await connectExtension(port);
      const b = await connectExtension(port);

      const status = (await fetch(`${cdpUrl}/extension/status`).then((r) => r.json())) as {
        connected: boolean;
      };
      expect(status.connected).toBe(true);

      // Both browsers use the same small counters for their first tab.
      announceTab(a.ws, "tc-tab-1", "T1", "https://a.example");
      announceTab(b.ws, "tc-tab-1", "T1", "https://b.example");

      const list = await waitForListMatch(fetchList, (l) => l.length === 2);
      const ids = list.map((t) => t.id);
      expect(new Set(ids).size).toBe(2);
      expect(list.find((t) => t.url === "https://a.example")?.id).toBe("T1");
      expect(list.find((t) => t.url === "https://b.example")?.id).not.toBe("T1");

      const { cdp, nextMatching } = await connectCdp(port);
      cdp.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
      const res = (await nextMatching((m) => m.id === 1)) as {
        result: { targetInfos: Array<{ targetId: string; url: string }> };
      };
      expect(res.result.targetInfos).toHaveLength(2);
      expect(new Set(res.result.targetInfos.map((t) => t.targetId)).size).toBe(2);

      cdp.close();
      a.ws.close();
      b.ws.close();
    }, 15_000);

    it("routes a command for browser B's tab only to B and returns B's answer", async () => {
      const port = await startRelay();
      const a = await connectExtension(port);
      const b = await connectExtension(port);
      announceTab(a.ws, "tc-tab-1", "T1", "https://a.example");
      announceTab(b.ws, "tc-tab-1", "T1", "https://b.example");
      await waitForListMatch(fetchList, (l) => l.length === 2);

      const { cdp, nextMatching } = await connectCdp(port);
      cdp.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
      const targets = (await nextMatching((m) => m.id === 1)) as {
        result: { targetInfos: Array<{ targetId: string; url: string }> };
      };
      const bTargetId = targets.result.targetInfos.find((t) => t.url === "https://b.example")
        ?.targetId as string;
      cdp.send(
        JSON.stringify({ id: 2, method: "Target.attachToTarget", params: { targetId: bTargetId } }),
      );
      const attach = (await nextMatching((m) => m.id === 2)) as { result: { sessionId: string } };
      const bSession = attach.result.sessionId;
      expect(bSession).not.toBe("tc-tab-1");

      // One command per browser, in flight at the same time.
      cdp.send(
        JSON.stringify({
          id: 10,
          method: "Runtime.evaluate",
          sessionId: bSession,
          params: { expression: "b" },
        }),
      );
      cdp.send(
        JSON.stringify({
          id: 11,
          method: "Runtime.evaluate",
          sessionId: "tc-tab-1",
          params: { expression: "a" },
        }),
      );

      const toB = await b.nextCommand();
      expect(toB.params.method).toBe("Runtime.evaluate");
      expect(toB.params.sessionId).toBe("tc-tab-1");
      expect(toB.params.params?.expression).toBe("b");
      const toA = await a.nextCommand();
      expect(toA.params.sessionId).toBe("tc-tab-1");
      expect(toA.params.params?.expression).toBe("a");

      // B answering with A's request id must not resolve A's request.
      b.ws.send(JSON.stringify({ id: toA.id, result: { value: "wrong browser" } }));
      b.ws.send(JSON.stringify({ id: toB.id, result: { value: "from b" } }));
      const resB = (await nextMatching((m) => m.id === 10)) as { result: unknown };
      expect(resB.result).toEqual({ value: "from b" });
      a.ws.send(JSON.stringify({ id: toA.id, result: { value: "from a" } }));
      const resA = (await nextMatching((m) => m.id === 11)) as { result: unknown };
      expect(resA.result).toEqual({ value: "from a" });

      // Neither browser saw the other's command.
      await expect(a.nextCommand(300)).rejects.toThrow("timeout");
      await expect(b.nextCommand(300)).rejects.toThrow("timeout");

      // The HTTP activate route reaches the owner too, with the id stripped.
      await fetch(`${cdpUrl}/json/activate/${encodeURIComponent(bTargetId)}`, {
        headers: relayAuthHeaders(cdpUrl),
      });
      const activate = await b.nextCommand();
      expect(activate.params.method).toBe("Target.activateTarget");
      expect(activate.params.params?.targetId).toBe("T1");

      cdp.close();
      a.ws.close();
      b.ws.close();
    }, 20_000);

    it("keeps browser B's tabs and the CDP client when browser A goes away", async () => {
      const port = await startRelay(200);
      const a = await connectExtension(port);
      const b = await connectExtension(port);
      announceTab(a.ws, "tc-tab-1", "T1", "https://a.example");
      announceTab(b.ws, "tc-tab-1", "T1", "https://b.example");
      await waitForListMatch(fetchList, (l) => l.length === 2);

      const { cdp, nextMatching } = await connectCdp(port);
      let cdpClosed = false;
      cdp.on("close", () => {
        cdpClosed = true;
      });

      a.ws.close();
      const detached = (await nextMatching((m) => m.method === "Target.detachedFromTarget")) as {
        params: { sessionId: string; targetId: string };
      };
      expect(detached.params.sessionId).toBe("tc-tab-1");
      expect(detached.params.targetId).toBe("T1");

      const list = await waitForListMatch(fetchList, (l) => l.length === 1);
      expect(list[0]?.url).toBe("https://b.example");
      expect(cdpClosed).toBe(false);

      cdp.send(
        JSON.stringify({
          id: 4,
          method: "Target.attachToTarget",
          params: { targetId: list[0]?.id },
        }),
      );
      const attach = (await nextMatching((m) => m.id === 4)) as { result: { sessionId: string } };
      cdp.send(
        JSON.stringify({ id: 5, method: "Page.reload", sessionId: attach.result.sessionId }),
      );
      const toB = await b.nextCommand();
      expect(toB.params.method).toBe("Page.reload");
      expect(toB.params.sessionId).toBe("tc-tab-1");
      b.ws.send(JSON.stringify({ id: toB.id, result: {} }));
      const res = (await nextMatching((m) => m.id === 5)) as { result?: unknown };
      expect(res.result).toEqual({});

      cdp.close();
      b.ws.close();
    }, 15_000);

    it("lets a browser reconnect into its own slot by browserId", async () => {
      const port = await startRelay();
      const a = await connectExtension(port, "browser-a");
      const b1 = await connectExtension(port, "browser-b");
      announceTab(b1.ws, "tc-tab-1", "T1", "https://b.example");
      const before = await waitForListMatch(fetchList, (l) => l.length === 1);

      // The same browser cannot hold two open sockets.
      const dup = new WebSocket(
        `ws://127.0.0.1:${port}/extension?browserId=browser-b`,
        EXTENSION_SOCKET_OPTS,
      );
      const err = await waitForError(dup);
      expect(err.message).toContain("409");

      // After its worker restarts it comes back with the same tab ids.
      await new Promise<void>((resolve) => {
        b1.ws.once("close", () => resolve());
        b1.ws.close();
      });
      const b2 = await connectExtension(port, "browser-b");
      announceTab(b2.ws, "tc-tab-1", "T1", "https://b.example");
      const after = await fetchList();
      expect(after.map((t) => t.id)).toEqual(before.map((t) => t.id));

      a.ws.close();
      b2.ws.close();
    }, 15_000);
  });
});
