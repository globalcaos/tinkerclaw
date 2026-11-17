"""SQLite state: meter readings, runs, job status, scheduler ticks. One file in the data folder."""
import json
import sqlite3
import threading
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY, seat TEXT NOT NULL, at REAL NOT NULL, week_pct REAL, week_reset REAL,
  five_pct REAL, five_reset REAL, source TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS readings_seat_at ON readings(seat, at);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, seat TEXT,
  started REAL, finished REAL, error TEXT,
  CHECK (status IN ('queued','running','done','failed')));
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, seat TEXT NOT NULL, agents INTEGER NOT NULL DEFAULT 1,
  started REAL NOT NULL, finished REAL, ok INTEGER, verified INTEGER, error TEXT, output TEXT,
  sim INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS runs_seat_started ON runs(seat, started);
CREATE TABLE IF NOT EXISTS ticks (
  id INTEGER PRIMARY KEY, at REAL NOT NULL, seat TEXT NOT NULL, week_pct REAL, target_pct REAL,
  needed REAL, rate REAL, width INTEGER NOT NULL, burner INTEGER NOT NULL, reason TEXT, live INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


class Store:
    def __init__(self, path):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.executescript(SCHEMA)

    def close(self):
        with self._lock:
            self._db.close()

    def q(self, sql, args=()):
        with self._lock:
            return [dict(r) for r in self._db.execute(sql, args).fetchall()]

    def one(self, sql, args=()):
        rows = self.q(sql, args)
        return rows[0] if rows else None

    def x(self, sql, args=()):
        with self._lock:
            cur = self._db.execute(sql, args)
            self._db.commit()
            return cur.lastrowid

    def get(self, key, default=None):
        r = self.one("SELECT value FROM kv WHERE key=?", (key,))
        return json.loads(r["value"]) if r else default

    def put(self, key, value):
        self.x("INSERT INTO kv(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
               (key, json.dumps(value)))

    def add_reading(self, seat, at, r, source):
        self.x("INSERT INTO readings(seat, at, week_pct, week_reset, five_pct, five_reset, source) VALUES (?,?,?,?,?,?,?)",
               (seat, at, r["week_pct"], r.get("week_reset"), r["five_pct"], r.get("five_reset"), source))

    def readings(self, seat, since=0.0):
        return self.q("SELECT * FROM readings WHERE seat=? AND at>=? ORDER BY at, id", (seat, since))

    def last_reading(self, seat):
        return self.one("SELECT * FROM readings WHERE seat=? ORDER BY at DESC, id DESC LIMIT 1", (seat,))

    def runs(self, seat, since=0.0):
        return self.q("SELECT started, finished, agents FROM runs WHERE seat=? AND (finished IS NULL OR finished>=?)",
                      (seat, since))

    def job_status(self):
        return {r["id"]: r for r in self.q("SELECT * FROM jobs")}

    def running(self):
        """Open runs: [{run id, job id, seat, agents}]."""
        return self.q("SELECT id, job_id, seat, agents FROM runs WHERE finished IS NULL")

    def start_run(self, job, seat, now, sim):
        self.x("""INSERT INTO jobs(id, status, attempts, seat, started) VALUES (?, 'running', 1, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET status='running', attempts=attempts+1, seat=excluded.seat,
                  started=excluded.started, finished=NULL, error=NULL""", (job["id"], seat, now))
        return self.x("INSERT INTO runs(job_id, seat, agents, started, sim) VALUES (?,?,?,?,?)",
                      (job["id"], seat, job["agents"], now, int(sim)))

    def finish_run(self, run_id, now, ok, verified, error, output, job_status):
        r = self.one("SELECT job_id FROM runs WHERE id=?", (run_id,))
        self.x("UPDATE runs SET finished=?, ok=?, verified=?, error=?, output=? WHERE id=?",
               (now, int(ok), None if verified is None else int(verified), error, output, run_id))
        self.x("UPDATE jobs SET status=?, finished=?, error=? WHERE id=?", (job_status, now, error, r["job_id"]))
