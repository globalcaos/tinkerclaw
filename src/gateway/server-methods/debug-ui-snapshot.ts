/**
 * FORK 2026-05-09 — `debug.dumpUiSnapshot` RPC.
 *
 * Tinker UI calls this on every chat re-render so I (the architect-side
 * Claude Code session) can introspect the actual rendered DOM by reading a
 * file on disk, instead of round-tripping through the browser relay or
 * asking the user "what does it look like?". File mirror lives at
 *   ~/.openclaw/data/tinker-ui-snapshot.html  (the chat-area HTML)
 *   ~/.openclaw/data/tinker-ui-snapshot.json  (timestamp + viewport + url + computedStyles)
 *
 * Trust model: writes a known-name file under ~/.openclaw/data/ only. Caller
 * can't pick the path. Body size capped at 2 MB.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GatewayRequestHandlers } from "./types.js";

const SNAPSHOT_DIR = path.join(os.homedir(), ".openclaw/data");
const HTML_PATH = path.join(SNAPSHOT_DIR, "tinker-ui-snapshot.html");
const META_PATH = path.join(SNAPSHOT_DIR, "tinker-ui-snapshot.json");
const MAX_HTML_BYTES = 2 * 1024 * 1024;

export const debugUiSnapshotHandlers: GatewayRequestHandlers = {
  "debug.dumpUiSnapshot": async ({ params, respond }) => {
    const p = (params ?? {}) as {
      html?: unknown;
      css?: unknown;
      viewport?: unknown;
      url?: unknown;
      computedStyles?: unknown;
    };
    const html = typeof p.html === "string" ? p.html : "";
    if (!html) {
      respond(true, { ok: false, reason: "html required" }, undefined);
      return;
    }
    const truncated = html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html;
    const meta = {
      ts: new Date().toISOString(),
      bytes: truncated.length,
      truncated: html.length > MAX_HTML_BYTES,
      viewport: p.viewport ?? null,
      url: typeof p.url === "string" ? p.url : null,
      computedStyles: p.computedStyles ?? null,
    };

    try {
      await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
      await Promise.all([
        fs.writeFile(HTML_PATH, truncated, "utf-8"),
        fs.writeFile(META_PATH, JSON.stringify(meta, null, 2) + "\n", "utf-8"),
      ]);
      respond(true, { ok: true, htmlPath: HTML_PATH, metaPath: META_PATH }, undefined);
    } catch (err) {
      respond(true, { ok: false, reason: (err as Error).message }, undefined);
    }
  },
};
