#!/usr/bin/env node
/**
 * Places CLI — named locations with distance queries.
 * Usage:
 *   places add <name> <lat> <lon> [category] [notes]
 *   places remove <name>
 *   places list [category]
 *   places nearest <lat> <lon> [limit] [max_meters]
 *   places search <query>
 *   places where          # combines OwnTracks latest + nearest place
 */
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.OWNTRACKS_DATA || join(__dirname, "data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, "places.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS places (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    category TEXT DEFAULT 'other',
    notes TEXT DEFAULT '',
    created TEXT DEFAULT (datetime('now'))
  )
`);

function haversineSQL() {
  return `(6371000 * 2 * asin(sqrt(
    pow(sin(((? - lat) * 3.141592653589793 / 180) / 2), 2) +
    cos(lat * 3.141592653589793 / 180) * cos(? * 3.141592653589793 / 180) *
    pow(sin(((? - lon) * 3.141592653589793 / 180) / 2), 2)
  )))`;
}

const cmd = process.argv[2];

if (cmd === "add") {
  const [, , , name, lat, lon, category, ...notesParts] = process.argv;
  if (!name || !lat || !lon) {
    console.error("Usage: places add <name> <lat> <lon> [category] [notes]");
    process.exit(1);
  }
  try {
    db.prepare("INSERT INTO places (name, lat, lon, category, notes) VALUES (?, ?, ?, ?, ?)")
      .run(name, parseFloat(lat), parseFloat(lon), category || "other", notesParts.join(" ") || "");
    console.log(`✅ Added "${name}" (${lat}, ${lon}) [${category || "other"}]`);
  } catch (e) {
    if (e.message.includes("UNIQUE")) {
      db.prepare("UPDATE places SET lat=?, lon=?, category=?, notes=? WHERE name=?")
        .run(parseFloat(lat), parseFloat(lon), category || "other", notesParts.join(" ") || "", name);
      console.log(`🔄 Updated "${name}" (${lat}, ${lon}) [${category || "other"}]`);
    } else throw e;
  }
} else if (cmd === "remove") {
  const name = process.argv[3];
  const result = db.prepare("DELETE FROM places WHERE name = ?").run(name);
  console.log(result.changes ? `🗑️  Removed "${name}"` : `❌ "${name}" not found`);

} else if (cmd === "list") {
  const category = process.argv[3];
  const rows = category
    ? db.prepare("SELECT * FROM places WHERE category = ? ORDER BY name").all(category)
    : db.prepare("SELECT * FROM places ORDER BY category, name").all();
  if (!rows.length) { console.log("No places saved."); }
  else for (const r of rows) {
    console.log(`📍 ${r.name} (${r.lat}, ${r.lon}) [${r.category}]${r.notes ? " — " + r.notes : ""}`);
  }

} else if (cmd === "nearest") {
  const [, , , lat, lon, limit, maxM] = process.argv;
  if (!lat || !lon) {
    console.error("Usage: places nearest <lat> <lon> [limit=5] [max_meters=500]");
    process.exit(1);
  }
  const pLat = parseFloat(lat);
  const pLon = parseFloat(lon);
  const pLimit = parseInt(limit || "5", 10);
  const pMax = parseFloat(maxM || "500");

  const rows = db.prepare(`
    SELECT *, ${haversineSQL()} AS distance_m
    FROM places
    WHERE 1=1
    ORDER BY distance_m
    LIMIT ?
  `).all(pLat, pLat, pLon, pLimit).filter(r => r.distance_m <= pMax);

  if (!rows.length) { console.log(`No known places within ${pMax}m.`); }
  else for (const r of rows) {
    console.log(`📍 ${r.name} — ${Math.round(r.distance_m)}m [${r.category}]${r.notes ? " — " + r.notes : ""}`);
  }

} else if (cmd === "search") {
  const q = process.argv[3];
  const rows = db.prepare("SELECT * FROM places WHERE name LIKE ? OR category LIKE ? OR notes LIKE ? ORDER BY name")
    .all(`%${q}%`, `%${q}%`, `%${q}%`);
  if (!rows.length) { console.log(`No places matching "${q}".`); }
  else for (const r of rows) {
    console.log(`📍 ${r.name} (${r.lat}, ${r.lon}) [${r.category}]${r.notes ? " — " + r.notes : ""}`);
  }

} else if (cmd === "where") {
  // Read latest from OwnTracks
  const latestFile = join(DATA_DIR, "latest.json");
  if (!existsSync(latestFile)) {
    console.error("No location data yet. Send a ping from OwnTracks.");
    process.exit(1);
  }
  const loc = JSON.parse(readFileSync(latestFile, "utf-8"));
  const rows = db.prepare(`
    SELECT *, ${haversineSQL()} AS distance_m
    FROM places
    ORDER BY distance_m
    LIMIT 1
  `).all(loc.lat, loc.lat, loc.lon).filter(r => r.distance_m <= 500);

  const age = Math.round((Date.now() / 1000 - loc.tst) / 60);
  console.log(`📍 ${loc.lat}, ${loc.lon} (acc: ${loc.acc}m, ${age}min ago, batt: ${loc.batt}%)`);
  if (rows.length) {
    console.log(`📌 At: ${rows[0].name} — ${Math.round(rows[0].distance_m)}m away [${rows[0].category}]`);
  } else {
    console.log("📌 Not near any known place.");
  }

} else {
  console.log(`Usage: places <add|remove|list|nearest|search|where>
  add <name> <lat> <lon> [category] [notes]
  remove <name>
  list [category]
  nearest <lat> <lon> [limit=5] [max_meters=500]
  search <query>
  where   (current location + nearest place)`);
}

db.close();
