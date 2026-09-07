/**
 * ONE-OFF (2026-08-22). Companion to repair-cron-board-bodies.mts.
 *
 * After the letter-parser rebuild, two leftovers still made the Crons tab
 * unreadable:
 *
 *  1. ~100 OPEN items last seen on 2026-08-19 or earlier. They were written
 *     in log-voice (a path, a hash, a FLAG chip) BEFORE the fleet adopted
 *     CRON-ITEM-VOICE.md, so there is no body anywhere on disk to restore.
 *     Auto-resolve needs 3 missed runs and they only have 2, so they sit on
 *     the card as title-only junk until tomorrow. Resolve them now: they
 *     stopped being reported the night the voice changed, which is exactly
 *     what `resolved` means. Pinned / dismissed items are untouched.
 *
 *  2. A handful of 2026-08-20 one-liners that used the new ASK/ACT/WATCH/
 *     BROKE/FOUND/FYI tags against the old 6-token map, so they were filed
 *     as `note` with the prefix still in the text ("FOUND: backup healed").
 *     The card then skimmed them as FYI. Re-parse with the current map.
 *
 * Never creates, deletes, reorders, or touches a dismissal reason. Dry run
 * unless `--apply`.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { parseBullet } from "../extensions/tinkerclaw-cron-panel/src/board-store.ts";

const APPLY = process.argv.includes("--apply");
const BOARD_DIR = path.join(os.homedir(), ".openclaw", "cron", "board");
const VOICE_DAY = "2026-08-20";

const KIND_PREFIX =
  /^(ASK|ACT|WATCH|BROKE|FOUND|FYI|FLAG|CHANGED|REALIZED|DEAD|FAILED|NOTE|SHIPPED|QUERY|WARN|WARNING)\s*:\s*/i;

let resolved = 0;
let retagged = 0;
let boards = 0;

for (const file of fs.readdirSync(BOARD_DIR).filter((f) => f.endsWith(".json")).sort()) {
  const boardPath = path.join(BOARD_DIR, file);
  const board = JSON.parse(fs.readFileSync(boardPath, "utf8")) as {
    jobId: string;
    items: Array<{
      kind: string;
      text: string;
      status: string;
      pinned?: boolean;
      lastSeen?: string;
      resolvedAt?: string;
    }>;
  };
  let hits = 0;
  let tags = 0;
  const now = new Date().toISOString();
  for (const item of board.items ?? []) {
    if (item.status !== "open" || item.pinned) continue;
    if (typeof item.text !== "string") continue;

    if (KIND_PREFIX.test(item.text)) {
      const parsed = parseBullet(item.text);
      if (parsed.kind !== item.kind || parsed.text !== item.text) {
        item.kind = parsed.kind;
        item.text = parsed.text;
        tags += 1;
      }
    }

    const lastSeen = item.lastSeen ?? "";
    const titleOnly = !item.text.includes("\n");
    if (titleOnly && lastSeen && lastSeen < VOICE_DAY) {
      item.status = "resolved";
      item.resolvedAt = now;
      hits += 1;
    }
  }
  if (hits > 0 || tags > 0) {
    boards += 1;
    resolved += hits;
    retagged += tags;
    console.log(
      `${file.padEnd(32)} resolved ${hits} pre-voice log-lines, re-tagged ${tags}`,
    );
    if (APPLY) {
      const tmp = `${boardPath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`, "utf8");
      fs.renameSync(tmp, boardPath);
    }
  }
}
console.log(
  `\n${APPLY ? "APPLIED" : "DRY RUN"}: resolved ${resolved} pre-voice items, re-tagged ${retagged}, across ${boards} boards.`,
);
