# Changelog

- 0.1.2 — localstate source now confines files to ~/.openclaw/workspace/memory/online-presence (rejects absolute, `..` and symlink escapes, non-.json); credentials are read from plugin config only (the GITHUB*TOKEN / PULSE*\* environment fallbacks are removed); github.activity no longer runs the `gh` CLI and needs `credentials.githubToken`; manifest host list corrected (api.npmjs.org, oauth2.googleapis.com); package now ships the TypeScript source that index.ts imports alongside the rebuilt dist/index.js.
