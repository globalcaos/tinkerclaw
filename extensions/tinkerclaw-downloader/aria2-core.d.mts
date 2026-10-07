// Types for aria2-core.mjs (dependency-free JS so the installer script can import it
// without a build; declared here so the TS plugin entry can import it typed).
export declare const MANAGED_HEADER: string;
export interface Aria2Paths {
  confDir: string;
  conf: string;
  session: string;
  secret: string;
  log: string;
  unitName: string;
  unit: string;
}
export interface DownloaderOptions {
  downloadDir: string;
  rpcPort: number;
  maxConcurrentDownloads: number;
  unitName: string;
}
export interface TaskRow {
  gid: string;
  status: string;
  name: string;
  totalBytes: number;
  doneBytes: number;
  progress: number;
  speedBytesPerSec: number;
  dir?: string;
  error?: string;
}
export declare const TASK_KEYS: string[];
export declare function resolvePaths(home?: string, unitName?: string): Aria2Paths;
export declare function resolveOptions(
  raw?: Record<string, unknown>,
  home?: string,
): DownloaderOptions;
export declare function renderConf(
  o: DownloaderOptions & { secret: string; paths: Aria2Paths },
): string;
export declare function renderUnit(o: { aria2cPath: string; paths: Aria2Paths }): string;
export declare function findProblems(confText: string): string[];
export declare function repairConf(confText: string): string;
export declare function readSetting(confText: string, key: string): string | undefined;
export declare function rpc<T = unknown>(o: {
  port: number;
  secret: string;
  method: string;
  params?: unknown[];
  timeoutMs?: number;
}): Promise<T>;
export interface Aria2Task {
  gid: string;
  status: string;
  totalLength?: string;
  completedLength?: string;
  downloadSpeed?: string;
  errorMessage?: string;
  dir?: string;
  files?: { path?: string; uris?: { uri: string }[] }[];
  bittorrent?: { info?: { name?: string } };
}
export declare function summarizeTask(t: Aria2Task): TaskRow;
