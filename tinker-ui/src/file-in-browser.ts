// FORK 2026-10-15: pdf and md links must open when the agent runs on another machine. A file link used to open on the GATEWAY's desktop (xdg-open). When the
// page is not on the gateway's machine, or that machine has no desktop, the file is fetched over
// the socket (config.readExternalFile) and shown in a new browser tab instead.
import DOMPurify from "dompurify";

/** True when the page was not loaded from this machine's loopback, so the gateway is elsewhere. */
export function pageIsRemote(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return !(h === "localhost" || h === "::1" || /^127\./.test(h));
}

export type ReadFileReply = { ok?: boolean; name?: string; mime?: string; base64?: string };

function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

const PAGE_STYLE =
  "body{max-width:900px;margin:2em auto;padding:0 1.2em;font:16px/1.55 system-ui,sans-serif;" +
  "color:#2b2118;background:#fbf6ec}pre,code{background:#efe6d4;border-radius:4px}pre{padding:.8em;" +
  "overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #d6c7a8;padding:.3em .6em}" +
  "img{max-width:100%}";

/**
 * The tab's content. Markdown is rendered (sanitized); HTML runs only inside a sandboxed frame
 * with no same-origin access, so a page on disk cannot act with the Tinker login; anything else
 * keeps its own type (PDF, images, audio, video) or shows as UTF-8 text.
 */
export function viewerBlob(reply: ReadFileReply, renderMarkdown: (md: string) => string): Blob {
  const bin = atob(reply.base64 ?? "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const name = esc(reply.name ?? "file");
  if (reply.mime === "text/markdown") {
    const body = DOMPurify.sanitize(renderMarkdown(new TextDecoder().decode(bytes)));
    const html = `<!doctype html><meta charset="utf-8"><title>${name}</title><style>${PAGE_STYLE}</style>${body}`;
    return new Blob([html], { type: "text/html" });
  }
  if (reply.mime === "text/html") {
    const src = esc(new TextDecoder().decode(bytes));
    const html =
      `<!doctype html><meta charset="utf-8"><title>${name}</title>` +
      `<style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style>` +
      `<iframe sandbox="allow-scripts allow-popups" srcdoc="${src}"></iframe>`;
    return new Blob([html], { type: "text/html" });
  }
  const type = !reply.mime || reply.mime === "text/plain" ? "text/plain;charset=utf-8" : reply.mime;
  return new Blob([bytes], { type });
}
