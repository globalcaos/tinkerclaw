/**
 * ONE-OFF REPAIR (2026-08-22). Between 2026-08-19 10:50 and today the loaded
 * cron-panel bundle predated `7b33b2e800c`, so `parseReport` never joined a
 * bullet's indented continuation line and `normalizeText` flattened newlines.
 * Every body written by a cron since the fleet adopted CRON-ITEM-VOICE.md
 * (2026-08-20/21) was therefore discarded at ingest: 0 of 221 open items on
 * the 11 boards carry a title/body split.
 *
 * The report files are immutable, so the bodies still exist on disk. This
 * refills them IN PLACE — it never creates, deletes, reorders or re-kinds an
 * item, and never touches `status`, `pinned`, `runs` or a dismissal reason.
 * Match is exact-first-line + same kind, so it can only restore a body that
 * our own parser dropped; it can never invent one.
 *
 * Run with `--apply` to write. Default is a dry run.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { parseReport } from "../extensions/tinkerclaw-cron-panel/src/cron-data.ts";
import { parseBullet } from "../extensions/tinkerclaw-cron-panel/src/board-store.ts";

const APPLY = process.argv.includes("--apply");
const CRON_DIR = path.join(os.homedir(), ".openclaw", "cron");
const BOARD_DIR = path.join(CRON_DIR, "board");
const REPORTS_DIR = path.join(CRON_DIR, "reports");

const ws = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Every `<date>/<jobId>.md` bullet that carries a body, newest date last so the
 * newest wording wins. Each yields BOTH lookup keys the old bundle could have
 * produced for its title line:
 *  - `parsed`: the tag was in the old 6-token map, so it was stripped;
 *  - `raw`: the tag was one of the six new voice tokens the old map did not
 *    know, so parseBullet fell through to `note` and kept `FOUND: ` inline.
 */
function bulletsForJob(jobId: string): { keys: string[]; kind: string; text: string }[] {
  const dates = fs
    .readdirSync(REPORTS_DIR)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const out: { keys: string[]; kind: string; text: string }[] = [];
  for (const date of dates) {
    const p = path.join(REPORTS_DIR, date, `${jobId}.md`);
    if (!fs.existsSync(p)) continue;
    for (const raw of parseReport(fs.readFileSync(p, "utf8"), date).deltas) {
      const parsed = parseBullet(raw);
      if (!parsed.text.includes("\n")) continue;
      out.push({
        keys: [ws(parsed.text.split("\n")[0]), ws(raw.split("\n")[0])],
        kind: parsed.kind,
        text: parsed.text,
      });
    }
  }
  return out;
}

let boards = 0;
let repaired = 0;
for (const file of fs.readdirSync(BOARD_DIR).filter((f) => f.endsWith(".json")).sort()) {
  const boardPath = path.join(BOARD_DIR, file);
  const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
  const withBody = bulletsForJob(board.jobId);
  if (withBody.length === 0) continue;

  // title line -> the full bullet. Newest report date wins on collision.
  const byTitle = new Map<string, { kind: string; text: string }>();
  for (const b of withBody) for (const k of b.keys) byTitle.set(k, { kind: b.kind, text: b.text });

  let hits = 0;
  let rekinded = 0;
  for (const item of board.items ?? []) {
    if (typeof item.text !== "string" || item.text.includes("\n")) continue;
    const full = byTitle.get(ws(item.text));
    if (!full) continue;
    item.text = full.text;
    // The old map knew 6 tokens, so every ASK/ACT/WATCH/BROKE/FOUND/FYI bullet
    // was filed as `note` and skimmed as FYI. Restore the tag it was written with.
    if (item.kind !== full.kind) {
      item.kind = full.kind;
      rekinded += 1;
    }
    hits += 1;
  }
  if (hits > 0) {
    boards += 1;
    repaired += hits;
    console.log(`${file.padEnd(32)} restored ${hits} bodies, re-tagged ${rekinded}`);
    if (APPLY) {
      const tmp = `${boardPath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`, "utf8");
      fs.renameSync(tmp, boardPath);
    }
  }
}
console.log(
  `\n${APPLY ? "APPLIED" : "DRY RUN"}: ${repaired} item bodies across ${boards} boards.`,
);
