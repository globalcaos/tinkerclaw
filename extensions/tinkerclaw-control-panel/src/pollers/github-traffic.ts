/**
 * FORK 2026-06-05 — daily GitHub traffic poller.
 *
 * The old clones14d/views14d metrics stored GitHub's TRAILING-14-DAY rolling
 * total, but the graph plots one point per day — so a 14d total of ~750 looked
 * like "750 clones in a day". This poller returns the most recent day's REAL
 * daily count from GitHub's 14-day daily breakdown (small, true per-day number).
 *
 * Traffic API requires repo auth, so we shell out to the authed `gh` CLI
 * (/usr/bin/gh, signed in as the repo owner) rather than unauthenticated fetch.
 *
 * source: "github.traffic.daily:<clones|views>:<owner>/<repo>"
 *   → cron splits on the first ":" → key "github.traffic.daily",
 *     args "<clones|views>:<owner>/<repo>".
 */
import { execFileSync } from "node:child_process";
import type { PollerFn } from "./index.js";

export const githubTrafficDaily: PollerFn = async (args) => {
  const colon = args.indexOf(":");
  const metric = args.slice(0, colon);
  const repo = args.slice(colon + 1);
  if ((metric !== "clones" && metric !== "views") || !/^[^/]+\/[^/]+$/.test(repo)) {
    throw new Error(`github.traffic.daily needs "<clones|views>:<owner>/<repo>", got "${args}"`);
  }
  const out = execFileSync("gh", ["api", `repos/${repo}/traffic/${metric}`], {
    encoding: "utf8",
    timeout: 20_000,
  });
  const data = JSON.parse(out) as {
    clones?: Array<{ count: number }>;
    views?: Array<{ count: number }>;
  };
  const arr = (metric === "clones" ? data.clones : data.views) ?? [];
  return arr.length ? arr[arr.length - 1].count : 0;
};
