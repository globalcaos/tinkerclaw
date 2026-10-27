// FORK 2026-10-21 (the architect): the PDF reader layer on the phone.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closePdfReader,
  isPdfPath,
  lastPdf,
  openPdfReader,
  pdfReaderOpen,
  pdfViewerUrl,
  servePdf,
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
