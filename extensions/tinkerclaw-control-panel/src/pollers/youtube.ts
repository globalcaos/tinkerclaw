/**
 * FORK 2026-06-14 — YouTube channel-stats poller (public Data API v3).
 *
 * Reads a channel's PUBLIC statistics (subscriberCount / viewCount / videoCount)
 * via the YouTube Data API. Auth is a project API key (no OAuth, no expiry) —
 * created 2026-06-14 in GCP project organic-storm-486018-u9, restricted to
 * youtube.googleapis.com, stored chmod 600 at ~/.config/youtube-cli/data-api.key.
 *
 * source string: "youtube.channelStats:<subscribers|views|videos>:<channelId>"
 *   e.g. youtube.channelStats:subscribers:UCh_am-9EG0_a-DBronOMC4w (thetinkerzone)
 *
 * These are absolute monotonic totals (a growing line) — NOT cumulative running
 * sums; do not set the cumulative flag in SERIES_STYLE.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PollerFn } from "./index.js";

const KEY_PATH = path.join(os.homedir(), ".config", "youtube-cli", "data-api.key");

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
  const key = fs.readFileSync(KEY_PATH, "utf8").trim();
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
