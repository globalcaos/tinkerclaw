---
name: freeze-thaw
description: Freeze every live agent turn, power the laptop off, and bring all of it back after the next login — Tinker/WhatsApp chats mid-thought, terminal Claude Code sessions, shell tabs, Chrome. Use when the user says they are leaving, travelling, commuting, "I'm off", "freeze everything", "power off / shut down the laptop", or asks why a chat did not come back after a reboot, why a resumed chat failed on the network, or where a subagent report in /tmp went. Read it before touching the gateway's boot-time recovery or ~/.config/autostart/freeze-thaw.desktop.
metadata:
  openclaw:
    emoji: "🧊"
    os: ["linux"]
    requires:
      bins: ["python3", "systemctl", "systemd-run", "journalctl"]
    why: "The gateway resumes interrupted chats at boot, but not before the network is really up, and never terminals, Chrome or /tmp. This closes those gaps for owners who power the laptop off with work in flight."
    permissions:
      power: "freeze powers the machine off or reboots it (systemctl poweroff|reboot) unless --then=none. The agent runs it only on the user's explicit ask in the same turn."
      processes: "Stops the gateway unit and its worker units; with --then=none it SIGSTOPs terminal Claude Code sessions and thaw SIGCONTs them."
      file_write: "State in $XDG_STATE_HOME/freeze-thaw (pending manifest, history, log, copies of recent /tmp reports). install writes one autostart entry, one app launcher, one desktop icon and one systemd drop-in for the gateway unit; uninstall removes them."
      network: "wait-online sends HEAD requests to the model API URL (FREEZE_THAW_PROBE_URL) and reads the gateway's local /healthz."
repository: https://github.com/globalcaos/tinkerclaw
homepage: https://github.com/globalcaos/tinkerclaw
---

# freeze-thaw

**What it is for:** some owners power the laptop off for every commute, twice a day. They want to do that with work in flight and find it continuing after login, as if nothing happened.
**Where it came from:** measured 2026-09-25. The gateway already resumes interrupted main chats at boot (`src/agents/main-session-restart-recovery.ts`). It does not wait for the network, reopen terminals or Chrome, or keep `/tmp`. At one measured morning boot (2026-09-24), LLM calls failed with `network connection error` for at least ~100 s after NetworkManager had reported `CONNECTED_GLOBAL`. `/tmp` is emptied at every boot (`D /tmp`).
**What would change it:** the gateway growing its own network gate, GNOME getting session restore back, or a hibernate-sized swap (see the end).

## How the user drives it

- **Desktop icon or app grid: "Freeze & Power Off"** (right-click for _Freeze & Restart_). A dialog shows what is live; confirm, and the laptop powers off by itself.
- **Or tell the agent** "freeze, I'm off": the agent runs it (below).
- **Or ⏸ / ▶ next to SESSIONS in Tinker.** ⏸ = `freeze --then=none`: it freezes the chats, stops the gateway, and SIGSTOPs the terminal Claude sessions, but does **not** power off. ▶ = `thaw`, sent as a detached unit, and it works while the gateway is down. Both go through `tinker-prod-ui` (`scripts/tinker-prod-ui.mjs`, `/api/freeze-thaw`), not the gateway. The endpoint requires the `X-Tinker-Action: freeze-thaw` header plus a same-origin IP/localhost host, so another website cannot press them. `?dry=1` runs the script's dry run. The hover text follows the state: it reads `summary` from `pending.json` and the last thaw's `thaw.summary`. The page looks for the script at `~/.openclaw/workspace/skills/freeze-thaw/scripts/freeze_thaw.py`; if the skill lives elsewhere, set `TINKER_FREEZE_THAW_SCRIPT` for `tinker-prod-ui`. With no script found, the buttons stay hidden.
- **After login: nothing to do.** A "Thawed" notification says what came back and what did not.
- The plain power button still gets the gateway's built-in chat resume (network-gated for the guard window after any boot, once `install` has run). It does not get terminals, Chrome, or the `/tmp` reports back.

## How the agent runs it

```bash
FT={baseDir}/scripts/freeze_thaw.py
python3 $FT freeze --dry-run     # what would be frozen; changes nothing
python3 $FT freeze               # power off   (--then=reboot | --then=none)
python3 $FT status | thaw | discard | install | uninstall
```

