import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { request } from "undici";
import { createSubsystemLogger } from "../logging/subsystem.js";

import { loadAllowlist, isDomainAllowed } from "./secrets-proxy-allowlist.js";

const logger = createSubsystemLogger("security/secrets-proxy");

const PLACEHOLDER_LIMITS = {
  maxDepth: 5, // Simple depth limit for nested replacements if we ever add them
  maxReplacements: 100,
  timeoutMs: 100,
};

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB max request body
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Replaces {{VAR_NAME}} with process.env.VAR_NAME.
 * Only replaces top-level for now to avoid complexity/security risks.
 */
function replacePlaceholders(text: string): string {
  let count = 0;
  return text.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (count++ >= PLACEHOLDER_LIMITS.maxReplacements) {
      return `{{LIMIT_REACHED:${name}}}`;
    }
    return process.env[name] ?? "";
  });
}

export type SecretsProxyOptions = {
  port: number;
  bind?: string;
};

export async function startSecretsProxy(opts: SecretsProxyOptions): Promise<http.Server> {
  const allowedDomains = loadAllowlist();

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Set request timeout
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      logger.warn(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`);
      if (!res.headersSent) {
        res.statusCode = 408;
        res.end("Request Timeout");
      }
    });

    try {
      const targetUrl = req.headers["x-target-url"];
      if (typeof targetUrl !== "string" || !targetUrl) {
        res.statusCode = 400;
        res.end("Missing X-Target-URL header");
        return;
      }

      // Validate target URL before checking allowlist
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(targetUrl);
      } catch {
        res.statusCode = 400;
        res.end("Invalid X-Target-URL");
        return;
      }

      if (!isDomainAllowed(targetUrl, allowedDomains)) {
        logger.warn(`Blocked request to unauthorized domain: ${parsedUrl.hostname}`);
        res.statusCode = 403;
        res.end(`Domain not in allowlist: ${parsedUrl.hostname}`);
        return;
      }

      // Read body with size limit and replace placeholders
      const chunks: Buffer[] = [];
      let totalSize = 0;
      for await (const chunk of req) {
        totalSize += chunk.length;
        if (totalSize > MAX_BODY_SIZE) {
          res.statusCode = 413;
          res.end(`Request body too large (max ${MAX_BODY_SIZE / 1024 / 1024}MB)`);
          return;
        }
        chunks.push(chunk);
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const modifiedBody = replacePlaceholders(rawBody);

      // Prepare headers - filter out hop-by-hop and the special target header
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (
          key.toLowerCase() === "x-target-url" ||
          key.toLowerCase() === "host" ||
          key.toLowerCase() === "connection"
        ) {
          continue;
        }
        if (typeof value === "string") {
          headers[key] = replacePlaceholders(value);
        }
      }

      logger.info(`Proxying request: ${req.method} ${targetUrl}`);

      const response = await request(targetUrl, {
        method: (req.method as any) || "POST",
        headers,
        body: modifiedBody,
      });

      res.statusCode = response.statusCode;
      for (const [key, value] of Object.entries(response.headers)) {
        if (value) {
          res.setHeader(key, value);
        }
      }

      // Stream the response back
      for await (const chunk of response.body) {
        res.write(chunk);
      }
      res.end();
    } catch (err) {
      logger.error(`Proxy error: ${String(err)}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(`Proxy Error: ${String(err)}`);
      } else {
        res.end();
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port, opts.bind || "127.0.0.1", () => {
      logger.info(`Secrets Injection Proxy listening on ${opts.bind || "127.0.0.1"}:${opts.port}`);
      resolve(server);
    });
  });
}
