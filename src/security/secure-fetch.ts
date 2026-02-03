/**
 * Secure Fetch Wrapper
 * 
 * Intercepts all fetch() calls and routes them through the secrets injection proxy.
 * This must be loaded BEFORE any other modules that make HTTP requests.
 */
import process from "node:process";

const PROXY_URL = process.env.PROXY_URL || "http://host.docker.internal:8080";

// Store the original fetch
const originalFetch = globalThis.fetch;

/**
 * Wraps fetch to route all requests through the secrets proxy.
 * Adds X-Target-URL header with the original destination.
 */
async function secureFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  // Only intercept if we're in secure mode
  if (process.env.OPENCLAW_SECURE_MODE !== "1") {
    return originalFetch(input, init);
  }

  // Extract the target URL
  let targetUrl: string;
  if (typeof input === "string") {
    targetUrl = input;
  } else if (input instanceof URL) {
    targetUrl = input.toString();
  } else if (input instanceof Request) {
    targetUrl = input.url;
  } else {
    // Fallback - shouldn't happen but just in case
    return originalFetch(input, init);
  }

  // Skip proxy for local requests
  if (
    targetUrl.startsWith("http://localhost") ||
    targetUrl.startsWith("http://127.0.0.1") ||
    targetUrl.startsWith("http://host.docker.internal")
  ) {
    return originalFetch(input, init);
  }

  // Build new headers with X-Target-URL
  const headers = new Headers(init?.headers);
  headers.set("X-Target-URL", targetUrl);

  // Route through proxy
  return originalFetch(PROXY_URL, {
    ...init,
    headers,
  });
}

/**
 * Installs the secure fetch wrapper globally.
 * Call this at the very start of your application in secure mode.
 */
export function installSecureFetch(): void {
  if (process.env.OPENCLAW_SECURE_MODE !== "1") {
    return;
  }

  // Replace global fetch
  globalThis.fetch = secureFetch as typeof fetch;

  console.log("[secure-fetch] Installed fetch wrapper, routing through:", PROXY_URL);
}

/**
 * Restores the original fetch (for testing).
 */
export function uninstallSecureFetch(): void {
  globalThis.fetch = originalFetch;
}
