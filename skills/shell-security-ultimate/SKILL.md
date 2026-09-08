---
name: shell-security-ultimate
version: 2.3.1
description: "Classify every shell command as SAFE, WARN, or CRIT before your agent runs it. The classification is instruction-only and runs nothing. The package also ships optional installer scripts that MODIFY SOURCE CODE in an OpenClaw checkout you point them at — they refuse non-OpenClaw trees, back up first, require --yes, offer --dry-run, never rebuild unless you ask, and ship with an unpatch off-switch. Nothing is patched by installing this skill. Built for the TinkerClaw fork — github.com/globalcaos/tinkerclaw. See Permissions, Data Flow & Consent."
metadata:
  openclaw:
    owner: kn7623hrcwt6rg73a67xw3wyx580asdw
    category: security
    tags:
      - shell
      - command-classification
      - risk-management
      - agent-safety
    license: MIT
    notes:
      security: "The classification itself is instruction-only: it runs in the LLM context, executes nothing, and makes no network calls or credential reads. The package ALSO ships three optional scripts you must run deliberately. scripts/cmd_display.py is a ~200-line stdout formatter (argv in, coloured text out; no files, no network). scripts/patch-openclaw.sh MODIFIES SOURCE CODE OUTSIDE THIS SKILL: it sed-edits one TypeScript file in an OpenClaw checkout you point it at, so plugins can block tool calls. It refuses to touch a tree that is not an OpenClaw-family checkout, writes a timestamped backup first, requires a typed 'yes' or --yes, offers --dry-run, and does NOT run the target's build unless you pass --rebuild. scripts/unpatch-openclaw.sh is the off switch and reverses it. Nothing is patched by installing this skill. Enforcement of the SAFE/WARN/CRIT gate is the agent following instructions, not a kernel-level block — see the Permissions, Data Flow & Consent section."
---

# Shell Security Ultimate

Your agent has root access. Every command it runs is one bad inference away from `rm -rf /` or `curl | bash` from a stranger's repo.

This skill won't let that happen.

## How It Works

Every shell command gets classified before execution:

- 🟢 **SAFE** — Read-only, harmless. Runs without friction.
- 🟡 **WARN** — Could modify state. Logged, flagged, your call.
- 🔴 **CRIT** — Destructive or irreversible. Blocked until you say so.

No command runs unclassified. No silent `chmod 777`. No quiet `dd if=/dev/zero`. Your agent won't accidentally email your SSH keys, won't helpfully format a disk, and won't `DROP TABLE users` because it misread the task.

## What You Get

- **Pre-execution classification** for every command, every time
- **Detailed operation logs** so you see exactly what ran and why it was allowed
- **Full override control** — approve, deny, or escalate at any level

## Who It's For

Anyone giving an AI agent shell access and wanting to sleep at night.

*Clone it. Fork it. Break it. Make it yours.*

