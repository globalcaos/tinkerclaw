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
