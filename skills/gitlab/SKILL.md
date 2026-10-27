---
name: gitlab
description: "Not a usable skill: this folder holds only ClawHub publish metadata (_meta.json) for a package named gitlab whose payload was never committed. It contains no instructions, no scripts and no GitLab capability of any kind. Do not select it for GitLab work — use git and GitLab's own CLI or REST API instead."
---

# gitlab — publish metadata only

## What this is

Reference material, not a skill. The directory is what is left of a ClawHub
package named `gitlab`: the only file is `_meta.json`, a four-key JSON object
recording `ownerId`, `slug`, `version` and `publishedAt`. There is no skill
body, no script, no reference doc and no asset.

Because the package payload is missing, nothing here says what the upstream
`gitlab` skill did or how it did it. That information is not present in these
files, and this document does not guess at it.

## When to use / when not to

- **Do not load this as a skill.** With no instructions in the directory, the
  runtime has nothing to act on.
- **Do not treat it as GitLab support.** There is no GitLab client, no API
  wrapper, no authentication handling, no command surface.
- **For real GitLab work**, use `git` plus GitLab's own CLI or REST API
  directly. This directory adds nothing on top of them.
- The one reason to open it is housekeeping: decide whether to restore the
  missing payload or remove the directory.

## Entry points

None. The complete contents:

- `SKILL.md` — this file.
- `_meta.json` — publish metadata. Data only; nothing executes it.

There is no runnable command and no file the agent runtime consumes as
behaviour.

## Permissions & Data Flow

- **Reads:** nothing. No file here runs, so nothing is opened at runtime.
- **Writes:** nothing.
- **Network:** none. `_meta.json` records no endpoint or registry URL.
- **Credentials:** none. Nothing in this directory requests, stores or
  transmits a token. A working GitLab skill would need one; this is not one.
- **Note on the metadata:** the `ownerId` in `_meta.json` identifies the
  publishing account. Nothing here authenticates with it, but it does ship
  publicly with this repository, which the operator may want to weigh before
  keeping the file.
