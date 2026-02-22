# Repository Guidelines

- Repo: https://github.com/openclaw/openclaw
- GitHub issues/comments/PR comments: use literal multiline strings or `-F - <<'EOF'` (or $'...') for real newlines; never embed "\\n".

## Project Structure & Module Organization

- Source code: `src/` (CLI wiring in `src/cli`, commands in `src/commands`, web provider in `src/provider-web.ts`, infra in `src/infra`, media pipeline in `src/media`).
- Tests: colocated `*.test.ts`.
- Docs: `docs/` (images, queue, Pi config). Built output lives in `dist/`.
- Plugins/extensions: live under `extensions/*` (workspace packages). Keep plugin-only deps in the extension `package.json`; do not add them to the root `package.json` unless core uses them.
- Plugins: install runs `npm install --omit=dev` in plugin dir; runtime deps must live in `dependencies`. Avoid `workspace:*` in `dependencies` (npm install breaks); put `openclaw` in `devDependencies` or `peerDependencies` instead (runtime resolves `openclaw/plugin-sdk` via jiti alias).
- Installers served from `https://openclaw.ai/*`: live in the sibling repo `../openclaw.ai` (`public/install.sh`, `public/install-cli.sh`, `public/install.ps1`).
- Messaging channels: always consider **all** built-in + extension channels when refactoring shared logic (routing, allowlists, pairing, command gating, onboarding, docs).
  - Core channel code: `src/telegram`, `src/discord`, `src/slack`, `src/signal`, `src/imessage`, `src/web`, `src/channels`, `src/routing`
  - Extensions: `extensions/*` (e.g. `extensions/msteams`, `extensions/matrix`, `extensions/zalo`, `extensions/zalouser`, `extensions/voice-call`)
- When adding channels/extensions/apps/docs, update `.github/labeler.yml` and create matching GitHub labels.

## Build, Test, and Development Commands

- Runtime baseline: Node **22+** (keep Node + Bun paths working).
- Install deps: `pnpm install`
- If deps are missing, run `pnpm install` then retry once.
- Prefer Bun for TypeScript execution: `bun <file.ts>` / `bunx <tool>`.
- Run CLI in dev: `pnpm openclaw ...` or `pnpm dev`.
- Type-check/build: `pnpm build` · TypeScript: `pnpm tsgo`
- Lint/format: `pnpm check` · Format fix: `pnpm format:fix`
- Tests: `pnpm test` · Coverage: `pnpm test:coverage`

## Coding Style & Naming Conventions

- Language: TypeScript (ESM). Prefer strict typing; avoid `any`.
- Formatting/linting via Oxlint and Oxfmt; run `pnpm check` before commits.
- Never add `@ts-nocheck` and do not disable `no-explicit-any`; fix root causes.
- Never share class behavior via prototype mutation. Use explicit inheritance/composition.
- Add brief code comments for tricky or non-obvious logic.
- Keep files under ~500-700 LOC; split/refactor when it improves clarity.
- Naming: **OpenClaw** for product/app/docs; `openclaw` for CLI/package/paths/config.

## Commit & Pull Request Guidelines

- Full maintainer PR workflow: see `.agents/skills/PR_WORKFLOW.md`.
- Create commits with `scripts/committer "<msg>" <file...>`; avoid manual `git add`/`git commit`.
- Concise, action-oriented commit messages (e.g., `CLI: add verbose flag to send`).
- Group related changes; avoid bundling unrelated refactors.

## Shorthand Commands

- `sync`: commit dirty changes → `git pull --rebase` → `git push`.

## Security & Configuration Tips

- Never commit or publish real phone numbers, videos, or live configuration values.
- Release flow: always read `docs/reference/RELEASING.md` and `docs/platforms/mac/release.md` first.
- Release guardrails: do not change version numbers without operator's explicit consent.

## Agent-Specific Notes

- Vocabulary: "makeup" = "mac app".
- Never edit `node_modules`. When adding a new `AGENTS.md`, also add a `CLAUDE.md` symlink.
- Signal: "update fly" => `fly ssh console -a flawd-bot -C "bash -lc 'cd /data/clawd/openclaw && git pull --rebase origin main'"` then `fly machines restart e825232f34d058 -a flawd-bot`.
- When working on a GitHub Issue or PR, print the full URL at the end.
- Respond with high-confidence answers only: verify in code; do not guess.
- Never update the Carbon dependency.
- Any dependency with `pnpm.patchedDependencies` must use an exact version (no `^`/`~`).
- Patching dependencies requires explicit approval.
- CLI progress: use `src/cli/progress.ts`; don't hand-roll spinners/bars.
- Status output: keep tables + ANSI-safe wrapping (`src/terminal/table.ts`).
- Gateway runs from **global npm install**, not workspace `dist/`. Source changes need: `pnpm build` → patch global install or `sudo npm i -g openclaw@latest` → `openclaw gateway restart`.
- SwiftUI: prefer `Observation` framework (`@Observable`, `@Bindable`) over `ObservableObject`/`@StateObject`.
- Connection providers: update every UI surface and docs when adding new ones.
- Version locations: `package.json`, `apps/android/app/build.gradle.kts`, `apps/ios/Sources/Info.plist`, `apps/macos/Sources/OpenClaw/Resources/Info.plist`, `docs/install/updating.md`, `docs/platforms/mac/release.md`.
- Tool schema guardrails: avoid `Type.Union` in tool input schemas; no `anyOf`/`oneOf`/`allOf`. Use `stringEnum`/`optionalStringEnum`. Avoid raw `format` property names.
- **Multi-agent safety:** no `git stash`, no `git worktree` changes, no branch switching unless explicitly requested. Focus on your changes; commit only those.
- Lint/format churn: auto-resolve formatting-only diffs without asking.
- Bug investigations: read source code of relevant npm dependencies and all related local code before concluding.
- Never send streaming/partial replies to external messaging surfaces.

## Reference Files (load on demand via memory_search)

| Topic | File |
|-------|------|
| Docs & Mintlify linking | `memory/reference/docs-mintlify.md` |
| VM ops (exe.dev) | `memory/reference/vm-ops.md` |
| Testing & release channels | `memory/reference/testing.md` |
| GHSA security advisories | `memory/reference/ghsa-security.md` |
| NPM publish & release notes | `memory/reference/release-publish.md` |
