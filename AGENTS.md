# AGENTS.md - Quick Reference

**Repo**: https://github.com/openclaw/openclaw  
**File refs**: repo-root relative only (e.g., `src/telegram/index.ts:80`).

## Essential Quick Commands

- **Install**: `pnpm install`
- **Dev**: `pnpm dev` or `pnpm openclaw ...`
- **Build**: `pnpm build` (hard gate before pushing main)
- **Type-check**: `pnpm tsgo`
- **Lint/format**: `pnpm check`, `pnpm format:fix`
- **Test**: `pnpm test` (preferred landing bar for main)
- **Test coverage**: `pnpm test:coverage`

## Critical Boundaries (Refactor Triggers)

If you see core code naming specific extensions/providers/channels for extension-owned behavior → refactor toward generic registry/capability/plugin-owned seams instead.

- **Plugin SDK**: `src/plugin-sdk/*` is the public contract; extensions may NOT import `src/**` directly.
- **Channels**: `src/channels/**` is core implementation; plugin authors use SDK instead.
- **Providers**: core owns inference loop; plugins own provider-specific behavior via registration.
- **Config**: prefer schema/zod at external boundaries; do not re-expose removed legacy keys in help/baselines.

## Quick Git / PR Rules

- Commit scope: related changes only; group with `scripts/committer "<msg>" <file...>`.
- PR template: `.github/pull_request_template.md`
- Main safety: no merge commits; rebase before pushing if main advanced.
- Before landing: `pnpm check`, `pnpm test`, `pnpm build` (build is hard gate if output/modules touched).

## Prompt Cache & Determinism

- Module assembly (maps, registries, plugin lists, MCP catalogs) must be deterministic-ordered.
- Do NOT rewrite recent transcript bytes unless invalidating cache is intentional.
- Keep cached prefix stable across turns.

## Test Performance Guardrails

- Avoid `vi.resetModules()` per-test in hot files; use static imports + `beforeAll`.
- Do not partial-mock broad barrels; add a plugin-local `*.runtime.ts` seam instead.
- Prefer explicit mock factories over `importOriginal()`.

## Release / PR Maintenance Skills

- **Release**: `$openclaw-release-maintainer` (`.agents/skills/openclaw-release-maintainer/SKILL.md`)
- **PR landing**: Follow `/landpr` (global Codex prompt at `~/.codex/prompts/landpr.md`)
- **PR triage**: `$openclaw-pr-maintainer` (`.agents/skills/openclaw-pr-maintainer/SKILL.md`)
- **GHSA**: `$openclaw-ghsa-maintainer` (`.agents/skills/openclaw-ghsa-maintainer/SKILL.md`)

## Mobile / macOS Notes

- **Version bumps**: `package.json`, `apps/android/build.gradle.kts`, `apps/ios/Info.plist`, `apps/macos/Info.plist`, `docs/install/updating.md`
- **Real devices first**: check connected iOS/Android before simulator/emulator.
- **Mobile pairing**: `ws://` allowed for RFC 1918/link-local/mDNS; `wss://` required for Tailscale/public.
- **macOS gateway**: runs as menubar app only; restart via app or `scripts/restart-mac.sh`.
- **macOS logs**: use `scripts/clawlog.sh` for unified log query.

## Multi-Agent Safety

- **Never** create/apply/drop `git stash` (other agents may be working).
- **Never** create/remove `git worktree` or switch branches unless explicitly requested.
- **Keep unrelated WIP untouched**; commit only your changes.
- **Auto-resolve formatting-only diffs** without asking.

## Full Reference

Detailed guidance: `bank/reference/agents-upstream-full.md` (architecture, boundaries, testing, security, platform, collaboration).
