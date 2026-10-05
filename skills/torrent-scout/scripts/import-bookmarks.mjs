#!/usr/bin/env node
// import-bookmarks.mjs — turn the user's own bookmarked torrent sites into
// configured indexers.
//
// The point is not novelty, it is COVERAGE. Measured 2026-09-06 on one title:
// 3 indexers → 15 unique results, 12 → 22, 78 → 190. The pockets are real and
// they are disjoint; the only way to see them is to ask everyone.
//
// Reads Chrome/Chromium/Brave JSON and Firefox places.sqlite, keeps hosts that
// look torrent-related, matches them against Jackett's public indexer catalog
// by name stem, and configures the matches.
//
// Usage: node scripts/import-bookmarks.mjs [--apply] [--all-public]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const JACKETT = process.env.JACKETT_URL || "http://127.0.0.1:9117";
const KEYFILE = path.join(HOME, ".jackett-apikey");
const KW =
  /torrent|magnet|1337x|pirate|rarbg|yts|eztv|nyaa|limetorrent|kickass|tpb|zooqle|glodls|btdig|bitsearch|torlock|idope|rutracker|rutor|knaben|snowfl|magnetdl|divxtotal|mejortorrent|wolfmax|yggtorrent|extratorrent/i;

function chromeBookmarks() {
  const out = [];
  for (const rel of [
    ".config/google-chrome/Default/Bookmarks",
    ".config/chromium/Default/Bookmarks",
    ".config/BraveSoftware/Brave-Browser/Default/Bookmarks",
  ]) {
    const p = path.join(HOME, rel);
    if (!fs.existsSync(p)) continue;
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    // NOTE: iterate roots.VALUES. Walking the roots object itself matches
    // nothing (it has no type/children) and silently yields zero bookmarks —
    // which reads as "the user has none" rather than "the parser is wrong".
    const walk = (n) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(walk);
      if (n.type === "url" && n.url) out.push({ title: n.name || "", url: n.url });
      (n.children || []).forEach(walk);
    };
    Object.values(d.roots || {}).forEach(walk);
  }
  return out;
}

function firefoxBookmarks() {
  const base = path.join(HOME, ".mozilla/firefox");
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const d of fs.readdirSync(base)) {
    const db = path.join(base, d, "places.sqlite");
    if (!fs.existsSync(db)) continue;
    const tmp = path.join(os.tmpdir(), `places-${Date.now()}.sqlite`);
    try {
      fs.copyFileSync(db, tmp); // never read the live profile DB
      const py = `import sqlite3,json;c=sqlite3.connect(${JSON.stringify(tmp)});print(json.dumps([{"title":t or "","url":u} for t,u in c.execute("SELECT b.title,p.url FROM moz_bookmarks b JOIN moz_places p ON b.fk=p.id WHERE b.type=1")]))`;
      out.push(...JSON.parse(execFileSync("python3", ["-c", py], { encoding: "utf8" })));
    } catch {
      /* profile locked or schema changed */
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  }
  return out;
}

const stem = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function main() {
  const apply = process.argv.includes("--apply");
  const allPublic = process.argv.includes("--all-public");
  const marks = [...chromeBookmarks(), ...firefoxBookmarks()];
  console.log(`parsed ${marks.length} bookmarks`);
  if (!marks.length) {
    console.error("zero bookmarks parsed — treat that as a BROKEN PARSER, not an empty browser.");
    process.exit(3);
  }

  const hosts = new Set();
  for (const m of marks) {
    if (!/^https?:/.test(m.url)) continue;
    if (KW.test(m.url) || KW.test(m.title))
      hosts.add(
        m.url
          .split("/")[2]
          .replace(/^www\./, "")
          .toLowerCase(),
      );
  }
  console.log(`torrent-related bookmarked hosts: ${hosts.size}`);

  const key = fs.existsSync(KEYFILE) ? fs.readFileSync(KEYFILE, "utf8").trim() : "";
  const jar = path.join(os.tmpdir(), "jk-cookies.txt");
  execFileSync("curl", [
    "-s",
    "-c",
    jar,
    "-b",
    jar,
    "--max-time",
    "15",
    "-X",
    "POST",
    `${JACKETT}/UI/Dashboard`,
    "-H",
    "Content-Type: application/x-www-form-urlencoded",
    "--data",
    "password=",
    "-o",
    "/dev/null",
  ]);
  // Jackett's catalog is ~1.5 MB of JSON; the default 1 MB execFileSync buffer
  // fails with ENOBUFS, which surfaces as a confusing spawn error rather than
  // an obvious size problem.
  const idx = JSON.parse(
    execFileSync(
      "curl",
      ["-s", "-b", jar, "--max-time", "30", `${JACKETT}/api/v2.0/indexers?apikey=${key}`],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    ),
  );
  const configured = new Set(idx.filter((i) => i.configured).map((i) => i.id));
  const pub = idx.filter((i) => i.type === "public");

  const want = new Set();
  for (const h of hosts) {
    const hs = stem(h.split(".")[0]);
    if (hs.length < 4) continue;
    for (const i of pub) {
      const is = stem(i.id);
      if (hs.includes(is) || is.includes(hs)) want.add(i.id);
    }
  }
  if (allPublic) pub.forEach((i) => want.add(i.id));
  const todo = [...want].filter((i) => !configured.has(i));
  console.log(`matched ${want.size} indexers, ${todo.length} not yet configured`);
  if (!apply) {
    console.log("\ndry run. re-run with --apply to configure:\n  " + todo.join(", "));
    return;
  }

  let ok = 0;
  for (const id of todo) {
    const code = execFileSync(
      "curl",
      [
        "-s",
        "-b",
        jar,
        "--max-time",
        "35",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "-X",
        "POST",
        `${JACKETT}/api/v2.0/indexers/${id}/config?apikey=${key}`,
        "-H",
        "Content-Type: application/json",
        "--data",
        "[]",
      ],
      { encoding: "utf8" },
    );
    if (code.trim() === "204") ok += 1;
  }
  console.log(`configured ${ok} of ${todo.length} (the rest are offline or need credentials)`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
