/**
 * The two loopback routes the hook scripts call (contract C-CONTRACT.md "HTTP"): POST /plugins/amygdala2/decide and
 * /plugins/amygdala2/wait. Pure `(req, res)` handlers: the plugin registers them with auth "plugin", so the bearer token
 * check below is the only gate. The work is never tied to the client's connection: the shadow hooks hang up after
 * 150 ms and the decision must still be persisted.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HookAction } from "./hook-action.js";
import type { Seam } from "./types.js";

export const DECIDE_PATH = "/plugins/amygdala2/decide";
export const WAIT_PATH = "/plugins/amygdala2/wait";
/** Notes waiting for this chat's next hook call (2026-10-03): answered at once, never waits on the judge. */
export const NOTES_PATH = "/plugins/amygdala2/notes";
export const MAX_BODY_BYTES = 256 * 1024;
const MAX_WAIT_MS = 600_000;
const SEAMS: readonly Seam[] = ["prompt", "pre-tool", "post-tool", "stop"];

export interface HttpRuntime {
  decide(
    seam: Seam,
    hook: Record<string, unknown>,
    tabKey?: string,
  ): Promise<{ decisionId: string; hook: HookAction }>;
  waitFor(interventionId: string, timeoutMs: number): Promise<{ answer: string; text?: string }>;
  takeNotes(sessionKey: string): string[];
}

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

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
    /* the client is gone; the work is already done */
  }
}

/** Bearer token compare in constant time; different lengths are rejected without comparing. */
function tokenOk(header: string | string[] | undefined, token: string): boolean {
  if (token === "" || typeof header !== "string") return false;
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

type Body = { ok: true; text: string } | { ok: false; reason: "too-large" | "aborted" };

function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (b: Body): void => {
      if (settled) return;
      settled = true;
      resolve(b);
    };
    req.on("data", (c: Buffer) => {
      if (settled) return; // keep draining an oversized body so the 413 can be delivered
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        done({ ok: false, reason: "too-large" });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => done({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", () => done({ ok: false, reason: "aborted" }));
    // A hang-up before the body is complete: nothing was received, nothing to process.
    req.on("close", () => done({ ok: false, reason: "aborted" }));
  });
}

export function createHttpHandlers(
  runtime: HttpRuntime,
  tokenProvider: () => string,
): { decide: RouteHandler; wait: RouteHandler; notes: RouteHandler } {
  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    run: (body: Record<string, unknown>) => Promise<void>,
  ): Promise<boolean> {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      send(res, 405, { ok: false, error: "method not allowed" });
      return true;
    }
    if (!tokenOk(req.headers.authorization, tokenProvider())) {
      send(res, 401, { ok: false, error: "unauthorized" });
      req.resume();
      return true;
    }
    const body = await readBody(req);
    if (!body.ok) {
      if (body.reason === "too-large") send(res, 413, { ok: false, error: "body too large" });
      return true;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      send(res, 400, { ok: false, error: "invalid JSON" });
      return true;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      send(res, 400, { ok: false, error: "body must be a JSON object" });
      return true;
    }
    await run(parsed as Record<string, unknown>);
    return true;
  }

  const decide: RouteHandler = (req, res) =>
    handle(req, res, async (b) => {
      const seam = b.seam;
      const hook = b.hook;
      if (
        typeof seam !== "string" ||
        !SEAMS.includes(seam as Seam) ||
        !hook ||
        typeof hook !== "object" ||
        Array.isArray(hook)
      ) {
        send(res, 400, { ok: false, error: "expected {seam, hook}" });
        return;
      }
      try {
        const r = await runtime.decide(
          seam as Seam,
          hook as Record<string, unknown>,
          typeof b.tabKey === "string" && b.tabKey !== "" ? b.tabKey : undefined,
        );
        send(res, 200, { ok: true, decisionId: r.decisionId, hook: r.hook });
      } catch (err) {
        console.error("[amygdala] decide failed", err);
        send(res, 200, { ok: false, hook: { kind: "none" } });
      }
    });

  const wait: RouteHandler = (req, res) =>
    handle(req, res, async (b) => {
      const id = b.interventionId;
      const ms = b.timeoutMs;
      if (typeof id !== "string" || id === "" || typeof ms !== "number" || !Number.isFinite(ms)) {
        send(res, 400, { ok: false, error: "expected {interventionId, timeoutMs}" });
        return;
      }
      try {
        const r = await runtime.waitFor(id, Math.min(Math.max(ms, 0), MAX_WAIT_MS));
        send(res, 200, r);
      } catch (err) {
        console.error("[amygdala] wait failed", err);
        send(res, 200, { answer: "timeout" });
      }
    });

  const notes: RouteHandler = (req, res) =>
    handle(req, res, async (b) => {
      const key =
        typeof b.tabKey === "string" && b.tabKey !== ""
          ? b.tabKey
          : typeof b.session_id === "string" && b.session_id !== ""
            ? b.session_id
            : null;
      if (!key) {
        send(res, 400, { ok: false, error: "expected {tabKey} or {session_id}" });
        return;
      }
      send(res, 200, { ok: true, notes: runtime.takeNotes(key) });
    });

  return { decide, wait, notes };
}
