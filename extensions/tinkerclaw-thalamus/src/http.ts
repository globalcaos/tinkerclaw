// The Claude Code short-list route (charter phase D1; design doc section 13A.5).
//
// WHAT THIS IS FOR. A Claude Code `UserPromptSubmit` hook can return `additionalContext`. The hook script
// (`hooks/prompt-shortlist.mjs`) posts the prompt here and prints whatever this returns. The same seam, `prepare()`,
// serves the embedded runner's `before_prompt_build`, so the two lanes cannot disagree about what a list is.
//
// SHADOW ANSWERS EMPTY. The list is computed and recorded, and the reply carries no `additionalContext`, so the agent's
// context is untouched. Only `enforce` returns the note.
//
// THE ROUTE IS LOOPBACK AND TOKENED. The plugin registers it with auth "plugin", so the bearer token below is the only
// gate; it is compared in constant time. The work is never tied to the client's connection, and a slow or failed
// list answers `{}`: the hook prints nothing and the prompt goes through.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReadInput } from "./reads/routing-reader.js";
import type { Prepared } from "./shortlist-seam.js";

export const SHORTLIST_PATH = "/plugins/thalamus/shortlist";
export const DIGEST_PATH = "/plugins/thalamus/digest";
export const MAX_BODY_BYTES = 64 * 1024;

export type ShortlistRuntime = {
  prepare(input: ReadInput & { runId: string }): Promise<Prepared>;
  sourceOf(sessionKey: string): string;
};

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export const newToken = (): string => randomBytes(24).toString("hex");

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  try {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  } catch {
    /* the client is gone */
  }
}

export function tokenOk(header: string | string[] | undefined, token: string): boolean {
  if (token === "" || typeof header !== "string") return false;
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string | undefined> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        resolve(undefined);
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(undefined));
  });
}

export function createShortlistHandler(
  rt: ShortlistRuntime,
  token: () => string,
  now: () => number = Date.now,
): RouteHandler {
  return async (req, res) => {
    const url = (req.url ?? "").split("?")[0];
    if (url !== SHORTLIST_PATH) return false;
    if (req.method !== "POST") {
      send(res, 405, { error: "method" });
      return true;
    }
    if (!tokenOk(req.headers.authorization, token())) {
      send(res, 401, { error: "token" });
      return true;
    }
    const raw = await readBody(req);
    if (raw === undefined) {
      send(res, 413, {});
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      send(res, 400, { error: "json" });
      return true;
    }
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const sessionKey =
      typeof body.session_key === "string" && body.session_key
        ? body.session_key
        : typeof body.session_id === "string"
          ? body.session_id
          : "";
    if (!prompt || !sessionKey) {
      send(res, 200, {});
      return true;
    }
    try {
      const runId = `cc:${sessionKey}:${now()}`;
      const out = await rt.prepare({
        id: runId,
        runId,
        ts: now(),
        sessionKey,
        text: prompt,
        source: rt.sourceOf(sessionKey),
        trigger: "user",
      });
      send(res, 200, out.text ? { additionalContext: out.text } : {});
    } catch {
      send(res, 200, {});
    }
    return true;
  };
}

export type DigestRuntime = {
  /** The replacement text for a long tool result of this session's latest run, or undefined to keep it. */
  digest(input: {
    sessionKey: string;
    toolName: string;
    toolCallId: string;
    text: string;
  }): Promise<string | undefined>;
};

/**
 * The Claude Code `PostToolUse` route (design D3). The hook script (`hooks/post-tool-digest.mjs`) posts the tool's
 * largest text here; a digest comes back only in enforce with `enforce.digest`, and only when the run has a base and the
 * decision pays. Everything else, and every failure, answers `{}`: the tool's output reaches the model untouched.
 */
export function createDigestHandler(
  rt: DigestRuntime,
  token: () => string,
  maxBodyBytes = 4 * MAX_BODY_BYTES,
): RouteHandler {
  return async (req, res) => {
    const url = (req.url ?? "").split("?")[0];
    if (url !== DIGEST_PATH) return false;
    if (req.method !== "POST") {
      send(res, 405, { error: "method" });
      return true;
    }
    if (!tokenOk(req.headers.authorization, token())) {
      send(res, 401, { error: "token" });
      return true;
    }
    const raw = await readBody(req, maxBodyBytes);
    if (raw === undefined) {
      send(res, 413, {});
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      send(res, 400, { error: "json" });
      return true;
    }
    const sessionKey = typeof body.tc_session_key === "string" ? body.tc_session_key : "";
    const toolName = typeof body.tool_name === "string" ? body.tool_name : "";
    const toolCallId = typeof body.tool_use_id === "string" ? body.tool_use_id : "";
    const text = typeof body.text === "string" ? body.text : "";
    if (!sessionKey || !toolName || !text) {
      send(res, 200, {});
      return true;
    }
    try {
      const out = await rt.digest({
        sessionKey,
        toolName,
        toolCallId: toolCallId || `cc:${toolName}`,
        text,
      });
      send(res, 200, out ? { text: out } : {});
    } catch {
      send(res, 200, {});
    }
    return true;
  };
}
