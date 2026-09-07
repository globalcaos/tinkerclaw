/**
 * FORK: tinkerclaw-pulse-panel — local-state poller.
 *
 * A generic poller that reads a numeric value out of a JSON state file that
 * the online-presence crons already maintain, so we don't re-fetch upstream
 * for numbers we already have on disk.
 *
 * `args` is "<file>#<dot.path>", resolved relative to
 * ~/.openclaw/workspace/memory/online-presence/. Examples:
 *   localstate:inbound-campaign-state.json#inbound.organic
 *   localstate:engagement-state.json#clawhub.namespace_variants_jarvis_voice.total_downloads_visible_estimate
 *
 * Throws (poll is logged + skipped, retried next tick) if the file or path is
 * missing or the value isn't a finite number — e.g. inbound-campaign-state.json
 * doesn't exist until the weekly Inbound-Marketing cron first writes it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PollerFn } from "./index.js";

/**
 * Thrown when a localstate dot-path points at a key that is simply ABSENT
 * (an optional metric the upstream cron hasn't written yet) — as opposed to a
 * real failure (missing/malformed file, non-numeric value). The poll-runner
 * treats this as a quiet per-cycle skip rather than an error-level "poll
 * failed", so optional metrics don't flood the gateway log.
 */
export class MissingLocalStateKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingLocalStateKeyError";
  }
}

const BASE = path.join(os.homedir(), ".openclaw", "workspace", "memory", "online-presence");

export const localStateValue: PollerFn = async (args) => {
  const hash = args.indexOf("#");
  if (hash < 0) {
    throw new Error(`localstate poller: expected "file.json#a.b.c", got "${args}"`);
  }
  const file = args.slice(0, hash);
  const dotPath = args.slice(hash + 1);
  if (!file || !dotPath) {
    throw new Error(`localstate poller: expected "file.json#a.b.c", got "${args}"`);
  }
  const full = path.join(BASE, file);
  const json = JSON.parse(fs.readFileSync(full, "utf8")) as unknown;

  let cur: unknown = json;
  for (const k of dotPath.split(".")) {
    if (cur === undefined) {
      // An intermediate key is simply absent (e.g. the slug object exists but
      // the optional metric under it was never written) — quiet skip.
      throw new MissingLocalStateKeyError(`localstate: ${file}#${dotPath} — missing at "${k}"`);
    }
    if (cur == null || typeof cur !== "object") {
      throw new Error(`localstate: ${file}#${dotPath} — missing at "${k}"`);
    }
    cur = (cur as Record<string, unknown>)[k];
  }
  if (cur === undefined) {
    // Final optional key absent — quiet skip, not a real failure.
    throw new MissingLocalStateKeyError(`localstate: ${file}#${dotPath} — missing key`);
  }
  const n = Number(cur);
  if (!Number.isFinite(n)) {
    throw new Error(`localstate: ${file}#${dotPath} = ${String(cur)} (not a number)`);
  }
  return n;
};
