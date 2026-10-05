/**
 * FORK 2026-06-05 — daily GitHub traffic poller.
 *
 * The old clones14d/views14d metrics stored GitHub's TRAILING-14-DAY rolling
 * total, but the graph plots one point per day — so a 14d total of ~750 looked
 * like "750 clones in a day". This poller returns the most recent day's REAL
 * daily count from GitHub's 14-day daily breakdown (small, true per-day number).
 *
 * AUTH (changed 2026-09-08). The traffic endpoints require push access on the
 * repo. This used to shell out to the `gh` CLI, which silently borrowed
 * whatever GitHub account that CLI happened to be signed in as — a credential
 * store this plugin was never given. It now calls the REST API directly with
 * the OPERATOR-SUPPLIED token
 * (`plugins.tinkerclaw-pulse-panel.credentials.githubToken`).
 * With no token configured the poller is skipped rather than reaching for
 * someone else's login.
 *
 * source: "github.traffic.daily:<clones|views>:<owner>/<repo>"
 *   → cron splits on the first ":" → key "github.traffic.daily",
 *     args "<clones|views>:<owner>/<repo>".
 */
import { githubToken, PollerNotConfiguredError } from "./credentials.js";
import type { PollerFn } from "./index.js";

export const githubTrafficDaily: PollerFn = async (args) => {
  const colon = args.indexOf(":");
  const metric = args.slice(0, colon);
  const repo = args.slice(colon + 1);
  if ((metric !== "clones" && metric !== "views") || !/^[^/]+\/[^/]+$/.test(repo)) {
    throw new Error(`github.traffic.daily needs "<clones|views>:<owner>/<repo>", got "${args}"`);
  }
  const token = githubToken();
  if (!token) {
    throw new PollerNotConfiguredError(
      "github.traffic.daily: needs a GitHub token with push access — set plugins.tinkerclaw-pulse-panel.credentials.githubToken",
    );
  }
  const res = await fetch(`https://api.github.com/repos/${repo}/traffic/${metric}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "tinkerclaw-pulse-panel",
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`github traffic ${repo}/${metric}: HTTP ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    clones?: Array<{ count: number }>;
    views?: Array<{ count: number }>;
  };
  const arr = (metric === "clones" ? data.clones : data.views) ?? [];
  return arr.length ? arr[arr.length - 1].count : 0;
};
