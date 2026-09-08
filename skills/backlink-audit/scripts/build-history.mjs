#!/usr/bin/env node
// build-history — write dated, cumulative "ours" backlink observations into the
// control-panel store so the Inbound-links graph shows real historical growth,
// not just today's snapshot.
//
// The dataset below is DERIVED (not invented) from two scavenged sources:
//   1. Authored GitHub comments by globalcaos that contain a backlink to our
//      repo — dated by each thread's FIRST backlink-bearing comment (created_at
//      via `gh api repos/<r>/issues/<n>/comments`). One distinct source thread =
//      one backlink (multiple comments in a thread still = one linking page).
//   2. `git log -S "thetinkerzone.com"` in the tinkerclaw repo — when the README
//      backlink to thetinkerzone.com first went live.
//
// Re-derive: re-run the comment mine + git log, update EVENTS, re-run this.
// Writes via `openclaw gateway call control-panel.record` (idempotent per ts).

import { execFileSync } from "node:child_process";

// metric → [{ date 'YYYY-MM-DD', cumulative }] (cumulative distinct backlinks on/after that date)
// Re-derived 2026-06-10 from the full authoritative dataset (see scripts/date_curve
// logic in the session notes): `gh search issues author:globalcaos OR commenter:globalcaos`
// (19 third-party GitHub threads with a live github.com/globalcaos/tinkerclaw link),
// + moltbook /agents/jarvis_oscar/comments (28 distinct posts), + clawhub.ai skill page.
// The prior 1→6→14→36 curve UNDER-counted github (knew only 6 of 19 threads).
const SERIES = {
  // 66 distinct referring pages across 3 domains: 19 third-party GitHub threads +
  // 28 moltbook.com posts + 19 clawhub.ai skill pages (of our 20 skills, all but
  // teams-hack link the repo). clawhub backlinks are dated by each skill's creation
  // anchor (earliest graph.clawhub.<slug> obs) assuming the README's tinkerclaw link
  // was present from publish. external RE-VERIFIED = 0 (clawskills.sh + canitrunopenclaw
  // do NOT link tinkerclaw — prior external=3 was fiction).
  "graph.inbound.tinkerclaw.ours": [
    { date: "2026-02-06", cumulative: 1,  note: "clawhub:whatsapp-ultimate" },
    { date: "2026-02-11", cumulative: 2,  note: "+gh openclaw#13991 (first github backlink)" },
    { date: "2026-02-20", cumulative: 9,  note: "+7 clawhub skills (jarvis-voice, youtube/chatgpt-exporter/token-panel/shell-security-ultimate, outlook-hack, memory-bench-pioneer)" },
    { date: "2026-02-21", cumulative: 11, note: "+clawhub token-efficiency-guide, fork-and-skill-scanner-ultimate" },
    { date: "2026-02-22", cumulative: 12, note: "+clawhub subagent-overseer" },
    { date: "2026-02-26", cumulative: 16, note: "+gh OpenViking#311, MemOS#1129, memU#361, mnemon-dev/mnemon#1" },
    { date: "2026-03-03", cumulative: 17, note: "+clawhub tinker-command-center" },
    { date: "2026-03-06", cumulative: 18, note: "+clawhub smart-model-router" },
    { date: "2026-03-07", cumulative: 19, note: "+clawhub model-prompt-adapter" },
    { date: "2026-03-17", cumulative: 33, note: "+14 gh threads (openclaw #11919/#12219/#18099/#28108/#30286 + PRs #16689/#17307/#17326/#6500/#6735/#6747/#6753, DenchClaw#95, ALucek/agentic-memory#3 — backlink campaign)" },
    { date: "2026-03-23", cumulative: 36, note: "+clawhub owntracks-location, agent-superpowers, wordpress-ultimate" },
    { date: "2026-04-02", cumulative: 37, note: "+clawhub computational-humor" },
    { date: "2026-06-02", cumulative: 43, note: "+6 moltbook.com posts" },
    { date: "2026-06-04", cumulative: 65, note: "+22 moltbook.com posts (28 total)" },
    { date: "2026-06-06", cumulative: 66, note: "+clawhub agent-sensei-ultimate" },
  ],
  "graph.inbound.thetinkerzone.ours": [
    // Distinct public tinkerclaw-repo README pages linking thetinkerzone.com, dated by
    // first-commit. All self-links from ONE referring domain (github.com); extensions
    // are NOT npm-published (no npm pages). 2026-06-10: 8 (the src/fork/fractal-prompt.md
    // link is gone — that file is now a stub), down from the earlier 9.
    { date: "2026-02-14", cumulative: 1, note: "README.md" },
    { date: "2026-03-30", cumulative: 2, note: "+src/fork/fractal-prompt.md (link later removed)" },
    { date: "2026-04-29", cumulative: 9, note: "+7 extension/skill READMEs (npm-publish-prep commit)" },
    { date: "2026-06-10", cumulative: 8, note: "fractal-prompt stub no longer links it → 8 README pages" },
  ],
};

const tsOf = (d) => Date.parse(`${d}T12:00:00Z`);
let wrote = 0;
for (const [metric, points] of Object.entries(SERIES)) {
  for (const p of points) {
    const params = JSON.stringify({ id: metric, value: p.cumulative, ts: tsOf(p.date) });
    try {
      execFileSync("openclaw", ["gateway", "call", "control-panel.record", "--params", params], { encoding: "utf8" });
      console.log(`  ${metric}  ${p.date} = ${p.cumulative}  (${p.note})`);
      wrote++;
    } catch (e) {
      console.error(`  FAILED ${metric} ${p.date}: ${String(e.message).slice(0, 120)}`);
    }
  }
}
console.log(`\nwrote ${wrote} dated observations. The Inbound-links graph now shows the historical 'ours' growth curve.`);
