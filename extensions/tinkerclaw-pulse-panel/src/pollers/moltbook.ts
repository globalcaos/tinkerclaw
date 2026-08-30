/**
 * FORK: tinkerclaw-pulse-panel — Moltbook pollers.
 *
 * Four sibling pollers (`moltbook.karma`, `moltbook.posts`,
 * `moltbook.comments`, `moltbook.followers`) all hit `/agents/me` once and
 * pluck one field. A 60s in-memory cache keeps the four sibling calls in a
 * single tick to a single fetch.
 *
 * Bearer key is read from ~/.config/moltbook/credentials.json (the same file
 * the `moltbook` skill writes when the owner pastes a refreshed key). The account
 * is fixed by that credential, so the poller `args` is ignored.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PollerFn } from "./index.js";

type Me = {
  karma: number;
  posts_count: number;
  comments_count: number;
  follower_count: number;
};

let CACHE: { fetchedAt: number; data: Me } | null = null;
const TTL_MS = 60_000;

function apiKey(): string {
  const p = path.join(os.homedir(), ".config", "moltbook", "credentials.json");
  const key = JSON.parse(fs.readFileSync(p, "utf8"))?.api_key;
  if (typeof key !== "string" || !key) {
    throw new Error(`moltbook poller: no api_key in ${p}`);
  }
  return key;
}

async function fetchMe(): Promise<Me> {
  if (CACHE && Date.now() - CACHE.fetchedAt < TTL_MS) {
    return CACHE.data;
  }
  const res = await fetch("https://www.moltbook.com/api/v1/agents/me", {
    headers: { Authorization: `Bearer ${apiKey()}` },
  });
  if (!res.ok) {
    throw new Error(`moltbook /agents/me: HTTP ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { agent?: Me };
  if (!json?.agent) {
    throw new Error("moltbook /agents/me: missing `agent` in response");
  }
  CACHE = { fetchedAt: Date.now(), data: json.agent };
  return json.agent;
}

export const moltbookKarma: PollerFn = async () => (await fetchMe()).karma;
export const moltbookPosts: PollerFn = async () => (await fetchMe()).posts_count;
export const moltbookComments: PollerFn = async () => (await fetchMe()).comments_count;
export const moltbookFollowers: PollerFn = async () => (await fetchMe()).follower_count;
