# Downloader

The download daemon behind the `torrent-scout` skill. The skill decides what to fetch:
it searches, checks the real file list and ranks by quality. This plugin owns the part
that has to keep running when no agent is around: an aria2 daemon on a systemd user
unit, so a download outlives the chat turn, a gateway restart and a reboot.

## Install

```bash
node scripts/downloader/setup.mjs          # needs Linux and aria2c (sudo apt install aria2)
node scripts/downloader/setup.mjs --check  # 0 running, 1 configured but down, 3 not configured
```

The installer asks for it too (`scripts/setup.sh`, default no). It writes
`~/.config/aria2/aria2.conf`, the unit `torrent-scout-daemon.service`, keeps the RPC
secret in `~/.config/aria2/rpc-secret` (mode 600) and enables the plugin. Re-running it
is safe: it keeps the secret and the download folder, and backs up a config it did not
write.

## What runs

- **Guard, at every gateway start (Linux).** If the config has `force-save=true`, it
  removes the line and restarts the daemon after dropping its finished tasks. If the
  unit is installed but down, it starts it. It never installs anything.
- **Gateway methods:** `downloader.status` (daemon, problems, every task with progress),
  `downloader.add {uri, dir?}`, `downloader.remove {gid}`, `downloader.forget` (clears
  finished and failed tasks).

It talks only to aria2's JSON-RPC on `127.0.0.1`. Seeding is off: `seed-time=0`.

## Why no `force-save`

With `force-save=true` aria2 writes finished tasks into its session file, and reads
them back at every start. A film you deleted after watching came back after each
reboot and filled the disk again. Without it, unfinished downloads still resume and
finished ones are forgotten. The tests in `aria2-core.test.mjs` hold that line.

## Config

| key                      | default                     | what it does                      |
| ------------------------ | --------------------------- | --------------------------------- |
| `downloadDir`            | `~/Downloads/torrent-scout` | where finished files land         |
| `rpcPort`                | `6800`                      | aria2 RPC port on loopback        |
| `maxConcurrentDownloads` | `3`                         | downloads at once; the rest queue |
| `unitName`               | `torrent-scout-daemon`      | systemd user unit name            |

Changing a value means re-running the setup script, which rewrites the config.
