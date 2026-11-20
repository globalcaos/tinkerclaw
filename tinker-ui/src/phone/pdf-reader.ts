// FORK 2026-10-21: a PDF link opened on the phone gets the same capabilities as on desktop. The pdf-review viewer (apps/pdf-review: comments, highlights, read-aloud, Redo,
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
export async function lastPdf(f: Fetch = fetch, signal?: AbortSignal): Promise<string | null> {
  const r = await f(`${PDF_BASE}/api/history`, { cache: "no-store", signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const { files } = (await r.json()) as { files?: { path: string }[] };
  return files?.[0]?.path ?? null;
}

// FORK 2026-11-20: 📄 opens without the Pi. Its first step asked the Pi which file was read last, with no
// time limit: a phone whose link to the Pi was down or stalled got no reader and no sign, although the
// viewer and the chapters are kept on the phone for that case (apps/pdf-review sw.js). The viewer's
// worker cannot cover this call, the Tinker page is outside its scope, so the same rule is applied here:
// the Pi first, then what this device holds.

/** How long 📄 waits for the Pi to name the file read last. A working link answers in about 0.1 s
 *  (measured from the phone over a relayed link); after this the file this device read last opens,
 *  which is nearly always the same one. */
export const PI_WAIT_MS = 1500;

/** The viewer writes it for every file it opens on this device (apps/pdf-review viewer/web/autoreload.js
 *  keepOpened), and its own offline page opens the same one. The Tinker page shares the viewer's origin. */
const LAST_KEY = "pdfreview.last";

/** The served path this device read last, or null (nothing yet, or storage is closed). */
export function lastPdfHere(): string | null {
  try {
    return localStorage.getItem(LAST_KEY) || null;
  } catch {
    return null;
  }
}

/** `lastPdf`, given up after `ms`. The unanswered call is aborted: left open, a few presses on a dead
 *  link would hold every connection this page has to the door. */
function lastPdfWithin(ms: number, f: Fetch): Promise<string | null> {
  const stop = new AbortController();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const late = new Error(`no answer in ${ms} ms`);
      stop.abort(late);
      reject(late);
    }, ms);
    lastPdf(f, stop.signal)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

type OpenLine = {
  /** pi: the Pi named the file. kept: it did not, this device's last file opened. recent: neither, the
   *  Recent list opened. link: a tapped file link. */
  via: "pi" | "kept" | "recent" | "link";
  path?: string | null;
  /** Why the Pi's answer was not used, or why a link did not open. */
  why?: string;
  ms: number;
};
const LOG_KEY = "tinker.pdfReaderLog";

/** One line per attempt to open the reader, in the viewer's own log on the Pi
 *  (~/.local/state/pdf-review.log: `grep -a reader-open`), so a reader that did not open can be read
 *  there instead of guessed. A line the Pi could not take waits on this device and goes with the next. */
function logOpen(line: OpenLine, f: Fetch): void {
  try {
    const waiting = JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]") as unknown[];
    const batch = [
      ...waiting,
      {
        id: "tinker",
        event: "reader-open",
        at: new Date().toISOString().slice(0, 19) + "Z",
        ...line,
      },
    ].slice(-20);
    localStorage.setItem(LOG_KEY, JSON.stringify(batch));
    void f(`${PDF_BASE}/api/clientlog`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
      keepalive: true,
    })
      .then((r) => {
        if (!r.ok) return;
        // Only what was sent goes: a press made meanwhile has its own line here.
        const sent = new Set(batch.map((l) => JSON.stringify(l)));
        const left = (JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]") as unknown[]).filter(
          (l) => !sent.has(JSON.stringify(l)),
        );
        if (left.length) localStorage.setItem(LOG_KEY, JSON.stringify(left));
        else localStorage.removeItem(LOG_KEY);
      })
      .catch(() => {});
  } catch {
    // the log must never stop the reader (storage closed or full)
  }
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
 *  reuses the same layer. No bar, title or ✕ (2026-10-25: no close button is needed, the phone's
 *  own back button already does it): Back closes it through window.__jarvisBack,
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

/** Open `path` (a file on the gateway's disk) or, with null, the PDF read last. A file link needs the
 *  Pi to serve the file, so it still fails when the Pi is out of reach; the PDF read last does not
 *  (above): it opens from this device and never throws for a Pi that is silent. */
export async function openPdfReader(
  path: string | null,
  f: Fetch = fetch,
  doc: Document = document,
): Promise<void> {
  const t0 = Date.now();
  const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));
  if (path) {
    try {
      const where = await servePdf(path, f);
      showPdfReader(pdfViewerUrl(where), doc);
      logOpen({ via: "link", path: where, ms: Date.now() - t0 }, f);
    } catch (err) {
      logOpen({ via: "link", why: reason(err), ms: Date.now() - t0 }, f);
      throw err;
    }
    return;
  }
  let where: string | null;
  let why: string | undefined;
  try {
    where = await lastPdfWithin(PI_WAIT_MS, f);
  } catch (err) {
    why = reason(err);
    where = lastPdfHere();
    console.warn(
      "[phone] the Pi did not name the PDF read last; opening what this device holds",
      why,
    );
  }
  showPdfReader(pdfViewerUrl(where), doc);
  const via = why === undefined ? "pi" : where ? "kept" : "recent";
  logOpen({ via, path: where, why, ms: Date.now() - t0 }, f);
}

/** FORK 2026-10-28 (a comment marker accepts a voice note dictated into its text
 *  box by holding the side key). The side-key hold already ends in
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
