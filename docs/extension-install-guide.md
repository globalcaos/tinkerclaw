# Extension Install Guide

How to install a standalone OpenClaw extension (plugin) from scratch.
Written for the cognitive extensions modularization project.

## Terminology

- **Extension** = a folder (or single file) that OpenClaw discovers and loads at gateway startup.
- **Plugin manifest** = `openclaw.plugin.json` inside the extension folder.
- **Extensions directory** = `~/.openclaw/extensions/` (global) or `<workspace>/.openclaw/extensions/` (workspace-scoped).

## Install Methods

### 1. CLI Install (recommended)

```bash
# From a local directory
openclaw plugin install /path/to/my-extension

# From an npm package
openclaw plugin install my-openclaw-plugin

# From ClawHub marketplace
openclaw plugin install clawhub:package-name

# From a .zip / .tgz / .tar.gz archive
openclaw plugin install ./my-extension.tgz

# Link instead of copy (for development — changes apply without reinstall)
openclaw plugin install -l /path/to/my-extension
```

The CLI copies the extension into `~/.openclaw/extensions/<plugin-id>/`, records the install in `openclaw.json` under `plugins.installs`, and auto-enables it.

### 2. Manual Install (drop-in)

Copy or symlink your extension folder into the extensions directory:

```bash
cp -r ./my-extension ~/.openclaw/extensions/my-extension
```

The folder must contain at least one of:
- `openclaw.plugin.json` (manifest with `id` and `configSchema`)
- `package.json` with an `openclaw.extensions` array pointing to entry files
- An `index.ts` or `index.js` at the root (fallback discovery)

Restart the gateway to pick it up.

**Discovery order** (first match wins within each tier):
1. `plugins.load.paths` entries in `openclaw.json` (origin: `config`)
2. `<workspace>/.openclaw/extensions/` (origin: `workspace`)
3. Bundled/stock extensions shipped with the gateway binary
4. `~/.openclaw/extensions/` (origin: `global`)

### 3. Workspace-Scoped Extensions

For extensions that belong to a specific agent workspace rather than the global install:

```bash
cp -r ./my-extension ~/.openclaw/workspace/.openclaw/extensions/my-extension
```

These are discovered automatically when the workspace is active.

## Minimum Extension Structure

### Simplest possible extension (single file)

```
my-extension/
  index.js          # exports a register(api) function
  openclaw.plugin.json
```

### With package.json (npm-style)

```
my-extension/
  package.json      # must have openclaw.extensions: ["./index.js"]
  index.js
  openclaw.plugin.json
```

## Manifest Format

`openclaw.plugin.json`:

```json
{
  "id": "my-extension",
  "name": "My Extension",
  "description": "What it does",
  "version": "1.0.0",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

**Required fields:**
- `id` — unique plugin identifier (used as config key)
- `configSchema` — JSON Schema for plugin config (can be empty object schema as above)

**Optional but recommended:**
- `name`, `description`, `version`
- `enabledByDefault: true` if the plugin should auto-activate

## Entry Point

The extension entry file must export a `register` function:

```js
export function register(api) {
  // api.on("event", handler)       — subscribe to lifecycle events
  // api.registerTool(...)           — register agent tools
  // api.registerHttpRoute(...)      — add HTTP endpoints
  // api.runtime                     — access runtime services
}
```

## Enabling After Manual Install

If the plugin is not auto-enabled, add it to the allowlist in `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["my-extension"]
  }
}
```

Or if `plugins.allow` is not set (empty = all plugins allowed), no action needed.

## Verifying

```bash
# Check if the plugin is discovered and loaded
openclaw plugin list

# Diagnose load issues
openclaw plugin doctor

# Inspect a specific plugin
openclaw plugin inspect my-extension
```

## Uninstalling

```bash
openclaw plugin uninstall my-extension
```

Or for manual installs, delete the folder and restart the gateway.

## Ignored Directories

The discovery scanner skips directories whose names:
- End with `.bak`
- Contain `.backup-`
- Contain `.disabled`

Use these suffixes to temporarily disable an extension without deleting it.

## Reference: Existing Extension

See `~/.openclaw/extensions/whatsapp-fetch-history/` for a working example with:
- `openclaw.plugin.json` (manifest)
- `package.json` (declares `better-sqlite3` dependency)
- `index.js` (exports `register(api)` using `api.registerHttpRoute`)
