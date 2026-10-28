# Trip corner: offline trip page and flight watch

**What it is for:** the ✈ corner of the Jarvis phone app. `trip.json` holds the trip (flights, stays, car, activities, checklist, contacts). `trip-render.mjs` turns it into one offline `trip.html` that the phone door serves at `/trip/` and the app caches. `flight-watch.mjs` follows the flights live and pings the phone when something changes.
**How it was derived:** what a traveller needs at a gate (flight, local time with zone, terminal, gate, status, belt, the code to read out) and what changes what you do at an airport (delay moved 15 min or more, cancellation, diversion, gate or terminal, departed, landed, belt). The live sources were tested on real flights on 2026-10-19.
**What would change it:** a paid status API with push, or the airline's own app notifications proving enough.

## Files

- Data lives in `~/.openclaw/data/trip/` (`TRIP_DIR`), never in the repo: `trip.json` (schema v1), `trip-state.json` (live status, sent-notification keys, retries), `trip.html`, `provider-cache.json`.
- `fixtures/` holds fake trip data and trimmed public status pages (airline, number and airports swapped, dates moved back 52 weeks). Keep real travel dates and routes out of fixtures, tests and comments: the repo is public. The pages are `.page.txt` so the formatter leaves the inlined JSON byte-exact.

## Run

```bash
node scripts/trip/trip-render.mjs                      # writes $TRIP_DIR/trip.html
node scripts/trip/flight-watch.mjs --once --dry-run    # shows what it would send; sends nothing, writes only the provider cache
node scripts/trip/flight-watch.mjs --once              # one real pass
node --test scripts/trip/*.test.mjs
```

Whoever writes `trip.json` (the data unit, a person, Jarvis) should run `trip-render.mjs` after saving. If not, the next flight-watch pass re-renders, because it renders whenever `trip.html` is older than `trip.json` or `trip-state.json`.

On the always-on machine, install the timer (every 10 min on the clock; `Persistent=true` runs a missed slot after sleep):

```bash
cp scripts/trip/trip-watch.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now trip-watch.timer
```

The user manager's PATH usually has no nvm directory, so set `PATH` (with the node bin dir) and `OPENCLAW_BIN` in `~/.openclaw/data/trip/trip-watch.env` first. Other optional settings in the same file: `TRIP_NOTIFY_NODE` (else the first connected Android node from `openclaw nodes status --json`), `TRIP_WHATSAPP_TARGET` (fallback when the phone node is unreachable; unset = no fallback), `AERODATABOX_KEY` (third source, off without a key).

## What it watches and sends

- Flights leaving within 36 h, in the air, or landed less than 2 h ago.
- Reminders: check-in open at T-24 h; leave for the airport at T-3 h (international) or T-2 h (same country, judged by the airports' time zones; a flight can set `"international": true|false`).
- Reminders are skipped for flights marked `"confirmed": false`, and no booking code goes into a notification (it would show on the lock screen).
- Notifications go through `openclaw nodes invoke --command system.notify` with `title`, `body`, `priority`. Events for one flight in the same pass go out as one notification. Each event has a key in `notified`, so it is never sent twice; gate, terminal, belt and delay keys carry a counter, so a gate that flips back is announced again. A failed send is retried for 6 h.
- One pass at a time (a lock file in `TRIP_DIR`). trip-state is saved before alerts go into `trip.json` and after every send, so a pass killed halfway neither repeats nor loses a notification.
- A bad time zone in `trip.json` (say `Europe/Valencia`) is treated as UTC with a warning, and odd segments are skipped, so one typo does not stop the rest.

## Live sources (no key)

1. FlightStats flight tracker page (`/v2/flight-tracker/<carrier>/<number>?year&month&date`): the flight is inlined as `__NEXT_DATA__`. Has delay, gates, terminals and the baggage belt.
2. FlightAware flight page (`/live/flight/<ICAO ident>`): `trackpollBootstrap` with the current leg and upcoming days. No belt. Needs the airline's ICAO code (table in `providers/flightaware.mjs`); the IATA form can resolve to a different flight, which the date and origin check rejects.
3. AeroDataBox, only with `AERODATABOX_KEY`. Not tested live; there is no key here.

Each source is asked at most once per flight per ~10 min (cache in `provider-cache.json`). Both public pages can change shape without notice; the parser tests on the saved fixtures show which one broke.

## Checklist placement (the architect, 2026-10-19/20)

- Every item has a short `text` (one phrase: "ESTA", not a paragraph) and a `group` (folding section).
- `due` is the day the task must HAPPEN, and the item renders inside that day of the plan, above its
  segments. Return check-in goes on the day before the return flight, never at the top.
  Undated items (packing) render on departure day, before the flight.
- No duplicates across groups. Ticks and fold state live on the phone (localStorage `trip-check:`/`trip-fold:`,
  keyed by text and group), so renaming an item drops its tick.
- Alerts about a flight in the plan are not drawn as cards; its status chip already shows them.
  (2026-10-20: a return-leg online check-in checklist does not belong at the start of the trip.)
- No "Next up" section (2026-10-20: it distracted more than it helped); the header countdown keeps its first paint.