- **Only on the user's explicit ask in this turn.** It powers the laptop off.
- `freeze` hands itself to a transient systemd unit and returns at once. Stopping the gateway kills everything in its cgroup, including the turn that called it. The unit waits up to 5 min for **this** chat's run to end (`TC_SESSION_KEY`) before it stops anything. Reply in one or two lines and end the turn; do not start more work.
- **Never pass `--force`.** The guard refuses while a freeze is pending, within the guard window (default 10 min) of a boot, or within the guard window of a thaw. That is what stops a resumed chat, rereading its own "freeze" instruction, from powering the laptop off again. `--force` is for a human's own hand: the dialog and the Tinker ⏸ button use it.

## What it needs

Linux with a systemd user session, `python3`, and the gateway running as a systemd user unit. The desktop parts are optional and fail soft: `zenity` for the confirm dialog (`freeze --ask`, which the launcher uses), `notify-send` for the notifications, `xdg-user-dir` and `gio` for the desktop icon, a gnome-terminal-compatible terminal and Chrome for what `thaw` reopens. With no display, `thaw` still resumes the chats and skips the terminals and Chrome.

## Configuration

Every host-specific default is a variable. Set it in the environment, or as a `KEY=VALUE` line in `~/.config/freeze-thaw/config.env` (path override: `FREEZE_THAW_CONFIG`). Use the file for anything you change: the autostart entry and the gateway's `ExecStartPre` do not see your shell's environment. The environment wins over the file. `status` prints the effective values.

