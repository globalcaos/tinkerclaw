/**
 * OwnTracks HTTP webhook receiver (Node.js, zero deps).
 * Stores location updates in JSON files.
 */
import { createServer } from "http";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.OWNTRACKS_PORT || "18792", 10);
const DATA_DIR = process.env.OWNTRACKS_DATA || join(__dirname, "data");
const SECRET = process.env.OWNTRACKS_SECRET || "";

mkdirSync(DATA_DIR, { recursive: true });

const historyFile = join(DATA_DIR, "history.json");
const latestFile = join(DATA_DIR, "latest.json");

function loadHistory() {
  try {
    if (existsSync(historyFile)) return JSON.parse(readFileSync(historyFile, "utf-8"));
  } catch {}
  return [];
}

function saveHistory(h) {
  writeFileSync(historyFile, JSON.stringify(h.slice(-5000), null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/health") {
    res.writeHead(200);
    return res.end("ok");
  }

  if (req.method === "POST" && (url.pathname === "/" || url.pathname === "/owntracks")) {
    if (SECRET) {
      const auth = req.headers["authorization"];
      if (auth !== `Bearer ${SECRET}`) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unauthorized" }));
      }
    }

    try {
      const body = await readBody(req);
      if (body._type !== "location") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("[]");
      }

      const entry = {
        lat: body.lat,
        lon: body.lon,
        acc: body.acc ?? null,
        alt: body.alt ?? null,
        vel: body.vel ?? null,
        batt: body.batt ?? null,
        ssid: body.SSID ?? null,
        tst: body.tst,
        updated: new Date().toISOString(),
      };

      writeFileSync(latestFile, JSON.stringify(entry, null, 2));

      const history = loadHistory();
      history.push(entry);
      saveHistory(history);

      console.log(`📍 ${entry.lat}, ${entry.lon} (acc: ${entry.acc}m, batt: ${entry.batt}%)`);

      res.writeHead(200, { "content-type": "application/json" });
      return res.end("[]");
    } catch (e) {
      console.error("Parse error:", e);
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "bad request" }));
    }
  }

  if (req.method === "GET" && url.pathname === "/latest") {
    if (existsSync(latestFile)) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(readFileSync(latestFile, "utf-8"));
    }
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "no location yet" }));
  }

  if (req.method === "GET" && url.pathname === "/history") {
    const history = loadHistory();
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(history.slice(-limit)));
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🛰️  OwnTracks receiver listening on http://0.0.0.0:${PORT}`);
});
