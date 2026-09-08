---
name: dades
description: Read-only gateway to a company NAS / shared drive, with per-folder importance tiers and append-only audit logging. Use whenever the user asks to look at, search, list, read, or locate something on the company disk, shared drive, or internal NAS. All access goes through the dades CLI so it is confined to the share, refuses writes, and is audited. NOT for the user's personal files or the local workspace.
---

# dades — company NAS access (read-only)

Point this skill at **your** company share by editing `policy.json` (`mount.server`, `mount.share`, `folderTiers`). The bundled policy is a template — it names no real host.

Treat every byte as confidential: read freely, send nothing off-box without explicit per-action authorization.

## The one rule of access

Never touch the mount path with raw shell tools (`cat`, `ls`, `find`, `cp`, `rm`, an editor).
**Always go through the gateway CLI:**

```
node {baseDir}/scripts/dades <command> [args]
```

The CLI is the structural safety boundary. A "be careful" rule in a prompt fails under pressure; a code-level guard does not. It confines every path inside the share, **has no enabled code path that writes/moves/deletes**, and appends one line to an off-disk audit log for every call.

## Commands (all read-only)

| Command                             | What it does                                                                |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `dades status`                      | mount state, mode, enabled permission levels                                |
| `dades ls [relpath]`                | list a directory (root if omitted); shows the folder's tier                 |
| `dades tree [relpath] [--depth N]`  | directory tree, dirs only (default depth 2)                                 |
| `dades cat <relpath>`               | print a text file (≤5MB, refuses binary)                                    |
| `dades get <relpath>`               | copy ONE file out to `~/.openclaw/dades-export/` so a local app can open it |
| `dades stat <relpath>`              | size / mtime / type / tier as JSON                                          |
| `dades find [relpath] <pattern>`    | case-insensitive name search (capped)                                       |
| `dades map [--depth N] [--refresh]` | (re)build the cached folder map with tiers                                  |
| `dades tier [relpath]`              | the importance tier of a path + its future-write policy                     |
| `dades audit [--tail N]`            | recent audit-log lines                                                      |

`get` is still a READ: the source is opened read-only, the destination is pinned to
`~/.openclaw/dades-export/`, and every export is audited. Nothing leaves this machine.

## Importance tiers

Every top folder has a tier in `policy.json`. Right now everything is read-only; tiers govern
sensitivity awareness and any future write rollout. Unclassified folders default to Tier 1
(crown jewels). See `references/security-model.md` before proposing to enable a write level.

## If the user asks to write / modify / delete

Refuse. The CLI has no enabled write path. Propose a change to `policy.json` only with
explicit authorization, and never by editing the live NAS.
