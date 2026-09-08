---
name: owntracks-location
description: >
  Real-time phone location tracking via OwnTracks HTTP webhook receiver with named places
  and distance-based queries. Use when: (1) user asks "where am I?", (2) storing named
  locations (home, gym, work), (3) querying nearby places by distance, (4) checking
  location history. Requires: OwnTracks app on phone, Tailscale or LAN connectivity,
  Node.js 22+, better-sqlite3.
version: 1.0.1
---

> One of dozens of skills and plugins in **[TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — a self-improving OpenClaw fork that's been running 24/7 for months.

Ask your agent "where am I?" — and get a real answer, not a shrug.

No Google Timeline. No app phoning home to a stranger's servers. Just your phone, your box, your data.

Your phone already knows where you are. This skill catches those location pings on your own machine: a tiny webhook receiver that logs each one into a local SQLite database. Name the spots that matter — home, gym, work — and your agent can tell you where you are, what's nearby, and how far you've wandered, all without a cloud middleman ever touching the trail.

**Part of [TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — real-time token tracking, self-improving crons, persistent cognitive memory. This is one piece of that stack; the repo has dozens more.

👉 **https://github.com/globalcaos/tinkerclaw**

_Clone it. Fork it. Break it. Make it yours._

# OwnTracks Location

<scope>
Real-time location awareness via OwnTracks → HTTP webhook → SQLite. Use this skill when the user wants to know "where am I?", record a named place, or query nearby places by distance.
</scope>

## Architecture

```
Phone (OwnTracks) → HTTP POST → server.mjs (port 18793) → SQLite + latest.json
Agent queries → places.mjs CLI or curl http://localhost:18793/latest
```

## Setup

### 1. Start the receiver

```bash
node scripts/server.mjs
# Default port: 18793. Override: OWNTRACKS_PORT=9999
# Data dir override: OWNTRACKS_DATA=/path/to/data
```

Recommended: install as user systemd service for persistence.

```bash
mkdir -p ~/.config/systemd/user
cat << 'EOF' > ~/.config/systemd/user/owntracks-receiver.service
[Unit]
Description=OwnTracks Location Receiver
After=network.target

[Service]
Type=simple
Environment=OWNTRACKS_PORT=18793
Environment=OWNTRACKS_DATA=<SKILL_DIR>/scripts/data
ExecStart=/usr/local/bin/node <SKILL_DIR>/scripts/server.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now owntracks-receiver
```

Replace `<SKILL_DIR>` with the absolute path to this skill directory.

### 2. Configure OwnTracks on phone

1. Install OwnTracks from F-Droid or Play Store
2. Open → Menu → Preferences → Mode → HTTP
3. URL: `http://<host-tailscale-ip>:18793/owntracks`
4. Tap the share icon on the map to send a test ping

Phone must reach the receiver (same LAN or Tailscale).

### 3. Verify

```bash
curl http://localhost:18793/latest
# Should return JSON with lat, lon, acc, batt, etc.
```

## Places CLI

Named locations with haversine distance queries.

```bash
# Add a place
node scripts/places.mjs add "Home" 41.3200 1.8900 home "Olivella"
node scripts/places.mjs add "Gym" 41.2229 1.7385 gym "Aqua Sport, Vilanova"

# Where am I? (reads OwnTracks latest + finds nearest named place)
node scripts/places.mjs where

# Find nearby places from arbitrary coordinates
node scripts/places.mjs nearest 41.22 1.74 5 500

# Search by name/category/notes
node scripts/places.mjs search "gym"

# List all
node scripts/places.mjs list
node scripts/places.mjs list gym

# Remove
node scripts/places.mjs remove "Old Place"
```

<agent_usage>
When the user asks "where am I?":

```bash
curl -s http://localhost:18793/latest
node scripts/places.mjs where
```

When the user says "this is my X" at a location:

1. Get current coords from `/latest`
2. Reverse geocode via Nominatim or web search for the business name
3. `node scripts/places.mjs add "<name>" <lat> <lon> <category>`
</agent_usage>

## Server Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/owntracks` | OwnTracks webhook (expects `_type: "location"`) |
| GET | `/latest` | Last known location |
| GET | `/history?limit=50` | Location history |
| GET | `/health` | Health check |

## Dependencies

- Node.js 22+
- `better-sqlite3` (for places.mjs)
- OwnTracks app (Android/iOS)
- Network path from phone to receiver (Tailscale recommended)
