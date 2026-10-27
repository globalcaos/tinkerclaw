// Where the viewer is mounted. On the desktop it is served at the root (http://127.0.0.1:18820/viewer/…);
// on the phone it comes through Tinker under /pdf/ (tinker-prod-ui proxies /pdf/* to this server), so
// every call to the server and every file path carries that prefix (2026-10-21).
export const BASE = location.pathname.replace(/\/viewer\/web\/[^/]*$/, "");

// A file URL as the server knows it: its path with the mount prefix taken off ("/papers/…").
export function served(url) {
  const p = new URL(url, location.href).pathname;
  return BASE && p.startsWith(`${BASE}/`) ? p.slice(BASE.length) : p;
}

// The viewer opened on a served path ("/papers/open/…/x.pdf"). Encoded twice, as open-pdf does: the
// viewer decodes `file=` once, and the path must stay a URL path after that.
export function viewerUrl(where) {
  const path = BASE + where.split("/").map(encodeURIComponent).join("/");
  return `${BASE}/viewer/web/viewer.html?file=${encodeURIComponent(path)}`;
}

// A phone or tablet: no file manager or desktop editor to open on the far machine.
export const TOUCH = matchMedia("(pointer: coarse)").matches;
