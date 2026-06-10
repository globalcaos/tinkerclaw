# tinkerclaw-orca — cross-session file-lease registry

When several agents work the **same git tree** at once — multiple Claude Code
sessions, Jarvis, an ORCA run — they clobber each other's edits and each other's
context files. ORCA's lease registry serializes edits **per file** with fast
handoff, on **one branch, no merges**: an agent claims a file before editing it,
and releases it when done (or its claim expires).

## Pieces (one source of truth)

| File                    | Role                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lease-core.mjs`        | The lease primitives + a CLI. Dependency-free. Atomic on-disk leases — the gateway is **never** in the path, so a down gateway never blocks an edit.            |
| `index.ts` (plugin)     | Hosts the registry as gateway RPCs (`orca.lease.acquire/release/status/list`) + a stale-lease GC janitor. For programmatic callers (Jarvis, the ORCA workflow). |
| `enforce-file-lease.sh` | A Claude Code PreToolUse/Stop **hook** that makes leasing automatic for every Edit/Write. Runs `lease-core.mjs` as a CLI.                                       |

A lease is one JSON file per `(repo-root, repo-relative path)` under
`~/.openclaw/run/orca-leases/`. It is claimed atomically with `linkSync`
(atomic content **and** `EEXIST` mutual-exclusion) and replaced with `renameSync`
(atomic content). A held lease becomes reclaimable when its **TTL elapses**, or
(opt-in, real pid only) when its holder process is dead on this host. The steal
critical section is serialized by a short per-lease `O_EXCL` lock, so two
acquirers cannot both steal one stale lease.

## Activating the hook (per machine)

The hook is **shipped** here but **not active** until you wire it into a Claude
Code settings file. Because activation is per-machine, put it in the **gitignored**
`.claude/settings.local.json` (so the tool is shared, the activation is yours):

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          { "type": "command", "command": "extensions/tinkerclaw-orca/enforce-file-lease.sh" },
        ],
      },
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "extensions/tinkerclaw-orca/enforce-file-lease.sh" },
        ],
      },
    ],
  },
}
```

Do **not** wire `SubagentStop` (see "SubagentStop" below).

### Modes — `ORCA_LEASE_MODE`

- `off` — do nothing; allow every edit.
- `warn` _(default)_ — allow every edit, but print a warning when another live
  session already holds the file. **Start here** — it never surprises a peer.
- `enforce` — **deny** (exit 2) an edit to a file another live session holds.

Flip to enforce per shell with `export ORCA_LEASE_MODE=enforce`.

### Other knobs

- `ORCA_LEASE_TTL_MS` — claim lifetime, default `120000` (2 min). The hook
  re-claims on every edit, so an actively-edited file stays held; a file idle
  longer than the TTL is released for others.
- `ORCA_LEASE_ROOT` — override the lease directory (used by the tests).

**Fail-open by construction:** any error (no git repo, missing node/lease-core,
unparsable hook input) allows the edit. Leasing makes editing _safer_; it must
never make editing _impossible_.

## By-design limits (not bugs)

- **A crashed session wedges its files for up to one TTL.** The hook records
  `pid 0` (the owner is a _session_, which outlives the ephemeral node process),
  so a crash without a `Stop` is recovered by TTL expiry (and the janitor), not
  by pid-liveness. With TTL=120 s the wait is bounded and short.
- **The hook TTL (120 s) is intentionally shorter than the library/RPC default
  (300 s).** Short + refresh-on-edit gives _fast handoff_ between interactive
  sessions; programmatic callers that hold a file across a long operation can
  pass a longer `--ttl` or anchor pid-liveness with `--pid`.
- **`SubagentStop` does NOT release.** A `Task` subagent finishing does not mean
  the session is done editing, and a subagent may share the parent's
  `session_id`; releasing on `SubagentStop` would free the parent's _live_
  leases mid-flight. A subagent's own leases are reclaimed by TTL instead.
- **Gateway / cc-bridge edits don't pass through this hook.** Jarvis edits files
  with its own tools, not Claude Code's Edit/Write, so to participate it must call
  the `orca.lease.*` RPCs directly (a future integration point). The hook today
  protects Claude Code sessions, which is the primary clobber source.

## Tests

```bash
node --test extensions/tinkerclaw-orca/lease-core.test.mjs   # primitives + CLI + concurrency
bash    extensions/tinkerclaw-orca/enforce-file-lease.test.sh # the hook, end-to-end
node    scripts/run-tsgo.mjs -p extensions/tinkerclaw-orca/tsconfig.json  # plugin types
```
