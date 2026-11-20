// FORK 2026-10-21 (the architect): the PDF reader layer on the phone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closePdfReader,
  isPdfPath,
  lastPdf,
  openPdfReader,
  pdfDictate,
  pdfReaderOpen,
  pdfViewerUrl,
  PI_WAIT_MS,
  servePdf,
  showPdfReader,
} from "./pdf-reader.js";

const reply = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );

afterEach(() => {
  closePdfReader();
});

describe("pdf-reader", () => {
  it("encodes the served path twice under /pdf, as open-pdf does on the desktop", () => {
    const url = pdfViewerUrl("/papers/open/ab12/My paper #2.pdf");
    expect(url.startsWith("/pdf/viewer/web/viewer.html?file=")).toBe(true);
    const file = decodeURIComponent(url.split("file=")[1]!);
    expect(file).toBe("/pdf/papers/open/ab12/My%20paper%20%232.pdf");
  });

  it("with nothing read yet the viewer opens on the Recent list", () => {
    expect(pdfViewerUrl(null)).toBe("/pdf/viewer/web/viewer.html?file=&recent=1");
  });

  it("knows a PDF path", () => {
    expect(isPdfPath("~/Documents/a.PDF")).toBe(true);
    expect(isPdfPath("~/Documents/a.md")).toBe(false);
  });

  it("asks the server to serve the file and passes its refusal on", async () => {
    const f = vi.fn(() => reply(200, { path: "/papers/open/x/a.pdf" }));
    expect(await servePdf("~/Documents/a.pdf", f as unknown as typeof fetch)).toBe(
      "/papers/open/x/a.pdf",
    );
    expect(f).toHaveBeenCalledWith("/pdf/api/open", expect.objectContaining({ method: "POST" }));
    const no = vi.fn(() => reply(403, { error: "outside the folders the viewer may open" }));
    await expect(servePdf("/tmp/a.pdf", no as unknown as typeof fetch)).rejects.toThrow(/outside/);
  });

  it("the last PDF is the first in the history, or none", async () => {
    const some = vi.fn(() =>
      reply(200, { files: [{ path: "/papers/b.pdf" }, { path: "/papers/a.pdf" }] }),
    );
    expect(await lastPdf(some as unknown as typeof fetch)).toBe("/papers/b.pdf");
    const none = vi.fn(() => reply(200, { files: [] }));
    expect(await lastPdf(none as unknown as typeof fetch)).toBeNull();
  });

  it("opens one bare layer over the page (no bar, no ✕), and Back closes it", async () => {
    const f = vi.fn(() => reply(200, { files: [{ path: "/papers/b.pdf" }] }));
    await openPdfReader(null, f as unknown as typeof fetch);
    await openPdfReader(null, f as unknown as typeof fetch);
    expect(document.querySelectorAll("#pdf-reader-layer")).toHaveLength(1);
    expect(
      document.querySelector<HTMLIFrameElement>("#pdf-reader-layer iframe")!.getAttribute("src"),
    ).toBe(pdfViewerUrl("/papers/b.pdf"));
    expect(document.querySelector("#pdf-reader-layer button")).toBeNull();
    expect(document.querySelector("#pdf-reader-layer")!.children).toHaveLength(1);
    expect(closePdfReader()).toBe(true);
    expect(pdfReaderOpen()).toBe(false);
    await openPdfReader(null, f as unknown as typeof fetch);
    expect(closePdfReader()).toBe(true);
    expect(closePdfReader()).toBe(false);
  });
});

