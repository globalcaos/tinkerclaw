/**
 * FORK 2026-09-10 — daily GitHub activity (commits / lines added / lines
 * deleted) on the default branch, authored by the authenticated user.
 *
 * GitHub's `/stats/code_frequency` 422s on this repo (too many commits) and
 * `/stats/commit_activity` is a weekly histogram of every author, including
 * the imported OpenClaw history. GraphQL `history(author: {id: viewer})` is
 * the series the architect asked for: when HE pushed, and how much.
 *
 * AUTH. GraphQL needs a credential: the operator-supplied token
 * (`plugins.tinkerclaw-pulse-panel.credentials.githubToken`), sent to
 * api.github.com/graphql. The plugin does not run the `gh` CLI or borrow any
 * other local login. With no token the poller is skipped rather than walking
 * 28k unfiltered commits.
 *
 * source: "github.activity:<commits|additions|deletions>:<owner>/<repo>"
 */
import { githubToken, PollerNotConfiguredError } from "./credentials.js";
import type { PollerFn } from "./index.js";

const DAY = 86_400_000;
const PAGE = 100;
const MAX_PAGES = 40; // 4000 commits — well above the architect's ~1.3k on this repo.

export type ActivityMetric = "commits" | "additions" | "deletions";
export type DayBucket = {
  ts: number;
  commits: number;
  additions: number;
  deletions: number;
};
export type ActivityTimeline = DayBucket[];
export type ActivityArgs = { metric: ActivityMetric; owner: string; repo: string };

const METRICS = new Set<ActivityMetric>(["commits", "additions", "deletions"]);

export function parseActivityArgs(args: string): ActivityArgs {
  const colon = args.indexOf(":");
  const metric = args.slice(0, colon) as ActivityMetric;
  const repo = args.slice(colon + 1);
  const slash = repo.indexOf("/");
  const owner = repo.slice(0, slash);
  const name = repo.slice(slash + 1);
  if (!METRICS.has(metric) || !owner || !name || name.includes("/")) {
    throw new Error(
      `github.activity needs "<commits|additions|deletions>:<owner>/<repo>", got "${args}"`,
    );
  }
  return { metric, owner, repo: name };
}

/** UTC noon of the commit's UTC calendar day — matches presence-graph dailyLast. */
export function dayNoonUtc(iso: string): number {
  const d = new Date(iso);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0);
}

export function bucketCommits(
  nodes: Array<{ committedDate: string; additions?: number | null; deletions?: number | null }>,
): ActivityTimeline {
  const m = new Map<number, DayBucket>();
  for (const n of nodes) {
    if (!n?.committedDate) continue;
    const ts = dayNoonUtc(n.committedDate);
    const b = m.get(ts) ?? { ts, commits: 0, additions: 0, deletions: 0 };
    b.commits += 1;
    b.additions += n.additions ?? 0;
    b.deletions += n.deletions ?? 0;
    m.set(ts, b);
  }
  return [...m.values()].sort((a, c) => a.ts - c.ts);
}

/** Fill empty UTC days so the line sits on zero between bursts instead of sloping. */
export function fillDayGaps(days: ActivityTimeline, untilTs = Date.now()): ActivityTimeline {
  if (!days.length) return days;
  const by = new Map(days.map((d) => [d.ts, d]));
  const start = days[0].ts;
  const end = Math.floor(untilTs / DAY) * DAY + DAY / 2;
  const out: ActivityTimeline = [];
  for (let ts = start; ts <= end; ts += DAY) {
    out.push(by.get(ts) ?? { ts, commits: 0, additions: 0, deletions: 0 });
  }
  return out;
}

type GqlData = Record<string, unknown>;

const VIEWER_QUERY = "query{viewer{id}}";
const HISTORY_QUERY =
  "query($owner:String!,$name:String!,$after:String,$since:DateTime,$authorId:ID){repository(owner:$owner,name:$name){defaultBranchRef{target{...on Commit{history(first:100,after:$after,since:$since,author:{id:$authorId}){pageInfo{hasNextPage endCursor}nodes{committedDate additions deletions}}}}}}}";

async function githubGraphql(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<GqlData> {
  const token = githubToken();
  if (!token) {
    throw new PollerNotConfiguredError(
      "github.activity: needs a GitHub token — set plugins.tinkerclaw-pulse-panel.credentials.githubToken",
    );
  }
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "tinkerclaw-pulse-panel",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`github graphql HTTP ${res.status} ${res.statusText}`);
  }
  return unwrapGraphql(await res.json());
}

function unwrapGraphql(body: { data?: GqlData; errors?: Array<{ message: string }> }): GqlData {
  if (body.errors?.length) throw new Error(`github graphql: ${body.errors[0].message}`);
  if (!body.data) throw new Error("github graphql: empty data");
  return body.data;
}

type HistoryNode = { committedDate: string; additions?: number; deletions?: number };
type HistoryPayload = {
  repository?: {
    defaultBranchRef?: {
      target?: {
        history?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: HistoryNode[];
        };
      };
    };
  };
};

let VIEWER_ID: string | null | undefined;

async function viewerId(): Promise<string> {
  if (VIEWER_ID) return VIEWER_ID;
  const data = await githubGraphql(VIEWER_QUERY);
  const id = (data.viewer as { id?: string } | undefined)?.id;
  if (!id) {
    throw new PollerNotConfiguredError("github.activity: GraphQL viewer has no id");
  }
  VIEWER_ID = id;
  return id;
}

const ACTIVITY_CACHE = new Map<string, { fetchedAt: number; days: ActivityTimeline }>();
const ACTIVITY_TTL_MS = 60_000;

export async function fetchActivityTimeline(
  owner: string,
  repo: string,
  sinceMs?: number,
): Promise<ActivityTimeline> {
  const cacheKey = `${owner}/${repo}:${sinceMs ?? 0}`;
  const cached = ACTIVITY_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < ACTIVITY_TTL_MS) return cached.days;

  const authorId = await viewerId();
  const nodes: HistoryNode[] = [];
  let after: string | undefined;
  const since = sinceMs ? new Date(sinceMs).toISOString() : undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = (await githubGraphql(HISTORY_QUERY, {
      owner,
      name: repo,
      after,
      since,
      authorId,
    })) as HistoryPayload;
    const hist = data.repository?.defaultBranchRef?.target?.history;
    if (!hist) break;
    if (hist.nodes?.length) nodes.push(...hist.nodes);
    if (!hist.pageInfo?.hasNextPage || !hist.pageInfo.endCursor) break;
    after = hist.pageInfo.endCursor;
    if ((hist.nodes?.length ?? 0) < PAGE) break;
  }
  const days = fillDayGaps(bucketCommits(nodes));
  ACTIVITY_CACHE.set(cacheKey, { fetchedAt: Date.now(), days });
  return days;
}

export const githubActivityDaily: PollerFn = async (args) => {
  const { metric, owner, repo } = parseActivityArgs(args);
  const days = await fetchActivityTimeline(owner, repo, Date.now() - 3 * DAY);
  if (!days.length) return 0;
  return days[days.length - 1][metric];
};