👉 Explore the full project: [github.com/globalcaos/clawdbot-moltbot-openclaw](https://github.com/globalcaos/clawdbot-moltbot-openclaw)

---

## What's Actually in the Box

Four working files, two of which are inert until you run them on purpose. Anything else in
the download (`skill-card.md`, `_meta.json`, `.clawhub/`) is registry metadata and does nothing.

| File | What it is | Runs when |
| --- | --- | --- |
| `SKILL.md` | The classification rules themselves — prompt text, no code | Loaded into context when the skill is active |
| `scripts/cmd_display.py` | A stdout formatter: takes a level, command, purpose and result on argv and prints a coloured four-line report | Only when the agent or you invoke it |
| `scripts/patch-openclaw.sh` | **Optional.** Edits one TypeScript file in an OpenClaw checkout so plugins can block tool calls | Never automatically. You run it, and confirm |
| `scripts/unpatch-openclaw.sh` | The off switch for that patch | You run it |

Installing this skill patches nothing, writes nothing, and starts nothing.

## Permissions, Data Flow & Consent

Short version: the classification is prompt text and touches no files. One optional script
rewrites source code in a project that is not this one, and it asks first. Longer version,
because a security skill is the last place you should take that on trust:

**What data it touches.** The text of the shell commands your agent is about to run, and
whatever you write as their purpose. That is it. `cmd_display.py` receives those as command-line
arguments, formats them, and writes to stdout. It opens no files, keeps no history, and stores
nothing between calls. One caveat worth stating plainly: anything passed as a command-line
argument is visible in the process table to other users on the same machine and lands in your
shell history — so do not pipe secrets through the `result` argument.

**What goes over the network.** Nothing. There is no network code in this package.

**What credentials it reads.** None. No tokens, no keys, no auth files, and no environment
variables other than `OPENCLAW_DIR` — a path you set, used only by the two patch scripts.

**What gets written to disk.** Nothing at all, unless you run `patch-openclaw.sh`. When you do,
and only after you confirm, it writes exactly two things, both inside the checkout you named:

- a timestamped backup, `pi-tool-definition-adapter.ts.backup.<date>`
- the modified `src/agents/pi-tool-definition-adapter.ts` itself

`unpatch-openclaw.sh` writes one more backup (`.unpatch-backup.<date>`) before restoring.

**Capabilities, and why each exists.**

| Capability | Why | Scope |
| --- | --- | --- |
| In-context classification | The actual feature — label commands before they run | Prompt text; executes nothing |
| Local shell exec (optional) | Run `cmd_display.py` to print the four-line report | One Python script; argv in, stdout out |
| Source modification (optional) | `patch-openclaw.sh` enables `before_tool_call` plugin hooks | One file under `OPENCLAW_DIR`, plus its backup. Never runs unattended |
| Build execution (optional, off) | `--rebuild` runs the target checkout's `pnpm build` | Off by default. A build executes package scripts from that checkout — a separate decision |
| Network | **None.** No requests, no telemetry, no phone-home | — |
| Credentials | **None.** Reads no tokens, keys or auth files | — |

## The Optional Patch — Consent and the Off Switch

`patch-openclaw.sh` is the one genuinely high-impact thing here, so it is worth being blunt:
**it rewrites source code in a codebase that is not this skill.** It exists because OpenClaw's
tool dispatcher does not, by default, give plugins a chance to veto a tool call. The patch adds
that hook. Read the script before you run it — it is short, and it prints the exact change it
will make before making it.

What guards it:

- **`--dry-run`** shows the target file and the change, then exits without touching anything.
- **Explicit consent.** It refuses to proceed until you type `yes`, or pass `--yes`. In a
  non-interactive shell without `--yes` it refuses outright rather than assuming.
- **Target validation.** It refuses to edit a tree whose `package.json` does not name an
  OpenClaw-family project, so a typo in `OPENCLAW_DIR` cannot point `sed` at your other work.
  Override with `--allow-any-repo` if you know better.
- **A backup first**, and an automatic restore if verification fails.
- **No build unless you ask.** `pnpm build` runs only with `--rebuild`; otherwise the script
  prints the command and leaves the decision to you.

```bash
./scripts/patch-openclaw.sh --dry-run     # see the change, touch nothing
./scripts/patch-openclaw.sh               # asks before editing; does not rebuild
./scripts/unpatch-openclaw.sh             # OFF SWITCH — restores the file
```

To undo it by hand instead, restore the `.backup.<date>` file it left beside the original, or
run `git checkout src/agents/pi-tool-definition-adapter.ts` in that checkout.

**What the patch does not do.** It does not block anything on its own. It only lets a plugin
that registers a `before_tool_call` hook return a block decision. **This package does not ship
such a plugin.** Patching and then assuming you are protected is worse than not patching — so
after patching, nothing changes until you install a plugin that implements the hook.

## What's Enforced by Code, and What Isn't

The honest boundary, because the difference matters more here than anywhere else:

- **Instruction-level (the default).** The SAFE / WARN / CRIT gate is guidance the agent
  follows. It is only as strong as the model's instruction-following — a determined jailbreak,
  a prompt injection inside a file the agent reads, or a plain misclassification can get past
  it. Treat it as a seatbelt, not a vault.
- **Code-level (only if you patch, and only with a hook plugin).** A `before_tool_call` hook
  can genuinely refuse to execute a tool. That is real enforcement, and it needs both the patch
  above and a plugin that uses it.

If you need a hard guarantee, run the agent in a container or a VM with credentials it cannot
escalate. This skill lowers the odds of a bad command; it does not make one impossible.

**Turning it off.** Deactivate or uninstall the skill and the classification behaviour stops —
it is prompt text, so nothing lingers. Telling the agent to stand down for a session works the
same way. If you ran the patch, run `./scripts/unpatch-openclaw.sh` (then rebuild) to return
the checkout to its original behaviour.

## cmd_display.py Reference

```bash
python3 scripts/cmd_display.py <level> "<command>" "<purpose>" "<result>" [warning] [action]
```

Levels: `safe` 🟢, `low` 🔵, `medium` 🟡, `high` 🟠, `critical` 🔴. Output is at most four lines —
level and command, result, purpose, and an optional warning or next action. It prints; it does
not run the command for you, and it decides nothing.

Everything this document describes is in this package. If you find a claim here that the code
does not do, that is a bug — open an issue on
[the repo](https://github.com/globalcaos/clawdbot-moltbot-openclaw/issues).
