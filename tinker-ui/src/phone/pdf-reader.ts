// FORK 2026-10-21 (the architect: "When I click on a pdf link from the phone I want the capabilities we have on
// desktop to work"). The pdf-review viewer (apps/pdf-review: comments, highlights, read-aloud, Redo,
// 🕘 Recent) is served under /pdf/ by tinker-prod-ui, so the phone reaches it through the phone door.
// It opens in a full-screen layer over the chat instead of a page change, so the chat keeps its socket
// and Back (window.__jarvisBack, through phone-mode) closes the layer.
//   - a .pdf file link tapped in phone mode: POST /pdf/api/open links the file and names its served path;
//   - 📄 in the phone dropdown: the most recent file in /pdf/api/history, or the Recent list when none.

export const PDF_BASE = "/pdf";
const LAYER_ID = "pdf-reader-layer";

/** The viewer URL for a served path ("/papers/open/…/x.pdf"); encoded twice, as open-pdf does. */
export function pdfViewerUrl(where: string | null): string {
  const viewer = `${PDF_BASE}/viewer/web/viewer.html`;
  if (!where) return `${viewer}?file=&recent=1`;
  const path = PDF_BASE + where.split("/").map(encodeURIComponent).join("/");
  return `${viewer}?file=${encodeURIComponent(path)}`;
}

export function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path.trim());
}

type Fetch = typeof fetch;

/** The served path of a file on the gateway's disk; throws with the server's reason. */
export async function servePdf(path: string, f: Fetch = fetch): Promise<string> {
  const r = await f(`${PDF_BASE}/api/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const body = (await r.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!r.ok || !body.path) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body.path;
}

/** The served path of the PDF read last, or null when nothing was opened yet. */
export async function lastPdf(f: Fetch = fetch): Promise<string | null> {
  const r = await f(`${PDF_BASE}/api/history`, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const { files } = (await r.json()) as { files?: { path: string }[] };
  return files?.[0]?.path ?? null;
}

export function pdfReaderOpen(doc: Document = document): boolean {
  return Boolean(doc.getElementById(LAYER_ID));
}

export function closePdfReader(doc: Document = document): boolean {
  const layer = doc.getElementById(LAYER_ID);
  if (!layer) return false;
  layer.remove();
  doc.body.classList.remove("pdf-reader-open");
  return true;
}

/** Show the viewer over the chat at `url`; replaces a layer already open. Zen Mail (/zen/, 2026-10-21)
 *  reuses the same layer. No bar, title or ✕ (the architect, 2026-10-25: "We don't even need the close button
 *  since the phone's default back button works already"): Back closes it through window.__jarvisBack,
 *  Escape on a narrow desktop window; `title` only names the frame for screen readers. */
export function showPdfReader(
  url: string,
  doc: Document = document,
  title = "PDF reader",
): HTMLElement {
  closePdfReader(doc);
  const layer = doc.createElement("div");
  layer.id = LAYER_ID;
  const frame = doc.createElement("iframe");
  frame.className = "pdf-reader-frame";
  frame.setAttribute("title", title);
  frame.src = url;
  layer.appendChild(frame);
  doc.body.appendChild(layer);
  doc.body.classList.add("pdf-reader-open");
  return layer;
}

/** Open `path` (a file on the gateway's disk) or, with null, the PDF read last. */
export async function openPdfReader(
  path: string | null,
  f: Fetch = fetch,
  doc: Document = document,
): Promise<void> {
  const where = path ? await servePdf(path, f) : await lastPdf(f);
  showPdfReader(pdfViewerUrl(where), doc);
}

/** FORK 2026-10-28 (the architect: "When I put a comment marker, I want to be able to input a voice note that
 *  goes into the text box ... press and hold on the lock button"). The side-key hold already ends in
 *  window.__jarvisAssist(text); while a PDF comment box is open in the reader layer, the words go into
 *  that box (the viewer's window.__pdfDictate, apps/pdf-review tools.js) instead of the chat.
 *  true = the viewer took them; false = no layer, no open comment box, or a frame from elsewhere. */
export function pdfDictate(text: string, doc: Document = document): boolean {
  const frame = doc.querySelector<HTMLIFrameElement>(`#${LAYER_ID} iframe`);
  try {
    const dictate = (
      frame?.contentWindow as (Window & { __pdfDictate?: (t: string) => boolean }) | null
    )?.__pdfDictate;
    return typeof dictate === "function" && dictate(text) === true;
  } catch {
    return false; // a cross-origin frame (Zen Mail on another host) cannot be reached
  }
}