// 2026-11-20: the first step of 📄 asked the Pi which file was read last, with no time limit. With the Pi
// out of reach (a phone on a weak relayed link) it opened nothing and said nothing, although the viewer
// and the chapters are kept on the phone for exactly that case.
describe("📄 when the Pi does not answer", () => {
  const LAST = "pdfreview.last"; // the viewer writes it for every file it opens on this device
  const WAITING = "tinker.pdfReaderLog";
  const frameSrc = () =>
    document.querySelector<HTMLIFrameElement>("#pdf-reader-layer iframe")?.getAttribute("src");
  // A call the Pi never answers. Like the browser's fetch, it ends only when it is aborted.
  const silent = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }),
  );

  beforeEach(() => {
    localStorage.clear();
    silent.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the file this device read last, and lets go of the unanswered call", async () => {
    localStorage.setItem(LAST, "/papers/open/71c6/ch10.pdf");
    // Not awaited: before the fix this call never ended, and a test that waits for it hangs with it.
    void openPdfReader(null, silent as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(PI_WAIT_MS - 1);
    expect(frameSrc()).toBeUndefined(); // still waiting for the Pi
    await vi.advanceTimersByTimeAsync(1);
    expect(frameSrc()).toBe(pdfViewerUrl("/papers/open/71c6/ch10.pdf"));
    // Not left hanging: six of them would use up every connection the page has to the door.
    const history = silent.mock.calls.find(([url]) => url === "/pdf/api/history")!;
    expect(history[1]?.signal?.aborted).toBe(true);
  });

  it("does not wait when the call fails outright", async () => {
    localStorage.setItem(LAST, "/papers/open/71c6/ch10.pdf");
    const down = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    await openPdfReader(null, down as unknown as typeof fetch);
    expect(frameSrc()).toBe(pdfViewerUrl("/papers/open/71c6/ch10.pdf"));
  });

  it("opens the Recent list when this device has read nothing yet", async () => {
    const down = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    await openPdfReader(null, down as unknown as typeof fetch);
    expect(frameSrc()).toBe(pdfViewerUrl(null));
  });

  it("the Pi's answer still wins when it comes in time", async () => {
    localStorage.setItem(LAST, "/papers/open/71c6/ch10.pdf"); // another file was read elsewhere since
    const f = vi.fn(() => reply(200, { files: [{ path: "/papers/open/71c6/ch11.pdf" }] }));
    await openPdfReader(null, f as unknown as typeof fetch);
    expect(frameSrc()).toBe(pdfViewerUrl("/papers/open/71c6/ch11.pdf"));
  });

  it("keeps the line about a press the Pi could not hear, and sends it with the next one", async () => {
    localStorage.setItem(LAST, "/papers/open/71c6/ch10.pdf");
    const down = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    await openPdfReader(null, down as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(0);
    const waiting = JSON.parse(localStorage.getItem(WAITING)!) as Record<string, unknown>[];
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      id: "tinker",
      event: "reader-open",
      via: "kept",
      why: "Failed to fetch",
      path: "/papers/open/71c6/ch10.pdf",
    });

    const up = vi.fn((url: string, _init?: RequestInit) =>
      url === "/pdf/api/clientlog"
        ? Promise.resolve(new Response(null, { status: 204 }))
        : reply(200, { files: [{ path: "/papers/open/71c6/ch10.pdf" }] }),
    );
    await openPdfReader(null, up as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(0);
    const posted = up.mock.calls.find(([url]) => url === "/pdf/api/clientlog")!;
    const lines = JSON.parse(String(posted[1]!.body)) as Record<string, unknown>[];
    expect(lines.map((l) => l.via)).toEqual(["kept", "pi"]);
    expect(localStorage.getItem(WAITING)).toBeNull();
  });
});

describe("pdfDictate (side-key voice into a PDF comment)", () => {
  it("is false with no reader layer, so the words go to the chat", () => {
    expect(pdfDictate("hello")).toBe(false);
  });

  it("hands the words to the viewer and reports whether a comment box took them", () => {
    const layer = showPdfReader("about:blank");
    const win = layer.querySelector("iframe")!.contentWindow as Window & {
      __pdfDictate?: (t: string) => boolean;
    };
    const got: string[] = [];
    win.__pdfDictate = (t) => (got.push(t), true);
    expect(pdfDictate("make this shorter")).toBe(true);
    expect(got).toEqual(["make this shorter"]);
    win.__pdfDictate = () => false; // comment box closed
    expect(pdfDictate("open the chat")).toBe(false);
  });
});
