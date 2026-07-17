/**
 * FORK: tinkerclaw-control-panel — GitHub pollers.
 *
 * Three sibling pollers (`github.stargazers`, `github.forks`,
 * `github.open_issues`) all hit the same /repos/{owner}/{repo} endpoint and
 * pluck one field. A small in-memory cache (60s TTL) keeps the three sibling
 * calls in a single tick from doing three identical fetches.
 *
 * Unauthenticated rate limit is 60 req/h per IP — plenty for the 6h cadence
 * across a handful of repos. If GITHUB_TOKEN is set in env, requests are
 * authenticated (5000/h).
 */
import type { PollerFn } from "./index.js";

type RepoFields = {
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  subscribers_count?: number;
};

const REPO_CACHE = new Map<string, { fetchedAt: number; data: RepoFields }>();
const REPO_TTL_MS = 60_000;

async function fetchRepo(owner: string, repo: string): Promise<RepoFields> {
  const key = `${owner}/${repo}`;
  const cached = REPO_CACHE.get(key);
  if (cached && Date.now() - cached.fetchedAt < REPO_TTL_MS) {
    return cached.data;
  }
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "tinkerclaw-control-panel",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (!res.ok) {
    throw new Error(`github api ${key}: HTTP ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as RepoFields;
  REPO_CACHE.set(key, { fetchedAt: Date.now(), data });
  return data;
}

function parseOwnerRepo(args: string): { owner: string; repo: string } {
  const [owner, repo] = args.split("/");
  if (!owner || !repo) {
    throw new Error(`github poller: expected "owner/repo", got "${args}"`);
  }
  return { owner, repo };
}

export const githubStargazers: PollerFn = async (args) => {
  const { owner, repo } = parseOwnerRepo(args);
  const data = await fetchRepo(owner, repo);
  return data.stargazers_count;
};

export const githubForks: PollerFn = async (args) => {
  const { owner, repo } = parseOwnerRepo(args);
  const data = await fetchRepo(owner, repo);
  return data.forks_count;
};

export const githubOpenIssues: PollerFn = async (args) => {
  const { owner, repo } = parseOwnerRepo(args);
  const data = await fetchRepo(owner, repo);
  return data.open_issues_count;
};

/**
 * FORK 2026-06-26 — exact star-gain timeline for the Pulse "GitHub stars" graph.
 * The 6h stargazers poller only records the live count at `now`, so the curve
 * starts wherever polling began — no origin, no intermediate gain points. This
 * reconstructs the TRUE curve from GitHub directly: the repo's `created_at`
 * (the zero dot — stars=0 the moment the repo went up) plus one `starred_at`
 * per stargazer (each an intermediate point where a star was gained). The
 * backfill turns these into a cumulative 0→N series. Uses the
 * `application/vnd.github.star+json` media type, which adds `starred_at` to
 * each stargazer entry. Paginated (per_page=100, capped) so a growing repo
 * stays correct; 14 stars today fit one page.
 */
export type StargazerTimeline = { createdAtMs: number; starredAtMs: number[] };

export async function fetchStargazerTimeline(args: string): Promise<StargazerTimeline> {
  const { owner, repo } = parseOwnerRepo(args);
  const repoData = (await fetchRepo(owner, repo)) as RepoFields & { created_at?: string };
  // fetchRepo caches the plucked fields but not created_at; fetch it explicitly.
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "tinkerclaw-control-panel",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const metaRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (!metaRes.ok) {
    throw new Error(`github repo ${owner}/${repo}: HTTP ${metaRes.status} ${metaRes.statusText}`);
  }
  const meta = (await metaRes.json()) as { created_at: string };
  const createdAtMs = Date.parse(meta.created_at);

  const starHeaders = { ...headers, Accept: "application/vnd.github.star+json" };
  const starredAtMs: number[] = [];
  const MAX_PAGES = 20; // 2000 stars — far beyond current scale, a safety cap.
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/stargazers?per_page=100&page=${page}`,
      { headers: starHeaders },
    );
    if (!res.ok) {
      throw new Error(`github stargazers ${owner}/${repo}: HTTP ${res.status} ${res.statusText}`);
    }
    const batch = (await res.json()) as Array<{ starred_at?: string }>;
    if (batch.length === 0) break;
    for (const s of batch) {
      if (s.starred_at) starredAtMs.push(Date.parse(s.starred_at));
    }
    if (batch.length < 100) break;
  }
  starredAtMs.sort((a, b) => a - b);
  return { createdAtMs, starredAtMs };
}
