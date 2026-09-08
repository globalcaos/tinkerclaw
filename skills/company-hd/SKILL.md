---
name: company-hd
description: Accident-prevention layer over a company hard drive / NAS. A code-level read-only gateway with path confinement, importance tiers, and append-only audit logging. Use whenever the user asks to look at, search, list, read, or locate something on the company disk, shared drive, or internal NAS. NEVER touch the share with raw shell tools — this CLI is the only sanctioned path. NOT for the user's personal files or the local workspace.
---

# company-hd — accident-prevention layer over the company disk

This is not a file browser. It is a **guard** between the agent and a disk where one wrong `rm` destroys engineering IP.

A "be careful, read-only" rule in a prompt is rated 2/5 — it fails under pressure (prompt injection, context overflow, rationalization). This CLI is rated 4/5 because the guarantee lives **in code**:

- There is **no enabled code path** that writes, moves, or deletes on the share.
- Write verbs exist only to **refuse loudly** and log the attempt.
- Every path is resolved and realpath-checked **inside** the mount. `..` and symlink-out are denied.
- Every call appends one line to an **off-disk** audit log.

Point it at **your** company share by editing `policy.json` (`mount.server`, `mount.share`, `folderTiers`). The bundled policy is a template — it names no real host.

Treat every byte as confidential: read freely, send nothing off-box without explicit per-action authorization.

## The one rule of access

Never touch the mount path with raw shell tools (`cat`, `ls`, `find`, `cp`, `rm`, an editor).
**Always go through the gateway CLI:**

```
node {baseDir}/scripts/company-hd <command> [args]
```

## Commands (all read-only)

| Command                                  | What it does                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `company-hd status`                      | mount state, mode, enabled permission levels                                     |
| `company-hd ls [relpath]`                | list a directory (root if omitted); shows the folder's tier                      |
| `company-hd tree [relpath] [--depth N]`  | directory tree, dirs only (default depth 2)                                      |
| `company-hd cat <relpath>`               | print a text file (≤5MB, refuses binary)                                         |
| `company-hd get <relpath>`               | copy ONE file out to `~/.openclaw/company-hd-export/` so a local app can open it |
| `company-hd stat <relpath>`              | size / mtime / type / tier as JSON                                               |
| `company-hd find [relpath] <pattern>`    | case-insensitive name search (capped)                                            |
| `company-hd map [--depth N] [--refresh]` | (re)build the cached folder map with tiers                                       |
| `company-hd tier [relpath]`              | the importance tier of a path + its future-write policy                          |
| `company-hd audit [--tail N]`            | recent audit-log lines                                                           |

`get` is still a READ: the source is opened read-only, the destination is pinned to
`~/.openclaw/company-hd-export/`, and every export is audited. Nothing leaves this machine.

## Importance tiers

Every top folder has a tier in `policy.json`. Right now everything is read-only; tiers govern
sensitivity awareness and any future write rollout. Unclassified folders default to Tier 1
(crown jewels). See `references/security-model.md` before proposing to enable a write level.

## If the user asks to write / modify / delete

Refuse. The CLI has no enabled write path. Propose a change to `policy.json` only with
explicit authorization, and never by editing the live NAS.
