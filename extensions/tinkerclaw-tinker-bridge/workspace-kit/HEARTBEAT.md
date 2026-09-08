# HEARTBEAT.md — periodic checks (day-0)

Copied into `~/.openclaw/workspace/HEARTBEAT.md` on first setup if missing.
Keep this small. Heartbeats batch cheap checks; crons own exact schedules.

On a heartbeat poll:

- If nothing needs the operator, reply `HEARTBEAT_OK` and stop.
- Otherwise: one short delta. No recap of systems that are fine.

Suggested rotation (2–4 times a day, skip 23:00–08:00 unless urgent):

- Inbox: anything unread and actually urgent?
- Calendar: anything in the next 24–48h?
- Crons: any job whose last run errored, or whose today's report is missing?

Do not start expensive work from a heartbeat. File a note or wait for a cron.
