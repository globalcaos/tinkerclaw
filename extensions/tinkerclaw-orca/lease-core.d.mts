// Types for lease-core.mjs (dependency-free JS so the Edit/Write hook can run it
// as a CLI; declared here so the TS plugin entry can import it typed).
export interface LeaseRecord {
  owner: string;
  pid: number;
  host: string;
  sessionId: string;
  acquiredAt: number;
  ttlMs: number;
  intent: string;
  repo: string;
  path: string;
}
export interface AcquireOpts {
  repo: string;
  path: string;
  owner: string;
  pid?: number;
  sessionId?: string;
  ttlMs?: number;
  intent?: string;
  root?: string;
  now?: number;
  isAlive?: (pid: number) => boolean;
}
export function acquire(opts: AcquireOpts): {
  allowed: boolean;
  holder: LeaseRecord;
  leaseFile: string;
};
export function release(opts: { repo: string; path: string; owner: string; root?: string }): {
  released: boolean;
  holder?: LeaseRecord;
};
export function releaseAllByOwner(opts: { owner: string; root?: string }): {
  released: number;
};
export function status(opts: { repo: string; path: string; root?: string }): {
  held: boolean;
  holder?: LeaseRecord;
};
export function list(opts: {
  repo: string;
  root?: string;
}): Array<{ path: string; holder: LeaseRecord }>;
export function gc(opts: {
  repo: string;
  root?: string;
  now?: number;
  isAlive?: (pid: number) => boolean;
}): { reclaimed: number };
export function gcAll(opts?: {
  root?: string;
  now?: number;
  isAlive?: (pid: number) => boolean;
}): { reclaimed: number };
export function renew(opts: {
  repo: string;
  path: string;
  owner: string;
  ttlMs?: number;
  root?: string;
  now?: number;
}): { renewed: boolean };
export function runCli(argv: string[]): number;
export const DEFAULT_ROOT: string;
export const DEFAULT_TTL_MS: number;
