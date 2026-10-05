/**
 * FORK: tinkerclaw-pulse-panel — Google Analytics 4 poller (real traffic).
 *
 * Replaces the `demo.website.visits` stub. Reads daily sessions for a GA4
 * property via the Data API, authenticating as an OPERATOR-SUPPLIED Google
 * service account granted Viewer on that property. The JSON key file is named
 * by `plugins.tinkerclaw-pulse-panel.credentials.ga4ServiceAccountFile`; there is no default
 * path, so with nothing configured this poller is skipped rather than reading
 * whatever gcloud happens to have left on the machine. No external dep: the SA
 * JWT is signed with node:crypto and exchanged for an access token at
 * oauth2.googleapis.com before the report call to analyticsdata.googleapis.com.
 *
 * source string: "ga4.sessions:<propertyId>"
 * Returns today's session count (today..today; partial-day, fine for a daily
 * gauge — dailyLast keeps the last reading of the day).
 */
import crypto from "node:crypto";
import { readCredentialFile } from "./credentials.js";
import type { PollerFn } from "./index.js";
const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let tokenCache: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.exp - 60 > now) return tokenCache.token;
  const sa = JSON.parse(readCredentialFile("ga4ServiceAccountFile")) as {
    client_email: string;
    private_key: string;
  };
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/analytics.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claim}`;
  const signature = b64url(crypto.sign("RSA-SHA256", Buffer.from(signingInput), sa.private_key));
  const jwt = `${signingInput}.${signature}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`GA4 token HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: json.access_token, exp: now + json.expires_in };
  return json.access_token;
}

export const ga4Sessions: PollerFn = async (args) => {
  const property = args.trim();
  if (!/^\d+$/.test(property))
    throw new Error(`ga4.sessions needs a numeric propertyId, got "${args}"`);
  const token = await accessToken();
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        dateRanges: [{ startDate: "today", endDate: "today" }],
        metrics: [{ name: "sessions" }],
      }),
    },
  );
  if (!res.ok) throw new Error(`GA4 runReport HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { rows?: Array<{ metricValues: Array<{ value: string }> }> };
  return Number(json.rows?.[0]?.metricValues?.[0]?.value ?? 0);
};
