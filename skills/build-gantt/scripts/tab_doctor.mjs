#!/usr/bin/env node
// FORK 2026-11-14. Why does (or doesn't) a chain master show its Gantt tab? One call, read-only.
// It runs the page's own pure functions (tinker-ui/src/gantt-tab.ts and tab-chains.ts; Node 22
// strips their types) on the desk file the page saves (~/.openclaw/data/tinker-ui-state.json) and
// on the board list tinker-prod-ui serves. It separates: a missing plan file (the tab draws
// greyed), a board the server does not serve, no chain for the session, the session open only as
// a slave, a chain saved on closed tab ids (the page heals it since develop f0e7360852e2), and a
// served page without those fixes.
// Usage: node ~/src/tinkerclaw/skills/build-gantt/scripts/tab_doctor.mjs [session-key fragment]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tinker-ui/src");
const { ganttBoardsByMaster, parseGanttBoards } = await import(path.join(src, "gantt-tab.ts"));
const chains = await import(path.join(src, "tab-chains.ts"));
const heal = chains.healChains ?? ((c) => c);
const data = path.join(os.homedir(), ".openclaw/data");
const base = `http://127.0.0.1:${process.env.TINKER_PROD_PORT || 18793}`;
const want = process.argv[2] || "";
const match = (a, b) => !!a && !!b && (a === b || a.endsWith(":" + b) || b.endsWith(":" + a));
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(data, f), "utf8"));
const get = async (url, asJson) => {
  try {
    const r = await fetch(base + url);
    return asJson ? await r.json() : await r.text();
  } catch {
    return null;
  }
};

const filed = readJson("gantt-boards.json").boards || {};
const servedRaw = await get("/api/gantt/boards", true);
const served = servedRaw ? parseGanttBoards(servedRaw) : null;
const state = readJson("tinker-ui-state.json");
const tabs = state.tabs || [];
const saved = chains.parseChains(state.choices?.["loop:chains"] || "[]");
const healed = heal(saved, tabs, match);
const keyOf = (id) => tabs.find((t) => t.id === id)?.sessionKey;
const title = (id) => tabs.find((t) => t.id === id)?.title || "";
const isOpen = (id) => tabs.some((t) => t.id === id);
const drawn = served ? ganttBoardsByMaster(healed, served, keyOf, match) : new Map();

const html = await get("/tinker/", false);
const js = html?.match(/\/tinker\/assets\/index-[^"]+\.js/)?.[0];
const code = js ? await get(js, false) : null;
const has = (yes) => (yes ? "yes" : "NO");
console.log(
  `page server ${base}: ${served ? "up" : "DOWN"}; served page ${js || "?"}` +
    (code
      ? ` (greyed tab ${has(code.includes("tab-gantt-missing"))}, chain heal ${has(/has\([\w$]+\.master\)\?[\w$]+\.master:/.test(code))})`
      : ""),
);
try {
  const loads = fs
    .readFileSync(path.join(os.homedir(), ".local/state/tinkerclaw/disruptions.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((d) => d?.event === "page-load")
    .slice(-3);
  if (loads.length)
    console.log(
      "last page loads: " + loads.map((d) => `${d.at.slice(11, 19)}Z ${d.bundle}`).join(", "),
    );
} catch {}

for (const [session, b] of Object.entries(filed)) {
  if (want && !session.includes(want)) continue;
  console.log(`\n${session}  ${b.title || ""}`);
  const plan = b.plan || "";
  console.log(
    `  plan: ${fs.existsSync(plan) ? "present" : "MISSING (the tab draws greyed and its chart names the path)"}  ${plan}`,
  );
  const sb = served?.find((x) => match(x.session, session));
  console.log(
    `  served: ${!served ? "page server did not answer" : sb ? (sb.missing ? "yes, marked missing" : "yes") : "NO (a tinker-prod-ui older than e3c14b87dc7e drops a board whose plan is missing)"}`,
  );
  const asMaster = saved.find((c) => match(c.masterKey, session));
  if (!asMaster) {
    const asSlave = saved.find((c) => match(c.slaveKey, session));
    console.log(
      `  chain: ${asSlave ? "this session is a chain SLAVE; the tab shows after its master only" : "none; the tab shows only after a chain master (right-click → Set conversation slave)"}`,
    );
  } else {
    const h = healed[saved.indexOf(asMaster)];
    console.log(
      `  chain saved: ${asMaster.master} → ${asMaster.slave} (${isOpen(asMaster.master) ? "open" : "CLOSED"} → ${isOpen(asMaster.slave) ? "open" : "CLOSED"})`,
    );
    if (h.master !== asMaster.master || h.slave !== asMaster.slave)
      console.log(`  chain as the page reads it (healed by session key): ${h.master} → ${h.slave}`);
  }
  const master = [...drawn.entries()].find(([, x]) => match(x.session, session))?.[0];
  console.log(
    `  VERDICT: ${master ? `the page draws the Gantt tab${sb?.missing ? " (greyed)" : ""} after ${master} (${title(master)})` : "no Gantt tab: fix the first NO / MISSING / none / CLOSED line above"}`,
  );
}
