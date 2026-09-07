/**
 * FORK: tinkerclaw-pulse-panel — npm download pollers.
 *
 * Hits the public npm registry's downloads endpoint. No auth required.
 * Endpoint shape: /downloads/point/{period}/{package} → { downloads, ... }.
 */
import type { PollerFn } from "./index.js";

async function fetchDownloads(pkg: string, period: "last-week" | "last-month"): Promise<number> {
  const res = await fetch(
    `https://api.npmjs.org/downloads/point/${period}/${encodeURIComponent(pkg)}`,
  );
  if (!res.ok) {
    throw new Error(`npm api ${pkg}: HTTP ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { downloads?: number };
  if (typeof data.downloads !== "number") {
    throw new Error(`npm api ${pkg}: unexpected payload`);
  }
  return data.downloads;
}

export const npmDownloadsWeekly: PollerFn = (args) => fetchDownloads(args, "last-week");
export const npmDownloadsMonthly: PollerFn = (args) => fetchDownloads(args, "last-month");