| Variable                                                   | Default                                                        | What it sets                                                                                                            |
| ---------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_STATE_DIR`                                       | `~/.openclaw`                                                  | where the gateway's session stores live (`agents/*/sessions/sessions.json`)                                             |
| `CLAUDE_CONFIG_DIR`                                        | `~/.claude`                                                    | where Claude Code keeps `sessions/` and `projects/`                                                                     |
| `FREEZE_THAW_STATE`                                        | `$XDG_STATE_HOME/freeze-thaw`                                  | manifest, history, log. The Tinker buttons only read the default, so change it for test runs only                       |
| `FREEZE_THAW_GATEWAY_UNIT`                                 | `openclaw-gateway.service`                                     | the systemd user unit of the gateway                                                                                    |
| `FREEZE_THAW_WORKER_UNITS`                                 | `tinkerclaw-worker-*`                                          | glob of the worker units stopped after the gateway                                                                      |
| `FREEZE_THAW_CLI`                                          | `openclaw`                                                     | CLI used for `gateway call agent` (`tinkerclaw` works too)                                                              |
| `FREEZE_THAW_HEALTH_URL`                                   | `http://127.0.0.1:$OPENCLAW_GATEWAY_PORT/healthz` (port 18789) | gateway health check                                                                                                    |
| `FREEZE_THAW_PROBE_URL`                                    | `https://api.anthropic.com/`                                   | the model API the network gate must reach                                                                               |
| `FREEZE_THAW_OWNER`                                        | `The user`                                                     | who froze the laptop, as the resume message says it                                                                     |
| `FREEZE_THAW_GUARD_SECONDS`                                | `600`                                                          | the guard window after a boot or a thaw                                                                                 |
| `FREEZE_THAW_TERMINAL`                                     | `gnome-terminal`                                               | terminal to reopen; it must accept gnome-terminal's `--window`, `--tab`, `--working-directory`, `--`                    |
| `FREEZE_THAW_SHELL`                                        | `bash`                                                         | interactive shell (`-ic`) the reopened `claude --resume` runs in; pick the one whose rc file puts `claude` on your PATH |
| `FREEZE_THAW_BROWSER_COMM` / `FREEZE_THAW_BROWSER_WRAPPER` | `chrome` / `google-chrome`                                     | the browser's process name and the launcher next to its binary                                                          |
| `FREEZE_THAW_REPORT_GLOB`                                  | `/tmp/*.report.md`                                             | subagent reports backed up at freeze and restored at thaw                                                               |
| `FREEZE_THAW_ICON` / `FREEZE_THAW_DESKTOP_FILE`            | `weather-snow` / `freeze-and-power-off.desktop`                | icon name and desktop icon file name                                                                                    |

## What comes back

| Before the freeze                                   | After login                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chats mid-thought (Tinker, WhatsApp)                | Resumed by the gateway once the model API answers. `thaw` then checks each one in the journal and resumes any the gateway skipped or that failed. |
| The chat that asked for the freeze                  | Not resumed: it finished its reply before the stop.                                                                                               |
| Subagents                                           | Not resumed (gateway policy). Their finished reports (`FREEZE_THAW_REPORT_GLOB`) are restored; the resumed parent re-dispatches the missing ones. |
| Cron runs                                           | Run again on their next slot.                                                                                                                     |
| Terminal Claude Code sessions                       | Reopened in the terminal with `claude --resume <id>`, plus a resume prompt if it was busy.                                                        |
| Plain shell tabs                                    | Reopened at the same directories, in one window. Commands are not re-run.                                                                         |
| Chrome                                              | Relaunched with the same flags. It restores its own tabs when the profile has `restore_on_startup=1` (check each profile you use).                |
| Enabled user services                               | systemd starts them as always.                                                                                                                    |
| Ad-hoc `systemd-run` jobs (e.g. a download watcher) | **Not restarted.** Re-running an arbitrary command twice is not safe. Listed in the notification and in `history/<id>.json`.                      |

## What `install` puts in place

| Path                                                                                              | Role                                                                 |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `~/.config/autostart/freeze-thaw.desktop`                                                         | runs `thaw` at login                                                 |
| `~/.local/share/applications/freeze-thaw.desktop` + `<xdg desktop dir>/$FREEZE_THAW_DESKTOP_FILE` | the launcher and the trusted desktop icon                            |
| `~/.config/systemd/user/<gateway unit>.d/zz-freeze-thaw-wait-online.conf`                         | `ExecStartPre=-… wait-online --timeout 600`, `TimeoutStartSec=12min` |

The gate probes `FREEZE_THAW_PROBE_URL` with a real TLS round trip, so a captive portal counts as offline. It runs only while a freeze is pending or within the guard window after boot, so a normal gateway restart is not delayed. The leading `-` plus exit 0 means it can never keep the gateway from starting. `install` reloads systemd but does not restart the gateway. Rerun `install` after moving the skill: the three files carry its absolute path.

State lives in `$XDG_STATE_HOME/freeze-thaw/` (`pending.json`, `history/`, `freeze-thaw.log`, backed-up reports), outside the OpenClaw state dir, because many hosts keep that tree in git with a remote, and a manifest carries session keys. `FREEZE_THAW_STATE=<dir>` points a test run elsewhere.

## Debugging a thaw

1. `python3 $FT status`, then `$XDG_STATE_HOME/freeze-thaw/freeze-thaw.log` and `history/<id>.json` for the per-chat outcome.
2. The gateway's own decisions: `journalctl --user -u "${FREEZE_THAW_GATEWAY_UNIT:-openclaw-gateway.service}" -b -o cat | grep main-session-restart-recovery`. The network gate: `… | grep freeze-thaw:`.
3. Rehearse without side effects: write a manifest into `FREEZE_THAW_STATE=/tmp/x`, then `thaw --dry-run`.

## Failures overcome

- **2026-09-25: the resume message adopted another chat's work.** Sent live to a blank scratch chat, "resume your previous turn" led the model (Opus 5) to find this half-built skill on disk. It overwrote `SKILL.md`, with a false "verified end-to-end" line, and ran `install`. The message now opens with a SCOPE rule: only a turn this chat's transcript shows unfinished, otherwise one line and stop. **Never test the resume message on a chat with no real unfinished turn.** Use `thaw --dry-run`.
- **2026-09-25: CLI callers may not pass `provider`/`model`** ("overrides are not authorized for this caller"). The thaw sends neither. The run applies the chat's stored `modelOverride` itself (`src/agents/agent-command.ts`). That is from reading the code; nobody has yet watched a pinned chat resume live.
- **2026-09-25: Chrome rewrites its process title** into one space-joined string, so its argv is split before relaunch.

## Why not hibernate

Where the kernel allows it (no lockdown), hibernate would be a literal "nothing happened". It needs a swap file at least the size of the RAM in use and a `resume=` kernel parameter, both behind sudo. On the machine this was built for, swap was a small fraction of the RAM in use and the disk was nearly full, so it stayed off. Check `swapon --show`, `free -h` and `df -h /` before choosing it. That is the owner's call, not the agent's.
