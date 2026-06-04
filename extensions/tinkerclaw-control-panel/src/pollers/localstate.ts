/**
 * FORK: tinkerclaw-control-panel — local-state poller.
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
    if (cur == null || typeof cur !== "object") {
      throw new Error(`localstate: ${file}#${dotPath} — missing at "${k}"`);
    }
    cur = (cur as Record<string, unknown>)[k];
  }
  const n = Number(cur);
  if (!Number.isFinite(n)) {
    throw new Error(`localstate: ${file}#${dotPath} = ${String(cur)} (not a number)`);
  }
  return n;
};
