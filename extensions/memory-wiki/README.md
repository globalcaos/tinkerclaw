# @openclaw/memory-wiki

Persistent wiki compiler and Obsidian-friendly knowledge vault for **OpenClaw**.

This plugin is separate from the active memory plugin. `memory-core` still handles recall, promotion, and dreaming. `memory-wiki` compiles durable knowledge into a navigable markdown vault with deterministic indexes, provenance, and optional Obsidian CLI workflows.

## Modes

- `isolated`: own vault, own sources, no dependency on `memory-core`
- `bridge`: reads public `memory-core` artifacts and memory events through public seams
- `unsafe-local`: explicit same-machine escape hatch for private local paths

Default mode is `isolated`.

## Config

Put config under `plugins.entries.memory-wiki.config`:

```json5
{
  vaultMode: "isolated",

  vault: {
    path: "~/.openclaw/wiki/main",
    renderMode: "obsidian", // or "native"
  },

  obsidian: {
    enabled: true,
    useOfficialCli: true,
    vaultName: "OpenClaw Wiki",
    openAfterWrites: false,
  },

  bridge: {
    enabled: false,
    readMemoryCore: true,
    indexDreamReports: true,
    indexDailyNotes: true,
    indexMemoryRoot: true,
    followMemoryEvents: true,
  },

  unsafeLocal: {
    allowPrivateMemoryCoreAccess: false,
    paths: [],
  },

  ingest: {
    autoCompile: true,
    maxConcurrentJobs: 1,
    allowUrlIngest: true,
  },

  search: {
    backend: "shared", // or "local"
    corpus: "wiki", // or "memory" | "all"
  },

  render: {
    preserveHumanBlocks: true,
    createBacklinks: true,
    createDashboards: true,
  },
}
```

## Vault shape

The plugin initializes a vault like this:

```text
<vault>/
  AGENTS.md
  WIKI.md
  index.md
  inbox.md
  entities/
  concepts/
  syntheses/
  sources/
  reports/
  _attachments/
  _views/
  .openclaw-wiki/
```

Generated content stays inside managed blocks. Human note blocks are preserved.

## CLI

```bash
openclaw wiki status
openclaw wiki doctor
openclaw wiki init
openclaw wiki ingest ./notes/alpha.md
openclaw wiki compile
openclaw wiki lint
openclaw wiki search "alpha"
openclaw wiki get entity.alpha --from 1 --lines 80

openclaw wiki apply synthesis "Alpha Summary" \
  --body "Short synthesis body" \
  --source-id source.alpha

openclaw wiki apply metadata entity.alpha \
  --source-id source.alpha \
  --status review \
  --question "Still active?"

openclaw wiki bridge import
openclaw wiki unsafe-local import

openclaw wiki obsidian status
openclaw wiki obsidian search "alpha"
openclaw wiki obsidian open syntheses/alpha-summary.md
openclaw wiki obsidian command workspace:quick-switcher
openclaw wiki obsidian daily
```

## Agent tools

- `wiki_status`
- `wiki_lint`
- `wiki_apply`
- `wiki_search`
- `wiki_get`

## Gateway RPC

Read methods:

- `wiki.status`
- `wiki.doctor`
- `wiki.search`
- `wiki.get`
- `wiki.obsidian.status`
- `wiki.obsidian.search`

Write methods:

- `wiki.init`
- `wiki.compile`
- `wiki.ingest`
- `wiki.lint`
- `wiki.bridge.import`
- `wiki.unsafeLocal.import`
- `wiki.apply`
- `wiki.obsidian.open`
- `wiki.obsidian.command`
- `wiki.obsidian.daily`

## Notes

- `unsafe-local` is intentionally experimental and non-portable.
- Bridge mode reads `memory-core` through public seams only.
- Wiki pages are compiled artifacts, not the ultimate source of truth. Keep provenance attached to raw sources, memory artifacts, and daily notes.
- Obsidian CLI support requires the official `obsidian` CLI to be installed and available on `PATH`.
