import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetLocalHelperForTest,
  bytesToBase64,
  callLocalHelper,
  localHelperAvailable,
  openWithLocalApp,
} from "./local-helper.js";

// A stand-in for the plugin's content script: answers each request with handler(msg).
function plugin(handler: (msg: Record<string, unknown>) => unknown) {
  window.addEventListener("message", (ev: MessageEvent) => {
    const d = ev.data as { __tinkerLocal?: string; id?: string; msg?: Record<string, unknown> };
    if (d?.__tinkerLocal !== "req") return;
    const res = handler(d.msg ?? {});
    queueMicrotask(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { __tinkerLocal: "res", id: d.id, res },
          source: window,
        }),
      ),
    );
  });
}
const post = (data: unknown) =>
  window.dispatchEvent(new MessageEvent("message", { data, source: window }));

describe("local helper bridge", () => {
  beforeEach(() => __resetLocalHelperForTest());

  it("without the plugin nothing answers: null, and the helper reads as unavailable", async () => {
    expect(await callLocalHelper({ action: "ping" }, 50, post)).toBeNull();
  });

  it("opens by path when the file exists here; sends the bytes only when it is missing", async () => {
    const seen: Array<Record<string, unknown>> = [];
    plugin((m) => {
      seen.push(m);
      if (m.action === "ping") return { ok: true };
      if (m.base64) return { ok: true, copied: true };
      return m.path === "/here.pdf" ? { ok: true } : { ok: false, missing: true };
    });
    window.postMessage = ((d: unknown) => post(d)) as typeof window.postMessage;
    expect(await localHelperAvailable()).toBe(true);
    let reads = 0;
    const read = async () => (reads++, { ok: true, name: "a.md", base64: "aGk=" });
    expect((await openWithLocalApp("/here.pdf", read)).ok).toBe(true);
    expect(reads).toBe(0);
    const r = await openWithLocalApp("/only/on/pi.md", read);
    expect(r).toMatchObject({ ok: true, copied: true });
    expect(reads).toBe(1);
    expect(seen.at(-1)).toMatchObject({ action: "open", name: "a.md", base64: "aGk=" });
  });

  it("base64 survives large buffers", () => {
    const buf = new Uint8Array(100_000).map((_, i) => i % 256).buffer;
    expect(atob(bytesToBase64(buf)).length).toBe(100_000);
  });
});
