/**
 * FORK 2026-06-14 — YouTube channel-stats poller (public Data API v3).
 *
 * Reads a channel's PUBLIC statistics (subscriberCount / viewCount / videoCount)
 * via the YouTube Data API. Auth is a project API key (no OAuth, no expiry),
 * OPERATOR-SUPPLIED: a file containing just the key, named by
 * `plugins.tinkerclaw-pulse-panel.credentials.youtubeApiKeyFile`. No default path — with
 * nothing configured this poller is skipped.
 *
 * source string: "youtube.channelStats:<subscribers|views|videos>:<channelId>"
 *
 * These are absolute monotonic totals (a growing line) — NOT cumulative running
 * sums; do not set the cumulative flag in SERIES_STYLE.
 */
import { readCredentialFile } from "./credentials.js";
import type { PollerFn } from "./index.js";

const FIELD: Record<string, "subscriberCount" | "viewCount" | "videoCount"> = {
  subscribers: "subscriberCount",
  views: "viewCount",
  videos: "videoCount",
};

export const youtubeChannelStats: PollerFn = async (args) => {
  const colon = args.indexOf(":");
  const metric = args.slice(0, colon);
  const channelId = args.slice(colon + 1);
  const field = FIELD[metric];
  if (!field || !/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
    throw new Error(
      `youtube.channelStats needs "<subscribers|views|videos>:<channelId>", got "${args}"`,
    );
  }
  const key = readCredentialFile("youtubeApiKeyFile").trim();
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}&key=${key}`,
  );
  if (!res.ok) throw new Error(`youtube api ${channelId}: HTTP ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { items?: Array<{ statistics?: Record<string, string> }> };
  const stat = data.items?.[0]?.statistics?.[field];
  if (stat == null) throw new Error(`youtube api ${channelId}: no ${field} (channel not found?)`);
  const n = Number(stat);
  if (!Number.isFinite(n))
    throw new Error(`youtube api ${channelId}: ${field}=${stat} not a number`);
  return n;
};
